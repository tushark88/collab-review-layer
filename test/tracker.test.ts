import assert from "node:assert/strict";
import test from "node:test";
import { chooseWorkItem, InMemoryProviderMutationRecovery, parseStableIssueContext, ProviderMutationRejectedError, stableIssueBody, type SearchContext, type WorkItem } from "../src/tracker.ts";
import { FileWebhookDeliveryLedger, InMemoryWebhookDeliveryLedger, MAX_WEBHOOK_BODY_BYTES, processUniqueDelivery, requireDeliveryId, requireFreshTimestamp, requireWebhookBody, verifyHmacSha256 } from "../src/webhook.ts";
import { createHmac } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const context: SearchContext = { container: { provider: "github", id: "org/repo", workspaceId: "org", name: "repo" }, repository: "org/repo", route: "/demo", anchorFingerprint: "anchor-1", labels: ["bug"], now: "2026-08-30T00:00:00Z" };
const item = (overrides: Partial<WorkItem>): WorkItem => ({ provider: "github", id: "1", url: "https://example.test/1", title: "Synthetic issue", body: "", state: "open", containerId: "org/repo", repository: "org/repo", route: "/demo", anchorFingerprint: "anchor-1", labels: ["bug"], updatedAt: "2026-08-29T00:00:00Z", ...overrides });
const contextBinding = { provider: "github", workItemId: "org/repo#42" } as const;
const contextSecret = "synthetic-context-secret";

test("exact links win before scoring", () => {
  const result = chooseWorkItem([item({ id: "linked" }), item({ id: "other" })], { ...context, exactLinkedId: "linked" });
  assert.equal(result.kind, "reuse");
  if (result.kind === "reuse") assert.equal(result.item.id, "linked");
});

test("ambiguous matches create a new item and preserve duplicate context", () => {
  const result = chooseWorkItem([item({ id: "1" }), item({ id: "2" })], context);
  assert.equal(result.kind, "create");
  if (result.kind === "create") assert.equal(result.possibleDuplicate?.id, "1");
});

test("product identity contributes to deterministic matching", () => {
  const result = chooseWorkItem(
    [item({ id: "matching-product", product: "prototype-a" }), item({ id: "other-product", product: "prototype-b" })],
    { ...context, product: "prototype-a" },
  );
  assert.equal(result.kind, "reuse");
  if (result.kind === "reuse") assert.equal(result.item.id, "matching-product");
});

test("creation recovery resumes finishing and fails unknown creation outcomes closed", async () => {
  const recovery = new InMemoryProviderMutationRecovery<{ id: string }, { id: string }>();
  let creates = 0;
  let finishes = 0;
  const create = async () => { creates += 1; return { id: "created-1" }; };
  const finish = async (created: { id: string }) => {
    finishes += 1;
    if (finishes === 1) throw new Error("synthetic attachment failure");
    return created;
  };
  await assert.rejects(() => recovery.run("item-1", "fingerprint-1", create, finish), /attachment failure/);
  assert.deepEqual(await recovery.run("item-1", "fingerprint-1", create, finish), { id: "created-1" });
  assert.deepEqual({ creates, finishes }, { creates: 1, finishes: 2 });
  await assert.rejects(() => recovery.run("item-1", "different", create, finish), /different provider mutation/);

  const unknown = new InMemoryProviderMutationRecovery<{ id: string }, { id: string }>();
  let uncertainCreates = 0;
  const uncertainCreate = async (): Promise<{ id: string }> => { uncertainCreates += 1; throw new Error("synthetic provider timeout"); };
  await assert.rejects(() => unknown.run("item-2", "fingerprint-2", uncertainCreate, async (value) => value), /provider timeout/);
  await assert.rejects(() => unknown.run("item-2", "fingerprint-2", uncertainCreate, async (value) => value), /outcome is unknown/);
  assert.equal(uncertainCreates, 1);

  const concurrent = new InMemoryProviderMutationRecovery<{ id: string }, { id: string }>();
  let concurrentCreates = 0;
  let concurrentFinishes = 0;
  let releaseCreate!: (value: { id: string }) => void;
  const pendingCreate = () => new Promise<{ id: string }>((resolve) => {
    concurrentCreates += 1;
    releaseCreate = resolve;
  });
  const first = concurrent.run("item-3", "fingerprint-3", pendingCreate, async (value) => { concurrentFinishes += 1; return value; });
  const second = concurrent.run("item-3", "fingerprint-3", pendingCreate, async (value) => { concurrentFinishes += 1; return value; });
  releaseCreate({ id: "created-3" });
  assert.deepEqual(await Promise.all([first, second]), [{ id: "created-3" }, { id: "created-3" }]);
  assert.deepEqual({ concurrentCreates, concurrentFinishes }, { concurrentCreates: 1, concurrentFinishes: 1 });

  const refused = new InMemoryProviderMutationRecovery<{ id: string }, { id: string }>();
  let refusedCreates = 0;
  const retryRefused = async () => {
    refusedCreates += 1;
    if (refusedCreates === 1) throw new ProviderMutationRejectedError("synthetic refusal");
    return { id: "created-after-refusal" };
  };
  await assert.rejects(() => refused.run("item-4", "fingerprint-4", retryRefused, async (value) => value), /synthetic refusal/);
  assert.deepEqual(await refused.run("item-4", "fingerprint-4", retryRefused, async (value) => value), { id: "created-after-refusal" });
  assert.equal(refusedCreates, 2);

  const bounded = new InMemoryProviderMutationRecovery<{ id: string }, { id: string }>(1);
  let boundedCreates = 0;
  const createBounded = async (id: string) => { boundedCreates += 1; return { id }; };
  assert.deepEqual(await bounded.run("bounded-1", "bounded-fingerprint-1", () => createBounded("first"), async (value) => value), { id: "first" });
  assert.deepEqual(await bounded.run("bounded-1", "bounded-fingerprint-1", () => createBounded("duplicate"), async (value) => value), { id: "first" });
  assert.deepEqual(await bounded.run("bounded-2", "bounded-fingerprint-2", () => createBounded("second"), async (value) => value), { id: "second" });
  assert.deepEqual(await bounded.run("bounded-2", "bounded-fingerprint-2", () => createBounded("duplicate"), async (value) => value), { id: "second" });
  assert.equal(boundedCreates, 2);

  const partial = new InMemoryProviderMutationRecovery<{ id: string }, { id: string }>(1);
  let partialFinishes = 0;
  const finishPartial = async (value: { id: string }) => {
    partialFinishes += 1;
    if (partialFinishes === 1) throw new Error("synthetic partial attachment");
    return value;
  };
  await assert.rejects(() => partial.run("partial-1", "partial-fingerprint-1", async () => ({ id: "partial" }), finishPartial), /partial attachment/);
  await assert.rejects(() => partial.run("partial-2", "partial-fingerprint-2", async () => ({ id: "other" }), async (value) => value), /capacity exceeded by unresolved records/);
  assert.deepEqual(await partial.run("partial-1", "partial-fingerprint-1", async () => ({ id: "duplicate" }), finishPartial), { id: "partial" });
  assert.deepEqual(await partial.run("partial-2", "partial-fingerprint-2", async () => ({ id: "other" }), async (value) => value), { id: "other" });

  const unresolved = new InMemoryProviderMutationRecovery<{ id: string }, { id: string }>(1);
  await assert.rejects(() => unresolved.run("unknown-1", "unknown-fingerprint-1", async () => { throw new Error("synthetic unknown outcome"); }, async (value) => value), /unknown outcome/);
  await assert.rejects(() => unresolved.run("unknown-2", "unknown-fingerprint-2", async () => ({ id: "other" }), async (value) => value), /capacity exceeded by unresolved records/);
});

test("stable body includes every required review dimension", () => {
  const body = stableIssueBody({ reviewId: "r", prototypeId: "p", revisionId: "v", viewportId: "mobile", variantId: "a", route: "/demo", anchorFingerprint: "sha256:a", captureDigest: "sha256:c", reviewUrl: "https://review.example.test/r" }, contextBinding, contextSecret);
  for (const label of ["Review:", "Prototype:", "Revision:", "Viewport:", "Variant:", "Route:", "Anchor:", "Capture:", "Context signature:"]) assert.match(body, new RegExp(label));
});

test("stable issue context is single-line and round trips for matching", () => {
  const body = stableIssueBody({ reviewId: "r", prototypeId: "p", revisionId: "v", viewportId: "mobile", variantId: "a", route: "/demo\nRepository: injected/repo", anchorFingerprint: "anchor\r\nis:pr", reviewUrl: "https://review.example.test/r" }, contextBinding, contextSecret);
  const parsed = parseStableIssueContext(body, contextBinding, contextSecret);

  assert.equal(parsed.product, "p");
  assert.equal(parsed.route, "/demo Repository: injected/repo");
  assert.equal(parsed.anchorFingerprint, "anchor is:pr");
  assert.doesNotMatch(body, /\nRepository: injected/);
});

test("stable issue context ignores later prose and rejects malformed or duplicate blocks", () => {
  const body = stableIssueBody({ reviewId: "r", prototypeId: "p", revisionId: "v", viewportId: "mobile", variantId: "a", route: "/demo", anchorFingerprint: "anchor-1", reviewUrl: "https://review.example.test/r" }, contextBinding, contextSecret);
  assert.deepEqual(parseStableIssueContext(`${body}\n\nUser note\nRoute: /unrelated\nAnchor: unrelated`, contextBinding, contextSecret), { product: "p", route: "/demo", anchorFingerprint: "anchor-1" });
  assert.deepEqual(parseStableIssueContext(`${body}\n${body}`, contextBinding, contextSecret), {});
  assert.deepEqual(parseStableIssueContext(body.replace("Revision: v", "Route: /duplicate"), contextBinding, contextSecret), {});
  assert.deepEqual(parseStableIssueContext(body.replace("Anchor: anchor-1", "Anchor: "), contextBinding, contextSecret), {});
});

test("stable issue context rejects edits, forgeries, and cross-item copies", () => {
  const body = stableIssueBody({ reviewId: "r", prototypeId: "p", revisionId: "v", viewportId: "mobile", variantId: "a", route: "/demo", anchorFingerprint: "anchor-1", reviewUrl: "https://review.example.test/r" }, contextBinding, contextSecret);
  assert.deepEqual(parseStableIssueContext(body.replace("Route: /demo", "Route: /forged"), contextBinding, contextSecret), {});
  assert.deepEqual(parseStableIssueContext(body, { ...contextBinding, workItemId: "org/repo#43" }, contextSecret), {});
  assert.deepEqual(parseStableIssueContext(body, contextBinding, "wrong-secret"), {});
});

test("webhook HMAC comparison fails closed", () => {
  const body = new TextEncoder().encode("synthetic");
  const secret = "test-only-secret";
  const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  assert.equal(verifyHmacSha256(body, signature, secret), true);
  assert.equal(verifyHmacSha256(body, `${signature}0`, secret), false);
  assert.equal(verifyHmacSha256(body, `sha256=${"z".repeat(64)}`, secret), false);
});

test("webhook input limits fail closed", () => {
  assert.throws(() => requireWebhookBody(new Uint8Array()), /empty/);
  assert.throws(() => requireWebhookBody(new Uint8Array(MAX_WEBHOOK_BODY_BYTES + 1)), /size limit/);
  assert.throws(() => requireDeliveryId(""), /delivery id/);
  assert.throws(() => requireFreshTimestamp(1_000, 62_000), /stale/);
  assert.equal(requireDeliveryId("delivery-1"), "delivery-1");
});

test("webhook delivery ledger rejects replay in memory", async () => {
  const ledger = new InMemoryWebhookDeliveryLedger();
  await processUniqueDelivery(ledger, "github", "delivery-1", {}, async () => {});
  await assert.rejects(() => processUniqueDelivery(ledger, "github", "delivery-1", {}, async () => {}), /duplicate/);
  await assert.doesNotReject(() => processUniqueDelivery(ledger, "linear", "delivery-1", {}, async () => {}));
});

test("webhook delivery ledger releases a failed application for retry", async () => {
  const ledger = new InMemoryWebhookDeliveryLedger();
  await assert.rejects(
    () => processUniqueDelivery(ledger, "github", "delivery-1", {}, async () => { throw new Error("synthetic apply failure"); }),
    /apply failure/,
  );
  await assert.doesNotReject(() => processUniqueDelivery(ledger, "github", "delivery-1", {}, async () => {}));
});

test("file webhook delivery ledger survives process-local adapter replacement", async () => {
  const directory = await mkdtemp(join(tmpdir(), "collab-review-deliveries-"));
  try {
    await processUniqueDelivery(new FileWebhookDeliveryLedger(directory), "github", "delivery-1", {}, async () => {});
    await assert.rejects(
      () => processUniqueDelivery(new FileWebhookDeliveryLedger(directory), "github", "delivery-1", {}, async () => {}),
      /duplicate/,
    );
    const markers = await readdir(directory);
    assert.equal(markers.length, 1);
    assert.match(markers[0]!, /^[a-f0-9]{64}\.completed$/);
    assert.equal((await stat(join(directory, markers[0]!))).mode & 0o777, 0o600);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("file webhook delivery ledger makes a failed application retryable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "collab-review-delivery-retry-"));
  try {
    await assert.rejects(
      () => processUniqueDelivery(new FileWebhookDeliveryLedger(directory), "github", "delivery-1", {}, async () => { throw new Error("synthetic apply failure"); }),
      /apply failure/,
    );
    await assert.doesNotReject(
      () => processUniqueDelivery(new FileWebhookDeliveryLedger(directory), "github", "delivery-1", {}, async () => {}),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("file webhook delivery ledger repairs broad directory permissions", async () => {
  const parent = await mkdtemp(join(tmpdir(), "collab-review-delivery-mode-"));
  const directory = join(parent, "ledger");
  try {
    await mkdir(directory, { mode: 0o755 });
    await chmod(directory, 0o755);
    await processUniqueDelivery(new FileWebhookDeliveryLedger(directory), "github", "delivery-1", {}, async () => {});
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
