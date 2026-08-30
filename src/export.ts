import type { DomainEvent } from "./domain.ts";

export interface ExportPolicy {
  redactActor: (actorId: string) => string;
  redactText: (text: string) => string;
}

const SAFE_STRING_KEYS = new Set([
  "id",
  "reviewId",
  "prototypeId",
  "revisionId",
  "viewportId",
  "variantId",
  "threadId",
  "messageId",
  "route",
  "digest",
  "mediaType",
  "createdAt",
  "editedAt",
  "deletedAt",
  "resolvedAt",
  "occurredAt",
  "type",
  "disposition",
]);

export function projectEvent(event: DomainEvent, policy: ExportPolicy): DomainEvent {
  return redact(structuredClone(event), policy) as DomainEvent;
}

export function exportJson(events: readonly DomainEvent[], policy: ExportPolicy): string {
  return JSON.stringify({ schemaVersion: 1, events: events.map((event) => projectEvent(event, policy)) }, null, 2);
}

export function exportNdjson(events: readonly DomainEvent[], policy: ExportPolicy): string {
  return events.map((event) => JSON.stringify(projectEvent(event, policy))).join("\n") + (events.length ? "\n" : "");
}

function redact(value: unknown, policy: ExportPolicy, key?: string): unknown {
  if (typeof value === "string") {
    if (key === "actorId" || key === "authorId") return policy.redactActor(value);
    if (key && SAFE_STRING_KEYS.has(key)) return value;
    return policy.redactText(value);
  }
  if (Array.isArray(value)) return value.map((entry) => redact(entry, policy));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, redact(child, policy, childKey)]));
  }
  return value;
}
