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
    ReviewShellController,
    ReviewShellView,
  } from "/dist/browser.js";

  const root = document.querySelector("#shell-root");
  const preview = document.createElement("div");
  const previewAction = document.createElement("button");
  previewAction.type = "button";
  previewAction.textContent = "Synthetic preview action";
  preview.appendChild(previewAction);
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
    previewDetached: () => preview.parentNode === null,
    shellPresent: () => Boolean(root.querySelector("[data-collab-review-layer='shell']")),
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
  if (port === 4173) return `default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self'; frame-src ${hostOrigin} ${prototypeOrigin} ${attackerOrigin}`;
  return `default-src 'none'; script-src 'self' 'unsafe-inline'; img-src 'self'`;
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

function handler(port) {
  return async (request, response) => {
    const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
    if (url.pathname === "/health") return respond(response, 200, "text/plain", "ok", port);
    if (url.pathname === "/slow") {
      setTimeout(() => respond(response, 200, "image/svg+xml", '<svg xmlns="http://www.w3.org/2000/svg"/>', port), 500);
      return;
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
    if (port === 4173 && url.pathname === "/host.html") return respond(response, 200, "text/html", hostPage, port);
    if (port === 4173 && url.pathname === "/shell.html") return respond(response, 200, "text/html", shellPage, port);
    if (port === 4173 && url.pathname === "/redirected.html") return respond(response, 200, "text/html", "<!doctype html><title>Redirected host document</title>", port);
    if (port === 4174 && url.pathname === "/prototype.html") return respond(response, 200, "text/html", prototypePage, port);
    if (port === 4174 && url.pathname === "/relay.html") return respond(response, 200, "text/html", relayPage, port);
    if (port === 4175 && url.pathname === "/attacker.html") return respond(response, 200, "text/html", attackerPage, port);
    return respond(response, 404, "text/plain", "not found", port);
  };
}

const servers = [4173, 4174, 4175].map((port) => createServer(handler(port)).listen(port, "127.0.0.1"));
const close = () => Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
process.once("SIGTERM", () => void close().finally(() => process.exit(0)));
process.once("SIGINT", () => void close().finally(() => process.exit(0)));
