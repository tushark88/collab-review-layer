import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { StaticReviewAuthorizer, type ReviewAction } from "../src/auth.ts";
import { FileEventStore, InMemoryEventStore, ReviewKernel } from "../src/kernel.ts";
import { exportNdjson } from "../src/export.ts";

const context = { reviewId: "review-1", prototypeId: "prototype-1", revisionId: "rev-abc", viewportId: "mobile", variantId: "control", route: "/synthetic" };
const anchor = { schemaVersion: 1 as const, geometry: { xRatio: 0.25, yRatio: 0.5 }, scroll: { xRatio: 0, yRatio: 0.4 }, semantic: { role: "button", accessibleName: "Continue" } };

function setup() {
  let id = 0;
  const events = new InMemoryEventStore();
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
      token: "secret-token-value",
      commentBody: "private comment text",
      nested: { unexpected: "private extension text" },
    },
  });

  const output = exportNdjson(events.read("review-1"), { redactActor: () => "actor-1", redactText: () => "[redacted]" });
  assert.doesNotMatch(output, /private-actor|secret-token-value|private comment text|private extension text/);
  assert.match(output, /object-1|\/synthetic|\[redacted\]/);
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
