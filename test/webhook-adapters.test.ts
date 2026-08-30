import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { GitHubIssuesTracker } from "../src/adapters/github.ts";
import type { JsonTransport } from "../src/adapters/http.ts";
import { LinearTracker } from "../src/adapters/linear.ts";
import { stableIssueBody, type SearchContext, type TrackerWebhook } from "../src/tracker.ts";
import { InMemoryWebhookDeliveryLedger } from "../src/webhook.ts";

const unusedTransport: JsonTransport = { async request<T>(): Promise<T> { throw new Error("not used"); } };
const stableBody = stableIssueBody({ reviewId: "review", prototypeId: "prototype", revisionId: "revision", viewportId: "mobile", variantId: "control", route: "/demo", anchorFingerprint: "anchor-1", reviewUrl: "https://review.example.test/review" });

test("Linear verifies raw signature, official timestamp, and delivery id", async () => {
  const secret = "linear-test-secret";
  const now = 1_800_000_000_000;
  const body = new TextEncoder().encode(JSON.stringify({ type: "Comment", webhookTimestamp: now, data: { id: "issue-1", body: "Synthetic reply" } }));
  const signature = createHmac("sha256", secret).update(body).digest("hex");
  const tracker = new LinearTracker({ endpoint: "https://api.linear.app/graphql", token: "test-token", webhookSecret: secret, teamId: "team", now: () => now, deliveries: new InMemoryWebhookDeliveryLedger(), dispositionStateIds: { accepted: "open", rejected: "canceled", implemented_verified: "done" } }, unusedTransport);
  let parsed: TrackerWebhook | undefined;
  await tracker.processWebhook(body, { "linear-signature": signature, "linear-timestamp": String(now), "linear-delivery": "delivery-1", "linear-event": "Comment" }, async (webhook) => { parsed = webhook; });
  assert.equal(parsed?.deliveryId, "delivery-1");
  assert.equal(parsed?.event, "Comment");
  await assert.rejects(() => tracker.processWebhook(body, { "linear-signature": signature, "linear-timestamp": String(now), "linear-delivery": "delivery-1", "linear-event": "Comment" }, async () => {}), /duplicate/);
  const staleBody = new TextEncoder().encode(JSON.stringify({ type: "Comment", webhookTimestamp: now - 61_000, data: { id: "issue-1" } }));
  const staleSignature = createHmac("sha256", secret).update(staleBody).digest("hex");
  await assert.rejects(() => tracker.processWebhook(staleBody, { "linear-signature": staleSignature, "linear-timestamp": String(now - 61_000), "linear-delivery": "delivery-2" }, async () => {}), /stale/);
});

test("GitHub requires a valid signature and delivery id", async () => {
  const secret = "github-test-secret";
  const body = new TextEncoder().encode(JSON.stringify({ issue: { number: 42 }, comment: { body: "Synthetic reply" } }));
  const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  const tracker = new GitHubIssuesTracker({ endpoint: "https://api.github.com", token: "test-token", webhookSecret: secret, owner: "owner", repository: "repo", workspace: { kind: "user", login: "owner" }, deliveries: new InMemoryWebhookDeliveryLedger() }, unusedTransport);
  let parsed: TrackerWebhook | undefined;
  await tracker.processWebhook(body, { "x-hub-signature-256": signature, "x-github-delivery": "delivery-1", "x-github-event": "issue_comment" }, async (webhook) => { parsed = webhook; });
  assert.equal(parsed?.workItemId, "owner/repo#42");
  await assert.rejects(() => tracker.processWebhook(body, { "x-hub-signature-256": signature, "x-github-delivery": "delivery-1", "x-github-event": "issue_comment" }, async () => {}), /duplicate/);
  await assert.rejects(() => tracker.processWebhook(body, { "x-hub-signature-256": signature }, async () => {}), /delivery id/);
});

test("both tracker adapters release failed webhook applications for retry", async () => {
  const githubSecret = "github-test-secret";
  const githubBody = new TextEncoder().encode(JSON.stringify({ issue: { number: 42 } }));
  const githubSignature = `sha256=${createHmac("sha256", githubSecret).update(githubBody).digest("hex")}`;
  const github = new GitHubIssuesTracker({ endpoint: "https://api.github.com", token: "test-token", webhookSecret: githubSecret, owner: "owner", repository: "repo", workspace: { kind: "user", login: "owner" }, deliveries: new InMemoryWebhookDeliveryLedger() }, unusedTransport);
  const githubHeaders = { "x-hub-signature-256": githubSignature, "x-github-delivery": "retry-1" };
  await assert.rejects(() => github.processWebhook(githubBody, githubHeaders, async () => { throw new Error("synthetic GitHub apply failure"); }), /apply failure/);
  await assert.doesNotReject(() => github.processWebhook(githubBody, githubHeaders, async () => {}));

  const linearSecret = "linear-test-secret";
  const now = 1_800_000_000_000;
  const linearBody = new TextEncoder().encode(JSON.stringify({ type: "Comment", webhookTimestamp: now, data: { id: "issue-1" } }));
  const linearSignature = createHmac("sha256", linearSecret).update(linearBody).digest("hex");
  const linear = new LinearTracker({ endpoint: "https://api.linear.app/graphql", token: "test-token", webhookSecret: linearSecret, teamId: "team", now: () => now, deliveries: new InMemoryWebhookDeliveryLedger(), dispositionStateIds: { accepted: "open", rejected: "canceled", implemented_verified: "done" } }, unusedTransport);
  const linearHeaders = { "linear-signature": linearSignature, "linear-delivery": "retry-1" };
  await assert.rejects(() => linear.processWebhook(linearBody, linearHeaders, async () => { throw new Error("synthetic Linear apply failure"); }), /apply failure/);
  await assert.doesNotReject(() => linear.processWebhook(linearBody, linearHeaders, async () => {}));
});

test("GitHub issue search treats review context as phrases, not qualifiers", async () => {
  let requestedUrl = "";
  const transport: JsonTransport = {
    async request<T>(input: { method: "GET" | "POST" | "PATCH"; url: string; headers: Record<string, string>; body?: unknown }): Promise<T> {
      requestedUrl = input.url;
      return { items: [] } as T;
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
          body: stableBody,
          state: "open",
          labels: [],
          updated_at: "2026-08-30T00:00:00Z",
        } as T;
      }
      if ((new URL(input.url).searchParams.get("q") ?? "").includes("is:open")) {
        return {
          items: [{
            number: 7,
            html_url: "https://github.com/owner/other/issues/7",
            repository_url: "https://api.github.com/repos/owner/other",
            title: "Workspace candidate",
            body: stableBody,
            state: "open",
            labels: [],
            updated_at: "2026-08-29T00:00:00Z",
          }],
        } as T;
      }
      return { items: [] } as T;
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

test("Linear adapter honors exact, current-project, workspace-open, and recent-closed tiers", async () => {
  const issue = (id: string, projectId: string, state: string, updatedAt: string) => ({
    id,
    url: `https://linear.example.test/issue/${id}`,
    title: `Synthetic ${id}`,
    description: stableBody,
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
