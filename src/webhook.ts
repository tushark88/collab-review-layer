import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

export const MAX_WEBHOOK_BODY_BYTES = 1_048_576;
export const MAX_WEBHOOK_DELIVERY_ID_BYTES = 512;

export interface WebhookDeliveryLedger {
  claim(provider: string, deliveryId: string): Promise<boolean>;
}

export class InMemoryWebhookDeliveryLedger implements WebhookDeliveryLedger {
  readonly #claims = new Set<string>();

  async claim(provider: string, deliveryId: string): Promise<boolean> {
    const key = deliveryKey(provider, deliveryId);
    if (this.#claims.has(key)) return false;
    this.#claims.add(key);
    return true;
  }
}

/**
 * Durable local reference adapter. Atomic exclusive file creation makes claims
 * safe across multiple processes sharing the same directory. Delivery ids are
 * hashed and never written to disk.
 */
export class FileWebhookDeliveryLedger implements WebhookDeliveryLedger {
  readonly directory: string;

  constructor(directory: string) {
    if (!isAbsolute(directory)) throw new Error("webhook delivery directory must be absolute");
    this.directory = directory;
  }

  async claim(provider: string, deliveryId: string): Promise<boolean> {
    const key = deliveryKey(provider, deliveryId);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      await writeFile(join(this.directory, key), "", { flag: "wx", mode: 0o600 });
      return true;
    } catch (error) {
      if (isAlreadyExists(error)) return false;
      throw error;
    }
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

export async function requireUniqueDelivery(ledger: WebhookDeliveryLedger, provider: string, deliveryId: string): Promise<void> {
  if (!await ledger.claim(provider, requireDeliveryId(deliveryId))) throw new Error("duplicate webhook delivery");
}

function deliveryKey(provider: string, deliveryId: string): string {
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(provider)) throw new Error("invalid webhook provider");
  requireDeliveryId(deliveryId);
  return createHash("sha256").update(provider).update("\u0000").update(deliveryId).digest("hex");
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}
