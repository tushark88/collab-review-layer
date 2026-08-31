import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { StaticReviewAuthorizer, type ReviewAction, type ReviewAuthorizer } from "../src/auth.ts";
import type { DomainEvent } from "../src/domain.ts";
import { FileEventStore, InMemoryEventStore, MAX_MESSAGE_BODY_BYTES, ReviewKernel, type EventStore } from "../src/kernel.ts";
import { exportNdjson } from "../src/export.ts";

const context = { reviewId: "review-1", prototypeId: "prototype-1", revisionId: "rev-abc", viewportId: "mobile", variantId: "control", route: "/synthetic" };
const anchor = { schemaVersion: 1 as const, geometry: { xRatio: 0.25, yRatio: 0.5 }, scroll: { xRatio: 0, yRatio: 0.4 }, semantic: { role: "button", accessibleName: "Continue" } };

function setupWithEvents(events: EventStore) {
  let id = 0;
  const everyAction: ReviewAction[] = ["create_thread", "reply", "edit_own_message", "delete_own_message", "resolve_thread", "reopen_thread", "read_thread"];
  const authorizer = new StaticReviewAuthorizer([
    { actorId: "actor-private", reviewId: context.reviewId, actions: everyAction },
    { actorId: "reviewer-2", reviewId: context.reviewId, actions: everyAction },
    { actorId: "a", reviewId: context.reviewId, actions: everyAction },
    { actorId: "person@example.test", reviewId: context.reviewId, actions: everyAction },
  ]);
  const kernel = new ReviewKernel({ events, authorizer, now: () => "2026-08-30T00:00:00.000Z", id: () => `id-${++id}` });
  return { events, kernel };
}

function setup() {
  return setupWithEvents(new InMemoryEventStore());
}

class ToggleEventStore implements EventStore {
  rejecting = false;
  readonly delegate = new InMemoryEventStore();

  append(event: Omit<DomainEvent, "sequence">, expectedSequence?: number): DomainEvent {
    if (this.rejecting) throw new Error("synthetic append rejection");
    return this.delegate.append(event, expectedSequence);
  }

  read(reviewId: string): readonly DomainEvent[] {
    return this.delegate.read(reviewId);
  }

  readAll(): readonly DomainEvent[] {
    return this.delegate.readAll();
  }
}

test("thread lifecycle is durable and append-only", () => {
  const { events, kernel } = setup();
  let thread = kernel.createThread({ context, anchor, actorId: "actor-private", body: "Synthetic feedback" });
  const firstMessage = thread.messages[0]!;
  thread = kernel.reply(thread.id, "actor-private", "More evidence");
  thread = kernel.editMessage(thread.id, firstMessage.id, "actor-private", "Edited feedback");
  thread = kernel.resolve(thread.id, "reviewer-2", "rejected", "Expected behavior");
  assert.equal(thread.disposition, "rejected");
  thread = kernel.reopen(thread.id, "reviewer-2");
  assert.equal(thread.disposition, undefined);
  assert.deepEqual(events.read(context.reviewId).map((event) => event.type), ["thread.created", "message.created", "message.edited", "thread.resolved", "thread.reopened"]);
});

test("generated identifier collisions are rejected before append", () => {
  const events = new InMemoryEventStore();
  const everyAction: ReviewAction[] = ["create_thread", "reply", "edit_own_message", "delete_own_message", "resolve_thread", "reopen_thread", "read_thread"];
  const authorizer = new StaticReviewAuthorizer([{ actorId: "a", reviewId: context.reviewId, actions: everyAction }]);
  const identifiers = ["message-1", "thread-1", "event-1", "message-2", "thread-1", "message-1"];
  const kernel = new ReviewKernel({ events, authorizer, now: () => "2026-08-30T00:00:00.000Z", id: () => identifiers.shift() ?? "unexpected-id" });
  const before = kernel.createThread({ context, anchor, actorId: "a", body: "Initial feedback" });

  assert.throws(() => kernel.createThread({ context, anchor, actorId: "a", body: "Duplicate thread" }), /duplicate thread id/);
  assert.equal(events.readAll().length, 1);
  assert.deepEqual(kernel.getThread(before.id, "a"), before);

  assert.throws(() => kernel.reply(before.id, "a", "Duplicate message"), /duplicate message id/);
  assert.equal(events.readAll().length, 1);
  assert.deepEqual(kernel.getThread(before.id, "a"), before);
});

test("reply validation rejects an invalid generated timestamp before append", () => {
  const events = new InMemoryEventStore();
  const everyAction: ReviewAction[] = ["create_thread", "reply", "edit_own_message", "delete_own_message", "resolve_thread", "reopen_thread", "read_thread"];
  const authorizer = new StaticReviewAuthorizer([{ actorId: "a", reviewId: context.reviewId, actions: everyAction }]);
  let id = 0;
  let clockCalls = 0;
  const kernel = new ReviewKernel({
    events,
    authorizer,
    now: () => clockCalls++ === 0 ? "2026-08-30T00:00:00.000Z" : "   ",
    id: () => `reply-validation-${++id}`,
  });
  const before = kernel.createThread({ context, anchor, actorId: "a", body: "Initial feedback" });

  assert.throws(() => kernel.reply(before.id, "a", "Invalid timestamp reply"), /reply message creation time/);
  assert.equal(events.readAll().length, 1);
  assert.deepEqual(kernel.getThread(before.id, "a"), before);
});

test("kernel rejects oversized review text before append", () => {
  const events = new InMemoryEventStore();
  const { kernel } = setupWithEvents(events);
  const oversized = "x".repeat(MAX_MESSAGE_BODY_BYTES + 1);

  assert.throws(() => kernel.createThread({ context, anchor, actorId: "a", body: oversized }), /message body exceeds size limit/);
  assert.equal(events.readAll().length, 0);
  const thread = kernel.createThread({ context, anchor, actorId: "a", body: "Initial feedback" });
  assert.throws(() => kernel.reply(thread.id, "a", oversized), /message body exceeds size limit/);
  assert.throws(() => kernel.editMessage(thread.id, thread.messages[0]!.id, "a", oversized), /message body exceeds size limit/);
  assert.throws(() => kernel.resolve(thread.id, "a", "rejected", oversized), /disposition reason exceeds size limit/);
  assert.equal(events.readAll().length, 1);
});

test("lifecycle mutations persist and return the same operation timestamps", () => {
  const events = new InMemoryEventStore();
  const everyAction: ReviewAction[] = ["create_thread", "reply", "edit_own_message", "delete_own_message", "resolve_thread", "reopen_thread", "read_thread"];
  const authorizer = new StaticReviewAuthorizer([{ actorId: "a", reviewId: context.reviewId, actions: everyAction }]);
  let id = 0;
  let tick = 0;
  const kernel = new ReviewKernel({ events, authorizer, now: () => new Date(Date.UTC(2026, 7, 30, 0, 0, tick++)).toISOString(), id: () => `timestamp-${++id}` });
  const created = kernel.createThread({ context, anchor, actorId: "a", body: "Initial feedback" });
  kernel.editMessage(created.id, created.messages[0]!.id, "a", "Edited feedback");
  kernel.deleteMessage(created.id, created.messages[0]!.id, "a");
  const immediate = kernel.resolve(created.id, "a", "accepted");

  const restarted = new ReviewKernel({
    events,
    authorizer,
    now: () => { throw new Error("restart read must not need a clock"); },
    id: () => { throw new Error("restart read must not need an id"); },
  });
  assert.deepEqual(restarted.getThread(created.id, "a"), immediate);
});

test("rejecting without a reason fails closed", () => {
  const { kernel } = setup();
  const thread = kernel.createThread({ context, anchor, actorId: "a", body: "Feedback" });
  assert.throws(() => kernel.resolve(thread.id, "a", "rejected"), /requires a reason/);
});

test("resolving with a new disposition clears an obsolete reason", () => {
  const { kernel } = setup();
  const thread = kernel.createThread({ context, anchor, actorId: "a", body: "Feedback" });
  const rejected = kernel.resolve(thread.id, "a", "rejected", "Expected behavior");
  assert.equal(rejected.dispositionReason, "Expected behavior");
  const accepted = kernel.resolve(thread.id, "a", "accepted");
  assert.equal(accepted.dispositionReason, undefined);
});

test("whitespace-only optional reasons are omitted from durable resolution history", () => {
  const { events, kernel } = setup();
  const thread = kernel.createThread({ context, anchor, actorId: "a", body: "Feedback" });
  const immediate = kernel.resolve(thread.id, "a", "accepted", "   ");
  assert.equal(immediate.dispositionReason, undefined);
  const resolution = events.read(context.reviewId).at(-1);
  assert.equal(Object.hasOwn(resolution?.payload ?? {}, "reason"), false);
  assert.deepEqual(kernel.getThread(thread.id, "a"), immediate);
});

test("invalid runtime dispositions cannot poison another review or restart", () => {
  const otherContext = { ...context, reviewId: "review-2" };
  const everyAction: ReviewAction[] = ["create_thread", "reply", "edit_own_message", "delete_own_message", "resolve_thread", "reopen_thread", "read_thread"];
  const authorizer = new StaticReviewAuthorizer([
    { actorId: "a", reviewId: context.reviewId, actions: everyAction },
    { actorId: "reviewer-2", reviewId: otherContext.reviewId, actions: everyAction },
  ]);
  const events = new InMemoryEventStore();
  let id = 0;
  const dependencies = { events, authorizer, now: () => "2026-08-30T00:00:00.000Z", id: () => `runtime-${++id}` };
  const kernel = new ReviewKernel(dependencies);
  const first = kernel.createThread({ context, anchor, actorId: "a", body: "First review" });
  const second = kernel.createThread({ context: otherContext, anchor, actorId: "reviewer-2", body: "Second review" });

  assert.throws(() => kernel.resolve(first.id, "a", "invalid" as never), /invalid disposition/);
  assert.equal(events.readAll().length, 2);

  const restarted = new ReviewKernel(dependencies);
  assert.equal(restarted.getThread(first.id, "a").disposition, undefined);
  assert.equal(restarted.getThread(second.id, "reviewer-2").messages[0]?.body, "Second review");
});

test("static authorization rejects duplicate actor and review grants", () => {
  assert.throws(
    () => new StaticReviewAuthorizer([
      { actorId: "a", reviewId: context.reviewId, actions: ["read_thread"] },
      { actorId: "a", reviewId: context.reviewId, actions: ["reply"] },
    ]),
    /duplicate authorization grant/,
  );
});

test("static authorization enforces optional thread-scoped grants", () => {
  const authorizer = new StaticReviewAuthorizer([
    { actorId: "scoped", reviewId: context.reviewId, threadId: "thread-1", actions: ["read_thread", "reply"] },
  ]);
  assert.doesNotThrow(() => authorizer.assertAllowed({ actorId: "scoped", reviewId: context.reviewId, threadId: "thread-1", action: "read_thread" }));
  assert.throws(() => authorizer.assertAllowed({ actorId: "scoped", reviewId: context.reviewId, threadId: "thread-2", action: "read_thread" }), /not authorized/);
  assert.throws(() => authorizer.assertAllowed({ actorId: "scoped", reviewId: context.reviewId, action: "read_thread" }), /not authorized/);
  assert.throws(() => new StaticReviewAuthorizer([{ actorId: "bad\u0000actor", reviewId: context.reviewId, actions: ["read_thread"] }]), /valid actor ids/);
});

test("agent export redacts actors and message text", () => {
  const { events, kernel } = setup();
  kernel.createThread({ context, anchor, actorId: "person@example.test", body: "secret-shaped synthetic text" });
  const output = exportNdjson(events.read(context.reviewId), { redactActor: () => "actor-1", redactText: () => "[redacted]" });
  assert.doesNotMatch(output, /person@example\.test|secret-shaped|Continue/);
  assert.match(output, /actor-1/);
  assert.match(output, /review-1|prototype-1|rev-abc|\/synthetic/);
});

test("agent export redacts unknown fields of every primitive type by default", () => {
  const events = new InMemoryEventStore();
  events.append({
    id: "event-1",
    reviewId: "review-1",
    type: "synthetic.event",
    occurredAt: "2026-08-30T00:00:00.000Z",
    actorId: "private-actor",
    payload: {
      id: "object-1",
      route: "/synthetic",
      type: "private note",
      token: "secret-token-value",
      commentBody: "private comment text",
      accountNumber: 123456789,
      isPrivate: true,
      nullablePrivateField: null,
      "customer-email@example.test": true,
      nested: { id: "private-nested-id", route: "/private-route", type: "private nested note", unexpected: "private extension text" },
    },
  });

  const output = exportNdjson(events.read("review-1"), { redactActor: () => "actor-1", redactText: () => "[redacted]" });
  assert.doesNotMatch(output, /private-actor|object-1|\/synthetic|private note|secret-token-value|private comment text|123456789|true|private-nested-id|\/private-route|private nested note|private extension text|customer-email/);
  const projectedPayload = JSON.parse(output.trim()).payload as Record<string, unknown>;
  assert.deepEqual(projectedPayload, {});
  assert.match(output, /review-1|synthetic\.event|actor-1/);
});

test("agent export preserves property and array path boundaries", () => {
  const events = new InMemoryEventStore();
  events.append({
    id: "event-1",
    reviewId: "review-1",
    type: "thread.created",
    occurredAt: "2026-08-30T00:00:00.000Z",
    actorId: "private-actor",
    payload: {
      "thread.messages.*.id": "private dotted-key value",
      thread: { messages: { "0": { id: "private numeric-key value" } } },
    },
  });

  const output = exportNdjson(events.read("review-1"), { redactActor: () => "actor-1", redactText: () => "[redacted]" });
  assert.doesNotMatch(output, /thread\.messages\.\*\.id|private dotted-key value|private numeric-key value|"0"/);
  assert.match(output, /actor-1|thread\.created/);
});

test("thread creation validates durable state before appending", () => {
  const { events, kernel } = setup();
  assert.throws(
    () => kernel.createThread({ context: { ...context, prototypeId: " " }, anchor, actorId: "a", body: "Feedback" }),
    /prototype id/,
  );
  assert.throws(
    () => kernel.createThread({
      context,
      anchor,
      capture: { id: "capture-1", digest: "sha256:not-a-digest", mediaType: "image/png", createdAt: "2026-08-30T00:00:00Z" },
      actorId: "a",
      body: "Feedback",
    }),
    /capture digest/,
  );
  assert.equal(events.readAll().length, 0);
  assert.doesNotThrow(() => setupWithEvents(events));
});

test("event store does not expose mutable stored payloads", () => {
  const events = new InMemoryEventStore();
  const appended = events.append({
    id: "event-1",
    reviewId: "review-1",
    type: "synthetic.event",
    occurredAt: "2026-08-30T00:00:00.000Z",
    actorId: "actor-1",
    payload: { nested: { value: "original" } },
  });

  (appended.payload as { nested: { value: string } }).nested.value = "mutated";

  assert.deepEqual(events.read("review-1")[0]?.payload, { nested: { value: "original" } });
});

test("event store rejects a stale expected event count before appending", () => {
  const events = new InMemoryEventStore();
  events.append({ id: "event-1", reviewId: "review-1", type: "synthetic.event", occurredAt: "2026-08-30T00:00:00Z", actorId: "actor-1", payload: {} }, 0);
  assert.throws(
    () => events.append({ id: "event-2", reviewId: "review-1", type: "synthetic.event", occurredAt: "2026-08-30T00:00:01Z", actorId: "actor-1", payload: {} }, 0),
    /history changed/,
  );
  assert.equal(events.readAll().length, 1);
});

test("kernel authorization fails closed before state changes", () => {
  const { events, kernel } = setup();

  assert.throws(
    () => kernel.createThread({ context, anchor, actorId: "ungranted", body: "Synthetic feedback" }),
    /not authorized/,
  );
  assert.equal(events.read(context.reviewId).length, 0);

  const thread = kernel.createThread({ context, anchor, actorId: "actor-private", body: "Synthetic feedback" });
  assert.throws(() => kernel.reply(thread.id, "ungranted", "Unauthorized reply"), /not authorized/);
  assert.equal(events.read(context.reviewId).length, 1);
});

test("kernel rejects an asynchronous authorizer before state changes", async () => {
  const events = new InMemoryEventStore();
  const authorizer = {
    async assertAllowed(): Promise<void> { throw new Error("synthetic asynchronous denial"); },
  } as unknown as ReviewAuthorizer;
  const kernel = new ReviewKernel({ events, authorizer, now: () => "2026-08-30T00:00:00.000Z", id: () => "unused" });

  assert.throws(
    () => kernel.createThread({ context, anchor, actorId: "actor-private", body: "Synthetic feedback" }),
    /must be synchronous/,
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(events.read(context.reviewId).length, 0);
});

test("kernel commits no state when an event append fails", () => {
  {
    const events = new ToggleEventStore();
    const { kernel } = setupWithEvents(events);
    events.rejecting = true;
    assert.throws(() => kernel.createThread({ context, anchor, actorId: "a", body: "Feedback" }), /append rejection/);
    assert.throws(() => kernel.getThread("id-2", "a"), /unknown thread/);
    assert.equal(events.read(context.reviewId).length, 0);
  }

  {
    const events = new ToggleEventStore();
    const { kernel } = setupWithEvents(events);
    const before = kernel.createThread({ context, anchor, actorId: "a", body: "Feedback" });
    events.rejecting = true;
    assert.throws(() => kernel.reply(before.id, "a", "Reply"), /append rejection/);
    assert.deepEqual(kernel.getThread(before.id, "a"), before);
  }

  {
    const events = new ToggleEventStore();
    const { kernel } = setupWithEvents(events);
    const before = kernel.createThread({ context, anchor, actorId: "a", body: "Feedback" });
    events.rejecting = true;
    assert.throws(() => kernel.editMessage(before.id, before.messages[0]!.id, "a", "Edited"), /append rejection/);
    assert.deepEqual(kernel.getThread(before.id, "a"), before);
  }

  {
    const events = new ToggleEventStore();
    const { kernel } = setupWithEvents(events);
    const before = kernel.createThread({ context, anchor, actorId: "a", body: "Feedback" });
    events.rejecting = true;
    assert.throws(() => kernel.deleteMessage(before.id, before.messages[0]!.id, "a"), /append rejection/);
    assert.deepEqual(kernel.getThread(before.id, "a"), before);
  }

  {
    const events = new ToggleEventStore();
    const { kernel } = setupWithEvents(events);
    const before = kernel.createThread({ context, anchor, actorId: "a", body: "Feedback" });
    events.rejecting = true;
    assert.throws(() => kernel.resolve(before.id, "a", "accepted"), /append rejection/);
    assert.deepEqual(kernel.getThread(before.id, "a"), before);
  }

  {
    const events = new ToggleEventStore();
    const { kernel } = setupWithEvents(events);
    const thread = kernel.createThread({ context, anchor, actorId: "a", body: "Feedback" });
    const before = kernel.resolve(thread.id, "a", "rejected", "Expected behavior");
    events.rejecting = true;
    assert.throws(() => kernel.reopen(before.id, "a"), /append rejection/);
    assert.deepEqual(kernel.getThread(before.id, "a"), before);
  }
});

test("file event store survives adapter replacement and rejects corrupt history", async () => {
  const directory = await mkdtemp(join(tmpdir(), "collab-review-events-"));
  const eventPath = join(directory, "events.ndjson");
  try {
    const first = new FileEventStore(eventPath);
    first.append({ id: "event-1", reviewId: "review-1", type: "synthetic.event", occurredAt: "2026-08-30T00:00:00Z", actorId: "actor-1", payload: { value: 1 } });
    assert.equal(new FileEventStore(eventPath).read("review-1")[0]?.id, "event-1");
    assert.throws(
      () => first.append({ id: "event-1", reviewId: "review-1", type: "synthetic.event", occurredAt: "2026-08-30T00:00:01Z", actorId: "actor-1", payload: {} }),
      /duplicate event id/,
    );

    await writeFile(eventPath, `${JSON.stringify({ id: "event-1", sequence: 2, reviewId: "review-1", type: "synthetic.event", occurredAt: "2026-08-30T00:00:00Z", actorId: "actor-1", payload: {} })}\n`, { mode: 0o600 });
    assert.throws(() => new FileEventStore(eventPath).read("review-1"), /sequence conflict/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("file event store isolates review and actor storage quotas", async () => {
  const directory = await mkdtemp(join(tmpdir(), "collab-review-event-quotas-"));
  const event = (id: string, reviewId: string, actorId: string) => ({ id, reviewId, type: "synthetic.event", occurredAt: "2026-08-30T00:00:00Z", actorId, payload: { body: "x".repeat(256) } });
  try {
    const byReview = new FileEventStore(join(directory, "review.ndjson"), 4096, { maxEventBytes: 512, maxReviewBytes: 650, maxActorBytes: 4096 });
    byReview.append(event("review-1-a", "review-1", "actor-1"));
    assert.throws(() => byReview.append(event("review-1-b", "review-1", "actor-2")), /review exceeds event storage quota/);
    assert.doesNotThrow(() => byReview.append(event("review-2-a", "review-2", "actor-2")));

    const byActor = new FileEventStore(join(directory, "actor.ndjson"), 4096, { maxEventBytes: 512, maxReviewBytes: 4096, maxActorBytes: 650 });
    byActor.append(event("actor-1-a", "review-1", "actor-1"));
    assert.throws(() => byActor.append(event("actor-1-b", "review-2", "actor-1")), /actor exceeds event storage quota/);
    assert.doesNotThrow(() => byActor.append(event("actor-2-a", "review-2", "actor-2")));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("kernel rehydrates durable thread state and remains mutable after restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "collab-review-kernel-restart-"));
  const eventPath = join(directory, "events.ndjson");
  const actions: ReviewAction[] = ["create_thread", "reply", "edit_own_message", "delete_own_message", "resolve_thread", "reopen_thread", "read_thread"];
  const authorizer = new StaticReviewAuthorizer([{ actorId: "a", reviewId: context.reviewId, actions }]);
  try {
    let firstId = 0;
    const first = new ReviewKernel({ events: new FileEventStore(eventPath), authorizer, now: () => "2026-08-30T00:00:00.000Z", id: () => `first-${++firstId}` });
    let expected = first.createThread({ context, anchor, actorId: "a", body: "Persisted feedback" });
    expected = first.reply(expected.id, "a", "Persisted reply");
    expected = first.editMessage(expected.id, expected.messages[0]!.id, "a", "Persisted edit");
    expected = first.resolve(expected.id, "a", "rejected", "Persisted reason");

    let restartedId = 0;
    const restarted = new ReviewKernel({ events: new FileEventStore(eventPath), authorizer, now: () => "2026-08-31T00:00:00.000Z", id: () => `restart-${++restartedId}` });
    assert.deepEqual(restarted.getThread(expected.id, "a"), expected);
    const reopened = restarted.reopen(expected.id, "a");

    const reloaded = new ReviewKernel({ events: new FileEventStore(eventPath), authorizer, now: () => "2026-09-01T00:00:00.000Z", id: () => "unused" });
    assert.deepEqual(reloaded.getThread(expected.id, "a"), reopened);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("kernels sharing an event store refresh before reads and mutations", () => {
  const events = new InMemoryEventStore();
  const { kernel: first } = setupWithEvents(events);
  let secondId = 0;
  const everyAction: ReviewAction[] = ["create_thread", "reply", "edit_own_message", "delete_own_message", "resolve_thread", "reopen_thread", "read_thread"];
  const second = new ReviewKernel({
    events,
    authorizer: new StaticReviewAuthorizer([{ actorId: "a", reviewId: context.reviewId, actions: everyAction }]),
    now: () => "2026-08-30T00:00:01.000Z",
    id: () => `second-${++secondId}`,
  });

  const created = first.createThread({ context, anchor, actorId: "a", body: "Initial feedback" });
  second.reply(created.id, "a", "Reply from second kernel");
  first.reply(created.id, "a", "Reply from first kernel");

  const expectedBodies = ["Initial feedback", "Reply from second kernel", "Reply from first kernel"];
  assert.deepEqual(first.getThread(created.id, "a").messages.map((message) => message.body), expectedBodies);
  assert.deepEqual(second.getThread(created.id, "a").messages.map((message) => message.body), expectedBodies);
});

test("kernel ignores extension events but rejects malformed known history", () => {
  const authorizer = new StaticReviewAuthorizer([]);
  const extensions = new InMemoryEventStore();
  extensions.append({ id: "extension-1", reviewId: "review-1", type: "extension.recorded", occurredAt: "2026-08-30T00:00:00Z", actorId: "actor-1", payload: { value: "synthetic" } });
  assert.doesNotThrow(() => new ReviewKernel({ events: extensions, authorizer, now: () => "2026-08-30T00:00:00Z", id: () => "unused" }));

  const malformed = new InMemoryEventStore();
  malformed.append({ id: "known-1", reviewId: "review-1", type: "thread.created", occurredAt: "2026-08-30T00:00:00Z", actorId: "actor-1", payload: { thread: { id: "missing-required-state" } } });
  assert.throws(
    () => new ReviewKernel({ events: malformed, authorizer, now: () => "2026-08-30T00:00:00Z", id: () => "unused" }),
    /event history/,
  );
});

test("file event store creates and hardens each missing directory ancestor", async () => {
  const root = await mkdtemp(join(tmpdir(), "collab-review-event-ancestors-"));
  const first = join(root, "first");
  const second = join(first, "second");
  const eventPath = join(second, "events.ndjson");
  try {
    const store = new FileEventStore(eventPath);
    store.append({ id: "event-1", reviewId: "review-1", type: "synthetic.event", occurredAt: "2026-08-30T00:00:00Z", actorId: "actor-1", payload: {} });
    assert.equal(store.read("review-1")[0]?.id, "event-1");
    assert.equal((await stat(first)).mode & 0o777, 0o700);
    assert.equal((await stat(second)).mode & 0o777, 0o700);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("file event store readers never inspect a cross-process partial append", async () => {
  const directory = await mkdtemp(join(tmpdir(), "collab-review-concurrent-events-"));
  const eventPath = join(directory, "events.ndjson");
  let child: ChildProcess | undefined;
  try {
    const childScript = `
      const { constants, closeSync, fsyncSync, openSync, unlinkSync, writeSync } = require("node:fs");
      const path = process.argv[1];
      const lockPath = path + ".lock";
      const event = { id: "event-1", sequence: 1, reviewId: "review-1", type: "synthetic.event", occurredAt: "2026-08-30T00:00:00Z", actorId: "actor-1", payload: {} };
      const line = JSON.stringify(event) + "\\n";
      const split = Math.floor(line.length / 2);
      const lock = openSync(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      const file = openSync(path, constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      writeSync(file, line.slice(0, split));
      process.send("partial");
      process.once("message", () => {
        writeSync(file, line.slice(split));
        fsyncSync(file);
        closeSync(file);
        closeSync(lock);
        unlinkSync(lockPath);
        process.exit(0);
      });
    `;
    child = spawn(process.execPath, ["-e", childScript, eventPath], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
    await once(child, "message");
    assert.throws(() => new FileEventStore(eventPath).read("review-1"), /event store is locked/);
    child.send("finish");
    const [code] = await once(child, "exit");
    assert.equal(code, 0);
    child = undefined;
    assert.equal(new FileEventStore(eventPath).read("review-1")[0]?.id, "event-1");
  } finally {
    if (child && !child.killed) child.kill();
    await rm(directory, { recursive: true, force: true });
  }
});

test("file event store repairs broad permissions on its directory and existing data file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "collab-review-event-mode-"));
  const eventPath = join(directory, "events.ndjson");
  try {
    const event = { id: "event-1", sequence: 1, reviewId: "review-1", type: "synthetic.event", occurredAt: "2026-08-30T00:00:00Z", actorId: "actor-1", payload: {} };
    await writeFile(eventPath, `${JSON.stringify(event)}\n`, { mode: 0o644 });
    await chmod(directory, 0o755);
    await chmod(eventPath, 0o644);
    assert.equal(new FileEventStore(eventPath).read("review-1")[0]?.id, "event-1");
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal((await stat(eventPath)).mode & 0o777, 0o600);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
