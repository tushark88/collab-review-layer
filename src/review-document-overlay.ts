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

export type ReviewDocumentOverlayErrorCode = "invalid_config" | "invalid_state" | "missing_styles";

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
  readonly #onSubmit: (submission: ReviewDocumentOverlaySubmission) => void;
  readonly #onReplaceAnchor?: (request: ReviewDocumentOverlayReplacementRequest) => void;
  readonly #onOpenThread: (threadId: string) => void;
  readonly #onAnchorUnavailable: (report: ReviewDocumentOverlayUnavailableReport) => void;
  readonly #threads = new Map<string, ReviewDocumentOverlayThread>();
  readonly #pins = new Map<string, HTMLButtonElement>();
  readonly #reportedUnavailable = new Set<string>();
  readonly #replacementRequested = new Set<string>();
  #interactionMode: ReviewShellInteractionMode;
  #state: ReviewDocumentOverlayState = "idle";
  #root?: HTMLElement;
  #composer?: HTMLElement;
  #recoveryPanel?: HTMLElement;
  #replacementArmedThreadId?: string;
  #draftAnchor?: CurrentAnchor;
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
    this.#root = root;
    this.#document.addEventListener("click", this.#handleDocumentClick, true);
    this.#document.addEventListener("keydown", this.#handleDocumentKeydown, true);
    this.#window.addEventListener("scroll", this.#scheduleRefresh, true);
    this.#window.addEventListener("resize", this.#scheduleRefresh);
    const MutationObserverConstructor = (this.#window as unknown as WindowWithObservers).MutationObserver;
    const ResizeObserverConstructor = (this.#window as unknown as WindowWithObservers).ResizeObserver;
    const mutationObserver = new MutationObserverConstructor(this.#scheduleRefresh);
    mutationObserver.observe(this.#document.body, { childList: true, subtree: true });
    this.#mutationObserver = mutationObserver;
    const resizeObserver = new ResizeObserverConstructor(this.#scheduleRefresh);
    resizeObserver.observe(this.#document.documentElement);
    resizeObserver.observe(this.#document.body);
    this.#resizeObserver = resizeObserver;
    this.#state = "mounted";
    return this.snapshot();
  }

  setInteractionMode(mode: ReviewShellInteractionMode): ReviewDocumentOverlaySnapshot {
    this.#requireMounted();
    this.#interactionMode = requireInteractionMode(mode);
    this.#root!.dataset.interactionMode = this.#interactionMode;
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
    this.#threads.clear();
    for (const [threadId, thread] of next) this.#threads.set(threadId, thread);
    this.#reportedUnavailable.clear();
    this.#replacementRequested.clear();
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
    this.#closeComposer();
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
    event.preventDefault();
    event.stopImmediatePropagation();
    const anchorTarget = target.closest("[data-collab-review-id]");
    if (!anchorTarget || anchorTarget.ownerDocument !== this.#document) return;
    const anchor = this.#captureAnchor(anchorTarget, event.clientX, event.clientY);
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
    this.#openComposer(anchor, event.clientX, event.clientY);
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

  #refreshPlacements(): void {
    this.#resizeObserver?.disconnect();
    this.#resizeObserver?.observe(this.#document.documentElement);
    this.#resizeObserver?.observe(this.#document.body);
    for (const thread of this.#threads.values()) {
      if (thread.anchor.locationAvailability !== "available") {
        this.#removePin(thread.threadId);
        continue;
      }
      const target = resolveAnchorElement(this.#document, thread.anchor);
      if (!target) {
        this.#removePin(thread.threadId);
        this.#reportUnavailable(thread);
        continue;
      }
      this.#reportedUnavailable.delete(unavailableKey(thread));
      this.#resizeObserver?.observe(target);
      const rect = target.getBoundingClientRect();
      const x = rect.left + thread.anchor.element.offset.x;
      const y = rect.top + thread.anchor.element.offset.y;
      const pin = this.#pin(thread);
      pin.hidden = x < 0 || y < 0 || x > this.#window.innerWidth || y > this.#window.innerHeight;
      pin.style.left = `${x}px`;
      pin.style.top = `${y}px`;
    }
  }

  #pin(thread: ReviewDocumentOverlayThread): HTMLButtonElement {
    const known = this.#pins.get(thread.threadId);
    if (known) {
      known.setAttribute("aria-label", `Open ${thread.label ?? "review thread"}`);
      return known;
    }
    const pin = this.#document.createElement("button");
    pin.type = "button";
    pin.className = "crl-overlay__pin";
    pin.setAttribute("aria-label", `Open ${thread.label ?? "review thread"}`);
    pin.textContent = "●";
    pin.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (this.#interactionMode === "comment") this.#onOpenThread(thread.threadId);
    });
    this.#root!.appendChild(pin);
    this.#pins.set(thread.threadId, pin);
    return pin;
  }

  #removePin(threadId: string): void {
    this.#pins.get(threadId)?.remove();
    this.#pins.delete(threadId);
  }

  #reportUnavailable(thread: ReviewDocumentOverlayThread): void {
    const key = unavailableKey(thread);
    if (this.#reportedUnavailable.has(key)) return;
    this.#reportedUnavailable.add(key);
    this.#onAnchorUnavailable(Object.freeze({
      threadId: thread.threadId,
      anchorGeneration: thread.anchorGeneration,
    }));
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
    const identity = target.getAttribute("data-collab-review-id")?.trim();
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

  #openComposer(anchor: CurrentAnchor, clientX: number, clientY: number): void {
    this.#closeComposer();
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
    positionComposer(composer, clientX, clientY, this.#window);
    textarea.focus();
  }

  #closeComposer(): void {
    this.#composer?.remove();
    this.#composer = undefined;
    this.#draftAnchor = undefined;
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
    reviewId: requireIdentifier(record.reviewId, "review"),
    prototypeId: requireIdentifier(record.prototypeId, "prototype"),
    revisionId: requireIdentifier(record.revisionId, "revision"),
    viewportId: requireIdentifier(record.viewportId, "viewport"),
    variantId: requireIdentifier(record.variantId, "variant"),
    route: requireRoute(record.route),
    deviceId: requireIdentifier(record.deviceId, "device"),
    surfaceId: requireIdentifier(record.surfaceId, "surface"),
  };
  return Object.freeze(context);
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
      const context = requireAnchorContext(record.context);
      requireMatchingContext(context, expectedContext);
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
  const context = requireAnchorContext(record.context);
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

function requireRoute(value: unknown): string {
  const result = readBridgeRoute(value);
  if (!result.ok) throw new ReviewDocumentOverlayError("invalid_config", "review overlay route is invalid");
  return result.value;
}

function requireInteractionMode(value: unknown): ReviewShellInteractionMode {
  if (value !== "pointer" && value !== "comment") {
    throw new ReviewDocumentOverlayError("invalid_config", "review overlay interaction mode is invalid");
  }
  return value;
}

function isDocument(value: unknown): value is Document {
  return Boolean(value) && typeof value === "object" && (value as { nodeType?: unknown }).nodeType === 9;
}

function isElement(value: unknown): value is Element {
  return Boolean(value) && typeof value === "object" && (value as { nodeType?: unknown }).nodeType === 1;
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

function unavailableKey(thread: ReviewDocumentOverlayThread): string {
  return JSON.stringify([thread.threadId, thread.anchorGeneration]);
}

interface WindowWithObservers {
  readonly MutationObserver: typeof MutationObserver;
  readonly ResizeObserver: typeof ResizeObserver;
}
