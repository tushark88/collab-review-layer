import type { Anchor, Capture, Disposition, DomainEvent, Message, ReviewContext, Thread } from "./domain.ts";

export interface EventStore {
  append(event: Omit<DomainEvent, "sequence">): DomainEvent;
  read(reviewId: string): readonly DomainEvent[];
}

export class InMemoryEventStore implements EventStore {
  readonly #events: DomainEvent[] = [];

  append(event: Omit<DomainEvent, "sequence">): DomainEvent {
    const stored = Object.freeze({ ...structuredClone(event), sequence: this.#events.length + 1 });
    this.#events.push(stored);
    return structuredClone(stored);
  }

  read(reviewId: string): readonly DomainEvent[] {
    return this.#events.filter((event) => event.reviewId === reviewId).map((event) => structuredClone(event));
  }
}

export interface KernelDependencies {
  events: EventStore;
  now: () => string;
  id: () => string;
}

export class ReviewKernel {
  readonly #threads = new Map<string, Thread>();
  readonly dependencies: KernelDependencies;
  constructor(dependencies: KernelDependencies) { this.dependencies = dependencies; }

  createThread(input: { context: ReviewContext; anchor: Anchor; capture?: Capture; actorId: string; body: string }): Thread {
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
    const thread = this.#thread(threadId);
    const message = { id: this.dependencies.id(), authorId: actorId, body, createdAt: this.dependencies.now() };
    thread.messages.push(message);
    this.#record(thread, actorId, "message.created", { threadId, message });
    return structuredClone(thread);
  }

  editMessage(threadId: string, messageId: string, actorId: string, body: string): Thread {
    requireBody(body);
    const thread = this.#thread(threadId);
    const message = requireOwnedMessage(thread, messageId, actorId);
    if (message.deletedAt) throw new Error("deleted messages cannot be edited");
    message.body = body;
    message.editedAt = this.dependencies.now();
    this.#record(thread, actorId, "message.edited", { threadId, messageId, body });
    return structuredClone(thread);
  }

  deleteMessage(threadId: string, messageId: string, actorId: string): Thread {
    const thread = this.#thread(threadId);
    const message = requireOwnedMessage(thread, messageId, actorId);
    if (!message.deletedAt) message.deletedAt = this.dependencies.now();
    this.#record(thread, actorId, "message.deleted", { threadId, messageId });
    return structuredClone(thread);
  }

  resolve(threadId: string, actorId: string, disposition: Disposition, reason?: string): Thread {
    if (disposition === "rejected" && !reason?.trim()) throw new Error("rejection requires a reason");
    const thread = this.#thread(threadId);
    thread.resolvedAt = this.dependencies.now();
    thread.disposition = disposition;
    if (reason?.trim()) thread.dispositionReason = reason.trim();
    this.#record(thread, actorId, "thread.resolved", { threadId, disposition, reason });
    return structuredClone(thread);
  }

  reopen(threadId: string, actorId: string): Thread {
    const thread = this.#thread(threadId);
    delete thread.resolvedAt;
    delete thread.disposition;
    delete thread.dispositionReason;
    this.#record(thread, actorId, "thread.reopened", { threadId });
    return structuredClone(thread);
  }

  getThread(threadId: string): Thread { return structuredClone(this.#thread(threadId)); }

  #thread(id: string): Thread {
    const thread = this.#threads.get(id);
    if (!thread) throw new Error(`unknown thread: ${id}`);
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
