import { createHmac, timingSafeEqual } from "node:crypto";

export const MAX_WEBHOOK_BODY_BYTES = 1_048_576;

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
  return deliveryId;
}
