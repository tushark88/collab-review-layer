import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { StaticReviewAuthorizer, type ReviewAction, type ReviewAuthorizer } from "../src/auth.ts";
import type { Anchor, DomainEvent } from "../src/domain.ts";
import { FileEventStore, InMemoryEventStore, MAX_MESSAGE_BODY_BYTES, ReviewKernel, type EventStore } from "../src/kernel.ts";
import { exportNdjson } from "../src/export.ts";

const context = { reviewId: "review-1", prototypeId: "prototype-1", revisionId: "rev-abc", viewportId: "mobile", variantId: "control", route: "/synthetic" };
const legacyAnchor = { schemaVersion: 1 as const, geometry: { xRatio: 0.25, yRatio: 0.5 }, scroll: { xRatio: 0, yRatio: 0.4 }, semantic: { role: "button", accessibleName: "Continue" } };
const anchor = {
  schemaVersion: 2 as const,
  locationAvailability: "available" as const,
  recoveryState: "not_required" as const,
  context: { ...context, deviceId: "device-mobile", surfaceId: "surface-primary" },
  element: {
    selector: "[data-review-target='synthetic-action']",
    identity: "synthetic-action",
    offset: { x: 24, y: 18 },
  },
  document: { x: 184, y: 612, width: 1_280, height: 2_400 },
  semantic: { role: "button", accessibleName: "Continue" },
  text: { exact: "Continue", prefix: "Review", suffix: "Summary" },
};

function setupWithEvents(events: EventStore) {
  let id = 0;
  const everyAction: ReviewAction[] = ["create_thread", "reply", "edit_own_message", "delete_own_message", "resolve_thread", "reopen_thread", "replace_anchor", "report_anchor_unavailable", "read_thread"];
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

class FsyncFaultFileEventStore extends FileEventStore {
  syncCalls = 0;
  readonly failRollbackSync: boolean;

  constructor(path: string, failRollbackSync = false) {
    super(path);
    this.failRollbackSync = failRollbackSync;
  }

  protected override syncEventFile(descriptor: number): void {
    this.syncCalls += 1;
    if (this.syncCalls === 1 || (this.failRollbackSync && this.syncCalls === 2)) throw new Error("synthetic event fsync failure");
    super.syncEventFile(descriptor);
  }
}

class LockDirectoryFaultFileEventStore extends FileEventStore {
  protected override syncLockDirectory(): void {
    throw new Error("synthetic lock directory sync failure");
  }
}

class LockReleaseFaultFileEventStore extends FileEventStore {
  syncCalls = 0;

  protected override syncLockDirectory(path: string): void {
    this.syncCalls += 1;
    if (this.syncCalls === 2) throw new Error("synthetic lock release sync failure");
    super.syncLockDirectory(path);
  }
}

class LockCloseFaultFileEventStore extends FileEventStore {
  protected override closeLockFile(): void {
    throw new Error("synthetic lock close failure");
  }
}

class LockUnlinkFaultFileEventStore extends FileEventStore {
  protected override unlinkLockFile(): void {
    throw new Error("synthetic lock unlink failure");
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

test("thread creation rejects stale anchors and accepts a complete current anchor", () => {
  const { events, kernel } = setup();

  assert.throws(
    () => kernel.createThread({ context, anchor: legacyAnchor, actorId: "a", body: "Stale location" }),
    (error: unknown) => error instanceof Error
      && "code" in error && error.code === "stale_anchor"
      && "status" in error && error.status === 409,
  );
  assert.throws(
    () => kernel.createThread({
      context,
      anchor: { ...anchor, context: { ...anchor.context, deviceId: "x".repeat(257) } },
      actorId: "a",
      body: "Oversized identity",
    }),
    (error: unknown) => error instanceof Error && "status" in error && error.status === 422,
  );
  assert.throws(
    () => kernel.createThread({
      context,
      anchor: { ...anchor, element: { ...anchor.element, selector: "[data-review-target]\nbutton" } },
      actorId: "a",
      body: "Invalid selector",
    }),
    (error: unknown) => error instanceof Error && "status" in error && error.status === 422,
  );
  assert.throws(
    () => kernel.createThread({
      context: { ...context, route: "https://prototype.example.test/escape" },
      anchor: { ...anchor, context: { ...anchor.context, route: "https://prototype.example.test/escape" } },
      actorId: "a",
      body: "Invalid route",
    }),
    (error: unknown) => error instanceof Error && "status" in error && error.status === 422,
  );
  assert.equal(events.readAll().length, 0);

  assert.throws(
    () => kernel.createThread({
      context,
      anchor: { ...anchor, element: undefined } as unknown as Anchor,
      actorId: "a",
      body: "Incomplete location",
    }),
    (error: unknown) => error instanceof Error
      && "code" in error && error.code === "invalid_anchor"
      && "status" in error && error.status === 422,
  );
  assert.throws(
    () => kernel.createThread({
      context,
      anchor: { ...anchor, context: { ...anchor.context, revisionId: "different-revision" } },
      actorId: "a",
      body: "Mismatched location",
    }),
    (error: unknown) => error instanceof Error
      && "code" in error && error.code === "invalid_anchor"
      && "status" in error && error.status === 422,
  );
  assert.equal(events.readAll().length, 0);

  const thread = kernel.createThread({ context, anchor, actorId: "a", body: "Current location" });
  assert.deepEqual(thread.anchor, anchor);
  assert.deepEqual((events.readAll()[0]?.payload as { thread: { anchor: unknown } }).thread.anchor, anchor);
});

test("the thread owner can replace its anchor without replacing its discussion or history", () => {
  const { events, kernel } = setup();
  const created = kernel.createThread({ context, anchor, actorId: "a", body: "Current location" });
  kernel.reply(created.id, "reviewer-2", "Preserved reply");
  const before = kernel.resolve(created.id, "reviewer-2", "accepted");
  const replacement = {
    ...anchor,
    element: { ...anchor.element, offset: { x: 32, y: 28 } },
    document: { ...anchor.document, x: 420, y: 900, height: 2_800 },
  };

  const replaced = kernel.replaceAnchor(created.id, "a", replacement);

  assert.deepEqual(replaced, { ...before, anchor: replacement, anchorGeneration: 2 });
  assert.deepEqual(events.read(context.reviewId).map((event) => event.type), [
    "thread.created",
    "message.created",
    "thread.resolved",
    "anchor.replaced",
  ]);

  const everyAction: ReviewAction[] = [
    "create_thread",
    "reply",
    "edit_own_message",
    "delete_own_message",
    "resolve_thread",
    "reopen_thread",
    "read_thread",
    "replace_anchor",
  ];
  const restarted = new ReviewKernel({
    events,
    authorizer: new StaticReviewAuthorizer([{ actorId: "a", reviewId: context.reviewId, actions: everyAction }]),
    now: () => { throw new Error("restart read must not need a clock"); },
    id: () => { throw new Error("restart read must not need an id"); },
  });
  assert.deepEqual(restarted.getThread(created.id, "a"), replaced);

  const exportedReplacement = JSON.parse(exportNdjson(events.read(context.reviewId), {
    redactActor: () => "actor-1",
    redactText: () => "[redacted]",
  }).trim().split("\n").at(-1)!) as { payload: { anchor: Record<string, unknown> } };
  assert.deepEqual(exportedReplacement.payload.anchor, {
    schemaVersion: 2,
    locationAvailability: "available",
    recoveryState: "not_required",
    context: anchor.context,
    element: { selector: "[redacted]", identity: "[redacted]", offset: replacement.element.offset },
    document: replacement.document,
    semantic: { role: "[redacted]", accessibleName: "[redacted]" },
    text: { exact: "[redacted]", prefix: "[redacted]", suffix: "[redacted]" },
  });
});

test("anchor replacement preserves trusted device and surface identity", () => {
  const { events, kernel } = setup();
  const created = kernel.createThread({ context, anchor, actorId: "a", body: "Current location" });

  for (const replacementContext of [
    { ...anchor.context, deviceId: "different-device" },
    { ...anchor.context, surfaceId: "different-surface" },
  ]) {
    assert.throws(
      () => kernel.replaceAnchor(created.id, "a", { ...anchor, context: replacementContext }),
      (error: unknown) => error instanceof Error
        && error.name === "AnchorContractError"
        && (error as { status?: number }).status === 422,
    );
  }
  assert.equal(events.read(context.reviewId).length, 1);
  assert.deepEqual(kernel.getThread(created.id, "a"), created);

  const orphaned = kernel.reportAnchorUnavailable(created.id, "reviewer-2", created.anchorGeneration);
  assert.throws(
    () => kernel.replaceAnchor(created.id, "a", {
      ...anchor,
      context: { ...anchor.context, surfaceId: "different-surface" },
    }),
    (error: unknown) => error instanceof Error
      && error.name === "AnchorContractError"
      && (error as { status?: number }).status === 422,
  );
  assert.equal(events.read(context.reviewId).length, 2);
  assert.deepEqual(kernel.getThread(created.id, "a"), orphaned);
});

test("anchor replacement requires thread ownership even when the actor is authorized", () => {
  const { events, kernel } = setup();
  const before = kernel.createThread({ context, anchor, actorId: "a", body: "Current location" });
  const replacement = { ...anchor, element: { ...anchor.element, offset: { x: 30, y: 20 } } };

  assert.throws(() => kernel.replaceAnchor(before.id, "reviewer-2", replacement), /only the thread owner/);
  assert.equal(events.read(context.reviewId).length, 1);
  assert.deepEqual(kernel.getThread(before.id, "a"), before);
});

test("anchor replacement requires an explicit authorization grant", () => {
  const events = new InMemoryEventStore();
  let id = 0;
  const kernel = new ReviewKernel({
    events,
    authorizer: new StaticReviewAuthorizer([{
      actorId: "a",
      reviewId: context.reviewId,
      actions: ["create_thread", "read_thread"],
    }]),
    now: () => "2026-08-30T00:00:00.000Z",
    id: () => `restricted-${++id}`,
  });
  const before = kernel.createThread({ context, anchor, actorId: "a", body: "Current location" });

  assert.throws(() => kernel.replaceAnchor(before.id, "a", anchor), /not authorized/);
  assert.throws(() => kernel.reportAnchorUnavailable(before.id, "a", before.anchorGeneration), /not authorized/);
  assert.equal(events.read(context.reviewId).length, 1);
  assert.deepEqual(kernel.getThread(before.id, "a"), before);
});

test("an authorized orphan report is durable and preserves the Thread until owner replacement", () => {
  const { events, kernel } = setup();
  const created = kernel.createThread({ context, anchor, actorId: "a", body: "Current location" });
  kernel.reply(created.id, "reviewer-2", "Preserved reply");
  const before = kernel.resolve(created.id, "reviewer-2", "accepted");
  const orphaned = kernel.reportAnchorUnavailable(created.id, "reviewer-2", created.anchorGeneration);

  assert.deepEqual(orphaned, {
    ...before,
    anchor: {
      schemaVersion: 2,
      locationAvailability: "unavailable",
      recoveryState: "orphaned_replacement_required",
      context: anchor.context,
    },
  });
  assert.deepEqual(events.read(context.reviewId).map((event) => event.type), [
    "thread.created",
    "message.created",
    "thread.resolved",
    "anchor.orphaned",
  ]);

  const restarted = setupWithEvents(events).kernel;
  assert.deepEqual(restarted.getThread(created.id, "a"), orphaned);

  const projected = JSON.parse(exportNdjson(events.read(context.reviewId), {
    redactActor: () => "actor-1",
    redactText: () => "[redacted]",
  }).trim().split("\n").at(-1)!) as { payload: Record<string, unknown> };
  assert.deepEqual(projected.payload, {
    threadId: created.id,
    anchorGeneration: created.anchorGeneration,
    anchor: {
      schemaVersion: 2,
      locationAvailability: "unavailable",
      recoveryState: "orphaned_replacement_required",
      context: anchor.context,
    },
  });

  const replaced = restarted.replaceAnchor(created.id, "a", anchor);
  assert.deepEqual(replaced, { ...orphaned, anchor, anchorGeneration: 2 });
});

test("a delayed orphan report cannot invalidate a newer Anchor generation", () => {
  const { events, kernel } = setup();
  const created = kernel.createThread({ context, anchor, actorId: "a", body: "Current location" });
  const replacement = {
    ...anchor,
    element: { ...anchor.element, offset: { x: 42, y: 24 } },
  };
  const replaced = kernel.replaceAnchor(created.id, "a", replacement);

  assert.equal(created.anchorGeneration, 1);
  assert.equal(replaced.anchorGeneration, 2);
  assert.throws(
    () => kernel.reportAnchorUnavailable(created.id, "reviewer-2", created.anchorGeneration),
    (error: unknown) => error instanceof Error
      && "code" in error && error.code === "stale_anchor"
      && "status" in error && error.status === 409,
  );
  assert.deepEqual(kernel.getThread(created.id, "a"), replaced);
  assert.deepEqual(events.read(context.reviewId).map((event) => event.type), ["thread.created", "anchor.replaced"]);
});

test("replay rejects an orphan report that rewrites retained device or surface identity", () => {
  const { events, kernel } = setup();
  const created = kernel.createThread({ context, anchor, actorId: "a", body: "Current location" });
  events.append({
    id: "mismatched-orphan-context-event",
    reviewId: context.reviewId,
    type: "anchor.orphaned",
    occurredAt: "2026-08-30T00:00:00.000Z",
    actorId: "reviewer-2",
    payload: {
      threadId: created.id,
      anchorGeneration: created.anchorGeneration,
      anchor: {
        schemaVersion: 2,
        locationAvailability: "unavailable",
        recoveryState: "orphaned_replacement_required",
        context: { ...anchor.context, deviceId: "different-device" },
      },
    },
  });

  assert.throws(
    () => kernel.getThread(created.id, "a"),
    /orphaned anchor deviceId does not match previous anchor context/,
  );
});

test("replay rejects an anchor replacement that rewrites retained device or surface identity", () => {
  const { events, kernel } = setup();
  const created = kernel.createThread({ context, anchor, actorId: "a", body: "Current location" });
  events.append({
    id: "mismatched-replacement-context-event",
    reviewId: context.reviewId,
    type: "anchor.replaced",
    occurredAt: "2026-08-30T00:00:00.000Z",
    actorId: "a",
    payload: {
      threadId: created.id,
      anchorGeneration: 2,
      anchor: { ...anchor, context: { ...anchor.context, surfaceId: "different-surface" } },
    },
  });

  assert.throws(
    () => kernel.getThread(created.id, "a"),
    /replacement anchor surfaceId does not match previous anchor context/,
  );
});

test("thread creation rejects generated IDs outside the bridge identity contract", () => {
  const events = new InMemoryEventStore();
  const generated = ["message-1", "x".repeat(257)];
  const kernel = new ReviewKernel({
    events,
    authorizer: new StaticReviewAuthorizer([{ actorId: "a", reviewId: context.reviewId, actions: ["create_thread"] }]),
    now: () => "2026-08-30T00:00:00.000Z",
    id: () => generated.shift()!,
  });

  assert.throws(
    () => kernel.createThread({ context, anchor, actorId: "a", body: "Current location" }),
    /invalid thread id/,
  );
  assert.equal(events.readAll().length, 0);
});

test("replay rejects a created current Anchor whose context differs from its Thread", () => {
  const events = new InMemoryEventStore();
  events.append({
    id: "mismatched-anchor-event",
    reviewId: context.reviewId,
    type: "thread.created",
    occurredAt: "2026-08-29T00:00:00.000Z",
    actorId: "a",
    payload: {
      thread: {
        id: "mismatched-anchor-thread",
        context,
        anchor: { ...anchor, context: { ...anchor.context, revisionId: "different-revision" } },
        messages: [{ id: "mismatched-anchor-message", authorId: "a", body: "Invalid location", createdAt: "2026-08-29T00:00:00.000Z" }],
      },
    },
  });

  assert.throws(() => setupWithEvents(events), /anchor revisionId does not match thread context/);
});

test("replay rejects Anchor generations that contradict append order", () => {
  const createdAt = "2026-08-29T00:00:00.000Z";
  const invalidCreation = new InMemoryEventStore();
  invalidCreation.append({
    id: "invalid-generation-create-event",
    reviewId: context.reviewId,
    type: "thread.created",
    occurredAt: createdAt,
    actorId: "a",
    payload: {
      thread: {
        id: "invalid-generation-thread",
        context,
        anchor,
        anchorGeneration: 2,
        messages: [{ id: "invalid-generation-message", authorId: "a", body: "Invalid generation", createdAt }],
      },
    },
  });
  assert.throws(() => setupWithEvents(invalidCreation), /created anchor generation does not match event order/);

  const { events, kernel } = setup();
  const created = kernel.createThread({ context, anchor, actorId: "a", body: "Current location" });
  events.append({
    id: "invalid-generation-replace-event",
    reviewId: context.reviewId,
    type: "anchor.replaced",
    occurredAt: createdAt,
    actorId: "a",
    payload: { threadId: created.id, anchorGeneration: 4, anchor },
  });
  assert.throws(() => kernel.getThread(created.id, "a"), /replacement anchor generation does not match event order/);

  const missingReplacement = setup();
  const missingReplacementThread = missingReplacement.kernel.createThread({ context, anchor, actorId: "a", body: "Current location" });
  missingReplacement.events.append({
    id: "missing-generation-replace-event",
    reviewId: context.reviewId,
    type: "anchor.replaced",
    occurredAt: createdAt,
    actorId: "a",
    payload: { threadId: missingReplacementThread.id, anchor },
  });
  assert.throws(
    () => missingReplacement.kernel.getThread(missingReplacementThread.id, "a"),
    /invalid replacement anchor generation/,
  );

  const missingOrphan = setup();
  const missingOrphanThread = missingOrphan.kernel.createThread({ context, anchor, actorId: "a", body: "Current location" });
  const latest = missingOrphan.kernel.replaceAnchor(missingOrphanThread.id, "a", anchor);
  missingOrphan.events.append({
    id: "missing-generation-orphan-event",
    reviewId: context.reviewId,
    type: "anchor.orphaned",
    occurredAt: createdAt,
    actorId: "reviewer-2",
    payload: {
      threadId: latest.id,
      anchor: {
        schemaVersion: 2,
        locationAvailability: "unavailable",
        recoveryState: "orphaned_replacement_required",
        context: anchor.context,
      },
    },
  });
  assert.throws(
    () => missingOrphan.kernel.getThread(latest.id, "a"),
    /invalid orphaned anchor generation/,
  );
});

test("legacy event history keeps readable Thread IDs outside the new-write identifier limit", () => {
  const events = new InMemoryEventStore();
  const legacyThreadId = "legacy-" + "x".repeat(300);
  events.append({
    id: "legacy-long-thread-event",
    reviewId: context.reviewId,
    type: "thread.created",
    occurredAt: "2026-08-29T00:00:00.000Z",
    actorId: "a",
    payload: {
      thread: {
        id: legacyThreadId,
        context,
        anchor: legacyAnchor,
        messages: [{ id: "legacy-long-thread-message", authorId: "a", body: "Legacy location", createdAt: "2026-08-29T00:00:00.000Z" }],
      },
    },
  });

  const { kernel } = setupWithEvents(events);
  assert.equal(kernel.getThread(legacyThreadId, "a").id, legacyThreadId);
});

test("legacy Anchors with pre-bound Review Context identifiers remain recoverable and replayable", () => {
  const events = new InMemoryEventStore();
  const legacyContext = { ...context, prototypeId: "legacy-prototype-" + "x".repeat(300) };
  const legacyReplacement = {
    ...anchor,
    context: { ...anchor.context, ...legacyContext },
  };
  events.append({
    id: "legacy-long-context-event",
    reviewId: legacyContext.reviewId,
    type: "thread.created",
    occurredAt: "2026-08-29T00:00:00.000Z",
    actorId: "a",
    payload: {
      thread: {
        id: "legacy-long-context-thread",
        context: legacyContext,
        anchor: legacyAnchor,
        messages: [{ id: "legacy-long-context-message", authorId: "a", body: "Legacy location", createdAt: "2026-08-29T00:00:00.000Z" }],
      },
    },
  });

  const first = setupWithEvents(events).kernel;
  assert.throws(
    () => first.replaceAnchor("legacy-long-context-thread", "a", {
      ...legacyReplacement,
      context: { ...legacyReplacement.context, prototypeId: legacyReplacement.context.prototypeId + "-changed" },
    }),
    (error: unknown) => error instanceof Error
      && error.name === "AnchorContractError"
      && (error as { status?: number }).status === 422,
  );
  assert.equal(events.read(legacyContext.reviewId).length, 1);
  const replaced = first.replaceAnchor("legacy-long-context-thread", "a", legacyReplacement);
  assert.equal(replaced.anchorGeneration, 2);
  assert.deepEqual(replaced.anchor, legacyReplacement);

  const restarted = setupWithEvents(events).kernel;
  assert.deepEqual(restarted.getThread(replaced.id, "a"), replaced);
  const orphaned = first.reportAnchorUnavailable(replaced.id, "reviewer-2", replaced.anchorGeneration);
  assert.equal(orphaned.anchor.locationAvailability, "unavailable");
  assert.deepEqual(setupWithEvents(events).kernel.getThread(replaced.id, "a"), orphaned);
});

test("pre-generation schema-v2 history becomes unavailable and recoverable without trusting pre-limit placement", () => {
  const events = new InMemoryEventStore();
  const preLimitAnchor = {
    ...anchor,
    context: { ...anchor.context, deviceId: "legacy-device-" + "x".repeat(300) },
    element: { ...anchor.element, selector: "[data-review-target]\nbutton" },
  };
  events.append({
    id: "pre-generation-current-event",
    reviewId: context.reviewId,
    type: "thread.created",
    occurredAt: "2026-08-29T00:00:00.000Z",
    actorId: "a",
    payload: {
      thread: {
        id: "pre-generation-current-thread",
        context,
        anchor: preLimitAnchor,
        messages: [{ id: "pre-generation-current-message", authorId: "a", body: "Current location", createdAt: "2026-08-29T00:00:00.000Z" }],
      },
    },
  });

  const { kernel } = setupWithEvents(events);
  const before = kernel.getThread("pre-generation-current-thread", "a");
  assert.equal(before.anchorGeneration, 1);
  assert.deepEqual(before.anchor, {
    schemaVersion: 2,
    locationAvailability: "unavailable",
    recoveryState: "legacy_replacement_required",
    context: preLimitAnchor.context,
  });
  const projected = JSON.parse(exportNdjson(events.read(context.reviewId), {
    redactActor: () => "actor-1",
    redactText: () => "[redacted]",
  }).trim()) as { payload: { thread: { anchor: unknown; anchorGeneration?: number } } };
  assert.equal(projected.payload.thread.anchorGeneration, 1);
  assert.deepEqual(projected.payload.thread.anchor, {
    schemaVersion: 2,
    locationAvailability: "unavailable",
    recoveryState: "legacy_replacement_required",
    context: preLimitAnchor.context,
  });

  const replaced = kernel.replaceAnchor(before.id, "a", anchor);
  assert.equal(replaced.anchorGeneration, 2);
  assert.deepEqual(replaced.anchor, anchor);
  assert.deepEqual(setupWithEvents(events).kernel.getThread(before.id, "a"), replaced);
  assert.deepEqual(
    ((events.read(context.reviewId)[0]?.payload as { thread: { anchor: unknown } }).thread.anchor),
    preLimitAnchor,
  );
});

test("pre-generation schema-v2 recovery preserves device and surface identity that meets the current contract", () => {
  const events = new InMemoryEventStore();
  events.append({
    id: "pre-generation-valid-context-event",
    reviewId: context.reviewId,
    type: "thread.created",
    occurredAt: "2026-08-29T00:00:00.000Z",
    actorId: "a",
    payload: {
      thread: {
        id: "pre-generation-valid-context-thread",
        context,
        anchor,
        messages: [{ id: "pre-generation-valid-context-message", authorId: "a", body: "Historical location", createdAt: "2026-08-29T00:00:00.000Z" }],
      },
    },
  });

  const { kernel } = setupWithEvents(events);
  const before = kernel.getThread("pre-generation-valid-context-thread", "a");
  assert.equal(before.anchor.locationAvailability, "unavailable");
  assert.throws(
    () => kernel.replaceAnchor(before.id, "a", {
      ...anchor,
      context: { ...anchor.context, deviceId: "different-device" },
    }),
    (error: unknown) => error instanceof Error
      && error.name === "AnchorContractError"
      && (error as { status?: number }).status === 422,
  );
  assert.equal(events.read(context.reviewId).length, 1);
  assert.deepEqual(kernel.getThread(before.id, "a"), before);
});

test("legacy anchors are location unavailable in reads and agent exports", () => {
  const events = new InMemoryEventStore();
  events.append({
    id: "legacy-anchor-event",
    reviewId: context.reviewId,
    type: "thread.created",
    occurredAt: "2026-08-29T00:00:00.000Z",
    actorId: "a",
    payload: {
      thread: {
        id: "legacy-anchor-thread",
        context,
        anchor: legacyAnchor,
        messages: [{ id: "legacy-anchor-message", authorId: "a", body: "Legacy location", createdAt: "2026-08-29T00:00:00.000Z" }],
      },
    },
  });
  const { kernel } = setupWithEvents(events);

  assert.deepEqual(kernel.getThread("legacy-anchor-thread", "a").anchor, {
    schemaVersion: 1,
    locationAvailability: "unavailable",
    recoveryState: "legacy_replacement_required",
  });

  const projected = JSON.parse(exportNdjson(events.read(context.reviewId), {
    redactActor: () => "actor-1",
    redactText: () => "[redacted]",
  }).trim()) as { payload: { thread: { anchor: unknown; anchorGeneration: number } } };
  assert.equal(projected.payload.thread.anchorGeneration, 1);
  assert.deepEqual(projected.payload.thread.anchor, {
    schemaVersion: 1,
    locationAvailability: "unavailable",
    recoveryState: "legacy_replacement_required",
  });

  const before = kernel.getThread("legacy-anchor-thread", "a");
  const replaced = kernel.replaceAnchor("legacy-anchor-thread", "a", anchor);
  assert.deepEqual(replaced, { ...before, anchor, anchorGeneration: 2 });
  assert.deepEqual(events.read(context.reviewId).map((event) => event.type), ["thread.created", "anchor.replaced"]);
  assert.deepEqual(
    ((events.read(context.reviewId)[0]?.payload as { thread: { anchor: unknown } }).thread.anchor),
    legacyAnchor,
  );
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

  assert.throws(() => kernel.reply(before.id, "a", "Invalid timestamp reply"), /reply timestamp is invalid/);
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

test("kernel reads legacy oversized messages while bounding new mutations", () => {
  const events = new InMemoryEventStore();
  const legacyBody = "x".repeat(MAX_MESSAGE_BODY_BYTES + 1);
  const createdAt = "2026-08-29T00:00:00.000Z";
  events.append({
    id: "legacy-created-event",
    reviewId: context.reviewId,
    type: "thread.created",
    occurredAt: createdAt,
    actorId: "a",
    payload: { thread: { id: "legacy-created-thread", context, anchor, messages: [{ id: "legacy-created-message", authorId: "a", body: legacyBody, createdAt }] } },
  });
  events.append({
    id: "legacy-edit-thread-event",
    reviewId: context.reviewId,
    type: "thread.created",
    occurredAt: createdAt,
    actorId: "a",
    payload: { thread: { id: "legacy-edited-thread", context, anchor, messages: [{ id: "legacy-edited-message", authorId: "a", body: "Original", createdAt }] } },
  });
  events.append({
    id: "legacy-edit-event",
    reviewId: context.reviewId,
    type: "message.edited",
    occurredAt: "2026-08-29T00:01:00.000Z",
    actorId: "a",
    payload: { threadId: "legacy-edited-thread", messageId: "legacy-edited-message", body: legacyBody },
  });
  let id = 0;
  const everyAction: ReviewAction[] = ["create_thread", "reply", "edit_own_message", "delete_own_message", "resolve_thread", "reopen_thread", "read_thread"];
  const kernel = new ReviewKernel({
    events,
    authorizer: new StaticReviewAuthorizer([{ actorId: "a", reviewId: context.reviewId, actions: everyAction }]),
    now: () => "2026-08-30T00:00:00.000Z",
    id: () => `post-upgrade-${++id}`,
  });

  assert.equal(kernel.getThread("legacy-created-thread", "a").messages[0]?.body, legacyBody);
  assert.equal(kernel.getThread("legacy-edited-thread", "a").messages[0]?.body, legacyBody);
  assert.doesNotThrow(() => kernel.reply("legacy-created-thread", "a", "Bounded reply"));
  assert.doesNotThrow(() => kernel.editMessage("legacy-edited-thread", "legacy-edited-message", "a", "Bounded edit"));
  assert.throws(() => kernel.reply("legacy-created-thread", "a", legacyBody), /message body exceeds size limit/);
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

test("kernel rejects invalid lifecycle timestamps before append", () => {
  const everyAction: ReviewAction[] = ["create_thread", "reply", "edit_own_message", "delete_own_message", "resolve_thread", "reopen_thread", "read_thread"];
  const authorizer = new StaticReviewAuthorizer([{ actorId: "a", reviewId: context.reviewId, actions: everyAction }]);
  const setupClock = (timestamps: string[]) => {
    const events = new InMemoryEventStore();
    let id = 0;
    const kernel = new ReviewKernel({ events, authorizer, now: () => timestamps.shift() ?? " ", id: () => `clock-${++id}` });
    return { events, kernel };
  };

  const invalidCreation = setupClock(["not-a-timestamp"]);
  assert.throws(() => invalidCreation.kernel.createThread({ context, anchor, actorId: "a", body: "Feedback" }), /timestamp is invalid/);
  assert.equal(invalidCreation.events.readAll().length, 0);

  const invalidReply = setupClock(["2026-08-30T00:00:00.000Z", "2026-02-30T00:00:00Z"]);
  const replyThread = invalidReply.kernel.createThread({ context, anchor, actorId: "a", body: "Feedback" });
  assert.throws(() => invalidReply.kernel.reply(replyThread.id, "a", "Reply"), /timestamp is invalid/);
  assert.equal(invalidReply.events.readAll().length, 1);
  assert.deepEqual(invalidReply.kernel.getThread(replyThread.id, "a"), replyThread);

  for (const mutate of [
    (kernel: ReviewKernel, threadId: string, messageId: string) => kernel.editMessage(threadId, messageId, "a", "Edited"),
    (kernel: ReviewKernel, threadId: string, messageId: string) => kernel.deleteMessage(threadId, messageId, "a"),
    (kernel: ReviewKernel, threadId: string) => kernel.resolve(threadId, "a", "accepted"),
  ]) {
    const { events, kernel } = setupClock(["2026-08-30T00:00:00.000Z", "not-a-timestamp"]);
    const before = kernel.createThread({ context, anchor, actorId: "a", body: "Feedback" });
    assert.throws(() => mutate(kernel, before.id, before.messages[0]!.id), /timestamp is invalid/);
    assert.equal(events.readAll().length, 1);
    assert.deepEqual(kernel.getThread(before.id, "a"), before);
  }

  const { events, kernel } = setupClock(["2026-08-30T00:00:00.000Z", "2026-08-30T00:01:00.000Z", "not-a-timestamp"]);
  const created = kernel.createThread({ context, anchor, actorId: "a", body: "Feedback" });
  const beforeReopen = kernel.resolve(created.id, "a", "accepted");
  assert.throws(() => kernel.reopen(created.id, "a"), /timestamp is invalid/);
  assert.equal(events.readAll().length, 2);
  assert.deepEqual(kernel.getThread(created.id, "a"), beforeReopen);
});

test("kernel rejects malformed timestamps in known event history", () => {
  const everyAction: ReviewAction[] = ["create_thread", "reply", "edit_own_message", "delete_own_message", "resolve_thread", "reopen_thread", "read_thread"];
  const authorizer = new StaticReviewAuthorizer([{ actorId: "a", reviewId: context.reviewId, actions: everyAction }]);
  const valid = "2026-08-30T00:00:00Z";
  const later = "2026-08-30T00:01:00Z";
  const createdEvent = (occurredAt = valid, createdAt = valid, captureCreatedAt?: string) => ({
    id: "event-1",
    reviewId: context.reviewId,
    type: "thread.created",
    occurredAt,
    actorId: "a",
    payload: {
      thread: {
        id: "thread-1",
        context,
        anchor,
        messages: [{ id: "message-1", authorId: "a", body: "Feedback", createdAt }],
        ...(captureCreatedAt ? { capture: { id: "capture-1", digest: `sha256:${"a".repeat(64)}`, mediaType: "image/png", createdAt: captureCreatedAt } } : {}),
      },
    },
  });
  const rejectHistory = (history: Array<Omit<DomainEvent, "sequence">>, pattern: RegExp) => {
    const events = new InMemoryEventStore();
    for (const event of history) events.append(event);
    assert.throws(
      () => new ReviewKernel({ events, authorizer, now: () => valid, id: () => "unused" }),
      pattern,
    );
  };

  rejectHistory([createdEvent("not-a-timestamp", valid)], /occurrence timestamp.*invalid/);
  rejectHistory([createdEvent(valid, "not-a-timestamp")], /creation timestamp.*invalid/);
  rejectHistory([createdEvent(valid, valid, "2026-02-30T00:00:00Z")], /capture creation timestamp.*invalid/);
  rejectHistory([createdEvent(valid, later)], /timestamp does not match/);
  rejectHistory([
    createdEvent(),
    { id: "event-2", reviewId: context.reviewId, type: "message.edited", occurredAt: "not-a-timestamp", actorId: "a", payload: { threadId: "thread-1", messageId: "message-1", body: "Edited" } },
  ], /occurrence timestamp.*invalid/);
  rejectHistory([
    createdEvent(),
    { id: "event-2", reviewId: context.reviewId, type: "message.created", occurredAt: later, actorId: "a", payload: { threadId: "thread-1", message: { id: "message-2", authorId: "a", body: "Reply", createdAt: valid } } },
  ], /timestamp does not match/);
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
  const second = kernel.createThread({
    context: otherContext,
    anchor: { ...anchor, context: { ...anchor.context, reviewId: otherContext.reviewId } },
    actorId: "reviewer-2",
    body: "Second review",
  });

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

test("agent export redacts unvalidated semantic roles", () => {
  const { events, kernel } = setup();
  kernel.createThread({
    context,
    anchor: { ...anchor, semantic: { ...anchor.semantic, role: "customer-email@example.test" } },
    actorId: "actor-private",
    body: "Synthetic feedback",
  });
  const output = exportNdjson(events.read(context.reviewId), { redactActor: () => "actor-1", redactText: () => "[redacted]" });
  assert.doesNotMatch(output, /customer-email@example\.test/);
  const projected = JSON.parse(output.trim()) as { payload: { thread: { anchor: { semantic: { role: string } } } } };
  assert.equal(projected.payload.thread.anchor.semantic.role, "[redacted]");
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

  {
    const events = new ToggleEventStore();
    const { kernel } = setupWithEvents(events);
    const before = kernel.createThread({ context, anchor, actorId: "a", body: "Feedback" });
    const replacement = { ...anchor, element: { ...anchor.element, offset: { x: 30, y: 20 } } };
    events.rejecting = true;
    assert.throws(() => kernel.replaceAnchor(before.id, "a", replacement), /append rejection/);
    assert.deepEqual(kernel.getThread(before.id, "a"), before);
  }

  {
    const events = new ToggleEventStore();
    const { kernel } = setupWithEvents(events);
    const before = kernel.createThread({ context, anchor, actorId: "a", body: "Feedback" });
    events.rejecting = true;
    assert.throws(() => kernel.reportAnchorUnavailable(before.id, "a", before.anchorGeneration), /append rejection/);
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

test("file event store rolls back failed appends or remains fenced", async () => {
  const directory = await mkdtemp(join(tmpdir(), "collab-review-event-rollback-"));
  const event = { id: "event-1", reviewId: "review-1", type: "synthetic.event", occurredAt: "2026-08-30T00:00:00Z", actorId: "actor-1", payload: { value: 1 } };
  try {
    const recoverablePath = join(directory, "recoverable.ndjson");
    const recoverable = new FsyncFaultFileEventStore(recoverablePath);
    assert.throws(() => recoverable.append(event), /synthetic event fsync failure/);
    assert.deepEqual(new FileEventStore(recoverablePath).readAll(), []);
    assert.doesNotThrow(() => recoverable.append(event));
    assert.equal(new FileEventStore(recoverablePath).readAll().length, 1);

    const fencedPath = join(directory, "fenced.ndjson");
    const fenced = new FsyncFaultFileEventStore(fencedPath, true);
    assert.throws(() => fenced.append(event), /fenced for operator recovery/);
    assert.throws(() => new FileEventStore(fencedPath).readAll(), /event store is locked/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("file event store persists its lock before touching event data", async () => {
  const directory = await mkdtemp(join(tmpdir(), "collab-review-lock-sync-"));
  const eventPath = join(directory, "events.ndjson");
  const event = { id: "event-1", reviewId: "review-1", type: "synthetic.event", occurredAt: "2026-08-30T00:00:00Z", actorId: "actor-1", payload: {} };
  try {
    assert.throws(() => new LockDirectoryFaultFileEventStore(eventPath).append(event), /synthetic lock directory sync failure/);
    assert.deepEqual(new FileEventStore(eventPath).readAll(), []);
    assert.doesNotThrow(() => new FileEventStore(eventPath).append(event));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("file event store does not invert a committed result when lock cleanup sync fails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "collab-review-lock-release-"));
  const eventPath = join(directory, "events.ndjson");
  const event = { id: "event-1", reviewId: "review-1", type: "synthetic.event", occurredAt: "2026-08-30T00:00:00Z", actorId: "actor-1", payload: {} };
  try {
    assert.doesNotThrow(() => new LockReleaseFaultFileEventStore(eventPath).append(event));
    assert.equal(new FileEventStore(eventPath).readAll().length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("file event store preserves committed results when lock close or unlink cleanup fails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "collab-review-lock-cleanup-"));
  const event = { id: "event-1", reviewId: "review-1", type: "synthetic.event", occurredAt: "2026-08-30T00:00:00Z", actorId: "actor-1", payload: {} };
  try {
    const closePath = join(directory, "close.ndjson");
    assert.doesNotThrow(() => new LockCloseFaultFileEventStore(closePath).append(event));
    assert.equal(new FileEventStore(closePath).readAll().length, 1);

    const unlinkPath = join(directory, "unlink.ndjson");
    assert.doesNotThrow(() => new LockUnlinkFaultFileEventStore(unlinkPath).append(event));
    assert.throws(() => new FileEventStore(unlinkPath).readAll(), /event store is locked/);
    await rm(`${unlinkPath}.lock`);
    assert.equal(new FileEventStore(unlinkPath).readAll().length, 1);
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
