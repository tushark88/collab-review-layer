import assert from "node:assert/strict";
import test from "node:test";
import { assertSecureEndpoint, FetchJsonTransport, TrackerHttpError } from "../src/adapters/http.ts";

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

test("JSON transport bounds response bodies and exposes status without response content", async () => {
  const missing: typeof fetch = async () => new Response("private provider error", { status: 404 });
  await assert.rejects(
    () => new FetchJsonTransport(missing).request({ method: "GET", url: "https://tracker.example.test/missing", headers: {} }),
    (error: unknown) => error instanceof TrackerHttpError && error.status === 404 && !error.message.includes("private provider error"),
  );

  const oversized: typeof fetch = async () => new Response(JSON.stringify({ value: "x".repeat(200) }), { status: 200 });
  await assert.rejects(
    () => new FetchJsonTransport(oversized, 500, 100).request({ method: "GET", url: "https://tracker.example.test/large", headers: {} }),
    /size limit/,
  );
});
