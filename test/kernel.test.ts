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
  assert.doesNotMatch(output, /person@example\.test|secret-shaped/);
  assert.match(output, /actor-1/);
});
