import { expect, test, type Frame, type Page } from "@playwright/test";
import { BRIDGE_PROTOCOL } from "../../src/bridge.ts";

const HOST_ORIGIN = "http://127.0.0.1:4173";
const PROTOTYPE_ORIGIN = "http://127.0.0.1:4174";
const ATTACKER_ORIGIN = "http://127.0.0.1:4175";
const NONCE = "0123456789abcdef0123456789abcdef";

interface SessionInput {
  source: string;
  title: string;
  peerOrigin: string;
  sessionId: string;
  nonce: string;
  capabilities: string[];
}

function session(generation: number): SessionInput {
  const sessionId = `browser-session-${generation}`;
  const parameters = new URLSearchParams({ sessionId, nonce: NONCE, hostOrigin: HOST_ORIGIN });
  return {
    source: `${PROTOTYPE_ORIGIN}/prototype.html#${parameters}`,
    title: `Synthetic prototype ${generation}`,
    peerOrigin: PROTOTYPE_ORIGIN,
    sessionId,
    nonce: NONCE,
    capabilities: ["navigation", "viewport", "variant"],
  };
}

function operationalEnvelope(sessionId: string, route: string) {
  return {
    protocol: BRIDGE_PROTOCOL,
    wireVersion: 1,
    sessionId,
    nonce: NONCE,
    sequence: 1,
    message: { type: "navigation", mode: "report", route, protocolVersion: 1 },
  };
}

async function openHost(page: Page, input: SessionInput): Promise<Frame> {
  await page.evaluate((config) => globalThis.hostHarness.open(config), input);
  await expect.poll(() => page.evaluate(() => globalThis.hostHarness.snapshot().state)).toBe("active");
  const frame = page.frames().find((candidate) => candidate.url() === input.source);
  if (!frame) throw new Error("synthetic prototype frame did not mount");
  await expect.poll(() => frame.evaluate(() => globalThis.prototypeHarness?.snapshot().session.state)).toBe("active");
  return frame;
}

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (error) => console.error(`browser page error: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") console.error(`browser console error: ${message.text()}`);
  });
  await page.goto(`${HOST_ORIGIN}/host.html`);
  await expect.poll(() => page.evaluate(() => Boolean(globalThis.hostHarness))).toBe(true);
});

test("applies a least-privilege cross-origin frame policy before handshake", async ({ page }) => {
  await expect(page.evaluate(() => globalThis.hostHarness.reset("unsafe"))).rejects.toThrow(/sandbox profile/u);
  await page.evaluate(() => globalThis.hostHarness.reset());
  const invalid = session(1);
  invalid.source = `${HOST_ORIGIN}/host.html`;
  invalid.peerOrigin = HOST_ORIGIN;
  await expect(page.evaluate((config) => globalThis.hostHarness.open(config), invalid)).rejects.toThrow(/cross-origin/u);
  expect(await page.evaluate(() => globalThis.hostHarness.frameDetails())).toEqual([]);
  const mismatched = session(1);
  mismatched.source = `${ATTACKER_ORIGIN}/attacker.html`;
  await expect(page.evaluate((config) => globalThis.hostHarness.open(config), mismatched)).rejects.toThrow(/exact peer origin/u);
  expect(await page.evaluate(() => globalThis.hostHarness.frameDetails())).toEqual([]);

  const frame = await openHost(page, session(1));
  expect(await page.evaluate(() => globalThis.hostHarness.frameDetails())).toEqual([{
    source: session(1).source,
    title: "Synthetic prototype 1",
    sandbox: "allow-same-origin allow-scripts",
    allow: expect.stringContaining("camera 'none'"),
    referrerPolicy: "no-referrer",
  }]);
  expect(await frame.evaluate(() => globalThis.prototypeHarness.referrer)).toBe("");
  expect(await frame.evaluate(() => {
    const policy = (Reflect.get(document, "permissionsPolicy") ?? Reflect.get(document, "featurePolicy")) as
      | { allowsFeature(feature: string): boolean }
      | undefined;
    return policy?.allowsFeature("camera");
  })).toBe(false);

  await page.evaluate(() => globalThis.hostHarness.reset("cooperative-forms"));
  await openHost(page, session(2));
  expect((await page.evaluate(() => globalThis.hostHarness.frameDetails()))[0]?.sandbox).toBe("allow-forms allow-same-origin allow-scripts");
  await page.evaluate(() => globalThis.hostHarness.close());
  expect(await page.evaluate(() => globalThis.hostHarness.snapshot().state)).toBe("closed");
  await expect(page.evaluate((config) => globalThis.hostHarness.open(config), session(3))).rejects.toThrow(/cannot be reopened/u);
});

test("carries bidirectional messages and ignores sibling and wrong-session senders", async ({ page }) => {
  const current = session(1);
  const frame = await openHost(page, current);
  await page.evaluate(() => globalThis.hostHarness.send({ type: "navigation", mode: "request", route: "/from-host" }));
  await expect.poll(() => frame.evaluate(() => globalThis.prototypeHarness.messages)).toContainEqual({
    type: "navigation",
    mode: "request",
    route: "/from-host",
  });

  await frame.evaluate(() => globalThis.prototypeHarness.send({
    type: "viewport",
    mode: "report",
    viewportId: "mobile",
    width: 390,
    height: 844,
    devicePixelRatio: 3,
  }));
  await expect.poll(() => page.evaluate(() => globalThis.hostHarness.events.filter((event) => event.type === "message"))).toContainEqual(
    expect.objectContaining({ message: expect.objectContaining({ type: "viewport", viewportId: "mobile" }) }),
  );

  const siblingPayload = operationalEnvelope(current.sessionId, "/sibling-attack");
  const siblingParameters = new URLSearchParams({ hostOrigin: HOST_ORIGIN, payload: JSON.stringify(siblingPayload) });
  await page.evaluate((source) => globalThis.hostHarness.addSibling(source), `${PROTOTYPE_ORIGIN}/relay.html?${siblingParameters}`);
  await frame.evaluate((payload) => globalThis.prototypeHarness.sendRaw(payload), operationalEnvelope("wrong-session", "/wrong-session"));
  await page.waitForTimeout(100);
  const routes = await page.evaluate(() => globalThis.hostHarness.events
    .flatMap((event) => event.type === "message" && event.message.type === "navigation" ? [event.message.route] : []));
  expect(routes).not.toContain("/sibling-attack");
  expect(routes).not.toContain("/wrong-session");
  expect(await page.evaluate(() => globalThis.hostHarness.snapshot().state)).toBe("active");
});

test("fails closed for a malformed claimed session and an unplanned reload", async ({ page }) => {
  const current = session(1);
  let frame = await openHost(page, current);
  await frame.evaluate(
    ({ protocol, sessionId }) => globalThis.prototypeHarness.sendRaw({ protocol, sessionId }),
    { protocol: BRIDGE_PROTOCOL, sessionId: current.sessionId },
  );
  await expect.poll(() => page.evaluate(() => globalThis.hostHarness.events.some(
    (event) => event.type === "error" && event.error.code === "invalid_message",
  ))).toBe(true);
  expect(await page.evaluate(() => globalThis.hostHarness.snapshot().state)).toBe("idle");
  expect(await page.evaluate(() => globalThis.hostHarness.frameDetails())).toEqual([]);

  frame = await openHost(page, session(2));
  expect(await page.evaluate(() => globalThis.hostHarness.snapshot().source)).not.toContain(NONCE);
  await frame.evaluate(() => location.reload());
  await expect.poll(() => page.evaluate(() => globalThis.hostHarness.events.some(
    (event) => event.type === "error" && event.error.code === "unexpected_navigation",
  ))).toBe(true);
  expect(await page.evaluate(() => globalThis.hostHarness.snapshot().state)).toBe("idle");

  const replacement = session(3);
  await openHost(page, replacement);
  expect(await page.evaluate(() => globalThis.hostHarness.snapshot())).toEqual(expect.objectContaining({
    state: "active",
    generation: 3,
    sessionId: replacement.sessionId,
  }));
});

test("replaces peer identity and leaves stale frames inert when physical cleanup fails", async ({ page }) => {
  const first = session(1);
  const staleFrame = await openHost(page, first);
  await page.evaluate(() => globalThis.hostHarness.failNextCleanup());
  const second = session(2);
  const activeFrame = await openHost(page, second);

  expect(await page.evaluate(() => globalThis.hostHarness.events.some(
    (event) => event.type === "error" && event.error.code === "cleanup_failure",
  ))).toBe(true);
  expect(await page.evaluate(() => globalThis.hostHarness.snapshot())).toEqual(expect.objectContaining({
    state: "active",
    generation: 2,
    sessionId: second.sessionId,
  }));
  expect(staleFrame).not.toBe(activeFrame);
  await staleFrame.evaluate(() => globalThis.prototypeHarness.send({ type: "navigation", mode: "report", route: "/stale-frame" }));
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => globalThis.hostHarness.events.some(
    (event) => event.type === "message" && event.message.type === "navigation" && event.message.route === "/stale-frame",
  ))).toBe(false);
  expect(await page.evaluate(() => globalThis.hostHarness.snapshot().state)).toBe("active");
});

test("relies on concrete targetOrigin and rejects the expected window after hostile navigation", async ({ page }) => {
  const current = session(1);
  const frame = await openHost(page, current);
  const payload = operationalEnvelope(current.sessionId, "/attacker-origin");
  const parameters = new URLSearchParams({ hostOrigin: HOST_ORIGIN, payload: JSON.stringify(payload) });
  await frame.evaluate((source) => globalThis.prototypeHarness.navigate(source), `${ATTACKER_ORIGIN}/attacker.html?${parameters}`);

  await expect.poll(() => page.evaluate(() => globalThis.hostHarness.attackReports)).toContainEqual({
    kind: "attacker-report",
    received: 0,
  });
  await expect.poll(() => page.evaluate(() => globalThis.hostHarness.events.some(
    (event) => event.type === "error" && event.error.code === "invalid_origin",
  ))).toBe(true);
  expect(await page.evaluate(() => globalThis.hostHarness.events.some(
    (event) => event.type === "message" && event.message.type === "navigation" && event.message.route === "/attacker-origin",
  ))).toBe(false);
  expect(await page.evaluate(() => globalThis.hostHarness.snapshot().state)).toBe("idle");
});

declare global {
  // Synthetic browser fixture surface, not part of the package interface.
  var hostHarness: {
    reset(profile?: string): void;
    open(config: SessionInput): unknown;
    send(message: unknown): void;
    close(): void;
    snapshot(): { state: string; generation: number; sessionId?: string; source?: string };
    events: Array<
      | { type: "state" }
      | { type: "error"; error: { code: string } }
      | { type: "message"; message: { type: string; route?: string } }
    >;
    attackReports: Array<{ kind: string; received?: number }>;
    frameDetails(): Array<{ source: string; title: string; sandbox: string; allow: string; referrerPolicy: string }>;
    addSibling(source: string): void;
    failNextCleanup(): void;
  };
  var prototypeHarness: {
    messages: unknown[];
    referrer: string;
    snapshot(): { session: { state: string } };
    send(message: unknown): void;
    sendRaw(message: unknown): void;
    navigate(source: string): void;
  };
}
