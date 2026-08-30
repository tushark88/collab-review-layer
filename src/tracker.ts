import type { Disposition, ReviewContext } from "./domain.ts";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export type TrackerProvider = "linear" | "github" | "plane";

export interface WorkContainer { provider: TrackerProvider; id: string; workspaceId: string; name: string; }
export interface WorkItem {
  provider: TrackerProvider; id: string; url: string; title: string; body: string;
  state: "open" | "closed"; containerId?: string; repository?: string;
  route?: string; anchorFingerprint?: string; labels: string[]; updatedAt: string;
}
export type StableIssueContextInput = ReviewContext & { anchorFingerprint: string; captureDigest?: string; reviewUrl: string };
export interface WorkItemDraft { title: string; context: StableIssueContextInput; possibleDuplicateUrl?: string; labels: string[]; idempotencyKey: string; }
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
  processWebhook(body: Uint8Array, headers: Readonly<Record<string, string>>, apply: (webhook: TrackerWebhook) => Promise<void>): Promise<void>;
}

export type MatchDecision = { kind: "reuse"; item: WorkItem; score: number; reason: string } |
  { kind: "create"; possibleDuplicate?: WorkItem; reason: string };

export function trackerCommentBody(body: string, idempotencyKey: string): string {
  if (!idempotencyKey.trim()) throw new Error("tracker comment idempotency key is required");
  const digest = createHash("sha256").update(idempotencyKey).digest("hex");
  return `${body}\n\n<!-- collab-review-sync:${digest} -->`;
}

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

export function stableIssueBody(context: StableIssueContextInput, binding: { provider: TrackerProvider; workItemId: string }, secret: string): string {
  if (!secret) throw new Error("tracker context signing secret is required");
  const block = [
    "<!-- collaborative-review-context:v2 -->",
    `Review: ${stableValue(context.reviewId)}`,
    `Prototype: ${stableValue(context.prototypeId)}`,
    `Revision: ${stableValue(context.revisionId)}`,
    `Viewport: ${stableValue(context.viewportId)}`,
    `Variant: ${stableValue(context.variantId)}`,
    `Route: ${stableValue(context.route)}`,
    `Anchor: ${stableValue(context.anchorFingerprint)}`,
    `Capture: ${stableValue(context.captureDigest ?? "none")}`,
    `Review URL: ${stableValue(context.reviewUrl)}`,
  ].join("\n");
  const signature = createHmac("sha256", secret).update(contextSignatureInput(block, binding)).digest("hex");
  return `${block}\nContext signature: hmac-sha256:${signature}`;
}

export interface StableIssueContext {
  route?: string;
  anchorFingerprint?: string;
}

export function parseStableIssueContext(body: string, binding: { provider: TrackerProvider; workItemId: string }, secret: string): StableIssueContext {
  if (!secret) return {};
  const marker = "<!-- collaborative-review-context:v2 -->";
  const lines = body.split(/\r?\n/);
  const markerIndexes = lines.flatMap((line, index) => line === marker ? [index] : []);
  if (markerIndexes.length !== 1) return {};
  const markerIndex = markerIndexes[0]!;
  const expectedFields = ["Review", "Prototype", "Revision", "Viewport", "Variant", "Route", "Anchor", "Capture", "Review URL"] as const;
  const fields = new Map<string, string>();
  for (const [offset, field] of expectedFields.entries()) {
    const line = lines[markerIndex + offset + 1];
    const prefix = `${field}: `;
    if (!line?.startsWith(prefix)) return {};
    const value = line.slice(prefix.length);
    if (!value) return {};
    fields.set(field, value);
  }
  const signatureLine = lines[markerIndex + expectedFields.length + 1];
  const signatureMatch = /^Context signature: hmac-sha256:([a-f0-9]{64})$/.exec(signatureLine ?? "");
  if (!signatureMatch) return {};
  const block = lines.slice(markerIndex, markerIndex + expectedFields.length + 1).join("\n");
  const expected = createHmac("sha256", secret).update(contextSignatureInput(block, binding)).digest();
  const actual = Buffer.from(signatureMatch[1]!, "hex");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return {};
  return { route: fields.get("Route"), anchorFingerprint: fields.get("Anchor") };
}

function contextSignatureInput(block: string, binding: { provider: TrackerProvider; workItemId: string }): string {
  if (!binding.workItemId.trim()) throw new Error("tracker context Work Item id is required");
  const workItemId = binding.provider === "github" ? binding.workItemId.toLowerCase() : binding.workItemId;
  return `${binding.provider}\u0000${workItemId}\u0000${block}`;
}

function stableValue(value: string): string {
  return value.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
}
