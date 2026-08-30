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

const ACTOR_PATHS = new Set(["actorId", "payload.thread.messages.*.authorId", "payload.message.authorId"]);

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
  if (typeof value === "string") {
    const normalizedPath = path.map((part) => /^\d+$/.test(part) ? "*" : part).join(".");
    if (ACTOR_PATHS.has(normalizedPath)) return policy.redactActor(value);
    if (SAFE_EVENT_STRING_PATHS.has(normalizedPath) || SAFE_PAYLOAD_STRING_PATHS[eventType]?.has(normalizedPath)) return value;
    return policy.redactText(value);
  }
  if (Array.isArray(value)) return value.map((entry, index) => redact(entry, policy, eventType, [...path, String(index)]));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, redact(child, policy, eventType, [...path, childKey])]));
  }
  return value;
}
