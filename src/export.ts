import type { DomainEvent } from "./domain.ts";

export interface ExportPolicy {
  redactActor: (actorId: string) => string;
  redactText: (text: string) => string;
}

const ARRAY_ITEM = Symbol("array item");
type PathSegment = string | typeof ARRAY_ITEM;
type PathSchema = readonly (readonly PathSegment[])[];

const SAFE_EVENT_STRING_PATHS = paths(
  "id",
  "reviewId",
  "occurredAt",
  "type",
);

const SAFE_EVENT_PRIMITIVE_PATHS = paths("sequence");
const PAYLOAD_PATH = paths("payload");

const SAFE_PAYLOAD_STRING_PATHS: Readonly<Record<string, PathSchema>> = {
  "thread.created": paths(
    "payload.thread.id",
    "payload.thread.context.reviewId",
    "payload.thread.context.prototypeId",
    "payload.thread.context.revisionId",
    "payload.thread.context.viewportId",
    "payload.thread.context.variantId",
    "payload.thread.context.route",
    "payload.thread.anchor.locationAvailability",
    "payload.thread.anchor.recoveryState",
    "payload.thread.anchor.context.reviewId",
    "payload.thread.anchor.context.prototypeId",
    "payload.thread.anchor.context.revisionId",
    "payload.thread.anchor.context.viewportId",
    "payload.thread.anchor.context.variantId",
    "payload.thread.anchor.context.route",
    "payload.thread.anchor.context.deviceId",
    "payload.thread.anchor.context.surfaceId",
    "payload.thread.capture.id",
    "payload.thread.capture.digest",
    "payload.thread.capture.mediaType",
    "payload.thread.capture.createdAt",
    "payload.thread.messages.*.id",
    "payload.thread.messages.*.createdAt",
    "payload.thread.messages.*.editedAt",
    "payload.thread.messages.*.deletedAt",
    "payload.thread.resolvedAt",
    "payload.thread.disposition",
  ),
  "message.created": paths(
    "payload.threadId",
    "payload.message.id",
    "payload.message.createdAt",
    "payload.message.editedAt",
    "payload.message.deletedAt",
  ),
  "message.edited": paths("payload.threadId", "payload.messageId"),
  "message.deleted": paths("payload.threadId", "payload.messageId"),
  "thread.resolved": paths("payload.threadId", "payload.disposition"),
  "thread.reopened": paths("payload.threadId"),
  "anchor.replaced": paths(
    "payload.threadId",
    "payload.anchor.locationAvailability",
    "payload.anchor.recoveryState",
    "payload.anchor.context.reviewId",
    "payload.anchor.context.prototypeId",
    "payload.anchor.context.revisionId",
    "payload.anchor.context.viewportId",
    "payload.anchor.context.variantId",
    "payload.anchor.context.route",
    "payload.anchor.context.deviceId",
    "payload.anchor.context.surfaceId",
  ),
  "anchor.orphaned": paths(
    "payload.threadId",
    "payload.anchor.locationAvailability",
    "payload.anchor.recoveryState",
    "payload.anchor.context.reviewId",
    "payload.anchor.context.prototypeId",
    "payload.anchor.context.revisionId",
    "payload.anchor.context.viewportId",
    "payload.anchor.context.variantId",
    "payload.anchor.context.route",
    "payload.anchor.context.deviceId",
    "payload.anchor.context.surfaceId",
  ),
};

const SAFE_PAYLOAD_PRIMITIVE_PATHS: Readonly<Record<string, PathSchema>> = {
  "thread.created": paths(
    "payload.thread.anchorGeneration",
    "payload.thread.anchor.schemaVersion",
    "payload.thread.anchor.element.offset.x",
    "payload.thread.anchor.element.offset.y",
    "payload.thread.anchor.document.x",
    "payload.thread.anchor.document.y",
    "payload.thread.anchor.document.width",
    "payload.thread.anchor.document.height",
  ),
  "anchor.replaced": paths(
    "payload.anchorGeneration",
    "payload.anchor.schemaVersion",
    "payload.anchor.element.offset.x",
    "payload.anchor.element.offset.y",
    "payload.anchor.document.x",
    "payload.anchor.document.y",
    "payload.anchor.document.width",
    "payload.anchor.document.height",
  ),
  "anchor.orphaned": paths("payload.anchorGeneration", "payload.anchor.schemaVersion"),
};

const ACTOR_PATHS = paths("actorId", "payload.thread.messages.*.authorId", "payload.message.authorId");

const REDACTED_TEXT_PATHS: Readonly<Record<string, PathSchema>> = {
  "thread.created": paths(
    "payload.thread.anchor.semantic.role",
    "payload.thread.anchor.semantic.accessibleName",
    "payload.thread.anchor.semantic.testId",
    "payload.thread.anchor.element.selector",
    "payload.thread.anchor.element.identity",
    "payload.thread.anchor.text.exact",
    "payload.thread.anchor.text.prefix",
    "payload.thread.anchor.text.suffix",
    "payload.thread.messages.*.body",
    "payload.thread.dispositionReason",
  ),
  "message.created": paths("payload.message.body"),
  "message.edited": paths("payload.body"),
  "thread.resolved": paths("payload.reason"),
  "anchor.replaced": paths(
    "payload.anchor.element.selector",
    "payload.anchor.element.identity",
    "payload.anchor.semantic.role",
    "payload.anchor.semantic.accessibleName",
    "payload.anchor.semantic.testId",
    "payload.anchor.text.exact",
    "payload.anchor.text.prefix",
    "payload.anchor.text.suffix",
  ),
};

export function projectEvent(event: DomainEvent, policy: ExportPolicy): DomainEvent {
  const projected = normalizeLegacyAnchor(structuredClone(event));
  return redact(projected, policy, event.type) as DomainEvent;
}

export function exportJson(events: readonly DomainEvent[], policy: ExportPolicy): string {
  return JSON.stringify({ schemaVersion: 1, events: events.map((event) => projectEvent(event, policy)) }, null, 2);
}

export function exportNdjson(events: readonly DomainEvent[], policy: ExportPolicy): string {
  return events.map((event) => JSON.stringify(projectEvent(event, policy))).join("\n") + (events.length ? "\n" : "");
}

function redact(value: unknown, policy: ExportPolicy, eventType: string, path: readonly PathSegment[] = []): unknown {
  if (typeof value === "string") {
    if (matchesPath(path, ACTOR_PATHS)) return policy.redactActor(value);
    if (matchesPath(path, SAFE_EVENT_STRING_PATHS) || matchesPath(path, SAFE_PAYLOAD_STRING_PATHS[eventType])) return value;
    return policy.redactText(value);
  }
  if (Array.isArray(value)) return value.map((entry) => redact(entry, policy, eventType, [...path, ARRAY_ITEM]));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).flatMap(([childKey, child]) => {
      const childPath = [...path, childKey];
      return isRecognizedPath(childPath, eventType)
        ? [[childKey, redact(child, policy, eventType, childPath)]]
        : [];
    }));
  }
  if (matchesPath(path, SAFE_EVENT_PRIMITIVE_PATHS) || matchesPath(path, SAFE_PAYLOAD_PRIMITIVE_PATHS[eventType])) return value;
  return policy.redactText(String(value));
}

function paths(...values: readonly string[]): PathSchema {
  return values.map((value) => value.split(".").map((part) => part === "*" ? ARRAY_ITEM : part));
}

function matchesPath(path: readonly PathSegment[], schema: PathSchema | undefined): boolean {
  return schema?.some((candidate) => candidate.length === path.length && candidate.every((segment, index) => segment === path[index])) ?? false;
}

function isRecognizedPath(path: readonly PathSegment[], eventType: string): boolean {
  if (matchesPath(path, PAYLOAD_PATH)) return true;
  const recognized = [
    ...SAFE_EVENT_STRING_PATHS,
    ...SAFE_EVENT_PRIMITIVE_PATHS,
    ...ACTOR_PATHS,
    ...(SAFE_PAYLOAD_STRING_PATHS[eventType] ?? []),
    ...(SAFE_PAYLOAD_PRIMITIVE_PATHS[eventType] ?? []),
    ...(REDACTED_TEXT_PATHS[eventType] ?? []),
  ];
  return recognized.some((candidate) => path.length <= candidate.length && path.every((segment, index) => segment === candidate[index]));
}

function normalizeLegacyAnchor(event: DomainEvent): DomainEvent {
  if (event.type !== "thread.created") return event;
  const payload = asRecord(event.payload);
  const thread = asRecord(payload?.thread);
  const anchor = asRecord(thread?.anchor);
  if (!thread) return event;
  const preGenerationAnchor = thread.anchorGeneration === undefined;
  if (thread.anchorGeneration === undefined) thread.anchorGeneration = 1;
  if (anchor?.schemaVersion === 1) {
    thread.anchor = {
      schemaVersion: 1,
      locationAvailability: "unavailable",
      recoveryState: "legacy_replacement_required",
    };
  } else if (anchor?.schemaVersion === 2 && preGenerationAnchor) {
    const context = asRecord(anchor.context);
    thread.anchor = {
      schemaVersion: 2,
      locationAvailability: "unavailable",
      recoveryState: "legacy_replacement_required",
      ...(context ? { context } : {}),
    };
  }
  return event;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
