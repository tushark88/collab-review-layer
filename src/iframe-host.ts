import {
  BrowserBridgeAdapter,
  BrowserBridgeTransportError,
  type BrowserBridgeEvent,
  type BrowserBridgeSnapshot,
} from "./browser-bridge.ts";
import {
  BridgeProtocolError,
  BridgeSession,
  type BridgeCapability,
  type BridgeOperationalMessage,
} from "./bridge.ts";
import { readBridgeOrigin } from "./bridge-constraints.ts";

export type ReviewFrameSandboxProfile = "cooperative" | "cooperative-forms";

export interface ReviewFrameSandboxPolicy {
  readonly sandbox: string;
  readonly permissionsPolicy: string;
}

const DENY_SENSITIVE_PERMISSIONS = [
  "autoplay 'none'",
  "camera 'none'",
  "clipboard-read 'none'",
  "clipboard-write 'none'",
  "display-capture 'none'",
  "fullscreen 'none'",
  "geolocation 'none'",
  "microphone 'none'",
  "payment 'none'",
  "picture-in-picture 'none'",
  "publickey-credentials-get 'none'",
  "screen-wake-lock 'none'",
  "usb 'none'",
  "web-share 'none'",
].join("; ");

export const REVIEW_FRAME_SANDBOX_POLICIES: Readonly<Record<ReviewFrameSandboxProfile, ReviewFrameSandboxPolicy>> = Object.freeze({
  cooperative: Object.freeze({
    sandbox: "allow-same-origin allow-scripts",
    permissionsPolicy: DENY_SENSITIVE_PERMISSIONS,
  }),
  "cooperative-forms": Object.freeze({
    sandbox: "allow-forms allow-same-origin allow-scripts",
    permissionsPolicy: DENY_SENSITIVE_PERMISSIONS,
  }),
});

export type ReviewFrameHostState = "idle" | "loading" | "negotiating" | "active" | "closed";

export interface ReviewFrameHostConfig {
  readonly container: HTMLElement;
  readonly sandboxProfile?: ReviewFrameSandboxProfile;
  readonly onEvent: (event: ReviewFrameHostEvent) => void;
}

export interface ReviewFrameOpenConfig {
  readonly source: string;
  readonly title: string;
  readonly peerOrigin: string;
  readonly sessionId: string;
  readonly nonce: string;
  readonly capabilities: readonly BridgeCapability[];
  readonly maxMessageBytes?: number;
}

export interface ReviewFrameHostSnapshot {
  readonly state: ReviewFrameHostState;
  readonly generation: number;
  readonly sandboxProfile: ReviewFrameSandboxProfile;
  readonly source?: string;
  readonly peerOrigin?: string;
  readonly sessionId?: string;
  readonly bridge?: BrowserBridgeSnapshot;
}

export type ReviewFrameHostEventError = ReviewFrameHostError | BridgeProtocolError | BrowserBridgeTransportError;

export type ReviewFrameHostEvent =
  | { readonly type: "state"; readonly snapshot: ReviewFrameHostSnapshot }
  | { readonly type: "message"; readonly message: BridgeOperationalMessage; readonly snapshot: ReviewFrameHostSnapshot }
  | {
    readonly type: "error";
    readonly error: ReviewFrameHostEventError;
    readonly snapshot: ReviewFrameHostSnapshot;
  };

export type ReviewFrameHostErrorCode =
  | "invalid_config"
  | "invalid_state"
  | "mount_failure"
  | "cleanup_failure"
  | "unexpected_navigation"
  | "bridge_rejected";

export class ReviewFrameHostError extends Error {
  readonly code: ReviewFrameHostErrorCode;

  constructor(code: ReviewFrameHostErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ReviewFrameHostError";
    this.code = code;
  }
}

interface StoredOpenConfig {
  readonly source: string;
  readonly snapshotSource: string;
  readonly title: string;
  readonly peerOrigin: string;
  readonly sessionId: string;
  readonly nonce: string;
  readonly capabilities: readonly BridgeCapability[];
  readonly maxMessageBytes?: number;
}

/**
 * Browser owner for one cooperative cross-origin prototype frame. The module
 * applies reviewed frame policy before mounting, creates the bridge only after
 * the frame loads, and makes every replacement invalidate the prior frame and
 * listener before the next one becomes active.
 */
export class ReviewFrameHost {
  readonly #container: HTMLElement;
  readonly #window: Window;
  readonly #hostOrigin: string;
  readonly #sandboxProfile: ReviewFrameSandboxProfile;
  readonly #policy: ReviewFrameSandboxPolicy;
  readonly #onEvent: (event: ReviewFrameHostEvent) => void;
  #state: ReviewFrameHostState = "idle";
  #generation = 0;
  #current?: StoredOpenConfig;
  #frame?: HTMLIFrameElement;
  #loadListener?: () => void;
  #loadCount = 0;
  #bridge?: BrowserBridgeAdapter;

  constructor(config: ReviewFrameHostConfig) {
    if (!config?.container || typeof config.container.appendChild !== "function" || typeof config.container.ownerDocument?.createElement !== "function") {
      throw new ReviewFrameHostError("invalid_config", "review frame container is invalid");
    }
    if (typeof config.onEvent !== "function") {
      throw new ReviewFrameHostError("invalid_config", "review frame event callback is invalid");
    }
    const sandboxProfile = config.sandboxProfile ?? "cooperative";
    if (!Object.prototype.hasOwnProperty.call(REVIEW_FRAME_SANDBOX_POLICIES, sandboxProfile)) {
      throw new ReviewFrameHostError("invalid_config", "review frame sandbox profile is invalid");
    }
    const hostWindow = config.container.ownerDocument.defaultView;
    if (!hostWindow) throw new ReviewFrameHostError("invalid_config", "review frame container must belong to a browser window");
    const hostOrigin = readBridgeOrigin(hostWindow.location.origin);
    if (!hostOrigin.ok) throw new ReviewFrameHostError("invalid_config", "review frame host origin is invalid");
    this.#container = config.container;
    this.#window = hostWindow;
    this.#hostOrigin = hostOrigin.value;
    this.#sandboxProfile = sandboxProfile;
    this.#policy = REVIEW_FRAME_SANDBOX_POLICIES[sandboxProfile];
    this.#onEvent = config.onEvent;
  }

  open(config: ReviewFrameOpenConfig): ReviewFrameHostSnapshot {
    if (this.#state === "closed") throw new ReviewFrameHostError("invalid_state", "closed review frame host cannot be reopened");
    const parsed = parseOpenConfig(config, this.#hostOrigin);
    this.#generation += 1;
    const generation = this.#generation;
    const cleanupFailures = this.#teardownCurrent("idle");
    this.#reportCleanupFailures(cleanupFailures);
    if (generation !== this.#generation || this.#state !== "idle") {
      throw new ReviewFrameHostError("invalid_state", "review frame open was superseded by a reentrant lifecycle change");
    }
    const frame = this.#container.ownerDocument.createElement("iframe");
    const loadListener = (): void => this.#handleLoad(generation, frame);
    this.#current = parsed;
    this.#frame = frame;
    this.#loadListener = loadListener;
    this.#loadCount = 0;
    this.#state = "loading";

    try {
      frame.title = parsed.title;
      frame.referrerPolicy = "no-referrer";
      frame.setAttribute("sandbox", this.#policy.sandbox);
      frame.setAttribute("allow", this.#policy.permissionsPolicy);
      frame.addEventListener("load", loadListener);
      frame.src = parsed.source;
      this.#container.appendChild(frame);
    } catch (cause) {
      const mountCleanup = this.#teardownCurrent("idle");
      throw new ReviewFrameHostError("mount_failure", "review frame could not be mounted", {
        cause: mountCleanup.length === 0 ? cause : new AggregateError([cause, ...mountCleanup], "review frame mount and cleanup failed"),
      });
    }

    this.#notify({ type: "state", snapshot: this.snapshot() });
    return this.snapshot();
  }

  send(message: BridgeOperationalMessage): void {
    if (this.#state !== "active" || !this.#bridge) {
      throw new ReviewFrameHostError("invalid_state", "review frame bridge is not active");
    }
    this.#bridge.send(message);
  }

  snapshot(): ReviewFrameHostSnapshot {
    const snapshot: ReviewFrameHostSnapshot = {
      state: this.#state,
      generation: this.#generation,
      sandboxProfile: this.#sandboxProfile,
    };
    if (this.#current) {
      Object.assign(snapshot, {
        source: this.#current.snapshotSource,
        peerOrigin: this.#current.peerOrigin,
        sessionId: this.#current.sessionId,
      });
    }
    if (this.#bridge) Object.assign(snapshot, { bridge: freezeBridgeSnapshot(this.#bridge.snapshot()) });
    return Object.freeze(snapshot);
  }

  close(): void {
    if (this.#state === "closed") return;
    const cleanupFailures = this.#teardownCurrent("closed");
    this.#notify({ type: "state", snapshot: this.snapshot() });
    this.#reportCleanupFailures(cleanupFailures);
  }

  #handleLoad(generation: number, frame: HTMLIFrameElement): void {
    if (generation !== this.#generation || frame !== this.#frame || this.#state === "closed" || !this.#current) return;
    this.#loadCount += 1;
    if (this.#loadCount > 1) {
      const error = new ReviewFrameHostError(
        "unexpected_navigation",
        "review frame navigated or reloaded without a fresh bridge session",
      );
      const cleanupFailures = this.#teardownCurrent("idle");
      this.#notify({ type: "error", error, snapshot: this.snapshot() });
      this.#reportCleanupFailures(cleanupFailures);
      return;
    }

    const peerWindow = frame.contentWindow;
    if (!peerWindow) {
      this.#failCurrent(new ReviewFrameHostError("mount_failure", "review frame peer window is unavailable"));
      return;
    }
    const current = this.#current;
    let bridge: BrowserBridgeAdapter;
    try {
      bridge = new BrowserBridgeAdapter({
        role: "host",
        sessionId: current.sessionId,
        nonce: current.nonce,
        peerOrigin: current.peerOrigin,
        capabilities: current.capabilities,
        maxMessageBytes: current.maxMessageBytes,
        eventSource: this.#window,
        peerWindow,
        onEvent: (event) => this.#handleBridgeEvent(generation, frame, bridge, event),
      });
      this.#bridge = bridge;
      this.#state = "negotiating";
      bridge.start();
    } catch (error) {
      if (this.#frame === frame && this.#generation === generation) {
        this.#failCurrent(asHostEventError(error));
      }
    }
  }

  #handleBridgeEvent(
    generation: number,
    frame: HTMLIFrameElement,
    bridge: BrowserBridgeAdapter,
    event: BrowserBridgeEvent,
  ): void {
    if (generation !== this.#generation || frame !== this.#frame || bridge !== this.#bridge || this.#state === "closed") return;
    if (event.type === "error") {
      this.#failCurrent(event.error);
      return;
    }
    if (event.type === "message") {
      this.#notify({ type: "message", message: event.message, snapshot: this.snapshot() });
      return;
    }
    if (event.snapshot.session.state === "rejected") {
      this.#failCurrent(new ReviewFrameHostError("bridge_rejected", "review frame bridge negotiation was rejected"));
      return;
    }
    this.#state = event.snapshot.session.state === "active" ? "active" : "negotiating";
    this.#notify({ type: "state", snapshot: this.snapshot() });
  }

  #failCurrent(error: ReviewFrameHostEventError): void {
    const cleanupFailures = this.#teardownCurrent("idle");
    this.#notify({ type: "error", error, snapshot: this.snapshot() });
    this.#reportCleanupFailures(cleanupFailures);
  }

  #teardownCurrent(nextState: ReviewFrameHostState): unknown[] {
    const bridge = this.#bridge;
    const frame = this.#frame;
    const loadListener = this.#loadListener;
    this.#bridge = undefined;
    this.#frame = undefined;
    this.#loadListener = undefined;
    this.#current = undefined;
    this.#loadCount = 0;
    this.#state = nextState;
    const failures: unknown[] = [];
    if (bridge) {
      try {
        bridge.close();
      } catch (error) {
        failures.push(error);
      }
    }
    if (frame && loadListener) {
      try {
        frame.removeEventListener("load", loadListener);
      } catch (error) {
        failures.push(error);
      }
    }
    if (frame) {
      try {
        frame.remove();
      } catch (error) {
        failures.push(error);
      }
    }
    return failures;
  }

  #reportCleanupFailures(failures: readonly unknown[]): void {
    if (failures.length === 0) return;
    const error = new ReviewFrameHostError("cleanup_failure", "review frame cleanup was incomplete", {
      cause: new AggregateError(failures, "review frame cleanup operations failed"),
    });
    this.#notify({ type: "error", error, snapshot: this.snapshot() });
  }

  #notify(event: ReviewFrameHostEvent): void {
    try {
      const result: unknown = this.#onEvent(event);
      if (!isPromiseLike(result)) return;
      void Promise.resolve(result).catch(() => undefined);
      throw new ReviewFrameHostError("invalid_config", "review frame event callback must be synchronous");
    } catch (error) {
      this.#teardownCurrent(this.#state === "closed" ? "closed" : "idle");
      throw error;
    }
  }
}

function parseOpenConfig(value: ReviewFrameOpenConfig, hostOrigin: string): StoredOpenConfig {
  if (!value || typeof value !== "object") throw new ReviewFrameHostError("invalid_config", "review frame configuration is invalid");
  const peerOrigin = readBridgeOrigin(value.peerOrigin);
  if (!peerOrigin.ok) throw new ReviewFrameHostError("invalid_config", "review frame peer origin is invalid");
  if (peerOrigin.value === hostOrigin) {
    throw new ReviewFrameHostError("invalid_config", "review frame peer must be cross-origin from its host");
  }
  let source: URL;
  try {
    source = new URL(value.source);
  } catch {
    throw new ReviewFrameHostError("invalid_config", "review frame source is invalid");
  }
  if (source.username || source.password || source.origin !== peerOrigin.value) {
    throw new ReviewFrameHostError("invalid_config", "review frame source must match its exact peer origin");
  }
  const title = requireTitle(value.title);
  try {
    new BridgeSession({
      role: "host",
      sessionId: value.sessionId,
      nonce: value.nonce,
      allowedOrigins: [peerOrigin.value],
      capabilities: value.capabilities,
      maxMessageBytes: value.maxMessageBytes,
    });
  } catch (cause) {
    throw new ReviewFrameHostError("invalid_config", "review frame bridge configuration is invalid", { cause });
  }
  return Object.freeze({
    source: source.href,
    snapshotSource: withoutUrlFragment(source),
    title,
    peerOrigin: peerOrigin.value,
    sessionId: value.sessionId,
    nonce: value.nonce,
    capabilities: Object.freeze([...value.capabilities]),
    maxMessageBytes: value.maxMessageBytes,
  });
}

function withoutUrlFragment(source: URL): string {
  const snapshotSource = new URL(source.href);
  snapshotSource.hash = "";
  return snapshotSource.href;
}

function requireTitle(value: unknown): string {
  if (
    typeof value !== "string"
    || !value.trim()
    || value.length > 256
    || value.includes("\u0000")
    || value.includes("\r")
    || value.includes("\n")
  ) {
    throw new ReviewFrameHostError("invalid_config", "review frame title is invalid");
  }
  return value;
}

function freezeBridgeSnapshot(snapshot: BrowserBridgeSnapshot): BrowserBridgeSnapshot {
  return Object.freeze({
    transportState: snapshot.transportState,
    session: Object.freeze({
      ...snapshot.session,
      capabilities: Object.freeze([...snapshot.session.capabilities]),
    }),
  });
}

function asHostEventError(error: unknown): ReviewFrameHostEventError {
  if (error instanceof ReviewFrameHostError || error instanceof BridgeProtocolError || error instanceof BrowserBridgeTransportError) return error;
  return new ReviewFrameHostError("mount_failure", "review frame bridge could not start", { cause: error });
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return Boolean(value && (typeof value === "object" || typeof value === "function") && typeof (value as { then?: unknown }).then === "function");
}
