import type {
  BridgeNavigationMessage,
  BridgeVariantMessage,
  BridgeViewportMessage,
} from "./bridge.ts";

export type ReviewShellInteractionMode = "pointer" | "comment";
export type ReviewShellViewportPresentation = "desktop" | "mobile" | "custom";

export interface ReviewShellVariantDefinition {
  readonly id: string;
  readonly label: string;
}

export interface ReviewShellRevisionDefinition {
  readonly id: string;
  readonly label: string;
  readonly initialVariantId: string;
  readonly initialRoute: string;
  readonly variants: readonly ReviewShellVariantDefinition[];
}

export interface ReviewShellPrototypeDefinition {
  readonly id: string;
  readonly label: string;
  readonly initialRevisionId: string;
  readonly revisions: readonly ReviewShellRevisionDefinition[];
}

export interface ReviewShellViewportDefinition {
  readonly id: string;
  readonly label: string;
  readonly presentation: ReviewShellViewportPresentation;
  readonly width: number;
  readonly height: number;
  readonly devicePixelRatio: number;
}

export interface ReviewShellConfig {
  readonly prototypes: readonly ReviewShellPrototypeDefinition[];
  readonly viewports: readonly ReviewShellViewportDefinition[];
  readonly initialPrototypeId: string;
  readonly initialViewportId: string;
  readonly initialInteractionMode?: ReviewShellInteractionMode;
}

export interface ReviewShellOption {
  readonly id: string;
  readonly label: string;
}

export interface ReviewShellSnapshot {
  readonly interactionMode: ReviewShellInteractionMode;
  readonly prototypeId: string;
  readonly revisionId: string;
  readonly variantId: string;
  readonly route: string;
  readonly viewport: ReviewShellViewportDefinition;
  readonly prototypes: readonly ReviewShellOption[];
  readonly revisions: readonly ReviewShellOption[];
  readonly variants: readonly ReviewShellOption[];
  readonly viewports: readonly ReviewShellViewportDefinition[];
}

export interface ReviewShellBridgeRequests {
  readonly navigation: BridgeNavigationMessage;
  readonly variant: BridgeVariantMessage;
  readonly viewport: BridgeViewportMessage;
}

export type ReviewShellStateErrorCode = "invalid_config" | "invalid_input" | "invalid_selection";

export class ReviewShellStateError extends Error {
  readonly code: ReviewShellStateErrorCode;

  constructor(code: ReviewShellStateErrorCode, message: string) {
    super(message);
    this.name = "ReviewShellStateError";
    this.code = code;
  }
}

interface StoredRevision {
  readonly id: string;
  readonly label: string;
  readonly initialVariantId: string;
  readonly initialRoute: string;
  readonly variants: ReadonlyMap<string, ReviewShellOption>;
}

interface StoredPrototype {
  readonly id: string;
  readonly label: string;
  readonly initialRevisionId: string;
  readonly revisions: ReadonlyMap<string, StoredRevision>;
}

/**
 * DOM-free owner of shell navigation, interaction-mode, and viewport state.
 * Rendering, transport, iframe policy, persistence, and analytics remain at
 * separate boundaries.
 */
export class ReviewShellController {
  readonly #prototypes: ReadonlyMap<string, StoredPrototype>;
  readonly #viewports = new Map<string, ReviewShellViewportDefinition>();
  #interactionMode: ReviewShellInteractionMode;
  #prototypeId: string;
  #revisionId: string;
  #variantId: string;
  #route: string;
  #viewportId: string;

  constructor(config: ReviewShellConfig) {
    this.#prototypes = parsePrototypes(config.prototypes);
    for (const viewport of parseViewports(config.viewports)) this.#viewports.set(viewport.id, viewport);
    const prototype = requireSelection(this.#prototypes, config.initialPrototypeId, "initial prototype", "invalid_config");
    const revision = requireSelection(prototype.revisions, prototype.initialRevisionId, "prototype initial revision", "invalid_config");
    requireSelection(revision.variants, revision.initialVariantId, "revision initial variant", "invalid_config");
    requireSelection(this.#viewports, config.initialViewportId, "initial viewport", "invalid_config");
    this.#interactionMode = requireInteractionMode(config.initialInteractionMode ?? "pointer", "invalid_config");
    this.#prototypeId = prototype.id;
    this.#revisionId = revision.id;
    this.#variantId = revision.initialVariantId;
    this.#route = revision.initialRoute;
    this.#viewportId = config.initialViewportId;
  }

  snapshot(): ReviewShellSnapshot {
    const prototype = this.#currentPrototype();
    const revision = this.#currentRevision();
    const viewport = this.#currentViewport();
    return Object.freeze({
      interactionMode: this.#interactionMode,
      prototypeId: this.#prototypeId,
      revisionId: this.#revisionId,
      variantId: this.#variantId,
      route: this.#route,
      viewport: copyViewport(viewport),
      prototypes: freezeOptions(this.#prototypes.values()),
      revisions: freezeOptions(prototype.revisions.values()),
      variants: freezeOptions(revision.variants.values()),
      viewports: Object.freeze([...this.#viewports.values()].map(copyViewport)),
    });
  }

  bridgeRequests(): ReviewShellBridgeRequests {
    const viewport = this.#currentViewport();
    return Object.freeze({
      navigation: Object.freeze({ type: "navigation", mode: "request", route: this.#route }),
      variant: Object.freeze({ type: "variant", mode: "request", variantId: this.#variantId }),
      viewport: Object.freeze({
        type: "viewport",
        mode: "request",
        viewportId: viewport.id,
        width: viewport.width,
        height: viewport.height,
        devicePixelRatio: viewport.devicePixelRatio,
      }),
    });
  }

  setInteractionMode(mode: ReviewShellInteractionMode): ReviewShellSnapshot {
    this.#interactionMode = requireInteractionMode(mode, "invalid_input");
    return this.snapshot();
  }

  selectPrototype(prototypeId: string): ReviewShellSnapshot {
    const prototype = requireSelection(this.#prototypes, prototypeId, "prototype", "invalid_selection");
    const revision = requireSelection(prototype.revisions, prototype.initialRevisionId, "prototype initial revision", "invalid_config");
    this.#prototypeId = prototype.id;
    this.#revisionId = revision.id;
    this.#variantId = revision.initialVariantId;
    this.#route = revision.initialRoute;
    return this.snapshot();
  }

  selectRevision(revisionId: string): ReviewShellSnapshot {
    const revision = requireSelection(this.#currentPrototype().revisions, revisionId, "revision", "invalid_selection");
    this.#revisionId = revision.id;
    this.#variantId = revision.initialVariantId;
    this.#route = revision.initialRoute;
    return this.snapshot();
  }

  selectVariant(variantId: string): ReviewShellSnapshot {
    const variant = requireSelection(this.#currentRevision().variants, variantId, "variant", "invalid_selection");
    this.#variantId = variant.id;
    return this.snapshot();
  }

  navigate(route: string): ReviewShellSnapshot {
    this.#route = requireRoute(route, "invalid_input");
    return this.snapshot();
  }

  selectViewport(viewportId: string): ReviewShellSnapshot {
    const viewport = requireSelection(this.#viewports, viewportId, "viewport", "invalid_selection");
    this.#viewportId = viewport.id;
    return this.snapshot();
  }

  setCustomViewport(viewportId: string, width: number, height: number, devicePixelRatio: number): ReviewShellSnapshot {
    const viewport = requireSelection(this.#viewports, viewportId, "viewport", "invalid_selection");
    if (viewport.presentation !== "custom") fail("invalid_input", "only a custom viewport can be resized");
    const replacement = Object.freeze({
      ...viewport,
      width: requireSafeInteger(width, "custom viewport width", "invalid_input"),
      height: requireSafeInteger(height, "custom viewport height", "invalid_input"),
      devicePixelRatio: requirePixelRatio(devicePixelRatio, "custom viewport pixel ratio", "invalid_input"),
    });
    this.#viewports.set(viewport.id, replacement);
    this.#viewportId = viewport.id;
    return this.snapshot();
  }

  #currentPrototype(): StoredPrototype {
    return this.#prototypes.get(this.#prototypeId)!;
  }

  #currentRevision(): StoredRevision {
    return this.#currentPrototype().revisions.get(this.#revisionId)!;
  }

  #currentViewport(): ReviewShellViewportDefinition {
    return this.#viewports.get(this.#viewportId)!;
  }
}

function parsePrototypes(value: readonly ReviewShellPrototypeDefinition[]): ReadonlyMap<string, StoredPrototype> {
  if (!Array.isArray(value) || value.length === 0) fail("invalid_config", "at least one prototype is required");
  const prototypes = new Map<string, StoredPrototype>();
  for (const candidate of value) {
    const id = requireText(candidate?.id, "prototype id", "invalid_config");
    if (prototypes.has(id)) fail("invalid_config", "prototype ids must be unique");
    if (!Array.isArray(candidate.revisions) || candidate.revisions.length === 0) fail("invalid_config", "each prototype requires a revision");
    const revisions = new Map<string, StoredRevision>();
    for (const revisionCandidate of candidate.revisions) {
      const revisionId = requireText(revisionCandidate?.id, "revision id", "invalid_config");
      if (revisions.has(revisionId)) fail("invalid_config", "revision ids must be unique within a prototype");
      if (!Array.isArray(revisionCandidate.variants) || revisionCandidate.variants.length === 0) fail("invalid_config", "each revision requires a variant");
      const variants = new Map<string, ReviewShellOption>();
      for (const variantCandidate of revisionCandidate.variants) {
        const variantId = requireText(variantCandidate?.id, "variant id", "invalid_config");
        if (variants.has(variantId)) fail("invalid_config", "variant ids must be unique within a revision");
        variants.set(variantId, Object.freeze({ id: variantId, label: requireText(variantCandidate.label, "variant label", "invalid_config") }));
      }
      const initialVariantId = requireText(revisionCandidate.initialVariantId, "initial variant id", "invalid_config");
      requireSelection(variants, initialVariantId, "revision initial variant", "invalid_config");
      const revision = Object.freeze({
        id: revisionId,
        label: requireText(revisionCandidate.label, "revision label", "invalid_config"),
        initialVariantId,
        initialRoute: requireRoute(revisionCandidate.initialRoute, "invalid_config"),
        variants,
      });
      revisions.set(revisionId, revision);
    }
    const initialRevisionId = requireText(candidate.initialRevisionId, "initial revision id", "invalid_config");
    requireSelection(revisions, initialRevisionId, "prototype initial revision", "invalid_config");
    prototypes.set(id, Object.freeze({
      id,
      label: requireText(candidate.label, "prototype label", "invalid_config"),
      initialRevisionId,
      revisions,
    }));
  }
  return prototypes;
}

function parseViewports(value: readonly ReviewShellViewportDefinition[]): readonly ReviewShellViewportDefinition[] {
  if (!Array.isArray(value) || value.length === 0) fail("invalid_config", "at least one viewport is required");
  const ids = new Set<string>();
  return Object.freeze(value.map((candidate) => {
    const id = requireText(candidate?.id, "viewport id", "invalid_config");
    if (ids.has(id)) fail("invalid_config", "viewport ids must be unique");
    ids.add(id);
    if (candidate.presentation !== "desktop" && candidate.presentation !== "mobile" && candidate.presentation !== "custom") {
      fail("invalid_config", "viewport presentation is invalid");
    }
    return Object.freeze({
      id,
      label: requireText(candidate.label, "viewport label", "invalid_config"),
      presentation: candidate.presentation,
      width: requireSafeInteger(candidate.width, "viewport width", "invalid_config"),
      height: requireSafeInteger(candidate.height, "viewport height", "invalid_config"),
      devicePixelRatio: requirePixelRatio(candidate.devicePixelRatio, "viewport pixel ratio", "invalid_config"),
    });
  }));
}

function freezeOptions(values: Iterable<{ readonly id: string; readonly label: string }>): readonly ReviewShellOption[] {
  return Object.freeze([...values].map(({ id, label }) => Object.freeze({ id, label })));
}

function copyViewport(viewport: ReviewShellViewportDefinition): ReviewShellViewportDefinition {
  return Object.freeze({ ...viewport });
}

function requireSelection<T>(values: ReadonlyMap<string, T>, value: unknown, label: string, code: ReviewShellStateErrorCode): T {
  const id = requireText(value, `${label} id`, code);
  const selected = values.get(id);
  if (selected === undefined) fail(code, `${label} is not available`);
  return selected;
}

function requireInteractionMode(value: unknown, code: ReviewShellStateErrorCode): ReviewShellInteractionMode {
  if (value !== "pointer" && value !== "comment") fail(code, "interaction mode is invalid");
  return value;
}

function requireRoute(value: unknown, code: ReviewShellStateErrorCode): string {
  const route = requireText(value, "route", code, 2_048);
  if (!route.startsWith("/") || route.startsWith("//") || route.includes("\\") || /[\u0000-\u001f\u007f]/u.test(route)) {
    fail(code, "route must be an origin-relative path");
  }
  const base = new URL("https://shell.invalid");
  if (new URL(route, base).origin !== base.origin) fail(code, "route must not change origin");
  return route;
}

function requireText(value: unknown, label: string, code: ReviewShellStateErrorCode, maximumLength = 256): string {
  if (typeof value !== "string" || value.length > maximumLength || value.includes("\u0000") || value.includes("\r") || value.includes("\n") || !value.trim()) {
    fail(code, `${label} is invalid`);
  }
  return value;
}

function requireSafeInteger(value: unknown, label: string, code: ReviewShellStateErrorCode): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 16_384) fail(code, `${label} is invalid`);
  return value as number;
}

function requirePixelRatio(value: unknown, label: string, code: ReviewShellStateErrorCode): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0.1 || value > 10) fail(code, `${label} is invalid`);
  return value;
}

function fail(code: ReviewShellStateErrorCode, message: string): never {
  throw new ReviewShellStateError(code, message);
}
