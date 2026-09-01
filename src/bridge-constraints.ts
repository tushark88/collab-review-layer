export type BridgeOriginConstraintProblem = "invalid" | "https_required" | "origin_only";
export type BridgeRouteConstraintProblem = "invalid" | "origin_relative" | "origin_change";

export type BridgeConstraintResult<T, Problem extends string> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly problem: Problem };

const ROUTE_MAXIMUM_LENGTH = 2_048;
const VIEWPORT_DIMENSION_MINIMUM = 1;
const VIEWPORT_DIMENSION_MAXIMUM = 16_384;
const DEVICE_PIXEL_RATIO_MINIMUM = 0.1;
const DEVICE_PIXEL_RATIO_MAXIMUM = 10;
const ROUTE_BASE = new URL("https://bridge-constraints.invalid");

/**
 * Internal owner of the constraints shared by bridge wire messages, browser
 * transport configuration, and shell-generated bridge requests. Callers map
 * failures to their own public error type and domain-specific message.
 */
export function readBridgeOrigin(value: unknown): BridgeConstraintResult<string, BridgeOriginConstraintProblem> {
  if (typeof value !== "string" || value === "*" || value === "null") return { ok: false, problem: "invalid" };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, problem: "invalid" };
  }
  if (url.username || url.password || url.origin === "null") return { ok: false, problem: "invalid" };
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    return { ok: false, problem: "https_required" };
  }
  if (url.pathname !== "/" || url.search || url.hash) return { ok: false, problem: "origin_only" };
  return { ok: true, value: url.origin };
}

export function readBridgeRoute(value: unknown): BridgeConstraintResult<string, BridgeRouteConstraintProblem> {
  if (
    typeof value !== "string"
    || value.length > ROUTE_MAXIMUM_LENGTH
    || value.includes("\u0000")
    || value.includes("\r")
    || value.includes("\n")
    || !value.trim()
  ) {
    return { ok: false, problem: "invalid" };
  }
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\") || /[\u0000-\u001f\u007f]/u.test(value)) {
    return { ok: false, problem: "origin_relative" };
  }
  let resolved: URL;
  try {
    resolved = new URL(value, ROUTE_BASE);
  } catch {
    return { ok: false, problem: "origin_relative" };
  }
  if (resolved.origin !== ROUTE_BASE.origin) return { ok: false, problem: "origin_change" };
  return { ok: true, value };
}

export function readBridgeViewportDimension(value: unknown): BridgeConstraintResult<number, "invalid"> {
  if (
    !Number.isSafeInteger(value)
    || (value as number) < VIEWPORT_DIMENSION_MINIMUM
    || (value as number) > VIEWPORT_DIMENSION_MAXIMUM
  ) {
    return { ok: false, problem: "invalid" };
  }
  return { ok: true, value: value as number };
}

export function readBridgeDevicePixelRatio(value: unknown): BridgeConstraintResult<number, "invalid"> {
  if (
    typeof value !== "number"
    || !Number.isFinite(value)
    || value < DEVICE_PIXEL_RATIO_MINIMUM
    || value > DEVICE_PIXEL_RATIO_MAXIMUM
  ) {
    return { ok: false, problem: "invalid" };
  }
  return { ok: true, value };
}
