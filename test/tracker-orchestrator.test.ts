import assert from "node:assert/strict";
import test from "node:test";
import { TrackerOrchestrator } from "../src/tracker-orchestrator.ts";
import type { Disposition } from "../src/domain.ts";
import type { SearchContext, SearchTier, TrackerWebhook, WorkContainer, WorkItem, WorkItemDraft, WorkTracker } from "../src/tracker.ts";

class FakeTracker implements WorkTracker {
  readonly provider = "linear" as const;
  readonly calls: string[] = [];
  readonly byTier = new Map<SearchTier, WorkItem[]>();
  readonly container: WorkContainer = { provider: "linear", id: "project-1", workspaceId: "workspace-1", name: "Review Shell" };
  async findOrCreateContainer(): Promise<WorkContainer> { this.calls.push("container"); return this.container; }
  async candidates(_context: SearchContext, tier: SearchTier = "open_workspace"): Promise<readonly WorkItem[]> { this.calls.push(`search:${tier}`); return this.byTier.get(tier) ?? []; }
  async createItem(_container: WorkContainer, draft: WorkItemDraft): Promise<WorkItem> { this.calls.push("create"); return item({ id: "created", body: draft.body }); }
  async addComment(itemId: string, body: string): Promise<void> { this.calls.push(`comment:${itemId}:${body}`); }
  async applyDisposition(itemId: string, disposition: Disposition): Promise<void> { this.calls.push(`disposition:${itemId}:${disposition}`); }
  async parseAndVerifyWebhook(): Promise<TrackerWebhook> { throw new Error("not used"); }
}

const item = (overrides: Partial<WorkItem>): WorkItem => ({ provider: "linear", id: "candidate", url: "https://tracker.example.test/item", title: "Candidate", body: "", state: "open", containerId: "project-1", repository: "product/repo", route: "/demo", anchorFingerprint: "anchor-1", labels: ["bug"], updatedAt: "2026-08-30T00:00:00Z", ...overrides });
const input = { context: { reviewId: "review", prototypeId: "prototype", revisionId: "revision", viewportId: "mobile", variantId: "control", route: "/demo" }, anchorFingerprint: "anchor-1", captureDigest: "sha256:capture", reviewUrl: "https://review.example.test/review", firstMessage: "The first shell message", title: "Synthetic feedback", labels: ["bug"], idempotencyKey: "thread:1" };
const search = { workspaceId: "workspace-1", containerName: "Review Shell", repository: "product/repo", route: "/demo", anchorFingerprint: "anchor-1", labels: ["bug"], now: "2026-08-30T00:00:00Z" };

test("exact linked item short-circuits broader search and receives first message", async () => {
  const tracker = new FakeTracker();
  tracker.byTier.set("exact_link", [item({ id: "linked" })]);
  const result = await new TrackerOrchestrator(tracker).projectThread(input, { ...search, exactLinkedId: "linked" });
  assert.equal(result.action, "reused");
  assert.deepEqual(result.searched, ["exact_link"]);
  assert.deepEqual(tracker.calls, ["container", "search:exact_link", "comment:linked:The first shell message"]);
});

test("ambiguous workspace candidates create a new item with possible duplicate relation", async () => {
  const tracker = new FakeTracker();
  tracker.byTier.set("current_container", [item({ id: "a" }), item({ id: "b" })]);
  const result = await new TrackerOrchestrator(tracker).projectThread(input, search);
  assert.equal(result.action, "created");
  assert.equal(result.possibleDuplicate?.id, "a");
  assert.match(result.item.body, /Possible duplicate/);
  assert.deepEqual(result.searched, ["current_container", "open_workspace", "recent_closed"]);
  assert.match(tracker.calls.at(-1) ?? "", /^comment:created:The first shell message$/);
});

test("rejected disposition fails closed without a reason", async () => {
  const tracker = new FakeTracker();
  const orchestrator = new TrackerOrchestrator(tracker);
  await assert.rejects(() => orchestrator.applyDisposition("item", "rejected"), /recorded reason/);
  assert.equal(tracker.calls.length, 0);
});
