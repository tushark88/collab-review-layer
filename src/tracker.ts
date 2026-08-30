import type { Disposition, ReviewContext } from "./domain.ts";

export type TrackerProvider = "linear" | "github" | "plane";

export interface WorkContainer { provider: TrackerProvider; id: string; workspaceId: string; name: string; }
export interface WorkItem {
  provider: TrackerProvider; id: string; url: string; title: string; body: string;
  state: "open" | "closed"; containerId?: string; repository?: string;
  route?: string; anchorFingerprint?: string; labels: string[]; updatedAt: string;
}
export interface WorkItemDraft { title: string; body: string; labels: string[]; idempotencyKey: string; }
export interface SearchContext {
  exactLinkedId?: string; container: WorkContainer; repository?: string; product?: string;
  route: string; anchorFingerprint: string; labels: string[]; now: string;
}
export interface TrackerWebhook { deliveryId: string; event: string; workItemId?: string; commentBody?: string; raw: unknown; }
export type SearchTier = "exact_link" | "current_container" | "open_workspace" | "recent_closed";

export interface WorkTracker {
  readonly provider: TrackerProvider;
  findOrCreateContainer(input: { workspaceId: string; name: string }): Promise<WorkContainer>;
  candidates(context: SearchContext, tier?: SearchTier): Promise<readonly WorkItem[]>;
  createItem(container: WorkContainer, draft: WorkItemDraft): Promise<WorkItem>;
  addComment(itemId: string, body: string, idempotencyKey: string): Promise<void>;
  applyDisposition(itemId: string, disposition: Disposition, reason?: string): Promise<void>;
  parseAndVerifyWebhook(body: Uint8Array, headers: Readonly<Record<string, string>>): Promise<TrackerWebhook>;
}

export type MatchDecision = { kind: "reuse"; item: WorkItem; score: number; reason: string } |
  { kind: "create"; possibleDuplicate?: WorkItem; reason: string };

export function chooseWorkItem(items: readonly WorkItem[], context: SearchContext): MatchDecision {
  const exact = context.exactLinkedId && items.find((item) => item.id === context.exactLinkedId);
  if (exact) return { kind: "reuse", item: exact, score: 1000, reason: "exact previously linked item" };
  const ranked = items.map((item) => ({ item, score: score(item, context) })).sort((a, b) => b.score - a.score);
  const first = ranked[0];
  if (!first) return { kind: "create", reason: "no candidates" };
  const second = ranked[1];
  const deterministic = first.score >= 85 && (!second || first.score - second.score >= 20);
  if (deterministic) return { kind: "reuse", item: first.item, score: first.score, reason: "deterministic high-confidence match" };
  return { kind: "create", possibleDuplicate: first.score >= 45 ? first.item : undefined, reason: "ambiguous candidates; duplicate is safer than wrong attachment" };
}

function score(item: WorkItem, context: SearchContext): number {
  let result = 0;
  if (item.containerId === context.container.id) result += 35;
  if (context.repository && item.repository === context.repository) result += 15;
  if (item.route === context.route) result += 15;
  if (item.anchorFingerprint === context.anchorFingerprint) result += 30;
  result += Math.min(15, item.labels.filter((label) => context.labels.includes(label)).length * 5);
  if (item.state === "open") result += 5;
  const ageDays = (Date.parse(context.now) - Date.parse(item.updatedAt)) / 86_400_000;
  if (ageDays <= 14) result += 5;
  return result;
}

export function stableIssueBody(context: ReviewContext & { anchorFingerprint: string; captureDigest?: string; reviewUrl: string }): string {
  return [
    "<!-- collaborative-review-context:v1 -->",
    `Review: ${context.reviewId}`,
    `Prototype: ${context.prototypeId}`,
    `Revision: ${context.revisionId}`,
    `Viewport: ${context.viewportId}`,
    `Variant: ${context.variantId}`,
    `Route: ${context.route}`,
    `Anchor: ${context.anchorFingerprint}`,
    `Capture: ${context.captureDigest ?? "none"}`,
    `Review URL: ${context.reviewUrl}`,
  ].join("\n");
}
