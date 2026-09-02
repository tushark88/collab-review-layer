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
  type BridgeDraftAttachment,
  type BridgeDraftMessage,
  type BridgeOperationalMessage,
} from "./bridge.ts";
import { readBridgeOrigin } from "./bridge-constraints.ts";
import type { CurrentAnchor } from "./domain.ts";

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
  readonly onDraftSubmit?: (submission: ReviewFrameDraftSubmission) => void;
}

export interface ReviewFrameDraftSubmission {
  readonly requestId: string;
  readonly body: string;
  readonly anchor: CurrentAnchor;
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
  | "missing_styles"
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

interface StoredDraft {
  readonly requestId: string;
  readonly anchor: CurrentAnchor;
  readonly attachment: BridgeDraftAttachment;
}

const DRAFT_STYLE_SENTINEL = "--crl-frame-draft-owned";

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
  readonly #onDraftSubmit?: (submission: ReviewFrameDraftSubmission) => void;
  #state: ReviewFrameHostState = "idle";
  #generation = 0;
  #current?: StoredOpenConfig;
  #frame?: HTMLIFrameElement;
  #loadListener?: () => void;
  #loadCount = 0;
  #bridge?: BrowserBridgeAdapter;
  #draft?: StoredDraft;
  #draftComposer?: HTMLElement;
  #draftFocusReturn?: Element;
  #draftRefreshFrame?: number;
  readonly #retiredDraftRequestIds = new Set<string>();

  constructor(config: ReviewFrameHostConfig) {
    if (!config?.container || typeof config.container.appendChild !== "function" || typeof config.container.ownerDocument?.createElement !== "function") {
      throw new ReviewFrameHostError("invalid_config", "review frame container is invalid");
    }
    if (typeof config.onEvent !== "function") {
      throw new ReviewFrameHostError("invalid_config", "review frame event callback is invalid");
    }
    if (config.onDraftSubmit !== undefined && typeof config.onDraftSubmit !== "function") {
      throw new ReviewFrameHostError("invalid_config", "review frame draft submit callback is invalid");
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
    this.#onDraftSubmit = config.onDraftSubmit;
  }

  open(config: ReviewFrameOpenConfig): ReviewFrameHostSnapshot {
    if (this.#state === "closed") throw new ReviewFrameHostError("invalid_state", "closed review frame host cannot be reopened");
    const parsed = parseOpenConfig(config, this.#hostOrigin);
    if (parsed.capabilities.includes("draft") && !this.#onDraftSubmit) {
      throw new ReviewFrameHostError("invalid_config", "the draft capability requires shell-owned draft handling");
    }
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
    let hostReadable = false;
    try {
      hostReadable = frame.contentDocument !== null;
    } catch (cause) {
      this.#failCurrent(new ReviewFrameHostError("mount_failure", "review frame document isolation could not be verified", { cause }));
      return;
    }
    if (hostReadable) {
      this.#failCurrent(new ReviewFrameHostError(
        "unexpected_navigation",
        "review frame resolved to a host-readable document",
      ));
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
      if (event.message.type === "draft") {
        try {
          this.#handleDraftMessage(event.message);
        } catch (error) {
          this.#failCurrent(asHostEventError(error));
          return;
        }
      }
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

  #handleDraftMessage(message: BridgeDraftMessage): void {
    if (message.action === "open") {
      if (message.mode !== "request") throw new BridgeProtocolError("invalid_message", "prototype draft open mode is invalid");
      if (this.#draft) throw new BridgeProtocolError("invalid_state", "a review frame draft is already active");
      if (this.#retiredDraftRequestIds.has(message.requestId)) {
        throw new BridgeProtocolError("invalid_state", "a retired review frame draft request cannot be reopened");
      }
      this.#openDraftComposer(message);
      return;
    }
    if (message.action === "update") {
      if (message.mode !== "report") {
        throw new BridgeProtocolError("invalid_message", "prototype draft update mode is invalid");
      }
      if (message.requestId !== this.#draft?.requestId) {
        if (this.#retiredDraftRequestIds.has(message.requestId)) return;
        throw new BridgeProtocolError("invalid_state", "review frame draft update does not match the active request");
      }
      if (message.attachment.locationAvailability === "unavailable") {
        this.#closeDraftComposer(true);
        return;
      }
      this.#draft = { ...this.#draft, attachment: message.attachment };
      this.#refreshDraftPlacement();
      return;
    }
    if (message.mode !== "report") {
      throw new BridgeProtocolError("invalid_message", "prototype draft dismissal mode is invalid");
    }
    if (message.requestId !== this.#draft?.requestId) {
      if (this.#retiredDraftRequestIds.has(message.requestId)) return;
      throw new BridgeProtocolError("invalid_state", "review frame draft dismissal does not match the active request");
    }
    this.#closeDraftComposer(true);
  }

  #openDraftComposer(message: Extract<BridgeDraftMessage, { action: "open" }>): void {
    const document = this.#container.ownerDocument;
    if (!document.body) throw new ReviewFrameHostError("mount_failure", "review frame draft host document has no body");
    const composer = document.createElement("section");
    composer.className = "crl-frame-draft";
    composer.setAttribute("role", "dialog");
    composer.setAttribute("aria-label", "Add review comment");
    const form = document.createElement("form");
    const label = document.createElement("label");
    label.className = "crl-frame-draft__label";
    label.textContent = "Comment";
    const textarea = document.createElement("textarea");
    textarea.className = "crl-frame-draft__textarea";
    textarea.name = "comment";
    textarea.required = true;
    textarea.rows = 4;
    label.appendChild(textarea);
    const actions = document.createElement("div");
    actions.className = "crl-frame-draft__actions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => this.#dismissDraftFromHost());
    const submit = document.createElement("button");
    submit.type = "submit";
    submit.textContent = "Submit comment";
    actions.append(cancel, submit);
    form.append(label, actions);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      this.#submitDraft(textarea.value);
    });
    textarea.addEventListener("keydown", (event) => {
      if (event.isComposing) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        this.#dismissDraftFromHost();
        return;
      }
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        form.requestSubmit();
      }
    });
    composer.appendChild(form);
    this.#draftFocusReturn = document.activeElement ?? undefined;
    const composerHost = closestComposedActiveModal(this.#container) ?? document.body;
    composerHost.appendChild(composer);
    if (this.#window.getComputedStyle(composer).getPropertyValue(DRAFT_STYLE_SENTINEL).trim() !== "1") {
      composer.remove();
      this.#draftFocusReturn = undefined;
      throw new ReviewFrameHostError("missing_styles", "review frame draft stylesheet is not loaded in the shell document");
    }
    this.#draft = {
      requestId: message.requestId,
      anchor: structuredClone(message.anchor),
      attachment: structuredClone(message.attachment),
    };
    this.#draftComposer = composer;
    this.#refreshDraftPlacement();
    this.#scheduleDraftRefresh();
    textarea.focus();
  }

  #submitDraft(value: string): void {
    const draft = this.#draft;
    const onDraftSubmit = this.#onDraftSubmit;
    const body = value.trim();
    if (!draft || !onDraftSubmit || !body || !this.#refreshDraftPlacement()) return;
    try {
      const result: unknown = onDraftSubmit(Object.freeze({
        requestId: draft.requestId,
        body,
        anchor: structuredClone(draft.anchor),
      }));
      if (isPromiseLike(result)) throw new ReviewFrameHostError("invalid_config", "review frame draft submit callback must be synchronous");
    } catch (cause) {
      this.#failCurrent(cause instanceof ReviewFrameHostError
        ? cause
        : new ReviewFrameHostError("invalid_config", "review frame draft submit callback failed", { cause }));
      return;
    }
    this.#dismissDraftFromHost();
  }

  #dismissDraftFromHost(): void {
    const requestId = this.#draft?.requestId;
    if (!requestId) return;
    this.#closeDraftComposer(true);
    try {
      this.send({ type: "draft", mode: "request", action: "dismiss", requestId });
    } catch (error) {
      this.#failCurrent(asHostEventError(error));
    }
  }

  #refreshDraftPlacement(): boolean {
    const draft = this.#draft;
    const composer = this.#draftComposer;
    const frame = this.#frame;
    if (!draft || !composer || !frame || draft.attachment.locationAvailability !== "available") return false;
    composer.dataset.coordinateSpace = draft.attachment.coordinateSpace;
    const projection = frameContentProjection(frame);
    if (!projection) {
      composer.hidden = true;
      return false;
    }
    const anchorX = projection.left + (draft.attachment.x * projection.scaleX);
    const anchorY = projection.top + (draft.attachment.y * projection.scaleY);
    const visible = draft.attachment.visible
      && anchorX >= Math.max(0, projection.left)
      && anchorX <= Math.min(this.#window.innerWidth, projection.right)
      && anchorY >= Math.max(0, projection.top)
      && anchorY <= Math.min(this.#window.innerHeight, projection.bottom);
    composer.hidden = !visible;
    if (!visible) return false;
    const gap = 12;
    const edge = 8;
    const composerRect = composer.getBoundingClientRect();
    composer.style.left = `${clamp(anchorX + gap, edge, this.#window.innerWidth - composerRect.width - edge)}px`;
    composer.style.top = `${clamp(anchorY + gap, edge, this.#window.innerHeight - composerRect.height - edge)}px`;
    return true;
  }

  #scheduleDraftRefresh(): void {
    if (!this.#draft || this.#draftRefreshFrame !== undefined) return;
    this.#draftRefreshFrame = this.#window.requestAnimationFrame(() => {
      this.#draftRefreshFrame = undefined;
      if (!this.#draft) return;
      this.#refreshDraftPlacement();
      this.#scheduleDraftRefresh();
    });
  }

  #closeDraftComposer(restoreFocus: boolean): void {
    const focusReturn = this.#draftFocusReturn;
    if (this.#draft) this.#retireDraftRequest(this.#draft.requestId);
    if (this.#draftRefreshFrame !== undefined) this.#window.cancelAnimationFrame(this.#draftRefreshFrame);
    this.#draftRefreshFrame = undefined;
    this.#draftComposer?.remove();
    this.#draftComposer = undefined;
    this.#draft = undefined;
    this.#draftFocusReturn = undefined;
    if (restoreFocus && focusReturn?.isConnected && isFocusableElement(focusReturn)) {
      focusReturn.focus({ preventScroll: true });
    }
  }

  #retireDraftRequest(requestId: string): void {
    this.#retiredDraftRequestIds.add(requestId);
    const oldest = this.#retiredDraftRequestIds.values().next().value as string | undefined;
    if (this.#retiredDraftRequestIds.size > 64 && oldest !== undefined) this.#retiredDraftRequestIds.delete(oldest);
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
    try {
      this.#closeDraftComposer(false);
    } catch (error) {
      failures.push(error);
    }
    this.#retiredDraftRequestIds.clear();
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

function isFocusableElement(value: Element): value is Element & { focus(options?: FocusOptions): void } {
  return typeof (value as { focus?: unknown }).focus === "function";
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(value, maximum));
}

function frameContentProjection(frame: HTMLIFrameElement): Readonly<{
  left: number;
  top: number;
  right: number;
  bottom: number;
  scaleX: number;
  scaleY: number;
}> | undefined {
  if (!hasPositiveAxisAlignedFrameProjection(frame)) return undefined;
  const rect = frame.getBoundingClientRect();
  const borderBoxWidth = frame.offsetWidth;
  const borderBoxHeight = frame.offsetHeight;
  if (borderBoxWidth <= 0 || borderBoxHeight <= 0 || frame.clientWidth <= 0 || frame.clientHeight <= 0) return undefined;
  const scaleX = rect.width / borderBoxWidth;
  const scaleY = rect.height / borderBoxHeight;
  if (!Number.isFinite(scaleX) || !Number.isFinite(scaleY) || scaleX <= 0 || scaleY <= 0) return undefined;
  const left = rect.left + (frame.clientLeft * scaleX);
  const top = rect.top + (frame.clientTop * scaleY);
  return {
    left,
    top,
    right: left + (frame.clientWidth * scaleX),
    bottom: top + (frame.clientHeight * scaleY),
    scaleX,
    scaleY,
  };
}

function hasPositiveAxisAlignedFrameProjection(frame: HTMLIFrameElement): boolean {
  const window = frame.ownerDocument.defaultView;
  if (!window) return false;
  const DOMMatrixConstructor = (window as unknown as { DOMMatrix: typeof DOMMatrix }).DOMMatrix;
  if (typeof DOMMatrixConstructor !== "function") return false;
  for (let element: Element | null = frame; element; element = composedParentElement(element)) {
    const style = window.getComputedStyle(element);
    if (style.perspective !== "none" || style.offsetPath !== "none") return false;
    const transforms = [
      style.transform,
      style.rotate === "none" ? "none" : `rotate(${style.rotate})`,
      style.scale === "none" ? "none" : `scale(${style.scale})`,
    ];
    for (const transform of transforms) {
      if (transform === "none") continue;
      let matrix: DOMMatrix;
      try {
        matrix = new DOMMatrixConstructor(transform);
      } catch {
        return false;
      }
      if (
        !matrix.is2D
        || Math.abs(matrix.b) > 1e-8
        || Math.abs(matrix.c) > 1e-8
        || matrix.a <= 0
        || matrix.d <= 0
      ) return false;
    }
  }
  return true;
}

function closestComposedActiveModal(element: Element): Element | undefined {
  for (let current: Element | null = element; current; current = composedParentElement(current)) {
    if (current.matches("dialog:modal")) return current;
  }
  return undefined;
}

function composedParentElement(element: Element): Element | null {
  if (element.parentElement) return element.parentElement;
  const host = (element.getRootNode() as DocumentFragment & { host?: Element }).host;
  return host?.ownerDocument === element.ownerDocument ? host : null;
}
