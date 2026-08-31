import type { DomainEvent } from "./domain.ts";

export interface ExportPolicy {
  redactActor: (actorId: string) => string;
  redactText: (text: string) => string;
}

const SAFE_EVENT_STRING_PATHS = new Set([
  "id",
  "reviewId",
  "occurredAt",
  "type",
]);

const SAFE_EVENT_PRIMITIVE_PATHS = new Set(["sequence"]);

const SAFE_PAYLOAD_STRING_PATHS: Readonly<Record<string, ReadonlySet<string>>> = {
  "thread.created": new Set([
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
  ]),
  "message.created": new Set([
    "payload.threadId",
    "payload.message.id",
    "payload.message.createdAt",
    "payload.message.editedAt",
    "payload.message.deletedAt",
  ]),
  "message.edited": new Set(["payload.threadId", "payload.messageId"]),
  "message.deleted": new Set(["payload.threadId", "payload.messageId"]),
  "thread.resolved": new Set(["payload.threadId", "payload.disposition"]),
  "thread.reopened": new Set(["payload.threadId"]),
};

const SAFE_PAYLOAD_PRIMITIVE_PATHS: Readonly<Record<string, ReadonlySet<string>>> = {
  "thread.created": new Set([
    "payload.thread.anchor.schemaVersion",
    "payload.thread.anchor.geometry.xRatio",
    "payload.thread.anchor.geometry.yRatio",
    "payload.thread.anchor.scroll.xRatio",
    "payload.thread.anchor.scroll.yRatio",
  ]),
};

const ACTOR_PATHS = new Set(["actorId", "payload.thread.messages.*.authorId", "payload.message.authorId"]);

const REDACTED_TEXT_PATHS: Readonly<Record<string, ReadonlySet<string>>> = {
  "thread.created": new Set([
    "payload.thread.anchor.semantic.accessibleName",
    "payload.thread.anchor.semantic.testId",
    "payload.thread.anchor.text.exact",
    "payload.thread.anchor.text.prefix",
    "payload.thread.anchor.text.suffix",
    "payload.thread.messages.*.body",
    "payload.thread.dispositionReason",
  ]),
  "message.created": new Set(["payload.message.body"]),
  "message.edited": new Set(["payload.body"]),
  "thread.resolved": new Set(["payload.reason"]),
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

function redact(value: unknown, policy: ExportPolicy, eventType: string, path: readonly string[] = []): unknown {
  const normalizedPath = normalizePath(path);
  if (typeof value === "string") {
    if (ACTOR_PATHS.has(normalizedPath)) return policy.redactActor(value);
    if (SAFE_EVENT_STRING_PATHS.has(normalizedPath) || SAFE_PAYLOAD_STRING_PATHS[eventType]?.has(normalizedPath)) return value;
    return policy.redactText(value);
  }
  if (Array.isArray(value)) return value.map((entry, index) => redact(entry, policy, eventType, [...path, String(index)]));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).flatMap(([childKey, child]) => {
      const childPath = [...path, childKey];
      return isRecognizedPath(normalizePath(childPath), eventType)
        ? [[childKey, redact(child, policy, eventType, childPath)]]
        : [];
    }));
  }
  if (SAFE_EVENT_PRIMITIVE_PATHS.has(normalizedPath) || SAFE_PAYLOAD_PRIMITIVE_PATHS[eventType]?.has(normalizedPath)) return value;
  return policy.redactText(String(value));
}

function normalizePath(path: readonly string[]): string {
  return path.map((part) => /^\d+$/.test(part) ? "*" : part).join(".");
}

function isRecognizedPath(path: string, eventType: string): boolean {
  if (path === "payload") return true;
  const recognized = [
    ...SAFE_EVENT_STRING_PATHS,
    ...SAFE_EVENT_PRIMITIVE_PATHS,
    ...ACTOR_PATHS,
    ...(SAFE_PAYLOAD_STRING_PATHS[eventType] ?? []),
    ...(SAFE_PAYLOAD_PRIMITIVE_PATHS[eventType] ?? []),
    ...(REDACTED_TEXT_PATHS[eventType] ?? []),
  ];
  return recognized.some((candidate) => candidate === path || candidate.startsWith(`${path}.`));
}
