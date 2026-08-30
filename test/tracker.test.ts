import assert from "node:assert/strict";
import test from "node:test";
import { chooseWorkItem, parseStableIssueContext, stableIssueBody, type SearchContext, type WorkItem } from "../src/tracker.ts";
import { FileWebhookDeliveryLedger, InMemoryWebhookDeliveryLedger, MAX_WEBHOOK_BODY_BYTES, requireDeliveryId, requireFreshTimestamp, requireUniqueDelivery, requireWebhookBody, verifyHmacSha256 } from "../src/webhook.ts";
import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const context: SearchContext = { container: { provider: "github", id: "org/repo", workspaceId: "org", name: "repo" }, repository: "org/repo", route: "/demo", anchorFingerprint: "anchor-1", labels: ["bug"], now: "2026-08-30T00:00:00Z" };
const item = (overrides: Partial<WorkItem>): WorkItem => ({ provider: "github", id: "1", url: "https://example.test/1", title: "Synthetic issue", body: "", state: "open", containerId: "org/repo", repository: "org/repo", route: "/demo", anchorFingerprint: "anchor-1", labels: ["bug"], updatedAt: "2026-08-29T00:00:00Z", ...overrides });

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

test("stable body includes every required review dimension", () => {
  const body = stableIssueBody({ reviewId: "r", prototypeId: "p", revisionId: "v", viewportId: "mobile", variantId: "a", route: "/demo", anchorFingerprint: "sha256:a", captureDigest: "sha256:c", reviewUrl: "https://review.example.test/r" });
  for (const label of ["Review:", "Prototype:", "Revision:", "Viewport:", "Variant:", "Route:", "Anchor:", "Capture:"]) assert.match(body, new RegExp(label));
});

test("stable issue context is single-line and round trips for matching", () => {
  const body = stableIssueBody({ reviewId: "r", prototypeId: "p", revisionId: "v", viewportId: "mobile", variantId: "a", route: "/demo\nRepository: injected/repo", anchorFingerprint: "anchor\r\nis:pr", reviewUrl: "https://review.example.test/r" });
  const parsed = parseStableIssueContext(body);

  assert.equal(parsed.route, "/demo Repository: injected/repo");
  assert.equal(parsed.anchorFingerprint, "anchor is:pr");
  assert.doesNotMatch(body, /\nRepository: injected/);
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
  await requireUniqueDelivery(ledger, "github", "delivery-1");
  await assert.rejects(() => requireUniqueDelivery(ledger, "github", "delivery-1"), /duplicate/);
  await assert.doesNotReject(() => requireUniqueDelivery(ledger, "linear", "delivery-1"));
});

test("file webhook delivery ledger survives process-local adapter replacement", async () => {
  const directory = await mkdtemp(join(tmpdir(), "collab-review-deliveries-"));
  try {
    await requireUniqueDelivery(new FileWebhookDeliveryLedger(directory), "github", "delivery-1");
    await assert.rejects(
      () => requireUniqueDelivery(new FileWebhookDeliveryLedger(directory), "github", "delivery-1"),
      /duplicate/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
