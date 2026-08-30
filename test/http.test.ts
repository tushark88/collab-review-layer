import assert from "node:assert/strict";
import test from "node:test";
import { assertSecureEndpoint, FetchJsonTransport } from "../src/adapters/http.ts";

test("tracker endpoints require HTTPS outside loopback development", () => {
  assert.doesNotThrow(() => assertSecureEndpoint("https://tracker.example.test/graphql"));
  assert.doesNotThrow(() => assertSecureEndpoint("http://localhost:3000/api"));
  assert.throws(() => assertSecureEndpoint("http://tracker.example.test/api"), /HTTPS/);
  assert.throws(() => assertSecureEndpoint("https://user:secret@tracker.example.test/api"), /credentials/);
});

test("JSON transport refuses redirects and bounds request duration", async () => {
  let observed: RequestInit | undefined;
  const fetcher: typeof fetch = async (_input, init) => {
    observed = init;
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const result = await new FetchJsonTransport(fetcher, 500).request<{ ok: boolean }>({ method: "GET", url: "https://tracker.example.test/api", headers: {} });
  assert.deepEqual(result, { ok: true });
  assert.equal(observed?.redirect, "error");
  assert.ok(observed?.signal);
});
