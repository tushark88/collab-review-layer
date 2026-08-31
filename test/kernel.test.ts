import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { StaticReviewAuthorizer, type ReviewAction } from "../src/auth.ts";
import type { DomainEvent } from "../src/domain.ts";
import { FileEventStore, InMemoryEventStore, ReviewKernel, type EventStore } from "../src/kernel.ts";
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

  append(event: Omit<DomainEvent, "sequence">): DomainEvent {
    if (this.rejecting) throw new Error("synthetic append rejection");
    return this.delegate.append(event);
  }

  read(reviewId: string): readonly DomainEvent[] {
    return this.delegate.read(reviewId);
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

test("agent export redacts unknown string fields by default", () => {
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
      nested: { id: "private-nested-id", route: "/private-route", type: "private nested note", unexpected: "private extension text" },
    },
  });

  const output = exportNdjson(events.read("review-1"), { redactActor: () => "actor-1", redactText: () => "[redacted]" });
  assert.doesNotMatch(output, /private-actor|object-1|\/synthetic|private note|secret-token-value|private comment text|private-nested-id|\/private-route|private nested note|private extension text/);
  assert.match(output, /review-1|synthetic\.event|\[redacted\]/);
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
