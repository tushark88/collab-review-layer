import { requireDisposition, type Anchor, type Capture, type Disposition, type DomainEvent, type Message, type ReviewContext, type Thread } from "./domain.ts";
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
    requireAnchor(input.anchor);
    const now = this.dependencies.now();
    const message: Message = { id: this.dependencies.id(), authorId: input.actorId, body: input.body, createdAt: now };
    const candidate: Thread = { id: this.dependencies.id(), context: structuredClone(input.context), anchor: structuredClone(input.anchor), messages: [message] };
    if (this.#threads.has(candidate.id)) throw new Error("duplicate thread id");
    if (input.capture) candidate.capture = structuredClone(input.capture);
    const thread = hydrateCreatedThread(candidate, { reviewId: input.context.reviewId, actorId: input.actorId });
    this.#record(thread.context.reviewId, input.actorId, "thread.created", { thread }, now);
    this.#threads.set(thread.id, thread);
    return structuredClone(thread);
  }

  reply(threadId: string, actorId: string, body: string): Thread {
    requireBody(body);
    this.#refresh();
    const thread = this.#authorizedThread(threadId, actorId, "reply");
    const now = this.dependencies.now();
    const message = { id: this.dependencies.id(), authorId: actorId, body, createdAt: now };
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
    const now = this.dependencies.now();
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
    const now = this.dependencies.now();
    if (!message.deletedAt) message.deletedAt = now;
    this.#record(thread.context.reviewId, actorId, "message.deleted", { threadId, messageId }, now);
    this.#threads.set(threadId, updated);
    return structuredClone(updated);
  }

  resolve(threadId: string, actorId: string, disposition: Disposition, reason?: string): Thread {
    const validatedDisposition = requireDisposition(disposition);
    if (validatedDisposition === "rejected" && !reason?.trim()) throw new Error("rejection requires a reason");
    this.#refresh();
    const thread = this.#authorizedThread(threadId, actorId, "resolve_thread");
    const updated = structuredClone(thread);
    const now = this.dependencies.now();
    updated.resolvedAt = now;
    updated.disposition = validatedDisposition;
    if (reason?.trim()) updated.dispositionReason = reason.trim();
    else delete updated.dispositionReason;
    this.#record(thread.context.reviewId, actorId, "thread.resolved", { threadId, disposition: validatedDisposition, reason }, now);
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
    this.#record(thread.context.reviewId, actorId, "thread.reopened", { threadId }, this.dependencies.now());
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
    if (event.type === "thread.created") {
      const payload = requireRecord(event.payload, "thread creation payload");
      const thread = hydrateCreatedThread(payload.thread, event);
      if (this.#threads.has(thread.id)) throw new Error("duplicate thread id in event history");
      this.#threads.set(thread.id, thread);
      return;
    }
    if (!KNOWN_THREAD_EVENT_TYPES.has(event.type)) return;
    const payload = requireRecord(event.payload, `${event.type} payload`);
    const threadId = requireHydratedString(payload.threadId, "thread id");
    const thread = this.#threads.get(threadId);
    if (!thread) throw new Error(`unknown thread in event history: ${threadId}`);
    if (thread.context.reviewId !== event.reviewId) throw new Error("event review does not match hydrated thread");
    const updated = structuredClone(thread);

    if (event.type === "message.created") {
      const message = hydrateMessage(payload.message, "created message");
      if (message.authorId !== event.actorId) throw new Error("created message actor does not match event actor");
      if (message.editedAt || message.deletedAt) throw new Error("created message contains lifecycle timestamps");
      if (updated.messages.some((known) => known.id === message.id)) throw new Error("duplicate message id in event history");
      updated.messages.push(message);
    } else if (event.type === "message.edited") {
      const message = hydratedOwnedMessage(updated, payload, event.actorId);
      if (message.deletedAt) throw new Error("deleted message was edited in event history");
      message.body = requireHydratedString(payload.body, "edited message body");
      requireBody(message.body);
      message.editedAt = event.occurredAt;
    } else if (event.type === "message.deleted") {
      const message = hydratedOwnedMessage(updated, payload, event.actorId);
      if (!message.deletedAt) message.deletedAt = event.occurredAt;
    } else if (event.type === "thread.resolved") {
      const disposition = requireDisposition(payload.disposition);
      const reason = payload.reason === undefined ? undefined : requireHydratedString(payload.reason, "disposition reason");
      if (disposition === "rejected" && !reason?.trim()) throw new Error("rejected event is missing its reason");
      updated.resolvedAt = event.occurredAt;
      updated.disposition = disposition;
      if (reason?.trim()) updated.dispositionReason = reason.trim();
      else delete updated.dispositionReason;
    } else if (event.type === "thread.reopened") {
      delete updated.resolvedAt;
      delete updated.disposition;
      delete updated.dispositionReason;
    }
    this.#threads.set(threadId, updated);
  }
}

const KNOWN_THREAD_EVENT_TYPES = new Set(["message.created", "message.edited", "message.deleted", "thread.resolved", "thread.reopened"]);

function requireBody(body: string): void {
  if (!body.trim()) throw new Error("message body is required");
}

function requireAnchor(anchor: Anchor): void {
  for (const value of [anchor.geometry.xRatio, anchor.geometry.yRatio, anchor.scroll.xRatio, anchor.scroll.yRatio]) {
    if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error("anchor ratios must be between 0 and 1");
  }
}

function requireOwnedMessage(thread: Thread, id: string, actorId: string): Message {
  const message = thread.messages.find((candidate) => candidate.id === id);
  if (!message) throw new Error(`unknown message: ${id}`);
  if (message.authorId !== actorId) throw new Error("only the author may mutate a message");
  return message;
}

function hydrateCreatedThread(value: unknown, event: Pick<DomainEvent, "reviewId" | "actorId">): Thread {
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
  if (messages[0]!.editedAt || messages[0]!.deletedAt) throw new Error("created thread message contains lifecycle timestamps");
  if (record.resolvedAt !== undefined || record.disposition !== undefined || record.dispositionReason !== undefined) throw new Error("created thread contains lifecycle state");
  const thread: Thread = {
    id: requireHydratedString(record.id, "thread id"),
    context,
    anchor: hydrateAnchor(record.anchor),
    messages,
  };
  if (record.capture !== undefined) thread.capture = hydrateCapture(record.capture);
  return thread;
}

function hydrateAnchor(value: unknown): Anchor {
  const record = requireRecord(value, "thread anchor");
  if (record.schemaVersion !== 1) throw new Error("unsupported anchor schema in event history");
  const geometry = requireRecord(record.geometry, "anchor geometry");
  const scroll = requireRecord(record.scroll, "anchor scroll");
  const anchor: Anchor = {
    schemaVersion: 1,
    geometry: { xRatio: requireRatio(geometry.xRatio), yRatio: requireRatio(geometry.yRatio) },
    scroll: { xRatio: requireRatio(scroll.xRatio), yRatio: requireRatio(scroll.yRatio) },
  };
  if (record.semantic !== undefined) {
    const semantic = requireRecord(record.semantic, "anchor semantic context");
    anchor.semantic = {};
    if (semantic.role !== undefined) anchor.semantic.role = requireHydratedString(semantic.role, "anchor role", true);
    if (semantic.accessibleName !== undefined) anchor.semantic.accessibleName = requireHydratedString(semantic.accessibleName, "anchor accessible name", true);
    if (semantic.testId !== undefined) anchor.semantic.testId = requireHydratedString(semantic.testId, "anchor test id", true);
  }
  if (record.text !== undefined) {
    const text = requireRecord(record.text, "anchor text context");
    anchor.text = { exact: requireHydratedString(text.exact, "anchor exact text", true) };
    if (text.prefix !== undefined) anchor.text.prefix = requireHydratedString(text.prefix, "anchor text prefix", true);
    if (text.suffix !== undefined) anchor.text.suffix = requireHydratedString(text.suffix, "anchor text suffix", true);
  }
  return anchor;
}

function hydrateCapture(value: unknown): Capture {
  const record = requireRecord(value, "thread capture");
  const digest = requireHydratedString(record.digest, "capture digest");
  if (!/^sha256:[a-f0-9]{64}$/.test(digest)) throw new Error("invalid capture digest in event history");
  return {
    id: requireHydratedString(record.id, "capture id"),
    digest: digest as Capture["digest"],
    mediaType: requireHydratedString(record.mediaType, "capture media type"),
    createdAt: requireHydratedString(record.createdAt, "capture creation time"),
  };
}

function hydrateMessage(value: unknown, label: string): Message {
  const record = requireRecord(value, label);
  const message: Message = {
    id: requireHydratedString(record.id, `${label} id`),
    authorId: requireHydratedString(record.authorId, `${label} author`),
    body: requireHydratedString(record.body, `${label} body`),
    createdAt: requireHydratedString(record.createdAt, `${label} creation time`),
  };
  requireBody(message.body);
  if (record.editedAt !== undefined) message.editedAt = requireHydratedString(record.editedAt, `${label} edit time`);
  if (record.deletedAt !== undefined) message.deletedAt = requireHydratedString(record.deletedAt, `${label} deletion time`);
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
