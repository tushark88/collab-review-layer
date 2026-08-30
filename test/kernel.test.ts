import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryEventStore, ReviewKernel } from "../src/kernel.ts";
import { exportNdjson } from "../src/export.ts";

const context = { reviewId: "review-1", prototypeId: "prototype-1", revisionId: "rev-abc", viewportId: "mobile", variantId: "control", route: "/synthetic" };
const anchor = { schemaVersion: 1 as const, geometry: { xRatio: 0.25, yRatio: 0.5 }, scroll: { xRatio: 0, yRatio: 0.4 }, semantic: { role: "button", accessibleName: "Continue" } };

function setup() {
  let id = 0;
  const events = new InMemoryEventStore();
  const kernel = new ReviewKernel({ events, now: () => "2026-08-30T00:00:00.000Z", id: () => `id-${++id}` });
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
