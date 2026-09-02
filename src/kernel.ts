import {
  CURRENT_ANCHOR_SCHEMA_VERSION,
  requireDisposition,
  type Anchor,
  type AnchorContext,
  type Capture,
  type CurrentAnchor,
  type Disposition,
  type DomainEvent,
  type Message,
  type OrphanedAnchor,
  type ReviewContext,
  type Thread,
  type ThreadAnchor,
} from "./domain.ts";
import {
  ANCHOR_ELEMENT_OFFSET_MINIMUM,
  readAnchorCoordinate,
  readAnchorIdentifier,
  readAnchorMetadata,
  readAnchorSelector,
  readAnchorText,
} from "./anchor-constraints.ts";
import { readBridgeRoute } from "./bridge-constraints.ts";
import { assertReviewAllowed, type ReviewAction, type ReviewAuthorizer } from "./auth.ts";
import type { EventStore } from "./events.ts";

export { FileEventStore, InMemoryEventStore } from "./events.ts";
export type { EventStore } from "./events.ts";

export interface KernelDependencies {
  events: EventStore;
  authorizer: ReviewAuthorizer;
  now: () => string;
  id: () => string;
}

export const MAX_MESSAGE_BODY_BYTES = 64 * 1024;
const UTF8 = new TextEncoder();
const RFC3339_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

export type AnchorContractErrorCode = "stale_anchor" | "invalid_anchor";

export class AnchorContractError extends Error {
  readonly code: AnchorContractErrorCode;
  readonly status: 409 | 422;

  constructor(code: AnchorContractErrorCode, status: 409 | 422, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AnchorContractError";
    this.code = code;
    this.status = status;
  }
}

export class ReviewKernel {
  readonly #threads = new Map<string, Thread>();
  #eventCount = 0;
  readonly dependencies: KernelDependencies;
  constructor(dependencies: KernelDependencies) {
    this.dependencies = dependencies;
    this.#refresh();
  }

  createThread(input: { context: ReviewContext; anchor: Anchor; capture?: Capture; actorId: string; body: string }): Thread {
    this.#refresh();
    assertReviewAllowed(this.dependencies.authorizer, { actorId: input.actorId, reviewId: input.context.reviewId, action: "create_thread" });
    requireBody(input.body);
    requireReviewContext(input.context);
    const anchor = requireCurrentAnchor(input.anchor, input.context);
    const now = requireTimestamp(this.dependencies.now(), "thread creation timestamp");
    const message: Message = { id: this.dependencies.id(), authorId: input.actorId, body: input.body, createdAt: now };
    const candidate: Thread = {
      id: requireAnchorIdentifier(this.dependencies.id(), "thread id"),
      context: structuredClone(input.context),
      anchor,
      anchorGeneration: 1,
      messages: [message],
    };
    if (this.#threads.has(candidate.id)) throw new Error("duplicate thread id");
    if (input.capture) candidate.capture = structuredClone(input.capture);
    const thread = hydrateCreatedThread(candidate, { reviewId: input.context.reviewId, actorId: input.actorId, occurredAt: now });
    this.#record(thread.context.reviewId, input.actorId, "thread.created", { thread }, now);
    this.#threads.set(thread.id, thread);
    return structuredClone(thread);
  }

  reply(threadId: string, actorId: string, body: string): Thread {
    requireBody(body);
    this.#refresh();
    const thread = this.#authorizedThread(threadId, actorId, "reply");
    const now = requireTimestamp(this.dependencies.now(), "reply timestamp");
    const message = hydrateMessage({ id: this.dependencies.id(), authorId: actorId, body, createdAt: now }, "reply message");
    if (thread.messages.some((known) => known.id === message.id)) throw new Error("duplicate message id");
    const updated = structuredClone(thread);
    updated.messages.push(message);
    this.#record(thread.context.reviewId, actorId, "message.created", { threadId, message }, now);
    this.#threads.set(threadId, updated);
    return structuredClone(updated);
  }

  editMessage(threadId: string, messageId: string, actorId: string, body: string): Thread {
    requireBody(body);
    this.#refresh();
    const thread = this.#authorizedThread(threadId, actorId, "edit_own_message");
    const updated = structuredClone(thread);
    const message = requireOwnedMessage(updated, messageId, actorId);
    if (message.deletedAt) throw new Error("deleted messages cannot be edited");
    const now = requireTimestamp(this.dependencies.now(), "edit timestamp");
    message.body = body;
    message.editedAt = now;
    this.#record(thread.context.reviewId, actorId, "message.edited", { threadId, messageId, body }, now);
    this.#threads.set(threadId, updated);
    return structuredClone(updated);
  }

  deleteMessage(threadId: string, messageId: string, actorId: string): Thread {
    this.#refresh();
    const thread = this.#authorizedThread(threadId, actorId, "delete_own_message");
    const updated = structuredClone(thread);
    const message = requireOwnedMessage(updated, messageId, actorId);
    const now = requireTimestamp(this.dependencies.now(), "deletion timestamp");
    if (!message.deletedAt) message.deletedAt = now;
    this.#record(thread.context.reviewId, actorId, "message.deleted", { threadId, messageId }, now);
    this.#threads.set(threadId, updated);
    return structuredClone(updated);
  }

  resolve(threadId: string, actorId: string, disposition: Disposition, reason?: string): Thread {
    const validatedDisposition = requireDisposition(disposition);
    const normalizedReason = reason?.trim() || undefined;
    if (normalizedReason) requireBoundedText(normalizedReason, "disposition reason");
    if (validatedDisposition === "rejected" && !normalizedReason) throw new Error("rejection requires a reason");
    this.#refresh();
    const thread = this.#authorizedThread(threadId, actorId, "resolve_thread");
    const updated = structuredClone(thread);
    const now = requireTimestamp(this.dependencies.now(), "resolution timestamp");
    updated.resolvedAt = now;
    updated.disposition = validatedDisposition;
    if (normalizedReason) updated.dispositionReason = normalizedReason;
    else delete updated.dispositionReason;
    const payload = normalizedReason
      ? { threadId, disposition: validatedDisposition, reason: normalizedReason }
      : { threadId, disposition: validatedDisposition };
    this.#record(thread.context.reviewId, actorId, "thread.resolved", payload, now);
    this.#threads.set(threadId, updated);
    return structuredClone(updated);
  }

  reopen(threadId: string, actorId: string): Thread {
    this.#refresh();
    const thread = this.#authorizedThread(threadId, actorId, "reopen_thread");
    const updated = structuredClone(thread);
    delete updated.resolvedAt;
    delete updated.disposition;
    delete updated.dispositionReason;
    const now = requireTimestamp(this.dependencies.now(), "reopen timestamp");
    this.#record(thread.context.reviewId, actorId, "thread.reopened", { threadId }, now);
    this.#threads.set(threadId, updated);
    return structuredClone(updated);
  }

  replaceAnchor(threadId: string, actorId: string, anchor: Anchor): Thread {
    this.#refresh();
    const thread = this.#authorizedThread(threadId, actorId, "replace_anchor");
    if (thread.messages[0]?.authorId !== actorId) throw new Error("only the thread owner may replace its anchor");
    const replacement = requireReplacementAnchor(anchor, thread);
    const now = requireTimestamp(this.dependencies.now(), "anchor replacement timestamp");
    const updated = structuredClone(thread);
    updated.anchor = replacement;
    updated.anchorGeneration = nextAnchorGeneration(thread.anchorGeneration);
    this.#record(
      thread.context.reviewId,
      actorId,
      "anchor.replaced",
      { threadId, anchorGeneration: updated.anchorGeneration, anchor: replacement },
      now,
    );
    this.#threads.set(threadId, updated);
    return structuredClone(updated);
  }

  reportAnchorUnavailable(threadId: string, actorId: string, anchorGeneration: number): Thread {
    this.#refresh();
    const thread = this.#authorizedThread(threadId, actorId, "report_anchor_unavailable");
    const reportedGeneration = requireAnchorGeneration(anchorGeneration, "reported anchor generation");
    if (reportedGeneration !== thread.anchorGeneration) {
      throw new AnchorContractError("stale_anchor", 409, "reported anchor generation is no longer current");
    }
    if (thread.anchor.locationAvailability !== "available") throw new Error("only an available anchor can become orphaned");
    const anchor: OrphanedAnchor = {
      schemaVersion: CURRENT_ANCHOR_SCHEMA_VERSION,
      locationAvailability: "unavailable",
      recoveryState: "orphaned_replacement_required",
      context: structuredClone(thread.anchor.context),
    };
    const now = requireTimestamp(this.dependencies.now(), "anchor orphan report timestamp");
    const updated = structuredClone(thread);
    updated.anchor = anchor;
    this.#record(thread.context.reviewId, actorId, "anchor.orphaned", { threadId, anchorGeneration: reportedGeneration, anchor }, now);
    this.#threads.set(threadId, updated);
    return structuredClone(updated);
  }

  getThread(threadId: string, actorId: string): Thread {
    this.#refresh();
    return structuredClone(this.#authorizedThread(threadId, actorId, "read_thread"));
  }

  #thread(id: string): Thread {
    const thread = this.#threads.get(id);
    if (!thread) throw new Error(`unknown thread: ${id}`);
    return thread;
  }

  #authorizedThread(id: string, actorId: string, action: ReviewAction): Thread {
    const thread = this.#thread(id);
    assertReviewAllowed(this.dependencies.authorizer, { actorId, reviewId: thread.context.reviewId, action, threadId: id });
    return thread;
  }

  #record(reviewId: string, actorId: string, type: string, payload: unknown, occurredAt: string): void {
    const stored = this.dependencies.events.append({ id: this.dependencies.id(), reviewId, type, occurredAt, actorId, payload }, this.#eventCount);
    this.#eventCount = stored.sequence;
  }

  #refresh(): void {
    const events = this.dependencies.events.readAll();
    this.#threads.clear();
    this.#hydrate(events);
    this.#eventCount = events.length;
  }

  #hydrate(events: readonly DomainEvent[]): void {
    const eventIds = new Set<string>();
    for (const [index, event] of events.entries()) {
      if (event.sequence !== index + 1) throw new Error("event sequence conflict during kernel hydration");
      if (eventIds.has(event.id)) throw new Error("duplicate event id during kernel hydration");
      eventIds.add(event.id);
      this.#applyPersistedEvent(event);
    }
  }

  #applyPersistedEvent(event: DomainEvent): void {
    if (event.type !== "thread.created" && !KNOWN_THREAD_EVENT_TYPES.has(event.type)) return;
    const occurredAt = requireTimestamp(event.occurredAt, `${event.type} occurrence timestamp in event history`);
    if (event.type === "thread.created") {
      const payload = requireRecord(event.payload, "thread creation payload");
      const thread = hydrateCreatedThread(payload.thread, event);
      if (this.#threads.has(thread.id)) throw new Error("duplicate thread id in event history");
      this.#threads.set(thread.id, thread);
      return;
    }
    const payload = requireRecord(event.payload, `${event.type} payload`);
    const threadId = requireHydratedString(payload.threadId, "thread id");
    const thread = this.#threads.get(threadId);
    if (!thread) throw new Error(`unknown thread in event history: ${threadId}`);
    if (thread.context.reviewId !== event.reviewId) throw new Error("event review does not match hydrated thread");
    const updated = structuredClone(thread);

    if (event.type === "message.created") {
      const message = hydrateMessage(payload.message, "created message");
      if (message.authorId !== event.actorId) throw new Error("created message actor does not match event actor");
      if (message.createdAt !== occurredAt) throw new Error("created message timestamp does not match its event");
      if (message.editedAt || message.deletedAt) throw new Error("created message contains lifecycle timestamps");
      if (updated.messages.some((known) => known.id === message.id)) throw new Error("duplicate message id in event history");
      updated.messages.push(message);
    } else if (event.type === "message.edited") {
      const message = hydratedOwnedMessage(updated, payload, event.actorId);
      if (message.deletedAt) throw new Error("deleted message was edited in event history");
      message.body = requireHydratedString(payload.body, "edited message body");
      requirePersistedBody(message.body);
      message.editedAt = occurredAt;
    } else if (event.type === "message.deleted") {
      const message = hydratedOwnedMessage(updated, payload, event.actorId);
      if (!message.deletedAt) message.deletedAt = occurredAt;
    } else if (event.type === "thread.resolved") {
      const disposition = requireDisposition(payload.disposition);
      const reason = payload.reason === undefined ? undefined : requireHydratedString(payload.reason, "disposition reason");
      if (disposition === "rejected" && !reason?.trim()) throw new Error("rejected event is missing its reason");
      updated.resolvedAt = occurredAt;
      updated.disposition = disposition;
      if (reason?.trim()) updated.dispositionReason = reason.trim();
      else delete updated.dispositionReason;
    } else if (event.type === "thread.reopened") {
      delete updated.resolvedAt;
      delete updated.disposition;
      delete updated.dispositionReason;
    } else if (event.type === "anchor.replaced") {
      if (updated.messages[0]?.authorId !== event.actorId) throw new Error("anchor replacement actor does not own the thread");
      const replacement = hydrateCurrentAnchor(payload.anchor, "replacement anchor", updated.context);
      requireMatchingAnchorContext(replacement.context, updated.context);
      requireRetainedAnchorContext(replacement.context, updated.anchor, "replacement anchor");
      updated.anchor = replacement;
      const expectedGeneration = nextAnchorGeneration(updated.anchorGeneration);
      updated.anchorGeneration = requireMatchingAnchorGeneration(
        payload.anchorGeneration,
        expectedGeneration,
        "replacement anchor generation",
      );
    } else if (event.type === "anchor.orphaned") {
      if (updated.anchor.locationAvailability !== "available") throw new Error("unavailable anchor was orphaned again in event history");
      requireMatchingAnchorGeneration(payload.anchorGeneration, updated.anchorGeneration, "orphaned anchor generation");
      const orphaned = hydrateOrphanedAnchor(payload.anchor, "orphaned anchor", updated.context);
      requireMatchingAnchorContext(orphaned.context, updated.context);
      requireMatchingCompleteAnchorContext(orphaned.context, updated.anchor.context, "orphaned anchor");
      updated.anchor = orphaned;
    }
    this.#threads.set(threadId, updated);
  }
}

const KNOWN_THREAD_EVENT_TYPES = new Set(["message.created", "message.edited", "message.deleted", "thread.resolved", "thread.reopened", "anchor.replaced", "anchor.orphaned"]);

function requireBody(body: string): void {
  requireBoundedText(body, "message body");
}

function requirePersistedBody(body: string): void {
  if (!body.trim()) throw new Error("message body is required");
}

function requireBoundedText(value: string, label: string): void {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);
  if (UTF8.encode(value).byteLength > MAX_MESSAGE_BODY_BYTES) throw new Error(`${label} exceeds size limit`);
}

function requireTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} is invalid`);
  const match = RFC3339_TIMESTAMP.exec(value);
  if (!match || !Number.isFinite(Date.parse(value))) throw new Error(`${label} is invalid`);
  const [, year, month, day] = match;
  const calendar = new Date(0);
  calendar.setUTCHours(0, 0, 0, 0);
  calendar.setUTCFullYear(Number(year), Number(month) - 1, Number(day));
  if (calendar.getUTCFullYear() !== Number(year) || calendar.getUTCMonth() !== Number(month) - 1 || calendar.getUTCDate() !== Number(day)) throw new Error(`${label} is invalid`);
  return value;
}

function requireCurrentAnchor(value: unknown, context: ReviewContext, permitPreBoundReviewContext = false): CurrentAnchor {
  const version = anchorSchemaVersion(value);
  if (version !== CURRENT_ANCHOR_SCHEMA_VERSION) {
    throw new AnchorContractError("stale_anchor", 409, `anchor schema ${String(version)} is not current`);
  }
  try {
    const anchor = hydrateCurrentAnchor(value, "current anchor", permitPreBoundReviewContext ? context : undefined);
    requireMatchingAnchorContext(anchor.context, context);
    return anchor;
  } catch (error) {
    if (error instanceof AnchorContractError) throw error;
    throw new AnchorContractError("invalid_anchor", 422, "current anchor is incomplete or invalid", { cause: error });
  }
}

function requireReplacementAnchor(value: unknown, thread: Thread): CurrentAnchor {
  const replacement = requireCurrentAnchor(value, thread.context, true);
  try {
    requireRetainedAnchorContext(replacement.context, thread.anchor, "replacement anchor");
    return replacement;
  } catch (error) {
    throw new AnchorContractError("invalid_anchor", 422, "current anchor is incomplete or invalid", { cause: error });
  }
}

function requireReviewContext(value: unknown): ReviewContext {
  const record = requireRecord(value, "review context");
  return {
    reviewId: requireHydratedString(record.reviewId, "review id"),
    prototypeId: requireHydratedString(record.prototypeId, "prototype id"),
    revisionId: requireHydratedString(record.revisionId, "revision id"),
    viewportId: requireHydratedString(record.viewportId, "viewport id"),
    variantId: requireHydratedString(record.variantId, "variant id"),
    route: requireHydratedString(record.route, "route"),
  };
}

function requireOwnedMessage(thread: Thread, id: string, actorId: string): Message {
  const message = thread.messages.find((candidate) => candidate.id === id);
  if (!message) throw new Error(`unknown message: ${id}`);
  if (message.authorId !== actorId) throw new Error("only the author may mutate a message");
  return message;
}

function hydrateCreatedThread(value: unknown, event: Pick<DomainEvent, "reviewId" | "actorId" | "occurredAt">): Thread {
  const record = requireRecord(value, "created thread");
  const contextRecord = requireRecord(record.context, "created thread context");
  const context: ReviewContext = {
    reviewId: requireHydratedString(contextRecord.reviewId, "review id"),
    prototypeId: requireHydratedString(contextRecord.prototypeId, "prototype id"),
    revisionId: requireHydratedString(contextRecord.revisionId, "revision id"),
    viewportId: requireHydratedString(contextRecord.viewportId, "viewport id"),
    variantId: requireHydratedString(contextRecord.variantId, "variant id"),
    route: requireHydratedString(contextRecord.route, "route"),
  };
  if (context.reviewId !== event.reviewId) throw new Error("created thread review does not match event review");
  const messages = requireArray(record.messages, "created thread messages").map((message) => hydrateMessage(message, "created thread message"));
  if (messages.length !== 1) throw new Error("created thread must contain exactly one message");
  if (messages[0]!.authorId !== event.actorId) throw new Error("created thread actor does not match event actor");
  if (messages[0]!.createdAt !== event.occurredAt) throw new Error("created thread message timestamp does not match its event");
  if (messages[0]!.editedAt || messages[0]!.deletedAt) throw new Error("created thread message contains lifecycle timestamps");
  if (record.resolvedAt !== undefined || record.disposition !== undefined || record.dispositionReason !== undefined) throw new Error("created thread contains lifecycle state");
  const preGenerationAnchor = record.anchorGeneration === undefined;
  const hydratedAnchor = hydrateAnchor(record.anchor, preGenerationAnchor);
  if ("context" in hydratedAnchor) requireMatchingAnchorContext(hydratedAnchor.context, context);
  const thread: Thread = {
    id: requireHydratedString(record.id, "thread id"),
    context,
    anchor: hydratedAnchor,
    anchorGeneration: record.anchorGeneration === undefined
      ? 1
      : requireMatchingAnchorGeneration(record.anchorGeneration, 1, "created anchor generation"),
    messages,
  };
  if (record.capture !== undefined) thread.capture = hydrateCapture(record.capture);
  return thread;
}

function hydrateAnchor(value: unknown, preGenerationAnchor = false): ThreadAnchor {
  const record = requireRecord(value, "thread anchor");
  if (record.schemaVersion === CURRENT_ANCHOR_SCHEMA_VERSION) {
    if (!preGenerationAnchor) return hydrateCurrentAnchor(record, "thread anchor");
    const historical = hydrateHistoricalCurrentAnchor(record, "pre-generation thread anchor");
    return {
      schemaVersion: CURRENT_ANCHOR_SCHEMA_VERSION,
      locationAvailability: "unavailable",
      recoveryState: "legacy_replacement_required",
      context: historical.context,
    };
  }
  if (record.schemaVersion !== 1) throw new Error("unsupported anchor schema in event history");
  const geometry = requireRecord(record.geometry, "anchor geometry");
  const scroll = requireRecord(record.scroll, "anchor scroll");
  requireRatio(geometry.xRatio);
  requireRatio(geometry.yRatio);
  requireRatio(scroll.xRatio);
  requireRatio(scroll.yRatio);
  if (record.semantic !== undefined) {
    const semantic = requireRecord(record.semantic, "anchor semantic context");
    if (semantic.role !== undefined) requireHydratedString(semantic.role, "anchor role", true);
    if (semantic.accessibleName !== undefined) requireHydratedString(semantic.accessibleName, "anchor accessible name", true);
    if (semantic.testId !== undefined) requireHydratedString(semantic.testId, "anchor test id", true);
  }
  if (record.text !== undefined) {
    const text = requireRecord(record.text, "anchor text context");
    requireHydratedString(text.exact, "anchor exact text", true);
    if (text.prefix !== undefined) requireHydratedString(text.prefix, "anchor text prefix", true);
    if (text.suffix !== undefined) requireHydratedString(text.suffix, "anchor text suffix", true);
  }
  return { schemaVersion: 1, locationAvailability: "unavailable", recoveryState: "legacy_replacement_required" };
}

function hydrateHistoricalCurrentAnchor(value: unknown, label: string): CurrentAnchor {
  const record = requireRecord(value, label);
  if (record.schemaVersion !== CURRENT_ANCHOR_SCHEMA_VERSION) throw new Error(`invalid ${label} schema version`);
  if (record.locationAvailability !== "available") throw new Error(`invalid ${label} location availability`);
  if (record.recoveryState !== "not_required") throw new Error(`invalid ${label} recovery state`);
  const elementRecord = requireRecord(record.element, `${label} element`);
  const offsetRecord = requireRecord(elementRecord.offset, `${label} element offset`);
  const documentRecord = requireRecord(record.document, `${label} document`);
  const anchor: CurrentAnchor = {
    schemaVersion: CURRENT_ANCHOR_SCHEMA_VERSION,
    locationAvailability: "available",
    recoveryState: "not_required",
    context: hydrateHistoricalAnchorContext(record.context, `${label} context`),
    element: {
      selector: requireHydratedString(elementRecord.selector, `${label} element selector`),
      identity: requireHydratedString(elementRecord.identity, `${label} element identity`),
      offset: {
        x: requireHistoricalAnchorNumber(offsetRecord.x, `${label} element x offset`, ANCHOR_ELEMENT_OFFSET_MINIMUM),
        y: requireHistoricalAnchorNumber(offsetRecord.y, `${label} element y offset`, ANCHOR_ELEMENT_OFFSET_MINIMUM),
      },
    },
    document: {
      x: requireHistoricalAnchorNumber(documentRecord.x, `${label} document x`, 0),
      y: requireHistoricalAnchorNumber(documentRecord.y, `${label} document y`, 0),
      width: requireHistoricalAnchorNumber(documentRecord.width, `${label} document width`, 1),
      height: requireHistoricalAnchorNumber(documentRecord.height, `${label} document height`, 1),
    },
  };
  if (record.semantic !== undefined) {
    const semantic = requireRecord(record.semantic, `${label} semantic context`);
    anchor.semantic = {};
    if (semantic.role !== undefined) anchor.semantic.role = requireHydratedString(semantic.role, `${label} role`, true);
    if (semantic.accessibleName !== undefined) anchor.semantic.accessibleName = requireHydratedString(semantic.accessibleName, `${label} accessible name`, true);
    if (semantic.testId !== undefined) anchor.semantic.testId = requireHydratedString(semantic.testId, `${label} test id`, true);
  }
  if (record.text !== undefined) {
    const text = requireRecord(record.text, `${label} text context`);
    anchor.text = { exact: requireHydratedString(text.exact, `${label} exact text`, true) };
    if (text.prefix !== undefined) anchor.text.prefix = requireHydratedString(text.prefix, `${label} text prefix`, true);
    if (text.suffix !== undefined) anchor.text.suffix = requireHydratedString(text.suffix, `${label} text suffix`, true);
  }
  return anchor;
}

function hydrateHistoricalAnchorContext(value: unknown, label: string): AnchorContext {
  const record = requireRecord(value, label);
  return {
    reviewId: requireHydratedString(record.reviewId, `${label} review id`),
    prototypeId: requireHydratedString(record.prototypeId, `${label} prototype id`),
    revisionId: requireHydratedString(record.revisionId, `${label} revision id`),
    viewportId: requireHydratedString(record.viewportId, `${label} viewport id`),
    variantId: requireHydratedString(record.variantId, `${label} variant id`),
    route: requireHydratedString(record.route, `${label} route`),
    deviceId: requireHydratedString(record.deviceId, `${label} device id`),
    surfaceId: requireHydratedString(record.surfaceId, `${label} surface id`),
  };
}

function requireHistoricalAnchorNumber(value: unknown, label: string, minimum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum) throw new Error(`invalid ${label}`);
  return value;
}

function hydrateCurrentAnchor(value: unknown, label: string, preBoundReviewContext?: ReviewContext): CurrentAnchor {
  const record = requireRecord(value, label);
  if (record.schemaVersion !== CURRENT_ANCHOR_SCHEMA_VERSION) throw new Error(`invalid ${label} schema version`);
  if (record.locationAvailability !== "available") throw new Error(`invalid ${label} location availability`);
  if (record.recoveryState !== "not_required") throw new Error(`invalid ${label} recovery state`);
  const anchorContext = hydrateAnchorContext(record.context, `${label} context`, preBoundReviewContext);
  const elementRecord = requireRecord(record.element, `${label} element`);
  const offsetRecord = requireRecord(elementRecord.offset, `${label} element offset`);
  const documentRecord = requireRecord(record.document, `${label} document`);
  const anchor: CurrentAnchor = {
    schemaVersion: CURRENT_ANCHOR_SCHEMA_VERSION,
    locationAvailability: "available",
    recoveryState: "not_required",
    context: anchorContext,
    element: {
      selector: requireAnchorSelector(elementRecord.selector, `${label} element selector`),
      identity: requireAnchorIdentifier(elementRecord.identity, `${label} element identity`),
      offset: {
        x: requireAnchorNumber(offsetRecord.x, `${label} element x offset`, ANCHOR_ELEMENT_OFFSET_MINIMUM),
        y: requireAnchorNumber(offsetRecord.y, `${label} element y offset`, ANCHOR_ELEMENT_OFFSET_MINIMUM),
      },
    },
    document: {
      x: requireAnchorNumber(documentRecord.x, `${label} document x`, 0),
      y: requireAnchorNumber(documentRecord.y, `${label} document y`, 0),
      width: requireAnchorNumber(documentRecord.width, `${label} document width`, 1),
      height: requireAnchorNumber(documentRecord.height, `${label} document height`, 1),
    },
  };
  if (record.semantic !== undefined) {
    const semantic = requireRecord(record.semantic, `${label} semantic context`);
    anchor.semantic = {};
    if (semantic.role !== undefined) anchor.semantic.role = requireAnchorMetadata(semantic.role, `${label} role`, 256);
    if (semantic.accessibleName !== undefined) anchor.semantic.accessibleName = requireAnchorMetadata(semantic.accessibleName, `${label} accessible name`, 2_048);
    if (semantic.testId !== undefined) anchor.semantic.testId = requireAnchorMetadata(semantic.testId, `${label} test id`, 256);
  }
  if (record.text !== undefined) {
    const text = requireRecord(record.text, `${label} text context`);
    anchor.text = { exact: requireAnchorText(text.exact, `${label} exact text`, 4_096) };
    if (text.prefix !== undefined) anchor.text.prefix = requireAnchorText(text.prefix, `${label} text prefix`, 1_024);
    if (text.suffix !== undefined) anchor.text.suffix = requireAnchorText(text.suffix, `${label} text suffix`, 1_024);
  }
  return anchor;
}

function anchorSchemaVersion(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return (value as Record<string, unknown>).schemaVersion;
}

function requireMatchingAnchorContext(anchor: AnchorContext, context: ReviewContext): void {
  for (const key of ["reviewId", "prototypeId", "revisionId", "viewportId", "variantId", "route"] as const) {
    if (anchor[key] !== context[key]) throw new Error(`anchor ${key} does not match thread context`);
  }
}

function requireMatchingCompleteAnchorContext(anchor: AnchorContext, expected: AnchorContext, label: string): void {
  for (const key of ["reviewId", "prototypeId", "revisionId", "viewportId", "variantId", "route", "deviceId", "surfaceId"] as const) {
    if (anchor[key] !== expected[key]) throw new Error(`${label} ${key} does not match previous anchor context`);
  }
}

function requireRetainedAnchorContext(anchor: AnchorContext, previous: ThreadAnchor, label: string): void {
  if (!("context" in previous)) return;
  for (const key of ["deviceId", "surfaceId"] as const) {
    const wasAdmittedByCurrentContract = previous.recoveryState !== "legacy_replacement_required"
      || readAnchorIdentifier(previous.context[key]).ok;
    if (wasAdmittedByCurrentContract && anchor[key] !== previous.context[key]) {
      throw new Error(`${label} ${key} does not match previous anchor context`);
    }
  }
}

function requireAnchorGeneration(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(`invalid ${label}`);
  return value as number;
}

function requireMatchingAnchorGeneration(value: unknown, expected: number, label: string): number {
  const generation = requireAnchorGeneration(value, label);
  if (generation !== expected) throw new Error(`${label} does not match event order`);
  return generation;
}

function nextAnchorGeneration(value: number): number {
  const generation = requireAnchorGeneration(value, "anchor generation");
  if (generation === Number.MAX_SAFE_INTEGER) throw new Error("anchor generation cannot advance");
  return generation + 1;
}

function hydrateOrphanedAnchor(value: unknown, label: string, preBoundReviewContext?: ReviewContext): OrphanedAnchor {
  const record = requireRecord(value, label);
  if (
    record.schemaVersion !== CURRENT_ANCHOR_SCHEMA_VERSION
    || record.locationAvailability !== "unavailable"
    || record.recoveryState !== "orphaned_replacement_required"
  ) throw new Error(`invalid ${label} state`);
  return {
    schemaVersion: CURRENT_ANCHOR_SCHEMA_VERSION,
    locationAvailability: "unavailable",
    recoveryState: "orphaned_replacement_required",
    context: hydrateAnchorContext(record.context, `${label} context`, preBoundReviewContext),
  };
}

function hydrateAnchorContext(value: unknown, label: string, preBoundReviewContext?: ReviewContext): AnchorContext {
  const record = requireRecord(value, label);
  return {
    reviewId: requireAnchorContextIdentifier(record.reviewId, preBoundReviewContext?.reviewId, `${label} review id`),
    prototypeId: requireAnchorContextIdentifier(record.prototypeId, preBoundReviewContext?.prototypeId, `${label} prototype id`),
    revisionId: requireAnchorContextIdentifier(record.revisionId, preBoundReviewContext?.revisionId, `${label} revision id`),
    viewportId: requireAnchorContextIdentifier(record.viewportId, preBoundReviewContext?.viewportId, `${label} viewport id`),
    variantId: requireAnchorContextIdentifier(record.variantId, preBoundReviewContext?.variantId, `${label} variant id`),
    route: requireAnchorContextRoute(record.route, preBoundReviewContext?.route, `${label} route`),
    deviceId: requireAnchorIdentifier(record.deviceId, `${label} device id`),
    surfaceId: requireAnchorIdentifier(record.surfaceId, `${label} surface id`),
  };
}

function requireAnchorContextIdentifier(value: unknown, preBoundValue: string | undefined, label: string): string {
  if (preBoundValue === undefined) return requireAnchorIdentifier(value, label);
  if (value !== preBoundValue) throw new Error(`${label} does not match immutable thread context`);
  return preBoundValue;
}

function requireAnchorContextRoute(value: unknown, preBoundValue: string | undefined, label: string): string {
  if (preBoundValue === undefined) return requireAnchorRoute(value, label);
  if (value !== preBoundValue) throw new Error(`${label} does not match immutable thread context`);
  return preBoundValue;
}

function requireAnchorIdentifier(value: unknown, label: string): string {
  const result = readAnchorIdentifier(value);
  if (!result.ok) throw new Error(`invalid ${label}`);
  return result.value;
}

function requireAnchorRoute(value: unknown, label: string): string {
  const result = readBridgeRoute(value);
  if (!result.ok) throw new Error(`invalid ${label}`);
  return result.value;
}

function requireAnchorSelector(value: unknown, label: string): string {
  const result = readAnchorSelector(value);
  if (!result.ok) throw new Error(`invalid ${label}`);
  return result.value;
}

function requireAnchorMetadata(value: unknown, label: string, maximumLength: number): string {
  const result = readAnchorMetadata(value, maximumLength);
  if (!result.ok) throw new Error(`invalid ${label}`);
  return result.value;
}

function requireAnchorText(value: unknown, label: string, maximumLength: number): string {
  const result = readAnchorText(value, maximumLength);
  if (!result.ok) throw new Error(`invalid ${label}`);
  return result.value;
}

function requireAnchorNumber(value: unknown, label: string, minimum: number): number {
  const result = readAnchorCoordinate(value, minimum);
  if (!result.ok) throw new Error(`invalid ${label}`);
  return result.value;
}

function hydrateCapture(value: unknown): Capture {
  const record = requireRecord(value, "thread capture");
  const digest = requireHydratedString(record.digest, "capture digest");
  if (!/^sha256:[a-f0-9]{64}$/.test(digest)) throw new Error("invalid capture digest in event history");
  return {
    id: requireHydratedString(record.id, "capture id"),
    digest: digest as Capture["digest"],
    mediaType: requireHydratedString(record.mediaType, "capture media type"),
    createdAt: requireTimestamp(record.createdAt, "capture creation timestamp"),
  };
}

function hydrateMessage(value: unknown, label: string): Message {
  const record = requireRecord(value, label);
  const message: Message = {
    id: requireHydratedString(record.id, `${label} id`),
    authorId: requireHydratedString(record.authorId, `${label} author`),
    body: requireHydratedString(record.body, `${label} body`),
    createdAt: requireTimestamp(record.createdAt, `${label} creation timestamp`),
  };
  requirePersistedBody(message.body);
  if (record.editedAt !== undefined) message.editedAt = requireTimestamp(record.editedAt, `${label} edit timestamp`);
  if (record.deletedAt !== undefined) message.deletedAt = requireTimestamp(record.deletedAt, `${label} deletion timestamp`);
  return message;
}

function hydratedOwnedMessage(thread: Thread, payload: Readonly<Record<string, unknown>>, actorId: string): Message {
  const messageId = requireHydratedString(payload.messageId, "message id");
  const message = thread.messages.find((candidate) => candidate.id === messageId);
  if (!message) throw new Error(`unknown message in event history: ${messageId}`);
  if (message.authorId !== actorId) throw new Error("message event actor does not own the message");
  return message;
}

function requireRatio(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) throw new Error("invalid anchor ratio in event history");
  return value;
}

function requireArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`invalid ${label} in event history`);
  return value;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`invalid ${label} in event history`);
  return value as Record<string, unknown>;
}

function requireHydratedString(value: unknown, label: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && !value.trim())) throw new Error(`invalid ${label} in event history`);
  return value;
}
