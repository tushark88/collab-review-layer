export interface JsonTransport {
  request<T>(input: { method: "GET" | "POST" | "PATCH"; url: string; headers: Record<string, string>; body?: unknown }): Promise<T>;
}

export class FetchJsonTransport implements JsonTransport {
  readonly fetcher: typeof fetch;
  constructor(fetcher: typeof fetch = fetch) { this.fetcher = fetcher; }
  async request<T>(input: { method: "GET" | "POST" | "PATCH"; url: string; headers: Record<string, string>; body?: unknown }): Promise<T> {
    const response = await this.fetcher(input.url, { method: input.method, headers: { "content-type": "application/json", ...input.headers }, body: input.body === undefined ? undefined : JSON.stringify(input.body) });
    if (!response.ok) throw new Error(`tracker request failed: ${response.status}`);
    return await response.json() as T;
  }
}
