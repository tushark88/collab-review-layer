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
    "payload.thread.anchor.semantic.role",
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
};

const SAFE_PAYLOAD_PRIMITIVE_PATHS: Readonly<Record<string, PathSchema>> = {
  "thread.created": paths(
    "payload.thread.anchor.schemaVersion",
    "payload.thread.anchor.geometry.xRatio",
    "payload.thread.anchor.geometry.yRatio",
    "payload.thread.anchor.scroll.xRatio",
    "payload.thread.anchor.scroll.yRatio",
  ),
};

const ACTOR_PATHS = paths("actorId", "payload.thread.messages.*.authorId", "payload.message.authorId");

const REDACTED_TEXT_PATHS: Readonly<Record<string, PathSchema>> = {
  "thread.created": paths(
    "payload.thread.anchor.semantic.accessibleName",
    "payload.thread.anchor.semantic.testId",
    "payload.thread.anchor.text.exact",
    "payload.thread.anchor.text.prefix",
    "payload.thread.anchor.text.suffix",
    "payload.thread.messages.*.body",
    "payload.thread.dispositionReason",
  ),
  "message.created": paths("payload.message.body"),
  "message.edited": paths("payload.body"),
  "thread.resolved": paths("payload.reason"),
};

export function projectEvent(event: DomainEvent, policy: ExportPolicy): DomainEvent {
  return redact(structuredClone(event), policy, event.type) as DomainEvent;
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
