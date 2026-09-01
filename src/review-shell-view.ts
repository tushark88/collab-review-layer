import type {
  ReviewShellBridgeRequests,
  ReviewShellInteractionMode,
  ReviewShellSnapshot,
} from "./shell-state.ts";
import { ReviewShellController, ReviewShellStateError } from "./shell-state.ts";

export const REVIEW_SHELL_CHANGE_EVENT = "collab-review-layer:change";

export type ReviewShellViewAction =
  | "interaction-mode"
  | "prototype"
  | "revision"
  | "variant"
  | "route"
  | "viewport"
  | "custom-viewport";

export interface ReviewShellViewChange {
  readonly action: ReviewShellViewAction;
  readonly snapshot: ReviewShellSnapshot;
  readonly bridgeRequests: ReviewShellBridgeRequests;
}

export type ReviewShellViewState = "idle" | "mounted" | "destroyed";
export type ReviewShellHeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;

export interface ReviewShellViewSnapshot {
  readonly state: ReviewShellViewState;
  readonly shell: ReviewShellSnapshot;
}

export interface ReviewShellViewConfig {
  readonly root: HTMLElement;
  readonly controller: ReviewShellController;
  readonly preview: HTMLElement;
  readonly label?: string;
  readonly headingLevel?: ReviewShellHeadingLevel;
}

export type ReviewShellViewErrorCode = "invalid_config" | "invalid_state";

export class ReviewShellViewError extends Error {
  readonly code: ReviewShellViewErrorCode;

  constructor(code: ReviewShellViewErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ReviewShellViewError";
    this.code = code;
  }
}

interface ViewElements {
  readonly shell: HTMLElement;
  readonly prototype: HTMLSelectElement;
  readonly revision: HTMLSelectElement;
  readonly variant: HTMLSelectElement;
  readonly route: HTMLInputElement;
  readonly routeForm: HTMLFormElement;
  readonly pointerMode: HTMLButtonElement;
  readonly commentMode: HTMLButtonElement;
  readonly viewport: HTMLSelectElement;
  readonly customGroup: HTMLFieldSetElement;
  readonly customForm: HTMLFormElement;
  readonly customWidth: HTMLInputElement;
  readonly customHeight: HTMLInputElement;
  readonly customPixelRatio: HTMLInputElement;
  readonly viewportFrame: HTMLElement;
  readonly viewportSummary: HTMLElement;
  readonly status: HTMLElement;
}

/**
 * Accessible, framework-neutral renderer for ReviewShellController. The module
 * owns shell DOM and focus-preserving updates while the caller keeps ownership
 * of the supplied preview element, frame security, persistence, and transport.
 */
export class ReviewShellView {
  readonly #root: HTMLElement;
  readonly #controller: ReviewShellController;
  readonly #preview: HTMLElement;
  readonly #label: string;
  readonly #headingLevel: ReviewShellHeadingLevel;
  readonly #document: Document;
  readonly #window: Window;
  readonly #previewHadClass: boolean;
  #state: ReviewShellViewState = "idle";
  #elements?: ViewElements;

  constructor(config: ReviewShellViewConfig) {
    if (!isHtmlElement(config?.root)) throw new ReviewShellViewError("invalid_config", "review shell root is invalid");
    if (!(config.controller instanceof ReviewShellController)) {
      throw new ReviewShellViewError("invalid_config", "review shell controller is invalid");
    }
    if (!isHtmlElement(config.preview)) throw new ReviewShellViewError("invalid_config", "review shell preview is invalid");
    if (config.root.ownerDocument !== config.preview.ownerDocument) {
      throw new ReviewShellViewError("invalid_config", "review shell root and preview must share a document");
    }
    if (config.preview.parentNode !== null || config.preview === config.root || config.preview.contains(config.root)) {
      throw new ReviewShellViewError("invalid_config", "review shell preview must be detached and independent from its root");
    }
    const view = config.root.ownerDocument.defaultView;
    if (!view) throw new ReviewShellViewError("invalid_config", "review shell root must belong to a browser window");
    this.#root = config.root;
    this.#controller = config.controller;
    this.#preview = config.preview;
    this.#label = requireLabel(config.label ?? "Prototype review");
    this.#headingLevel = requireHeadingLevel(config.headingLevel ?? 2);
    this.#document = config.root.ownerDocument;
    this.#window = view;
    this.#previewHadClass = config.preview.classList.contains("crl-shell__preview-root");
  }

  mount(): ReviewShellViewSnapshot {
    if (this.#state !== "idle") throw new ReviewShellViewError("invalid_state", "review shell view can only mount once");
    const elements = this.#createElements();
    try {
      this.#preview.classList.add("crl-shell__preview-root");
      elements.viewportFrame.appendChild(this.#preview);
      this.#root.appendChild(elements.shell);
      this.#elements = elements;
      this.#state = "mounted";
      this.#render(this.#controller.snapshot());
      return this.snapshot();
    } catch (cause) {
      this.#preview.remove();
      if (!this.#previewHadClass) this.#preview.classList.remove("crl-shell__preview-root");
      elements.shell.remove();
      this.#elements = undefined;
      this.#state = "idle";
      throw new ReviewShellViewError("invalid_state", "review shell view could not be mounted", { cause });
    }
  }

  refresh(): ReviewShellViewSnapshot {
    this.#requireMounted();
    this.#render(this.#controller.snapshot());
    return this.snapshot();
  }

  snapshot(): ReviewShellViewSnapshot {
    return Object.freeze({ state: this.#state, shell: this.#controller.snapshot() });
  }

  destroy(): void {
    if (this.#state === "destroyed") return;
    if (this.#elements) {
      this.#preview.remove();
      this.#elements.shell.remove();
      this.#elements = undefined;
    }
    if (!this.#previewHadClass) this.#preview.classList.remove("crl-shell__preview-root");
    this.#state = "destroyed";
  }

  #createElements(): ViewElements {
    const shell = this.#element("section", "crl-shell");
    shell.setAttribute("aria-label", this.#label);
    shell.dataset.collabReviewLayer = "shell";

    const header = this.#element("header", "crl-shell__header");
    const headingTag = `h${this.#headingLevel}` as const;
    const title = this.#element(headingTag, "crl-shell__title");
    title.textContent = this.#label;
    header.appendChild(title);

    const controls = this.#element("div", "crl-shell__controls");
    const prototypeField = this.#selectField("Prototype");
    const revisionField = this.#selectField("Revision");
    const variantField = this.#selectField("Variant");
    const viewportField = this.#selectField("Viewport");

    const routeForm = this.#element("form", "crl-shell__route-form") as HTMLFormElement;
    routeForm.noValidate = true;
    const routeLabel = this.#element("label", "crl-shell__field crl-shell__field--route");
    routeLabel.appendChild(this.#fieldLabel("Route"));
    const route = this.#element("input", "crl-shell__control") as HTMLInputElement;
    route.type = "text";
    route.required = true;
    route.spellcheck = false;
    route.autocapitalize = "none";
    route.autocomplete = "off";
    const routeSubmit = this.#element("button", "crl-shell__button") as HTMLButtonElement;
    routeSubmit.type = "submit";
    routeSubmit.textContent = "Go";
    routeLabel.appendChild(route);
    const routeRow = this.#element("div", "crl-shell__input-row");
    routeRow.append(routeLabel, routeSubmit);
    routeForm.appendChild(routeRow);

    const modeGroup = this.#element("fieldset", "crl-shell__mode-group") as HTMLFieldSetElement;
    const modeLegend = this.#element("legend", "crl-shell__legend");
    modeLegend.textContent = "Interaction mode";
    const modeButtons = this.#element("div", "crl-shell__mode-buttons");
    const pointerMode = this.#modeButton("Pointer");
    const commentMode = this.#modeButton("Comment");
    modeButtons.append(pointerMode, commentMode);
    modeGroup.append(modeLegend, modeButtons);

    controls.append(
      prototypeField.label,
      revisionField.label,
      variantField.label,
      routeForm,
      viewportField.label,
      modeGroup,
    );

    const customGroup = this.#element("fieldset", "crl-shell__custom") as HTMLFieldSetElement;
    const customLegend = this.#element("legend", "crl-shell__legend");
    customLegend.textContent = "Custom viewport dimensions";
    const customForm = this.#element("form", "crl-shell__custom-form") as HTMLFormElement;
    const customWidth = this.#numberField(customForm, "Width", 1, 16_384, 1);
    const customHeight = this.#numberField(customForm, "Height", 1, 16_384, 1);
    const customPixelRatio = this.#numberField(customForm, "Pixel ratio", 0.1, 10, "any");
    const applyCustom = this.#element("button", "crl-shell__button") as HTMLButtonElement;
    applyCustom.type = "submit";
    applyCustom.textContent = "Apply dimensions";
    customForm.appendChild(applyCustom);
    customGroup.append(customLegend, customForm);

    header.append(controls, customGroup);

    const content = this.#element("div", "crl-shell__content");
    const previewRegion = this.#element("section", "crl-shell__preview");
    previewRegion.setAttribute("aria-label", "Live prototype preview");
    const viewportSummary = this.#element("p", "crl-shell__viewport-summary");
    const viewportScroll = this.#element("div", "crl-shell__viewport-scroll");
    viewportScroll.tabIndex = 0;
    viewportScroll.setAttribute("role", "region");
    viewportScroll.setAttribute("aria-label", "Scrollable prototype viewport");
    const viewportFrame = this.#element("div", "crl-shell__viewport-frame");
    viewportScroll.appendChild(viewportFrame);
    previewRegion.append(viewportSummary, viewportScroll);
    content.appendChild(previewRegion);

    const status = this.#element("p", "crl-shell__status crl-shell__visually-hidden");
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    status.setAttribute("aria-atomic", "true");
    shell.append(header, content, status);

    prototypeField.select.addEventListener("change", () => this.#commit(
      "prototype",
      () => this.#controller.selectPrototype(prototypeField.select.value),
      (snapshot) => `Prototype changed to ${selectedLabel(snapshot.prototypes, snapshot.prototypeId)}.`,
    ));
    revisionField.select.addEventListener("change", () => this.#commit(
      "revision",
      () => this.#controller.selectRevision(revisionField.select.value),
      (snapshot) => `Revision changed to ${selectedLabel(snapshot.revisions, snapshot.revisionId)}.`,
    ));
    variantField.select.addEventListener("change", () => this.#commit(
      "variant",
      () => this.#controller.selectVariant(variantField.select.value),
      (snapshot) => `Variant changed to ${selectedLabel(snapshot.variants, snapshot.variantId)}.`,
    ));
    viewportField.select.addEventListener("change", () => this.#commit(
      "viewport",
      () => this.#controller.selectViewport(viewportField.select.value),
      (snapshot) => `Viewport changed to ${snapshot.viewport.label}, ${snapshot.viewport.width} by ${snapshot.viewport.height} CSS pixels.`,
    ));
    const selectInteractionMode = (mode: ReviewShellInteractionMode): void => {
      if (this.#controller.snapshot().interactionMode === mode) return;
      const label = mode === "pointer" ? "Pointer" : "Comment";
      this.#commit(
        "interaction-mode",
        () => this.#controller.setInteractionMode(mode),
        () => `${label} mode selected.`,
      );
    };
    pointerMode.addEventListener("click", () => selectInteractionMode("pointer"));
    commentMode.addEventListener("click", () => selectInteractionMode("comment"));
    route.addEventListener("input", () => clearValidity(route));
    routeForm.addEventListener("submit", (event) => {
      event.preventDefault();
      this.#commit(
        "route",
        () => this.#controller.navigate(route.value),
        (snapshot) => `Route changed to ${snapshot.route}.`,
        route,
      );
    });
    for (const input of [customWidth, customHeight, customPixelRatio]) {
      input.addEventListener("input", () => clearValidity(input));
    }
    customForm.addEventListener("submit", (event) => {
      event.preventDefault();
      if (!customForm.reportValidity()) return;
      const viewportId = this.#controller.snapshot().viewport.id;
      this.#commit(
        "custom-viewport",
        () => this.#controller.setCustomViewport(
          viewportId,
          Number(customWidth.value),
          Number(customHeight.value),
          Number(customPixelRatio.value),
        ),
        (snapshot) => `Custom viewport changed to ${snapshot.viewport.width} by ${snapshot.viewport.height} CSS pixels at ${snapshot.viewport.devicePixelRatio} pixel ratio.`,
        customWidth,
      );
    });

    return {
      shell,
      prototype: prototypeField.select,
      revision: revisionField.select,
      variant: variantField.select,
      route,
      routeForm,
      pointerMode,
      commentMode,
      viewport: viewportField.select,
      customGroup,
      customForm,
      customWidth,
      customHeight,
      customPixelRatio,
      viewportFrame,
      viewportSummary,
      status,
    };
  }

  #render(snapshot: ReviewShellSnapshot): void {
    const elements = this.#requireMounted();
    updateOptions(elements.prototype, snapshot.prototypes, snapshot.prototypeId);
    updateOptions(elements.revision, snapshot.revisions, snapshot.revisionId);
    updateOptions(elements.variant, snapshot.variants, snapshot.variantId);
    updateOptions(elements.viewport, snapshot.viewports, snapshot.viewport.id);
    clearValidity(elements.route);
    elements.route.value = snapshot.route;
    setPressed(elements.pointerMode, snapshot.interactionMode === "pointer");
    setPressed(elements.commentMode, snapshot.interactionMode === "comment");
    const custom = snapshot.viewport.presentation === "custom";
    elements.customGroup.hidden = !custom;
    for (const input of [elements.customWidth, elements.customHeight, elements.customPixelRatio]) input.disabled = !custom;
    elements.customWidth.value = String(snapshot.viewport.width);
    elements.customHeight.value = String(snapshot.viewport.height);
    elements.customPixelRatio.value = String(snapshot.viewport.devicePixelRatio);
    elements.viewportFrame.dataset.presentation = snapshot.viewport.presentation;
    elements.viewportFrame.style.inlineSize = `${snapshot.viewport.width}px`;
    elements.viewportFrame.style.blockSize = `${snapshot.viewport.height}px`;
    elements.viewportFrame.setAttribute(
      "aria-label",
      `${snapshot.viewport.label} prototype viewport, ${snapshot.viewport.width} by ${snapshot.viewport.height} CSS pixels`,
    );
    elements.viewportSummary.textContent = `${snapshot.viewport.label} · ${snapshot.viewport.width} × ${snapshot.viewport.height} CSS px · ${snapshot.viewport.devicePixelRatio}×`;
  }

  #commit(
    action: ReviewShellViewAction,
    mutation: () => ReviewShellSnapshot,
    announcement: (snapshot: ReviewShellSnapshot) => string,
    validityTarget?: HTMLInputElement,
  ): void {
    const elements = this.#requireMounted();
    let snapshot: ReviewShellSnapshot;
    try {
      snapshot = mutation();
    } catch (error) {
      const message = error instanceof ReviewShellStateError ? error.message : "review shell change failed";
      elements.status.textContent = `Change not applied: ${message}.`;
      if (validityTarget) {
        validityTarget.setAttribute("aria-invalid", "true");
        validityTarget.setCustomValidity(message);
        validityTarget.reportValidity();
      }
      return;
    }

    if (validityTarget) clearValidity(validityTarget);
    try {
      this.#render(snapshot);
      elements.status.textContent = announcement(snapshot);
      const detail: ReviewShellViewChange = Object.freeze({
        action,
        snapshot,
        bridgeRequests: this.#controller.bridgeRequests(),
      });
      const CustomEventConstructor = Reflect.get(this.#window, "CustomEvent") as typeof CustomEvent;
      this.#root.dispatchEvent(new CustomEventConstructor<ReviewShellViewChange>(REVIEW_SHELL_CHANGE_EVENT, {
        bubbles: true,
        detail,
      }));
    } catch (cause) {
      throw new ReviewShellViewError("invalid_state", "review shell state changed but the view could not be refreshed", { cause });
    }
  }

  #requireMounted(): ViewElements {
    if (this.#state !== "mounted" || !this.#elements) {
      throw new ReviewShellViewError("invalid_state", "review shell view is not mounted");
    }
    return this.#elements;
  }

  #selectField(labelText: string): { label: HTMLLabelElement; select: HTMLSelectElement } {
    const label = this.#element("label", "crl-shell__field") as HTMLLabelElement;
    label.appendChild(this.#fieldLabel(labelText));
    const select = this.#element("select", "crl-shell__control") as HTMLSelectElement;
    label.appendChild(select);
    return { label, select };
  }

  #numberField(
    form: HTMLFormElement,
    labelText: string,
    min: number,
    max: number,
    step: number | "any",
  ): HTMLInputElement {
    const label = this.#element("label", "crl-shell__field");
    label.appendChild(this.#fieldLabel(labelText));
    const input = this.#element("input", "crl-shell__control") as HTMLInputElement;
    input.type = "number";
    input.required = true;
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.inputMode = step === "any" || step < 1 ? "decimal" : "numeric";
    label.appendChild(input);
    form.appendChild(label);
    return input;
  }

  #modeButton(label: string): HTMLButtonElement {
    const button = this.#element("button", "crl-shell__mode-button") as HTMLButtonElement;
    button.type = "button";
    button.setAttribute("aria-pressed", "false");
    const mark = this.#element("span", "crl-shell__selection-mark");
    mark.setAttribute("aria-hidden", "true");
    mark.hidden = true;
    mark.textContent = "✓";
    const text = this.#element("span", "crl-shell__mode-label");
    text.textContent = label;
    button.append(mark, text);
    return button;
  }

  #fieldLabel(value: string): HTMLElement {
    const label = this.#element("span", "crl-shell__field-label");
    label.textContent = value;
    return label;
  }

  #element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
    const element = this.#document.createElement(tag);
    element.className = className;
    return element;
  }
}

function isHtmlElement(value: unknown): value is HTMLElement {
  if (!value || typeof value !== "object" || !("ownerDocument" in value)) return false;
  const ownerDocument = (value as { ownerDocument?: Document }).ownerDocument;
  const view = ownerDocument?.defaultView;
  const HTMLElementConstructor = view ? Reflect.get(view, "HTMLElement") as typeof HTMLElement | undefined : undefined;
  return typeof HTMLElementConstructor === "function" && value instanceof HTMLElementConstructor;
}

function requireLabel(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 256 || /[\u0000\r\n]/u.test(value)) {
    throw new ReviewShellViewError("invalid_config", "review shell label is invalid");
  }
  return value;
}

function requireHeadingLevel(value: unknown): ReviewShellHeadingLevel {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 6) {
    throw new ReviewShellViewError("invalid_config", "review shell heading level is invalid");
  }
  return value as ReviewShellHeadingLevel;
}

function updateOptions(
  select: HTMLSelectElement,
  options: readonly { readonly id: string; readonly label: string }[],
  selectedId: string,
): void {
  const current = [...select.options];
  const unchanged = current.length === options.length && current.every((option, index) => {
    const expected = options[index];
    return expected !== undefined && option.value === expected.id && option.text === expected.label;
  });
  if (!unchanged) {
    const fragment = select.ownerDocument.createDocumentFragment();
    for (const candidate of options) {
      const option = select.ownerDocument.createElement("option");
      option.value = candidate.id;
      option.textContent = candidate.label;
      fragment.appendChild(option);
    }
    select.replaceChildren(fragment);
  }
  select.value = selectedId;
}

function selectedLabel(options: readonly { readonly id: string; readonly label: string }[], selectedId: string): string {
  return options.find((option) => option.id === selectedId)?.label ?? selectedId;
}

function clearValidity(input: HTMLInputElement): void {
  input.removeAttribute("aria-invalid");
  input.setCustomValidity("");
}

function setPressed(button: HTMLButtonElement, pressed: boolean): void {
  button.setAttribute("aria-pressed", String(pressed));
  const mark = button.querySelector<HTMLElement>(".crl-shell__selection-mark");
  if (mark) mark.hidden = !pressed;
}
