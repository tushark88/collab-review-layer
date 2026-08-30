import type { Disposition, ReviewContext } from "./domain.ts";
import { chooseWorkItem, stableIssueBody, type MatchDecision, type SearchContext, type SearchTier, type WorkContainer, type WorkItem, type WorkTracker } from "./tracker.ts";

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

  async projectThread(input: ThreadProjectionInput, search: Omit<SearchContext, "container"> & { containerName: string; workspaceId: string }): Promise<ProjectionResult> {
    const container = await this.tracker.findOrCreateContainer({ workspaceId: search.workspaceId, name: search.containerName });
    const context: SearchContext = { ...search, container };
    const searched: SearchTier[] = [];
    const candidates: WorkItem[] = [];

    for (const tier of ["exact_link", "current_container", "open_workspace", "recent_closed"] as const) {
      if (tier === "exact_link" && !context.exactLinkedId) continue;
      searched.push(tier);
      const found = await this.tracker.candidates(context, tier);
      candidates.push(...found.filter((item) => !candidates.some((known) => known.provider === item.provider && known.id === item.id)));
      const decision = chooseWorkItem(candidates, context);
      if (decision.kind === "reuse" && (tier === "exact_link" || decision.score >= 105)) {
        await this.tracker.addComment(decision.item.id, input.firstMessage, `${input.idempotencyKey}:first-message`);
        return { container, item: decision.item, action: "reused", searched };
      }
    }

    const decision: MatchDecision = chooseWorkItem(candidates, context);
    if (decision.kind === "reuse") {
      await this.tracker.addComment(decision.item.id, input.firstMessage, `${input.idempotencyKey}:first-message`);
      return { container, item: decision.item, action: "reused", searched };
    }

    const duplicateNote = decision.possibleDuplicate ? `\n\nPossible duplicate: ${decision.possibleDuplicate.url}` : "";
    const body = stableIssueBody({ ...input.context, anchorFingerprint: input.anchorFingerprint, captureDigest: input.captureDigest, reviewUrl: input.reviewUrl }) + duplicateNote;
    const item = await this.tracker.createItem(container, { title: input.title, body, labels: input.labels, idempotencyKey: `${input.idempotencyKey}:item` });
    await this.tracker.addComment(item.id, input.firstMessage, `${input.idempotencyKey}:first-message`);
    const result: ProjectionResult = { container, item, action: "created", searched };
    if (decision.possibleDuplicate) result.possibleDuplicate = decision.possibleDuplicate;
    return result;
  }

  async applyDisposition(itemId: string, disposition: Disposition, reason?: string): Promise<void> {
    if (disposition === "rejected" && !reason?.trim()) throw new Error("rejection requires a recorded reason");
    await this.tracker.applyDisposition(itemId, disposition, reason);
  }
}
