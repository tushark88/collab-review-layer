export type ReviewAction =
  | "create_thread"
  | "reply"
  | "edit_own_message"
  | "delete_own_message"
  | "resolve_thread"
  | "reopen_thread"
  | "read_thread";

export interface ReviewAuthorizationRequest {
  actorId: string;
  reviewId: string;
  action: ReviewAction;
  threadId?: string;
}

export interface ReviewAuthorizer {
  assertAllowed(request: ReviewAuthorizationRequest): void;
}

export interface ReviewGrant {
  actorId: string;
  reviewId: string;
  actions: readonly ReviewAction[];
}

/**
 * Small fail-closed reference adapter for local development and tests. Production
 * consumers should provide an adapter backed by their own identity and policy.
 */
export class StaticReviewAuthorizer implements ReviewAuthorizer {
  readonly #grants = new Map<string, ReadonlySet<ReviewAction>>();

  constructor(grants: readonly ReviewGrant[]) {
    for (const grant of grants) {
      if (!grant.actorId.trim() || !grant.reviewId.trim()) throw new Error("authorization grants require actor and review ids");
      const key = grantKey(grant.actorId, grant.reviewId);
      if (this.#grants.has(key)) throw new Error("duplicate authorization grant");
      this.#grants.set(key, new Set(grant.actions));
    }
  }

  assertAllowed(request: ReviewAuthorizationRequest): void {
    const actions = this.#grants.get(grantKey(request.actorId, request.reviewId));
    if (!actions?.has(request.action)) throw new Error("not authorized");
  }
}

export class DenyAllReviewAuthorizer implements ReviewAuthorizer {
  assertAllowed(): never {
    throw new Error("not authorized");
  }
}

function grantKey(actorId: string, reviewId: string): string {
  return `${actorId}\u0000${reviewId}`;
}
