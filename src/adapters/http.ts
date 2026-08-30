export interface JsonTransport {
  request<T>(input: { method: "GET" | "POST" | "PATCH"; url: string; headers: Record<string, string>; body?: unknown }): Promise<T>;
}

export class TrackerHttpError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`tracker request failed: ${status}`);
    this.name = "TrackerHttpError";
    this.status = status;
  }
}

export class FetchJsonTransport implements JsonTransport {
  readonly fetcher: typeof fetch;
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
  constructor(fetcher: typeof fetch = fetch, timeoutMs = 10_000, maxResponseBytes = 2_097_152) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("timeout must be positive");
    if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1) throw new Error("response size limit must be positive");
    this.fetcher = fetcher;
    this.timeoutMs = timeoutMs;
    this.maxResponseBytes = maxResponseBytes;
  }
  async request<T>(input: { method: "GET" | "POST" | "PATCH"; url: string; headers: Record<string, string>; body?: unknown }): Promise<T> {
    assertSecureEndpoint(input.url);
    const response = await this.fetcher(input.url, {
      method: input.method,
      headers: { "content-type": "application/json", ...input.headers },
      body: input.body === undefined ? undefined : JSON.stringify(input.body),
      redirect: "error",
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) throw new TrackerHttpError(response.status);
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > this.maxResponseBytes) throw new Error("tracker response exceeds size limit");
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > this.maxResponseBytes) throw new Error("tracker response exceeds size limit");
    try {
      return JSON.parse(new TextDecoder().decode(bytes)) as T;
    } catch {
      throw new Error("tracker returned invalid JSON");
    }
  }
}

export function assertSecureEndpoint(value: string): void {
  const url = new URL(value);
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) throw new Error("tracker endpoint must use HTTPS");
  if (url.username || url.password) throw new Error("tracker endpoint must not contain credentials");
}
