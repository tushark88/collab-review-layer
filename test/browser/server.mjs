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
    if (host) host.close();
    events.length = 0;
    host = new ReviewFrameHost({
      container,
      sandboxProfile: profile,
      onEvent: (event) => events.push(normalizeEvent(event)),
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
  if (port === 4173) return `default-src 'none'; script-src 'self' 'unsafe-inline'; frame-src ${prototypeOrigin} ${attackerOrigin}`;
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
    if (/^\/dist\/[a-z0-9-]+\.js$/u.test(url.pathname)) {
      try {
        const body = await readFile(join(repositoryRoot, url.pathname.slice(1)), "utf8");
        return respond(response, 200, "text/javascript", body, port);
      } catch {
        return respond(response, 404, "text/plain", "not found", port);
      }
    }
    if (port === 4173 && url.pathname === "/host.html") return respond(response, 200, "text/html", hostPage, port);
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
