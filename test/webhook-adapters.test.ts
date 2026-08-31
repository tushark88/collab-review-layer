import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { GitHubIssuesTracker } from "../src/adapters/github.ts";
import { TrackerHttpError, type JsonTransport } from "../src/adapters/http.ts";
import { LinearTracker } from "../src/adapters/linear.ts";
import { chooseWorkItem, stableIssueBody, trackerCommentBody, type SearchContext, type TrackerWebhook } from "../src/tracker.ts";
import { InMemoryWebhookDeliveryLedger } from "../src/webhook.ts";

const unusedTransport: JsonTransport = { async request<T>(): Promise<T> { throw new Error("not used"); } };
const stableContext = { reviewId: "review", prototypeId: "prototype", revisionId: "revision", viewportId: "mobile", variantId: "control", route: "/demo", anchorFingerprint: "anchor-1", reviewUrl: "https://review.example.test/review" };
const otherContext = { ...stableContext, reviewId: "other", route: "/other", anchorFingerprint: "other-anchor", reviewUrl: "https://review.example.test/other" };
const githubStableBody = (repository: string, number: number, context = stableContext) => stableIssueBody(context, { provider: "github", workItemId: `${repository}#${number}` }, "test-secret");
const linearStableBody = (id: string, context = stableContext) => stableIssueBody(context, { provider: "linear", workItemId: id }, "test-secret");

test("Linear verifies raw signature, official timestamp, and delivery id", async () => {
  const secret = "linear-test-secret";
  const now = 1_800_000_000_000;
  const body = new TextEncoder().encode(JSON.stringify({ type: "Comment", action: "create", webhookTimestamp: now, data: { id: "comment-1", issueId: "issue-1", body: "Synthetic reply", privateField: "not projected" }, privateField: "not projected" }));
  const signature = createHmac("sha256", secret).update(body).digest("hex");
  const tracker = new LinearTracker({ endpoint: "https://api.linear.app/graphql", token: "test-token", webhookSecret: secret, teamId: "team", now: () => now, deliveries: new InMemoryWebhookDeliveryLedger(), dispositionStateIds: { accepted: "open", rejected: "canceled", implemented_verified: "done" } }, unusedTransport);
  let parsed: TrackerWebhook | undefined;
  await tracker.processWebhook(body, { "linear-signature": signature, "linear-timestamp": String(now), "linear-delivery": "delivery-1", "linear-event": "Comment" }, async (webhook) => { parsed = webhook; });
  assert.equal(parsed?.deliveryId, "delivery-1");
  assert.equal(parsed?.event, "Comment");
  assert.equal(parsed?.workItemId, "issue-1");
  assert.equal(parsed?.commentBody, "Synthetic reply");
  assert.doesNotMatch(JSON.stringify(parsed?.raw), /privateField/);
  await assert.rejects(() => tracker.processWebhook(body, { "linear-signature": signature, "linear-timestamp": String(now), "linear-delivery": "delivery-1", "linear-event": "Comment" }, async () => {}), /duplicate/);
  const staleBody = new TextEncoder().encode(JSON.stringify({ type: "Comment", webhookTimestamp: now - 61_000, data: { id: "issue-1" } }));
  const staleSignature = createHmac("sha256", secret).update(staleBody).digest("hex");
  await assert.rejects(() => tracker.processWebhook(staleBody, { "linear-signature": staleSignature, "linear-timestamp": String(now - 61_000), "linear-delivery": "delivery-2" }, async () => {}), /stale/);
});

test("GitHub requires a valid signature and delivery id", async () => {
  const secret = "github-test-secret";
  const body = new TextEncoder().encode(JSON.stringify({ action: "created", issue: { number: 42 }, comment: { body: "Synthetic reply", privateField: "not projected" }, repository: { full_name: "owner/repo" }, privateField: "not projected" }));
  const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  const tracker = new GitHubIssuesTracker({ endpoint: "https://api.github.com", token: "test-token", webhookSecret: secret, owner: "owner", repository: "repo", workspace: { kind: "user", login: "owner" }, deliveries: new InMemoryWebhookDeliveryLedger() }, unusedTransport);
  let parsed: TrackerWebhook | undefined;
  await tracker.processWebhook(body, { "x-hub-signature-256": signature, "x-github-delivery": "delivery-1", "x-github-event": "issue_comment" }, async (webhook) => { parsed = webhook; });
  assert.equal(parsed?.workItemId, "owner/repo#42");
  assert.equal(parsed?.commentBody, "Synthetic reply");
  assert.doesNotMatch(JSON.stringify(parsed?.raw), /privateField/);
  await assert.rejects(() => tracker.processWebhook(body, { "x-hub-signature-256": signature, "x-github-delivery": "delivery-1", "x-github-event": "issue_comment" }, async () => {}), /duplicate/);
  await assert.rejects(() => tracker.processWebhook(body, { "x-hub-signature-256": signature }, async () => {}), /delivery id/);
});

test("both tracker adapters release failed webhook applications for retry", async () => {
  const githubSecret = "github-test-secret";
  const githubBody = new TextEncoder().encode(JSON.stringify({ action: "opened", issue: { number: 42 }, repository: { full_name: "owner/repo" } }));
  const githubSignature = `sha256=${createHmac("sha256", githubSecret).update(githubBody).digest("hex")}`;
  const github = new GitHubIssuesTracker({ endpoint: "https://api.github.com", token: "test-token", webhookSecret: githubSecret, owner: "owner", repository: "repo", workspace: { kind: "user", login: "owner" }, deliveries: new InMemoryWebhookDeliveryLedger() }, unusedTransport);
  const githubHeaders = { "x-hub-signature-256": githubSignature, "x-github-delivery": "retry-1", "x-github-event": "issues" };
  await assert.rejects(() => github.processWebhook(githubBody, githubHeaders, async () => { throw new Error("synthetic GitHub apply failure"); }), /apply failure/);
  await assert.doesNotReject(() => github.processWebhook(githubBody, githubHeaders, async () => {}));

  const linearSecret = "linear-test-secret";
  const now = 1_800_000_000_000;
  const linearBody = new TextEncoder().encode(JSON.stringify({ type: "Comment", webhookTimestamp: now, data: { id: "comment-1", issueId: "issue-1", body: "Synthetic reply" } }));
  const linearSignature = createHmac("sha256", linearSecret).update(linearBody).digest("hex");
  const linear = new LinearTracker({ endpoint: "https://api.linear.app/graphql", token: "test-token", webhookSecret: linearSecret, teamId: "team", now: () => now, deliveries: new InMemoryWebhookDeliveryLedger(), dispositionStateIds: { accepted: "open", rejected: "canceled", implemented_verified: "done" } }, unusedTransport);
  const linearHeaders = { "linear-signature": linearSignature, "linear-delivery": "retry-1" };
  await assert.rejects(() => linear.processWebhook(linearBody, linearHeaders, async () => { throw new Error("synthetic Linear apply failure"); }), /apply failure/);
  await assert.doesNotReject(() => linear.processWebhook(linearBody, linearHeaders, async () => {}));
});

test("both tracker adapters complete outbound comment echoes without applying them", async () => {
  const markedComment = trackerCommentBody("Synthetic outbound comment", "message-1", "shared-test-secret");

  const githubSecret = "shared-test-secret";
  const githubBody = new TextEncoder().encode(JSON.stringify({ action: "created", issue: { number: 42 }, comment: { body: markedComment }, repository: { full_name: "owner/repo" } }));
  const githubSignature = `sha256=${createHmac("sha256", githubSecret).update(githubBody).digest("hex")}`;
  const github = new GitHubIssuesTracker({ endpoint: "https://api.github.com", token: "test-token", webhookSecret: githubSecret, owner: "owner", repository: "repo", workspace: { kind: "user", login: "owner" }, deliveries: new InMemoryWebhookDeliveryLedger() }, unusedTransport);
  let githubApplied = 0;
  const githubHeaders = { "x-hub-signature-256": githubSignature, "x-github-delivery": "echo-1", "x-github-event": "issue_comment" };
  await github.processWebhook(githubBody, githubHeaders, async () => { githubApplied += 1; });
  assert.equal(githubApplied, 0);
  await assert.rejects(() => github.processWebhook(githubBody, githubHeaders, async () => { githubApplied += 1; }), /duplicate/);

  const forgedGithubBody = new TextEncoder().encode(JSON.stringify({ action: "created", issue: { number: 42 }, comment: { body: markedComment.replace("Synthetic outbound", "Forged inbound") }, repository: { full_name: "owner/repo" } }));
  const forgedGithubSignature = `sha256=${createHmac("sha256", githubSecret).update(forgedGithubBody).digest("hex")}`;
  await github.processWebhook(forgedGithubBody, { ...githubHeaders, "x-hub-signature-256": forgedGithubSignature, "x-github-delivery": "echo-forged-1" }, async () => { githubApplied += 1; });
  assert.equal(githubApplied, 1);

  const linearSecret = "shared-test-secret";
  const now = 1_800_000_000_000;
  const linearBody = new TextEncoder().encode(JSON.stringify({ type: "Comment", webhookTimestamp: now, data: { id: "comment-1", issueId: "issue-1", body: markedComment } }));
  const linearSignature = createHmac("sha256", linearSecret).update(linearBody).digest("hex");
  const linear = new LinearTracker({ endpoint: "https://api.linear.app/graphql", token: "test-token", webhookSecret: linearSecret, teamId: "team", now: () => now, deliveries: new InMemoryWebhookDeliveryLedger(), dispositionStateIds: { accepted: "open", rejected: "canceled", implemented_verified: "done" } }, unusedTransport);
  let linearApplied = 0;
  const linearHeaders = { "linear-signature": linearSignature, "linear-delivery": "echo-1", "linear-event": "Comment" };
  await linear.processWebhook(linearBody, linearHeaders, async () => { linearApplied += 1; });
  assert.equal(linearApplied, 0);
  await assert.rejects(() => linear.processWebhook(linearBody, linearHeaders, async () => { linearApplied += 1; }), /duplicate/);
});

test("GitHub webhooks are repository-bound and reject malformed supported payloads", async () => {
  const secret = "github-test-secret";
  const tracker = new GitHubIssuesTracker({ endpoint: "https://api.github.com", token: "test-token", webhookSecret: secret, owner: "owner", repository: "repo", workspace: { kind: "user", login: "owner" }, deliveries: new InMemoryWebhookDeliveryLedger() }, unusedTransport);
  const headersFor = (body: Uint8Array, delivery: string) => ({
    "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
    "x-github-delivery": delivery,
    "x-github-event": "issue_comment",
  });
  const crossRepository = new TextEncoder().encode(JSON.stringify({ action: "created", issue: { number: 42 }, comment: { body: "Synthetic reply" }, repository: { full_name: "owner/other" } }));
  await assert.rejects(() => tracker.processWebhook(crossRepository, headersFor(crossRepository, "cross-repo"), async () => {}), /does not match/);

  const malformed = new TextEncoder().encode(JSON.stringify({ action: "created", issue: { number: "42" }, comment: { body: 7 }, repository: { full_name: "owner/repo" } }));
  await assert.rejects(() => tracker.processWebhook(malformed, headersFor(malformed, "malformed"), async () => {}), /issue number/);
});

test("Linear rejects event mismatches and malformed comment payloads", async () => {
  const secret = "linear-test-secret";
  const now = 1_800_000_000_000;
  const tracker = new LinearTracker({ endpoint: "https://api.linear.app/graphql", token: "test-token", webhookSecret: secret, teamId: "team", now: () => now, deliveries: new InMemoryWebhookDeliveryLedger(), dispositionStateIds: { accepted: "open", rejected: "canceled", implemented_verified: "done" } }, unusedTransport);
  const body = new TextEncoder().encode(JSON.stringify({ type: "Comment", webhookTimestamp: now, data: { id: "comment-1", issueId: "issue-1", body: 7 } }));
  const headers = { "linear-signature": createHmac("sha256", secret).update(body).digest("hex"), "linear-delivery": "malformed-linear", "linear-event": "Issue" };
  await assert.rejects(() => tracker.processWebhook(body, headers, async () => {}), /does not match/);
  await assert.rejects(
    () => tracker.processWebhook(body, { ...headers, "linear-delivery": "malformed-comment", "linear-event": "Comment" }, async () => {}),
    /comment body/,
  );
});

test("rejected dispositions record their reason before changing provider state", async () => {
  const githubCalls: string[] = [];
  const githubTransport: JsonTransport = {
    async request<T>(input: { method: "GET" | "POST" | "PATCH"; url: string; headers: Record<string, string>; body?: unknown }): Promise<T> {
      githubCalls.push(input.method);
      if (input.method === "POST") throw new Error("synthetic comment failure");
      return {} as T;
    },
  };
  const github = new GitHubIssuesTracker({ endpoint: "https://api.github.com", token: "test-token", webhookSecret: "test-secret", owner: "owner", repository: "repo", workspace: { kind: "user", login: "owner" }, deliveries: new InMemoryWebhookDeliveryLedger() }, githubTransport);
  await assert.rejects(() => github.applyDisposition("owner/repo#42", "rejected", "Synthetic reason"), /comment failure/);
  assert.deepEqual(githubCalls, ["POST"]);

  const linearCalls: string[] = [];
  const linearTransport: JsonTransport = {
    async request<T>(input: { method: "GET" | "POST" | "PATCH"; url: string; headers: Record<string, string>; body?: unknown }): Promise<T> {
      const query = (input.body as { query: string }).query;
      linearCalls.push(query.includes("commentCreate") ? "comment" : "state");
      if (query.includes("commentCreate")) throw new Error("synthetic comment failure");
      return { data: { issueUpdate: { success: true } } } as T;
    },
  };
  const linear = new LinearTracker({ endpoint: "https://api.linear.app/graphql", token: "test-token", webhookSecret: "test-secret", teamId: "team", now: () => Date.parse("2026-08-30T00:00:00Z"), deliveries: new InMemoryWebhookDeliveryLedger(), dispositionStateIds: { accepted: "open", rejected: "canceled", implemented_verified: "done" } }, linearTransport);
  await assert.rejects(() => linear.applyDisposition("issue-1", "rejected", "Synthetic reason"), /comment failure/);
  assert.deepEqual(linearCalls, ["comment"]);
});

test("tracker comments use opaque sync markers", async () => {
  let githubBody: unknown;
  const githubTransport: JsonTransport = {
    async request<T>(input: { method: "GET" | "POST" | "PATCH"; url: string; headers: Record<string, string>; body?: unknown }): Promise<T> {
      githubBody = input.body;
      return {} as T;
    },
  };
  const github = new GitHubIssuesTracker({ endpoint: "https://api.github.com", token: "test-token", webhookSecret: "test-secret", owner: "owner", repository: "repo", workspace: { kind: "user", login: "owner" }, deliveries: new InMemoryWebhookDeliveryLedger() }, githubTransport);
  await github.addComment("owner/repo#42", "Synthetic feedback", "unsafe-->marker");
  const serialized = JSON.stringify(githubBody);
  assert.match(serialized, /collab-review-sync:v1:[a-f0-9]{64}:[a-f0-9]{64}/);
  assert.doesNotMatch(serialized, /unsafe/);
});

test("tracker creation binds signed context only after immutable item identity exists", async () => {
  const githubCalls: Array<{ method: string; body?: unknown }> = [];
  const githubTransport: JsonTransport = {
    async request<T>(input: { method: "GET" | "POST" | "PATCH"; url: string; headers: Record<string, string>; body?: unknown }): Promise<T> {
      githubCalls.push({ method: input.method, body: input.body });
      if (input.method === "POST") {
        return { number: 42, html_url: "https://github.com/owner/repo/issues/42", title: "Synthetic", state: "open", labels: [], updated_at: "2026-08-30T00:00:00Z" } as T;
      }
      return {} as T;
    },
  };
  const github = new GitHubIssuesTracker({ endpoint: "https://api.github.com", token: "test-token", webhookSecret: "test-secret", owner: "owner", repository: "repo", workspace: { kind: "user", login: "owner" }, deliveries: new InMemoryWebhookDeliveryLedger() }, githubTransport);
  const githubItem = await github.createItem({ provider: "github", id: "owner/repo", workspaceId: "owner", name: "repo" }, { title: "Synthetic", context: stableContext, labels: [], idempotencyKey: "item-1" });
  assert.doesNotMatch(JSON.stringify(githubCalls[0]?.body), /anchor-1/);
  assert.match(JSON.stringify(githubCalls[1]?.body), /Context signature: hmac-sha256:[a-f0-9]{64}/);
  assert.match(githubItem.body, /Context signature/);

  const linearCalls: Array<{ query: string; variables: unknown }> = [];
  const linearTransport: JsonTransport = {
    async request<T>(input: { method: "GET" | "POST" | "PATCH"; url: string; headers: Record<string, string>; body?: unknown }): Promise<T> {
      const operation = input.body as { query: string; variables: unknown };
      linearCalls.push(operation);
      if (operation.query.includes("issueCreate")) return { data: { issueCreate: { success: true, issue: { id: "issue-1", url: "https://linear.example.test/issue/issue-1", title: "Synthetic", updatedAt: "2026-08-30T00:00:00Z" } } } } as T;
      return { data: { issueUpdate: { success: true } } } as T;
    },
  };
  const linear = new LinearTracker({ endpoint: "https://api.linear.app/graphql", token: "test-token", webhookSecret: "test-secret", teamId: "team", now: () => Date.parse("2026-08-30T00:00:00Z"), deliveries: new InMemoryWebhookDeliveryLedger(), dispositionStateIds: { accepted: "open", rejected: "canceled", implemented_verified: "done" } }, linearTransport);
  const linearItem = await linear.createItem({ provider: "linear", id: "project-1", workspaceId: "workspace", name: "Review" }, { title: "Synthetic", context: stableContext, labels: [], idempotencyKey: "item-1" });
  assert.doesNotMatch(JSON.stringify(linearCalls[0]?.variables), /anchor-1/);
  assert.match(JSON.stringify(linearCalls[1]?.variables), /Context signature: hmac-sha256:[a-f0-9]{64}/);
  assert.match(linearItem.body, /Context signature/);
});

test("both tracker adapters retry context attachment without creating a second item", async () => {
  let githubCreates = 0;
  let githubAttachments = 0;
  const githubTransport: JsonTransport = {
    async request<T>(input: { method: "GET" | "POST" | "PATCH"; url: string; headers: Record<string, string>; body?: unknown }): Promise<T> {
      if (input.method === "POST") {
        githubCreates += 1;
        return { number: 42, html_url: "https://github.com/owner/repo/issues/42", title: "Synthetic", state: "open", labels: [], updated_at: "2026-08-30T00:00:00Z" } as T;
      }
      githubAttachments += 1;
      if (githubAttachments === 1) throw new Error("synthetic GitHub attachment failure");
      return {} as T;
    },
  };
  const github = new GitHubIssuesTracker({ endpoint: "https://api.github.com", token: "test-token", webhookSecret: "test-secret", owner: "owner", repository: "repo", workspace: { kind: "user", login: "owner" }, deliveries: new InMemoryWebhookDeliveryLedger() }, githubTransport);
  const githubContainer = { provider: "github", id: "owner/repo", workspaceId: "owner", name: "repo" } as const;
  const draft = { title: "Synthetic", context: stableContext, labels: [], idempotencyKey: "recover-item-1" };
  await assert.rejects(() => github.createItem(githubContainer, draft), /attachment failure/);
  assert.equal((await github.createItem(githubContainer, draft)).id, "owner/repo#42");
  assert.deepEqual({ creates: githubCreates, attachments: githubAttachments }, { creates: 1, attachments: 2 });

  let linearCreates = 0;
  let linearAttachments = 0;
  const linearTransport: JsonTransport = {
    async request<T>(input: { method: "GET" | "POST" | "PATCH"; url: string; headers: Record<string, string>; body?: unknown }): Promise<T> {
      const query = (input.body as { query: string }).query;
      if (query.includes("issueCreate")) {
        linearCreates += 1;
        return { data: { issueCreate: { success: true, issue: { id: "issue-1", url: "https://linear.example.test/issue/issue-1", title: "Synthetic", updatedAt: "2026-08-30T00:00:00Z" } } } } as T;
      }
      linearAttachments += 1;
      return { data: { issueUpdate: { success: linearAttachments > 1 } } } as T;
    },
  };
  const linear = new LinearTracker({ endpoint: "https://api.linear.app/graphql", token: "test-token", webhookSecret: "test-secret", teamId: "team", now: () => Date.parse("2026-08-30T00:00:00Z"), deliveries: new InMemoryWebhookDeliveryLedger(), dispositionStateIds: { accepted: "open", rejected: "canceled", implemented_verified: "done" } }, linearTransport);
  const linearContainer = { provider: "linear", id: "project-1", workspaceId: "workspace", name: "Review" } as const;
  await assert.rejects(() => linear.createItem(linearContainer, draft), /context attachment was not accepted/);
  assert.equal((await linear.createItem(linearContainer, draft)).id, "issue-1");
  assert.deepEqual({ creates: linearCreates, attachments: linearAttachments }, { creates: 1, attachments: 2 });
});

test("both tracker adapters retry definitive creation refusals and fence uncertain outcomes", async () => {
  const githubContainer = { provider: "github", id: "owner/repo", workspaceId: "owner", name: "repo" } as const;
  const linearContainer = { provider: "linear", id: "project-1", workspaceId: "workspace", name: "Review" } as const;
  const draft = { title: "Synthetic", context: stableContext, labels: [], idempotencyKey: "creation-refusal-1" };

  let githubRefusalCalls = 0;
  const githubRefusalTransport: JsonTransport = {
    async request<T>(input: { method: "GET" | "POST" | "PATCH"; url: string; headers: Record<string, string>; body?: unknown }): Promise<T> {
      if (input.method === "POST") {
        githubRefusalCalls += 1;
        if (githubRefusalCalls === 1) throw new TrackerHttpError(422);
        return { number: 42, html_url: "https://github.com/owner/repo/issues/42", title: "Synthetic", state: "open", labels: [], updated_at: "2026-08-30T00:00:00Z" } as T;
      }
      return {} as T;
    },
  };
  const githubRefusal = new GitHubIssuesTracker({ endpoint: "https://api.github.com", token: "test-token", webhookSecret: "test-secret", owner: "owner", repository: "repo", workspace: { kind: "user", login: "owner" }, deliveries: new InMemoryWebhookDeliveryLedger() }, githubRefusalTransport);
  await assert.rejects(() => githubRefusal.createItem(githubContainer, draft), /422/);
  assert.equal((await githubRefusal.createItem(githubContainer, draft)).id, "owner/repo#42");
  assert.equal(githubRefusalCalls, 2);

  let githubUncertainCalls = 0;
  const githubUncertain = new GitHubIssuesTracker({ endpoint: "https://api.github.com", token: "test-token", webhookSecret: "test-secret", owner: "owner", repository: "repo", workspace: { kind: "user", login: "owner" }, deliveries: new InMemoryWebhookDeliveryLedger() }, {
    async request<T>(): Promise<T> { githubUncertainCalls += 1; throw new TrackerHttpError(503); },
  });
  await assert.rejects(() => githubUncertain.createItem(githubContainer, draft), /503/);
  await assert.rejects(() => githubUncertain.createItem(githubContainer, draft), /outcome is unknown/);
  assert.equal(githubUncertainCalls, 1);

  let linearRefusalCalls = 0;
  const linearRefusalTransport: JsonTransport = {
    async request<T>(input: { method: "GET" | "POST" | "PATCH"; url: string; headers: Record<string, string>; body?: unknown }): Promise<T> {
      const query = (input.body as { query: string }).query;
      if (query.includes("issueCreate")) {
        linearRefusalCalls += 1;
        return { data: { issueCreate: linearRefusalCalls === 1
          ? { success: false }
          : { success: true, issue: { id: "issue-1", url: "https://linear.example.test/issue/issue-1", title: "Synthetic", updatedAt: "2026-08-30T00:00:00Z" } } } } as T;
      }
      return { data: { issueUpdate: { success: true } } } as T;
    },
  };
  const linearConfig = { endpoint: "https://api.linear.app/graphql", token: "test-token", webhookSecret: "test-secret", teamId: "team", now: () => Date.parse("2026-08-30T00:00:00Z"), deliveries: new InMemoryWebhookDeliveryLedger(), dispositionStateIds: { accepted: "open", rejected: "canceled", implemented_verified: "done" } } as const;
  const linearRefusal = new LinearTracker(linearConfig, linearRefusalTransport);
  await assert.rejects(() => linearRefusal.createItem(linearContainer, draft), /not accepted/);
  assert.equal((await linearRefusal.createItem(linearContainer, draft)).id, "issue-1");
  assert.equal(linearRefusalCalls, 2);

  let linearUncertainCalls = 0;
  const linearUncertain = new LinearTracker(linearConfig, {
    async request<T>(): Promise<T> { linearUncertainCalls += 1; throw new Error("synthetic Linear timeout"); },
  });
  await assert.rejects(() => linearUncertain.createItem(linearContainer, draft), /Linear timeout/);
  await assert.rejects(() => linearUncertain.createItem(linearContainer, draft), /outcome is unknown/);
  assert.equal(linearUncertainCalls, 1);
});

test("Linear mutation payload failures stop disposition processing", async () => {
  const commentCalls: string[] = [];
  const rejectedTransport: JsonTransport = {
    async request<T>(input: { method: "GET" | "POST" | "PATCH"; url: string; headers: Record<string, string>; body?: unknown }): Promise<T> {
      const query = (input.body as { query: string }).query;
      commentCalls.push(query.includes("commentCreate") ? "comment" : "state");
      return { data: query.includes("commentCreate") ? { commentCreate: { success: false } } : { issueUpdate: { success: true } } } as T;
    },
  };
  const config = { endpoint: "https://api.linear.app/graphql", token: "test-token", webhookSecret: "test-secret", teamId: "team", now: () => Date.parse("2026-08-30T00:00:00Z"), deliveries: new InMemoryWebhookDeliveryLedger(), dispositionStateIds: { accepted: "open", rejected: "canceled", implemented_verified: "done" } } as const;
  await assert.rejects(() => new LinearTracker(config, rejectedTransport).applyDisposition("issue-1", "rejected", "Synthetic reason"), /comment creation was not accepted/);
  assert.deepEqual(commentCalls, ["comment"]);

  const stateCalls: string[] = [];
  const acceptedTransport: JsonTransport = {
    async request<T>(input: { method: "GET" | "POST" | "PATCH"; url: string; headers: Record<string, string>; body?: unknown }): Promise<T> {
      const query = (input.body as { query: string }).query;
      stateCalls.push(query.includes("issueUpdate") ? "state" : "comment");
      return { data: query.includes("issueUpdate") ? { issueUpdate: { success: false } } : { commentCreate: { success: true } } } as T;
    },
  };
  await assert.rejects(() => new LinearTracker(config, acceptedTransport).applyDisposition("issue-1", "accepted"), /disposition update was not accepted/);
  assert.deepEqual(stateCalls, ["state"]);
});

test("GitHub issue search treats review context as phrases, not qualifiers", async () => {
  let requestedUrl = "";
  const transport: JsonTransport = {
    async request<T>(input: { method: "GET" | "POST" | "PATCH"; url: string; headers: Record<string, string>; body?: unknown }): Promise<T> {
      requestedUrl = input.url;
      return { total_count: 0, incomplete_results: false, items: [] } as T;
    },
  };
  const tracker = new GitHubIssuesTracker({ endpoint: "https://api.github.com", token: "test-token", webhookSecret: "test-secret", owner: "owner", repository: "repo", workspace: { kind: "user", login: "owner" }, deliveries: new InMemoryWebhookDeliveryLedger() }, transport);
  const context: SearchContext = {
    container: { provider: "github", id: "owner/repo", workspaceId: "owner", name: "repo" },
    repository: "owner/repo",
    route: '/demo" repo:private/private',
    anchorFingerprint: 'anchor" is:pr',
    labels: [],
    now: "2026-08-30T00:00:00Z",
  };

  await tracker.candidates(context);

  assert.equal(
    new URL(requestedUrl).searchParams.get("q"),
    'repo:owner/repo is:issue in:body ("/demo repo:private/private" OR "anchor is:pr")',
  );
});

test("GitHub adapter honors exact, workspace-open, and recent-closed search tiers", async () => {
  const requestedUrls: string[] = [];
  const transport: JsonTransport = {
    async request<T>(input: { method: "GET" | "POST" | "PATCH"; url: string; headers: Record<string, string>; body?: unknown }): Promise<T> {
      requestedUrls.push(input.url);
      if (input.url.endsWith("/issues/42")) {
        return {
          number: 42,
          html_url: "https://github.com/owner/repo/issues/42",
          title: "Synthetic issue",
          body: githubStableBody("owner/repo", 42),
          state: "open",
          labels: [],
          updated_at: "2026-08-30T00:00:00Z",
        } as T;
      }
      if ((new URL(input.url).searchParams.get("q") ?? "").includes("is:open")) {
        return {
          total_count: 1,
          incomplete_results: false,
          items: [{
            number: 7,
            html_url: "https://github.com/owner/other/issues/7",
            repository_url: "https://api.github.com/repos/owner/other",
            title: "Workspace candidate",
            body: githubStableBody("owner/other", 7),
            state: "open",
            labels: [],
            updated_at: "2026-08-29T00:00:00Z",
          }],
        } as T;
      }
      return { total_count: 0, incomplete_results: false, items: [] } as T;
    },
  };
  const tracker = new GitHubIssuesTracker({ endpoint: "https://api.github.com", token: "test-token", webhookSecret: "test-secret", owner: "owner", repository: "repo", workspace: { kind: "user", login: "owner" }, deliveries: new InMemoryWebhookDeliveryLedger(), closedLookbackDays: 30 }, transport);
  const context: SearchContext = {
    exactLinkedId: "42",
    container: { provider: "github", id: "owner/repo", workspaceId: "owner", name: "repo" },
    repository: "owner/repo",
    route: "/demo",
    anchorFingerprint: "anchor-1",
    labels: [],
    now: "2026-08-30T00:00:00Z",
  };

  const exact = await tracker.candidates(context, "exact_link");
  const workspace = await tracker.candidates(context, "open_workspace");
  await tracker.candidates(context, "recent_closed");

  assert.equal(exact[0]?.id, "owner/repo#42");
  assert.equal(exact[0]?.route, "/demo");
  assert.equal(workspace[0]?.id, "owner/other#7");
  assert.equal(workspace[0]?.containerId, "owner/other");
  assert.match(new URL(requestedUrls[1]!).searchParams.get("q") ?? "", /user:owner is:issue is:open/);
  assert.match(new URL(requestedUrls[2]!).searchParams.get("q") ?? "", /user:owner is:issue is:closed updated:>=2026-07-31/);
  await assert.rejects(() => tracker.candidates({ ...context, exactLinkedId: "outside/repo#9" }, "exact_link"), /outside the configured workspace/);
});

test("copied or edited tracker context cannot drive fuzzy reuse", async () => {
  const copiedBody = githubStableBody("owner/repo", 42);
  const transport: JsonTransport = {
    async request<T>(): Promise<T> {
      return {
        total_count: 1,
        incomplete_results: false,
        items: [{
          number: 7,
          html_url: "https://github.com/owner/repo/issues/7",
          repository_url: "https://api.github.com/repos/owner/repo",
          title: "Attacker-authored synthetic issue",
          body: copiedBody,
          state: "open",
          labels: [{ name: "bug" }],
          updated_at: "2026-08-29T00:00:00Z",
        }],
      } as T;
    },
  };
  const tracker = new GitHubIssuesTracker({ endpoint: "https://api.github.com", token: "test-token", webhookSecret: "test-secret", owner: "owner", repository: "repo", workspace: { kind: "user", login: "owner" }, deliveries: new InMemoryWebhookDeliveryLedger() }, transport);
  const context: SearchContext = { container: { provider: "github", id: "owner/repo", workspaceId: "owner", name: "repo" }, repository: "owner/repo", route: "/demo", anchorFingerprint: "anchor-1", labels: ["bug"], now: "2026-08-30T00:00:00Z" };
  const candidates = await tracker.candidates(context);

  assert.equal(candidates[0]?.route, undefined);
  assert.equal(candidates[0]?.anchorFingerprint, undefined);
  assert.equal(chooseWorkItem(candidates, context).kind, "create");
});

test("Linear adapter honors exact, current-project, workspace-open, and recent-closed tiers", async () => {
  const issue = (id: string, projectId: string, state: string, updatedAt: string) => ({
    id,
    url: `https://linear.example.test/issue/${id}`,
    title: `Synthetic ${id}`,
    description: linearStableBody(id),
    state: { type: state },
    project: { id: projectId },
    labels: { nodes: [] },
    updatedAt,
  });
  const transport: JsonTransport = {
    async request<T>(input: { method: "GET" | "POST" | "PATCH"; url: string; headers: Record<string, string>; body?: unknown }): Promise<T> {
      const query = (input.body as { query: string }).query;
      if (query.includes("issue(id:$id)")) return { data: { issue: issue("exact", "other-project", "completed", "2026-01-01T00:00:00Z") } } as T;
      return {
        data: {
          issueSearch: {
            nodes: [
              issue("current", "project-1", "started", "2026-08-29T00:00:00Z"),
              issue("workspace", "project-2", "started", "2026-08-28T00:00:00Z"),
              issue("recent-closed", "project-2", "completed", "2026-08-20T00:00:00Z"),
              issue("old-closed", "project-2", "canceled", "2026-01-01T00:00:00Z"),
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      } as T;
    },
  };
  const tracker = new LinearTracker({ endpoint: "https://api.linear.app/graphql", token: "test-token", webhookSecret: "test-secret", teamId: "team", now: () => Date.parse("2026-08-30T00:00:00Z"), deliveries: new InMemoryWebhookDeliveryLedger(), closedLookbackDays: 30, dispositionStateIds: { accepted: "open", rejected: "canceled", implemented_verified: "done" } }, transport);
  const context: SearchContext = {
    exactLinkedId: "exact",
    container: { provider: "linear", id: "project-1", workspaceId: "workspace", name: "Review" },
    route: "/demo",
    anchorFingerprint: "anchor-1",
    labels: [],
    now: "2026-08-30T00:00:00Z",
  };

  assert.deepEqual((await tracker.candidates(context, "exact_link")).map(({ id }) => id), ["exact"]);
  assert.deepEqual((await tracker.candidates(context, "current_container")).map(({ id }) => id), ["current"]);
  assert.deepEqual((await tracker.candidates(context, "open_workspace")).map(({ id }) => id), ["current", "workspace"]);
  assert.deepEqual((await tracker.candidates(context, "recent_closed")).map(({ id }) => id), ["recent-closed"]);
});

test("GitHub and Linear aggregate later search pages before matching", async () => {
  const githubRecord = (number: number, context = stableContext) => ({
    number,
    html_url: `https://github.com/owner/repo/issues/${number}`,
    repository_url: "https://api.github.com/repos/owner/repo",
    title: `Synthetic ${number}`,
    body: githubStableBody("owner/repo", number, context),
    state: "open",
    labels: [{ name: "bug" }],
    updated_at: "2026-08-29T00:00:00Z",
  });
  const githubTransport: JsonTransport = {
    async request<T>(input: { method: "GET" | "POST" | "PATCH"; url: string; headers: Record<string, string>; body?: unknown }): Promise<T> {
      const page = new URL(input.url).searchParams.get("page");
      const firstPage = [githubRecord(1), ...Array.from({ length: 99 }, (_, index) => githubRecord(index + 2, otherContext))];
      return { total_count: 101, incomplete_results: false, items: page === "1" ? firstPage : [githubRecord(101)] } as T;
    },
  };
  const github = new GitHubIssuesTracker({ endpoint: "https://api.github.com", token: "test-token", webhookSecret: "test-secret", owner: "owner", repository: "repo", workspace: { kind: "user", login: "owner" }, deliveries: new InMemoryWebhookDeliveryLedger() }, githubTransport);
  const githubContext: SearchContext = { container: { provider: "github", id: "owner/repo", workspaceId: "owner", name: "repo" }, repository: "owner/repo", route: "/demo", anchorFingerprint: "anchor-1", labels: ["bug"], now: "2026-08-30T00:00:00Z" };
  const githubCandidates = await github.candidates(githubContext);
  assert.equal(githubCandidates.length, 101);
  assert.equal(chooseWorkItem(githubCandidates, githubContext).kind, "create");

  const linearIssue = (id: string, context = stableContext) => ({ id, url: `https://linear.example.test/issue/${id}`, title: `Synthetic ${id}`, description: linearStableBody(id, context), state: { type: "started" }, project: { id: "project-1" }, labels: { nodes: [{ name: "bug" }] }, updatedAt: "2026-08-29T00:00:00Z" });
  const linearTransport: JsonTransport = {
    async request<T>(input: { method: "GET" | "POST" | "PATCH"; url: string; headers: Record<string, string>; body?: unknown }): Promise<T> {
      const after = (input.body as { variables: { after?: string } }).variables.after;
      const issueSearch = after
        ? { nodes: [linearIssue("second")], pageInfo: { hasNextPage: false, endCursor: null } }
        : { nodes: [linearIssue("first")], pageInfo: { hasNextPage: true, endCursor: "page-2" } };
      return { data: { issueSearch } } as T;
    },
  };
  const linear = new LinearTracker({ endpoint: "https://api.linear.app/graphql", token: "test-token", webhookSecret: "test-secret", teamId: "team", now: () => Date.parse("2026-08-30T00:00:00Z"), deliveries: new InMemoryWebhookDeliveryLedger(), dispositionStateIds: { accepted: "open", rejected: "canceled", implemented_verified: "done" } }, linearTransport);
  const linearContext: SearchContext = { container: { provider: "linear", id: "project-1", workspaceId: "workspace", name: "Review" }, route: "/demo", anchorFingerprint: "anchor-1", labels: ["bug"], now: "2026-08-30T00:00:00Z" };
  const linearCandidates = await linear.candidates(linearContext);
  assert.equal(linearCandidates.length, 2);
  assert.equal(chooseWorkItem(linearCandidates, linearContext).kind, "create");
});

test("Linear search fails a never-ending paginated tier closed", async () => {
  let requests = 0;
  const transport: JsonTransport = {
    async request<T>(): Promise<T> {
      requests += 1;
      return {
        data: {
          issueSearch: {
            nodes: [],
            pageInfo: { hasNextPage: true, endCursor: `cursor-${requests}` },
          },
        },
      } as T;
    },
  };
  const tracker = new LinearTracker({ endpoint: "https://api.linear.app/graphql", token: "test-token", webhookSecret: "test-secret", teamId: "team", now: () => Date.parse("2026-08-30T00:00:00Z"), deliveries: new InMemoryWebhookDeliveryLedger(), dispositionStateIds: { accepted: "open", rejected: "canceled", implemented_verified: "done" } }, transport);
  const context: SearchContext = { container: { provider: "linear", id: "project-1", workspaceId: "workspace", name: "Review" }, route: "/demo", anchorFingerprint: "anchor-1", labels: [], now: "2026-08-30T00:00:00Z" };

  assert.deepEqual(await tracker.candidates(context), []);
  assert.equal(requests, 20);
});

test("GitHub configuration rejects a repository outside the search workspace", () => {
  assert.throws(
    () => new GitHubIssuesTracker({ endpoint: "https://api.github.com", token: "test-token", webhookSecret: "test-secret", owner: "repository-owner", repository: "repo", workspace: { kind: "org", login: "different-workspace" }, deliveries: new InMemoryWebhookDeliveryLedger() }, unusedTransport),
    /owner must match/,
  );
});
