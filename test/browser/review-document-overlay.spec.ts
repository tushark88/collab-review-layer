import { expect, test, type Page } from "@playwright/test";

const HOST_ORIGIN = "http://127.0.0.1:4173";

async function loadOverlay(page: Page): Promise<void> {
  page.on("pageerror", (error) => console.error(`browser page error: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") console.error(`browser console error: ${message.text()}`);
  });
  await page.goto(`${HOST_ORIGIN}/overlay.html`);
  await expect.poll(() => page.evaluate(() => Boolean(globalThis.overlayHarness))).toBe(true);
}

test("explicit owned styles preserve prototype clicks in Pointer mode and create a complete Anchor in Comment mode", async ({ page }) => {
  await loadOverlay(page);
  const action = page.getByRole("button", { name: "Synthetic prototype action" });

  expect(await page.evaluate(() => [...document.styleSheets].some((sheet) => sheet.href?.endsWith("/dist/review-overlay.css")))).toBe(true);
  expect(await page.locator("[data-collab-review-layer='overlay']").evaluate((element) => {
    return getComputedStyle(element).getPropertyValue("--crl-overlay-owned").trim();
  })).toBe("1");

  await action.click({ position: { x: 20, y: 15 } });
  expect(await page.evaluate(() => globalThis.overlayHarness.prototypeClicks())).toBe(1);
  await expect(page.getByRole("dialog", { name: "Add review comment" })).toHaveCount(0);

  await page.evaluate(() => globalThis.overlayHarness.setMode("comment"));
  await action.click({ position: { x: 20, y: 15 } });
  expect(await page.evaluate(() => globalThis.overlayHarness.prototypeClicks())).toBe(1);
  const composer = page.getByRole("dialog", { name: "Add review comment" });
  await expect(composer).toBeVisible();
  const composerBox = await composer.boundingBox();
  expect(composerBox).not.toBeNull();
  expect(composerBox!.x).toBeGreaterThanOrEqual(0);
  expect(composerBox!.y).toBeGreaterThanOrEqual(0);
  expect(composerBox!.x + composerBox!.width).toBeLessThanOrEqual(1280);
  expect(composerBox!.y + composerBox!.height).toBeLessThanOrEqual(720);

  await page.getByRole("textbox", { name: "Comment" }).fill("Synthetic feedback");
  await page.getByRole("textbox", { name: "Comment" }).press("Control+Enter");
  await expect(composer).toHaveCount(0);

  expect(await page.evaluate(() => globalThis.overlayHarness.submissions)).toEqual([{
    body: "Synthetic feedback",
    anchor: {
      schemaVersion: 2,
      locationAvailability: "available",
      recoveryState: "not_required",
      context: {
        reviewId: "review-synthetic",
        prototypeId: "prototype-synthetic",
        revisionId: "revision-synthetic",
        viewportId: "desktop",
        variantId: "default",
        route: "/overlay",
        deviceId: "desktop-chromium",
        surfaceId: "top-document",
      },
      element: {
        selector: "[data-collab-review-id=\"synthetic-action\"]",
        identity: "synthetic-action",
        offset: { x: 20, y: 15 },
      },
      document: { x: 60, y: 55, width: 1280, height: 720 },
    },
  }]);
});

test("the overlay fails closed without its owned asset and rejects ratio-only placement input", async ({ page }) => {
  await page.goto(`${HOST_ORIGIN}/overlay-without-styles.html`);
  await expect.poll(() => page.evaluate(() => globalThis.overlayWithoutStylesResult)).toEqual({
    name: "ReviewDocumentOverlayError",
    code: "missing_styles",
    message: "review overlay stylesheet is not loaded in this document",
  });
  await expect(page.locator("[data-collab-review-layer='overlay']")).toHaveCount(0);

  await loadOverlay(page);
  expect(await page.evaluate(() => {
    try {
      globalThis.overlayHarness.setThreads([{
        threadId: "thread-ratio-only",
        anchorGeneration: 1,
        anchor: {
          schemaVersion: 1,
          semantic: { role: "button" },
          geometry: { xRatio: 0.5, yRatio: 0.5 },
          scroll: { xRatio: 0, yRatio: 0 },
        },
      }]);
      return { accepted: true };
    } catch (error) {
      const typed = error as { name?: unknown; code?: unknown };
      return { name: typed.name, code: typed.code };
    }
  })).toEqual({ name: "ReviewDocumentOverlayError", code: "invalid_config" });
});

test("destroy removes every owned surface and restores prototype interaction", async ({ page }) => {
  await loadOverlay(page);
  await page.evaluate(() => globalThis.overlayHarness.setMode("comment"));
  await page.evaluate(() => globalThis.overlayHarness.destroy());

  await expect(page.locator("[data-collab-review-layer='overlay']")).toHaveCount(0);
  expect(await page.evaluate(() => globalThis.overlayHarness.snapshot())).toEqual({
    state: "destroyed",
    interactionMode: "comment",
    composerOpen: false,
  });
  await page.getByRole("button", { name: "Synthetic prototype action" }).click();
  expect(await page.evaluate(() => globalThis.overlayHarness.prototypeClicks())).toBe(1);
  expect(await page.evaluate(() => globalThis.overlayHarness.submissions)).toEqual([]);
});

test("a document-space pin follows its element, stays non-intercepting in Pointer mode, and fails unavailable", async ({ page }) => {
  await loadOverlay(page);
  await page.evaluate(() => globalThis.overlayHarness.setThreads([{
    threadId: "thread-synthetic",
    anchorGeneration: 1,
    label: "Synthetic thread",
    anchor: {
      schemaVersion: 2,
      locationAvailability: "available",
      recoveryState: "not_required",
      context: {
        reviewId: "review-synthetic",
        prototypeId: "prototype-synthetic",
        revisionId: "revision-synthetic",
        viewportId: "desktop",
        variantId: "default",
        route: "/overlay",
        deviceId: "desktop-chromium",
        surfaceId: "top-document",
      },
      element: {
        selector: "[data-collab-review-id=\"synthetic-action\"]",
        identity: "synthetic-action",
        offset: { x: 20, y: 15 },
      },
      document: { x: 60, y: 55, width: 1280, height: 720 },
    },
  }]));

  const action = page.getByRole("button", { name: "Synthetic prototype action" });
  const pin = page.getByRole("button", { name: "Open Synthetic thread" });
  await expect(pin).toBeVisible();
  const assertAttached = async (): Promise<void> => {
    const targetBox = await action.boundingBox();
    const pinBox = await pin.boundingBox();
    expect(targetBox).not.toBeNull();
    expect(pinBox).not.toBeNull();
    expect(pinBox!.x + (pinBox!.width / 2)).toBeCloseTo(targetBox!.x + 20, 0);
    expect(pinBox!.y + (pinBox!.height / 2)).toBeCloseTo(targetBox!.y + 15, 0);
  };
  await assertAttached();

  const pinBox = await pin.boundingBox();
  await page.mouse.click(pinBox!.x + (pinBox!.width / 2), pinBox!.y + (pinBox!.height / 2));
  expect(await page.evaluate(() => globalThis.overlayHarness.prototypeClicks())).toBe(1);
  expect(await page.evaluate(() => globalThis.overlayHarness.openedThreads)).toEqual([]);

  await page.evaluate(() => globalThis.overlayHarness.setMode("comment"));
  const scrollBeforeOpen = await page.evaluate(() => scrollY);
  await pin.click();
  expect(await page.evaluate(() => globalThis.overlayHarness.openedThreads)).toEqual(["thread-synthetic"]);
  expect(await page.evaluate(() => scrollY)).toBe(scrollBeforeOpen);

  await page.evaluate(() => globalThis.overlayHarness.growAbove());
  await expect.poll(async () => {
    const targetBox = await action.boundingBox();
    const currentPinBox = await pin.boundingBox();
    return Math.round((currentPinBox?.y ?? 0) + ((currentPinBox?.height ?? 0) / 2) - (targetBox?.y ?? 0));
  }).toBe(15);
  await page.evaluate(() => scrollTo(0, 200));
  await expect.poll(async () => {
    const targetBox = await action.boundingBox();
    const currentPinBox = await pin.boundingBox();
    return Math.round((currentPinBox?.y ?? 0) + ((currentPinBox?.height ?? 0) / 2) - (targetBox?.y ?? 0));
  }).toBe(15);

  await page.evaluate(() => globalThis.overlayHarness.removeTarget());
  await expect(pin).toHaveCount(0);
  expect(await page.evaluate(() => globalThis.overlayHarness.unavailableAnchors)).toEqual([{
    threadId: "thread-synthetic",
    anchorGeneration: 1,
  }]);
});

test("an unavailable Anchor has no pin and re-placement preserves the existing Thread identity", async ({ page }) => {
  await loadOverlay(page);
  await page.evaluate(() => globalThis.overlayHarness.setThreads([{
    threadId: "thread-legacy",
    anchorGeneration: 4,
    label: "Legacy synthetic thread",
    canReplaceAnchor: true,
    anchor: {
      schemaVersion: 1,
      locationAvailability: "unavailable",
      recoveryState: "legacy_replacement_required",
    },
  }]));

  await expect(page.locator(".crl-overlay__pin")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Re-place Legacy synthetic thread" })).toHaveCount(0);
  await page.evaluate(() => globalThis.overlayHarness.setMode("comment"));
  const recovery = page.getByRole("button", { name: "Re-place Legacy synthetic thread" });
  await expect(recovery).toBeVisible();
  await recovery.click();
  await page.getByRole("button", { name: "Synthetic prototype action" }).click({ position: { x: 35, y: 25 } });

  await expect(recovery).toHaveCount(0);
  await expect(page.getByRole("dialog", { name: "Add review comment" })).toHaveCount(0);
  expect(await page.evaluate(() => globalThis.overlayHarness.submissions)).toEqual([]);
  expect(await page.evaluate(() => globalThis.overlayHarness.replacementRequests)).toEqual([{
    threadId: "thread-legacy",
    anchorGeneration: 4,
    anchor: {
      schemaVersion: 2,
      locationAvailability: "available",
      recoveryState: "not_required",
      context: {
        reviewId: "review-synthetic",
        prototypeId: "prototype-synthetic",
        revisionId: "revision-synthetic",
        viewportId: "desktop",
        variantId: "default",
        route: "/overlay",
        deviceId: "desktop-chromium",
        surfaceId: "top-document",
      },
      element: {
        selector: "[data-collab-review-id=\"synthetic-action\"]",
        identity: "synthetic-action",
        offset: { x: 35, y: 25 },
      },
      document: { x: 75, y: 65, width: 1280, height: 720 },
    },
  }]);
});

test("a cooperative nested document owns its styles and preserves Pointer and Comment behavior", async ({ page }) => {
  await page.goto(`${HOST_ORIGIN}/nested-overlay.html`);
  const nested = page.frameLocator("iframe[title='Synthetic nested prototype']");
  const action = nested.getByRole("button", { name: "Nested prototype action" });
  await expect(action).toBeVisible();
  const frame = page.frames().find((candidate) => candidate.url().includes("/nested-prototype.html"));
  expect(frame).toBeDefined();

  expect(await frame!.evaluate(() => [...document.styleSheets].some((sheet) => sheet.href?.endsWith("/dist/review-overlay.css")))).toBe(true);
  expect(await frame!.locator("[data-collab-review-layer='overlay']").evaluate((element) => {
    return getComputedStyle(element).getPropertyValue("--crl-overlay-owned").trim();
  })).toBe("1");

  await action.click();
  expect(await frame!.evaluate(() => globalThis.nestedOverlayHarness.prototypeClicks())).toBe(1);
  await frame!.evaluate(() => globalThis.nestedOverlayHarness.setMode("comment"));
  await nested.locator("#nested-action-content").click();
  expect(await frame!.evaluate(() => globalThis.nestedOverlayHarness.prototypeClicks())).toBe(1);
  const composer = nested.getByRole("dialog", { name: "Add review comment" });
  await expect(composer).toBeVisible();
  const composerBox = await composer.boundingBox();
  expect(composerBox).not.toBeNull();
  const frameViewport = await frame!.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  expect(composerBox!.x).toBeGreaterThanOrEqual(0);
  expect(composerBox!.y).toBeGreaterThanOrEqual(0);
  expect(composerBox!.x + composerBox!.width).toBeLessThanOrEqual(frameViewport.width);
  expect(composerBox!.y + composerBox!.height).toBeLessThanOrEqual(frameViewport.height);
  await nested.getByRole("textbox", { name: "Comment" }).press("Escape");
  await expect(composer).toHaveCount(0);
});

for (const device of [
  { name: "representative iPhone", viewport: { width: 390, height: 844 } },
  { name: "representative Android", viewport: { width: 412, height: 915 } },
]) {
  test(`${device.name} viewport keeps the composer in bounds and supports Escape plus submit shortcut`, async ({ page }) => {
    await page.setViewportSize(device.viewport);
    await loadOverlay(page);
    await page.evaluate(() => globalThis.overlayHarness.setMode("comment"));
    const action = page.getByRole("button", { name: "Synthetic prototype action" });

    await action.click({ position: { x: 24, y: 18 } });
    const composer = page.getByRole("dialog", { name: "Add review comment" });
    await expect(composer).toBeVisible();
    const composerBox = await composer.boundingBox();
    expect(composerBox).not.toBeNull();
    expect(composerBox!.x).toBeGreaterThanOrEqual(0);
    expect(composerBox!.y).toBeGreaterThanOrEqual(0);
    expect(composerBox!.x + composerBox!.width).toBeLessThanOrEqual(device.viewport.width);
    expect(composerBox!.y + composerBox!.height).toBeLessThanOrEqual(device.viewport.height);
    await page.getByRole("textbox", { name: "Comment" }).press("Escape");
    await expect(composer).toHaveCount(0);

    await action.click({ position: { x: 24, y: 18 } });
    await page.getByRole("textbox", { name: "Comment" }).fill(`${device.name} feedback`);
    await page.getByRole("textbox", { name: "Comment" }).press("Control+Enter");
    await expect(composer).toHaveCount(0);
    expect(await page.evaluate(() => globalThis.overlayHarness.submissions.length)).toBe(1);
  });
}

declare global {
  var overlayHarness: {
    submissions: unknown[];
    replacementRequests: unknown[];
    openedThreads: string[];
    unavailableAnchors: Array<{ threadId: string; anchorGeneration: number }>;
    prototypeClicks(): number;
    snapshot(): unknown;
    setMode(mode: "pointer" | "comment"): unknown;
    setThreads(threads: unknown[]): unknown;
    refresh(): unknown;
    growAbove(): void;
    removeTarget(): void;
    destroy(): void;
  };
  var nestedOverlayHarness: {
    prototypeClicks(): number;
    setMode(mode: "pointer" | "comment"): unknown;
  };
  var overlayWithoutStylesResult: unknown;
}
