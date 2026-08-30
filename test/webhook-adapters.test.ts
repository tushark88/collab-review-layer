import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { GitHubIssuesTracker } from "../src/adapters/github.ts";
import type { JsonTransport } from "../src/adapters/http.ts";
import { LinearTracker } from "../src/adapters/linear.ts";
import type { SearchContext } from "../src/tracker.ts";

const unusedTransport: JsonTransport = { async request<T>(): Promise<T> { throw new Error("not used"); } };

test("Linear verifies raw signature, official timestamp, and delivery id", async () => {
  const secret = "linear-test-secret";
  const now = 1_800_000_000_000;
  const body = new TextEncoder().encode(JSON.stringify({ type: "Comment", webhookTimestamp: now, data: { id: "issue-1", body: "Synthetic reply" } }));
  const signature = createHmac("sha256", secret).update(body).digest("hex");
  const tracker = new LinearTracker({ endpoint: "https://api.linear.app/graphql", token: "test-token", webhookSecret: secret, teamId: "team", now: () => now, dispositionStateIds: { accepted: "open", rejected: "canceled", implemented_verified: "done" } }, unusedTransport);
  const parsed = await tracker.parseAndVerifyWebhook(body, { "linear-signature": signature, "linear-timestamp": String(now), "linear-delivery": "delivery-1", "linear-event": "Comment" });
  assert.equal(parsed.deliveryId, "delivery-1");
  assert.equal(parsed.event, "Comment");
  const staleBody = new TextEncoder().encode(JSON.stringify({ type: "Comment", webhookTimestamp: now - 61_000, data: { id: "issue-1" } }));
  const staleSignature = createHmac("sha256", secret).update(staleBody).digest("hex");
  await assert.rejects(() => tracker.parseAndVerifyWebhook(staleBody, { "linear-signature": staleSignature, "linear-timestamp": String(now - 61_000), "linear-delivery": "delivery-2" }), /stale/);
});

test("GitHub requires a valid signature and delivery id", async () => {
  const secret = "github-test-secret";
  const body = new TextEncoder().encode(JSON.stringify({ issue: { number: 42 }, comment: { body: "Synthetic reply" } }));
  const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  const tracker = new GitHubIssuesTracker({ endpoint: "https://api.github.com", token: "test-token", webhookSecret: secret, owner: "owner", repository: "repo" }, unusedTransport);
  const parsed = await tracker.parseAndVerifyWebhook(body, { "x-hub-signature-256": signature, "x-github-delivery": "delivery-1", "x-github-event": "issue_comment" });
  assert.equal(parsed.workItemId, "42");
  await assert.rejects(() => tracker.parseAndVerifyWebhook(body, { "x-hub-signature-256": signature }), /delivery id/);
});

test("GitHub issue search treats review context as phrases, not qualifiers", async () => {
  let requestedUrl = "";
  const transport: JsonTransport = {
    async request<T>(input: { method: "GET" | "POST" | "PATCH"; url: string; headers: Record<string, string>; body?: unknown }): Promise<T> {
      requestedUrl = input.url;
      return { items: [] } as T;
    },
  };
  const tracker = new GitHubIssuesTracker({ endpoint: "https://api.github.com", token: "test-token", webhookSecret: "test-secret", owner: "owner", repository: "repo" }, transport);
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
    'repo:owner/repo is:issue in:body "/demo repo:private/private" "anchor is:pr"',
  );
});
