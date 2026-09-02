import {
  CURRENT_ANCHOR_SCHEMA_VERSION,
  type AnchorContext,
  type CurrentAnchor,
  type ThreadAnchor,
} from "./domain.ts";
import {
  ANCHOR_ELEMENT_OFFSET_MINIMUM,
  readAnchorCoordinate,
  readAnchorIdentifier,
  readAnchorMetadata,
  readAnchorSelector,
  readAnchorText,
} from "./anchor-constraints.ts";
import { readBridgeRoute } from "./bridge-constraints.ts";
import type { ReviewShellInteractionMode } from "./shell-state.ts";

export type ReviewDocumentOverlayState = "idle" | "mounted" | "destroyed";

export interface ReviewDocumentOverlaySubmission {
  readonly body: string;
  readonly anchor: CurrentAnchor;
}

export interface ReviewDocumentOverlayThread {
  readonly threadId: string;
  readonly anchorGeneration: number;
  readonly anchor: ThreadAnchor;
  readonly label?: string;
  readonly canReplaceAnchor?: boolean;
}

export interface ReviewDocumentOverlayUnavailableReport {
  readonly threadId: string;
  readonly anchorGeneration: number;
}

export interface ReviewDocumentOverlayReplacementRequest {
  readonly threadId: string;
  readonly anchorGeneration: number;
  readonly anchor: CurrentAnchor;
}

export type ReviewDocumentOverlayCoordinateSpace = "document" | "viewport";

export type ReviewDocumentOverlayThreadAttachment =
  | Readonly<{
    locationAvailability: "available";
    coordinateSpace: ReviewDocumentOverlayCoordinateSpace;
    x: number;
    y: number;
  }>
  | Readonly<{
    locationAvailability: "unavailable";
    recoveryState: Extract<ThreadAnchor, { locationAvailability: "unavailable" }>["recoveryState"];
  }>;

export type ReviewDocumentOverlayPlacementDiagnostic =
  | Readonly<{
    kind: "anchor_unavailable";
    reason: "identity_unresolved" | "target_not_rendered";
    threadId: string;
    anchorGeneration: number;
  }>
  | Readonly<{
    kind: "placement_bug";
    reason: "unsupported_coordinate_projection";
    threadId: string;
    anchorGeneration: number;
  }>;

export interface ReviewDocumentOverlayConfig {
  readonly document: Document;
  readonly context: AnchorContext;
  readonly interactionMode?: ReviewShellInteractionMode;
  readonly onSubmit: (submission: ReviewDocumentOverlaySubmission) => void;
  readonly onReplaceAnchor?: (request: ReviewDocumentOverlayReplacementRequest) => void;
  readonly onOpenThread?: (threadId: string, attachment: ReviewDocumentOverlayThreadAttachment) => void;
  readonly onThreadAttachmentChange?: (threadId: string, attachment: ReviewDocumentOverlayThreadAttachment | undefined) => void;
  readonly onAnchorUnavailable?: (report: ReviewDocumentOverlayUnavailableReport) => void;
  readonly onPlacementDiagnostic?: (diagnostic: ReviewDocumentOverlayPlacementDiagnostic) => void;
}

export interface ReviewDocumentOverlaySnapshot {
  readonly state: ReviewDocumentOverlayState;
  readonly interactionMode: ReviewShellInteractionMode;
  readonly composerOpen: boolean;
}

export type ReviewDocumentOverlayErrorCode = "environment_failure" | "invalid_config" | "invalid_state" | "missing_styles";

export class ReviewDocumentOverlayError extends Error {
  readonly code: ReviewDocumentOverlayErrorCode;

  constructor(code: ReviewDocumentOverlayErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ReviewDocumentOverlayError";
    this.code = code;
  }
}

const STYLE_SENTINEL = "--crl-overlay-owned";
const PLACEMENT_MOTION_EVENTS = [
  "animationstart",
  "animationend",
  "animationcancel",
  "transitionrun",
  "transitionend",
  "transitioncancel",
] as const;
const PROTOTYPE_PRESS_EVENTS = [
  "pointerdown",
  "pointerup",
  "pointercancel",
  "mousedown",
  "mouseup",
  "touchstart",
  "touchend",
  "touchcancel",
] as const;
const PROTOTYPE_PRESS_LISTENER_OPTIONS = Object.freeze({ capture: true, passive: false });
const KEYFRAME_METADATA = new Set(["composite", "computedOffset", "easing", "offset"]);
const COSMETIC_ANIMATION_PROPERTY = /^(?:accentColor|backdropFilter|background|borderColor|boxShadow|caretColor|color|fill|filter|floodColor|lightingColor|opacity|outlineColor|stopColor|stroke|textDecorationColor|textEmphasisColor|textShadow)$/;
const ELEMENT_LOCAL_ANIMATION_PROPERTY = /^(?:clipPath|offsetAnchor|offsetDistance|offsetPath|offsetPosition|offsetRotate|perspective|perspectiveOrigin|rotate|scale|transform|transformOrigin|transformStyle|translate)$/;
const ANCHOR_UNAVAILABLE_STABILITY_MS = 500;
type AnchorUnavailableReason = "identity_unresolved" | "target_not_rendered";
type PrototypePressChannel = "pointer" | "mouse" | "touch";
interface PrototypePressState {
  readonly channel: PrototypePressChannel;
  readonly identifier: number;
  readonly target: Element;
  readonly anchorTarget?: Element;
}
interface PrototypePressActivation {
  readonly target: Element;
  readonly anchorTarget: Element;
  readonly clientX: number;
  readonly clientY: number;
}
type CanonicalPrototypePress = Readonly<{
  phase: "down" | "up" | "cancel";
  channel: PrototypePressChannel;
  identifier: number;
  point?: Readonly<{ clientX: number; clientY: number }>;
}>;

export class ReviewDocumentOverlay {
  readonly #document: Document;
  readonly #window: Window;
  readonly #context: AnchorContext;
  readonly #newThreadAnchoringAvailable: boolean;
  readonly #onSubmit: (submission: ReviewDocumentOverlaySubmission) => void;
  readonly #onReplaceAnchor?: (request: ReviewDocumentOverlayReplacementRequest) => void;
  readonly #onOpenThread: (threadId: string, attachment: ReviewDocumentOverlayThreadAttachment) => void;
  readonly #onThreadAttachmentChange: (threadId: string, attachment: ReviewDocumentOverlayThreadAttachment | undefined) => void;
  readonly #onAnchorUnavailable: (report: ReviewDocumentOverlayUnavailableReport) => void;
  readonly #onPlacementDiagnostic: (diagnostic: ReviewDocumentOverlayPlacementDiagnostic) => void;
  readonly #threads = new Map<string, ReviewDocumentOverlayThread>();
  readonly #pins = new Map<string, HTMLButtonElement>();
  readonly #placedTargets = new Map<string, Element>();
  readonly #stickyTrackedThreadIds = new Set<string>();
  readonly #threadAttachments = new Map<string, ReviewDocumentOverlayThreadAttachment>();
  readonly #failedThreadAttachmentNotifications = new Set<string>();
  readonly #threadAttachmentNotificationsInFlight = new Map<string, object>();
  readonly #reportedUnavailable = new Set<string>();
  readonly #pendingUnavailableReports = new Map<string, number>();
  readonly #replacementRequested = new Set<string>();
  readonly #reportedPlacementDiagnostics = new Set<string>();
  readonly #resizeObservedTargets = new Set<Element>();
  readonly #intersectionObservedTargets = new Set<Element>();
  readonly #placementMotionSources = new Set<Element>();
  #interactionMode: ReviewShellInteractionMode;
  #state: ReviewDocumentOverlayState = "idle";
  #root?: HTMLElement;
  #composer?: HTMLElement;
  #recoveryPanel?: HTMLElement;
  #replacementArmedThreadId?: string;
  #draftAnchor?: CurrentAnchor;
  #composerFocusReturn?: Element;
  #mutationObserver?: MutationObserver;
  #resizeObserver?: ResizeObserver;
  #intersectionObserver?: IntersectionObserver;
  #resizeObservedBody?: HTMLElement;
  #layoutShiftObserver?: PerformanceObserver;
  #refreshFrame?: number;
  #layoutShiftRefreshTimeout?: number;
  #pendingPrototypePress?: PrototypePressState;
  #pressActivatedAnchorTarget?: Element;
  #pressActivationResetTimeout?: number;
  #lastWindowScrollAt = Number.NEGATIVE_INFINITY;
  #lastWindowScrollX: number;
  #lastWindowScrollY: number;

  constructor(config: ReviewDocumentOverlayConfig) {
    if (!isDocument(config?.document) || !config.document.defaultView) {
      throw new ReviewDocumentOverlayError("invalid_config", "review overlay document is invalid");
    }
    if (typeof config.onSubmit !== "function") {
      throw new ReviewDocumentOverlayError("invalid_config", "review overlay submit handler is required");
    }
    for (const [name, callback] of [
      ["onReplaceAnchor", config.onReplaceAnchor],
      ["onOpenThread", config.onOpenThread],
      ["onThreadAttachmentChange", config.onThreadAttachmentChange],
      ["onAnchorUnavailable", config.onAnchorUnavailable],
      ["onPlacementDiagnostic", config.onPlacementDiagnostic],
    ] as const) {
      if (callback !== undefined && typeof callback !== "function") {
        throw new ReviewDocumentOverlayError("invalid_config", `review overlay ${name} callback is invalid`);
      }
    }
    this.#document = config.document;
    this.#window = config.document.defaultView;
    this.#lastWindowScrollX = this.#window.scrollX;
    this.#lastWindowScrollY = this.#window.scrollY;
    this.#context = requireAnchorContext(config.context);
    this.#newThreadAnchoringAvailable = isNewThreadContext(this.#context);
    this.#interactionMode = requireInteractionMode(config.interactionMode ?? "pointer");
    this.#onSubmit = config.onSubmit;
    this.#onReplaceAnchor = config.onReplaceAnchor;
    this.#onOpenThread = config.onOpenThread ?? (() => undefined);
    this.#onThreadAttachmentChange = config.onThreadAttachmentChange ?? (() => undefined);
    this.#onAnchorUnavailable = config.onAnchorUnavailable ?? (() => undefined);
    this.#onPlacementDiagnostic = config.onPlacementDiagnostic ?? (() => undefined);
  }

  mount(): ReviewDocumentOverlaySnapshot {
    if (this.#state !== "idle") {
      throw new ReviewDocumentOverlayError("invalid_state", "review overlay can only mount once");
    }
    if (!this.#document.body || this.#document.querySelector("[data-collab-review-layer='overlay']")) {
      throw new ReviewDocumentOverlayError("invalid_state", "review overlay requires an available document body");
    }
    const root = this.#document.createElement("div");
    root.className = "crl-overlay";
    root.popover = "manual";
    root.dataset.collabReviewLayer = "overlay";
    root.dataset.interactionMode = this.#interactionMode;
    (activeModalDialog(this.#document) ?? this.#document.body).appendChild(root);
    try {
      root.showPopover();
    } catch (cause) {
      root.remove();
      throw new ReviewDocumentOverlayError("environment_failure", "review overlay top layer could not be attached", { cause });
    }
    if (this.#window.getComputedStyle(root).getPropertyValue(STYLE_SENTINEL).trim() !== "1") {
      root.remove();
      throw new ReviewDocumentOverlayError("missing_styles", "review overlay stylesheet is not loaded in this document");
    }
    let mutationObserver: MutationObserver | undefined;
    let resizeObserver: ResizeObserver | undefined;
    let intersectionObserver: IntersectionObserver | undefined;
    let layoutShiftObserver: PerformanceObserver | undefined;
    try {
      const MutationObserverConstructor = (this.#window as unknown as WindowWithObservers).MutationObserver;
      const ResizeObserverConstructor = (this.#window as unknown as WindowWithObservers).ResizeObserver;
      const IntersectionObserverConstructor = (this.#window as unknown as WindowWithObservers).IntersectionObserver;
      mutationObserver = new MutationObserverConstructor(this.#handleDocumentMutations);
      mutationObserver.observe(this.#document.documentElement, { attributes: true, childList: true, subtree: true });
      resizeObserver = new ResizeObserverConstructor(this.#scheduleRefresh);
      resizeObserver.observe(this.#document.documentElement);
      resizeObserver.observe(this.#document.body);
      intersectionObserver = new IntersectionObserverConstructor(this.#handleTargetIntersection, {
        root: null,
        rootMargin: "0px",
      });
      layoutShiftObserver = observeLayoutShifts(this.#window, root, this.#handleLayoutShift);
      for (const type of PROTOTYPE_PRESS_EVENTS) {
        this.#document.addEventListener(type, this.#handlePrototypePress, PROTOTYPE_PRESS_LISTENER_OPTIONS);
      }
      this.#document.addEventListener("click", this.#handleDocumentClick, true);
      this.#document.addEventListener("keydown", this.#handleDocumentKeydown, true);
      this.#document.addEventListener("keyup", this.#handleDocumentKeyup, true);
      this.#document.addEventListener("toggle", this.#handlePopoverToggle, true);
      for (const type of PLACEMENT_MOTION_EVENTS) {
        this.#document.addEventListener(type, this.#handlePlacementMotion, true);
      }
      this.#window.addEventListener("scroll", this.#handleScroll, true);
      this.#window.addEventListener("resize", this.#scheduleRefresh);
    } catch (cause) {
      for (const type of PROTOTYPE_PRESS_EVENTS) {
        this.#document.removeEventListener(type, this.#handlePrototypePress, true);
      }
      this.#document.removeEventListener("click", this.#handleDocumentClick, true);
      this.#document.removeEventListener("keydown", this.#handleDocumentKeydown, true);
      this.#document.removeEventListener("keyup", this.#handleDocumentKeyup, true);
      this.#document.removeEventListener("toggle", this.#handlePopoverToggle, true);
      for (const type of PLACEMENT_MOTION_EVENTS) {
        this.#document.removeEventListener(type, this.#handlePlacementMotion, true);
      }
      this.#window.removeEventListener("scroll", this.#handleScroll, true);
      this.#window.removeEventListener("resize", this.#scheduleRefresh);
      mutationObserver?.disconnect();
      resizeObserver?.disconnect();
      intersectionObserver?.disconnect();
      layoutShiftObserver?.disconnect();
      root.remove();
      throw new ReviewDocumentOverlayError("environment_failure", "review overlay browser observers could not be attached", { cause });
    }
    this.#root = root;
    this.#mutationObserver = mutationObserver;
    this.#resizeObserver = resizeObserver;
    this.#intersectionObserver = intersectionObserver;
    this.#resizeObservedBody = this.#document.body;
    this.#layoutShiftObserver = layoutShiftObserver;
    this.#state = "mounted";
    return this.snapshot();
  }

  setInteractionMode(mode: ReviewShellInteractionMode): ReviewDocumentOverlaySnapshot {
    this.#requireMounted();
    this.#interactionMode = requireInteractionMode(mode);
    this.#root!.dataset.interactionMode = this.#interactionMode;
    for (const pin of this.#pins.values()) this.#setPinInteractivity(pin);
    if (mode === "pointer") {
      this.#closeComposer();
      this.#clearPrototypePress();
      this.#replacementArmedThreadId = undefined;
    }
    this.#renderRecoveryPanel();
    return this.snapshot();
  }

  setThreads(threads: readonly ReviewDocumentOverlayThread[]): ReviewDocumentOverlaySnapshot {
    this.#requireMounted();
    if (!Array.isArray(threads)) throw new ReviewDocumentOverlayError("invalid_config", "review overlay Threads are invalid");
    const next = new Map<string, ReviewDocumentOverlayThread>();
    for (const value of threads) {
      const thread = requireThread(value, this.#context);
      if (next.has(thread.threadId)) throw new ReviewDocumentOverlayError("invalid_config", "review overlay Thread ids must be unique");
      next.set(thread.threadId, thread);
    }
    this.#reconcileOneShotState(next);
    this.#threads.clear();
    for (const [threadId, thread] of next) this.#threads.set(threadId, thread);
    this.#replacementArmedThreadId = undefined;
    for (const threadId of this.#pins.keys()) {
      if (!next.has(threadId)) this.#removePin(threadId);
    }
    for (const threadId of this.#threadAttachments.keys()) {
      if (!next.has(threadId)) this.#updateThreadAttachment(threadId, undefined);
    }
    this.#refreshPlacements();
    this.#renderRecoveryPanel();
    return this.snapshot();
  }

  beginAnchorReplacement(threadId: string): ReviewDocumentOverlaySnapshot {
    this.#requireMounted();
    const thread = this.#threads.get(threadId);
    if (!thread
      || thread.anchor.locationAvailability !== "unavailable"
      || thread.canReplaceAnchor !== true
      || !this.#onReplaceAnchor
      || this.#replacementRequested.has(unavailableKey(thread))) {
      throw new ReviewDocumentOverlayError("invalid_state", "review overlay Anchor replacement is not available");
    }
    this.#closeComposer();
    this.#replacementArmedThreadId = thread.threadId;
    this.#renderRecoveryPanel();
    return this.snapshot();
  }

  refresh(): ReviewDocumentOverlaySnapshot {
    this.#requireMounted();
    this.#refreshPlacements(true);
    return this.snapshot();
  }

  snapshot(): ReviewDocumentOverlaySnapshot {
    return Object.freeze({
      state: this.#state,
      interactionMode: this.#interactionMode,
      composerOpen: this.#composer !== undefined,
    });
  }

  destroy(): void {
    if (this.#state === "destroyed") return;
    for (const type of PROTOTYPE_PRESS_EVENTS) {
      this.#document.removeEventListener(type, this.#handlePrototypePress, true);
    }
    this.#document.removeEventListener("click", this.#handleDocumentClick, true);
    this.#document.removeEventListener("keydown", this.#handleDocumentKeydown, true);
    this.#document.removeEventListener("keyup", this.#handleDocumentKeyup, true);
    this.#document.removeEventListener("toggle", this.#handlePopoverToggle, true);
    for (const type of PLACEMENT_MOTION_EVENTS) {
      this.#document.removeEventListener(type, this.#handlePlacementMotion, true);
    }
    this.#window.removeEventListener("scroll", this.#handleScroll, true);
    this.#window.removeEventListener("resize", this.#scheduleRefresh);
    this.#mutationObserver?.disconnect();
    this.#resizeObserver?.disconnect();
    this.#intersectionObserver?.disconnect();
    this.#layoutShiftObserver?.disconnect();
    if (this.#refreshFrame !== undefined) this.#window.cancelAnimationFrame(this.#refreshFrame);
    if (this.#layoutShiftRefreshTimeout !== undefined) this.#window.clearTimeout(this.#layoutShiftRefreshTimeout);
    this.#clearPrototypePress();
    for (const timeout of this.#pendingUnavailableReports.values()) this.#window.clearTimeout(timeout);
    this.#mutationObserver = undefined;
    this.#resizeObserver = undefined;
    this.#intersectionObserver = undefined;
    this.#resizeObservedBody = undefined;
    this.#layoutShiftObserver = undefined;
    this.#refreshFrame = undefined;
    this.#layoutShiftRefreshTimeout = undefined;
    this.#resizeObservedTargets.clear();
    this.#intersectionObservedTargets.clear();
    this.#placementMotionSources.clear();
    this.#closeComposer(false);
    this.#recoveryPanel?.remove();
    this.#recoveryPanel = undefined;
    this.#replacementArmedThreadId = undefined;
    this.#root?.remove();
    this.#root = undefined;
    this.#threads.clear();
    this.#pins.clear();
    this.#placedTargets.clear();
    this.#stickyTrackedThreadIds.clear();
    this.#threadAttachments.clear();
    this.#failedThreadAttachmentNotifications.clear();
    this.#threadAttachmentNotificationsInFlight.clear();
    this.#reportedUnavailable.clear();
    this.#pendingUnavailableReports.clear();
    this.#replacementRequested.clear();
    this.#reportedPlacementDiagnostics.clear();
    this.#state = "destroyed";
  }

  readonly #handleDocumentClick = (event: MouseEvent): void => {
    if (this.#state !== "mounted" || this.#interactionMode !== "comment" || !event.isTrusted) return;
    const target = event.target;
    if (!isElement(target) || target.ownerDocument !== this.#document || this.#root?.contains(target)) return;
    this.#syncRootHost(target);
    const anchorTarget = target.closest("[data-collab-review-id]");
    if (!anchorTarget || anchorTarget.ownerDocument !== this.#document) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    if (!hasRenderedBox(anchorTarget, this.#window)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (this.#pressActivatedAnchorTarget === anchorTarget) {
      this.#clearPressActivation();
      return;
    }
    const targetRect = anchorTarget.getBoundingClientRect();
    const clientX = event.detail === 0 ? targetRect.left + (targetRect.width / 2) : event.clientX;
    const clientY = event.detail === 0 ? targetRect.top + (targetRect.height / 2) : event.clientY;
    this.#activateAnchorTarget(target, anchorTarget, clientX, clientY);
  };

  #activateAnchorTarget(target: Element, anchorTarget: Element, clientX: number, clientY: number): void {
    const activeElement = this.#document.activeElement;
    const focusReturn = findFocusableAncestor(target, anchorTarget)
      ?? (isElement(activeElement) && anchorTarget.contains(activeElement) && isFocusableElement(activeElement)
        ? activeElement
        : anchorTarget);
    const anchor = this.#captureAnchor(anchorTarget, clientX, clientY);
    if (!anchor) return;
    if (this.#replacementArmedThreadId) {
      const thread = this.#threads.get(this.#replacementArmedThreadId);
      if (!thread || thread.anchor.locationAvailability !== "unavailable" || !thread.canReplaceAnchor || !this.#onReplaceAnchor) {
        this.#replacementArmedThreadId = undefined;
        this.#renderRecoveryPanel();
        return;
      }
      const request = Object.freeze({
        threadId: thread.threadId,
        anchorGeneration: thread.anchorGeneration,
        anchor,
      });
      this.#onReplaceAnchor(request);
      this.#replacementRequested.add(unavailableKey(thread));
      this.#replacementArmedThreadId = undefined;
      this.#renderRecoveryPanel();
      return;
    }
    if (!this.#newThreadAnchoringAvailable) return;
    this.#openComposer(anchor, focusReturn);
  }

  readonly #handlePrototypePress = (event: Event): void => {
    if (this.#state !== "mounted" || this.#interactionMode !== "comment" || !event.isTrusted) return;
    const target = event.target;
    if (!isElement(target) || target.ownerDocument !== this.#document) return;
    const anchorTarget = target.closest("[data-collab-review-id]");
    const renderedAnchorTarget = anchorTarget?.ownerDocument === this.#document && hasRenderedBox(anchorTarget, this.#window)
      ? anchorTarget
      : undefined;
    const activation = this.#advancePrototypePress(event, target, renderedAnchorTarget);
    if (this.#root?.contains(target) || (anchorTarget && !renderedAnchorTarget)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!activation) return;
    this.#syncRootHost(activation.target);
    this.#rememberPressActivation(activation.anchorTarget);
    this.#activateAnchorTarget(
      activation.target,
      activation.anchorTarget,
      activation.clientX,
      activation.clientY,
    );
  };

  #advancePrototypePress(
    event: Event,
    target: Element,
    anchorTarget: Element | undefined,
  ): PrototypePressActivation | undefined {
    const gesture = readCanonicalPrototypePress(event, this.#window);
    if (!gesture) return undefined;
    if (gesture.phase === "down") {
      this.#pendingPrototypePress = { channel: gesture.channel, identifier: gesture.identifier, target, anchorTarget };
      return undefined;
    }
    const pending = this.#pendingPrototypePress;
    if (!pending || pending.channel !== gesture.channel || pending.identifier !== gesture.identifier) return undefined;
    this.#pendingPrototypePress = undefined;
    const releaseAnchorTarget = gesture.point
      ? renderedAnchorAtPoint(this.#document, this.#window, gesture.point)
      : anchorTarget;
    if (gesture.phase === "cancel" || !pending.anchorTarget || pending.anchorTarget !== releaseAnchorTarget || !gesture.point) {
      return undefined;
    }
    return {
      target: pending.target,
      anchorTarget: pending.anchorTarget,
      clientX: gesture.point.clientX,
      clientY: gesture.point.clientY,
    };
  }

  #rememberPressActivation(anchorTarget: Element): void {
    if (this.#pressActivationResetTimeout !== undefined) {
      this.#window.clearTimeout(this.#pressActivationResetTimeout);
    }
    this.#pressActivatedAnchorTarget = anchorTarget;
    this.#pressActivationResetTimeout = this.#window.setTimeout(() => this.#clearPressActivation(), 1_000);
  }

  #clearPressActivation(): void {
    if (this.#pressActivationResetTimeout !== undefined) {
      this.#window.clearTimeout(this.#pressActivationResetTimeout);
    }
    this.#pressActivationResetTimeout = undefined;
    this.#pressActivatedAnchorTarget = undefined;
  }

  #clearPrototypePress(): void {
    this.#pendingPrototypePress = undefined;
    this.#clearPressActivation();
  }

  readonly #handleDocumentKeydown = (event: KeyboardEvent): void => {
    if (event.isComposing || !event.isTrusted) return;
    if (event.key === "Escape" && (this.#composer || this.#replacementArmedThreadId)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      this.#closeComposer();
      this.#replacementArmedThreadId = undefined;
      this.#renderRecoveryPanel();
      return;
    }
    if (
      this.#state !== "mounted"
      || this.#interactionMode !== "comment"
      || !isKeyboardActivation(event)
    ) return;
    const target = event.target;
    if (!isElement(target) || target.ownerDocument !== this.#document || this.#root?.contains(target)) return;
    this.#syncRootHost(target);
    const anchorTarget = target.closest("[data-collab-review-id]");
    if (!anchorTarget || anchorTarget.ownerDocument !== this.#document) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    if (!hasRenderedBox(anchorTarget, this.#window)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const rect = anchorTarget.getBoundingClientRect();
    this.#activateAnchorTarget(
      target,
      anchorTarget,
      rect.left + (rect.width / 2),
      rect.top + (rect.height / 2),
    );
  };

  readonly #handleDocumentKeyup = (event: KeyboardEvent): void => {
    if (
      event.isComposing
      || this.#state !== "mounted"
      || this.#interactionMode !== "comment"
      || !event.isTrusted
      || !isKeyboardActivation(event)
    ) return;
    const target = event.target;
    if (!isElement(target) || target.ownerDocument !== this.#document || this.#root?.contains(target)) return;
    const anchorTarget = target.closest("[data-collab-review-id]");
    if (anchorTarget?.ownerDocument === this.#document && !hasRenderedBox(anchorTarget, this.#window)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  readonly #handlePopoverToggle = (event: Event): void => {
    const target = event.target;
    if (
      this.#state !== "mounted"
      || !isElement(target)
      || target.ownerDocument !== this.#document
      || target === this.#root
      || this.#root?.contains(target)
      || (event as ToggleEvent).newState !== "open"
    ) return;
    this.#syncRootHost(target);
  };

  readonly #scheduleRefresh = (): void => {
    if (this.#state !== "mounted" || this.#refreshFrame !== undefined) return;
    this.#refreshFrame = this.#window.requestAnimationFrame(() => {
      this.#refreshFrame = undefined;
      this.#refreshPlacements();
    });
  };

  readonly #handleDocumentMutations = (mutations: readonly MutationRecord[]): void => {
    this.#syncRootHost();
    if (mutations.some((mutation) => !this.#root?.contains(mutation.target))) this.#scheduleRefresh();
  };

  readonly #handlePlacementMotion = (event: Event): void => {
    const target = event.target;
    if (!isElement(target) || this.#root?.contains(target)) return;
    if (!this.#placementMotionSources.has(target) && !this.#motionSourceCanAffectPlacement(target)) return;
    this.#placementMotionSources.add(target);
    this.#scheduleRefresh();
  };

  readonly #handleLayoutShift = (): void => {
    if (this.#state !== "mounted") return;
    const quietPeriod = 100;
    const elapsed = this.#window.performance.now() - this.#lastWindowScrollAt;
    if (elapsed >= quietPeriod) {
      this.#scheduleRefresh();
      return;
    }
    if (this.#layoutShiftRefreshTimeout !== undefined) this.#window.clearTimeout(this.#layoutShiftRefreshTimeout);
    this.#layoutShiftRefreshTimeout = this.#window.setTimeout(() => {
      this.#layoutShiftRefreshTimeout = undefined;
      this.#scheduleRefresh();
    }, quietPeriod - elapsed);
  };

  readonly #handleTargetIntersection = (entries: readonly IntersectionObserverEntry[]): void => {
    if (this.#state !== "mounted") return;
    if (entries.some((entry) => entry.isIntersecting && this.#intersectionObservedTargets.has(entry.target))) {
      this.#scheduleRefresh();
    }
  };

  readonly #handleScroll = (event: Event): void => {
    if (this.#state !== "mounted") return;
    const scrollSource = event.target;
    if (
      isElement(scrollSource)
      && !isViewportScrollSource(scrollSource, this.#document, this.#window)
    ) {
      let composerAffected = false;
      if (this.#composer && this.#draftAnchor) {
        const target = resolveAnchorElement(this.#document, this.#draftAnchor);
        composerAffected = Boolean(target && scrollSource.contains(target));
      }
      for (const [threadId, target] of this.#placedTargets) {
        const thread = this.#threads.get(threadId);
        if (thread && scrollSource.contains(target)) this.#refreshThreadPlacement(thread);
      }
      if (composerAffected) this.#refreshComposerPlacement();
      return;
    }
    const horizontalChanged = this.#window.scrollX !== this.#lastWindowScrollX;
    const verticalChanged = this.#window.scrollY !== this.#lastWindowScrollY;
    this.#lastWindowScrollAt = this.#window.performance.now();
    this.#lastWindowScrollX = this.#window.scrollX;
    this.#lastWindowScrollY = this.#window.scrollY;
    for (const [threadId, pin] of this.#pins) {
      if (pin.dataset.coordinateSpace !== "document") continue;
      const thread = this.#threads.get(threadId);
      if (thread) this.#refreshDocumentPinEdgeClamp(thread, pin);
    }
    if (this.#composer?.dataset.coordinateSpace === "document") {
      refreshDocumentComposerEdgeClamp(this.#composer, this.#window);
    }
    if (this.#composer?.dataset.tracksStickyThreshold === "true" && this.#draftAnchor) {
      const target = resolveAnchorElement(this.#document, this.#draftAnchor);
      if (target) {
        const placement = placementForTarget(target, this.#window);
        if (
          !placement
          || this.#composer.dataset.coordinateSpace !== placement.coordinateSpace
          || placementNeedsWindowScrollRefresh(placement, horizontalChanged, verticalChanged)
        ) {
          this.#refreshPlacements();
          return;
        }
      }
    }
    for (const threadId of this.#stickyTrackedThreadIds) {
      const thread = this.#threads.get(threadId);
      if (!thread || thread.anchor.locationAvailability !== "available") continue;
      const pin = this.#pins.get(threadId);
      const target = resolveAnchorElement(this.#document, thread.anchor);
      if (!pin || !target) continue;
      const placement = placementForTarget(target, this.#window);
      if (
        !placement
        || pin.dataset.coordinateSpace !== placement.coordinateSpace
        || placementNeedsWindowScrollRefresh(placement, horizontalChanged, verticalChanged)
      ) {
        this.#refreshPlacements();
        return;
      }
    }
  };

  #refreshPlacements(retryFailedAttachmentNotifications = false): void {
    this.#syncRootHost();
    for (const thread of this.#threads.values()) {
      this.#refreshThreadPlacement(thread, retryFailedAttachmentNotifications);
    }
    if (retryFailedAttachmentNotifications) {
      for (const threadId of [...this.#failedThreadAttachmentNotifications]) {
        if (!this.#threads.has(threadId)) {
          this.#updateThreadAttachment(threadId, this.#threadAttachments.get(threadId), true);
        }
      }
    }
    this.#refreshComposerPlacement();
    this.#syncIntersectionObservedTargets(this.#currentAnchorTargets());
    this.#syncResizeObservedTargets(this.#currentResizeTargets());
    if (this.#hasRunningPlacementMotion()) this.#scheduleRefresh();
  }

  #refreshThreadPlacement(
    thread: ReviewDocumentOverlayThread,
    retryFailedAttachmentNotification = false,
  ): Element | undefined {
    if (thread.anchor.locationAvailability !== "available") {
      this.#removePin(thread.threadId);
      this.#updateThreadAttachment(thread.threadId, Object.freeze({
        locationAvailability: "unavailable",
        recoveryState: thread.anchor.recoveryState,
      }), retryFailedAttachmentNotification);
      return undefined;
    }
    const target = resolveAnchorElement(this.#document, thread.anchor);
    if (!target) {
      this.#removePin(thread.threadId);
      this.#updateThreadAttachment(thread.threadId, undefined, retryFailedAttachmentNotification);
      this.#clearPlacementBug(thread);
      this.#scheduleUnavailableReport(thread);
      return undefined;
    }
    if (!hasRenderedBox(target, this.#window)) {
      this.#removePin(thread.threadId);
      this.#updateThreadAttachment(thread.threadId, undefined, retryFailedAttachmentNotification);
      this.#clearPlacementBug(thread);
      this.#scheduleUnavailableReport(thread);
      return undefined;
    }
    const point = elementLocalPointToViewport(target, thread.anchor.element.offset, this.#window);
    if (!point) {
      this.#removePin(thread.threadId);
      this.#updateThreadAttachment(thread.threadId, undefined, retryFailedAttachmentNotification);
      this.#cancelUnavailableReport(thread);
      this.#reportPlacementBug(thread);
      return undefined;
    }
    this.#cancelUnavailableReport(thread);
    this.#reportedUnavailable.delete(unavailableKey(thread));
    const { x, y } = point;
    const placement = placementForTarget(target, this.#window);
    if (!placement) {
      this.#removePin(thread.threadId);
      this.#updateThreadAttachment(thread.threadId, undefined, retryFailedAttachmentNotification);
      this.#reportPlacementBug(thread);
      return undefined;
    }
    this.#clearPlacementBug(thread);
    this.#placedTargets.set(thread.threadId, target);
    const coordinateSpace = placement.coordinateSpace;
    if (placement.tracksStickyThreshold) this.#stickyTrackedThreadIds.add(thread.threadId);
    else this.#stickyTrackedThreadIds.delete(thread.threadId);
    const pin = this.#pin(thread);
    pin.dataset.coordinateSpace = coordinateSpace;
    pin.style.position = coordinateSpace === "document" ? "absolute" : "fixed";
    pin.hidden = false;
    const halfWidth = pin.offsetWidth / 2;
    const halfHeight = pin.offsetHeight / 2;
    pin.dataset.halfWidth = String(halfWidth);
    pin.dataset.halfHeight = String(halfHeight);
    const pointIsInViewport = x >= 0 && y >= 0 && x <= this.#window.innerWidth && y <= this.#window.innerHeight;
    const pointIsVisibleThroughClipping = pointSurvivesAncestorOverflowClipping(target, x, y, this.#window);
    const attachmentX = coordinateSpace === "document"
      ? (pointIsInViewport ? clamp(x, halfWidth, this.#window.innerWidth - halfWidth) : x) + this.#window.scrollX
      : clamp(x, halfWidth, this.#window.innerWidth - halfWidth);
    const attachmentY = coordinateSpace === "document"
      ? (pointIsInViewport ? clamp(y, halfHeight, this.#window.innerHeight - halfHeight) : y) + this.#window.scrollY
      : clamp(y, halfHeight, this.#window.innerHeight - halfHeight);
    pin.hidden = !pointIsVisibleThroughClipping || (coordinateSpace === "viewport" && !pointIsInViewport);
    if (coordinateSpace === "document") {
      const rawDocumentX = x + this.#window.scrollX;
      const rawDocumentY = y + this.#window.scrollY;
      pin.dataset.rawDocumentX = String(rawDocumentX);
      pin.dataset.rawDocumentY = String(rawDocumentY);
      pin.style.left = `${rawDocumentX}px`;
      pin.style.top = `${rawDocumentY}px`;
      pin.style.setProperty("--crl-pin-edge-x", `${attachmentX - rawDocumentX}px`);
      pin.style.setProperty("--crl-pin-edge-y", `${attachmentY - rawDocumentY}px`);
    } else {
      delete pin.dataset.rawDocumentX;
      delete pin.dataset.rawDocumentY;
      pin.style.left = `${attachmentX}px`;
      pin.style.top = `${attachmentY}px`;
      pin.style.removeProperty("--crl-pin-edge-x");
      pin.style.removeProperty("--crl-pin-edge-y");
    }
    this.#updateThreadAttachment(thread.threadId, Object.freeze({
      locationAvailability: "available",
      coordinateSpace,
      x: attachmentX,
      y: attachmentY,
    }), retryFailedAttachmentNotification);
    return target;
  }

  #refreshDocumentPinEdgeClamp(thread: ReviewDocumentOverlayThread, pin: HTMLButtonElement): void {
    const rawDocumentX = Number(pin.dataset.rawDocumentX);
    const rawDocumentY = Number(pin.dataset.rawDocumentY);
    const halfWidth = Number(pin.dataset.halfWidth);
    const halfHeight = Number(pin.dataset.halfHeight);
    if (![rawDocumentX, rawDocumentY, halfWidth, halfHeight].every(Number.isFinite)) return;
    const x = rawDocumentX - this.#window.scrollX;
    const y = rawDocumentY - this.#window.scrollY;
    const pointIsInViewport = x >= 0 && y >= 0 && x <= this.#window.innerWidth && y <= this.#window.innerHeight;
    const attachmentX = (pointIsInViewport ? clamp(x, halfWidth, this.#window.innerWidth - halfWidth) : x) + this.#window.scrollX;
    const attachmentY = (pointIsInViewport ? clamp(y, halfHeight, this.#window.innerHeight - halfHeight) : y) + this.#window.scrollY;
    const edgeX = `${attachmentX - rawDocumentX}px`;
    const edgeY = `${attachmentY - rawDocumentY}px`;
    if (pin.style.getPropertyValue("--crl-pin-edge-x") !== edgeX) pin.style.setProperty("--crl-pin-edge-x", edgeX);
    if (pin.style.getPropertyValue("--crl-pin-edge-y") !== edgeY) pin.style.setProperty("--crl-pin-edge-y", edgeY);
    this.#updateThreadAttachment(thread.threadId, Object.freeze({
      locationAvailability: "available",
      coordinateSpace: "document",
      x: attachmentX,
      y: attachmentY,
    }));
  }

  #refreshComposerPlacement(): boolean {
    if (!this.#composer || !this.#draftAnchor) return false;
    const target = resolveAnchorElement(this.#document, this.#draftAnchor);
    if (!target || !hasRenderedBox(target, this.#window)) {
      this.#closeComposer();
      return false;
    }
    const point = elementLocalPointToViewport(target, this.#draftAnchor.element.offset, this.#window);
    if (!point) {
      this.#closeComposer();
      return false;
    }
    const placement = placementForTarget(target, this.#window);
    if (!placement) {
      this.#closeComposer();
      return false;
    }
    this.#composer.dataset.tracksStickyThreshold = String(placement.tracksStickyThreshold);
    this.#composer.hidden = !pointSurvivesAncestorOverflowClipping(target, point.x, point.y, this.#window);
    if (this.#composer.hidden) return false;
    positionComposer(this.#composer, point.x, point.y, placement.coordinateSpace, this.#window);
    return true;
  }

  #motionSourceCanAffectPlacement(source: Element): boolean {
    for (const target of this.#placedTargets.values()) {
      if (source === target || source.contains(target)) return true;
    }
    if (this.#composer && this.#draftAnchor) {
      const target = resolveAnchorElement(this.#document, this.#draftAnchor);
      if (target && (source === target || source.contains(target))) return true;
    }
    return source.getAnimations().some((animation) => animationMayAffectSiblingLayout(animation));
  }

  #hasRunningPlacementMotion(): boolean {
    let sourceMotionIsRunning = false;
    for (const source of this.#placementMotionSources) {
      if (hasRunningPlacementAnimation(source)) sourceMotionIsRunning = true;
      else this.#placementMotionSources.delete(source);
    }
    if (sourceMotionIsRunning) return true;
    for (const animation of this.#document.getAnimations()) {
      if (animation.playState === "running" && animationMayAffectSiblingLayout(animation)) return true;
    }
    const placementTargets = new Set(this.#resizeObservedTargets);
    if (this.#composer && this.#draftAnchor) {
      const draftTarget = resolveAnchorElement(this.#document, this.#draftAnchor);
      if (draftTarget) placementTargets.add(draftTarget);
    }
    const inspected = new Set<Element>();
    for (const target of placementTargets) {
      for (let element: Element | null = target; element; element = element.parentElement) {
        if (inspected.has(element)) continue;
        inspected.add(element);
        if (hasRunningPlacementAnimation(element)) return true;
      }
    }
    return false;
  }

  #syncResizeObservedTargets(next: ReadonlySet<Element>): void {
    for (const target of this.#resizeObservedTargets) {
      if (next.has(target)) continue;
      this.#resizeObserver?.unobserve(target);
      this.#resizeObservedTargets.delete(target);
    }
    for (const target of next) {
      if (this.#resizeObservedTargets.has(target)) continue;
      this.#resizeObserver?.observe(target);
      this.#resizeObservedTargets.add(target);
    }
  }

  #syncIntersectionObservedTargets(next: ReadonlySet<Element>): void {
    for (const target of this.#intersectionObservedTargets) {
      if (next.has(target)) continue;
      this.#intersectionObserver?.unobserve(target);
      this.#intersectionObservedTargets.delete(target);
    }
    for (const target of next) {
      if (this.#intersectionObservedTargets.has(target)) continue;
      this.#intersectionObserver?.observe(target);
      this.#intersectionObservedTargets.add(target);
    }
  }

  #syncResizeObservedBody(body: HTMLElement): void {
    if (this.#resizeObservedBody === body) return;
    if (this.#resizeObservedBody) this.#resizeObserver?.unobserve(this.#resizeObservedBody);
    this.#resizeObserver?.observe(body);
    this.#resizeObservedBody = body;
  }

  #currentAnchorTargets(): ReadonlySet<Element> {
    const targets = new Set(this.#placedTargets.values());
    if (this.#composer && this.#draftAnchor) {
      const draftTarget = resolveAnchorElement(this.#document, this.#draftAnchor);
      if (draftTarget) targets.add(draftTarget);
    }
    return targets;
  }

  #currentResizeTargets(): ReadonlySet<Element> {
    const targets = new Set(this.#currentAnchorTargets());
    if (this.#composer) targets.add(this.#composer);
    return targets;
  }

  #pin(thread: ReviewDocumentOverlayThread): HTMLButtonElement {
    const known = this.#pins.get(thread.threadId);
    if (known) {
      known.setAttribute("aria-label", `Open ${thread.label ?? "review thread"}`);
      this.#setPinInteractivity(known);
      return known;
    }
    const pin = this.#document.createElement("button");
    pin.type = "button";
    pin.className = "crl-overlay__pin";
    pin.setAttribute("aria-label", `Open ${thread.label ?? "review thread"}`);
    pin.textContent = "●";
    this.#setPinInteractivity(pin);
    pin.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const attachment = this.#threadAttachments.get(thread.threadId);
      if (this.#interactionMode === "comment" && attachment) this.#onOpenThread(thread.threadId, attachment);
    });
    this.#root!.appendChild(pin);
    this.#pins.set(thread.threadId, pin);
    return pin;
  }

  #setPinInteractivity(pin: HTMLButtonElement): void {
    if (this.#interactionMode === "pointer") {
      if (this.#document.activeElement === pin) pin.blur();
      pin.tabIndex = -1;
      pin.setAttribute("aria-hidden", "true");
      return;
    }
    pin.tabIndex = 0;
    pin.removeAttribute("aria-hidden");
  }

  #removePin(threadId: string): void {
    this.#pins.get(threadId)?.remove();
    this.#pins.delete(threadId);
    this.#placedTargets.delete(threadId);
    this.#stickyTrackedThreadIds.delete(threadId);
  }

  #updateThreadAttachment(
    threadId: string,
    attachment: ReviewDocumentOverlayThreadAttachment | undefined,
    retryFailedNotification = false,
  ): void {
    const previous = this.#threadAttachments.get(threadId);
    const changed = !sameThreadAttachment(previous, attachment);
    if (!changed && !(retryFailedNotification && this.#failedThreadAttachmentNotifications.has(threadId))) return;
    if (changed) {
      if (attachment) this.#threadAttachments.set(threadId, attachment);
      else this.#threadAttachments.delete(threadId);
    }
    const notificationAttempt = {};
    this.#threadAttachmentNotificationsInFlight.set(threadId, notificationAttempt);
    this.#failedThreadAttachmentNotifications.delete(threadId);
    try {
      this.#onThreadAttachmentChange(threadId, attachment);
    } catch {
      if (this.#threadAttachmentNotificationsInFlight.get(threadId) === notificationAttempt) {
        this.#failedThreadAttachmentNotifications.add(threadId);
      }
    } finally {
      if (this.#threadAttachmentNotificationsInFlight.get(threadId) === notificationAttempt) {
        this.#threadAttachmentNotificationsInFlight.delete(threadId);
      }
    }
  }

  #reportUnavailable(thread: ReviewDocumentOverlayThread, reason: AnchorUnavailableReason): void {
    const key = unavailableKey(thread);
    if (this.#reportedUnavailable.has(key)) return;
    this.#reportedUnavailable.add(key);
    try {
      this.#onAnchorUnavailable(Object.freeze({
        threadId: thread.threadId,
        anchorGeneration: thread.anchorGeneration,
      }));
      this.#reportPlacementDiagnostic(Object.freeze({
        kind: "anchor_unavailable",
        reason,
        threadId: thread.threadId,
        anchorGeneration: thread.anchorGeneration,
      }));
    } catch (error) {
      this.#reportedUnavailable.delete(key);
      throw error;
    }
  }

  #scheduleUnavailableReport(thread: ReviewDocumentOverlayThread): void {
    const key = unavailableKey(thread);
    if (this.#reportedUnavailable.has(key) || this.#pendingUnavailableReports.has(key)) return;
    const timeout = this.#window.setTimeout(() => {
      this.#pendingUnavailableReports.delete(key);
      if (this.#state !== "mounted") return;
      const current = this.#threads.get(thread.threadId);
      if (!current || unavailableKey(current) !== key || current.anchor.locationAvailability !== "available") return;
      const target = resolveAnchorElement(this.#document, current.anchor);
      if (target && hasRenderedBox(target, this.#window)) {
        const point = elementLocalPointToViewport(target, current.anchor.element.offset, this.#window);
        if (point) this.#scheduleRefresh();
        else this.#reportPlacementBug(current);
        return;
      }
      try {
        this.#reportUnavailable(current, target ? "target_not_rendered" : "identity_unresolved");
      } catch {
        // The one-shot guard rolls back so a later refresh can retry delivery.
      }
    }, ANCHOR_UNAVAILABLE_STABILITY_MS);
    this.#pendingUnavailableReports.set(key, timeout);
  }

  #reportPlacementBug(thread: ReviewDocumentOverlayThread): void {
    const key = placementBugKey(thread);
    if (this.#reportedPlacementDiagnostics.has(key)) return;
    this.#reportedPlacementDiagnostics.add(key);
    this.#reportPlacementDiagnostic(Object.freeze({
      kind: "placement_bug",
      reason: "unsupported_coordinate_projection",
      threadId: thread.threadId,
      anchorGeneration: thread.anchorGeneration,
    }));
  }

  #clearPlacementBug(thread: ReviewDocumentOverlayThread): void {
    this.#reportedPlacementDiagnostics.delete(placementBugKey(thread));
  }

  #reportPlacementDiagnostic(diagnostic: ReviewDocumentOverlayPlacementDiagnostic): void {
    try {
      this.#onPlacementDiagnostic(diagnostic);
    } catch {
      if (diagnostic.kind === "placement_bug") {
        this.#reportedPlacementDiagnostics.delete(placementBugKey(diagnostic));
      }
    }
  }

  #cancelUnavailableReport(thread: ReviewDocumentOverlayThread): void {
    const key = unavailableKey(thread);
    const timeout = this.#pendingUnavailableReports.get(key);
    if (timeout === undefined) return;
    this.#window.clearTimeout(timeout);
    this.#pendingUnavailableReports.delete(key);
  }

  #reconcileOneShotState(next: ReadonlyMap<string, ReviewDocumentOverlayThread>): void {
    const availableKeys = new Set<string>();
    const unavailableKeys = new Set<string>();
    for (const thread of next.values()) {
      const destination = thread.anchor.locationAvailability === "available" ? availableKeys : unavailableKeys;
      destination.add(unavailableKey(thread));
    }
    for (const key of this.#reportedUnavailable) {
      if (!availableKeys.has(key)) this.#reportedUnavailable.delete(key);
    }
    for (const [key, timeout] of this.#pendingUnavailableReports) {
      if (availableKeys.has(key)) continue;
      this.#window.clearTimeout(timeout);
      this.#pendingUnavailableReports.delete(key);
    }
    for (const key of this.#replacementRequested) {
      if (!unavailableKeys.has(key)) this.#replacementRequested.delete(key);
    }
    for (const key of this.#reportedPlacementDiagnostics) {
      if (!availableKeys.has(key)) this.#reportedPlacementDiagnostics.delete(key);
    }
  }

  #renderRecoveryPanel(): void {
    this.#recoveryPanel?.remove();
    this.#recoveryPanel = undefined;
    if (this.#interactionMode !== "comment") return;
    const unavailable = [...this.#threads.values()].filter((thread) => thread.anchor.locationAvailability === "unavailable");
    if (unavailable.length === 0) return;
    const panel = this.#document.createElement("section");
    panel.className = "crl-overlay__recovery";
    panel.setAttribute("aria-label", "Unavailable review locations");
    const heading = this.#document.createElement("h2");
    heading.textContent = "Location needs attention";
    panel.appendChild(heading);
    for (const thread of unavailable) {
      const recoveryState = thread.anchor.recoveryState;
      if (recoveryState === "not_required") continue;
      const button = this.#document.createElement("button");
      button.type = "button";
      button.textContent = `Open ${thread.label ?? "review thread"}`;
      button.addEventListener("click", () => {
        this.#onOpenThread(thread.threadId, Object.freeze({
          locationAvailability: "unavailable",
          recoveryState,
        }));
      });
      panel.appendChild(button);
    }
    this.#root!.appendChild(panel);
    this.#recoveryPanel = panel;
  }

  #captureAnchor(target: Element, clientX: number, clientY: number): CurrentAnchor | undefined {
    const identity = target.getAttribute("data-collab-review-id") ?? undefined;
    const identityResult = readAnchorIdentifier(identity);
    if (!identityResult.ok) return undefined;
    const selector = `[data-collab-review-id="${escapeCssString(identityResult.value)}"]`;
    const selectorResult = readAnchorSelector(selector);
    if (!selectorResult.ok || this.#document.querySelectorAll(selectorResult.value).length !== 1) return undefined;
    const localPoint = viewportPointToElementLocal(target, { x: clientX, y: clientY }, this.#window);
    if (!localPoint) return undefined;
    const offsetX = readAnchorCoordinate(normalizeCoordinate(localPoint.x), ANCHOR_ELEMENT_OFFSET_MINIMUM);
    const offsetY = readAnchorCoordinate(normalizeCoordinate(localPoint.y), ANCHOR_ELEMENT_OFFSET_MINIMUM);
    const documentX = readAnchorCoordinate(clientX + this.#window.scrollX, 0);
    const documentY = readAnchorCoordinate(clientY + this.#window.scrollY, 0);
    const width = readAnchorCoordinate(documentWidth(this.#document, this.#window), 1);
    const height = readAnchorCoordinate(documentHeight(this.#document, this.#window), 1);
    if (!offsetX.ok || !offsetY.ok || !documentX.ok || !documentY.ok || !width.ok || !height.ok) return undefined;
    return {
      schemaVersion: CURRENT_ANCHOR_SCHEMA_VERSION,
      locationAvailability: "available",
      recoveryState: "not_required",
      context: structuredClone(this.#context),
      element: {
        selector: selectorResult.value,
        identity: identityResult.value,
        offset: { x: offsetX.value, y: offsetY.value },
      },
      document: { x: documentX.value, y: documentY.value, width: width.value, height: height.value },
    };
  }

  #openComposer(anchor: CurrentAnchor, focusReturn: Element): void {
    this.#closeComposer(false);
    const composer = this.#document.createElement("section");
    composer.className = "crl-overlay__composer";
    composer.setAttribute("role", "dialog");
    composer.setAttribute("aria-label", "Add review comment");
    const form = this.#document.createElement("form");
    const label = this.#document.createElement("label");
    label.className = "crl-overlay__label";
    label.textContent = "Comment";
    const textarea = this.#document.createElement("textarea");
    textarea.className = "crl-overlay__textarea";
    textarea.name = "comment";
    textarea.required = true;
    textarea.rows = 4;
    label.appendChild(textarea);
    const actions = this.#document.createElement("div");
    actions.className = "crl-overlay__actions";
    const cancel = this.#document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => this.#closeComposer());
    const submit = this.#document.createElement("button");
    submit.type = "submit";
    submit.textContent = "Submit comment";
    actions.append(cancel, submit);
    form.append(label, actions);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const body = textarea.value.trim();
      if (!body || !this.#draftAnchor) return;
      if (!this.#refreshComposerPlacement()) return;
      this.#onSubmit(Object.freeze({ body, anchor: structuredClone(this.#draftAnchor) }));
      this.#closeComposer();
    });
    textarea.addEventListener("keydown", (event) => {
      if (event.isComposing) return;
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        form.requestSubmit();
      }
    });
    composer.appendChild(form);
    this.#root!.appendChild(composer);
    this.#composer = composer;
    this.#draftAnchor = anchor;
    this.#composerFocusReturn = focusReturn;
    if (this.#refreshComposerPlacement()) {
      this.#syncIntersectionObservedTargets(this.#currentAnchorTargets());
      this.#syncResizeObservedTargets(this.#currentResizeTargets());
      textarea.focus();
      if (this.#hasRunningPlacementMotion()) this.#scheduleRefresh();
    }
  }

  #closeComposer(restoreFocus = true): void {
    const focusReturn = this.#composerFocusReturn;
    this.#composer?.remove();
    this.#composer = undefined;
    this.#draftAnchor = undefined;
    this.#composerFocusReturn = undefined;
    this.#syncIntersectionObservedTargets(this.#currentAnchorTargets());
    this.#syncResizeObservedTargets(this.#currentResizeTargets());
    if (restoreFocus && focusReturn?.isConnected && isFocusableElement(focusReturn)) {
      focusReturn.focus({ preventScroll: true });
    }
  }

  #syncRootHost(preferredTarget?: Element): void {
    const root = this.#root;
    const body = this.#document.body;
    if (!root || !body) return;
    this.#syncResizeObservedBody(body);
    const preferredDialog = preferredTarget?.closest("dialog:modal");
    const host = preferredDialog?.ownerDocument === this.#document
      ? preferredDialog
      : activeModalDialog(this.#document) ?? body;
    if (root.parentElement === host) {
      if (preferredTarget?.closest(":popover-open")) this.#promoteRootInTopLayer();
      return;
    }
    const wasOpen = root.matches(":popover-open");
    const shouldBeOpen = wasOpen || this.#state === "mounted";
    if (wasOpen) root.hidePopover();
    host.appendChild(root);
    if (shouldBeOpen) root.showPopover();
  }

  #promoteRootInTopLayer(): void {
    const root = this.#root;
    if (!root || !root.matches(":popover-open")) return;
    const focus = this.#document.activeElement;
    root.hidePopover();
    root.showPopover();
    if (focus && root.contains(focus) && isFocusableElement(focus)) focus.focus({ preventScroll: true });
  }

  #requireMounted(): void {
    if (this.#state !== "mounted") throw new ReviewDocumentOverlayError("invalid_state", "review overlay is not mounted");
  }
}

function requireAnchorContext(value: unknown): AnchorContext {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ReviewDocumentOverlayError("invalid_config", "review overlay Anchor Context is invalid");
  }
  const record = value as Record<string, unknown>;
  const context = {
    reviewId: requireOpaqueId(record.reviewId, "review"),
    prototypeId: requireOpaqueId(record.prototypeId, "prototype"),
    revisionId: requireOpaqueId(record.revisionId, "revision"),
    viewportId: requireOpaqueId(record.viewportId, "viewport"),
    variantId: requireOpaqueId(record.variantId, "variant"),
    route: requireOpaqueId(record.route, "route"),
    deviceId: requireIdentifier(record.deviceId, "device"),
    surfaceId: requireIdentifier(record.surfaceId, "surface"),
  };
  return Object.freeze(context);
}

function requireCurrentAnchorContext(value: unknown): AnchorContext {
  return requireAnchorContext(value);
}

function requireUnavailableAnchorContext(
  value: unknown,
  expected: AnchorContext,
  recoveryState: "legacy_replacement_required" | "orphaned_replacement_required",
): AnchorContext {
  if (recoveryState === "orphaned_replacement_required") {
    const context = requireAnchorContext(value);
    requireMatchingContext(context, expected);
    return context;
  }
  const record = requireRecord(value, "Anchor Context");
  const context = Object.freeze({
    reviewId: requireOpaqueId(record.reviewId, "review"),
    prototypeId: requireOpaqueId(record.prototypeId, "prototype"),
    revisionId: requireOpaqueId(record.revisionId, "revision"),
    viewportId: requireOpaqueId(record.viewportId, "viewport"),
    variantId: requireOpaqueId(record.variantId, "variant"),
    route: requireOpaqueId(record.route, "route"),
    deviceId: requireOpaqueId(record.deviceId, "device"),
    surfaceId: requireOpaqueId(record.surfaceId, "surface"),
  });
  for (const key of ["reviewId", "prototypeId", "revisionId", "viewportId", "variantId", "route"] as const) {
    if (context[key] !== expected[key]) {
      throw new ReviewDocumentOverlayError("invalid_config", `review overlay Anchor ${key} does not match its document context`);
    }
  }
  for (const key of ["deviceId", "surfaceId"] as const) {
    if (readAnchorIdentifier(context[key]).ok && context[key] !== expected[key]) {
      throw new ReviewDocumentOverlayError("invalid_config", `review overlay Anchor ${key} does not match its document context`);
    }
  }
  return context;
}

function requireThread(value: unknown, expectedContext: AnchorContext): ReviewDocumentOverlayThread {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ReviewDocumentOverlayError("invalid_config", "review overlay Thread is invalid");
  }
  const record = value as Record<string, unknown>;
  const threadId = requireOpaqueId(record.threadId, "Thread");
  if (!Number.isSafeInteger(record.anchorGeneration) || (record.anchorGeneration as number) < 1) {
    throw new ReviewDocumentOverlayError("invalid_config", "review overlay Anchor Generation is invalid");
  }
  const label = record.label === undefined ? undefined : requireLabel(record.label);
  if (record.canReplaceAnchor !== undefined && typeof record.canReplaceAnchor !== "boolean") {
    throw new ReviewDocumentOverlayError("invalid_config", "review overlay Thread replacement permission is invalid");
  }
  const anchor = requireThreadAnchor(record.anchor, expectedContext);
  return Object.freeze({
    threadId,
    anchorGeneration: record.anchorGeneration as number,
    anchor,
    ...(label ? { label } : {}),
    ...(record.canReplaceAnchor === true ? { canReplaceAnchor: true } : {}),
  });
}

function requireThreadAnchor(value: unknown, expectedContext: AnchorContext): ThreadAnchor {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ReviewDocumentOverlayError("invalid_config", "review overlay Anchor is invalid");
  }
  const record = value as Record<string, unknown>;
  if (record.locationAvailability === "unavailable") {
    if (record.schemaVersion === 1 && record.recoveryState === "legacy_replacement_required") {
      return Object.freeze({
        schemaVersion: 1,
        locationAvailability: "unavailable",
        recoveryState: "legacy_replacement_required",
      });
    }
    if (
      record.schemaVersion === CURRENT_ANCHOR_SCHEMA_VERSION
      && (record.recoveryState === "legacy_replacement_required" || record.recoveryState === "orphaned_replacement_required")
    ) {
      const context = requireUnavailableAnchorContext(record.context, expectedContext, record.recoveryState);
      return Object.freeze({
        schemaVersion: CURRENT_ANCHOR_SCHEMA_VERSION,
        locationAvailability: "unavailable",
        recoveryState: record.recoveryState,
        context,
      });
    }
    throw new ReviewDocumentOverlayError("invalid_config", "review overlay unavailable Anchor is invalid");
  }
  if (record.schemaVersion !== CURRENT_ANCHOR_SCHEMA_VERSION || record.locationAvailability !== "available" || record.recoveryState !== "not_required") {
    throw new ReviewDocumentOverlayError("invalid_config", "review overlay current Anchor is invalid");
  }
  const context = requireCurrentAnchorContext(record.context);
  requireMatchingContext(context, expectedContext);
  const element = requireRecord(record.element, "Anchor element");
  const offset = requireRecord(element.offset, "Anchor offset");
  const document = requireRecord(record.document, "Anchor document");
  const selector = readAnchorSelector(element.selector);
  const identity = readAnchorIdentifier(element.identity);
  const offsetX = readAnchorCoordinate(offset.x, ANCHOR_ELEMENT_OFFSET_MINIMUM);
  const offsetY = readAnchorCoordinate(offset.y, ANCHOR_ELEMENT_OFFSET_MINIMUM);
  const x = readAnchorCoordinate(document.x, 0);
  const y = readAnchorCoordinate(document.y, 0);
  const width = readAnchorCoordinate(document.width, 1);
  const height = readAnchorCoordinate(document.height, 1);
  if (!selector.ok || !identity.ok || !offsetX.ok || !offsetY.ok || !x.ok || !y.ok || !width.ok || !height.ok) {
    throw new ReviewDocumentOverlayError("invalid_config", "review overlay Anchor placement is invalid");
  }
  const anchor: CurrentAnchor = {
    schemaVersion: CURRENT_ANCHOR_SCHEMA_VERSION,
    locationAvailability: "available",
    recoveryState: "not_required",
    context,
    element: {
      selector: selector.value,
      identity: identity.value,
      offset: { x: offsetX.value, y: offsetY.value },
    },
    document: { x: x.value, y: y.value, width: width.value, height: height.value },
  };
  try {
    const semantic = readOptionalOwnDataField(record, "semantic", "Anchor");
    const text = readOptionalOwnDataField(record, "text", "Anchor");
    if (semantic.present) anchor.semantic = requireAnchorSemantic(semantic.value);
    if (text.present) anchor.text = requireAnchorTextEvidence(text.value);
  } catch (cause) {
    if (cause instanceof ReviewDocumentOverlayError) throw cause;
    throw new ReviewDocumentOverlayError("invalid_config", "review overlay Anchor evidence is invalid", { cause });
  }
  return anchor;
}

function requireAnchorSemantic(value: unknown): NonNullable<CurrentAnchor["semantic"]> {
  const record = requireOwnDataFields(value, [], ["role", "accessibleName", "testId"], "Anchor semantic evidence");
  const semantic: NonNullable<CurrentAnchor["semantic"]> = {};
  if (record.role !== undefined) semantic.role = requireAnchorMetadataValue(record.role, 256, "role");
  if (record.accessibleName !== undefined) {
    semantic.accessibleName = requireAnchorMetadataValue(record.accessibleName, 2_048, "accessible name");
  }
  if (record.testId !== undefined) semantic.testId = requireAnchorMetadataValue(record.testId, 256, "test id");
  return semantic;
}

function requireAnchorTextEvidence(value: unknown): NonNullable<CurrentAnchor["text"]> {
  const record = requireOwnDataFields(value, ["exact"], ["prefix", "suffix"], "Anchor text evidence");
  const text: NonNullable<CurrentAnchor["text"]> = {
    exact: requireAnchorTextValue(record.exact, 4_096, "exact text"),
  };
  if (record.prefix !== undefined) text.prefix = requireAnchorTextValue(record.prefix, 1_024, "text prefix");
  if (record.suffix !== undefined) text.suffix = requireAnchorTextValue(record.suffix, 1_024, "text suffix");
  return text;
}

function requireOwnDataFields(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): Record<string, unknown> {
  const record = requireRecord(value, label);
  const prototype = Object.getPrototypeOf(record);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new ReviewDocumentOverlayError("invalid_config", `review overlay ${label} is invalid`);
  }
  const allowed = new Set([...required, ...optional]);
  const fields = Object.create(null) as Record<string, unknown>;
  for (const key in record) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
    if (!allowed.has(key)) throw new ReviewDocumentOverlayError("invalid_config", `review overlay ${label} is invalid`);
    fields[key] = requireOwnDataField(record, key, label);
  }
  for (const key of required) fields[key] = requireOwnDataField(record, key, label);
  for (const key of optional) {
    if (Object.getOwnPropertyDescriptor(record, key) !== undefined) fields[key] = requireOwnDataField(record, key, label);
  }
  return fields;
}

function readOptionalOwnDataField(
  record: Record<string, unknown>,
  key: string,
  label: string,
): Readonly<{ present: false }> | Readonly<{ present: true; value: unknown }> {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (descriptor === undefined) {
    if (key in record) throw new ReviewDocumentOverlayError("invalid_config", `review overlay ${label} ${key} is invalid`);
    return { present: false };
  }
  return { present: true, value: requireOwnDataField(record, key, label) };
}

function requireOwnDataField(record: Record<string, unknown>, key: string, label: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
    throw new ReviewDocumentOverlayError("invalid_config", `review overlay ${label} ${key} is invalid`);
  }
  return descriptor.value;
}

function requireAnchorMetadataValue(value: unknown, maximumLength: number, label: string): string {
  const result = readAnchorMetadata(value, maximumLength);
  if (!result.ok) throw new ReviewDocumentOverlayError("invalid_config", `review overlay Anchor ${label} is invalid`);
  return result.value;
}

function requireAnchorTextValue(value: unknown, maximumLength: number, label: string): string {
  const result = readAnchorText(value, maximumLength);
  if (!result.ok) throw new ReviewDocumentOverlayError("invalid_config", `review overlay Anchor ${label} is invalid`);
  return result.value;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ReviewDocumentOverlayError("invalid_config", `review overlay ${label} is invalid`);
  }
  return value as Record<string, unknown>;
}

function requireMatchingContext(value: AnchorContext, expected: AnchorContext): void {
  for (const key of ["reviewId", "prototypeId", "revisionId", "viewportId", "variantId", "route", "deviceId", "surfaceId"] as const) {
    if (value[key] !== expected[key]) {
      throw new ReviewDocumentOverlayError("invalid_config", `review overlay Anchor ${key} does not match its document context`);
    }
  }
}

function requireOpaqueId(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 1_048_576) {
    throw new ReviewDocumentOverlayError("invalid_config", `review overlay ${label} id is invalid`);
  }
  return value;
}

function requireLabel(value: unknown): string {
  const result = readAnchorMetadata(value, 256);
  if (!result.ok || !result.value.trim()) throw new ReviewDocumentOverlayError("invalid_config", "review overlay Thread label is invalid");
  return result.value.trim();
}

function requireIdentifier(value: unknown, label: string): string {
  const result = readAnchorIdentifier(value);
  if (!result.ok) throw new ReviewDocumentOverlayError("invalid_config", `review overlay ${label} id is invalid`);
  return result.value;
}

function requireInteractionMode(value: unknown): ReviewShellInteractionMode {
  if (value !== "pointer" && value !== "comment") {
    throw new ReviewDocumentOverlayError("invalid_config", "review overlay interaction mode is invalid");
  }
  return value;
}

function isNewThreadContext(context: AnchorContext): boolean {
  for (const key of ["reviewId", "prototypeId", "revisionId", "viewportId", "variantId"] as const) {
    if (!readAnchorIdentifier(context[key]).ok) return false;
  }
  return readBridgeRoute(context.route).ok;
}

function isDocument(value: unknown): value is Document {
  return Boolean(value) && typeof value === "object" && (value as { nodeType?: unknown }).nodeType === 9;
}

function isElement(value: unknown): value is Element {
  return Boolean(value) && typeof value === "object" && (value as { nodeType?: unknown }).nodeType === 1;
}

function isKeyboardActivation(event: KeyboardEvent): boolean {
  return event.key === "Enter" || event.key === " " || event.key === "Spacebar";
}

function readCanonicalPrototypePress(event: Event, window: Window): CanonicalPrototypePress | undefined {
  const hasPointerEvents = typeof (window as unknown as { PointerEvent?: unknown }).PointerEvent === "function";
  if (hasPointerEvents && event.type.startsWith("pointer")) {
    const pointer = event as PointerEvent;
    if (!pointer.isPrimary || ((event.type === "pointerdown" || event.type === "pointerup") && pointer.button !== 0)) {
      return undefined;
    }
    return {
      phase: event.type === "pointerdown" ? "down" : event.type === "pointerup" ? "up" : "cancel",
      channel: "pointer",
      identifier: pointer.pointerId,
      point: event.type === "pointerup" ? { clientX: pointer.clientX, clientY: pointer.clientY } : undefined,
    };
  }
  if (hasPointerEvents) return undefined;
  if (event.type === "mousedown" || event.type === "mouseup") {
    const mouse = event as MouseEvent;
    if (mouse.button !== 0) return undefined;
    return {
      phase: event.type === "mousedown" ? "down" : "up",
      channel: "mouse",
      identifier: 0,
      point: event.type === "mouseup" ? { clientX: mouse.clientX, clientY: mouse.clientY } : undefined,
    };
  }
  if (!event.type.startsWith("touch")) return undefined;
  const touchEvent = event as TouchEvent;
  const touch = touchEvent.changedTouches.item(0);
  if (!touch || touchEvent.changedTouches.length !== 1) return undefined;
  if (event.type === "touchstart" && touchEvent.touches.length !== 1) return undefined;
  return {
    phase: event.type === "touchstart" ? "down" : event.type === "touchend" ? "up" : "cancel",
    channel: "touch",
    identifier: touch.identifier,
    point: event.type === "touchend" ? { clientX: touch.clientX, clientY: touch.clientY } : undefined,
  };
}

function activeModalDialog(document: Document): HTMLDialogElement | undefined {
  const focusedDialog = document.activeElement?.closest("dialog:modal");
  if (focusedDialog?.ownerDocument === document && focusedDialog.localName === "dialog") {
    return focusedDialog as HTMLDialogElement;
  }
  return [...document.querySelectorAll<HTMLDialogElement>("dialog:modal")].at(-1);
}

function isFocusableElement(value: Element): value is Element & { focus(options?: FocusOptions): void } {
  return typeof (value as { focus?: unknown }).focus === "function";
}

function findFocusableAncestor(start: Element, boundary: Element): Element | undefined {
  for (let element: Element | null = start; element && boundary.contains(element); element = element.parentElement) {
    const tabIndex = (element as { tabIndex?: unknown }).tabIndex;
    if (isFocusableElement(element) && typeof tabIndex === "number" && tabIndex >= 0) return element;
    if (element === boundary) break;
  }
  return undefined;
}

function animationMayAffectPlacement(animation: Animation): boolean {
  const effect = animation.effect as (AnimationEffect & { getKeyframes?: () => readonly Record<string, unknown>[] }) | null;
  if (!effect || typeof effect.getKeyframes !== "function") return true;
  try {
    const properties = new Set(effect.getKeyframes().flatMap((keyframe) => Object.keys(keyframe)));
    for (const metadata of KEYFRAME_METADATA) properties.delete(metadata);
    if (properties.size === 0) return true;
    return [...properties].some((property) => !COSMETIC_ANIMATION_PROPERTY.test(property));
  } catch {
    return true;
  }
}

function animationMayAffectSiblingLayout(animation: Animation): boolean {
  const effect = animation.effect as (AnimationEffect & { getKeyframes?: () => readonly Record<string, unknown>[] }) | null;
  if (!effect || typeof effect.getKeyframes !== "function") return true;
  try {
    const properties = new Set(effect.getKeyframes().flatMap((keyframe) => Object.keys(keyframe)));
    for (const metadata of KEYFRAME_METADATA) properties.delete(metadata);
    if (properties.size === 0) return true;
    return [...properties].some((property) => {
      return !COSMETIC_ANIMATION_PROPERTY.test(property) && !ELEMENT_LOCAL_ANIMATION_PROPERTY.test(property);
    });
  } catch {
    return true;
  }
}

function hasRunningPlacementAnimation(element: Element): boolean {
  return element.getAnimations().some((animation) => {
    return animation.playState === "running" && animationMayAffectPlacement(animation);
  });
}

function placementForTarget(
  target: Element,
  window: Window,
): ReviewDocumentOverlayPlacement | undefined {
  let tracksStickyThreshold = false;
  let stickyHorizontal = false;
  let stickyVertical = false;
  for (let element: Element | null = target; element; element = element.parentElement) {
    const style = window.getComputedStyle(element);
    if (style.position === "fixed" && !fixedContainingBlockAncestor(element, window)) {
      return {
        coordinateSpace: "viewport",
        tracksStickyThreshold: false,
        stickyHorizontal: true,
        stickyVertical: true,
      };
    }
    if (style.position !== "sticky") continue;
    tracksStickyThreshold = true;
    const active = activeStickyAxes(element, style, window);
    if (!active) return undefined;
    if (active.viewportRelative) {
      stickyHorizontal ||= active.horizontal;
      stickyVertical ||= active.vertical;
    }
  }
  return {
    coordinateSpace: stickyHorizontal || stickyVertical ? "viewport" : "document",
    tracksStickyThreshold,
    stickyHorizontal,
    stickyVertical,
  };
}

interface ReviewDocumentOverlayPlacement {
  readonly coordinateSpace: ReviewDocumentOverlayCoordinateSpace;
  readonly tracksStickyThreshold: boolean;
  readonly stickyHorizontal: boolean;
  readonly stickyVertical: boolean;
}

function placementNeedsWindowScrollRefresh(
  placement: ReviewDocumentOverlayPlacement,
  horizontalChanged: boolean,
  verticalChanged: boolean,
): boolean {
  return placement.coordinateSpace === "viewport" && (
    (horizontalChanged && !placement.stickyHorizontal)
    || (verticalChanged && !placement.stickyVertical)
  );
}

function fixedContainingBlockAncestor(element: Element, window: Window): Element | undefined {
  for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
    if (establishesFixedContainingBlock(window.getComputedStyle(ancestor))) return ancestor;
  }
  return undefined;
}

function establishesFixedContainingBlock(style: CSSStyleDeclaration): boolean {
  if (
    style.transform !== "none"
    || style.translate !== "none"
    || style.rotate !== "none"
    || style.scale !== "none"
    || style.perspective !== "none"
    || style.filter !== "none"
    || style.backdropFilter !== "none"
    || style.contentVisibility === "auto"
  ) return true;
  if (/(?:^|\s)(?:layout|paint|strict|content)(?:\s|$)/u.test(style.contain)) return true;
  return style.willChange.split(",").some((value) => {
    return /^(?:transform|translate|rotate|scale|perspective|filter|backdrop-filter|contain|content-visibility)$/u.test(value.trim());
  });
}

function activeStickyAxes(
  element: Element,
  style: CSSStyleDeclaration,
  window: Window,
): Readonly<{
  horizontal: boolean;
  vertical: boolean;
  viewportRelative: boolean;
}> | undefined {
  const rect = element.getBoundingClientRect();
  const scrollport = stickyScrollport(element, window);
  const parsedVisualTranslation = stickyVisualTranslation(element, style, scrollport.element, window);
  if (!parsedVisualTranslation) return undefined;
  const visualTranslation = parsedVisualTranslation;
  const leftEdge = rect.left - visualTranslation.x;
  const rightEdge = rect.right - visualTranslation.x;
  const topEdge = rect.top - visualTranslation.y;
  const bottomEdge = rect.bottom - visualTranslation.y;
  const epsilon = 1;
  const top = readPixelInset(style.top);
  const right = readPixelInset(style.right);
  const bottom = readPixelInset(style.bottom);
  const left = readPixelInset(style.left);
  return {
    horizontal: (
      (right !== undefined && Math.abs(rightEdge - (scrollport.right - right)) <= epsilon)
      || (left !== undefined && Math.abs(leftEdge - (scrollport.left + left)) <= epsilon)
    ),
    vertical: (
      (top !== undefined && Math.abs(topEdge - (scrollport.top + top)) <= epsilon)
      || (bottom !== undefined && Math.abs(bottomEdge - (scrollport.bottom - bottom)) <= epsilon)
    ),
    viewportRelative: scrollport.element === undefined,
  };
}

function stickyVisualTranslation(
  element: Element,
  style: CSSStyleDeclaration,
  exclusiveAncestor: Element | undefined,
  window: Window,
): Readonly<{ x: number; y: number }> | undefined {
  let x = 0;
  let y = 0;
  for (let current: Element | null = element; current && current !== exclusiveAncestor; current = current.parentElement) {
    const translation = elementVisualTranslation(
      current,
      current === element ? style : window.getComputedStyle(current),
      window,
    );
    if (!translation) return undefined;
    x += translation.x;
    y += translation.y;
  }
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : undefined;
}

function elementVisualTranslation(
  element: Element,
  style: CSSStyleDeclaration,
  window: Window,
): Readonly<{ x: number; y: number }> | undefined {
  try {
    const { DOMMatrix: DOMMatrixConstructor } = window as unknown as WindowWithGeometry;
    const dimensions = untransformedElementDimensions(element);
    let x = 0;
    let y = 0;
    if (style.translate !== "none") {
      const values = style.translate.trim().split(/\s+/u);
      if (values.length < 1 || values.length > 3) return undefined;
      const parsedX = readLengthPercentage(values[0]!, dimensions?.width);
      const parsedY = readLengthPercentage(values[1] ?? "0px", dimensions?.height);
      const parsedZ = readLengthPercentage(values[2] ?? "0px");
      if (parsedX === undefined || parsedY === undefined || parsedZ === undefined) return undefined;
      if (parsedZ !== 0) return undefined;
      x += parsedX;
      y += parsedY;
    }
    if (style.rotate !== "none" || style.scale !== "none") return undefined;
    if (style.perspective !== "none") return undefined;
    if (style.getPropertyValue("offset-path").trim() !== "" && style.getPropertyValue("offset-path").trim() !== "none") {
      return undefined;
    }
    const zoom = readZoom(style.zoom);
    if (zoom === undefined || zoom !== 1) return undefined;
    if (style.transform !== "none") {
      const matrix = new DOMMatrixConstructor(style.transform);
      const epsilon = 1e-10;
      if (
        Math.abs(matrix.m11 - 1) > epsilon
        || Math.abs(matrix.m12) > epsilon
        || Math.abs(matrix.m13) > epsilon
        || Math.abs(matrix.m14) > epsilon
        || Math.abs(matrix.m21) > epsilon
        || Math.abs(matrix.m22 - 1) > epsilon
        || Math.abs(matrix.m23) > epsilon
        || Math.abs(matrix.m24) > epsilon
        || Math.abs(matrix.m31) > epsilon
        || Math.abs(matrix.m32) > epsilon
        || Math.abs(matrix.m33 - 1) > epsilon
        || Math.abs(matrix.m34) > epsilon
        || Math.abs(matrix.m43) > epsilon
        || Math.abs(matrix.m44 - 1) > epsilon
      ) return undefined;
      x += matrix.m41;
      y += matrix.m42;
    }
    return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : undefined;
  } catch {
    return undefined;
  }
}

function stickyScrollport(
  element: Element,
  window: Window,
): Readonly<{ top: number; right: number; bottom: number; left: number; element?: Element }> {
  const document = element.ownerDocument;
  for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
    const style = window.getComputedStyle(ancestor);
    if (!/(?:auto|hidden|overlay|scroll)/u.test(`${style.overflowX} ${style.overflowY}`)) continue;
    if (
      ancestor === document.scrollingElement
      || ancestor === document.documentElement
      || (ancestor === document.body && bodyOverflowPropagatesToViewport(document, window))
    ) break;
    const rect = ancestor.getBoundingClientRect();
    return {
      top: rect.top + (ancestor as HTMLElement).clientTop,
      right: rect.left + (ancestor as HTMLElement).clientLeft + (ancestor as HTMLElement).clientWidth,
      bottom: rect.top + (ancestor as HTMLElement).clientTop + (ancestor as HTMLElement).clientHeight,
      left: rect.left + (ancestor as HTMLElement).clientLeft,
      element: ancestor,
    };
  }
  return { top: 0, right: window.innerWidth, bottom: window.innerHeight, left: 0 };
}

function isViewportScrollSource(element: Element, document: Document, window: Window): boolean {
  return element === document.scrollingElement
    || element === document.documentElement
    || (element === document.body && bodyOverflowPropagatesToViewport(document, window));
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

function pointSurvivesAncestorOverflowClipping(
  target: Element,
  x: number,
  y: number,
  window: Window,
): boolean {
  const viewportFixedBoundary = viewportFixedAncestor(target, window);
  if (viewportFixedBoundary === target) return true;
  const clips = /^(?:auto|clip|hidden|overlay|scroll)$/u;
  for (let ancestor = target.parentElement; ancestor; ancestor = ancestor.parentElement) {
    const style = window.getComputedStyle(ancestor);
    const clipsX = clips.test(style.overflowX);
    const clipsY = clips.test(style.overflowY);
    if (!clipsX && !clipsY) continue;
    const localPoint = viewportPointToElementUserSpace(ancestor, { x, y }, window);
    const bounds = overflowClippingBounds(ancestor, style, window);
    if (!localPoint || !bounds) return false;
    if (clipsX) {
      const horizontal = style.overflowX === "clip" ? bounds.clip : bounds.padding;
      if (localPoint.x < horizontal.left || localPoint.x > horizontal.right) return false;
    }
    if (clipsY) {
      const vertical = style.overflowY === "clip" ? bounds.clip : bounds.padding;
      if (localPoint.y < vertical.top || localPoint.y > vertical.bottom) return false;
    }
    if (ancestor === viewportFixedBoundary) break;
  }
  return true;
}

interface OverflowClippingRect {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

function overflowClippingBounds(
  element: Element,
  style: CSSStyleDeclaration,
  window: Window,
): Readonly<{ padding: OverflowClippingRect; clip: OverflowClippingRect }> | undefined {
  const svgViewport = svgViewportClippingRect(element);
  const dimensions = untransformedElementDimensions(element);
  if (!svgViewport && !dimensions) return undefined;
  const padding = svgViewport ?? {
    top: element.clientTop,
    right: element.clientLeft + element.clientWidth,
    bottom: element.clientTop + element.clientHeight,
    left: element.clientLeft,
  };
  const clipMargin = readOverflowClipMargin(style.getPropertyValue("overflow-clip-margin"));
  if (!clipMargin) return undefined;
  let origin: OverflowClippingRect;
  if (svgViewport) {
    origin = svgViewport;
  } else switch (clipMargin.box) {
    case "border-box":
      if (!dimensions) return undefined;
      origin = { top: 0, right: dimensions.width, bottom: dimensions.height, left: 0 };
      break;
    case "content-box": {
      const paddingTop = readLengthPercentage(style.paddingTop);
      const paddingRight = readLengthPercentage(style.paddingRight);
      const paddingBottom = readLengthPercentage(style.paddingBottom);
      const paddingLeft = readLengthPercentage(style.paddingLeft);
      if ([paddingTop, paddingRight, paddingBottom, paddingLeft].some((value) => value === undefined)) {
        return undefined;
      }
      origin = {
        top: padding.top + paddingTop!,
        right: padding.right - paddingRight!,
        bottom: padding.bottom - paddingBottom!,
        left: padding.left + paddingLeft!,
      };
      break;
    }
    default:
      origin = padding;
  }
  return {
    padding,
    clip: {
      top: origin.top - clipMargin.length,
      right: origin.right + clipMargin.length,
      bottom: origin.bottom + clipMargin.length,
      left: origin.left - clipMargin.length,
    },
  };
}

function svgViewportClippingRect(element: Element): OverflowClippingRect | undefined {
  if (element.namespaceURI !== "http://www.w3.org/2000/svg" || element.localName !== "svg") return undefined;
  try {
    const svg = element as SVGSVGElement;
    const width = svg.width?.baseVal?.value;
    const height = svg.height?.baseVal?.value;
    if (
      typeof width !== "number"
      || typeof height !== "number"
      || !Number.isFinite(width)
      || !Number.isFinite(height)
      || width <= 0
      || height <= 0
    ) {
      return undefined;
    }

    if (!svg.hasAttribute("viewBox")) {
      return { top: 0, right: width, bottom: height, left: 0 };
    }

    const viewBox = svg.viewBox?.baseVal;
    if (
      !viewBox
      || !Number.isFinite(viewBox.x)
      || !Number.isFinite(viewBox.y)
      || !Number.isFinite(viewBox.width)
      || !Number.isFinite(viewBox.height)
      || viewBox.width <= 0
      || viewBox.height <= 0
    ) {
      return undefined;
    }

    const aspectRatio = svg.preserveAspectRatio?.baseVal;
    if (!aspectRatio) return undefined;
    // SVGPreserveAspectRatio.SVG_PRESERVEASPECTRATIO_NONE is 1. With
    // non-uniform scaling, the viewport exposes exactly the declared viewBox.
    if (aspectRatio.align === 1) {
      return {
        top: viewBox.y,
        right: viewBox.x + viewBox.width,
        bottom: viewBox.y + viewBox.height,
        left: viewBox.x,
      };
    }

    const alignment = svgPreserveAspectRatioAlignment(aspectRatio.align);
    if (!alignment || (aspectRatio.meetOrSlice !== 1 && aspectRatio.meetOrSlice !== 2)) return undefined;
    const widthScale = width / viewBox.width;
    const heightScale = height / viewBox.height;
    const scale = aspectRatio.meetOrSlice === 2
      ? Math.max(widthScale, heightScale)
      : Math.min(widthScale, heightScale);
    if (!Number.isFinite(scale) || scale <= 0) return undefined;
    const visibleWidth = width / scale;
    const visibleHeight = height / scale;
    const left = viewBox.x - ((visibleWidth - viewBox.width) * alignment.x);
    const top = viewBox.y - ((visibleHeight - viewBox.height) * alignment.y);
    return {
      top,
      right: left + visibleWidth,
      bottom: top + visibleHeight,
      left,
    };
  } catch {
    return undefined;
  }
}

function svgPreserveAspectRatioAlignment(align: number): Readonly<{ x: number; y: number }> | undefined {
  // The SVGPreserveAspectRatio alignment constants run from xMinYMin (2) to
  // xMaxYMax (10), with X changing fastest inside each Y row.
  if (!Number.isInteger(align) || align < 2 || align > 10) return undefined;
  return {
    x: ((align - 2) % 3) / 2,
    y: Math.floor((align - 2) / 3) / 2,
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
    const parsed = readLengthPercentage(token);
    if (sawLength || parsed === undefined || parsed < 0) return undefined;
    length = parsed;
    sawLength = true;
  }
  return { box, length };
}

function viewportFixedAncestor(element: Element, window: Window): Element | undefined {
  for (let current: Element | null = element; current; current = current.parentElement) {
    if (window.getComputedStyle(current).position === "fixed" && !fixedContainingBlockAncestor(current, window)) {
      return current;
    }
  }
  return undefined;
}

function readPixelInset(value: string): number | undefined {
  if (value === "auto") return undefined;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function elementLocalPointToViewport(
  target: Element,
  point: Readonly<{ x: number; y: number }>,
  window: Window,
): Readonly<{ x: number; y: number }> | undefined {
  const userPoint = anchorLocalPointToElementUserSpace(target, point);
  const matrix = elementUserSpaceToViewportMatrix(target, window);
  return userPoint && matrix ? transformPoint(matrix, userPoint, window) : undefined;
}

function viewportPointToElementLocal(
  target: Element,
  point: Readonly<{ x: number; y: number }>,
  window: Window,
): Readonly<{ x: number; y: number }> | undefined {
  const userPoint = viewportPointToElementUserSpace(target, point, window);
  if (!userPoint) return undefined;
  const origin = anchorGeometryOrigin(target);
  return origin ? { x: userPoint.x - origin.x, y: userPoint.y - origin.y } : undefined;
}

function viewportPointToElementUserSpace(
  target: Element,
  point: Readonly<{ x: number; y: number }>,
  window: Window,
): Readonly<{ x: number; y: number }> | undefined {
  const matrix = elementUserSpaceToViewportMatrix(target, window);
  if (!matrix) return undefined;
  try {
    return transformPoint(matrix.inverse(), point, window);
  } catch {
    return undefined;
  }
}

function anchorLocalPointToElementUserSpace(
  target: Element,
  point: Readonly<{ x: number; y: number }>,
): Readonly<{ x: number; y: number }> | undefined {
  const origin = anchorGeometryOrigin(target);
  return origin ? { x: point.x + origin.x, y: point.y + origin.y } : undefined;
}

function anchorGeometryOrigin(target: Element): Readonly<{ x: number; y: number }> | undefined {
  if (target.namespaceURI !== "http://www.w3.org/2000/svg") return { x: 0, y: 0 };
  const svgTarget = target as Element & { getBBox?: () => DOMRect };
  if (typeof svgTarget.getBBox !== "function") return undefined;
  try {
    const box = svgTarget.getBBox();
    return Number.isFinite(box.x) && Number.isFinite(box.y) ? { x: box.x, y: box.y } : undefined;
  } catch {
    return undefined;
  }
}

function elementUserSpaceToViewportMatrix(target: Element, window: Window): DOMMatrix | undefined {
  try {
    const { DOMMatrix: DOMMatrixConstructor } = window as unknown as WindowWithGeometry;
    const svgTarget = target as Element & { getScreenCTM?: () => DOMMatrix | null };
    if (typeof svgTarget.getScreenCTM === "function") {
      const matrix = svgTarget.getScreenCTM();
      if (!matrix || ![matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f].every(Number.isFinite)) return undefined;
      return new DOMMatrixConstructor([matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f]);
    }
    if (target.getClientRects().length !== 1) return undefined;
    const rect = target.getBoundingClientRect();
    const dimensions = target as { offsetWidth?: unknown; offsetHeight?: unknown };
    const width = typeof dimensions.offsetWidth === "number" && dimensions.offsetWidth > 0
      ? dimensions.offsetWidth
      : rect.width;
    const height = typeof dimensions.offsetHeight === "number" && dimensions.offsetHeight > 0
      ? dimensions.offsetHeight
      : rect.height;
    if (![width, height].every(Number.isFinite)) return undefined;
    let localTransform = new DOMMatrixConstructor();
    for (let element: Element | null = target; element; element = element.parentElement) {
      const style = window.getComputedStyle(element);
      const transform = elementTransformMatrix(element, style, DOMMatrixConstructor);
      if (!transform) return undefined;
      localTransform = transform.multiply(localTransform);
      const parent = element.parentElement;
      if (!parent) continue;
      const parentStyle = window.getComputedStyle(parent);
      if (parentStyle.perspective !== "none") return undefined;
      if (!hasUsedPreserve3d(parentStyle)) {
        const flattenedTransform = projectElementPlaneTo2d(localTransform, DOMMatrixConstructor);
        if (!flattenedTransform) return undefined;
        localTransform = flattenedTransform;
      }
    }
    const projectedTransform = projectElementPlaneTo2d(localTransform, DOMMatrixConstructor);
    if (!projectedTransform) return undefined;
    const corners = [
      transformPoint(projectedTransform, { x: 0, y: 0 }, window),
      transformPoint(projectedTransform, { x: width, y: 0 }, window),
      transformPoint(projectedTransform, { x: 0, y: height }, window),
      transformPoint(projectedTransform, { x: width, y: height }, window),
    ];
    if (corners.some((corner) => !corner)) return undefined;
    const minX = Math.min(...corners.map((corner) => corner!.x));
    const minY = Math.min(...corners.map((corner) => corner!.y));
    return new DOMMatrixConstructor().translate(rect.left - minX, rect.top - minY).multiply(projectedTransform);
  } catch {
    return undefined;
  }
}

function hasUsedPreserve3d(style: CSSStyleDeclaration): boolean {
  if (style.transformStyle !== "preserve-3d") return false;
  if (
    ![style.overflowX, style.overflowY].every((value) => value === "visible" || value === "clip")
    || Number(style.opacity) < 1
    || style.filter !== "none"
    || style.clip !== "auto"
    || style.clipPath !== "none"
    || style.isolation === "isolate"
    || style.getPropertyValue("mask-image") !== "none"
    || !["", "none"].includes(style.getPropertyValue("mask-border-source"))
    || style.mixBlendMode !== "normal"
    || /(?:^|\s)(?:paint|strict|content)(?:\s|$)/u.test(style.contain)
    || style.contentVisibility === "hidden"
    || style.contentVisibility === "auto"
  ) return false;
  return true;
}

function elementTransformMatrix(
  element: Element,
  style: CSSStyleDeclaration,
  DOMMatrixConstructor: typeof DOMMatrix,
): DOMMatrix | undefined {
  const offsetPath = style.getPropertyValue("offset-path").trim();
  if (offsetPath !== "" && offsetPath !== "none") return undefined;
  let matrix = new DOMMatrixConstructor();
  if (style.translate !== "none") {
    const values = style.translate.trim().split(/\s+/u);
    if (values.length < 1 || values.length > 3) return undefined;
    const dimensions = untransformedElementDimensions(element);
    const x = readLengthPercentage(values[0]!, dimensions?.width);
    const y = readLengthPercentage(values[1] ?? "0px", dimensions?.height);
    const z = readLengthPercentage(values[2] ?? "0px");
    if (x === undefined || y === undefined || z === undefined) return undefined;
    matrix = matrix.translate(x, y, z);
  }
  if (style.rotate !== "none") {
    const values = style.rotate.trim().split(/\s+/u);
    let axis: readonly [number, number, number];
    let angleValue: string;
    if (values.length === 1) {
      axis = [0, 0, 1];
      angleValue = values[0]!;
    } else if (values.length === 2 && /^(?:x|y|z)$/u.test(values[0]!)) {
      axis = values[0] === "x" ? [1, 0, 0] : values[0] === "y" ? [0, 1, 0] : [0, 0, 1];
      angleValue = values[1]!;
    } else if (values.length === 4) {
      const parsedAxis = values.slice(0, 3).map(readCssNumber);
      if (parsedAxis.some((value) => value === undefined)) return undefined;
      axis = parsedAxis as [number, number, number];
      angleValue = values[3]!;
    } else {
      return undefined;
    }
    const angle = readAngleDegrees(angleValue);
    if (angle === undefined || axis.every((value) => value === 0)) return undefined;
    matrix = matrix.rotateAxisAngle(axis[0], axis[1], axis[2], angle);
  }
  if (style.scale !== "none") {
    const values = style.scale.trim().split(/\s+/u);
    if (values.length < 1 || values.length > 3) return undefined;
    const x = readScale(values[0]!);
    const y = readScale(values[1] ?? values[0]!);
    const z = readScale(values[2] ?? "1");
    if (x === undefined || y === undefined || z === undefined) return undefined;
    matrix = matrix.scale(x, y, z);
  }
  if (style.transform !== "none") matrix = matrix.multiply(new DOMMatrixConstructor(style.transform));
  const zoom = readZoom(style.zoom);
  if (zoom === undefined) return undefined;
  if (zoom !== 1) matrix = matrix.scale(zoom);
  return matrix;
}

function untransformedElementDimensions(element: Element): Readonly<{ width: number; height: number }> | undefined {
  const dimensions = element as { offsetWidth?: unknown; offsetHeight?: unknown };
  if (
    typeof dimensions.offsetWidth !== "number"
    || typeof dimensions.offsetHeight !== "number"
    || !Number.isFinite(dimensions.offsetWidth)
    || !Number.isFinite(dimensions.offsetHeight)
  ) return undefined;
  return { width: dimensions.offsetWidth, height: dimensions.offsetHeight };
}

function readLengthPercentage(value: string, percentageReference?: number): number | undefined {
  const match = /^(-?(?:\d+(?:\.\d+)?|\.\d+))(px|%)?$/u.exec(value);
  if (!match) return undefined;
  const number = Number(match[1]);
  if (!Number.isFinite(number)) return undefined;
  if (match[2] === "%") {
    return percentageReference === undefined ? undefined : (number / 100) * percentageReference;
  }
  return match[2] === "px" || number === 0 ? number : undefined;
}

function readCssNumber(value: string): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function readScale(value: string): number | undefined {
  if (value.endsWith("%")) {
    const percentage = Number(value.slice(0, -1));
    return Number.isFinite(percentage) ? percentage / 100 : undefined;
  }
  return readCssNumber(value);
}

function readZoom(value: string): number | undefined {
  if (value === "" || value === "normal" || value === "reset") return 1;
  const zoom = readScale(value);
  if (zoom === 0) return 1;
  return zoom !== undefined && zoom > 0 ? zoom : undefined;
}

function readAngleDegrees(value: string): number | undefined {
  const match = /^(-?(?:\d+(?:\.\d+)?|\.\d+))(deg|grad|rad|turn)?$/u.exec(value);
  if (!match) return undefined;
  const number = Number(match[1]);
  if (!Number.isFinite(number)) return undefined;
  switch (match[2]) {
    case "grad": return number * 0.9;
    case "rad": return number * (180 / Math.PI);
    case "turn": return number * 360;
    case "deg": return number;
    default: return number === 0 ? 0 : undefined;
  }
}

function projectElementPlaneTo2d(
  matrix: DOMMatrix,
  DOMMatrixConstructor: typeof DOMMatrix,
): DOMMatrix | undefined {
  if (matrix.is2D) return matrix;
  const values = [matrix.m11, matrix.m12, matrix.m21, matrix.m22, matrix.m41, matrix.m42, matrix.m14, matrix.m24, matrix.m44];
  if (!values.every(Number.isFinite)) return undefined;
  const epsilon = 1e-10;
  if (Math.abs(matrix.m14) > epsilon || Math.abs(matrix.m24) > epsilon || Math.abs(matrix.m44) <= epsilon) {
    return undefined;
  }
  return new DOMMatrixConstructor([
    matrix.m11 / matrix.m44,
    matrix.m12 / matrix.m44,
    matrix.m21 / matrix.m44,
    matrix.m22 / matrix.m44,
    matrix.m41 / matrix.m44,
    matrix.m42 / matrix.m44,
  ]);
}

function transformPoint(
  matrix: DOMMatrixReadOnly,
  point: Readonly<{ x: number; y: number }>,
  window: Window,
): Readonly<{ x: number; y: number }> | undefined {
  const { DOMPoint: DOMPointConstructor } = window as unknown as WindowWithGeometry;
  const transformed = new DOMPointConstructor(point.x, point.y).matrixTransform(matrix);
  const divisor = transformed.w === 0 ? 1 : transformed.w;
  const x = transformed.x / divisor;
  const y = transformed.y / divisor;
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : undefined;
}

function normalizeCoordinate(value: number): number {
  return Math.abs(value) < 1e-7 ? 0 : value;
}

function escapeCssString(value: string): string {
  let escaped = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint <= 0x1f || codePoint === 0x7f) {
      escaped += `\\${codePoint.toString(16)} `;
    } else if (character === "\\" || character === '"') {
      escaped += `\\${character}`;
    } else {
      escaped += character;
    }
  }
  return escaped;
}

function documentWidth(document: Document, window: Window): number {
  return Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth ?? 0, window.innerWidth);
}

function documentHeight(document: Document, window: Window): number {
  return Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0, window.innerHeight);
}

function positionComposer(
  composer: HTMLElement,
  clientX: number,
  clientY: number,
  coordinateSpace: ReviewDocumentOverlayCoordinateSpace,
  window: Window,
): void {
  const gap = 12;
  const edge = 8;
  composer.dataset.coordinateSpace = coordinateSpace;
  composer.style.position = coordinateSpace === "document" ? "absolute" : "fixed";
  const rect = composer.getBoundingClientRect();
  if (coordinateSpace === "document") {
    composer.dataset.rawDocumentX = String(clientX + gap + window.scrollX);
    composer.dataset.rawDocumentY = String(clientY + gap + window.scrollY);
    composer.dataset.anchorDocumentX = String(clientX + window.scrollX);
    composer.dataset.anchorDocumentY = String(clientY + window.scrollY);
    composer.dataset.width = String(rect.width);
    composer.dataset.height = String(rect.height);
    refreshDocumentComposerEdgeClamp(composer, window);
    return;
  }
  delete composer.dataset.rawDocumentX;
  delete composer.dataset.rawDocumentY;
  delete composer.dataset.anchorDocumentX;
  delete composer.dataset.anchorDocumentY;
  delete composer.dataset.width;
  delete composer.dataset.height;
  const left = clamp(clientX + gap, edge, window.innerWidth - rect.width - edge);
  const top = clamp(clientY + gap, edge, window.innerHeight - rect.height - edge);
  composer.style.left = `${left}px`;
  composer.style.top = `${top}px`;
}

function refreshDocumentComposerEdgeClamp(composer: HTMLElement, window: Window): void {
  const edge = 8;
  const rawDocumentX = Number(composer.dataset.rawDocumentX);
  const rawDocumentY = Number(composer.dataset.rawDocumentY);
  const anchorDocumentX = Number(composer.dataset.anchorDocumentX);
  const anchorDocumentY = Number(composer.dataset.anchorDocumentY);
  const width = Number(composer.dataset.width);
  const height = Number(composer.dataset.height);
  if (![rawDocumentX, rawDocumentY, anchorDocumentX, anchorDocumentY, width, height].every(Number.isFinite)) {
    return;
  }
  const anchorX = anchorDocumentX - window.scrollX;
  const anchorY = anchorDocumentY - window.scrollY;
  const rawX = rawDocumentX - window.scrollX;
  const rawY = rawDocumentY - window.scrollY;
  const left = anchorX >= 0 && anchorX <= window.innerWidth
    ? clamp(rawX, edge, window.innerWidth - width - edge)
    : rawX;
  const top = anchorY >= 0 && anchorY <= window.innerHeight
    ? clamp(rawY, edge, window.innerHeight - height - edge)
    : rawY;
  composer.style.left = `${left + window.scrollX}px`;
  composer.style.top = `${top + window.scrollY}px`;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(value, maximum));
}

function sameThreadAttachment(
  left: ReviewDocumentOverlayThreadAttachment | undefined,
  right: ReviewDocumentOverlayThreadAttachment | undefined,
): boolean {
  if (!left || !right) return left === right;
  if (left.locationAvailability !== right.locationAvailability) return false;
  if (left.locationAvailability === "unavailable" || right.locationAvailability === "unavailable") {
    return left.locationAvailability === "unavailable"
      && right.locationAvailability === "unavailable"
      && left.recoveryState === right.recoveryState;
  }
  return left.coordinateSpace === right.coordinateSpace && left.x === right.x && left.y === right.y;
}

function placementBugKey(thread: Pick<ReviewDocumentOverlayThread, "threadId" | "anchorGeneration">): string {
  return `${thread.threadId}:${thread.anchorGeneration}`;
}

function resolveAnchorElement(document: Document, anchor: CurrentAnchor): Element | undefined {
  try {
    const matches = document.querySelectorAll(anchor.element.selector);
    if (matches.length !== 1) return undefined;
    const [target] = matches;
    if (target?.getAttribute("data-collab-review-id") !== anchor.element.identity) return undefined;
    const identitySelector = `[data-collab-review-id="${escapeCssString(anchor.element.identity)}"]`;
    const identityMatches = document.querySelectorAll(identitySelector);
    if (identityMatches.length !== 1 || identityMatches[0] !== target) return undefined;
    return target;
  } catch {
    return undefined;
  }
}

function hasRenderedBox(target: Element, window: Window): boolean {
  if (target.getClientRects().length === 0) return false;
  const visibility = window.getComputedStyle(target).visibility;
  return visibility !== "hidden" && visibility !== "collapse";
}

function renderedAnchorAtPoint(
  document: Document,
  window: Window,
  point: Readonly<{ clientX: number; clientY: number }>,
): Element | undefined {
  const target = document.elementFromPoint(point.clientX, point.clientY);
  const anchorTarget = target?.closest("[data-collab-review-id]");
  return anchorTarget?.ownerDocument === document && hasRenderedBox(anchorTarget, window)
    ? anchorTarget
    : undefined;
}

function unavailableKey(thread: ReviewDocumentOverlayThread): string {
  return JSON.stringify([thread.threadId, thread.anchorGeneration]);
}

function observeLayoutShifts(window: Window, ownedRoot: Element, refresh: () => void): PerformanceObserver | undefined {
  const PerformanceObserverConstructor = (window as unknown as WindowWithObservers).PerformanceObserver;
  if (typeof PerformanceObserverConstructor !== "function") return undefined;
  try {
    const observer = new PerformanceObserverConstructor((list) => {
      const externalShift = list.getEntries().some((entry) => {
        if (entry.entryType !== "layout-shift") return false;
        const sources = (entry as PerformanceEntry & { sources?: readonly { node?: Node | null }[] }).sources;
        if (!sources || sources.length === 0) return false;
        return sources.some(({ node }) => node && !ownedRoot.contains(node));
      });
      if (externalShift) refresh();
    });
    observer.observe({ type: "layout-shift" });
    return observer;
  } catch {
    return undefined;
  }
}

interface WindowWithObservers {
  readonly MutationObserver: typeof MutationObserver;
  readonly ResizeObserver: typeof ResizeObserver;
  readonly IntersectionObserver: typeof IntersectionObserver;
  readonly PerformanceObserver?: typeof PerformanceObserver;
}

interface WindowWithGeometry {
  readonly DOMMatrix: typeof DOMMatrix;
  readonly DOMPoint: typeof DOMPoint;
}
