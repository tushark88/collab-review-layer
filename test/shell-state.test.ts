import test from "node:test";
import assert from "node:assert/strict";
import {
  ReviewShellController,
  ReviewShellStateError,
  type ReviewShellConfig,
} from "../src/shell-state.ts";
import { BridgeProtocolError, BridgeSession, type BridgeOperationalMessage } from "../src/bridge.ts";

const HOST_ORIGIN = "https://reviews.example.test";
const PROTOTYPE_ORIGIN = "https://prototype.example.test";
const SESSION_ID = "shell-contract-session";
const NONCE = "0123456789abcdef0123456789abcdef";

function config(): ReviewShellConfig {
  return {
    initialPrototypeId: "prototype-alpha",
    initialViewportId: "desktop",
    prototypes: [
      {
        id: "prototype-alpha",
        label: "Prototype Alpha",
        initialRevisionId: "revision-a1",
        revisions: [
          {
            id: "revision-a1",
            label: "Revision A1",
            initialVariantId: "control",
            initialRoute: "/synthetic/overview",
            variants: [
              { id: "control", label: "Control" },
              { id: "alternate", label: "Alternate" },
            ],
          },
          {
            id: "revision-a2",
            label: "Revision A2",
            initialVariantId: "updated",
            initialRoute: "/synthetic/updated",
            variants: [{ id: "updated", label: "Updated" }],
          },
        ],
      },
      {
        id: "prototype-beta",
        label: "Prototype Beta",
        initialRevisionId: "revision-b1",
        revisions: [{
          id: "revision-b1",
          label: "Revision B1",
          initialVariantId: "default",
          initialRoute: "/synthetic/beta",
          variants: [{ id: "default", label: "Default" }],
        }],
      },
    ],
    viewports: [
      { id: "desktop", label: "Desktop", presentation: "desktop", width: 1_440, height: 900, devicePixelRatio: 2 },
      { id: "mobile", label: "Mobile", presentation: "mobile", width: 390, height: 844, devicePixelRatio: 3 },
      { id: "custom", label: "Custom", presentation: "custom", width: 1_024, height: 768, devicePixelRatio: 1 },
    ],
  };
}

function expectShellError(code: ReviewShellStateError["code"], action: () => unknown): void {
  assert.throws(action, (error: unknown) => error instanceof ReviewShellStateError && error.code === code);
}

function connectedBridge(): { host: BridgeSession; prototype: BridgeSession } {
  const capabilities = ["navigation", "variant", "viewport"] as const;
  const host = new BridgeSession({ role: "host", sessionId: SESSION_ID, nonce: NONCE, allowedOrigins: [PROTOTYPE_ORIGIN], capabilities });
  const prototype = new BridgeSession({ role: "prototype", sessionId: SESSION_ID, nonce: NONCE, allowedOrigins: [HOST_ORIGIN], capabilities });
  const accepted = prototype.receive(HOST_ORIGIN, host.initiate());
  assert.equal(accepted.kind, "handshake");
  assert.ok(accepted.reply);
  host.receive(PROTOTYPE_ORIGIN, accepted.reply);
  return { host, prototype };
}

test("shell state exposes deterministic initial selection and bridge requests", () => {
  const shell = new ReviewShellController(config());
  const snapshot = shell.snapshot();
  assert.equal(snapshot.interactionMode, "pointer");
  assert.equal(snapshot.prototypeId, "prototype-alpha");
  assert.equal(snapshot.revisionId, "revision-a1");
  assert.equal(snapshot.variantId, "control");
  assert.equal(snapshot.route, "/synthetic/overview");
  assert.deepEqual(snapshot.viewport, {
    id: "desktop",
    label: "Desktop",
    presentation: "desktop",
    width: 1_440,
    height: 900,
    devicePixelRatio: 2,
  });
  assert.deepEqual(shell.bridgeRequests(), {
    navigation: { type: "navigation", mode: "request", route: "/synthetic/overview" },
    variant: { type: "variant", mode: "request", variantId: "control" },
    viewport: { type: "viewport", mode: "request", viewportId: "desktop", width: 1_440, height: 900, devicePixelRatio: 2 },
  });
});

test("shell transitions reset only revision-owned selection", () => {
  const shell = new ReviewShellController(config());
  shell.setInteractionMode("comment");
  shell.selectViewport("mobile");
  shell.selectVariant("alternate");
  shell.navigate("/synthetic/detail?step=2#focus");
  let snapshot = shell.snapshot();
  assert.equal(snapshot.variantId, "alternate");
  assert.equal(snapshot.route, "/synthetic/detail?step=2#focus");

  snapshot = shell.selectRevision("revision-a2");
  assert.equal(snapshot.revisionId, "revision-a2");
  assert.equal(snapshot.variantId, "updated");
  assert.equal(snapshot.route, "/synthetic/updated");
  assert.equal(snapshot.interactionMode, "comment");
  assert.equal(snapshot.viewport.id, "mobile");

  snapshot = shell.selectPrototype("prototype-beta");
  assert.equal(snapshot.prototypeId, "prototype-beta");
  assert.equal(snapshot.revisionId, "revision-b1");
  assert.equal(snapshot.variantId, "default");
  assert.equal(snapshot.route, "/synthetic/beta");
  assert.equal(snapshot.interactionMode, "comment");
  assert.equal(snapshot.viewport.id, "mobile");
});

test("custom viewport changes preserve identity and feed bridge requests", () => {
  const shell = new ReviewShellController(config());
  const snapshot = shell.setCustomViewport("custom", 820, 1_180, 2.5);
  assert.deepEqual(snapshot.viewport, {
    id: "custom",
    label: "Custom",
    presentation: "custom",
    width: 820,
    height: 1_180,
    devicePixelRatio: 2.5,
  });
  assert.equal(snapshot.viewports.find((viewport) => viewport.id === "custom")?.width, 820);
  assert.deepEqual(shell.bridgeRequests().viewport, {
    type: "viewport",
    mode: "request",
    viewportId: "custom",
    width: 820,
    height: 1_180,
    devicePixelRatio: 2.5,
  });
});

test("invalid shell transitions leave the prior selection intact", () => {
  const shell = new ReviewShellController(config());
  const before = shell.snapshot();
  expectShellError("invalid_selection", () => shell.selectPrototype("missing"));
  expectShellError("invalid_selection", () => shell.selectRevision("revision-b1"));
  expectShellError("invalid_selection", () => shell.selectVariant("missing"));
  expectShellError("invalid_selection", () => shell.selectViewport("missing"));
  expectShellError("invalid_input", () => shell.navigate("https://outside.example.test/path"));
  assert.throws(
    () => shell.navigate(""),
    (error: unknown) => error instanceof ReviewShellStateError
      && error.code === "invalid_input"
      && error.message === "route is invalid",
  );
  expectShellError("invalid_input", () => shell.setInteractionMode("browse" as never));
  expectShellError("invalid_input", () => shell.setCustomViewport("desktop", 800, 600, 1));
  expectShellError("invalid_input", () => shell.setCustomViewport("custom", 0, 600, 1));
  expectShellError("invalid_input", () => shell.setCustomViewport("custom", 800, 600, Number.NaN));
  assert.deepEqual(shell.snapshot(), before);
});

test("shell configuration rejects missing, duplicate, and invalid identities", () => {
  const valid = config();
  const create = (overrides: Partial<ReviewShellConfig>) => () => new ReviewShellController({ ...valid, ...overrides });
  expectShellError("invalid_config", create({ prototypes: [] }));
  expectShellError("invalid_config", create({ viewports: [] }));
  const sparseViewports = new Array<ReviewShellConfig["viewports"][number]>(1);
  expectShellError("invalid_config", create({ viewports: sparseViewports }));
  expectShellError("invalid_config", create({ initialPrototypeId: "missing" }));
  expectShellError("invalid_config", create({ initialViewportId: "missing" }));
  expectShellError("invalid_config", create({ prototypes: [valid.prototypes[0]!, valid.prototypes[0]!] }));
  expectShellError("invalid_config", create({ viewports: [valid.viewports[0]!, valid.viewports[0]!] }));
  expectShellError("invalid_config", create({
    prototypes: [{
      ...valid.prototypes[0]!,
      revisions: [valid.prototypes[0]!.revisions[0]!, valid.prototypes[0]!.revisions[0]!],
    }],
  }));
  expectShellError("invalid_config", create({
    prototypes: [{
      ...valid.prototypes[0]!,
      revisions: [{
        ...valid.prototypes[0]!.revisions[0]!,
        variants: [valid.prototypes[0]!.revisions[0]!.variants[0]!, valid.prototypes[0]!.revisions[0]!.variants[0]!],
      }],
    }],
  }));
  expectShellError("invalid_config", create({
    prototypes: [{ ...valid.prototypes[0]!, revisions: [] }],
  }));
  expectShellError("invalid_config", create({
    prototypes: [{ ...valid.prototypes[0]!, initialRevisionId: "missing" }],
  }));
  expectShellError("invalid_config", create({
    prototypes: [{
      ...valid.prototypes[0]!,
      revisions: [{ ...valid.prototypes[0]!.revisions[0]!, variants: [] }],
    }],
  }));
  expectShellError("invalid_config", create({
    prototypes: [{
      ...valid.prototypes[0]!,
      revisions: [{ ...valid.prototypes[0]!.revisions[0]!, initialVariantId: "missing" }],
    }],
  }));
});

test("shell configuration shares bridge route and viewport bounds", () => {
  const valid = config();
  const withRevision = (revision: ReviewShellConfig["prototypes"][number]["revisions"][number]): ReviewShellConfig => ({
    ...valid,
    prototypes: [{ ...valid.prototypes[0]!, revisions: [revision], initialRevisionId: revision.id }],
  });
  expectShellError("invalid_config", () => new ReviewShellController(withRevision({
    ...valid.prototypes[0]!.revisions[0]!,
    initialRoute: "//outside.example.test/path",
  })));
  expectShellError("invalid_config", () => new ReviewShellController({
    ...valid,
    viewports: [{ ...valid.viewports[0]!, width: 16_385 }],
  }));
  expectShellError("invalid_config", () => new ReviewShellController({
    ...valid,
    viewports: [{ ...valid.viewports[0]!, devicePixelRatio: 0.01 }],
  }));
  expectShellError("invalid_config", () => new ReviewShellController({
    ...valid,
    viewports: [{ ...valid.viewports[0]!, presentation: "watch" as never }],
  }));
  expectShellError("invalid_config", () => new ReviewShellController({
    ...valid,
    initialInteractionMode: "browse" as never,
  }));
});

test("shell bridge requests share the bridge runtime's exact route and viewport constraints", () => {
  const maximumRoute = `/${"r".repeat(2_047)}`;
  const shell = new ReviewShellController(config());
  shell.navigate(maximumRoute);
  shell.setCustomViewport("custom", 16_384, 1, 10);

  const linked = connectedBridge();
  const requests = shell.bridgeRequests();
  for (const message of [requests.navigation, requests.variant, requests.viewport]) {
    const received = linked.prototype.receive(HOST_ORIGIN, linked.host.send(message));
    assert.equal(received.kind, "message");
    assert.deepEqual(received.message, message);
  }

  const minimumViewport = shell.setCustomViewport("custom", 1, 16_384, 0.1).viewport;
  const minimumMessage: BridgeOperationalMessage = {
    type: "viewport",
    mode: "request",
    viewportId: minimumViewport.id,
    width: minimumViewport.width,
    height: minimumViewport.height,
    devicePixelRatio: minimumViewport.devicePixelRatio,
  };
  assert.equal(linked.prototype.receive(HOST_ORIGIN, linked.host.send(minimumMessage)).kind, "message");
  shell.navigate("/");
  const minimumRoute = shell.bridgeRequests().navigation;
  assert.equal(linked.prototype.receive(HOST_ORIGIN, linked.host.send(minimumRoute)).kind, "message");

  const oversizedRoute = `/${"r".repeat(2_048)}`;
  expectShellError("invalid_input", () => shell.navigate(oversizedRoute));
  assert.throws(
    () => linked.host.send({ type: "navigation", mode: "request", route: oversizedRoute }),
    (error: unknown) => error instanceof BridgeProtocolError && error.code === "invalid_message",
  );
  expectShellError("invalid_input", () => shell.setCustomViewport("custom", 16_385, 1, 1));
  assert.throws(
    () => linked.host.send({ type: "viewport", mode: "request", viewportId: "custom", width: 16_385, height: 1, devicePixelRatio: 1 }),
    (error: unknown) => error instanceof BridgeProtocolError && error.code === "invalid_message",
  );
  expectShellError("invalid_input", () => shell.setCustomViewport("custom", 1, 1, 10.1));
  assert.throws(
    () => linked.host.send({ type: "viewport", mode: "request", viewportId: "custom", width: 1, height: 1, devicePixelRatio: 10.1 }),
    (error: unknown) => error instanceof BridgeProtocolError && error.code === "invalid_message",
  );
});

test("shell clones configuration and returns deeply immutable snapshots", () => {
  const mutable = config();
  const shell = new ReviewShellController(mutable);
  (mutable.prototypes[0] as { label: string }).label = "Changed outside";
  (mutable.viewports[0] as { width: number }).width = 1;
  const snapshot = shell.snapshot();
  assert.equal(snapshot.prototypes[0]?.label, "Prototype Alpha");
  assert.equal(snapshot.viewport.width, 1_440);
  assert.ok(Object.isFrozen(snapshot));
  assert.ok(Object.isFrozen(snapshot.viewport));
  assert.ok(Object.isFrozen(snapshot.prototypes));
  assert.ok(Object.isFrozen(snapshot.prototypes[0]));
  assert.ok(Object.isFrozen(snapshot.viewports));
  assert.ok(Object.isFrozen(shell.bridgeRequests()));
  assert.ok(Object.isFrozen(shell.bridgeRequests().navigation));
  assert.throws(() => (snapshot.prototypes as unknown as Array<{ id: string; label: string }>).push({ id: "x", label: "X" }));
  assert.throws(() => { (snapshot.viewport as { width: number }).width = 1; });
  assert.equal(shell.snapshot().viewport.width, 1_440);
});
