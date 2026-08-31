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
  assertAllowed(request: ReviewAuthorizationRequest): undefined;
}

export interface ReviewGrant {
  actorId: string;
  reviewId: string;
  threadId?: string;
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
      requireGrantId(grant.actorId, "actor");
      requireGrantId(grant.reviewId, "review");
      if (grant.threadId !== undefined) requireGrantId(grant.threadId, "thread");
      const key = grantKey(grant.actorId, grant.reviewId, grant.threadId);
      if (this.#grants.has(key)) throw new Error("duplicate authorization grant");
      this.#grants.set(key, new Set(grant.actions));
    }
  }

  assertAllowed(request: ReviewAuthorizationRequest): undefined {
    if (!isGrantId(request.actorId) || !isGrantId(request.reviewId) || (request.threadId !== undefined && !isGrantId(request.threadId))) {
      throw new Error("not authorized");
    }
    const reviewActions = this.#grants.get(grantKey(request.actorId, request.reviewId));
    const threadActions = request.threadId === undefined ? undefined : this.#grants.get(grantKey(request.actorId, request.reviewId, request.threadId));
    if (!reviewActions?.has(request.action) && !threadActions?.has(request.action)) throw new Error("not authorized");
    return undefined;
  }
}

export class DenyAllReviewAuthorizer implements ReviewAuthorizer {
  assertAllowed(): never {
    throw new Error("not authorized");
  }
}

export function assertReviewAllowed(authorizer: ReviewAuthorizer, request: ReviewAuthorizationRequest): void {
  const result: unknown = authorizer.assertAllowed(request);
  if (result === undefined) return;
  if (isPromiseLike(result)) void Promise.resolve(result).catch(() => undefined);
  throw new Error("review authorizer must be synchronous");
}

function grantKey(actorId: string, reviewId: string, threadId = ""): string {
  return `${actorId}\u0000${reviewId}\u0000${threadId}`;
}

function requireGrantId(value: string, label: string): void {
  if (!isGrantId(value)) throw new Error(`authorization grants require valid ${label} ids`);
}

function isGrantId(value: string): boolean {
  return Boolean(value.trim()) && !value.includes("\u0000");
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return Boolean(value) && (typeof value === "object" || typeof value === "function") && typeof (value as { then?: unknown }).then === "function";
}
