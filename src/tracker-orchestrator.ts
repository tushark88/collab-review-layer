import type { Disposition, ReviewContext } from "./domain.ts";
import { chooseWorkItem, normalizeStableIssueValue, sameWorkItemIdentity, type MatchDecision, type SearchContext, type SearchTier, type WorkContainer, type WorkItem, type WorkTracker } from "./tracker.ts";

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
    const container = await this.tracker.findOrCreateContainer({ workspaceId: search.workspaceId, name: search.containerName });
    const context: SearchContext = { ...search, container, product: normalizeStableIssueValue(input.context.prototypeId) };
    const searched: SearchTier[] = [];
    const candidates: WorkItem[] = [];

    for (const tier of ["exact_link", "current_container", "open_workspace", "recent_closed"] as const) {
      if (tier === "exact_link" && !context.exactLinkedId) continue;
      searched.push(tier);
      const found = await this.tracker.candidates(context, tier);
      if (tier === "exact_link") {
        if (found.length > 1) throw new Error("exact-link search returned multiple items");
        const exact = found[0];
        if (exact) {
          await this.tracker.addComment(exact.id, input.firstMessage, `${input.idempotencyKey}:first-message`);
          return { container, item: exact, action: "reused", searched };
        }
      }
      candidates.push(...found.filter((item) => !candidates.some((known) => sameWorkItemIdentity(known, item))));
    }

    const decision: MatchDecision = chooseWorkItem(candidates, context);
    if (decision.kind === "reuse") {
      await this.tracker.addComment(decision.item.id, input.firstMessage, `${input.idempotencyKey}:first-message`);
      return { container, item: decision.item, action: "reused", searched };
    }

    const draft = {
      title: input.title,
      context: { ...input.context, anchorFingerprint: input.anchorFingerprint, captureDigest: input.captureDigest, reviewUrl: input.reviewUrl },
      possibleDuplicateUrl: decision.possibleDuplicate?.url,
      labels: input.labels,
      idempotencyKey: `${input.idempotencyKey}:item`,
    };
    const item = await this.tracker.createItem(container, draft);
    await this.tracker.addComment(item.id, input.firstMessage, `${input.idempotencyKey}:first-message`);
    const result: ProjectionResult = { container, item, action: "created", searched };
    if (decision.possibleDuplicate) result.possibleDuplicate = decision.possibleDuplicate;
    return result;
  }

  async applyDisposition(itemId: string, disposition: Disposition, transitionId: string, reason?: string): Promise<void> {
    if (disposition === "rejected" && !reason?.trim()) throw new Error("rejection requires a recorded reason");
    await this.tracker.applyDisposition(itemId, disposition, transitionId, reason);
  }
}
