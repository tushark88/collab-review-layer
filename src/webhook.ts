import { createHmac, timingSafeEqual } from "node:crypto";

export function verifyHmacSha256(body: Uint8Array, supplied: string | undefined, secret: string, prefix = "sha256="): boolean {
  if (!supplied?.startsWith(prefix) || !secret) return false;
  const expected = createHmac("sha256", secret).update(body).digest("hex");
  const actual = supplied.slice(prefix.length);
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
}

export function requireFreshTimestamp(timestamp: string | undefined, nowMs: number, toleranceMs = 5 * 60_000): void {
  const value = timestamp ? Number(timestamp) : Number.NaN;
  const milliseconds = value < 10_000_000_000 ? value * 1000 : value;
  if (!Number.isFinite(milliseconds) || Math.abs(nowMs - milliseconds) > toleranceMs) throw new Error("stale or missing webhook timestamp");
}
