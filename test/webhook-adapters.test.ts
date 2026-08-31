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
const trackerSecrets = (webhookSecret: string) => ({ webhookSecret, contextSigningSecret: `${webhookSecret}:context`, commentSigningSecret: `${webhookSecret}:comment`, workspaceId: "workspace" });
const githubStableBody = (repository: string, number: number, context = stableContext) => stableIssueBody(context, { provider: "github", workItemId: `${repository}#${number}` }, "test-secret:context");
const linearStableBody = (id: string, context = stableContext) => stableIssueBody(context, { provider: "linear", workItemId: id }, "test-secret:context");

test("Linear verifies raw signature, official timestamp, and delivery id", async () => {
  const secret = "linear-test-secret";
  const now = 1_800_000_000_000;
  const body = new TextEncoder().encode(JSON.stringify({ type: "Comment", action: "create", organizationId: "workspace", actor: { id: "actor-1", privateField: "not projected" }, webhookTimestamp: now, data: { id: "comment-1", issueId: "issue-1", body: "Synthetic reply", privateField: "not projected" }, privateField: "not projected" }));
  const signature = createHmac("sha256", secret).update(body).digest("hex");
  const tracker = new LinearTracker({ endpoint: "https://api.linear.app/graphql", token: "test-token", ...trackerSecrets(secret), teamId: "team", now: () => now, deliveries: new InMemoryWebhookDeliveryLedger(), dispositionStateIds: { accepted: "open", rejected: "canceled", implemented_verified: "done" } }, unusedTransport);
  let parsed: TrackerWebhook | undefined;
  await tracker.processWebhook(body, { "linear-signature": signature, "linear-timestamp": String(now), "linear-delivery": "delivery-1", "linear-event": "Comment" }, async (webhook) => { parsed = webhook; });
  assert.equal(parsed?.deliveryId, "delivery-1");
  assert.equal(parsed?.event, "Comment");
  assert.equal(parsed?.workItemId, "issue-1");
  assert.equal(parsed?.commentBody, "Synthetic reply");
  assert.equal(parsed?.providerActorId, "actor-1");
  assert.equal(parsed?.providerCommentId, "comment-1");
  assert.doesNotMatch(JSON.stringify(parsed?.raw), /privateField/);
  await assert.rejects(() => tracker.processWebhook(body, { "linear-signature": signature, "linear-timestamp": String(now), "linear-delivery": "delivery-1", "linear-event": "Comment" }, async () => {}), /duplicate/);
  const staleBody = new TextEncoder().encode(JSON.stringify({ type: "Comment", webhookTimestamp: now - 61_000, data: { id: "issue-1" } }));
  const staleSignature = createHmac("sha256", secret).update(staleBody).digest("hex");
  await assert.rejects(() => tracker.processWebhook(staleBody, { "linear-signature": staleSignature, "linear-timestamp": String(now - 61_000), "linear-delivery": "delivery-2" }, async () => {}), /stale/);
});

test("GitHub requires a valid signature and delivery id", async () => {
  const secret = "github-test-secret";
  const body = new TextEncoder().encode(JSON.stringify({ action: "created", issue: { number: 42 }, comment: { id: 101, body: "Synthetic reply", user: { id: 201 }, privateField: "not projected" }, repository: { full_name: "owner/repo" }, privateField: "not projected" }));
  const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  const tracker = new GitHubIssuesTracker({ endpoint: "https://api.github.com", token: "test-token", ...trackerSecrets(secret), owner: "owner", repository: "repo", workspace: { kind: "user", login: "owner" }, deliveries: new InMemoryWebhookDeliveryLedger() }, unusedTransport);
  let parsed: TrackerWebhook | undefined;
  await tracker.processWebhook(body, { "x-hub-signature-256": signature, "x-github-delivery": "delivery-1", "x-github-event": "issue_comment" }, async (webhook) => { parsed = webhook; });
  assert.equal(parsed?.workItemId, "owner/repo#42");
  assert.equal(parsed?.commentBody, "Synthetic reply");
  assert.equal(parsed?.providerActorId, "201");
  assert.equal(parsed?.providerCommentId, "101");
  assert.doesNotMatch(JSON.stringify(parsed?.raw), /privateField/);
  await assert.rejects(() => tracker.processWebhook(body, { "x-hub-signature-256": signature, "x-github-delivery": "delivery-1", "x-github-event": "issue_comment" }, async () => {}), /duplicate/);
  await assert.rejects(() => tracker.processWebhook(body, { "x-hub-signature-256": signature }, async () => {}), /delivery id/);
});

test("both tracker adapters release failed webhook applications for retry", async () => {
  const githubSecret = "github-test-secret";
  const githubBody = new TextEncoder().encode(JSON.stringify({ action: "opened", issue: { number: 42 }, repository: { full_name: "owner/repo" } }));
  const githubSignature = `sha256=${createHmac("sha256", githubSecret).update(githubBody).digest("hex")}`;
  const github = new GitHubIssuesTracker({ endpoint: "https://api.github.com", token: "test-token", ...trackerSecrets(githubSecret), owner: "owner", repository: "repo", workspace: { kind: "user", login: "owner" }, deliveries: new InMemoryWebhookDeliveryLedger() }, unusedTransport);
  const githubHeaders = { "x-hub-signature-256": githubSignature, "x-github-delivery": "retry-1", "x-github-event": "issues" };
  await assert.rejects(() => github.processWebhook(githubBody, githubHeaders, async () => { throw new Error("synthetic GitHub apply failure"); }), /apply failure/);
  await assert.doesNotReject(() => github.processWebhook(githubBody, githubHeaders, async () => {}));

  const linearSecret = "linear-test-secret";
  const now = 1_800_000_000_000;
  const linearBody = new TextEncoder().encode(JSON.stringify({ type: "Comment", action: "create", organizationId: "workspace", actor: { id: "actor-1" }, webhookTimestamp: now, data: { id: "comment-1", issueId: "issue-1", body: "Synthetic reply" } }));
  const linearSignature = createHmac("sha256", linearSecret).update(linearBody).digest("hex");
  const linear = new LinearTracker({ endpoint: "https://api.linear.app/graphql", token: "test-token", ...trackerSecrets(linearSecret), teamId: "team", now: () => now, deliveries: new InMemoryWebhookDeliveryLedger(), dispositionStateIds: { accepted: "open", rejected: "canceled", implemented_verified: "done" } }, unusedTransport);
  const linearHeaders = { "linear-signature": linearSignature, "linear-delivery": "retry-1" };
  await assert.rejects(() => linear.processWebhook(linearBody, linearHeaders, async () => { throw new Error("synthetic Linear apply failure"); }), /apply failure/);
  await assert.doesNotReject(() => linear.processWebhook(linearBody, linearHeaders, async () => {}));
});

test("both tracker adapters complete outbound comment echoes without applying them", async () => {
  const githubSecret = "shared-test-secret";
  const githubMarkedComment = trackerCommentBody("Synthetic outbound comment", "message-1", "shared-test-secret:comment", { provider: "github", workItemId: "owner/repo#42" });
  const githubBody = new TextEncoder().encode(JSON.stringify({ action: "created", issue: { number: 42 }, comment: { id: 101, body: githubMarkedComment, user: { id: 201 } }, repository: { full_name: "owner/repo" } }));
  const githubSignature = `sha256=${createHmac("sha256", githubSecret).update(githubBody).digest("hex")}`;
  const github = new GitHubIssuesTracker({ endpoint: "https://api.github.com", token: "test-token", ...trackerSecrets(githubSecret), owner: "owner", repository: "repo", workspace: { kind: "user", login: "owner" }, deliveries: new InMemoryWebhookDeliveryLedger() }, unusedTransport);
  let githubApplied = 0;
  const githubHeaders = { "x-hub-signature-256": githubSignature, "x-github-delivery": "echo-1", "x-github-event": "issue_comment" };
  await github.processWebhook(githubBody, githubHeaders, async () => { githubApplied += 1; });
  assert.equal(githubApplied, 0);
  await assert.rejects(() => github.processWebhook(githubBody, githubHeaders, async () => { githubApplied += 1; }), /duplicate/);

  const forgedGithubBody = new TextEncoder().encode(JSON.stringify({ action: "created", issue: { number: 42 }, comment: { id: 102, body: githubMarkedComment.replace("Synthetic outbound", "Forged inbound"), user: { id: 201 } }, repository: { full_name: "owner/repo" } }));
  const forgedGithubSignature = `sha256=${createHmac("sha256", githubSecret).update(forgedGithubBody).digest("hex")}`;
  await github.processWebhook(forgedGithubBody, { ...githubHeaders, "x-hub-signature-256": forgedGithubSignature, "x-github-delivery": "echo-forged-1" }, async () => { githubApplied += 1; });
  assert.equal(githubApplied, 1);

  const copiedGithubBody = new TextEncoder().encode(JSON.stringify({ action: "created", issue: { number: 43 }, comment: { id: 103, body: githubMarkedComment, user: { id: 201 } }, repository: { full_name: "owner/repo" } }));
  const copiedGithubSignature = `sha256=${createHmac("sha256", githubSecret).update(copiedGithubBody).digest("hex")}`;
  await github.processWebhook(copiedGithubBody, { ...githubHeaders, "x-hub-signature-256": copiedGithubSignature, "x-github-delivery": "echo-copied-1" }, async () => { githubApplied += 1; });
  assert.equal(githubApplied, 2);

  const linearSecret = "shared-test-secret";
  const now = 1_800_000_000_000;
  const linearMarkedComment = trackerCommentBody("Synthetic outbound comment", "message-1", "shared-test-secret:comment", { provider: "linear", workItemId: "issue-1" });
  const linearBody = new TextEncoder().encode(JSON.stringify({ type: "Comment", action: "create", organizationId: "workspace", actor: { id: "actor-1" }, webhookTimestamp: now, data: { id: "comment-1", issueId: "issue-1", body: linearMarkedComment } }));
  const linearSignature = createHmac("sha256", linearSecret).update(linearBody).digest("hex");
  const linear = new LinearTracker({ endpoint: "https://api.linear.app/graphql", token: "test-token", ...trackerSecrets(linearSecret), teamId: "team", now: () => now, deliveries: new InMemoryWebhookDeliveryLedger(), dispositionStateIds: { accepted: "open", rejected: "canceled", implemented_verified: "done" } }, unusedTransport);
  let linearApplied = 0;
  const linearHeaders = { "linear-signature": linearSignature, "linear-delivery": "echo-1", "linear-event": "Comment" };
  await linear.processWebhook(linearBody, linearHeaders, async () => { linearApplied += 1; });
  assert.equal(linearApplied, 0);
  await assert.rejects(() => linear.processWebhook(linearBody, linearHeaders, async () => { linearApplied += 1; }), /duplicate/);
});

test("GitHub webhooks are repository-bound and reject malformed supported payloads", async () => {
  const secret = "github-test-secret";
  const tracker = new GitHubIssuesTracker({ endpoint: "https://api.github.com", token: "test-token", ...trackerSecrets(secret), owner: "owner", repository: "repo", workspace: { kind: "user", login: "owner" }, deliveries: new InMemoryWebhookDeliveryLedger() }, unusedTransport);
  const headersFor = (body: Uint8Array, delivery: string) => ({
    "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
    "x-github-delivery": delivery,
    "x-github-event": "issue_comment",
  });
  const crossRepository = new TextEncoder().encode(JSON.stringify({ action: "created", issue: { number: 42 }, comment: { body: "Synthetic reply" }, repository: { full_name: "owner/other" } }));
  await assert.rejects(() => tracker.processWebhook(crossRepository, headersFor(crossRepository, "cross-repo"), async () => {}), /does not match/);

  const malformed = new TextEncoder().encode(JSON.stringify({ action: "created", issue: { number: "42" }, comment: { body: 7 }, repository: { full_name: "owner/repo" } }));
  await assert.rejects(() => tracker.processWebhook(malformed, headersFor(malformed, "malformed"), async () => {}), /issue number/);

  const pullRequestComment = new TextEncoder().encode(JSON.stringify({ action: "created", issue: { number: 42, pull_request: { url: "https://api.github.com/repos/owner/repo/pulls/42" } }, comment: { body: "Synthetic PR reply" }, repository: { full_name: "owner/repo" } }));
  await assert.rejects(() => tracker.processWebhook(pullRequestComment, headersFor(pullRequestComment, "pull-request-comment"), async () => {}), /pull request comments/);

  const editedComment = new TextEncoder().encode(JSON.stringify({ action: "edited", issue: { number: 42 }, comment: { body: "Synthetic edited reply" }, repository: { full_name: "owner/repo" } }));
  await assert.rejects(() => tracker.processWebhook(editedComment, headersFor(editedComment, "edited-comment"), async () => {}), /unsupported GitHub issue comment action/);

  const missingCommenter = new TextEncoder().encode(JSON.stringify({ action: "created", issue: { number: 42 }, comment: { id: 101, body: "Unattributed reply", user: null }, repository: { full_name: "owner/repo" } }));
  await assert.rejects(() => tracker.processWebhook(missingCommenter, headersFor(missingCommenter, "missing-commenter"), async () => {}), /comment user/);
});

test("Linear rejects event mismatches and malformed comment payloads", async () => {
  const secret = "linear-test-secret";
  const now = 1_800_000_000_000;
  const tracker = new LinearTracker({ endpoint: "https://api.linear.app/graphql", token: "test-token", ...trackerSecrets(secret), teamId: "team", now: () => now, deliveries: new InMemoryWebhookDeliveryLedger(), dispositionStateIds: { accepted: "open", rejected: "canceled", implemented_verified: "done" } }, unusedTransport);
  const body = new TextEncoder().encode(JSON.stringify({ type: "Comment", action: "create", organizationId: "workspace", actor: { id: "actor-1" }, webhookTimestamp: now, data: { id: "comment-1", issueId: "issue-1", body: 7 } }));
  const headers = { "linear-signature": createHmac("sha256", secret).update(body).digest("hex"), "linear-delivery": "malformed-linear", "linear-event": "Issue" };
  await assert.rejects(() => tracker.processWebhook(body, headers, async () => {}), /does not match/);
  await assert.rejects(
    () => tracker.processWebhook(body, { ...headers, "linear-delivery": "malformed-comment", "linear-event": "Comment" }, async () => {}),
    /comment body/,
  );

  const updated = new TextEncoder().encode(JSON.stringify({ type: "Comment", action: "update", organizationId: "workspace", actor: { id: "actor-1" }, webhookTimestamp: now, data: { id: "comment-1", issueId: "issue-1", body: "Edited reply" } }));
  await assert.rejects(
    () => tracker.processWebhook(updated, { "linear-signature": createHmac("sha256", secret).update(updated).digest("hex"), "linear-delivery": "updated-comment", "linear-event": "Comment" }, async () => {}),
    /unsupported Linear comment action/,
  );

  const missingActor = new TextEncoder().encode(JSON.stringify({ type: "Comment", action: "create", organizationId: "workspace", actor: null, webhookTimestamp: now, data: { id: "comment-2", issueId: "issue-1", body: "Unattributed reply" } }));
  await assert.rejects(
    () => tracker.processWebhook(missingActor, { "linear-signature": createHmac("sha256", secret).update(missingActor).digest("hex"), "linear-delivery": "missing-actor", "linear-event": "Comment" }, async () => {}),
    /Linear actor/,
  );
});

test("rejected dispositions record their reason before changing provider state", async () => {
  const githubCalls: string[] = [];
  const githubTransport: JsonTransport = {
    async request<T>(input: { method: "GET" | "POST" | "PATCH"; url: string; headers: Record<string, string>; body?: unknown }): Promise<T> {
      if (input.method === "GET") return [] as T;
      githubCalls.push(input.method);
      if (input.method === "POST") throw new Error("synthetic comment failure");
      return {} as T;
    },
  };
  const github = new GitHubIssuesTracker({ endpoint: "https://api.github.com", token: "test-token", ...trackerSecrets("test-secret"), owner: "owner", repository: "repo", workspace: { kind: "user", login: "owner" }, deliveries: new InMemoryWebhookDeliveryLedger() }, githubTransport);
  await assert.rejects(() => github.applyDisposition("owner/repo#42", "rejected", "transition-1", "Synthetic reason"), /comment failure/);
  assert.deepEqual(githubCalls, ["POST"]);

  const linearCalls: string[] = [];
  const linearTransport: JsonTransport = {
    async request<T>(input: { method: "GET" | "POST" | "PATCH"; url: string; headers: Record<string, string>; body?: unknown }): Promise<T> {
      const query = (input.body as { query: string }).query;
      if (query.includes("comments(")) return { data: { issue: { comments: { nodes: [], pageInfo: { hasNextPage: false } } } } } as T;
      linearCalls.push(query.includes("commentCreate") ? "comment" : "state");
      if (query.includes("commentCreate")) throw new Error("synthetic comment failure");
      return { data: { issueUpdate: { success: true } } } as T;
    },
  };
  const linear = new LinearTracker({ endpoint: "https://api.linear.app/graphql", token: "test-token", ...trackerSecrets("test-secret"), teamId: "team", now: () => Date.parse("2026-08-30T00:00:00Z"), deliveries: new InMemoryWebhookDeliveryLedger(), dispositionStateIds: { accepted: "open", rejected: "canceled", implemented_verified: "done" } }, linearTransport);
  await assert.rejects(() => linear.applyDisposition("issue-1", "rejected", "transition-1", "Synthetic reason"), /comment failure/);
  assert.deepEqual(linearCalls, ["comment"]);
});

test("disposition comment idempotency is scoped to each Work Item transition", async () => {
  const githubComments = new Map<string, string[]>();
  const githubTransport: JsonTransport = {
    async request<T>(input: { method: "GET" | "POST" | "PATCH"; url: string; headers: Record<string, string>; body?: unknown }): Promise<T> {
      const issueNumber = /\/issues\/([1-9][0-9]*)/.exec(new URL(input.url).pathname)?.[1] ?? "unknown";
      if (input.method === "GET") return (githubComments.get(issueNumber) ?? []).map((body) => ({ body })) as T;
      if (input.method === "POST") githubComments.set(issueNumber, [...(githubComments.get(issueNumber) ?? []), (input.body as { body: string }).body]);
      return {} as T;
    },
  };
  const github = new GitHubIssuesTracker({ endpoint: "https://api.github.com", token: "test-token", ...trackerSecrets("disposition-github-webhook"), owner: "owner", repository: "repo", workspace: { kind: "user", login: "owner" }, deliveries: new InMemoryWebhookDeliveryLedger() }, githubTransport);
  await github.applyDisposition("owner/repo#41", "rejected", "github-41-rejected-1", "Not actionable");
  await github.applyDisposition("owner/repo#42", "rejected", "github-42-rejected-1", "Not actionable");
  await github.applyDisposition("owner/repo#41", "accepted", "github-41-accepted-1", "Reconsidered");
  await github.applyDisposition("owner/repo#42", "implemented_verified", "github-42-implemented-1", "Verified");
  await github.applyDisposition("OWNER/REPO#41", "rejected", "github-41-rejected-1", "Not actionable");
  await github.applyDisposition("owner/repo#41", "rejected", "github-41-rejected-2", "No longer actionable");
  await github.applyDisposition("owner/repo#41", "rejected", "github-41-rejected-3", "Not actionable");
  assert.equal([...githubComments.values()].flat().length, 6);

  const linearComments = new Map<string, string[]>();
  const linearTransport: JsonTransport = {
    async request<T>(input: { method: "GET" | "POST" | "PATCH"; url: string; headers: Record<string, string>; body?: unknown }): Promise<T> {
      const operation = input.body as { query: string; variables: { id?: string; input?: { issueId?: string; body?: string } } };
      if (operation.query.includes("comments(")) {
        const comments = linearComments.get(operation.variables.id ?? "") ?? [];
        return { data: { issue: { comments: { nodes: comments.map((body) => ({ body })), pageInfo: { hasNextPage: false } } } } } as T;
      }
      if (operation.query.includes("commentCreate")) {
        const issueId = operation.variables.input?.issueId ?? "";
        linearComments.set(issueId, [...(linearComments.get(issueId) ?? []), operation.variables.input?.body ?? ""]);
        return { data: { commentCreate: { success: true } } } as T;
      }
      return { data: { issueUpdate: { success: true } } } as T;
    },
  };
  const linear = new LinearTracker({ endpoint: "https://api.linear.app/graphql", token: "test-token", ...trackerSecrets("disposition-linear-webhook"), teamId: "team", now: () => Date.parse("2026-08-30T00:00:00Z"), deliveries: new InMemoryWebhookDeliveryLedger(), dispositionStateIds: { accepted: "open", rejected: "canceled", implemented_verified: "done" } }, linearTransport);
  await linear.applyDisposition("issue-41", "rejected", "linear-41-rejected-1", "Not actionable");
  await linear.applyDisposition("issue-42", "rejected", "linear-42-rejected-1", "Not actionable");
  await linear.applyDisposition("issue-41", "accepted", "linear-41-accepted-1", "Reconsidered");
  await linear.applyDisposition("issue-42", "implemented_verified", "linear-42-implemented-1", "Verified");
  await linear.applyDisposition("issue-41", "rejected", "linear-41-rejected-1", "Not actionable");
  await linear.applyDisposition("issue-41", "rejected", "linear-41-rejected-2", "No longer actionable");
  await linear.applyDisposition("issue-41", "rejected", "linear-41-rejected-3", "Not actionable");
  assert.equal([...linearComments.values()].flat().length, 6);
});

test("tracker comments use opaque sync markers", async () => {
  let githubBody: unknown;
  const githubTransport: JsonTransport = {
    async request<T>(input: { method: "GET" | "POST" | "PATCH"; url: string; headers: Record<string, string>; body?: unknown }): Promise<T> {
      if (input.method === "GET") return [] as T;
      githubBody = input.body;
      return {} as T;
    },
  };
  const github = new GitHubIssuesTracker({ endpoint: "https://api.github.com", token: "test-token", ...trackerSecrets("test-secret"), owner: "owner", repository: "repo", workspace: { kind: "user", login: "owner" }, deliveries: new InMemoryWebhookDeliveryLedger() }, githubTransport);
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
  const github = new GitHubIssuesTracker({ endpoint: "https://api.github.com", token: "test-token", ...trackerSecrets("test-secret"), owner: "owner", repository: "repo", workspace: { kind: "user", login: "owner" }, deliveries: new InMemoryWebhookDeliveryLedger() }, githubTransport);
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
  const linear = new LinearTracker({ endpoint: "https://api.linear.app/graphql", token: "test-token", ...trackerSecrets("test-secret"), teamId: "team", now: () => Date.parse("2026-08-30T00:00:00Z"), deliveries: new InMemoryWebhookDeliveryLedger(), dispositionStateIds: { accepted: "open", rejected: "canceled", implemented_verified: "done" } }, linearTransport);
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
  const github = new GitHubIssuesTracker({ endpoint: "https://api.github.com", token: "test-token", ...trackerSecrets("test-secret"), owner: "owner", repository: "repo", workspace: { kind: "user", login: "owner" }, deliveries: new InMemoryWebhookDeliveryLedger() }, githubTransport);
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
  const linear = new LinearTracker({ endpoint: "https://api.linear.app/graphql", token: "test-token", ...trackerSecrets("test-secret"), teamId: "team", now: () => Date.parse("2026-08-30T00:00:00Z"), deliveries: new InMemoryWebhookDeliveryLedger(), dispositionStateIds: { accepted: "open", rejected: "canceled", implemented_verified: "done" } }, linearTransport);
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
  const githubRefusal = new GitHubIssuesTracker({ endpoint: "https://api.github.com", token: "test-token", ...trackerSecrets("test-secret"), owner: "owner", repository: "repo", workspace: { kind: "user", login: "owner" }, deliveries: new InMemoryWebhookDeliveryLedger() }, githubRefusalTransport);
  await assert.rejects(() => githubRefusal.createItem(githubContainer, draft), /422/);
  assert.equal((await githubRefusal.createItem(githubContainer, draft)).id, "owner/repo#42");
  assert.equal(githubRefusalCalls, 2);

  let githubUncertainCalls = 0;
  const githubUncertain = new GitHubIssuesTracker({ endpoint: "https://api.github.com", token: "test-token", ...trackerSecrets("test-secret"), owner: "owner", repository: "repo", workspace: { kind: "user", login: "owner" }, deliveries: new InMemoryWebhookDeliveryLedger() }, {
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
  const linearConfig = { endpoint: "https://api.linear.app/graphql", token: "test-token", ...trackerSecrets("test-secret"), teamId: "team", now: () => Date.parse("2026-08-30T00:00:00Z"), deliveries: new InMemoryWebhookDeliveryLedger(), dispositionStateIds: { accepted: "open", rejected: "canceled", implemented_verified: "done" } } as const;
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

test("both tracker adapters reconcile a remotely created comment after response loss", async () => {
  const githubComments: string[] = [];
  let githubCreates = 0;
  const githubTransport: JsonTransport = {
    async request<T>(input: { method: "GET" | "POST" | "PATCH"; url: string; headers: Record<string, string>; body?: unknown }): Promise<T> {
      if (input.method === "GET") return githubComments.map((body) => ({ body })) as T;
      githubCreates += 1;
      githubComments.push((input.body as { body: string }).body);
      throw new Error("synthetic GitHub response loss");
    },
  };
  const githubConfig = { endpoint: "https://api.github.com", token: "test-token", ...trackerSecrets("comment-github-webhook"), owner: "owner", repository: "repo", workspace: { kind: "user", login: "owner" } as const, deliveries: new InMemoryWebhookDeliveryLedger() };
  const github = new GitHubIssuesTracker(githubConfig, githubTransport);
  await assert.rejects(() => github.addComment("owner/repo#42", "Synthetic feedback", "comment-1"), /response loss/);
  await assert.doesNotReject(() => github.addComment("owner/repo#42", "Synthetic feedback", "comment-1"));
  await assert.doesNotReject(() => new GitHubIssuesTracker(githubConfig, githubTransport).addComment("owner/repo#42", "Synthetic feedback", "comment-1"));
  assert.equal(githubCreates, 1);

  const linearComments: string[] = [];
  let linearCreates = 0;
  const linearTransport: JsonTransport = {
    async request<T>(input: { method: "GET" | "POST" | "PATCH"; url: string; headers: Record<string, string>; body?: unknown }): Promise<T> {
      const operation = input.body as { query: string; variables: { input?: { body?: string } } };
      if (operation.query.includes("comments(")) return { data: { issue: { comments: { nodes: linearComments.map((body) => ({ body })), pageInfo: { hasNextPage: false } } } } } as T;
      linearCreates += 1;
      linearComments.push(operation.variables.input?.body ?? "");
      throw new Error("synthetic Linear response loss");
    },
  };
  const linearConfig = { endpoint: "https://api.linear.app/graphql", token: "test-token", ...trackerSecrets("comment-linear-webhook"), teamId: "team", now: () => Date.parse("2026-08-30T00:00:00Z"), deliveries: new InMemoryWebhookDeliveryLedger(), dispositionStateIds: { accepted: "open", rejected: "canceled", implemented_verified: "done" } } as const;
  const linear = new LinearTracker(linearConfig, linearTransport);
  await assert.rejects(() => linear.addComment("issue-1", "Synthetic feedback", "comment-1"), /response loss/);
  await assert.doesNotReject(() => linear.addComment("issue-1", "Synthetic feedback", "comment-1"));
  await assert.doesNotReject(() => new LinearTracker(linearConfig, linearTransport).addComment("issue-1", "Synthetic feedback", "comment-1"));
  assert.equal(linearCreates, 1);
});

test("Linear mutation payload failures stop disposition processing", async () => {
  const commentCalls: string[] = [];
  const rejectedTransport: JsonTransport = {
    async request<T>(input: { method: "GET" | "POST" | "PATCH"; url: string; headers: Record<string, string>; body?: unknown }): Promise<T> {
      const query = (input.body as { query: string }).query;
      if (query.includes("comments(")) return { data: { issue: { comments: { nodes: [], pageInfo: { hasNextPage: false } } } } } as T;
      commentCalls.push(query.includes("commentCreate") ? "comment" : "state");
      return { data: query.includes("commentCreate") ? { commentCreate: { success: false } } : { issueUpdate: { success: true } } } as T;
    },
  };
  const config = { endpoint: "https://api.linear.app/graphql", token: "test-token", ...trackerSecrets("test-secret"), teamId: "team", now: () => Date.parse("2026-08-30T00:00:00Z"), deliveries: new InMemoryWebhookDeliveryLedger(), dispositionStateIds: { accepted: "open", rejected: "canceled", implemented_verified: "done" } } as const;
  await assert.rejects(() => new LinearTracker(config, rejectedTransport).applyDisposition("issue-1", "rejected", "transition-1", "Synthetic reason"), /comment creation was not accepted/);
  assert.deepEqual(commentCalls, ["comment"]);

  const stateCalls: string[] = [];
  const acceptedTransport: JsonTransport = {
    async request<T>(input: { method: "GET" | "POST" | "PATCH"; url: string; headers: Record<string, string>; body?: unknown }): Promise<T> {
      const query = (input.body as { query: string }).query;
      stateCalls.push(query.includes("issueUpdate") ? "state" : "comment");
      return { data: query.includes("issueUpdate") ? { issueUpdate: { success: false } } : { commentCreate: { success: true } } } as T;
    },
  };
  await assert.rejects(() => new LinearTracker(config, acceptedTransport).applyDisposition("issue-1", "accepted", "transition-1"), /disposition update was not accepted/);
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
  const tracker = new GitHubIssuesTracker({ endpoint: "https://api.github.com", token: "test-token", ...trackerSecrets("test-secret"), owner: "owner", repository: "repo", workspace: { kind: "user", login: "owner" }, deliveries: new InMemoryWebhookDeliveryLedger() }, transport);
  const context: SearchContext = {
    container: { provider: "github", id: "owner/repo", workspaceId: "owner", name: "repo" },
    repository: "owner/repo",
    product: 'prototype" org:private',
    route: '/demo" repo:private/private',
    anchorFingerprint: 'anchor" is:pr',
    labels: [],
    now: "2026-08-30T00:00:00Z",
  };

  await tracker.candidates(context);

  assert.equal(
    new URL(requestedUrl).searchParams.get("q"),
    'repo:owner/repo is:issue in:body ("/demo repo:private/private" OR "anchor is:pr" OR "prototype org:private")',
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
  const tracker = new GitHubIssuesTracker({ endpoint: "https://api.github.com", token: "test-token", ...trackerSecrets("test-secret"), owner: "owner", repository: "repo", workspace: { kind: "user", login: "owner" }, deliveries: new InMemoryWebhookDeliveryLedger(), closedLookbackDays: 30 }, transport);
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
  assert.equal(exact[0]?.product, "prototype");
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
  const tracker = new GitHubIssuesTracker({ endpoint: "https://api.github.com", token: "test-token", ...trackerSecrets("test-secret"), owner: "owner", repository: "repo", workspace: { kind: "user", login: "owner" }, deliveries: new InMemoryWebhookDeliveryLedger() }, transport);
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
  const tracker = new LinearTracker({ endpoint: "https://api.linear.app/graphql", token: "test-token", ...trackerSecrets("test-secret"), teamId: "team", now: () => Date.parse("2026-08-30T00:00:00Z"), deliveries: new InMemoryWebhookDeliveryLedger(), closedLookbackDays: 30, dispositionStateIds: { accepted: "open", rejected: "canceled", implemented_verified: "done" } }, transport);
  const context: SearchContext = {
    exactLinkedId: "exact",
    container: { provider: "linear", id: "project-1", workspaceId: "workspace", name: "Review" },
    route: "/demo",
    anchorFingerprint: "anchor-1",
    labels: [],
    now: "2026-08-30T00:00:00Z",
  };

  assert.deepEqual((await tracker.candidates(context, "exact_link")).map(({ id }) => id), ["exact"]);
  assert.equal((await tracker.candidates(context, "exact_link"))[0]?.product, "prototype");
  assert.deepEqual((await tracker.candidates(context, "current_container")).map(({ id }) => id), ["current"]);
  assert.deepEqual((await tracker.candidates(context, "open_workspace")).map(({ id }) => id), ["current", "workspace"]);
  assert.deepEqual((await tracker.candidates(context, "recent_closed")).map(({ id }) => id), ["recent-closed"]);
});

test("Linear container lookup verifies workspace and rejects team ambiguity", async () => {
  const calls: Array<{ query: string; variables: Record<string, unknown> }> = [];
  const transport: JsonTransport = {
    async request<T>(input: { method: "GET" | "POST" | "PATCH"; url: string; headers: Record<string, string>; body?: unknown }): Promise<T> {
      const operation = input.body as { query: string; variables: Record<string, unknown> };
      calls.push(operation);
      return { data: { organization: { id: "workspace" }, projects: { nodes: [{ id: "project-1", name: "Review" }, { id: "project-2", name: "Review" }] } } } as T;
    },
  };
  const tracker = new LinearTracker({ endpoint: "https://api.linear.app/graphql", token: "test-token", ...trackerSecrets("test-secret"), teamId: "team", now: () => Date.parse("2026-08-30T00:00:00Z"), deliveries: new InMemoryWebhookDeliveryLedger(), dispositionStateIds: { accepted: "open", rejected: "canceled", implemented_verified: "done" } }, transport);

  await assert.rejects(() => tracker.findOrCreateContainer({ workspaceId: "other-workspace", name: "Review" }), /configured workspace/);
  assert.equal(calls.length, 0);
  await assert.rejects(() => tracker.findOrCreateContainer({ workspaceId: "workspace", name: "Review" }), /ambiguous/);
  assert.match(calls[0]?.query ?? "", /accessibleTeams/);
  assert.deepEqual(calls[0]?.variables, { name: "Review", teamId: "team" });

  const wrongCredential = new LinearTracker({ endpoint: "https://api.linear.app/graphql", token: "test-token", ...trackerSecrets("other-test-secret"), teamId: "team", now: () => Date.parse("2026-08-30T00:00:00Z"), deliveries: new InMemoryWebhookDeliveryLedger(), dispositionStateIds: { accepted: "open", rejected: "canceled", implemented_verified: "done" } }, {
    async request<T>(): Promise<T> { return { data: { organization: { id: "different-workspace" }, projects: { nodes: [] } } } as T; },
  });
  await assert.rejects(() => wrongCredential.findOrCreateContainer({ workspaceId: "workspace", name: "Review" }), /credential is scoped/);
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
  const github = new GitHubIssuesTracker({ endpoint: "https://api.github.com", token: "test-token", ...trackerSecrets("test-secret"), owner: "owner", repository: "repo", workspace: { kind: "user", login: "owner" }, deliveries: new InMemoryWebhookDeliveryLedger() }, githubTransport);
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
  const linear = new LinearTracker({ endpoint: "https://api.linear.app/graphql", token: "test-token", ...trackerSecrets("test-secret"), teamId: "team", now: () => Date.parse("2026-08-30T00:00:00Z"), deliveries: new InMemoryWebhookDeliveryLedger(), dispositionStateIds: { accepted: "open", rejected: "canceled", implemented_verified: "done" } }, linearTransport);
  const linearContext: SearchContext = { container: { provider: "linear", id: "project-1", workspaceId: "workspace", name: "Review" }, route: "/demo", anchorFingerprint: "anchor-1", labels: ["bug"], now: "2026-08-30T00:00:00Z" };
  const linearCandidates = await linear.candidates(linearContext);
  assert.equal(linearCandidates.length, 2);
  assert.equal(chooseWorkItem(linearCandidates, linearContext).kind, "create");
});

test("GitHub search fails a premature short page closed", async () => {
  let requests = 0;
  const tracker = new GitHubIssuesTracker({ endpoint: "https://api.github.com", token: "test-token", ...trackerSecrets("test-secret"), owner: "owner", repository: "repo", workspace: { kind: "user", login: "owner" }, deliveries: new InMemoryWebhookDeliveryLedger() }, {
    async request<T>(): Promise<T> {
      requests += 1;
      return {
        total_count: 2,
        incomplete_results: false,
        items: [{
          number: 1,
          html_url: "https://github.com/owner/repo/issues/1",
          repository_url: "https://api.github.com/repos/owner/repo",
          title: "Incomplete synthetic result",
          body: githubStableBody("owner/repo", 1),
          state: "open",
          labels: [],
          updated_at: "2026-08-29T00:00:00Z",
        }],
      } as T;
    },
  });
  const context: SearchContext = { container: { provider: "github", id: "owner/repo", workspaceId: "owner", name: "repo" }, repository: "owner/repo", route: "/demo", anchorFingerprint: "anchor-1", labels: [], now: "2026-08-30T00:00:00Z" };

  assert.deepEqual(await tracker.candidates(context), []);
  assert.equal(requests, 1);
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
  const tracker = new LinearTracker({ endpoint: "https://api.linear.app/graphql", token: "test-token", ...trackerSecrets("test-secret"), teamId: "team", now: () => Date.parse("2026-08-30T00:00:00Z"), deliveries: new InMemoryWebhookDeliveryLedger(), dispositionStateIds: { accepted: "open", rejected: "canceled", implemented_verified: "done" } }, transport);
  const context: SearchContext = { container: { provider: "linear", id: "project-1", workspaceId: "workspace", name: "Review" }, route: "/demo", anchorFingerprint: "anchor-1", labels: [], now: "2026-08-30T00:00:00Z" };

  assert.deepEqual(await tracker.candidates(context), []);
  assert.equal(requests, 20);
});

test("GitHub configuration rejects a repository outside the search workspace", () => {
  assert.throws(
    () => new GitHubIssuesTracker({ endpoint: "https://api.github.com", token: "test-token", ...trackerSecrets("test-secret"), owner: "repository-owner", repository: "repo", workspace: { kind: "org", login: "different-workspace" }, deliveries: new InMemoryWebhookDeliveryLedger() }, unusedTransport),
    /owner must match/,
  );
});

test("both tracker adapters require distinct webhook, context, and comment secrets", () => {
  const shared = { webhookSecret: "shared-secret", contextSigningSecret: "shared-secret", commentSigningSecret: "shared-secret" };
  assert.throws(
    () => new GitHubIssuesTracker({ endpoint: "https://api.github.com", token: "test-token", ...shared, owner: "owner", repository: "repo", workspace: { kind: "user", login: "owner" }, deliveries: new InMemoryWebhookDeliveryLedger() }, unusedTransport),
    /must be distinct/,
  );
  assert.throws(
    () => new LinearTracker({ endpoint: "https://api.linear.app/graphql", token: "test-token", ...shared, workspaceId: "workspace", teamId: "team", now: () => Date.parse("2026-08-30T00:00:00Z"), deliveries: new InMemoryWebhookDeliveryLedger(), dispositionStateIds: { accepted: "open", rejected: "canceled", implemented_verified: "done" } }, unusedTransport),
    /must be distinct/,
  );
});
