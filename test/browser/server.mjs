import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const hostOrigin = "http://127.0.0.1:4173";
const prototypeOrigin = "http://127.0.0.1:4174";
const attackerOrigin = "http://127.0.0.1:4175";

const hostPage = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<title>Synthetic review host</title>
<main id="frames"></main>
<script type="module">
  import { ReviewFrameHost } from "/dist/browser.js";

  const container = document.querySelector("#frames");
  const events = [];
  const attackReports = [];
  let host;
  let cleanupReaction;

  function normalizeEvent(event) {
    if (event.type === "error") {
      return {
        type: event.type,
        error: { name: event.error.name, code: event.error.code, message: event.error.message },
        snapshot: event.snapshot,
      };
    }
    if (event.type === "message") return { type: event.type, message: event.message, snapshot: event.snapshot };
    return { type: event.type, snapshot: event.snapshot };
  }

  function reset(profile) {
    cleanupReaction = undefined;
    if (host) host.close();
    events.length = 0;
    host = new ReviewFrameHost({
      container,
      sandboxProfile: profile,
      onEvent: (event) => {
        events.push(normalizeEvent(event));
        if (event.type !== "error" || event.error.code !== "cleanup_failure" || !cleanupReaction) return;
        const reaction = cleanupReaction;
        cleanupReaction = undefined;
        if (reaction.action === "open") host.open(reaction.config);
        else host.close();
      },
    });
  }

  window.addEventListener("message", (event) => {
    if (event.data?.kind === "attacker-ready") {
      try {
        host.send({ type: "navigation", mode: "request", route: "/must-not-reach-attacker" });
      } catch (error) {
        attackReports.push({ kind: "host-send-error", name: error.name, code: error.code });
      }
    }
    if (event.data?.kind === "attacker-report") attackReports.push(event.data);
  });

  reset();
  globalThis.hostHarness = {
    reset,
    open: (config) => host.open(config),
    send: (message) => host.send(message),
    close: () => host.close(),
    snapshot: () => host.snapshot(),
    events,
    attackReports,
    frameDetails: () => [...container.querySelectorAll("iframe")].map((frame) => ({
      source: frame.src,
      title: frame.title,
      sandbox: frame.getAttribute("sandbox"),
      allow: frame.getAttribute("allow"),
      referrerPolicy: frame.referrerPolicy,
    })),
    addSibling: (source) => {
      const frame = document.createElement("iframe");
      frame.src = source;
      document.body.appendChild(frame);
    },
    reactToCleanup: (action, config) => {
      cleanupReaction = { action, config };
    },
    failNextCleanup: () => {
      const frame = container.querySelector("iframe");
      if (!frame) throw new Error("missing synthetic frame");
      const originalWindowRemove = window.removeEventListener;
      let failedWindowRemoval = false;
      window.removeEventListener = function(type, listener, options) {
        if (!failedWindowRemoval && type === "message") {
          failedWindowRemoval = true;
          window.removeEventListener = originalWindowRemove;
          throw new Error("synthetic window listener removal failure");
        }
        return originalWindowRemove.call(this, type, listener, options);
      };
      Object.defineProperty(frame, "removeEventListener", {
        configurable: true,
        value: () => { throw new Error("synthetic frame listener removal failure"); },
      });
      Object.defineProperty(frame, "remove", {
        configurable: true,
        value: () => { throw new Error("synthetic frame removal failure"); },
      });
    },
  };
</script>
</html>`;

const shellPage = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Synthetic review shell</title>
<link rel="stylesheet" href="/dist/review-shell.css">
<div id="shell-root"></div>
<script type="module">
  import {
    REVIEW_SHELL_CHANGE_EVENT,
    ReviewFrameHost,
    ReviewShellController,
    ReviewShellView,
  } from "/dist/browser.js";

  const root = document.querySelector("#shell-root");
  const preview = document.createElement("div");
  const previewAction = document.createElement("button");
  previewAction.type = "button";
  previewAction.textContent = "Synthetic preview action";
  preview.appendChild(previewAction);
  const frameEvents = [];
  const frameHost = new ReviewFrameHost({
    container: preview,
    onEvent: (event) => frameEvents.push(event),
  });
  const controller = new ReviewShellController({
    prototypes: [
      {
        id: "prototype-a",
        label: "Checkout flow",
        initialRevisionId: "revision-a1",
        revisions: [
          {
            id: "revision-a1",
            label: "Revision A1",
            initialVariantId: "variant-a1-default",
            initialRoute: "/overview",
            variants: [
              { id: "variant-a1-default", label: "Default" },
              { id: "variant-a1-compact", label: "Markup <img src=x> remains text" },
            ],
          },
          {
            id: "revision-a2",
            label: "Revision A2",
            initialVariantId: "variant-a2-default",
            initialRoute: "/confirmation",
            variants: [{ id: "variant-a2-default", label: "Default" }],
          },
        ],
      },
      {
        id: "prototype-b",
        label: "Account flow",
        initialRevisionId: "revision-b1",
        revisions: [
          {
            id: "revision-b1",
            label: "Revision B1",
            initialVariantId: "variant-b1-default",
            initialRoute: "/dashboard",
            variants: [{ id: "variant-b1-default", label: "Default" }],
          },
        ],
      },
    ],
    viewports: [
      { id: "desktop", label: "Desktop", presentation: "desktop", width: 1280, height: 720, devicePixelRatio: 1 },
      { id: "mobile", label: "Mobile", presentation: "mobile", width: 390, height: 844, devicePixelRatio: 3 },
      { id: "custom", label: "Custom", presentation: "custom", width: 640, height: 480, devicePixelRatio: 1 },
    ],
    initialPrototypeId: "prototype-a",
    initialViewportId: "desktop",
  });
  const changes = [];
  root.addEventListener(REVIEW_SHELL_CHANGE_EVENT, (event) => changes.push(event.detail));
  const view = new ReviewShellView({ root, controller, preview });
  view.mount();

  globalThis.shellHarness = {
    changes,
    snapshot: () => view.snapshot(),
    mount: () => view.mount(),
    refresh: () => view.refresh(),
    destroy: () => view.destroy(),
    openFrame: () => frameHost.open({
      source: "http://127.0.0.1:4174/prototype.html#sessionId=shell-frame-session&nonce=0123456789abcdef0123456789abcdef&hostOrigin=http%3A%2F%2F127.0.0.1%3A4173",
      title: "Synthetic hosted prototype",
      peerOrigin: "http://127.0.0.1:4174",
      sessionId: "shell-frame-session",
      nonce: "0123456789abcdef0123456789abcdef",
      capabilities: ["navigation", "viewport", "variant"],
    }),
    frameEvents,
    frameSnapshot: () => frameHost.snapshot(),
    setRootWidth: (width) => { root.style.inlineSize = width ? String(width) + "px" : ""; },
    previewDetached: () => preview.parentNode === null,
    shellPresent: () => Boolean(root.querySelector("[data-collab-review-layer='shell']")),
  };
</script>
</html>`;

const overlayFixtureStyles = `
html, body { margin: 0; min-height: 100%; }
body { min-width: 320px; }
#growth { height: 0; }
#growth[data-grown="true"] { height: 300px; }
#unanchorable-action { position: absolute; inset-block-start: 0; inset-inline-end: 0; }
#prototype-action { width: 160px; height: 80px; margin: 40px; padding: 0; border: 0; }
#nested-anchor { position: absolute; inset-block-end: 20px; inset-inline-end: 20px; }
#layout-row { position: absolute; inset-block-end: 100px; inset-inline-start: 20px; display: flex; }
#layout-sibling { inline-size: 40px; block-size: 40px; transition: inline-size 800ms linear; }
#layout-row[data-moving="true"] #layout-sibling { inline-size: 160px; }
@keyframes synthetic-preexisting-layout-motion { from { inline-size: 40px; } to { inline-size: 200px; } }
#layout-row[data-preexisting="true"] #layout-sibling { animation: synthetic-preexisting-layout-motion 10000ms linear forwards; }
#ancestor-transform-parent { position: absolute; inset-block-start: 300px; inset-inline-end: 20px; transform-origin: 0 0; }
#ancestor-transform-target { position: relative; inline-size: 160px; block-size: 80px; }
#nested-3d-reference { position: absolute; inset-block-start: 20px; inset-inline-start: 30px; inline-size: 4px; block-size: 4px; }
@keyframes synthetic-target-motion { from { transform: translateX(0); } to { transform: translateX(120px); } }
#prototype-action[data-animating="true"] { animation: synthetic-target-motion 800ms linear forwards; }
#prototype-action[data-precomposer-animating="true"] { animation: synthetic-target-motion 3000ms linear forwards; }
@keyframes synthetic-cosmetic-motion { from { color: rgb(0 0 0); } to { color: rgb(0 0 255); } }
#prototype-action[data-cosmetic-animation="true"] { animation: synthetic-cosmetic-motion 100ms linear infinite alternate; }
@keyframes synthetic-unrelated-spinner-motion { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
#unrelated-spinner { position: fixed; inset-block-end: 8px; inset-inline-start: 8px; inline-size: 16px; block-size: 16px; }
#unrelated-spinner[data-animating="true"] { animation: synthetic-unrelated-spinner-motion 100ms linear infinite; }
#nested-sticky-surface { position: sticky; top: 20px; margin-block-start: 360px; margin-inline-start: 40px; inline-size: 180px; }
#nested-fixed-action { position: fixed; inset-block-start: 120px; inset-inline-start: 260px; inline-size: 150px; block-size: 60px; }
#nested-document-tail { block-size: 900px; }
`;

const overlayPage = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Synthetic document overlay</title>
<link rel="stylesheet" href="/overlay-fixture.css">
<link rel="stylesheet" href="/dist/review-overlay.css">
<div id="growth"></div>
<button id="unanchorable-action" type="button">Unanchorable prototype action</button>
<button id="prototype-action" type="button" data-collab-review-id="synthetic-action">Synthetic prototype action</button>
<div id="unrelated-spinner" aria-hidden="true"></div>
<div id="nested-anchor" data-collab-review-id="synthetic-nested-anchor"><button type="button">Nested prototype control</button></div>
<div id="layout-row"><img id="delayed-layout-sibling" alt=""><div id="layout-sibling"></div><button type="button" data-collab-review-id="synthetic-layout-target">Layout motion target</button></div>
<div id="ancestor-transform-parent"><button id="ancestor-transform-target" type="button" data-collab-review-id="synthetic-ancestor-transform-target">Ancestor transform target<span id="nested-3d-reference" aria-hidden="true"></span></button></div>
<script type="module">
  import { ReviewDocumentOverlay } from "/dist/browser.js";

  const prototypeAction = document.querySelector("#prototype-action");
  const submissions = [];
  const replacementRequests = [];
  const openedThreads = [];
  const attachmentChanges = [];
  const unavailableAnchors = [];
  const placementDiagnostics = [];
  const crossRealmOverlays = [];
  let unavailableFailuresRemaining = 0;
  let attachmentFailuresRemaining = 0;
  let reenterAttachmentFailureWithDocumentPlacement = false;
  const initialBody = document.body;
  const resizeObserverOperations = [];
  let instrumentedResizeObserver;
  let instrumentedResizeCallback;
  const parameters = new URLSearchParams(location.search);
  if (parameters.get("disableLayoutShiftObserver") === "true") {
    Object.defineProperty(window, "PerformanceObserver", { configurable: true, value: undefined });
  }
  if (parameters.get("disablePointerEvents") === "true") {
    Object.defineProperty(window, "PointerEvent", { configurable: true, value: undefined });
  }
  if (parameters.get("instrumentResizeObserver") === "true") {
    Object.defineProperty(window, "ResizeObserver", {
      configurable: true,
      value: class {
        constructor(callback) {
          instrumentedResizeObserver = this;
          instrumentedResizeCallback = callback;
        }
        observe(target) { resizeObserverOperations.push({ type: "observe", target }); }
        unobserve(target) { resizeObserverOperations.push({ type: "unobserve", target }); }
        disconnect() { resizeObserverOperations.push({ type: "disconnect" }); }
      },
    });
  }
  if (parameters.get("delayedLayoutShift") === "true") {
    document.querySelector("#delayed-layout-sibling").src = "/controlled-layout";
  }
  let preexistingLayoutAnimation;
  if (parameters.get("preexistingLayoutMotion") === "true") {
    document.querySelector("#layout-row").dataset.preexisting = "true";
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    [preexistingLayoutAnimation] = document.querySelector("#layout-sibling").getAnimations();
    if (preexistingLayoutAnimation) {
      preexistingLayoutAnimation.currentTime = 250;
      preexistingLayoutAnimation.pause();
    }
  }
  const context = {
    reviewId: parameters.get("reviewId") ?? "review-synthetic",
    prototypeId: "prototype-synthetic",
    revisionId: "revision-synthetic",
    viewportId: "desktop",
    variantId: "default",
    route: parameters.get("route") ?? "/overlay",
    deviceId: "desktop-chromium",
    surfaceId: "top-document",
  };
  let prototypeClicks = 0;
  let unanchorableClicks = 0;
  let prototypePointerDowns = 0;
  let prototypeMouseDowns = 0;
  let prototypeTouchStarts = 0;
  let prototypeKeyDowns = 0;
  prototypeAction.addEventListener("click", () => { prototypeClicks += 1; });
  prototypeAction.addEventListener("pointerdown", () => { prototypePointerDowns += 1; });
  prototypeAction.addEventListener("mousedown", () => { prototypeMouseDowns += 1; });
  prototypeAction.addEventListener("touchstart", () => { prototypeTouchStarts += 1; });
  prototypeAction.addEventListener("keydown", () => { prototypeKeyDowns += 1; });
  document.querySelector("#unanchorable-action").addEventListener("click", () => { unanchorableClicks += 1; });
  preexistingLayoutAnimation?.play();
  const overlay = new ReviewDocumentOverlay({
    document,
    context,
    trustDocumentForDrafts: true,
    onSubmit: (submission) => submissions.push(submission),
    onReplaceAnchor: (request) => replacementRequests.push(request),
    onOpenThread: (threadId, attachment) => openedThreads.push({ threadId, attachment }),
    onThreadAttachmentChange: (threadId, attachment) => {
      attachmentChanges.push({ threadId, attachment });
      if (attachmentFailuresRemaining > 0) {
        attachmentFailuresRemaining -= 1;
        if (reenterAttachmentFailureWithDocumentPlacement) {
          reenterAttachmentFailureWithDocumentPlacement = false;
          prototypeAction.style.position = "";
          prototypeAction.style.left = "";
          prototypeAction.style.top = "";
          overlay.refresh();
        }
        throw new Error("synthetic attachment callback failure");
      }
    },
    onAnchorUnavailable: (report) => {
      if (unavailableFailuresRemaining > 0) {
        unavailableFailuresRemaining -= 1;
        throw new Error("synthetic unavailable callback failure");
      }
      unavailableAnchors.push(report);
    },
    onPlacementDiagnostic: (diagnostic) => placementDiagnostics.push(diagnostic),
  });
  overlay.mount();

  globalThis.overlayHarness = {
    submissions,
    replacementRequests,
    openedThreads,
    attachmentChanges,
    unavailableAnchors,
    placementDiagnostics,
    context,
    prototypeClicks: () => prototypeClicks,
    unanchorableClicks: () => unanchorableClicks,
    prototypePressCounts: () => ({ pointerdown: prototypePointerDowns, mousedown: prototypeMouseDowns }),
    prototypeTouchStarts: () => prototypeTouchStarts,
    prototypeKeyDowns: () => prototypeKeyDowns,
    snapshot: () => overlay.snapshot(),
    setMode: (mode) => overlay.setInteractionMode(mode),
    setThreads: (threads) => overlay.setThreads(threads),
    beginAnchorReplacement: (threadId) => overlay.beginAnchorReplacement(threadId),
    refresh: () => overlay.refresh(),
    growAbove: () => { document.querySelector("#growth").dataset.grown = "true"; },
    moveTargetToEdge: () => { prototypeAction.style.margin = "0"; },
    animateTarget: () => { prototypeAction.dataset.animating = "true"; },
    animateTargetBeforeComposer: async () => {
      prototypeAction.dataset.precomposerAnimating = "true";
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const [animation] = prototypeAction.getAnimations();
      if (animation) animation.currentTime = 250;
    },
    animateTargetCosmetically: () => { prototypeAction.dataset.cosmeticAnimation = "true"; },
    animateUnrelatedSpinner: () => { document.querySelector("#unrelated-spinner").dataset.animating = "true"; },
    moveLayoutSibling: () => { document.querySelector("#layout-row").dataset.moving = "true"; },
    setTargetZoom: (zoom) => { prototypeAction.style.zoom = zoom; },
    setAncestorZoom: (zoom) => { document.querySelector("#ancestor-transform-parent").style.zoom = zoom; },
    tryInvalidCallback: (name) => {
      try {
        new ReviewDocumentOverlay({
          document,
          context,
          trustDocumentForDrafts: true,
          onSubmit: () => undefined,
          [name]: true,
        });
        return { name, accepted: true };
      } catch (error) {
        return { name, accepted: false, errorName: error?.name, code: error?.code };
      }
    },
    createCrossRealmModalOverlay: async () => {
      const frame = document.createElement("iframe");
      frame.srcdoc = '<!doctype html><link rel="stylesheet" href="/dist/review-overlay.css"><body></body>';
      document.body.appendChild(frame);
      await new Promise((resolve) => frame.addEventListener("load", resolve, { once: true }));
      const foreignDocument = frame.contentDocument;
      if (!foreignDocument?.body) throw new Error("missing synthetic iframe document");
      const first = foreignDocument.createElement("dialog");
      first.id = "foreign-first-modal";
      const firstAction = foreignDocument.createElement("button");
      firstAction.type = "button";
      firstAction.textContent = "Foreign top modal action";
      first.appendChild(firstAction);
      const second = foreignDocument.createElement("dialog");
      second.id = "foreign-second-modal";
      const secondAction = foreignDocument.createElement("button");
      secondAction.type = "button";
      secondAction.textContent = "Foreign lower modal action";
      second.appendChild(secondAction);
      foreignDocument.body.append(first, second);
      second.showModal();
      first.showModal();
      const foreignOverlay = new ReviewDocumentOverlay({
        document: foreignDocument,
        context: {
          reviewId: "review-foreign-document",
          prototypeId: "prototype-foreign-document",
          revisionId: "revision-foreign-document",
          viewportId: "desktop",
          variantId: "default",
          route: "/foreign-document",
          deviceId: "desktop-chromium",
          surfaceId: "same-origin-iframe",
        },
        onDraftEvent: () => undefined,
      });
      foreignOverlay.mount();
      crossRealmOverlays.push(foreignOverlay);
      const root = foreignDocument.querySelector("[data-collab-review-layer='overlay']");
      return {
        activeElement: foreignDocument.activeElement?.textContent,
        rootParent: root?.parentElement?.id,
        rootOpen: root?.matches(":popover-open"),
      };
    },
    transformBody: () => {
      document.body.style.transform = "translate(100px, 50px)";
      document.body.style.transformOrigin = "0 0";
    },
    temporarilyDetachTarget: async () => {
      const parent = prototypeAction.parentNode;
      const nextSibling = prototypeAction.nextSibling;
      prototypeAction.remove();
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const pinWasHidden = !document.querySelector(".crl-overlay__pin");
      parent.insertBefore(prototypeAction, nextSibling);
      return pinWasHidden;
    },
    removeTarget: () => prototypeAction.remove(),
    failNextUnavailable: () => { unavailableFailuresRemaining += 1; },
    failNextAttachmentChange: () => { attachmentFailuresRemaining += 1; },
    failNextAttachmentChangeWithDocumentReentry: () => {
      attachmentFailuresRemaining += 1;
      reenterAttachmentFailureWithDocumentPlacement = true;
    },
    resizeObserverOperations: () => resizeObserverOperations.map(({ type, target }) => ({
      type,
      target: target === document.documentElement
        ? "document-element"
        : target === initialBody
          ? "initial-body"
          : target === document.body
            ? "current-body"
            : target?.id || target?.tagName || "observer",
    })),
    flushResizeObserver: () => instrumentedResizeCallback?.([], instrumentedResizeObserver),
    destroy: () => overlay.destroy(),
  };
</script>
</html>`;

const coordinateOverlayStyles = `
html, body { margin: 0; min-width: 320px; min-height: 100%; }
#coordinate-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) clamp(7.5rem, 20vw, 15rem);
  gap: 16px;
  min-height: 2200px;
  transition: grid-template-columns 500ms linear;
}
#coordinate-main { min-width: 0; }
#normal-scroll-target {
  display: block;
  width: 160px;
  height: 80px;
  margin-block-start: 520px;
  margin-inline: auto 40px;
}
#sticky-surface {
  position: sticky;
  top: 80px;
  align-self: start;
  height: 180px;
  margin-block-start: 520px;
  background: #eef2f6;
}
#sticky-scroll-target { width: 120px; height: 64px; margin: 20px; }
#fixed-scroll-target { position: fixed; inset-block-start: 160px; inset-inline-end: 16px; width: 120px; height: 64px; }
#overflow-scroll-surface {
  position: absolute;
  inset-block-start: 160px;
  inset-inline-start: 16px;
  inline-size: 240px;
  block-size: 180px;
  overflow: auto;
  border: 1px solid #aab5c0;
}
#overflow-scroll-content { min-block-size: 720px; padding-block-start: 360px; }
#overflow-scroll-target { display: block; inline-size: 140px; block-size: 64px; margin-inline: auto; }
#hidden-clip-surface {
  position: absolute;
  inset-block-start: 520px;
  inset-inline-start: 16px;
  inline-size: 220px;
  block-size: 100px;
  overflow: hidden;
}
#hidden-clip-target { position: absolute; inset-block-start: 140px; inline-size: 140px; block-size: 64px; }
#hidden-clip-surface[data-revealed="true"] #hidden-clip-target { inset-block-start: 20px; }
#nested-clip-outer {
  position: absolute;
  inset-block-start: 660px;
  inset-inline-start: 16px;
  inline-size: 220px;
  block-size: 100px;
  overflow: hidden;
}
#nested-clip-inner { position: relative; inline-size: 200px; block-size: 180px; overflow: hidden; }
#nested-clip-target { position: absolute; inset-block-start: 120px; inline-size: 140px; block-size: 64px; }
#nested-clip-outer[data-revealed="true"] #nested-clip-target { inset-block-start: 20px; }
#transformed-fixed-container {
  position: absolute;
  inset-block-start: 360px;
  inset-inline-start: 16px;
  inline-size: 220px;
  block-size: 120px;
  transform: translateZ(0);
}
#transformed-fixed-target {
  position: fixed;
  inset-block-start: 24px;
  inset-inline-start: 32px;
  inline-size: 140px;
  block-size: 64px;
}
#one-axis-sticky-target {
  position: sticky;
  inset-inline-start: 16px;
  display: block;
  inline-size: 140px;
  block-size: 64px;
  margin-block-start: 60px;
}
#coordinate-layout[data-sidebar="closed"] { grid-template-columns: minmax(0, 1fr) 0; gap: 0; }
`;

const coordinateOverlayPage = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Synthetic coordinate-space overlay</title>
<link rel="stylesheet" href="/coordinate-overlay.css">
<link rel="stylesheet" href="/dist/review-overlay.css">
<div id="coordinate-layout" data-sidebar="open">
  <main id="coordinate-main">
    <button id="normal-scroll-target" type="button" data-collab-review-id="normal-scroll-target">Normal scroll target</button>
    <button id="one-axis-sticky-target" type="button" data-collab-review-id="one-axis-sticky-target">One-axis sticky target</button>
  </main>
  <aside id="sticky-surface">
    <button id="sticky-scroll-target" type="button" data-collab-review-id="sticky-scroll-target">Sticky scroll target</button>
  </aside>
</div>
<button id="fixed-scroll-target" type="button" data-collab-review-id="fixed-scroll-target">Fixed scroll target</button>
<div id="overflow-scroll-surface">
  <div id="overflow-scroll-content">
    <button id="overflow-scroll-target" type="button" data-collab-review-id="overflow-scroll-target">Overflow scroll target</button>
  </div>
</div>
<div id="hidden-clip-surface">
  <button id="hidden-clip-target" type="button" data-collab-review-id="hidden-clip-target">Hidden clip target</button>
</div>
<div id="nested-clip-outer">
  <div id="nested-clip-inner">
    <button id="nested-clip-target" type="button" data-collab-review-id="nested-clip-target">Nested clip target</button>
  </div>
</div>
<div id="transformed-fixed-container">
  <button id="transformed-fixed-target" type="button" data-collab-review-id="transformed-fixed-target">Transformed fixed target</button>
</div>
<script type="module">
  import { ReviewDocumentOverlay } from "/dist/browser.js";

  const context = {
    reviewId: "review-coordinate",
    prototypeId: "prototype-coordinate",
    revisionId: "revision-coordinate",
    viewportId: "responsive",
    variantId: "default",
    route: "/coordinate-overlay",
    deviceId: "synthetic-browser",
    surfaceId: "top-document",
  };
  const submissions = [];
  const openedThreads = [];
  const attachmentChanges = [];
  const unavailableAnchors = [];
  const placementDiagnostics = [];
  const overlay = new ReviewDocumentOverlay({
    document,
    context,
    trustDocumentForDrafts: true,
    onSubmit: (submission) => submissions.push(submission),
    onOpenThread: (threadId, attachment) => openedThreads.push({ threadId, attachment }),
    onThreadAttachmentChange: (threadId, attachment) => attachmentChanges.push({ threadId, attachment }),
    onAnchorUnavailable: (report) => unavailableAnchors.push(report),
    onPlacementDiagnostic: (diagnostic) => placementDiagnostics.push(diagnostic),
  });
  overlay.mount();

  globalThis.coordinateOverlayHarness = {
    submissions,
    openedThreads,
    attachmentChanges,
    unavailableAnchors,
    placementDiagnostics,
    context,
    setMode: (mode) => overlay.setInteractionMode(mode),
    setThread: ({ threadId, label, identity, offset, schemaVersion = 2 }) => overlay.setThreads([{
      threadId,
      anchorGeneration: 1,
      label,
      anchor: {
        schemaVersion,
        locationAvailability: "available",
        recoveryState: "not_required",
        context,
        element: {
          selector: '[data-collab-review-id="' + identity + '"]',
          identity,
          offset,
        },
        document: { x: 1, y: 1, width: 1280, height: 2200 },
      },
    }]),
    setSidebar: (state) => { document.querySelector("#coordinate-layout").dataset.sidebar = state; },
    revealHiddenClip: () => { document.querySelector("#hidden-clip-surface").dataset.revealed = "true"; },
    revealNestedClip: () => { document.querySelector("#nested-clip-outer").dataset.revealed = "true"; },
    refresh: () => overlay.refresh(),
  };
</script>
</html>`;

const nestedOverlayHostStyles = `
html, body { margin: 0; min-height: 100%; }
#nested-frame-root { width: 100%; height: 100vh; transition: margin-inline-start 400ms linear, width 400ms linear; }
body[data-sidebar="open"] #nested-frame-root { width: calc(100% - 160px); margin-inline-start: 160px; }
iframe { display: block; width: 100%; height: 100%; border: 0; }
`;

const overlayWithoutStylesPage = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<title>Synthetic overlay without owned styles</title>
<script type="module">
  import { ReviewDocumentOverlay } from "/dist/browser.js";

  try {
    const overlay = new ReviewDocumentOverlay({
      document,
      context: {
        reviewId: "review-synthetic",
        prototypeId: "prototype-synthetic",
        revisionId: "revision-synthetic",
        viewportId: "desktop",
        variantId: "default",
        route: "/missing-overlay-styles",
        deviceId: "desktop-chromium",
        surfaceId: "top-document",
      },
      trustDocumentForDrafts: true,
      onSubmit: () => undefined,
    });
    overlay.mount();
    globalThis.overlayWithoutStylesResult = { mounted: true };
  } catch (error) {
    globalThis.overlayWithoutStylesResult = { name: error.name, code: error.code, message: error.message };
  }
</script>
</html>`;

const overlayObserverFailurePage = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<title>Synthetic overlay observer failure</title>
<link rel="stylesheet" href="/dist/review-overlay.css">
<script type="module">
  import { ReviewDocumentOverlay } from "/dist/browser.js";

  Object.defineProperty(window, "ResizeObserver", {
    configurable: true,
    value: class {
      constructor() { throw new Error("synthetic ResizeObserver failure"); }
    },
  });
  try {
    const overlay = new ReviewDocumentOverlay({
      document,
      context: {
        reviewId: "review-synthetic",
        prototypeId: "prototype-synthetic",
        revisionId: "revision-synthetic",
        viewportId: "desktop",
        variantId: "default",
        route: "/observer-failure",
        deviceId: "desktop-chromium",
        surfaceId: "top-document",
      },
      trustDocumentForDrafts: true,
      onSubmit: () => undefined,
    });
    overlay.mount();
    globalThis.overlayObserverFailureResult = { mounted: true };
  } catch (error) {
    globalThis.overlayObserverFailureResult = { name: error.name, code: error.code, message: error.message };
  }
</script>
</html>`;

const nestedOverlayHostPage = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Synthetic nested overlay host</title>
<link rel="stylesheet" href="/nested-overlay-host.css">
<link id="nested-frame-host-styles" rel="stylesheet" href="/dist/review-frame-host.css">
<div id="nested-frame-clip"><div id="nested-frame-root"></div></div>
<dialog id="nested-frame-modal" aria-label="Synthetic review modal"></dialog>
<script type="module">
  import { ReviewFrameHost } from "/dist/browser.js";

  const hostParameters = new URLSearchParams(location.search);
  if (hostParameters.get("withoutDraftStyles") === "true") {
    document.querySelector("#nested-frame-host-styles")?.remove();
  }
  if (hostParameters.get("modal") === "true") {
    const modal = document.querySelector("#nested-frame-modal");
    modal.append(document.querySelector("#nested-frame-root"));
    modal.showModal();
  }

  const events = [];
  const draftRequests = [];
  const draftSubmissions = [];
  const host = new ReviewFrameHost({
    container: document.querySelector("#nested-frame-root"),
    onDraftSubmit: (submission) => draftSubmissions.push(submission),
    onEvent: (event) => {
      events.push(event);
      if (event.type !== "message" || event.message.type !== "draft") return;
      draftRequests.push(event.message);
    },
  });
  host.open({
    source: "${prototypeOrigin}/nested-prototype.html#sessionId=nested-overlay-session&nonce=0123456789abcdef0123456789abcdef&hostOrigin=${encodeURIComponent(hostOrigin)}",
    title: "Synthetic nested prototype",
    peerOrigin: "${prototypeOrigin}",
    sessionId: "nested-overlay-session",
    nonce: "0123456789abcdef0123456789abcdef",
    capabilities: ["anchor", "draft"],
  });
  globalThis.nestedHostHarness = {
    events,
    draftRequests,
    draftSubmissions,
    snapshot: () => host.snapshot(),
    send: (message) => host.send(message),
    setSidebar: (state) => { document.body.dataset.sidebar = state; },
    styleFrame: (transform = "scale(0.75)") => {
      const frame = document.querySelector("iframe");
      frame.style.boxSizing = "content-box";
      frame.style.border = "10px solid rgb(15 23 42)";
      frame.style.transform = transform;
      frame.style.transformOrigin = "0 0";
    },
    obscureFrame: (kind) => {
      const frame = document.querySelector("iframe");
      const clip = document.querySelector("#nested-frame-clip");
      if (kind === "frame-visibility") frame.style.visibility = "hidden";
      if (kind === "ancestor-opacity") clip.style.opacity = "0";
      if (kind === "ancestor-clip") {
        clip.style.width = "40px";
        clip.style.height = "40px";
        clip.style.overflow = "hidden";
        document.querySelector("#nested-frame-root").style.width = "100vw";
      }
    },
    transformComposerHost: (transform) => {
      const modal = document.querySelector("#nested-frame-modal");
      const composerHost = modal.matches(":modal") ? modal : document.body;
      composerHost.style.transform = transform;
      composerHost.style.transformOrigin = "0 0";
    },
  };
</script>
</html>`;

const nestedOverlayPrototypePage = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Synthetic nested prototype document</title>
<link rel="stylesheet" href="/overlay-fixture.css">
<link rel="stylesheet" href="/dist/review-overlay.css">
<button id="prototype-action" type="button" data-collab-review-id="nested-action"><span id="nested-action-content">Nested prototype action</span></button>
<div id="nested-sticky-surface"><button type="button" data-collab-review-id="nested-sticky-action">Nested sticky action</button></div>
<button id="nested-fixed-action" type="button" data-collab-review-id="nested-fixed-action">Nested fixed action</button>
<div id="nested-document-tail" aria-hidden="true"></div>
<script type="module">
  import { BrowserBridgeAdapter, ReviewDocumentOverlay } from "/dist/browser.js";

  const prototypeAction = document.querySelector("#prototype-action");
  let prototypeClicks = 0;
  prototypeAction.addEventListener("click", () => { prototypeClicks += 1; });
  const context = {
    reviewId: "review-synthetic",
    prototypeId: "prototype-synthetic",
    revisionId: "revision-synthetic",
    viewportId: "desktop",
    variantId: "default",
    route: "/nested",
    deviceId: "desktop-chromium",
    surfaceId: "nested-cooperative-document",
  };
  let unsafeDraftResult;
  try {
    new ReviewDocumentOverlay({
      document,
      context,
      trustDocumentForDrafts: true,
      onSubmit: () => undefined,
    });
    unsafeDraftResult = { accepted: true };
  } catch (error) {
    unsafeDraftResult = { accepted: false, name: error?.name, code: error?.code };
  }
  let bridge;
  let draftEventFailuresRemaining = 0;
  let reenterDraftEventAction;
  const draftEventAttempts = [];
  const onDraftEvent = (event) => {
      draftEventAttempts.push(event);
      if (reenterDraftEventAction === event.action) {
        overlay.refresh();
        reenterDraftEventAction = undefined;
      }
      if (draftEventFailuresRemaining > 0) {
        draftEventFailuresRemaining -= 1;
        throw new Error("synthetic draft event failure");
      }
      if (event.action === "open") {
        bridge.send({ type: "draft", mode: "request", ...event });
        return;
      }
      bridge.send({ type: "draft", mode: "report", ...event });
    };
  const createOverlay = () => new ReviewDocumentOverlay({ document, context, onDraftEvent });
  let overlay = createOverlay();
  overlay.mount();
  const parameters = new URLSearchParams(location.hash.slice(1));
  bridge = new BrowserBridgeAdapter({
    role: "prototype",
    sessionId: parameters.get("sessionId"),
    nonce: parameters.get("nonce"),
    peerOrigin: parameters.get("hostOrigin"),
    capabilities: ["anchor", "draft"],
    eventSource: window,
    peerWindow: parent,
    onEvent: (event) => {
      if (event.type === "message" && event.message.type === "draft" && event.message.action === "dismiss") {
        overlay.dismissDraftRequest(event.message.requestId);
        return;
      }
      if (event.type !== "message" || event.message.type !== "anchor" || event.message.mode !== "request") return;
      overlay.setThreads([{
        threadId: event.message.threadId,
        anchorGeneration: event.message.anchorGeneration,
        anchor: event.message.anchor,
        label: "Bridged nested thread",
      }]);
    },
  });
  bridge.start();

  globalThis.nestedOverlayHarness = {
    unsafeDraftResult,
    prototypeClicks: () => prototypeClicks,
    setMode: (mode) => overlay.setInteractionMode(mode),
    scrollTo: (top) => window.scrollTo({ top }),
    removeTarget: (identity) => document.querySelector('[data-collab-review-id="' + identity + '"]')?.remove(),
    retryUnavailableAfterFailure: () => {
      draftEventFailuresRemaining = 1;
      document.querySelector('[data-collab-review-id="nested-action"]')?.remove();
      let firstError;
      try { overlay.refresh(); } catch (error) { firstError = error?.message; }
      overlay.refresh();
      return { firstError, attempts: draftEventAttempts.filter((event) => event.action === "update") };
    },
    retryDestroyAfterFailure: () => {
      draftEventFailuresRemaining = 1;
      let firstError;
      try { overlay.destroy(); } catch (error) { firstError = error?.message; }
      const afterFailure = overlay.snapshot();
      overlay.destroy();
      return { firstError, afterFailure, afterRetry: overlay.snapshot(), attempts: draftEventAttempts.filter((event) => event.action === "dismiss") };
    },
    reenterUnavailableUpdate: () => {
      reenterDraftEventAction = "update";
      document.querySelector('[data-collab-review-id="nested-action"]')?.remove();
      overlay.refresh();
      return draftEventAttempts.filter((event) => event.action === "update").length;
    },
    reenterDismissal: () => {
      reenterDraftEventAction = "dismiss";
      overlay.destroy();
      return { state: overlay.snapshot().state, attempts: draftEventAttempts.filter((event) => event.action === "dismiss").length };
    },
    recreate: () => {
      overlay.destroy();
      overlay = createOverlay();
      overlay.mount();
      overlay.setInteractionMode("comment");
    },
  };
</script>
</html>`;

const prototypePage = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<title>Synthetic prototype</title>
<button type="button">Synthetic action</button>
<script type="module">
  import { BrowserBridgeAdapter } from "/dist/browser.js";

  const parameters = new URLSearchParams(location.hash.slice(1));
  const events = [];
  const messages = [];
  const adapter = new BrowserBridgeAdapter({
    role: "prototype",
    sessionId: parameters.get("sessionId"),
    nonce: parameters.get("nonce"),
    peerOrigin: parameters.get("hostOrigin"),
    capabilities: ["navigation", "viewport", "variant"],
    eventSource: window,
    peerWindow: parent,
    onEvent: (event) => {
      events.push(event.type === "error"
        ? { type: event.type, error: { name: event.error.name, code: event.error.code, message: event.error.message }, snapshot: event.snapshot }
        : { type: event.type, snapshot: event.snapshot });
      if (event.type === "message") messages.push(event.message);
    },
  });
  adapter.start();

  globalThis.prototypeHarness = {
    events,
    messages,
    snapshot: () => adapter.snapshot(),
    send: (message) => adapter.send(message),
    sendRaw: (message) => parent.postMessage(message, parameters.get("hostOrigin")),
    navigate: (source) => { location.href = source; },
    referrer: document.referrer,
  };
</script>
</html>`;

const relayPage = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<title>Synthetic relay</title>
<script>
  const parameters = new URLSearchParams(location.search);
  const payload = JSON.parse(parameters.get("payload"));
  parent.postMessage(payload, parameters.get("hostOrigin"));
</script>
</html>`;

const attackerPage = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<title>Synthetic attacker</title>
<img alt="" src="/slow">
<script>
  const parameters = new URLSearchParams(location.search);
  const received = [];
  addEventListener("message", (event) => received.push(event.data));
  parent.postMessage({ kind: "attacker-ready" }, parameters.get("hostOrigin"));
  setTimeout(() => {
    parent.postMessage({ kind: "attacker-report", received: received.length }, parameters.get("hostOrigin"));
  }, 50);
  setTimeout(() => {
    parent.postMessage(JSON.parse(parameters.get("payload")), parameters.get("hostOrigin"));
  }, 100);
</script>
</html>`;

function contentSecurityPolicy(port) {
  if (port === 4173) return `default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self'; img-src 'self'; frame-src ${hostOrigin} ${prototypeOrigin} ${attackerOrigin}`;
  return `default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self'; img-src 'self'`;
}

function respond(response, status, type, body, port) {
  response.writeHead(status, {
    "content-type": type,
    "cache-control": "no-store",
    "content-security-policy": contentSecurityPolicy(port),
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

const controlledLayoutResponses = [];

function handler(port) {
  return async (request, response) => {
    const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
    if (url.pathname === "/health") return respond(response, 200, "text/plain", "ok", port);
    if (url.pathname === "/slow") {
      setTimeout(() => respond(response, 200, "image/svg+xml", '<svg xmlns="http://www.w3.org/2000/svg"/>', port), 500);
      return;
    }
    if (url.pathname === "/controlled-layout") {
      controlledLayoutResponses.push(() => respond(response, 200, "image/svg+xml", '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="40"/>', port));
      return;
    }
    if (url.pathname === "/release-layout") {
      for (const release of controlledLayoutResponses.splice(0)) release();
      return respond(response, 200, "text/plain", "released", port);
    }
    if (port === 4174 && url.pathname === "/redirect-to-host") {
      response.writeHead(302, { location: `${hostOrigin}/redirected.html`, "cache-control": "no-store" });
      return response.end();
    }
    if (/^\/dist\/[a-z0-9-]+\.js$/u.test(url.pathname)) {
      try {
        const body = await readFile(join(repositoryRoot, url.pathname.slice(1)), "utf8");
        return respond(response, 200, "text/javascript", body, port);
      } catch {
        return respond(response, 404, "text/plain", "not found", port);
      }
    }
    if (port === 4173 && url.pathname === "/dist/review-shell.css") {
      try {
        const body = await readFile(join(repositoryRoot, "dist", "review-shell.css"), "utf8");
        return respond(response, 200, "text/css", body, port);
      } catch {
        return respond(response, 404, "text/plain", "not found", port);
      }
    }
    if ((port === 4173 || port === 4174) && url.pathname === "/dist/review-overlay.css") {
      try {
        const body = await readFile(join(repositoryRoot, "dist", "review-overlay.css"), "utf8");
        return respond(response, 200, "text/css", body, port);
      } catch {
        return respond(response, 404, "text/plain", "not found", port);
      }
    }
    if (port === 4173 && url.pathname === "/dist/review-frame-host.css") {
      try {
        const body = await readFile(join(repositoryRoot, "dist", "review-frame-host.css"), "utf8");
        return respond(response, 200, "text/css", body, port);
      } catch {
        return respond(response, 404, "text/plain", "not found", port);
      }
    }
    if ((port === 4173 || port === 4174) && url.pathname === "/overlay-fixture.css") return respond(response, 200, "text/css", overlayFixtureStyles, port);
    if (port === 4173 && url.pathname === "/coordinate-overlay.css") return respond(response, 200, "text/css", coordinateOverlayStyles, port);
    if (port === 4173 && url.pathname === "/nested-overlay-host.css") return respond(response, 200, "text/css", nestedOverlayHostStyles, port);
    if (port === 4173 && url.pathname === "/host.html") return respond(response, 200, "text/html", hostPage, port);
    if (port === 4173 && url.pathname === "/shell.html") return respond(response, 200, "text/html", shellPage, port);
    if (port === 4173 && url.pathname === "/overlay.html") return respond(response, 200, "text/html", overlayPage, port);
    if (port === 4173 && url.pathname === "/coordinate-overlay.html") return respond(response, 200, "text/html", coordinateOverlayPage, port);
    if (port === 4173 && url.pathname === "/overlay-without-styles.html") return respond(response, 200, "text/html", overlayWithoutStylesPage, port);
    if (port === 4173 && url.pathname === "/overlay-observer-failure.html") return respond(response, 200, "text/html", overlayObserverFailurePage, port);
    if (port === 4173 && url.pathname === "/nested-overlay.html") return respond(response, 200, "text/html", nestedOverlayHostPage, port);
    if (port === 4173 && url.pathname === "/redirected.html") return respond(response, 200, "text/html", "<!doctype html><title>Redirected host document</title>", port);
    if (port === 4174 && url.pathname === "/prototype.html") return respond(response, 200, "text/html", prototypePage, port);
    if (port === 4174 && url.pathname === "/nested-prototype.html") return respond(response, 200, "text/html", nestedOverlayPrototypePage, port);
    if (port === 4174 && url.pathname === "/relay.html") return respond(response, 200, "text/html", relayPage, port);
    if (port === 4175 && url.pathname === "/attacker.html") return respond(response, 200, "text/html", attackerPage, port);
    return respond(response, 404, "text/plain", "not found", port);
  };
}

const servers = [4173, 4174, 4175].map((port) => createServer(handler(port)).listen(port, "127.0.0.1"));
const close = () => Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
process.once("SIGTERM", () => void close().finally(() => process.exit(0)));
process.once("SIGINT", () => void close().finally(() => process.exit(0)));
