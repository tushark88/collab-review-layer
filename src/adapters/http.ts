export interface JsonTransport {
  request<T>(input: { method: "GET" | "POST" | "PATCH"; url: string; headers: Record<string, string>; body?: unknown }): Promise<T>;
}

export class FetchJsonTransport implements JsonTransport {
  readonly fetcher: typeof fetch;
  readonly timeoutMs: number;
  constructor(fetcher: typeof fetch = fetch, timeoutMs = 10_000) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("timeout must be positive");
    this.fetcher = fetcher;
    this.timeoutMs = timeoutMs;
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
    if (!response.ok) throw new Error(`tracker request failed: ${response.status}`);
    return await response.json() as T;
  }
}

export function assertSecureEndpoint(value: string): void {
  const url = new URL(value);
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) throw new Error("tracker endpoint must use HTTPS");
  if (url.username || url.password) throw new Error("tracker endpoint must not contain credentials");
}
