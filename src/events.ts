import type { DomainEvent } from "./domain.ts";
import { constants, closeSync, fchmodSync, fstatSync, fsyncSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync, type Stats } from "node:fs";
import { dirname, isAbsolute } from "node:path";

export interface EventStore {
  append(event: Omit<DomainEvent, "sequence">, expectedSequence?: number): DomainEvent;
  read(reviewId: string): readonly DomainEvent[];
  readAll(): readonly DomainEvent[];
}

export interface FileEventStoreQuotaOptions {
  maxEventBytes?: number;
  maxReviewBytes?: number;
  maxActorBytes?: number;
}

const DEFAULT_MAX_EVENT_BYTES = 256 * 1024;
const DEFAULT_MAX_REVIEW_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_ACTOR_BYTES = 8 * 1024 * 1024;

export class InMemoryEventStore implements EventStore {
  readonly #events: DomainEvent[] = [];

  append(event: Omit<DomainEvent, "sequence">, expectedSequence?: number): DomainEvent {
    if (expectedSequence !== undefined && this.#events.length !== expectedSequence) throw new Error("event history changed during mutation");
    if (this.#events.some((known) => known.id === event.id)) throw new Error("duplicate event id");
    const stored = Object.freeze({ ...structuredClone(event), sequence: this.#events.length + 1 });
    this.#events.push(stored);
    return structuredClone(stored);
  }

  read(reviewId: string): readonly DomainEvent[] {
    return this.readAll().filter((event) => event.reviewId === reviewId);
  }

  readAll(): readonly DomainEvent[] {
    return this.#events.map((event) => structuredClone(event));
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
  readonly maxEventBytes: number;
  readonly maxReviewBytes: number;
  readonly maxActorBytes: number;

  constructor(path: string, maxBytes = 64 * 1024 * 1024, quotas: FileEventStoreQuotaOptions = {}) {
    if (!isAbsolute(path)) throw new Error("event store path must be absolute");
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("event store size limit must be positive");
    this.path = path;
    this.maxBytes = maxBytes;
    this.maxEventBytes = quotaLimit(quotas.maxEventBytes, Math.min(DEFAULT_MAX_EVENT_BYTES, maxBytes), "event");
    this.maxReviewBytes = quotaLimit(quotas.maxReviewBytes, Math.min(DEFAULT_MAX_REVIEW_BYTES, maxBytes), "review");
    this.maxActorBytes = quotaLimit(quotas.maxActorBytes, Math.min(DEFAULT_MAX_ACTOR_BYTES, maxBytes), "actor");
    if (this.maxEventBytes > this.maxReviewBytes || this.maxEventBytes > this.maxActorBytes) throw new Error("event quota cannot exceed review or actor quota");
    if (this.maxReviewBytes > maxBytes || this.maxActorBytes > maxBytes) throw new Error("review and actor quotas cannot exceed total event store size");
  }

  append(event: Omit<DomainEvent, "sequence">, expectedSequence?: number): DomainEvent {
    ensurePrivateDirectory(dirname(this.path));
    const lockPath = `${this.path}.lock`;
    const lock = acquireLock(lockPath);
    try {
      const events = this.#readAll();
      if (expectedSequence !== undefined && events.length !== expectedSequence) throw new Error("event history changed during mutation");
      if (events.some((known) => known.id === event.id)) throw new Error("duplicate event id");
      const stored = { ...structuredClone(event), sequence: events.length + 1 };
      const serialized = serializeEvent(stored);
      const line = `${serialized}\n`;
      const lineBytes = Buffer.byteLength(line);
      if (lineBytes > this.maxEventBytes) throw new Error("event exceeds size limit");
      const reviewBytes = storedBytes(events, (known) => known.reviewId === event.reviewId);
      if (reviewBytes + lineBytes > this.maxReviewBytes) throw new Error("review exceeds event storage quota");
      const actorBytes = storedBytes(events, (known) => known.actorId === event.actorId);
      if (actorBytes + lineBytes > this.maxActorBytes) throw new Error("actor exceeds event storage quota");
      const currentBytes = existingSize(this.path);
      if (currentBytes + lineBytes > this.maxBytes) throw new Error("event store exceeds size limit");
      appendAndSync(this.path, line);
      return JSON.parse(serialized) as DomainEvent;
    } finally {
      releaseLock(lock, lockPath);
    }
  }

  read(reviewId: string): readonly DomainEvent[] {
    return this.readAll().filter((event) => event.reviewId === reviewId);
  }

  readAll(): readonly DomainEvent[] {
    ensurePrivateDirectory(dirname(this.path));
    const lockPath = `${this.path}.lock`;
    const lock = acquireLock(lockPath);
    try {
      return this.#readAll().map((event) => structuredClone(event));
    } finally {
      releaseLock(lock, lockPath);
    }
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
      const size = privateFileStats(descriptor).size;
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

function quotaLimit(value: number | undefined, fallback: number, label: string): number {
  const limit = value ?? fallback;
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error(`${label} event storage quota must be positive`);
  return limit;
}

function storedBytes(events: readonly DomainEvent[], matches: (event: DomainEvent) => boolean): number {
  let bytes = 0;
  for (const event of events) {
    if (matches(event)) bytes += Buffer.byteLength(`${serializeEvent(event)}\n`);
  }
  return bytes;
}

function ensurePrivateDirectory(path: string): void {
  const missing: string[] = [];
  let cursor = path;
  while (!isExistingDirectory(cursor)) {
    missing.push(cursor);
    const parent = dirname(cursor);
    if (parent === cursor) throw new Error("event store parent must be a directory");
    cursor = parent;
  }
  for (const directory of missing.reverse()) {
    try {
      mkdirSync(directory, { mode: 0o700 });
    } catch (error) {
      if (!isFileError(error, "EEXIST")) throw error;
    }
    enforcePrivateDirectory(directory);
    syncDirectory(dirname(directory));
  }
  enforcePrivateDirectory(path);
}

function isExistingDirectory(path: string): boolean {
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  } catch (error) {
    if (isFileError(error, "ENOENT")) return false;
    throw error;
  }
  closeSync(descriptor);
  return true;
}

function enforcePrivateDirectory(path: string): void {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const stats = fstatSync(descriptor);
    if (!stats.isDirectory()) throw new Error("event store parent must be a directory");
    if ((stats.mode & 0o077) !== 0) fchmodSync(descriptor, 0o700);
  } finally {
    closeSync(descriptor);
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

function releaseLock(descriptor: number, path: string): void {
  closeSync(descriptor);
  unlinkSync(path);
}

function appendAndSync(path: string, line: string): void {
  let descriptor: number;
  let created = false;
  try {
    descriptor = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    created = true;
  } catch (error) {
    if (!isFileError(error, "EEXIST")) throw error;
    descriptor = openSync(path, constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW);
  }
  try {
    privateFileStats(descriptor);
    if (created) syncDirectory(dirname(path));
    writeFileSync(descriptor, line);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function syncDirectory(path: string): void {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const stats = fstatSync(descriptor);
    if (!stats.isDirectory()) throw new Error("event store parent must be a directory");
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
    return privateFileStats(descriptor).size;
  } finally {
    closeSync(descriptor);
  }
}

function privateFileStats(descriptor: number): Stats {
  const stats = fstatSync(descriptor);
  if (!stats.isFile()) throw new Error("event store path must be a regular file");
  if ((stats.mode & 0o077) !== 0) fchmodSync(descriptor, 0o600);
  return stats;
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
