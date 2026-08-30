import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { access, chmod, lstat, mkdir, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

export const MAX_WEBHOOK_BODY_BYTES = 1_048_576;
export const MAX_WEBHOOK_DELIVERY_ID_BYTES = 512;

export interface WebhookDeliveryLedger {
  begin(provider: string, deliveryId: string): Promise<boolean>;
  complete(provider: string, deliveryId: string): Promise<void>;
  release(provider: string, deliveryId: string): Promise<void>;
}

export class InMemoryWebhookDeliveryLedger implements WebhookDeliveryLedger {
  readonly #claims = new Map<string, "pending" | "completed">();

  async begin(provider: string, deliveryId: string): Promise<boolean> {
    const key = deliveryKey(provider, deliveryId);
    if (this.#claims.has(key)) return false;
    this.#claims.set(key, "pending");
    return true;
  }

  async complete(provider: string, deliveryId: string): Promise<void> {
    const key = deliveryKey(provider, deliveryId);
    if (this.#claims.get(key) === "completed") return;
    if (this.#claims.get(key) !== "pending") throw new Error("webhook delivery is not pending");
    this.#claims.set(key, "completed");
  }

  async release(provider: string, deliveryId: string): Promise<void> {
    const key = deliveryKey(provider, deliveryId);
    if (this.#claims.get(key) === "pending") this.#claims.delete(key);
  }
}

/**
 * Durable local reference adapter. Atomic exclusive file creation makes pending
 * reservations safe across multiple processes sharing the same directory.
 * Successful application writes a completed marker before removing the pending
 * marker; failed application removes only the pending marker so retries remain
 * possible. Delivery ids are hashed and never written to disk.
 */
export class FileWebhookDeliveryLedger implements WebhookDeliveryLedger {
  readonly directory: string;

  constructor(directory: string) {
    if (!isAbsolute(directory)) throw new Error("webhook delivery directory must be absolute");
    this.directory = directory;
  }

  async begin(provider: string, deliveryId: string): Promise<boolean> {
    const key = deliveryKey(provider, deliveryId);
    await ensurePrivateDirectory(this.directory);
    const pending = join(this.directory, `${key}.pending`);
    const completed = join(this.directory, `${key}.completed`);
    if (await pathExists(completed)) return false;
    try {
      await writeFile(pending, "", { flag: "wx", mode: 0o600 });
    } catch (error) {
      if (isAlreadyExists(error)) return false;
      throw error;
    }
    if (await pathExists(completed)) {
      await removeIfPresent(pending);
      return false;
    }
    return true;
  }

  async complete(provider: string, deliveryId: string): Promise<void> {
    await ensurePrivateDirectory(this.directory);
    const key = deliveryKey(provider, deliveryId);
    const pending = join(this.directory, `${key}.pending`);
    const completed = join(this.directory, `${key}.completed`);
    if (await pathExists(completed)) {
      await removeIfPresent(pending);
      return;
    }
    if (!await pathExists(pending)) throw new Error("webhook delivery is not pending");
    try {
      await writeFile(completed, "", { flag: "wx", mode: 0o600 });
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
    }
    await removeIfPresent(pending);
  }

  async release(provider: string, deliveryId: string): Promise<void> {
    await ensurePrivateDirectory(this.directory);
    const key = deliveryKey(provider, deliveryId);
    await removeIfPresent(join(this.directory, `${key}.pending`));
  }
}

export function verifyHmacSha256(body: Uint8Array, supplied: string | undefined, secret: string, prefix = "sha256="): boolean {
  if (!supplied?.startsWith(prefix) || !secret) return false;
  const expected = createHmac("sha256", secret).update(body).digest("hex");
  const actual = supplied.slice(prefix.length);
  if (actual.length !== expected.length || !/^[0-9a-f]{64}$/i.test(actual)) return false;
  return timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
}

export function requireFreshTimestamp(timestamp: string | number | undefined, nowMs: number, toleranceMs = 60_000): void {
  const value = timestamp ? Number(timestamp) : Number.NaN;
  const milliseconds = value < 10_000_000_000 ? value * 1000 : value;
  if (!Number.isFinite(milliseconds) || Math.abs(nowMs - milliseconds) > toleranceMs) throw new Error("stale or missing webhook timestamp");
}

export function requireWebhookBody(body: Uint8Array): void {
  if (body.byteLength === 0) throw new Error("empty webhook body");
  if (body.byteLength > MAX_WEBHOOK_BODY_BYTES) throw new Error("webhook body exceeds size limit");
}

export function requireDeliveryId(deliveryId: string | undefined): string {
  if (!deliveryId?.trim()) throw new Error("missing webhook delivery id");
  if (Buffer.byteLength(deliveryId) > MAX_WEBHOOK_DELIVERY_ID_BYTES || !/^[\x21-\x7e]+$/.test(deliveryId)) {
    throw new Error("invalid webhook delivery id");
  }
  return deliveryId;
}

export async function processUniqueDelivery<T>(
  ledger: WebhookDeliveryLedger,
  provider: string,
  deliveryId: string,
  webhook: T,
  apply: (webhook: T) => Promise<void>,
): Promise<void> {
  const id = requireDeliveryId(deliveryId);
  if (!await ledger.begin(provider, id)) throw new Error("duplicate webhook delivery");
  try {
    await apply(webhook);
  } catch (error) {
    try {
      await ledger.release(provider, id);
    } catch (releaseError) {
      throw new AggregateError([error, releaseError], "webhook application failed and delivery release failed");
    }
    throw error;
  }
  await ledger.complete(provider, id);
}

function deliveryKey(provider: string, deliveryId: string): string {
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(provider)) throw new Error("invalid webhook provider");
  requireDeliveryId(deliveryId);
  return createHash("sha256").update(provider).update("\u0000").update(deliveryId).digest("hex");
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

async function removeIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stats = await lstat(path);
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error("webhook delivery path must be a directory");
  if ((stats.mode & 0o077) !== 0) await chmod(path, 0o700);
}
