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
import { readAnchorIdentifier, readLegacyAnchorCorrelationValue } from "./anchor-constraints.ts";
import { readBridgeOrigin, readBridgeRoute } from "./bridge-constraints.ts";
import type { AnchorContext, CurrentAnchor } from "./domain.ts";

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
  readonly context: AnchorContext;
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
  readonly context: AnchorContext;
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
  #draftFocusSentinel?: HTMLElement;
  #draftFocusedElement?: Element;
  #draftFocusReturn?: Element;
  #draftFocusParkedOn?: Element;
  #draftFocusRestoreInProgress = false;
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
    if (hostWindow !== globalThis) {
      throw new ReviewFrameHostError("invalid_config", "review frame container must belong to the current browser realm");
    }
    if (crossesClosedShadowBoundary(config.container)) {
      throw new ReviewFrameHostError("invalid_config", "review frame container cannot cross a closed shadow boundary");
    }
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
    if (parsed.capabilities.includes("draft") && !hasCurrentDraftContext(parsed.context)) {
      throw new ReviewFrameHostError("invalid_config", "the draft capability requires a current Anchor Context");
    }
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
      frame.addEventListener("focus", this.#handleFrameFocus, true);
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
      if (!this.#current || !sameAnchorContext(message.anchor.context, this.#current.context)) {
        throw new BridgeProtocolError("invalid_message", "prototype draft Anchor Context does not match its review frame");
      }
      if (message.mode !== "request") throw new BridgeProtocolError("invalid_message", "prototype draft open mode is invalid");
      if (this.#draft) throw new BridgeProtocolError("invalid_state", "a review frame draft is already active");
      if (this.#retiredDraftRequestIds.has(message.requestId)) {
        throw new BridgeProtocolError("invalid_state", "a retired review frame draft request cannot be reopened");
      }
      if (this.#window.navigator.userActivation?.isActive !== true) {
        throw new BridgeProtocolError("invalid_state", "a review frame draft requires current trusted user activation");
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
        if (!this.#preserveProtectedDraftAsUnavailable()) this.#closeDraftComposer(false);
        return;
      }
      this.#draft = { ...this.#draft, attachment: message.attachment };
      this.#setDraftAvailabilityUi(false);
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
    if (!this.#preserveProtectedDraftAsUnavailable()) this.#closeDraftComposer(false);
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
    const locationStatus = document.createElement("p");
    locationStatus.className = "crl-frame-draft__location-status";
    locationStatus.setAttribute("role", "status");
    locationStatus.hidden = true;
    locationStatus.textContent = "Comment location unavailable. Your draft is preserved.";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => this.#dismissDraftFromHost());
    const submit = document.createElement("button");
    submit.type = "submit";
    submit.textContent = "Submit comment";
    actions.append(cancel, submit);
    form.append(label, locationStatus, actions);
    composer.addEventListener("focusin", (event) => {
      if (event.target && composer.contains(event.target as Node)) this.#draftFocusedElement = event.target as Element;
    });
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
    this.#draftFocusReturn = deepestActiveElement(document);
    const composerHost = closestComposedActiveModal(this.#container) ?? document.body;
    if (!hostProvidesDraftStyles(composerHost, this.#window)) {
      this.#draftFocusReturn = undefined;
      throw new ReviewFrameHostError(
        "missing_styles",
        "review frame draft stylesheet is not loaded in the active shell tree",
      );
    }
    const focusSentinel = this.#draftFocusSentinel ?? document.createElement("span");
    focusSentinel.className = "crl-frame-draft-focus-sentinel";
    focusSentinel.tabIndex = -1;
    focusSentinel.textContent = "Review comment paused";
    composerHost.append(composer, focusSentinel);
    if (this.#window.getComputedStyle(composer).getPropertyValue(DRAFT_STYLE_SENTINEL).trim() !== "1") {
      composer.remove();
      focusSentinel.remove();
      this.#draftFocusSentinel = undefined;
      this.#draftFocusReturn = undefined;
      throw new ReviewFrameHostError("missing_styles", "review frame draft stylesheet is not loaded in the shell document");
    }
    this.#draftFocusSentinel = focusSentinel;
    this.#draft = {
      requestId: message.requestId,
      anchor: structuredClone(message.anchor),
      attachment: structuredClone(message.attachment),
    };
    this.#draftComposer = composer;
    this.#setDraftAvailabilityUi(false);
    const visible = this.#refreshDraftPlacement();
    this.#scheduleDraftRefresh();
    if (visible) textarea.focus();
    else if (deepestActiveElement(document) === this.#frame) {
      this.#draftFocusedElement = textarea;
      focusSentinel.focus({ preventScroll: true });
      this.#draftFocusParkedOn = focusSentinel;
    }
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
      if (isPromiseLike(result)) {
        void Promise.resolve(result).catch(() => undefined);
        throw new ReviewFrameHostError("invalid_config", "review frame draft submit callback must be synchronous");
      }
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

  readonly #handleFrameFocus = (): void => {
    this.#restoreVisibleDraftFocus();
  };

  #restoreVisibleDraftFocus(): void {
    const document = this.#container.ownerDocument;
    const composer = this.#draftComposer;
    const frame = this.#frame;
    if (
      this.#draftFocusRestoreInProgress
      || !this.#draft
      || !composer
      || !frame
      || deepestActiveElement(document) !== frame
    ) return;
    if (composer.hidden) {
      const sentinel = this.#draftFocusSentinel;
      if (sentinel && isFocusableElement(sentinel)) {
        sentinel.focus({ preventScroll: true });
        this.#draftFocusParkedOn = sentinel;
      }
      return;
    }
    const previous = this.#draftFocusedElement;
    const preferred = previous?.isConnected && composer.contains(previous) && isFocusableElement(previous)
      ? previous
      : composer.querySelector("textarea");
    this.#draftFocusRestoreInProgress = true;
    try {
      if (preferred && isFocusableElement(preferred)) preferred.focus({ preventScroll: true });
      if (deepestActiveElement(document) === frame) {
        const sentinel = this.#draftFocusSentinel;
        if (sentinel && isFocusableElement(sentinel)) {
          sentinel.focus({ preventScroll: true });
          this.#draftFocusParkedOn = sentinel;
        }
      }
    } finally {
      this.#draftFocusRestoreInProgress = false;
    }
  }

  #refreshDraftPlacement(): boolean {
    const draft = this.#draft;
    const composer = this.#draftComposer;
    const frame = this.#frame;
    if (!draft || !composer || !frame) return false;
    const expectedComposerHost = closestComposedActiveModal(this.#container) ?? this.#container.ownerDocument.body;
    const focusSentinel = this.#draftFocusSentinel;
    if (composer.parentElement !== expectedComposerHost || focusSentinel?.parentElement !== expectedComposerHost) {
      const activeElement = deepestActiveElement(this.#container.ownerDocument);
      const focusedElement = composer.hidden
        ? undefined
        : activeElement && composer.contains(activeElement)
          ? activeElement
          : this.#draftFocusedElement;
      const sentinelWasFocused = activeElement === focusSentinel;
      if (!hostProvidesDraftStyles(expectedComposerHost, this.#window)) {
        this.#rejectDraftForUnstyledHost(expectedComposerHost);
        return false;
      }
      expectedComposerHost.append(composer);
      if (focusSentinel) expectedComposerHost.append(focusSentinel);
      if (focusedElement && deepestActiveElement(this.#container.ownerDocument) !== focusedElement && isFocusableElement(focusedElement)) {
        focusedElement.focus({ preventScroll: true });
      } else if (sentinelWasFocused && focusSentinel) {
        focusSentinel.focus({ preventScroll: true });
      }
    }
    const composerHost = composer.parentElement;
    if (!composerHost) return false;
    if (this.#window.getComputedStyle(composer).getPropertyValue(DRAFT_STYLE_SENTINEL).trim() !== "1") {
      this.#rejectDraftForUnstyledHost(composerHost);
      return false;
    }
    if (!preservesViewportFixedCoordinates(composer, this.#window)) {
      this.#setDraftComposerVisibility(composer, false);
      return false;
    }
    if (draft.attachment.locationAvailability === "unavailable") {
      this.#setDraftComposerVisibility(composer, true);
      composer.style.left = "8px";
      composer.style.top = "8px";
      this.#restoreVisibleDraftFocus();
      return false;
    }
    composer.dataset.coordinateSpace = draft.attachment.coordinateSpace;
    const projection = frameContentProjection(frame);
    if (!projection) {
      this.#setDraftComposerVisibility(composer, false);
      return false;
    }
    const anchorX = projection.left + (draft.attachment.x * projection.scaleX);
    const anchorY = projection.top + (draft.attachment.y * projection.scaleY);
    const visible = draft.attachment.visible
      && anchorX >= Math.max(0, projection.visibleLeft)
      && anchorX <= Math.min(this.#window.innerWidth, projection.visibleRight)
      && anchorY >= Math.max(0, projection.visibleTop)
      && anchorY <= Math.min(this.#window.innerHeight, projection.visibleBottom)
      && framePaintsAtPoint(frame, anchorX, anchorY);
    this.#setDraftComposerVisibility(composer, visible);
    if (!visible) return false;
    const gap = 12;
    const edge = 8;
    const composerRect = composer.getBoundingClientRect();
    composer.style.left = `${clamp(anchorX + gap, edge, this.#window.innerWidth - composerRect.width - edge)}px`;
    composer.style.top = `${clamp(anchorY + gap, edge, this.#window.innerHeight - composerRect.height - edge)}px`;
    this.#restoreVisibleDraftFocus();
    return true;
  }

  #preserveProtectedDraftAsUnavailable(): boolean {
    const draft = this.#draft;
    const composer = this.#draftComposer;
    const textarea = composer?.querySelector<HTMLTextAreaElement>(".crl-frame-draft__textarea");
    if (!draft || !composer || !textarea?.value) return false;
    this.#draft = { ...draft, attachment: { locationAvailability: "unavailable" } };
    this.#setDraftAvailabilityUi(true);
    this.#refreshDraftPlacement();
    return true;
  }

  #setDraftAvailabilityUi(unavailable: boolean): void {
    const composer = this.#draftComposer;
    if (!composer) return;
    composer.dataset.locationAvailability = unavailable ? "unavailable" : "available";
    const status = composer.querySelector<HTMLElement>(".crl-frame-draft__location-status");
    if (status) status.hidden = !unavailable;
    const submit = composer.querySelector<HTMLButtonElement>('button[type="submit"]');
    if (submit) submit.disabled = unavailable;
  }

  #rejectDraftForUnstyledHost(host: Element): void {
    const draft = this.#draft;
    const frame = this.#frame;
    const bridge = this.#bridge;
    const generation = this.#generation;
    const state = this.#state;
    if (!draft || !frame || !bridge) return;
    const focused = focusShellHost(host);
    if (
      this.#draft !== draft
      || this.#frame !== frame
      || this.#bridge !== bridge
      || this.#generation !== generation
      || this.#state !== state
    ) return;
    this.#closeDraftComposer(false);
    if (!focused) {
      this.#failCurrent(new ReviewFrameHostError(
        "missing_styles",
        "review frame draft could not retain focus in its unstyled shell host",
      ));
      return;
    }
    try {
      this.send({ type: "draft", mode: "request", action: "dismiss", requestId: draft.requestId });
    } catch (error) {
      if (
        this.#frame === frame
        && this.#bridge === bridge
        && this.#generation === generation
        && this.#state === state
      ) this.#failCurrent(asHostEventError(error));
    }
  }

  #setDraftComposerVisibility(composer: HTMLElement, visible: boolean): void {
    const document = this.#container.ownerDocument;
    const wasHidden = composer.hidden;
    if (!visible) {
      const activeElement = deepestActiveElement(document);
      const focusIsInComposer = Boolean(activeElement && composer.contains(activeElement));
      if (focusIsInComposer && activeElement) {
        this.#draftFocusedElement = activeElement;
      }
      composer.hidden = true;
      if (focusIsInComposer || activeElement === this.#frame) {
        const sentinel = this.#draftFocusSentinel;
        if (sentinel && isFocusableElement(sentinel)) {
          sentinel.focus({ preventScroll: true });
          this.#draftFocusParkedOn = sentinel;
        }
      }
      return;
    }
    composer.hidden = false;
    const parkedOn = this.#draftFocusParkedOn;
    this.#draftFocusParkedOn = undefined;
    if (
      wasHidden
      && parkedOn
      && deepestActiveElement(document) === parkedOn
      && this.#draftFocusedElement?.isConnected
      && isFocusableElement(this.#draftFocusedElement)
    ) {
      this.#draftFocusedElement.focus({ preventScroll: true });
    }
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
    const document = this.#container.ownerDocument;
    const composer = this.#draftComposer;
    const focusSentinel = this.#draftFocusSentinel;
    const focusReturn = this.#draftFocusReturn;
    const activeElement = deepestActiveElement(document);
    const keepFocusParked = !restoreFocus
      && Boolean(focusSentinel)
      && (
        activeElement === focusSentinel
        || activeElement === this.#frame
        || Boolean(activeElement && composer?.contains(activeElement))
      );
    if (keepFocusParked && activeElement !== focusSentinel && focusSentinel) {
      if (composer) composer.hidden = true;
      focusSentinel.focus({ preventScroll: true });
    }
    if (this.#draft) this.#retireDraftRequest(this.#draft.requestId);
    if (this.#draftRefreshFrame !== undefined) this.#window.cancelAnimationFrame(this.#draftRefreshFrame);
    this.#draftRefreshFrame = undefined;
    composer?.remove();
    this.#draftComposer = undefined;
    this.#draftFocusedElement = undefined;
    this.#draftFocusParkedOn = undefined;
    this.#draftFocusRestoreInProgress = false;
    this.#draft = undefined;
    this.#draftFocusReturn = undefined;
    if (!keepFocusParked) {
      focusSentinel?.remove();
      this.#draftFocusSentinel = undefined;
    }
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
    this.#draftFocusSentinel?.remove();
    this.#draftFocusSentinel = undefined;
    this.#retiredDraftRequestIds.clear();
    if (bridge) {
      try {
        bridge.close();
      } catch (error) {
        failures.push(error);
      }
    }
    if (frame) {
      if (loadListener) try {
        frame.removeEventListener("load", loadListener);
      } catch (error) {
        failures.push(error);
      }
      try {
        frame.removeEventListener("focus", this.#handleFrameFocus, true);
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
  const context = requireAnchorContext(value.context);
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
    context,
    maxMessageBytes: value.maxMessageBytes,
  });
}

function requireAnchorContext(value: unknown): AnchorContext {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ReviewFrameHostError("invalid_config", "review frame Anchor Context is invalid");
  }
  const record = value as Record<string, unknown>;
  const context: Record<keyof AnchorContext, string> = {
    reviewId: requireLegacyAnchorContextValue(record.reviewId),
    prototypeId: requireLegacyAnchorContextValue(record.prototypeId),
    revisionId: requireLegacyAnchorContextValue(record.revisionId),
    viewportId: requireLegacyAnchorContextValue(record.viewportId),
    variantId: requireLegacyAnchorContextValue(record.variantId),
    route: requireLegacyAnchorContextValue(record.route),
    deviceId: requireAnchorContextIdentifier(record.deviceId),
    surfaceId: requireAnchorContextIdentifier(record.surfaceId),
  };
  return Object.freeze(context);
}

function requireAnchorContextIdentifier(value: unknown): string {
  const result = readAnchorIdentifier(value);
  if (!result.ok) throw new ReviewFrameHostError("invalid_config", "review frame Anchor Context is invalid");
  return result.value;
}

function requireLegacyAnchorContextValue(value: unknown): string {
  const result = readLegacyAnchorCorrelationValue(value);
  if (!result.ok) throw new ReviewFrameHostError("invalid_config", "review frame Anchor Context is invalid");
  return result.value;
}

function sameAnchorContext(left: AnchorContext, right: AnchorContext): boolean {
  return (["reviewId", "prototypeId", "revisionId", "viewportId", "variantId", "route", "deviceId", "surfaceId"] as const)
    .every((key) => left[key] === right[key]);
}

function hasCurrentDraftContext(context: AnchorContext): boolean {
  for (const key of ["reviewId", "prototypeId", "revisionId", "viewportId", "variantId", "deviceId", "surfaceId"] as const) {
    if (!readAnchorIdentifier(context[key]).ok) return false;
  }
  return readBridgeRoute(context.route).ok;
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

function crossesClosedShadowBoundary(element: Element): boolean {
  for (let current: Element | null = element; current;) {
    const root = current.getRootNode();
    if (!(root instanceof ShadowRoot)) return false;
    if (root.mode === "closed") return true;
    current = root.host;
  }
  return false;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(value, maximum));
}

function frameContentProjection(frame: HTMLIFrameElement): Readonly<{
  left: number;
  top: number;
  right: number;
  bottom: number;
  visibleLeft: number;
  visibleTop: number;
  visibleRight: number;
  visibleBottom: number;
  scaleX: number;
  scaleY: number;
}> | undefined {
  if (!hasPositiveAxisAlignedFrameProjection(frame)) return undefined;
  const rect = frame.getBoundingClientRect();
  const borderBoxWidth = frame.offsetWidth;
  const borderBoxHeight = frame.offsetHeight;
  if (borderBoxWidth <= 0 || borderBoxHeight <= 0 || frame.clientWidth <= 0 || frame.clientHeight <= 0) return undefined;
  const window = frame.ownerDocument.defaultView;
  if (!window) return undefined;
  const style = window.getComputedStyle(frame);
  const paddingLeft = readNonNegativePixelLength(style.paddingLeft);
  const paddingRight = readNonNegativePixelLength(style.paddingRight);
  const paddingTop = readNonNegativePixelLength(style.paddingTop);
  const paddingBottom = readNonNegativePixelLength(style.paddingBottom);
  if ([paddingLeft, paddingRight, paddingTop, paddingBottom].some((value) => value === undefined)) return undefined;
  const contentWidth = frame.clientWidth - paddingLeft! - paddingRight!;
  const contentHeight = frame.clientHeight - paddingTop! - paddingBottom!;
  if (contentWidth <= 0 || contentHeight <= 0) return undefined;
  const scaleX = rect.width / borderBoxWidth;
  const scaleY = rect.height / borderBoxHeight;
  if (!Number.isFinite(scaleX) || !Number.isFinite(scaleY) || scaleX <= 0 || scaleY <= 0) return undefined;
  const left = rect.left + ((frame.clientLeft + paddingLeft!) * scaleX);
  const top = rect.top + ((frame.clientTop + paddingTop!) * scaleY);
  const right = left + (contentWidth * scaleX);
  const bottom = top + (contentHeight * scaleY);
  const visibleBounds = frameVisibleBounds(frame, { left, top, right, bottom });
  if (!visibleBounds) return undefined;
  return {
    left,
    top,
    right,
    bottom,
    visibleLeft: visibleBounds.left,
    visibleTop: visibleBounds.top,
    visibleRight: visibleBounds.right,
    visibleBottom: visibleBounds.bottom,
    scaleX,
    scaleY,
  };
}

function readNonNegativePixelLength(value: string): number | undefined {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function frameVisibleBounds(
  frame: HTMLIFrameElement,
  content: Readonly<{ left: number; top: number; right: number; bottom: number }>,
): Readonly<{ left: number; top: number; right: number; bottom: number }> | undefined {
  const window = frame.ownerDocument.defaultView;
  if (!window) return undefined;
  let left = content.left;
  let top = content.top;
  let right = content.right;
  let bottom = content.bottom;
  let resumeOverflowAt: Element | undefined;
  for (let element: Element | null = frame; element; element = composedParentElement(element)) {
    const style = window.getComputedStyle(element);
    if (
      (element === frame && style.visibility !== "visible")
      || Number.parseFloat(style.opacity) <= 0
      || hasZeroOpacityFilter(style.filter)
      || style.contentVisibility === "hidden"
      || ((style.position === "absolute" || style.position === "fixed") && Boolean(style.clip) && style.clip !== "auto")
      || (Boolean(style.clipPath) && style.clipPath !== "none")
      || (Boolean(style.maskImage) && style.maskImage !== "none")
    ) return undefined;
    if (resumeOverflowAt) {
      if (element !== resumeOverflowAt) continue;
      resumeOverflowAt = undefined;
    }
    if (element !== frame) {
      const paintContained = /(?:^|\s)(?:paint|strict|content)(?:\s|$)/u.test(style.contain);
      const bodyClipIsPropagated = element === frame.ownerDocument.body
        && bodyOverflowPropagatesToViewport(frame.ownerDocument, window);
      const clipsX = paintContained || (!bodyClipIsPropagated && style.overflowX !== "visible");
      const clipsY = paintContained || (!bodyClipIsPropagated && style.overflowY !== "visible");
      if (clipsX || clipsY) {
        const clippingBoxes = projectedClippingBoxes(element, style);
        if (!clippingBoxes) return undefined;
        if (clipsX) {
          const horizontal = style.overflowX === "clip" || (paintContained && style.overflowX === "visible")
            ? clippingBoxes.overflowClip
            : clippingBoxes.padding;
          left = Math.max(left, horizontal.left);
          right = Math.min(right, horizontal.right);
        }
        if (clipsY) {
          const vertical = style.overflowY === "clip" || (paintContained && style.overflowY === "visible")
            ? clippingBoxes.overflowClip
            : clippingBoxes.padding;
          top = Math.max(top, vertical.top);
          bottom = Math.min(bottom, vertical.bottom);
        }
        if (left > right || top > bottom) return undefined;
      }
    }
    if (style.position === "fixed" || style.position === "absolute") {
      const containingBlock = style.position === "fixed"
        ? closestFixedContainingBlock(element, window)
        : closestAbsoluteContainingBlock(element, window);
      if (!containingBlock) break;
      resumeOverflowAt = containingBlock;
    }
  }
  return { left, top, right, bottom };
}

function hasZeroOpacityFilter(value: string): boolean {
  return /(?:^|\s)opacity\(\s*(?:0+(?:\.0+)?|0+(?:\.0+)?%)\s*\)/u.test(value);
}

function framePaintsAtPoint(frame: HTMLIFrameElement, x: number, y: number): boolean {
  try {
    let root: Document | ShadowRoot = frame.ownerDocument;
    for (;;) {
      const elements: Element[] = root.elementsFromPoint(x, y);
      if (elements.includes(frame)) return true;
      const shadowHost = shadowHostInRoot(frame, root);
      if (!shadowHost?.shadowRoot || !elements.includes(shadowHost)) break;
      root = shadowHost.shadowRoot;
    }
  } catch {
    return false;
  }
  return frameHasPointerInertChain(frame) && !frameHasRoundedClipChain(frame);
}

function frameHasPointerInertChain(frame: HTMLIFrameElement): boolean {
  const window = frame.ownerDocument.defaultView;
  if (!window) return false;
  for (let element: Element | null = frame; element; element = composedParentElement(element)) {
    if (window.getComputedStyle(element).pointerEvents === "none") return true;
  }
  return false;
}

function frameHasRoundedClipChain(frame: HTMLIFrameElement): boolean {
  const window = frame.ownerDocument.defaultView;
  if (!window) return true;
  let resumeOverflowAt: Element | undefined;
  for (let element: Element | null = frame; element; element = composedParentElement(element)) {
    const style = window.getComputedStyle(element);
    if (resumeOverflowAt) {
      if (element !== resumeOverflowAt) continue;
      resumeOverflowAt = undefined;
    }
    const overflowClipsDescendants = element !== frame.ownerDocument.body
      || !bodyOverflowPropagatesToViewport(frame.ownerDocument, window);
    const clipsDescendants = (overflowClipsDescendants && (
      style.overflowX !== "visible"
      || style.overflowY !== "visible"
    ))
      || /(?:^|\s)(?:paint|strict|content)(?:\s|$)/u.test(style.contain);
    if (clipsDescendants && [
      style.borderTopLeftRadius,
      style.borderTopRightRadius,
      style.borderBottomRightRadius,
      style.borderBottomLeftRadius,
    ].some((value) => value.trim().split(/\s+/u).some((token) => Number.parseFloat(token) > 0))) return true;
    if (style.position === "fixed" || style.position === "absolute") {
      const containingBlock = style.position === "fixed"
        ? closestFixedContainingBlock(element, window)
        : closestAbsoluteContainingBlock(element, window);
      if (!containingBlock) break;
      resumeOverflowAt = containingBlock;
    }
  }
  return false;
}

function bodyOverflowPropagatesToViewport(document: Document, window: Window): boolean {
  const body = document.body;
  const root = document.documentElement;
  if (!body || body.parentElement !== root) return false;
  const rootStyle = window.getComputedStyle(root);
  const bodyStyle = window.getComputedStyle(body);
  return rootStyle.display !== "none"
    && bodyStyle.display !== "none"
    && rootStyle.overflowX === "visible"
    && rootStyle.overflowY === "visible"
    && rootStyle.contain === "none"
    && bodyStyle.contain === "none";
}

function shadowHostInRoot(element: Element, root: Document | ShadowRoot): Element | undefined {
  let current: Element = element;
  for (;;) {
    const currentRoot = current.getRootNode();
    if (!isOpenShadowRoot(currentRoot)) return undefined;
    const host = currentRoot.host;
    if (host.getRootNode() === root) return host;
    current = host;
  }
}

function isOpenShadowRoot(root: Node): root is ShadowRoot {
  return root.nodeType === 11
    && "host" in root
    && "mode" in root
    && root.mode === "open";
}

function closestFixedContainingBlock(element: Element, window: Window): Element | undefined {
  for (let current = composedParentElement(element); current; current = composedParentElement(current)) {
    if (establishesViewportFixedContainingBlock(window.getComputedStyle(current))) return current;
  }
  return undefined;
}

function closestAbsoluteContainingBlock(element: Element, window: Window): Element | undefined {
  for (let current = composedParentElement(element); current; current = composedParentElement(current)) {
    const style = window.getComputedStyle(current);
    if (style.display === "none" || style.display === "contents") continue;
    if (style.position !== "static" || establishesViewportFixedContainingBlock(style)) return current;
  }
  return undefined;
}

function deepestActiveElement(root: Document | ShadowRoot): Element | undefined {
  let active = root.activeElement ?? undefined;
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
  return active;
}

function hostProvidesDraftStyles(host: Element, window: Window): boolean {
  const probe = host.ownerDocument.createElement("section");
  probe.className = "crl-frame-draft";
  probe.hidden = true;
  host.appendChild(probe);
  try {
    return window.getComputedStyle(probe).getPropertyValue(DRAFT_STYLE_SENTINEL).trim() === "1";
  } finally {
    probe.remove();
  }
}

function focusShellHost(host: Element): boolean {
  if (!isFocusableElement(host)) return false;
  const previousTabIndex = host.getAttribute("tabindex");
  host.setAttribute("tabindex", "-1");
  try {
    host.focus({ preventScroll: true });
    return deepestActiveElement(host.ownerDocument) === host;
  } catch {
    return false;
  } finally {
    if (previousTabIndex === null) host.removeAttribute("tabindex");
    else host.setAttribute("tabindex", previousTabIndex);
  }
}

interface ProjectedClippingRect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

function projectedClippingBoxes(
  element: Element,
  style: CSSStyleDeclaration,
): Readonly<{ padding: ProjectedClippingRect; overflowClip: ProjectedClippingRect }> | undefined {
  const box = element as Element & {
    readonly offsetWidth?: number;
    readonly offsetHeight?: number;
  };
  const borderBoxWidth = box.offsetWidth;
  const borderBoxHeight = box.offsetHeight;
  if (!borderBoxWidth || !borderBoxHeight || element.clientWidth <= 0 || element.clientHeight <= 0) return undefined;
  const rect = element.getBoundingClientRect();
  const scaleX = rect.width / borderBoxWidth;
  const scaleY = rect.height / borderBoxHeight;
  if (!Number.isFinite(scaleX) || !Number.isFinite(scaleY) || scaleX <= 0 || scaleY <= 0) return undefined;
  const left = rect.left + (element.clientLeft * scaleX);
  const top = rect.top + (element.clientTop * scaleY);
  const padding = {
    left,
    top,
    right: left + (element.clientWidth * scaleX),
    bottom: top + (element.clientHeight * scaleY),
  };
  const clipMargin = readOverflowClipMargin(style.getPropertyValue("overflow-clip-margin"));
  if (!clipMargin) return undefined;
  let origin: ProjectedClippingRect;
  if (clipMargin.box === "border-box") {
    origin = { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
  } else if (clipMargin.box === "content-box") {
    const paddingLeft = readNonNegativePixelLength(style.paddingLeft);
    const paddingRight = readNonNegativePixelLength(style.paddingRight);
    const paddingTop = readNonNegativePixelLength(style.paddingTop);
    const paddingBottom = readNonNegativePixelLength(style.paddingBottom);
    if ([paddingLeft, paddingRight, paddingTop, paddingBottom].some((value) => value === undefined)) return undefined;
    origin = {
      left: padding.left + (paddingLeft! * scaleX),
      top: padding.top + (paddingTop! * scaleY),
      right: padding.right - (paddingRight! * scaleX),
      bottom: padding.bottom - (paddingBottom! * scaleY),
    };
  } else {
    origin = padding;
  }
  return {
    padding,
    overflowClip: {
      left: origin.left - (clipMargin.length * scaleX),
      top: origin.top - (clipMargin.length * scaleY),
      right: origin.right + (clipMargin.length * scaleX),
      bottom: origin.bottom + (clipMargin.length * scaleY),
    },
  };
}

function readOverflowClipMargin(
  value: string,
): Readonly<{ box: "border-box" | "content-box" | "padding-box"; length: number }> | undefined {
  let box: "border-box" | "content-box" | "padding-box" = "padding-box";
  let length = 0;
  let sawBox = false;
  let sawLength = false;
  for (const token of value.trim().split(/\s+/u).filter(Boolean)) {
    if (token === "border-box" || token === "content-box" || token === "padding-box") {
      if (sawBox) return undefined;
      box = token;
      sawBox = true;
      continue;
    }
    const parsed = readNonNegativePixelLength(token);
    if (sawLength || parsed === undefined) return undefined;
    length = parsed;
    sawLength = true;
  }
  return { box, length };
}

function hasPositiveAxisAlignedFrameProjection(frame: HTMLIFrameElement): boolean {
  const window = frame.ownerDocument.defaultView;
  if (!window) return false;
  const DOMMatrixConstructor = (window as unknown as { DOMMatrix: typeof DOMMatrix }).DOMMatrix;
  if (typeof DOMMatrixConstructor !== "function") return false;
  for (let element: Element | null = frame; element; element = composedParentElement(element)) {
    const style = window.getComputedStyle(element);
    if (
      (Boolean(style.perspective) && style.perspective !== "none")
      || (Boolean(style.offsetPath) && style.offsetPath !== "none")
      || !hasPositiveTwoDimensionalScale(style.scale)
    ) return false;
    const transforms = [
      style.transform,
      !style.rotate || style.rotate === "none" ? "none" : `rotate(${style.rotate})`,
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

function hasPositiveTwoDimensionalScale(value: string): boolean {
  if (!value || value === "none") return true;
  const tokens = value.trim().split(/\s+/u);
  if (tokens.length < 1 || tokens.length > 3) return false;
  const factors = tokens.map(readScaleFactor);
  if (factors.some((factor) => factor === undefined)) return false;
  const x = factors[0];
  if (x === undefined) return false;
  const y = factors[1] ?? x;
  const z = factors[2] ?? 1;
  return x > 0 && y > 0 && z === 1;
}

function readScaleFactor(value: string): number | undefined {
  if (value.endsWith("%")) {
    const percentage = Number(value.slice(0, -1));
    return Number.isFinite(percentage) ? percentage / 100 : undefined;
  }
  const factor = Number(value);
  return Number.isFinite(factor) ? factor : undefined;
}

function closestComposedActiveModal(element: Element): Element | undefined {
  for (let current: Element | null = element; current; current = composedParentElement(current)) {
    if (current.matches("dialog:modal")) return current;
  }
  return undefined;
}

function preservesViewportFixedCoordinates(host: Element, window: Window): boolean {
  for (let current: Element | null = host; current; current = composedParentElement(current)) {
    const style = window.getComputedStyle(current);
    if (establishesViewportFixedContainingBlock(style)) return false;
    if (current.matches("dialog:modal")) break;
  }
  return true;
}

function establishesViewportFixedContainingBlock(style: CSSStyleDeclaration): boolean {
  const value = (property: string): string => style.getPropertyValue(property).trim().toLowerCase();
  const hasNonNoneValue = (property: string): boolean => {
    const propertyValue = value(property);
    return Boolean(propertyValue) && propertyValue !== "none";
  };
  const contentVisibility = value("content-visibility");
  const zoom = value("zoom");
  const willChange = value("will-change")
    .split(",")
    .map((property) => property.trim())
    .filter(Boolean);
  return hasNonNoneValue("transform")
    || hasNonNoneValue("translate")
    || hasNonNoneValue("rotate")
    || hasNonNoneValue("scale")
    || value("transform-style") === "preserve-3d"
    || hasNonNoneValue("perspective")
    || hasNonNoneValue("filter")
    || hasNonNoneValue("backdrop-filter")
    || hasNonNoneValue("offset-path")
    || /(?:^|\s)(?:layout|paint|strict|content)(?:\s|$)/u.test(value("contain"))
    || (Boolean(contentVisibility) && contentVisibility !== "visible")
    || (Boolean(zoom) && zoom !== "normal" && Number.parseFloat(zoom) !== 1)
    || willChange.some((property) => [
      "transform",
      "translate",
      "rotate",
      "scale",
      "transform-style",
      "perspective",
      "filter",
      "backdrop-filter",
      "offset-path",
      "contain",
      "content-visibility",
    ].includes(property));
}

function composedParentElement(element: Element): Element | null {
  if (element.assignedSlot?.ownerDocument === element.ownerDocument) return element.assignedSlot;
  if (element.parentElement) return element.parentElement;
  const host = (element.getRootNode() as DocumentFragment & { host?: Element }).host;
  return host?.ownerDocument === element.ownerDocument ? host : null;
}
