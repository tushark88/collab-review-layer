import test from "node:test";
import assert from "node:assert/strict";
import {
  BRIDGE_CAPABILITIES,
  BRIDGE_PROTOCOL,
  BRIDGE_PROTOCOL_VERSIONS,
  BridgeProtocolError,
  BridgeSession,
  type BridgeCapability,
  type BridgeEnvelope,
  type BridgeOperationalMessage,
} from "../src/bridge.ts";
import type { Anchor } from "../src/domain.ts";

const HOST_ORIGIN = "https://reviews.example.test";
const PROTOTYPE_ORIGIN = "https://prototype.example.test";
const SESSION_ID = "review-session-1";
const NONCE = "0123456789abcdef0123456789abcdef";

const anchor: Anchor = {
  schemaVersion: 1,
  semantic: { role: "button", accessibleName: "Synthetic action", testId: "synthetic-action" },
  text: { exact: "Synthetic action", prefix: "Before", suffix: "After" },
  geometry: { xRatio: 0.5, yRatio: 0.25 },
  scroll: { xRatio: 0, yRatio: 0.4 },
};

function sessions(capabilities: readonly BridgeCapability[] = BRIDGE_CAPABILITIES): { host: BridgeSession; prototype: BridgeSession } {
  return {
    host: new BridgeSession({ role: "host", sessionId: SESSION_ID, nonce: NONCE, allowedOrigins: [PROTOTYPE_ORIGIN], capabilities }),
    prototype: new BridgeSession({ role: "prototype", sessionId: SESSION_ID, nonce: NONCE, allowedOrigins: [HOST_ORIGIN], capabilities }),
  };
}

function connect(host: BridgeSession, prototype: BridgeSession): void {
  const hello = host.initiate();
  const accepted = prototype.receive(HOST_ORIGIN, hello);
  assert.equal(accepted.kind, "handshake");
  assert.ok(accepted.reply);
  const ready = host.receive(PROTOTYPE_ORIGIN, accepted.reply);
  assert.equal(ready.kind, "handshake");
  assert.equal(ready.reply, undefined);
}

function expectBridgeError(code: BridgeProtocolError["code"], action: () => unknown): void {
  assert.throws(action, (error: unknown) => error instanceof BridgeProtocolError && error.code === code);
}

test("bridge handshake binds exact origins and negotiates capabilities", () => {
  assert.equal(Object.isFrozen(BRIDGE_PROTOCOL_VERSIONS), true);
  assert.equal(Object.isFrozen(BRIDGE_CAPABILITIES), true);
  assert.throws(() => (BRIDGE_CAPABILITIES as unknown as string[]).push("future-capability"), TypeError);
  const host = new BridgeSession({
    role: "host",
    sessionId: SESSION_ID,
    nonce: NONCE,
    allowedOrigins: [PROTOTYPE_ORIGIN],
    capabilities: BRIDGE_CAPABILITIES,
  });
  const prototype = new BridgeSession({
    role: "prototype",
    sessionId: SESSION_ID,
    nonce: NONCE,
    allowedOrigins: [HOST_ORIGIN],
    capabilities: ["navigation", "viewport", "anchor"],
  });

  const hello = host.initiate();
  assert.equal(hello.protocol, BRIDGE_PROTOCOL);
  assert.equal(hello.sequence, 0);
  assert.equal(host.snapshot().state, "negotiating");

  const accepted = prototype.receive(HOST_ORIGIN, hello);
  assert.equal(accepted.kind, "handshake");
  assert.ok(accepted.reply);
  assert.deepEqual(accepted.snapshot.capabilities, ["navigation", "viewport", "anchor"]);
  assert.equal(accepted.snapshot.peerOrigin, HOST_ORIGIN);

  const ready = host.receive(PROTOTYPE_ORIGIN, accepted.reply);
  assert.equal(ready.kind, "handshake");
  assert.deepEqual(ready.snapshot.capabilities, ["navigation", "viewport", "anchor"]);
  assert.equal(ready.snapshot.protocolVersion, 1);
  assert.equal(ready.snapshot.peerOrigin, PROTOTYPE_ORIGIN);
});

test("bridge operational messages round trip through the negotiated interface", () => {
  const { host, prototype } = sessions();
  connect(host, prototype);
  const messages: BridgeOperationalMessage[] = [
    { type: "navigation", mode: "request", route: "/prototype?step=2#details" },
    { type: "focus", mode: "request", focused: true, anchorId: "anchor-1" },
    { type: "viewport", mode: "request", viewportId: "mobile", width: 390, height: 844, devicePixelRatio: 3 },
    { type: "variant", mode: "request", variantId: "control" },
    { type: "anchor", mode: "request", anchor },
  ];

  for (const message of messages) {
    const received = prototype.receive(HOST_ORIGIN, host.send(message));
    assert.equal(received.kind, "message");
    assert.deepEqual(received.message, message);
  }

  const reports: BridgeOperationalMessage[] = [
    { type: "navigation", mode: "report", route: "/reported" },
    { type: "focus", mode: "report", focused: false },
    { type: "viewport", mode: "report", viewportId: "desktop", width: 1_440, height: 900, devicePixelRatio: 2 },
    { type: "variant", mode: "report", variantId: "reported" },
    { type: "anchor", mode: "report", anchor, status: "attached" },
  ];
  for (const message of reports) {
    const received = host.receive(PROTOTYPE_ORIGIN, prototype.send(message));
    assert.equal(received.kind, "message");
    assert.deepEqual(received.message, message);
  }
});

test("bridge preserves multiline text anchors", () => {
  const { host, prototype } = sessions(["anchor"]);
  connect(host, prototype);
  const multiline: Anchor = {
    ...anchor,
    text: { exact: "First block\nSecond block", prefix: "Before\r\nline", suffix: "After\nline" },
  };
  const received = prototype.receive(HOST_ORIGIN, host.send({ type: "anchor", mode: "request", anchor: multiline }));
  assert.equal(received.kind, "message");
  assert.deepEqual(received.message, { type: "anchor", mode: "request", anchor: multiline });
});

test("bridge rejects unallowed or changed origins without advancing state", () => {
  const host = new BridgeSession({ role: "host", sessionId: SESSION_ID, nonce: NONCE, allowedOrigins: [PROTOTYPE_ORIGIN], capabilities: ["navigation"] });
  const prototype = new BridgeSession({
    role: "prototype",
    sessionId: SESSION_ID,
    nonce: NONCE,
    allowedOrigins: [HOST_ORIGIN, "https://alternate.example.test"],
    capabilities: ["navigation"],
  });
  const hello = host.initiate();
  expectBridgeError("invalid_origin", () => prototype.receive("https://attacker.example.test", hello));
  const accepted = prototype.receive(HOST_ORIGIN, hello);
  assert.equal(accepted.kind, "handshake");
  assert.ok(accepted.reply);
  host.receive(PROTOTYPE_ORIGIN, accepted.reply);

  const navigation = host.send({ type: "navigation", mode: "request", route: "/next" });
  expectBridgeError("invalid_origin", () => prototype.receive("https://alternate.example.test", navigation));
  assert.equal(prototype.snapshot().nextInboundSequence, 1);
});

test("bridge origin configuration rejects wildcards, paths, credentials, and insecure remote origins", () => {
  const configure = (origin: string) => new BridgeSession({ role: "host", sessionId: SESSION_ID, nonce: NONCE, allowedOrigins: [origin], capabilities: [] });
  expectBridgeError("invalid_origin", () => configure("*"));
  expectBridgeError("invalid_origin", () => configure("https://prototype.example.test/path"));
  expectBridgeError("invalid_origin", () => configure("https://user:secret@prototype.example.test"));
  expectBridgeError("invalid_origin", () => configure("http://prototype.example.test"));
  assert.doesNotThrow(() => configure("http://localhost:3000"));
});

test("bridge rejects unsupported versions explicitly", () => {
  const { host, prototype } = sessions(["navigation"]);
  const hello = structuredClone(host.initiate()) as BridgeEnvelope;
  assert.equal(hello.message.type, "bridge.hello");
  if (hello.message.type !== "bridge.hello") assert.fail("expected hello");
  hello.message.supportedVersions = [2];
  hello.message.capabilities.push("future-capability");

  const rejected = prototype.receive(HOST_ORIGIN, hello);
  assert.equal(rejected.kind, "handshake");
  assert.ok(rejected.reply);
  assert.equal(rejected.reply.message.type, "bridge.reject");
  const hostResult = host.receive(PROTOTYPE_ORIGIN, rejected.reply);
  assert.equal(hostResult.snapshot.state, "rejected");
  assert.equal(prototype.snapshot().state, "rejected");
});

test("bridge ignores future hello capabilities and rejects forged ready capabilities", () => {
  const first = sessions(["navigation"]);
  const hello = structuredClone(first.host.initiate()) as BridgeEnvelope;
  assert.equal(hello.message.type, "bridge.hello");
  if (hello.message.type !== "bridge.hello") assert.fail("expected hello");
  hello.message.capabilities.push("future-capability");
  const accepted = first.prototype.receive(HOST_ORIGIN, hello);
  assert.equal(accepted.kind, "handshake");
  assert.ok(accepted.reply);
  first.host.receive(PROTOTYPE_ORIGIN, accepted.reply);
  assert.deepEqual(first.host.snapshot().capabilities, ["navigation"]);

  const second = sessions(["navigation"]);
  const secondAccepted = second.prototype.receive(HOST_ORIGIN, second.host.initiate());
  assert.equal(secondAccepted.kind, "handshake");
  assert.ok(secondAccepted.reply);
  const forged = structuredClone(secondAccepted.reply) as BridgeEnvelope;
  assert.equal(forged.message.type, "bridge.ready");
  if (forged.message.type !== "bridge.ready") assert.fail("expected ready");
  forged.message.capabilities.push("focus");
  expectBridgeError("invalid_message", () => second.host.receive(PROTOTYPE_ORIGIN, forged));
});

test("bridge requires an active handshake and negotiated capabilities", () => {
  const { host, prototype } = sessions(["navigation"]);
  expectBridgeError("invalid_state", () => host.send({ type: "navigation", mode: "request", route: "/next" }));
  connect(host, prototype);
  expectBridgeError("unsupported_capability", () => host.send({ type: "viewport", mode: "request", viewportId: "mobile", width: 390, height: 844, devicePixelRatio: 3 }));
});

test("bridge rejects replay, gaps, and session confusion", () => {
  const { host, prototype } = sessions(["navigation"]);
  connect(host, prototype);
  const first = host.send({ type: "navigation", mode: "request", route: "/one" });
  prototype.receive(HOST_ORIGIN, first);
  expectBridgeError("invalid_sequence", () => prototype.receive(HOST_ORIGIN, first));

  const second = structuredClone(host.send({ type: "navigation", mode: "request", route: "/two" }));
  second.sessionId = "another-session";
  expectBridgeError("session_mismatch", () => prototype.receive(HOST_ORIGIN, second));
  assert.equal(prototype.snapshot().nextInboundSequence, 2);
});

test("bridge validates message payloads and unknown fields before sending", () => {
  const { host, prototype } = sessions();
  connect(host, prototype);
  expectBridgeError("invalid_message", () => host.send({ type: "navigation", mode: "request", route: "https://example.test/escape" }));
  expectBridgeError("invalid_message", () => host.send({ type: "navigation", mode: "request", route: "/\\\\attacker.example.test/escape" }));
  expectBridgeError("invalid_message", () => host.send({ type: "navigation", mode: "request", route: "/\t/attacker.example.test/escape" }));
  expectBridgeError("invalid_message", () => host.send({ type: "viewport", mode: "request", viewportId: "mobile", width: 0, height: 844, devicePixelRatio: 3 }));
  expectBridgeError("invalid_message", () => host.send({ type: "anchor", mode: "report", anchor: { ...anchor, geometry: { xRatio: 2, yRatio: 0 } }, status: "attached" }));

  const envelope = structuredClone(host.send({ type: "variant", mode: "request", variantId: "control" })) as BridgeEnvelope & { unexpected?: boolean };
  envelope.unexpected = true;
  expectBridgeError("invalid_message", () => prototype.receive(HOST_ORIGIN, envelope));
});

test("bridge bounds inbound message size and JSON compatibility", () => {
  const host = new BridgeSession({ role: "host", sessionId: SESSION_ID, nonce: NONCE, allowedOrigins: [PROTOTYPE_ORIGIN], capabilities: BRIDGE_CAPABILITIES });
  const prototype = new BridgeSession({ role: "prototype", sessionId: SESSION_ID, nonce: NONCE, allowedOrigins: [HOST_ORIGIN], capabilities: BRIDGE_CAPABILITIES, maxMessageBytes: 64 });
  expectBridgeError("invalid_message", () => prototype.receive(HOST_ORIGIN, host.initiate()));

  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  const fresh = sessions().prototype;
  expectBridgeError("invalid_message", () => fresh.receive(HOST_ORIGIN, cyclic));

  const accessor = structuredClone(sessions().host.initiate()) as BridgeEnvelope & { payload?: unknown };
  Object.defineProperty(accessor, "payload", { enumerable: true, get: () => "not allowed" });
  expectBridgeError("invalid_message", () => fresh.receive(HOST_ORIGIN, accessor));

  let hiddenAccessorRan = false;
  const hiddenMessage = sessions().host.initiate();
  const originalMessage = hiddenMessage.message;
  Object.defineProperty(hiddenMessage, "message", { enumerable: false, get: () => { hiddenAccessorRan = true; return originalMessage; } });
  expectBridgeError("invalid_message", () => fresh.receive(HOST_ORIGIN, hiddenMessage));
  assert.equal(hiddenAccessorRan, false);

  const hiddenCapabilities = sessions().host.initiate();
  assert.equal(hiddenCapabilities.message.type, "bridge.hello");
  if (hiddenCapabilities.message.type !== "bridge.hello") assert.fail("expected hello");
  Object.defineProperty(hiddenCapabilities.message, "capabilities", { enumerable: false, value: Array.from({ length: 10_000 }, () => "navigation") });
  expectBridgeError("invalid_message", () => fresh.receive(HOST_ORIGIN, hiddenCapabilities));

  let inheritedMessageRan = false;
  const polluted = sessions().host.initiate();
  delete (polluted as Partial<BridgeEnvelope>).message;
  Object.defineProperty(Object.prototype, "message", { configurable: true, enumerable: true, get: () => { inheritedMessageRan = true; return {}; } });
  try {
    expectBridgeError("invalid_message", () => fresh.receive(HOST_ORIGIN, polluted));
    assert.equal(inheritedMessageRan, false);
  } finally {
    delete (Object.prototype as { message?: unknown }).message;
  }

  let arrayAccessorRan = false;
  const accessorHello = sessions().host.initiate();
  assert.equal(accessorHello.message.type, "bridge.hello");
  if (accessorHello.message.type !== "bridge.hello") assert.fail("expected hello");
  const accessorCapabilities: string[] = [];
  Object.defineProperty(accessorCapabilities, "0", { enumerable: true, get: () => { arrayAccessorRan = true; return "navigation"; } });
  accessorCapabilities.length = 1;
  accessorHello.message.capabilities = accessorCapabilities;
  expectBridgeError("invalid_message", () => fresh.receive(HOST_ORIGIN, accessorHello));
  assert.equal(arrayAccessorRan, false);

  const preview = sessions(["anchor"]);
  connect(preview.host, preview.prototype);
  const unicodeAnchor: Anchor = { ...anchor, text: { exact: "旅程📍".repeat(20), prefix: "\b\t\n\f\r", suffix: "\\\"" } };
  const unicodeEnvelope = preview.host.send({ type: "anchor", mode: "request", anchor: unicodeAnchor });
  const unicodeBytes = new TextEncoder().encode(JSON.stringify(unicodeEnvelope)).byteLength;
  const unicodeHost = new BridgeSession({ role: "host", sessionId: SESSION_ID, nonce: NONCE, allowedOrigins: [PROTOTYPE_ORIGIN], capabilities: ["anchor"], maxMessageBytes: unicodeBytes });
  const unicodePrototype = new BridgeSession({ role: "prototype", sessionId: SESSION_ID, nonce: NONCE, allowedOrigins: [HOST_ORIGIN], capabilities: ["anchor"], maxMessageBytes: unicodeBytes });
  connect(unicodeHost, unicodePrototype);
  const unicodeReceived = unicodePrototype.receive(HOST_ORIGIN, unicodeHost.send({ type: "anchor", mode: "request", anchor: unicodeAnchor }));
  assert.equal(unicodeReceived.kind, "message");

  const surrogateHost = sessions(["anchor"]).host;
  const surrogatePrototype = new BridgeSession({ role: "prototype", sessionId: SESSION_ID, nonce: NONCE, allowedOrigins: [HOST_ORIGIN], capabilities: ["anchor"], maxMessageBytes: 512 });
  connect(surrogateHost, surrogatePrototype);
  const unmatchedSurrogates: Anchor = { ...anchor, text: { exact: "\ud800".repeat(100) } };
  expectBridgeError("invalid_message", () => surrogatePrototype.receive(HOST_ORIGIN, surrogateHost.send({ type: "anchor", mode: "request", anchor: unmatchedSurrogates })));

  const limitedHost = new BridgeSession({ role: "host", sessionId: SESSION_ID, nonce: NONCE, allowedOrigins: [PROTOTYPE_ORIGIN], capabilities: ["navigation", "anchor"], maxMessageBytes: 512 });
  const limitedPrototype = new BridgeSession({ role: "prototype", sessionId: SESSION_ID, nonce: NONCE, allowedOrigins: [HOST_ORIGIN], capabilities: ["navigation", "anchor"], maxMessageBytes: 512 });
  connect(limitedHost, limitedPrototype);
  expectBridgeError("invalid_message", () => limitedHost.send({ type: "anchor", mode: "request", anchor: { ...anchor, text: { exact: "x".repeat(1_000) } } }));
  assert.equal(limitedHost.snapshot().nextOutboundSequence, 1);
  const afterOversize = limitedPrototype.receive(HOST_ORIGIN, limitedHost.send({ type: "navigation", mode: "request", route: "/still-contiguous" }));
  assert.equal(afterOversize.kind, "message");

  let lateAccessorRan = false;
  const manyFields = sessions().host.initiate() as BridgeEnvelope & Record<string, unknown>;
  for (let index = 0; index < 100; index += 1) manyFields[`padding-${index}`] = "xxxxxxxxxxxxxxxx";
  Object.defineProperty(manyFields, "late", { enumerable: true, get: () => { lateAccessorRan = true; return "not reached"; } });
  const earlyCutoff = new BridgeSession({ role: "prototype", sessionId: SESSION_ID, nonce: NONCE, allowedOrigins: [HOST_ORIGIN], capabilities: ["navigation"], maxMessageBytes: 512 });
  expectBridgeError("invalid_message", () => earlyCutoff.receive(HOST_ORIGIN, manyFields));
  assert.equal(lateAccessorRan, false);
});
