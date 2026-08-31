import test from "node:test";
import assert from "node:assert/strict";
import {
  BrowserBridgeAdapter,
  BrowserBridgeTransportError,
  type BrowserBridgeEvent,
  type BrowserBridgeEventSource,
  type BrowserBridgeMessageEvent,
  type BrowserBridgeMessageListener,
  type BrowserBridgePeerWindow,
} from "../src/browser-bridge.ts";
import { BRIDGE_CAPABILITIES, BRIDGE_PROTOCOL, BridgeProtocolError } from "../src/bridge.ts";

const HOST_ORIGIN = "https://reviews.example.test";
const PROTOTYPE_ORIGIN = "https://prototype.example.test";
const SESSION_ID = "browser-review-session-1";
const NONCE = "0123456789abcdef0123456789abcdef";

class FakeEventSource implements BrowserBridgeEventSource {
  readonly listeners = new Set<BrowserBridgeMessageListener>();
  addCount = 0;
  removeCount = 0;

  addEventListener(type: "message", listener: BrowserBridgeMessageListener): void {
    assert.equal(type, "message");
    this.addCount += 1;
    this.listeners.add(listener);
  }

  removeEventListener(type: "message", listener: BrowserBridgeMessageListener): void {
    assert.equal(type, "message");
    this.removeCount += 1;
    this.listeners.delete(listener);
  }

  dispatch(event: BrowserBridgeMessageEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }
}

class FakePeerWindow implements BrowserBridgePeerWindow {
  readonly posts: Array<{ message: unknown; targetOrigin: string }> = [];
  readonly #destination: FakeEventSource;
  readonly #sourceForDestination: () => BrowserBridgePeerWindow;
  readonly #senderOrigin: string;
  failNextPost = false;

  constructor(
    destination: FakeEventSource,
    sourceForDestination: () => BrowserBridgePeerWindow,
    senderOrigin: string,
  ) {
    this.#destination = destination;
    this.#sourceForDestination = sourceForDestination;
    this.#senderOrigin = senderOrigin;
  }

  postMessage(message: unknown, targetOrigin: string): void {
    if (this.failNextPost) {
      this.failNextPost = false;
      throw new Error("synthetic post failure");
    }
    const cloned = structuredClone(message);
    this.posts.push({ message: cloned, targetOrigin });
    this.#destination.dispatch({ data: cloned, origin: this.#senderOrigin, source: this.#sourceForDestination() });
  }
}

interface LinkedAdapters {
  host: BrowserBridgeAdapter;
  prototype: BrowserBridgeAdapter;
  hostSource: FakeEventSource;
  prototypeSource: FakeEventSource;
  hostPeer: FakePeerWindow;
  prototypePeer: FakePeerWindow;
  hostEvents: BrowserBridgeEvent[];
  prototypeEvents: BrowserBridgeEvent[];
}

function linkedAdapters(): LinkedAdapters {
  const hostSource = new FakeEventSource();
  const prototypeSource = new FakeEventSource();
  let hostPeer: FakePeerWindow;
  let prototypePeer: FakePeerWindow;
  hostPeer = new FakePeerWindow(prototypeSource, () => prototypePeer, HOST_ORIGIN);
  prototypePeer = new FakePeerWindow(hostSource, () => hostPeer, PROTOTYPE_ORIGIN);
  const hostEvents: BrowserBridgeEvent[] = [];
  const prototypeEvents: BrowserBridgeEvent[] = [];
  const host = new BrowserBridgeAdapter({
    role: "host",
    sessionId: SESSION_ID,
    nonce: NONCE,
    peerOrigin: PROTOTYPE_ORIGIN,
    capabilities: BRIDGE_CAPABILITIES,
    eventSource: hostSource,
    peerWindow: hostPeer,
    onEvent: (event) => hostEvents.push(event),
  });
  const prototype = new BrowserBridgeAdapter({
    role: "prototype",
    sessionId: SESSION_ID,
    nonce: NONCE,
    peerOrigin: HOST_ORIGIN,
    capabilities: BRIDGE_CAPABILITIES,
    eventSource: prototypeSource,
    peerWindow: prototypePeer,
    onEvent: (event) => prototypeEvents.push(event),
  });
  return { host, prototype, hostSource, prototypeSource, hostPeer, prototypePeer, hostEvents, prototypeEvents };
}

function connect(linked: LinkedAdapters): void {
  linked.prototype.start();
  linked.host.start();
  assert.equal(linked.host.snapshot().session.state, "active");
  assert.equal(linked.prototype.snapshot().session.state, "active");
}

function expectTransportError(code: BrowserBridgeTransportError["code"], action: () => unknown): void {
  assert.throws(action, (error: unknown) => error instanceof BrowserBridgeTransportError && error.code === code);
}

test("browser adapter completes the handshake and carries bidirectional messages", () => {
  const linked = linkedAdapters();
  connect(linked);

  linked.host.send({ type: "navigation", mode: "request", route: "/synthetic" });
  linked.prototype.send({ type: "viewport", mode: "report", viewportId: "mobile", width: 390, height: 844, devicePixelRatio: 3 });

  const prototypeMessages = linked.prototypeEvents.filter((event) => event.type === "message");
  const hostMessages = linked.hostEvents.filter((event) => event.type === "message");
  assert.deepEqual(prototypeMessages.map((event) => event.message), [{ type: "navigation", mode: "request", route: "/synthetic" }]);
  assert.deepEqual(hostMessages.map((event) => event.message), [{ type: "viewport", mode: "report", viewportId: "mobile", width: 390, height: 844, devicePixelRatio: 3 }]);
  assert.ok(linked.hostPeer.posts.every((post) => post.targetOrigin === PROTOTYPE_ORIGIN));
  assert.ok(linked.prototypePeer.posts.every((post) => post.targetOrigin === HOST_ORIGIN));
  assert.equal(linked.hostSource.addCount, 1);
  assert.equal(linked.prototypeSource.addCount, 1);
});

test("browser adapter ignores other windows, unrelated messages, and other bridge sessions", () => {
  const linked = linkedAdapters();
  connect(linked);
  const before = linked.host.snapshot().session.nextInboundSequence;
  const errorsBefore = linked.hostEvents.filter((event) => event.type === "error").length;

  linked.hostSource.dispatch({ data: { protocol: BRIDGE_PROTOCOL, sessionId: SESSION_ID }, origin: PROTOTYPE_ORIGIN, source: {} });
  linked.hostSource.dispatch({ data: { type: "unrelated" }, origin: PROTOTYPE_ORIGIN, source: linked.hostPeer });
  linked.hostSource.dispatch({ data: { protocol: BRIDGE_PROTOCOL, sessionId: "another-session" }, origin: PROTOTYPE_ORIGIN, source: linked.hostPeer });
  linked.hostSource.dispatch({ data: { protocol: BRIDGE_PROTOCOL }, origin: PROTOTYPE_ORIGIN, source: linked.hostPeer });
  linked.hostSource.dispatch({ data: { protocol: BRIDGE_PROTOCOL, sessionId: 1 }, origin: PROTOTYPE_ORIGIN, source: linked.hostPeer });
  const accessorSession = { protocol: BRIDGE_PROTOCOL };
  Object.defineProperty(accessorSession, "sessionId", { enumerable: true, get: () => SESSION_ID });
  linked.hostSource.dispatch({ data: accessorSession, origin: PROTOTYPE_ORIGIN, source: linked.hostPeer });
  const hiddenSession = { protocol: BRIDGE_PROTOCOL };
  Object.defineProperty(hiddenSession, "sessionId", { enumerable: false, value: SESSION_ID });
  linked.hostSource.dispatch({ data: hiddenSession, origin: PROTOTYPE_ORIGIN, source: linked.hostPeer });
  assert.equal(linked.host.snapshot().session.nextInboundSequence, before);
  assert.equal(linked.hostEvents.filter((event) => event.type === "error").length, errorsBefore);

  linked.prototype.send({ type: "navigation", mode: "report", route: "/still-connected" });
  assert.equal(linked.host.snapshot().session.nextInboundSequence, before + 1);
});

test("browser adapter closes when the expected peer window changes origin", () => {
  const linked = linkedAdapters();
  connect(linked);
  linked.hostSource.dispatch({
    data: { protocol: BRIDGE_PROTOCOL, sessionId: SESSION_ID },
    origin: "https://navigated.example.test",
    source: linked.hostPeer,
  });
  const errors = linked.hostEvents.filter((event) => event.type === "error");
  assert.deepEqual(errors.map((event) => event.error.code), ["invalid_origin"]);
  assert.equal(linked.host.snapshot().transportState, "closed");
});

test("browser adapter closes on a claimed-session protocol failure", () => {
  const linked = linkedAdapters();
  connect(linked);
  const before = linked.host.snapshot().session.nextInboundSequence;
  linked.hostSource.dispatch({
    data: { protocol: BRIDGE_PROTOCOL, sessionId: SESSION_ID },
    origin: PROTOTYPE_ORIGIN,
    source: linked.hostPeer,
  });
  const errors = linked.hostEvents.filter((event) => event.type === "error");
  assert.deepEqual(errors.map((event) => event.error.code), ["invalid_message"]);
  assert.equal(linked.host.snapshot().session.nextInboundSequence, before);
  assert.equal(linked.host.snapshot().transportState, "closed");
  assert.equal(linked.hostSource.listeners.size, 0);
});

test("browser adapter removes its listener and cannot restart after close", () => {
  const linked = linkedAdapters();
  connect(linked);
  linked.host.close();
  assert.equal(linked.host.snapshot().transportState, "closed");
  assert.equal(linked.hostSource.listeners.size, 0);
  assert.equal(linked.hostSource.removeCount, 1);
  linked.host.close();
  assert.equal(linked.hostSource.removeCount, 1);
  expectTransportError("invalid_state", () => linked.host.start());
  expectTransportError("invalid_state", () => linked.host.send({ type: "navigation", mode: "request", route: "/closed" }));
});

test("browser adapter closes after a synchronous post failure consumes a sequence", () => {
  const linked = linkedAdapters();
  connect(linked);
  linked.hostPeer.failNextPost = true;
  expectTransportError("transport_failure", () => linked.host.send({ type: "navigation", mode: "request", route: "/will-not-send" }));
  assert.equal(linked.host.snapshot().transportState, "closed");
  assert.equal(linked.hostSource.listeners.size, 0);
  expectTransportError("invalid_state", () => linked.host.send({ type: "navigation", mode: "request", route: "/cannot-retry" }));
});

test("browser adapter reports an asynchronous handshake reply failure and closes", () => {
  const linked = linkedAdapters();
  linked.prototypePeer.failNextPost = true;
  linked.prototype.start();
  linked.host.start();

  assert.equal(linked.prototype.snapshot().transportState, "closed");
  assert.equal(linked.prototypeSource.listeners.size, 0);
  const errors = linked.prototypeEvents.filter((event) => event.type === "error");
  assert.equal(errors.length, 1);
  assert.ok(errors[0]!.error instanceof BrowserBridgeTransportError);
  assert.equal(errors[0]!.error.code, "transport_failure");
  assert.equal(linked.host.snapshot().session.state, "negotiating");
});

test("browser adapter rejects unsafe target origins before attaching listeners", () => {
  const linked = linkedAdapters();
  const create = (peerOrigin: string) => new BrowserBridgeAdapter({
    role: "host",
    sessionId: SESSION_ID,
    nonce: NONCE,
    peerOrigin,
    capabilities: [],
    eventSource: linked.hostSource,
    peerWindow: linked.hostPeer,
    onEvent: () => undefined,
  });
  assert.throws(() => create("*"), (error: unknown) => error instanceof BridgeProtocolError && error.code === "invalid_origin");
  assert.throws(() => create("https://prototype.example.test/path"), (error: unknown) => error instanceof BridgeProtocolError && error.code === "invalid_origin");
  assert.throws(() => create("http://prototype.example.test"), (error: unknown) => error instanceof BridgeProtocolError && error.code === "invalid_origin");
  assert.equal(linked.hostSource.addCount, 0);
});

test("browser adapter closes if the consumer event callback throws", () => {
  const linked = linkedAdapters();
  const adapter = new BrowserBridgeAdapter({
    role: "prototype",
    sessionId: SESSION_ID,
    nonce: NONCE,
    peerOrigin: HOST_ORIGIN,
    capabilities: [],
    eventSource: linked.prototypeSource,
    peerWindow: linked.prototypePeer,
    onEvent: () => {
      throw new Error("synthetic consumer failure");
    },
  });
  assert.throws(() => adapter.start(), /synthetic consumer failure/);
  assert.equal(adapter.snapshot().transportState, "closed");
  assert.equal(linked.prototypeSource.listeners.size, 0);
});

test("browser adapter does not post a hello after its state callback closes it", () => {
  const linked = linkedAdapters();
  linked.prototype.start();
  let host: BrowserBridgeAdapter;
  host = new BrowserBridgeAdapter({
    role: "host",
    sessionId: SESSION_ID,
    nonce: NONCE,
    peerOrigin: PROTOTYPE_ORIGIN,
    capabilities: [],
    eventSource: linked.hostSource,
    peerWindow: linked.hostPeer,
    onEvent: (event) => {
      if (event.type === "state" && event.snapshot.transportState === "listening") host.close();
    },
  });
  host.start();
  assert.equal(host.snapshot().transportState, "closed");
  assert.equal(linked.hostPeer.posts.length, 0);
  assert.equal(linked.prototype.snapshot().session.state, "idle");
});

test("browser adapter does not post a ready reply after its state callback closes it", () => {
  const linked = linkedAdapters();
  let prototype: BrowserBridgeAdapter;
  prototype = new BrowserBridgeAdapter({
    role: "prototype",
    sessionId: SESSION_ID,
    nonce: NONCE,
    peerOrigin: HOST_ORIGIN,
    capabilities: BRIDGE_CAPABILITIES,
    eventSource: linked.prototypeSource,
    peerWindow: linked.prototypePeer,
    onEvent: (event) => {
      if (event.type === "state" && event.snapshot.session.state === "active") prototype.close();
    },
  });
  prototype.start();
  linked.host.start();
  assert.equal(prototype.snapshot().transportState, "closed");
  assert.equal(linked.prototypePeer.posts.length, 0);
  assert.equal(linked.host.snapshot().session.state, "negotiating");
});

function acceptsNativeWindow(window: Window): void {
  const eventSource: BrowserBridgeEventSource = window;
  const peerWindow: BrowserBridgePeerWindow = window;
  void eventSource;
  void peerWindow;
}

void acceptsNativeWindow;
