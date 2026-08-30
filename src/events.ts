import type { DomainEvent } from "./domain.ts";
import { constants, closeSync, fstatSync, fsyncSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";

export interface EventStore {
  append(event: Omit<DomainEvent, "sequence">): DomainEvent;
  read(reviewId: string): readonly DomainEvent[];
}

export class InMemoryEventStore implements EventStore {
  readonly #events: DomainEvent[] = [];

  append(event: Omit<DomainEvent, "sequence">): DomainEvent {
    if (this.#events.some((known) => known.id === event.id)) throw new Error("duplicate event id");
    const stored = Object.freeze({ ...structuredClone(event), sequence: this.#events.length + 1 });
    this.#events.push(stored);
    return structuredClone(stored);
  }

  read(reviewId: string): readonly DomainEvent[] {
    return this.#events.filter((event) => event.reviewId === reviewId).map((event) => structuredClone(event));
  }
}

/**
 * Append-only local reference adapter. It serializes writers through an atomic
 * lock file, fsyncs every accepted event, and fails closed on corrupt or
 * conflicting history. A stale lock requires explicit operator recovery.
 */
export class FileEventStore implements EventStore {
  readonly path: string;
  readonly maxBytes: number;

  constructor(path: string, maxBytes = 64 * 1024 * 1024) {
    if (!isAbsolute(path)) throw new Error("event store path must be absolute");
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("event store size limit must be positive");
    this.path = path;
    this.maxBytes = maxBytes;
  }

  append(event: Omit<DomainEvent, "sequence">): DomainEvent {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const lockPath = `${this.path}.lock`;
    const lock = acquireLock(lockPath);
    try {
      const events = this.#readAll();
      if (events.some((known) => known.id === event.id)) throw new Error("duplicate event id");
      const stored = { ...structuredClone(event), sequence: events.length + 1 };
      const serialized = serializeEvent(stored);
      const line = `${serialized}\n`;
      const currentBytes = existingSize(this.path);
      if (currentBytes + Buffer.byteLength(line) > this.maxBytes) throw new Error("event store exceeds size limit");
      appendAndSync(this.path, line);
      return JSON.parse(serialized) as DomainEvent;
    } finally {
      closeSync(lock);
      unlinkSync(lockPath);
    }
  }

  read(reviewId: string): readonly DomainEvent[] {
    return this.#readAll().filter((event) => event.reviewId === reviewId).map((event) => structuredClone(event));
  }

  #readAll(): DomainEvent[] {
    let descriptor: number;
    try {
      descriptor = openSync(this.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if (isFileError(error, "ENOENT")) return [];
      throw error;
    }
    try {
      const size = fstatSync(descriptor).size;
      if (size > this.maxBytes) throw new Error("event store exceeds size limit");
      const raw = readFileSync(descriptor, "utf8");
      if (!raw) return [];
      if (!raw.endsWith("\n")) throw new Error("corrupt event history");
      return validateHistory(raw.split("\n").slice(0, -1));
    } finally {
      closeSync(descriptor);
    }
  }
}

function acquireLock(path: string): number {
  try {
    return openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  } catch (error) {
    if (isFileError(error, "EEXIST")) throw new Error("event store is locked");
    throw error;
  }
}

function appendAndSync(path: string, line: string): void {
  const descriptor = openSync(path, constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try {
    writeFileSync(descriptor, line);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function existingSize(path: string): number {
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (isFileError(error, "ENOENT")) return 0;
    throw error;
  }
  try {
    return fstatSync(descriptor).size;
  } finally {
    closeSync(descriptor);
  }
}

function validateHistory(lines: readonly string[]): DomainEvent[] {
  const events: DomainEvent[] = [];
  const ids = new Set<string>();
  for (const [index, line] of lines.entries()) {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new Error("corrupt event history");
    }
    if (!isDomainEvent(value)) throw new Error("corrupt event history");
    if (value.sequence !== index + 1) throw new Error("event sequence conflict");
    if (ids.has(value.id)) throw new Error("duplicate event id in history");
    ids.add(value.id);
    events.push(value);
  }
  return events;
}

function serializeEvent(event: DomainEvent): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(event);
  } catch {
    throw new Error("event must be JSON serializable");
  }
  const durable = JSON.parse(serialized) as unknown;
  if (!isDomainEvent(durable)) throw new Error("event must be JSON serializable");
  return serialized;
}

function isDomainEvent(value: unknown): value is DomainEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Record<string, unknown>;
  return Number.isSafeInteger(event.sequence)
    && typeof event.id === "string" && Boolean(event.id)
    && typeof event.reviewId === "string" && Boolean(event.reviewId)
    && typeof event.type === "string" && Boolean(event.type)
    && typeof event.occurredAt === "string" && Boolean(event.occurredAt)
    && typeof event.actorId === "string" && Boolean(event.actorId)
    && "payload" in event;
}

function isFileError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
