import type { Disposition, ReviewContext } from "./domain.ts";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export type TrackerProvider = "linear" | "github" | "plane";

export interface WorkContainer { provider: TrackerProvider; id: string; workspaceId: string; name: string; }
export interface WorkItem {
  provider: TrackerProvider; id: string; url: string; title: string; body: string;
  state: "open" | "closed"; containerId?: string; repository?: string;
  product?: string; route?: string; anchorFingerprint?: string; labels: string[]; updatedAt: string;
}
export type StableIssueContextInput = ReviewContext & { anchorFingerprint: string; captureDigest?: string; reviewUrl: string };
export interface WorkItemDraft { title: string; context: StableIssueContextInput; possibleDuplicateUrl?: string; labels: string[]; idempotencyKey: string; }
export interface SearchContext {
  exactLinkedId?: string; container: WorkContainer; repository?: string; product?: string;
  route: string; anchorFingerprint: string; labels: string[]; now: string;
}
export interface TrackerWebhook {
  deliveryId: string;
  event: string;
  workItemId?: string;
  commentBody?: string;
  providerActorId?: string;
  providerCommentId?: string;
  raw: unknown;
}
export type SearchTier = "exact_link" | "current_container" | "open_workspace" | "recent_closed";

export interface WorkTracker {
  readonly provider: TrackerProvider;
  findOrCreateContainer(input: { workspaceId: string; name: string }): Promise<WorkContainer>;
  candidates(context: SearchContext, tier?: SearchTier): Promise<readonly WorkItem[]>;
  createItem(container: WorkContainer, draft: WorkItemDraft): Promise<WorkItem>;
  addComment(itemId: string, body: string, idempotencyKey: string): Promise<void>;
  applyDisposition(itemId: string, disposition: Disposition, transitionId: string, reason?: string): Promise<void>;
  processWebhook(body: Uint8Array, headers: Readonly<Record<string, string>>, apply: (webhook: TrackerWebhook) => Promise<void>): Promise<void>;
}

export type MatchDecision = { kind: "reuse"; item: WorkItem; score: number; reason: string } |
  { kind: "create"; possibleDuplicate?: WorkItem; reason: string };

interface CreationRecord<TCreated, TResult> {
  fingerprint: string;
  lastUsed: number;
  createAttempted: boolean;
  createdReady: boolean;
  created?: TCreated;
  resultReady: boolean;
  result?: TResult;
  inFlight?: Promise<TResult>;
}

/** A provider response that definitively confirms its mutation was rejected. */
export class ProviderMutationRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderMutationRejectedError";
  }
}

export type MutationReconciliation<TResult> = { found: true; result: TResult } | { found: false };

/**
 * Process-local reference coordinator for multi-step or externally
 * reconcilable provider mutations. It coalesces concurrent retries, resumes a
 * finishing step after partial failure, and treats unknown provider outcomes as
 * requiring reconciliation instead of risking a duplicate.
 * Capacity pressure evicts the least-recently-used safe record, never an
 * in-flight, partially attached, or unknown-outcome record.
 */
export class InMemoryProviderMutationRecovery<TCreated, TResult> {
  readonly #records = new Map<string, CreationRecord<TCreated, TResult>>();
  readonly #maxRecords: number;
  #clock = 0;

  constructor(maxRecords = 10_000) {
    if (!Number.isSafeInteger(maxRecords) || maxRecords < 1) throw new Error("provider mutation recovery capacity must be positive");
    this.#maxRecords = maxRecords;
  }

  async run(
    idempotencyKey: string,
    fingerprint: string,
    create: () => Promise<TCreated>,
    finish: (created: TCreated) => Promise<TResult>,
    reconcile?: () => Promise<MutationReconciliation<TResult>>,
  ): Promise<TResult> {
    requireIdempotencyKey(idempotencyKey);
    let record = this.#records.get(idempotencyKey);
    if (record && record.fingerprint !== fingerprint) throw new Error("idempotency key was reused for a different provider mutation");
    if (!record) {
      this.#makeSpace();
      record = { fingerprint, lastUsed: 0, createAttempted: false, createdReady: false, resultReady: false };
      this.#records.set(idempotencyKey, record);
    }
    this.#touch(record);
    if (record.resultReady) return structuredClone(record.result as TResult);
    if (record.inFlight) return structuredClone(await record.inFlight);

    const execute = async (): Promise<TResult> => {
      if (!record!.createdReady) {
        if (reconcile) {
          const reconciled = await reconcile();
          if (reconciled.found) {
            record!.result = structuredClone(reconciled.result);
            record!.resultReady = true;
            return reconciled.result;
          }
        }
        if (record!.createAttempted) throw new Error("provider creation outcome is unknown; reconcile before retrying");
        record!.createAttempted = true;
        try {
          record!.created = await create();
        } catch (error) {
          if (error instanceof ProviderMutationRejectedError) {
            record!.createAttempted = false;
            this.#touch(record!);
          }
          throw error;
        }
        record!.createdReady = true;
      }
      const result = await finish(record!.created as TCreated);
      record!.result = structuredClone(result);
      record!.resultReady = true;
      return result;
    };
    record.inFlight = execute();
    try {
      return structuredClone(await record.inFlight);
    } finally {
      record.inFlight = undefined;
    }
  }

  #makeSpace(): void {
    if (this.#records.size < this.#maxRecords) return;
    let candidate: { key: string; lastUsed: number } | undefined;
    for (const [key, record] of this.#records) {
      const safeToEvict = !record.inFlight && (record.resultReady || (!record.createAttempted && !record.createdReady));
      if (safeToEvict && (!candidate || record.lastUsed < candidate.lastUsed)) candidate = { key, lastUsed: record.lastUsed };
    }
    if (!candidate) throw new Error("provider mutation recovery capacity exceeded by unresolved records");
    this.#records.delete(candidate.key);
  }

  #touch(record: CreationRecord<TCreated, TResult>): void {
    record.lastUsed = ++this.#clock;
  }
}

export function workItemCommentFingerprint(provider: TrackerProvider, workItemId: string, body: string): string {
  if (!workItemId.trim()) throw new Error("tracker comment Work Item id is required");
  const normalizedId = provider === "github" ? workItemId.toLowerCase() : workItemId;
  return createHash("sha256").update(JSON.stringify([provider, normalizedId, body])).digest("hex");
}

export function dispositionCommentIdempotencyKey(provider: TrackerProvider, workItemId: string, transitionId: string): string {
  if (!workItemId.trim()) throw new Error("tracker disposition Work Item id is required");
  requireIdempotencyKey(transitionId);
  const normalizedId = provider === "github" ? workItemId.toLowerCase() : workItemId;
  const itemDigest = createHash("sha256").update(provider).update("\u0000").update(normalizedId).digest("hex");
  const transitionDigest = createHash("sha256").update(transitionId).digest("hex");
  return `disposition:${itemDigest}:${transitionDigest}`;
}

export function trackerCommentBody(body: string, idempotencyKey: string, secret: string, binding: { provider: TrackerProvider; workItemId: string }): string {
  requireIdempotencyKey(idempotencyKey);
  if (!secret) throw new Error("tracker comment signing secret is required");
  const digest = createHash("sha256").update(idempotencyKey).digest("hex");
  const signature = createHmac("sha256", secret).update(trackerCommentSignatureInput(body, digest, binding)).digest("hex");
  return `${body}\n\n<!-- collab-review-sync:v1:${digest}:${signature} -->`;
}

export function isTrackerCommentEcho(body: string | undefined, secret: string, binding: { provider: TrackerProvider; workItemId: string }): boolean {
  if (typeof body !== "string" || !secret) return false;
  const match = /^([\s\S]*)\r?\n\r?\n<!-- collab-review-sync:v1:([a-f0-9]{64}):([a-f0-9]{64}) -->\s*$/.exec(body);
  if (!match) return false;
  const expected = createHmac("sha256", secret).update(trackerCommentSignatureInput(match[1]!, match[2]!, binding)).digest();
  const actual = Buffer.from(match[3]!, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function workItemDraftFingerprint(container: WorkContainer, draft: WorkItemDraft): string {
  requireIdempotencyKey(draft.idempotencyKey);
  const values = [
    container.provider,
    container.id,
    container.workspaceId,
    draft.title,
    draft.context.reviewId,
    draft.context.prototypeId,
    draft.context.revisionId,
    draft.context.viewportId,
    draft.context.variantId,
    draft.context.route,
    draft.context.anchorFingerprint,
    draft.context.captureDigest ?? "",
    draft.context.reviewUrl,
    draft.possibleDuplicateUrl ?? "",
    ...draft.labels,
  ];
  return createHash("sha256").update(JSON.stringify(values)).digest("hex");
}

export function chooseWorkItem(items: readonly WorkItem[], context: SearchContext): MatchDecision {
  const exact = context.exactLinkedId && items.find((item) => sameProviderIdentity(item.provider, item.id, context.exactLinkedId));
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
  if (sameProviderIdentity(item.provider, item.containerId, context.container.id)) result += 35;
  if (sameProviderIdentity(item.provider, item.repository, context.repository)) result += 15;
  if (context.product && item.product === context.product) result += 20;
  if (item.route === context.route) result += 15;
  if (item.anchorFingerprint === context.anchorFingerprint) result += 30;
  result += Math.min(15, item.labels.filter((label) => context.labels.includes(label)).length * 5);
  if (item.state === "open") result += 5;
  const ageDays = (Date.parse(context.now) - Date.parse(item.updatedAt)) / 86_400_000;
  if (ageDays <= 14) result += 5;
  return result;
}

export function sameWorkItemIdentity(left: Pick<WorkItem, "provider" | "id">, right: Pick<WorkItem, "provider" | "id">): boolean {
  return left.provider === right.provider && sameProviderIdentity(left.provider, left.id, right.id);
}

function sameProviderIdentity(provider: TrackerProvider, left: string | undefined, right: string | undefined): boolean {
  if (left === undefined || right === undefined) return false;
  return provider === "github" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

export function stableIssueBody(context: StableIssueContextInput, binding: { provider: TrackerProvider; workItemId: string }, secret: string): string {
  if (!secret) throw new Error("tracker context signing secret is required");
  const block = [
    "<!-- collaborative-review-context:v2 -->",
    `Review: ${normalizeStableIssueValue(context.reviewId)}`,
    `Prototype: ${normalizeStableIssueValue(context.prototypeId)}`,
    `Revision: ${normalizeStableIssueValue(context.revisionId)}`,
    `Viewport: ${normalizeStableIssueValue(context.viewportId)}`,
    `Variant: ${normalizeStableIssueValue(context.variantId)}`,
    `Route: ${normalizeStableIssueValue(context.route)}`,
    `Anchor: ${normalizeStableIssueValue(context.anchorFingerprint)}`,
    `Capture: ${normalizeStableIssueValue(context.captureDigest ?? "none")}`,
    `Review URL: ${normalizeStableIssueValue(context.reviewUrl)}`,
  ].join("\n");
  const signature = createHmac("sha256", secret).update(contextSignatureInput(block, binding)).digest("hex");
  return `${block}\nContext signature: hmac-sha256:${signature}`;
}

export interface StableIssueContext {
  product?: string;
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
  return { product: fields.get("Prototype"), route: fields.get("Route"), anchorFingerprint: fields.get("Anchor") };
}

function contextSignatureInput(block: string, binding: { provider: TrackerProvider; workItemId: string }): string {
  if (!binding.workItemId.trim()) throw new Error("tracker context Work Item id is required");
  const workItemId = binding.provider === "github" ? binding.workItemId.toLowerCase() : binding.workItemId;
  return `${binding.provider}\u0000${workItemId}\u0000${block}`;
}

function trackerCommentSignatureInput(body: string, idempotencyDigest: string, binding: { provider: TrackerProvider; workItemId: string }): string {
  if (!binding.workItemId.trim()) throw new Error("tracker comment Work Item id is required");
  const workItemId = binding.provider === "github" ? binding.workItemId.toLowerCase() : binding.workItemId;
  return `${binding.provider}\u0000${workItemId}\u0000${idempotencyDigest}\u0000${body}`;
}

export function requireDistinctTrackerSecrets(provider: string, webhook: string, context: string, comment: string): void {
  if (![webhook, context, comment].every((secret) => secret.trim())) throw new Error(`${provider} webhook, context, and comment secrets are required`);
  if (new Set([webhook, context, comment]).size !== 3) throw new Error(`${provider} webhook, context, and comment secrets must be distinct`);
}

export function normalizeStableIssueValue(value: string): string {
  const normalized = value.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  if (!normalized) throw new Error("stable tracker context values are required");
  return normalized;
}

function requireIdempotencyKey(value: string): void {
  if (!value.trim() || Buffer.byteLength(value) > 512) throw new Error("valid tracker idempotency key is required");
}
