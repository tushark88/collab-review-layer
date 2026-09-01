import {
  CURRENT_ANCHOR_SCHEMA_VERSION,
  type AnchorContext,
  type CurrentAnchor,
  type ThreadAnchor,
} from "./domain.ts";
import {
  readAnchorCoordinate,
  readAnchorIdentifier,
  readAnchorMetadata,
  readAnchorSelector,
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

export interface ReviewDocumentOverlayConfig {
  readonly document: Document;
  readonly context: AnchorContext;
  readonly interactionMode?: ReviewShellInteractionMode;
  readonly onSubmit: (submission: ReviewDocumentOverlaySubmission) => void;
  readonly onReplaceAnchor?: (request: ReviewDocumentOverlayReplacementRequest) => void;
  readonly onOpenThread?: (threadId: string) => void;
  readonly onAnchorUnavailable?: (report: ReviewDocumentOverlayUnavailableReport) => void;
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

export class ReviewDocumentOverlay {
  readonly #document: Document;
  readonly #window: Window;
  readonly #context: AnchorContext;
  readonly #newThreadAnchoringAvailable: boolean;
  readonly #onSubmit: (submission: ReviewDocumentOverlaySubmission) => void;
  readonly #onReplaceAnchor?: (request: ReviewDocumentOverlayReplacementRequest) => void;
  readonly #onOpenThread: (threadId: string) => void;
  readonly #onAnchorUnavailable: (report: ReviewDocumentOverlayUnavailableReport) => void;
  readonly #threads = new Map<string, ReviewDocumentOverlayThread>();
  readonly #pins = new Map<string, HTMLButtonElement>();
  readonly #reportedUnavailable = new Set<string>();
  readonly #replacementRequested = new Set<string>();
  readonly #resizeObservedTargets = new Set<Element>();
  #interactionMode: ReviewShellInteractionMode;
  #state: ReviewDocumentOverlayState = "idle";
  #root?: HTMLElement;
  #composer?: HTMLElement;
  #recoveryPanel?: HTMLElement;
  #replacementArmedThreadId?: string;
  #draftAnchor?: CurrentAnchor;
  #composerClientPoint?: Readonly<{ x: number; y: number }>;
  #composerFocusReturn?: Element;
  #mutationObserver?: MutationObserver;
  #resizeObserver?: ResizeObserver;
  #refreshFrame?: number;

  constructor(config: ReviewDocumentOverlayConfig) {
    if (!isDocument(config?.document) || !config.document.defaultView) {
      throw new ReviewDocumentOverlayError("invalid_config", "review overlay document is invalid");
    }
    if (typeof config.onSubmit !== "function") {
      throw new ReviewDocumentOverlayError("invalid_config", "review overlay submit handler is required");
    }
    this.#document = config.document;
    this.#window = config.document.defaultView;
    this.#context = requireAnchorContext(config.context);
    this.#newThreadAnchoringAvailable = isNewThreadContext(this.#context);
    this.#interactionMode = requireInteractionMode(config.interactionMode ?? "pointer");
    this.#onSubmit = config.onSubmit;
    this.#onReplaceAnchor = config.onReplaceAnchor;
    this.#onOpenThread = config.onOpenThread ?? (() => undefined);
    this.#onAnchorUnavailable = config.onAnchorUnavailable ?? (() => undefined);
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
    root.dataset.collabReviewLayer = "overlay";
    root.dataset.interactionMode = this.#interactionMode;
    this.#document.body.appendChild(root);
    if (this.#window.getComputedStyle(root).getPropertyValue(STYLE_SENTINEL).trim() !== "1") {
      root.remove();
      throw new ReviewDocumentOverlayError("missing_styles", "review overlay stylesheet is not loaded in this document");
    }
    let mutationObserver: MutationObserver | undefined;
    let resizeObserver: ResizeObserver | undefined;
    try {
      const MutationObserverConstructor = (this.#window as unknown as WindowWithObservers).MutationObserver;
      const ResizeObserverConstructor = (this.#window as unknown as WindowWithObservers).ResizeObserver;
      mutationObserver = new MutationObserverConstructor(this.#handleDocumentMutations);
      mutationObserver.observe(this.#document.body, { attributes: true, childList: true, subtree: true });
      resizeObserver = new ResizeObserverConstructor(this.#scheduleRefresh);
      resizeObserver.observe(this.#document.documentElement);
      resizeObserver.observe(this.#document.body);
      this.#document.addEventListener("click", this.#handleDocumentClick, true);
      this.#document.addEventListener("keydown", this.#handleDocumentKeydown, true);
      this.#window.addEventListener("scroll", this.#scheduleRefresh, true);
      this.#window.addEventListener("resize", this.#scheduleRefresh);
    } catch (cause) {
      this.#document.removeEventListener("click", this.#handleDocumentClick, true);
      this.#document.removeEventListener("keydown", this.#handleDocumentKeydown, true);
      this.#window.removeEventListener("scroll", this.#scheduleRefresh, true);
      this.#window.removeEventListener("resize", this.#scheduleRefresh);
      mutationObserver?.disconnect();
      resizeObserver?.disconnect();
      root.remove();
      throw new ReviewDocumentOverlayError("environment_failure", "review overlay browser observers could not be attached", { cause });
    }
    this.#root = root;
    this.#mutationObserver = mutationObserver;
    this.#resizeObserver = resizeObserver;
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
    for (const [threadId, pin] of this.#pins) {
      if (!next.has(threadId)) {
        pin.remove();
        this.#pins.delete(threadId);
      }
    }
    this.#refreshPlacements();
    this.#renderRecoveryPanel();
    return this.snapshot();
  }

  refresh(): ReviewDocumentOverlaySnapshot {
    this.#requireMounted();
    this.#refreshPlacements();
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
    this.#document.removeEventListener("click", this.#handleDocumentClick, true);
    this.#document.removeEventListener("keydown", this.#handleDocumentKeydown, true);
    this.#window.removeEventListener("scroll", this.#scheduleRefresh, true);
    this.#window.removeEventListener("resize", this.#scheduleRefresh);
    this.#mutationObserver?.disconnect();
    this.#resizeObserver?.disconnect();
    if (this.#refreshFrame !== undefined) this.#window.cancelAnimationFrame(this.#refreshFrame);
    this.#mutationObserver = undefined;
    this.#resizeObserver = undefined;
    this.#refreshFrame = undefined;
    this.#resizeObservedTargets.clear();
    this.#closeComposer(false);
    this.#recoveryPanel?.remove();
    this.#recoveryPanel = undefined;
    this.#replacementArmedThreadId = undefined;
    this.#root?.remove();
    this.#root = undefined;
    this.#threads.clear();
    this.#pins.clear();
    this.#reportedUnavailable.clear();
    this.#replacementRequested.clear();
    this.#state = "destroyed";
  }

  readonly #handleDocumentClick = (event: MouseEvent): void => {
    if (this.#state !== "mounted" || this.#interactionMode !== "comment") return;
    const target = event.target;
    if (!isElement(target) || target.ownerDocument !== this.#document || this.#root?.contains(target)) return;
    const anchorTarget = target.closest("[data-collab-review-id]");
    if (!anchorTarget || anchorTarget.ownerDocument !== this.#document) return;
    const targetRect = anchorTarget.getBoundingClientRect();
    const clientX = event.detail === 0 ? targetRect.left + (targetRect.width / 2) : event.clientX;
    const clientY = event.detail === 0 ? targetRect.top + (targetRect.height / 2) : event.clientY;
    const anchor = this.#captureAnchor(anchorTarget, clientX, clientY);
    if (!anchor) return;
    if (this.#replacementArmedThreadId) {
      event.preventDefault();
      event.stopImmediatePropagation();
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
    event.preventDefault();
    event.stopImmediatePropagation();
    this.#openComposer(anchor, clientX, clientY, anchorTarget);
  };

  readonly #handleDocumentKeydown = (event: KeyboardEvent): void => {
    if (event.key !== "Escape" || (!this.#composer && !this.#replacementArmedThreadId)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    this.#closeComposer();
    this.#replacementArmedThreadId = undefined;
    this.#renderRecoveryPanel();
  };

  readonly #scheduleRefresh = (): void => {
    if (this.#state !== "mounted" || this.#refreshFrame !== undefined) return;
    this.#refreshFrame = this.#window.requestAnimationFrame(() => {
      this.#refreshFrame = undefined;
      this.#refreshPlacements();
    });
  };

  readonly #handleDocumentMutations = (mutations: readonly MutationRecord[]): void => {
    if (mutations.some((mutation) => !this.#root?.contains(mutation.target))) this.#scheduleRefresh();
  };

  #refreshPlacements(): void {
    const resizeTargets = new Set<Element>();
    for (const thread of this.#threads.values()) {
      if (thread.anchor.locationAvailability !== "available") {
        this.#removePin(thread.threadId);
        continue;
      }
      const target = resolveAnchorElement(this.#document, thread.anchor);
      if (!target || !hasRenderedBox(target, this.#window)) {
        this.#removePin(thread.threadId);
        this.#reportUnavailable(thread);
        continue;
      }
      this.#reportedUnavailable.delete(unavailableKey(thread));
      resizeTargets.add(target);
      const rect = target.getBoundingClientRect();
      const x = rect.left + thread.anchor.element.offset.x;
      const y = rect.top + thread.anchor.element.offset.y;
      const pin = this.#pin(thread);
      pin.hidden = x < 0 || y < 0 || x > this.#window.innerWidth || y > this.#window.innerHeight;
      const halfWidth = pin.offsetWidth / 2;
      const halfHeight = pin.offsetHeight / 2;
      pin.style.left = `${clamp(x, halfWidth, this.#window.innerWidth - halfWidth)}px`;
      pin.style.top = `${clamp(y, halfHeight, this.#window.innerHeight - halfHeight)}px`;
    }
    this.#syncResizeObservedTargets(resizeTargets);
    if (this.#composer && this.#composerClientPoint) {
      positionComposer(this.#composer, this.#composerClientPoint.x, this.#composerClientPoint.y, this.#window);
    }
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
      if (this.#interactionMode === "comment") this.#onOpenThread(thread.threadId);
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
  }

  #reportUnavailable(thread: ReviewDocumentOverlayThread): void {
    const key = unavailableKey(thread);
    if (this.#reportedUnavailable.has(key)) return;
    this.#reportedUnavailable.add(key);
    try {
      this.#onAnchorUnavailable(Object.freeze({
        threadId: thread.threadId,
        anchorGeneration: thread.anchorGeneration,
      }));
    } catch (error) {
      this.#reportedUnavailable.delete(key);
      throw error;
    }
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
    for (const key of this.#replacementRequested) {
      if (!unavailableKeys.has(key)) this.#replacementRequested.delete(key);
    }
  }

  #renderRecoveryPanel(): void {
    this.#recoveryPanel?.remove();
    this.#recoveryPanel = undefined;
    if (this.#interactionMode !== "comment" || !this.#onReplaceAnchor) return;
    const recoverable = [...this.#threads.values()].filter((thread) => {
      return thread.anchor.locationAvailability === "unavailable"
        && thread.canReplaceAnchor === true
        && !this.#replacementRequested.has(unavailableKey(thread));
    });
    if (recoverable.length === 0) return;
    const panel = this.#document.createElement("section");
    panel.className = "crl-overlay__recovery";
    panel.setAttribute("aria-label", "Unavailable review locations");
    const heading = this.#document.createElement("h2");
    heading.textContent = "Location unavailable";
    panel.appendChild(heading);
    for (const thread of recoverable) {
      const button = this.#document.createElement("button");
      button.type = "button";
      button.textContent = this.#replacementArmedThreadId === thread.threadId
        ? `Choose a new location for ${thread.label ?? "review thread"}`
        : `Re-place ${thread.label ?? "review thread"}`;
      button.addEventListener("click", () => {
        this.#replacementArmedThreadId = thread.threadId;
        this.#closeComposer();
        this.#renderRecoveryPanel();
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
    const rect = target.getBoundingClientRect();
    const offsetX = readAnchorCoordinate(clientX - rect.left, 0);
    const offsetY = readAnchorCoordinate(clientY - rect.top, 0);
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

  #openComposer(anchor: CurrentAnchor, clientX: number, clientY: number, focusReturn: Element): void {
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
      this.#onSubmit(Object.freeze({ body, anchor: structuredClone(this.#draftAnchor) }));
      this.#closeComposer();
    });
    textarea.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        form.requestSubmit();
      }
    });
    composer.appendChild(form);
    this.#root!.appendChild(composer);
    this.#composer = composer;
    this.#draftAnchor = anchor;
    this.#composerClientPoint = Object.freeze({ x: clientX, y: clientY });
    this.#composerFocusReturn = focusReturn;
    positionComposer(composer, clientX, clientY, this.#window);
    textarea.focus();
  }

  #closeComposer(restoreFocus = true): void {
    const focusReturn = this.#composerFocusReturn;
    this.#composer?.remove();
    this.#composer = undefined;
    this.#draftAnchor = undefined;
    this.#composerClientPoint = undefined;
    this.#composerFocusReturn = undefined;
    if (restoreFocus && focusReturn?.isConnected && isFocusableElement(focusReturn)) {
      focusReturn.focus({ preventScroll: true });
    }
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
  const offsetX = readAnchorCoordinate(offset.x, 0);
  const offsetY = readAnchorCoordinate(offset.y, 0);
  const x = readAnchorCoordinate(document.x, 0);
  const y = readAnchorCoordinate(document.y, 0);
  const width = readAnchorCoordinate(document.width, 1);
  const height = readAnchorCoordinate(document.height, 1);
  if (!selector.ok || !identity.ok || !offsetX.ok || !offsetY.ok || !x.ok || !y.ok || !width.ok || !height.ok) {
    throw new ReviewDocumentOverlayError("invalid_config", "review overlay Anchor placement is invalid");
  }
  return structuredClone(value) as CurrentAnchor;
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

function isFocusableElement(value: Element): value is Element & { focus(options?: FocusOptions): void } {
  return typeof (value as { focus?: unknown }).focus === "function";
}

function escapeCssString(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function documentWidth(document: Document, window: Window): number {
  return Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth ?? 0, window.innerWidth);
}

function documentHeight(document: Document, window: Window): number {
  return Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0, window.innerHeight);
}

function positionComposer(composer: HTMLElement, clientX: number, clientY: number, window: Window): void {
  const gap = 12;
  const edge = 8;
  const rect = composer.getBoundingClientRect();
  const left = Math.max(edge, Math.min(clientX + gap, window.innerWidth - rect.width - edge));
  const top = Math.max(edge, Math.min(clientY + gap, window.innerHeight - rect.height - edge));
  composer.style.left = `${left}px`;
  composer.style.top = `${top}px`;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(value, maximum));
}

function resolveAnchorElement(document: Document, anchor: CurrentAnchor): Element | undefined {
  try {
    const matches = document.querySelectorAll(anchor.element.selector);
    if (matches.length !== 1) return undefined;
    const [target] = matches;
    if (target?.getAttribute("data-collab-review-id") !== anchor.element.identity) return undefined;
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

function unavailableKey(thread: ReviewDocumentOverlayThread): string {
  return JSON.stringify([thread.threadId, thread.anchorGeneration]);
}

interface WindowWithObservers {
  readonly MutationObserver: typeof MutationObserver;
  readonly ResizeObserver: typeof ResizeObserver;
}
