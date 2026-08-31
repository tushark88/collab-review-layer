import {
  BRIDGE_PROTOCOL,
  BridgeProtocolError,
  BridgeSession,
  type BridgeCapability,
  type BridgeOperationalMessage,
  type BridgeRole,
  type BridgeSessionSnapshot,
} from "./bridge.ts";

export interface BrowserBridgeMessageEvent {
  data: unknown;
  origin: string;
  source: unknown;
}

export type BrowserBridgeMessageListener = (event: BrowserBridgeMessageEvent) => void;

export interface BrowserBridgeEventSource {
  addEventListener(type: "message", listener: BrowserBridgeMessageListener): void;
  removeEventListener(type: "message", listener: BrowserBridgeMessageListener): void;
}

export interface BrowserBridgePeerWindow {
  postMessage(message: unknown, targetOrigin: string): void;
}

export type BrowserBridgeTransportState = "idle" | "listening" | "closed";

export interface BrowserBridgeSnapshot {
  transportState: BrowserBridgeTransportState;
  session: BridgeSessionSnapshot;
}

export type BrowserBridgeEvent =
  | { type: "state"; snapshot: BrowserBridgeSnapshot }
  | { type: "message"; message: BridgeOperationalMessage; snapshot: BrowserBridgeSnapshot }
  | { type: "error"; error: BridgeProtocolError | BrowserBridgeTransportError; snapshot: BrowserBridgeSnapshot };

export interface BrowserBridgeAdapterConfig {
  role: BridgeRole;
  sessionId: string;
  nonce: string;
  peerOrigin: string;
  capabilities: readonly BridgeCapability[];
  maxMessageBytes?: number;
  eventSource: BrowserBridgeEventSource;
  peerWindow: BrowserBridgePeerWindow;
  onEvent: (event: BrowserBridgeEvent) => void;
}

export type BrowserBridgeTransportErrorCode = "invalid_config" | "invalid_state" | "transport_failure";

export class BrowserBridgeTransportError extends Error {
  readonly code: BrowserBridgeTransportErrorCode;

  constructor(code: BrowserBridgeTransportErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BrowserBridgeTransportError";
    this.code = code;
  }
}

/**
 * Browser transport for one cooperative peer window. The adapter owns its
 * BridgeSession, source-window and target-origin binding, handshake replies,
 * and listener lifecycle. Iframe creation and sandbox policy belong to the
 * shell that supplies the peer window.
 */
export class BrowserBridgeAdapter {
  readonly #role: BridgeRole;
  readonly #sessionId: string;
  readonly #peerOrigin: string;
  readonly #eventSource: BrowserBridgeEventSource;
  readonly #peerWindow: BrowserBridgePeerWindow;
  readonly #onEvent: (event: BrowserBridgeEvent) => void;
  readonly #session: BridgeSession;
  readonly #listener: BrowserBridgeMessageListener;
  #transportState: BrowserBridgeTransportState = "idle";

  constructor(config: BrowserBridgeAdapterConfig) {
    if (!config.eventSource || typeof config.eventSource.addEventListener !== "function" || typeof config.eventSource.removeEventListener !== "function") {
      throw new BrowserBridgeTransportError("invalid_config", "browser bridge event source is invalid");
    }
    if (!config.peerWindow || typeof config.peerWindow.postMessage !== "function") {
      throw new BrowserBridgeTransportError("invalid_config", "browser bridge peer window is invalid");
    }
    if (typeof config.onEvent !== "function") {
      throw new BrowserBridgeTransportError("invalid_config", "browser bridge event callback is invalid");
    }
    this.#role = config.role;
    this.#sessionId = config.sessionId;
    this.#peerOrigin = normalizePeerOrigin(config.peerOrigin);
    this.#eventSource = config.eventSource;
    this.#peerWindow = config.peerWindow;
    this.#onEvent = config.onEvent;
    this.#session = new BridgeSession({
      role: config.role,
      sessionId: config.sessionId,
      nonce: config.nonce,
      allowedOrigins: [this.#peerOrigin],
      capabilities: config.capabilities,
      maxMessageBytes: config.maxMessageBytes,
    });
    this.#listener = (event) => this.#receive(event);
  }

  start(): void {
    if (this.#transportState !== "idle") {
      throw new BrowserBridgeTransportError("invalid_state", "browser bridge adapter can only start once");
    }
    try {
      this.#eventSource.addEventListener("message", this.#listener);
    } catch (cause) {
      throw new BrowserBridgeTransportError("transport_failure", "browser bridge listener could not be attached", { cause });
    }
    this.#transportState = "listening";

    if (this.#role === "prototype") {
      this.#emitState();
      return;
    }

    let hello;
    try {
      hello = this.#session.initiate();
    } catch (error) {
      this.#forceClose();
      throw error;
    }
    this.#emitState();
    try {
      this.#peerWindow.postMessage(hello, this.#peerOrigin);
    } catch (cause) {
      throw this.#failSynchronousTransport("browser bridge hello could not be posted", cause);
    }
  }

  send(message: BridgeOperationalMessage): void {
    if (this.#transportState !== "listening") {
      throw new BrowserBridgeTransportError("invalid_state", "browser bridge adapter is not listening");
    }
    const envelope = this.#session.send(message);
    try {
      this.#peerWindow.postMessage(envelope, this.#peerOrigin);
    } catch (cause) {
      throw this.#failSynchronousTransport("browser bridge message could not be posted", cause);
    }
  }

  close(): void {
    if (this.#transportState === "closed") return;
    const wasListening = this.#transportState === "listening";
    this.#transportState = "closed";
    if (wasListening) {
      try {
        this.#eventSource.removeEventListener("message", this.#listener);
      } catch (cause) {
        throw new BrowserBridgeTransportError("transport_failure", "browser bridge listener could not be removed", { cause });
      }
    }
    this.#emitState();
  }

  snapshot(): BrowserBridgeSnapshot {
    return { transportState: this.#transportState, session: this.#session.snapshot() };
  }

  #receive(event: BrowserBridgeMessageEvent): void {
    if (this.#transportState !== "listening" || event.source !== this.#peerWindow) return;
    if (!isBridgeEnvelopeForSession(event.data, this.#sessionId)) return;
    let result;
    try {
      result = this.#session.receive(event.origin, event.data);
    } catch (error) {
      if (error instanceof BridgeProtocolError) {
        this.#forceClose();
        this.#notify({ type: "error", error, snapshot: this.snapshot() });
        return;
      }
      this.#failAsynchronousTransport("browser bridge message could not be received", error);
      return;
    }

    if (result.kind === "handshake" && result.reply !== undefined) {
      try {
        this.#peerWindow.postMessage(result.reply, this.#peerOrigin);
      } catch (cause) {
        this.#failAsynchronousTransport("browser bridge handshake reply could not be posted", cause);
        return;
      }
    }

    if (result.kind === "message") {
      this.#notify({ type: "message", message: result.message, snapshot: this.snapshot() });
    } else {
      this.#emitState();
    }
  }

  #emitState(): void {
    this.#notify({ type: "state", snapshot: this.snapshot() });
  }

  #notify(event: BrowserBridgeEvent): void {
    try {
      this.#onEvent(event);
    } catch (error) {
      this.#forceClose();
      throw error;
    }
  }

  #failSynchronousTransport(message: string, cause: unknown): BrowserBridgeTransportError {
    const error = new BrowserBridgeTransportError("transport_failure", message, { cause });
    this.#forceClose();
    return error;
  }

  #failAsynchronousTransport(message: string, cause: unknown): void {
    const error = new BrowserBridgeTransportError("transport_failure", message, { cause });
    this.#forceClose();
    this.#notify({ type: "error", error, snapshot: this.snapshot() });
  }

  #forceClose(): void {
    const wasListening = this.#transportState === "listening";
    this.#transportState = "closed";
    if (wasListening) {
      try {
        this.#eventSource.removeEventListener("message", this.#listener);
      } catch {
        // The closed state makes a still-registered listener inert.
      }
    }
  }
}

function isBridgeEnvelopeForSession(value: unknown, sessionId: string): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const protocol = Object.getOwnPropertyDescriptor(value, "protocol");
  if (!protocol || !protocol.enumerable || !("value" in protocol) || protocol.value !== BRIDGE_PROTOCOL) return false;
  const session = Object.getOwnPropertyDescriptor(value, "sessionId");
  if (session && session.enumerable && "value" in session && typeof session.value === "string" && session.value !== sessionId) return false;
  return true;
}

function normalizePeerOrigin(value: unknown): string {
  if (typeof value !== "string" || value === "*" || value === "null") {
    throw new BridgeProtocolError("invalid_origin", "browser bridge peer origin is invalid");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new BridgeProtocolError("invalid_origin", "browser bridge peer origin is invalid");
  }
  if (url.username || url.password || url.origin === "null") {
    throw new BridgeProtocolError("invalid_origin", "browser bridge peer origin is invalid");
  }
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new BridgeProtocolError("invalid_origin", "browser bridge peer origin must use HTTPS outside loopback development");
  }
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new BridgeProtocolError("invalid_origin", "browser bridge peer origin must contain only an origin");
  }
  return url.origin;
}
