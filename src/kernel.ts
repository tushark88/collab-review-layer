import type { Anchor, Capture, Disposition, DomainEvent, Message, ReviewContext, Thread } from "./domain.ts";
import type { ReviewAction, ReviewAuthorizer } from "./auth.ts";
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
  readonly dependencies: KernelDependencies;
  constructor(dependencies: KernelDependencies) { this.dependencies = dependencies; }

  createThread(input: { context: ReviewContext; anchor: Anchor; capture?: Capture; actorId: string; body: string }): Thread {
    this.dependencies.authorizer.assertAllowed({ actorId: input.actorId, reviewId: input.context.reviewId, action: "create_thread" });
    requireBody(input.body);
    requireAnchor(input.anchor);
    const now = this.dependencies.now();
    const message: Message = { id: this.dependencies.id(), authorId: input.actorId, body: input.body, createdAt: now };
    const thread: Thread = { id: this.dependencies.id(), context: structuredClone(input.context), anchor: structuredClone(input.anchor), messages: [message] };
    if (input.capture) thread.capture = structuredClone(input.capture);
    this.#threads.set(thread.id, thread);
    this.#record(thread, input.actorId, "thread.created", { thread });
    return structuredClone(thread);
  }

  reply(threadId: string, actorId: string, body: string): Thread {
    requireBody(body);
    const thread = this.#authorizedThread(threadId, actorId, "reply");
    const message = { id: this.dependencies.id(), authorId: actorId, body, createdAt: this.dependencies.now() };
    thread.messages.push(message);
    this.#record(thread, actorId, "message.created", { threadId, message });
    return structuredClone(thread);
  }

  editMessage(threadId: string, messageId: string, actorId: string, body: string): Thread {
    requireBody(body);
    const thread = this.#authorizedThread(threadId, actorId, "edit_own_message");
    const message = requireOwnedMessage(thread, messageId, actorId);
    if (message.deletedAt) throw new Error("deleted messages cannot be edited");
    message.body = body;
    message.editedAt = this.dependencies.now();
    this.#record(thread, actorId, "message.edited", { threadId, messageId, body });
    return structuredClone(thread);
  }

  deleteMessage(threadId: string, messageId: string, actorId: string): Thread {
    const thread = this.#authorizedThread(threadId, actorId, "delete_own_message");
    const message = requireOwnedMessage(thread, messageId, actorId);
    if (!message.deletedAt) message.deletedAt = this.dependencies.now();
    this.#record(thread, actorId, "message.deleted", { threadId, messageId });
    return structuredClone(thread);
  }

  resolve(threadId: string, actorId: string, disposition: Disposition, reason?: string): Thread {
    if (disposition === "rejected" && !reason?.trim()) throw new Error("rejection requires a reason");
    const thread = this.#authorizedThread(threadId, actorId, "resolve_thread");
    thread.resolvedAt = this.dependencies.now();
    thread.disposition = disposition;
    if (reason?.trim()) thread.dispositionReason = reason.trim();
    this.#record(thread, actorId, "thread.resolved", { threadId, disposition, reason });
    return structuredClone(thread);
  }

  reopen(threadId: string, actorId: string): Thread {
    const thread = this.#authorizedThread(threadId, actorId, "reopen_thread");
    delete thread.resolvedAt;
    delete thread.disposition;
    delete thread.dispositionReason;
    this.#record(thread, actorId, "thread.reopened", { threadId });
    return structuredClone(thread);
  }

  getThread(threadId: string, actorId: string): Thread {
    return structuredClone(this.#authorizedThread(threadId, actorId, "read_thread"));
  }

  #thread(id: string): Thread {
    const thread = this.#threads.get(id);
    if (!thread) throw new Error(`unknown thread: ${id}`);
    return thread;
  }

  #authorizedThread(id: string, actorId: string, action: ReviewAction): Thread {
    const thread = this.#thread(id);
    this.dependencies.authorizer.assertAllowed({ actorId, reviewId: thread.context.reviewId, action, threadId: id });
    return thread;
  }

  #record(thread: Thread, actorId: string, type: string, payload: unknown): void {
    this.dependencies.events.append({ id: this.dependencies.id(), reviewId: thread.context.reviewId, type, occurredAt: this.dependencies.now(), actorId, payload });
  }
}

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
