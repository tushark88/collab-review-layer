import { requireDisposition, type Disposition, type ReviewContext } from "./domain.ts";
import { chooseWorkItem, normalizeStableIssueContext, requireIdempotencyKey, sameWorkItemIdentity, type MatchDecision, type SearchContext, type SearchTier, type WorkContainer, type WorkItem, type WorkTracker } from "./tracker.ts";

export interface ThreadProjectionInput {
  context: ReviewContext;
  anchorFingerprint: string;
  captureDigest?: string;
  reviewUrl: string;
  firstMessage: string;
  title: string;
  labels: string[];
  idempotencyKey: string;
}

export interface ProjectionResult {
  container: WorkContainer;
  item: WorkItem;
  action: "reused" | "created";
  possibleDuplicate?: WorkItem;
  searched: SearchTier[];
}

/**
 * Owns provider-neutral projection policy. Adapters only translate provider I/O.
 * Search is deliberately sequential so an exact link cannot be displaced by a
 * fuzzy workspace result and every broader query can be skipped when safe.
 */
export class TrackerOrchestrator {
  readonly tracker: WorkTracker;
  constructor(tracker: WorkTracker) { this.tracker = tracker; }

  async projectThread(input: ThreadProjectionInput, search: Omit<SearchContext, "container" | "product"> & { containerName: string; workspaceId: string }): Promise<ProjectionResult> {
    const itemIdempotencyKey = `${input.idempotencyKey}:item`;
    const firstMessageIdempotencyKey = `${input.idempotencyKey}:first-message`;
    requireIdempotencyKey(input.idempotencyKey);
    requireIdempotencyKey(itemIdempotencyKey);
    requireIdempotencyKey(firstMessageIdempotencyKey);
    const stableContext = normalizeStableIssueContext({ ...input.context, anchorFingerprint: input.anchorFingerprint, captureDigest: input.captureDigest, reviewUrl: input.reviewUrl });
    const container = await this.tracker.findOrCreateContainer({ workspaceId: search.workspaceId, name: search.containerName });
    const context: SearchContext = { ...search, container, product: stableContext.prototypeId, route: stableContext.route, anchorFingerprint: stableContext.anchorFingerprint };
    const searched: SearchTier[] = [];
    const candidates: WorkItem[] = [];
    let broadSearchComplete = true;

    for (const tier of ["exact_link", "current_container", "open_workspace", "recent_closed"] as const) {
      if (tier === "exact_link" && !context.exactLinkedId) continue;
      searched.push(tier);
      const found = await this.tracker.candidates(context, tier);
      if (tier === "exact_link") {
        if (!found.complete) throw new Error("exact-link search was incomplete");
        if (found.items.length > 1) throw new Error("exact-link search returned multiple items");
        const exact = found.items[0];
        if (exact) {
          await this.tracker.addComment(exact.id, input.firstMessage, firstMessageIdempotencyKey);
          return { container, item: exact, action: "reused", searched };
        }
      } else if (!found.complete) {
        broadSearchComplete = false;
      }
      candidates.push(...found.items.filter((item) => !candidates.some((known) => sameWorkItemIdentity(known, item))));
    }

    const matched = chooseWorkItem(candidates, context);
    const decision: MatchDecision = broadSearchComplete
      ? matched
      : { kind: "create", possibleDuplicate: matched.kind === "reuse" ? matched.item : matched.possibleDuplicate, reason: "one or more candidate tiers were incomplete" };
    if (decision.kind === "reuse") {
      await this.tracker.addComment(decision.item.id, input.firstMessage, firstMessageIdempotencyKey);
      return { container, item: decision.item, action: "reused", searched };
    }

    const draft = {
      title: input.title,
      context: stableContext,
      possibleDuplicateUrl: decision.possibleDuplicate?.url,
      labels: input.labels,
      idempotencyKey: itemIdempotencyKey,
    };
    const item = await this.tracker.createItem(container, draft);
    await this.tracker.addComment(item.id, input.firstMessage, firstMessageIdempotencyKey);
    const result: ProjectionResult = { container, item, action: "created", searched };
    if (decision.possibleDuplicate) result.possibleDuplicate = decision.possibleDuplicate;
    return result;
  }

  async applyDisposition(itemId: string, disposition: Disposition, transitionId: string, reason?: string): Promise<void> {
    const validatedDisposition = requireDisposition(disposition);
    if (validatedDisposition === "rejected" && !reason?.trim()) throw new Error("rejection requires a recorded reason");
    await this.tracker.applyDisposition(itemId, validatedDisposition, transitionId, reason);
  }
}
