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
  await page.getByRole("button", { name: "Unanchorable prototype action" }).click();
  expect(await page.evaluate(() => globalThis.overlayHarness.unanchorableClicks())).toBe(1);
  await expect(page.getByRole("dialog", { name: "Add review comment" })).toHaveCount(0);
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

test("keyboard activation anchors at the target center without triggering the prototype", async ({ page }) => {
  await loadOverlay(page);
  await page.evaluate(() => globalThis.overlayHarness.setMode("comment"));
  const action = page.getByRole("button", { name: "Synthetic prototype action" });
  await action.focus();
  await action.press("Enter");

  const composer = page.getByRole("dialog", { name: "Add review comment" });
  await expect(composer).toBeVisible();
  expect(await page.evaluate(() => globalThis.overlayHarness.prototypeClicks())).toBe(0);
  await page.getByRole("textbox", { name: "Comment" }).fill("Keyboard feedback");
  await page.getByRole("textbox", { name: "Comment" }).press("Control+Enter");
  expect(await page.evaluate(() => globalThis.overlayHarness.submissions)).toEqual([{
    body: "Keyboard feedback",
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
        offset: { x: 80, y: 40 },
      },
      document: { x: 120, y: 80, width: 1280, height: 720 },
    },
  }]);
});

test("script-generated prototype clicks remain prototype-owned in Comment mode", async ({ page }) => {
  await loadOverlay(page);
  await page.evaluate(() => globalThis.overlayHarness.setMode("comment"));
  await page.locator("#prototype-action").evaluate((element) => (element as HTMLElement).click());

  expect(await page.evaluate(() => globalThis.overlayHarness.prototypeClicks())).toBe(1);
  await expect(page.getByRole("dialog", { name: "Add review comment" })).toHaveCount(0);
  expect(await page.evaluate(() => globalThis.overlayHarness.submissions)).toEqual([]);
});

test("captured Anchor identity exactly matches its persistent DOM marker", async ({ page }) => {
  await loadOverlay(page);
  const action = page.getByRole("button", { name: "Synthetic prototype action" });
  await action.evaluate((element) => element.setAttribute("data-collab-review-id", " synthetic-action "));
  await page.evaluate(() => globalThis.overlayHarness.setMode("comment"));
  await action.click({ position: { x: 20, y: 15 } });
  await page.getByRole("textbox", { name: "Comment" }).fill("Exact identity feedback");
  await page.getByRole("textbox", { name: "Comment" }).press("Control+Enter");

  const submission = await page.evaluate(() => globalThis.overlayHarness.submissions[0]) as {
    anchor: { element: { identity: string; selector: string; offset: { x: number; y: number } } };
  };
  expect(submission.anchor.element).toEqual({
    selector: "[data-collab-review-id=\" synthetic-action \"]",
    identity: " synthetic-action ",
    offset: { x: 20, y: 15 },
  });
});

test("captured Anchor selectors escape accepted CSS control characters", async ({ page }) => {
  await loadOverlay(page);
  const action = page.getByRole("button", { name: "Synthetic prototype action" });
  await action.evaluate((element) => element.setAttribute("data-collab-review-id", "a\fb"));
  await page.evaluate(() => globalThis.overlayHarness.setMode("comment"));
  await action.click({ position: { x: 20, y: 15 } });
  await page.getByRole("textbox", { name: "Comment" }).fill("Escaped identity feedback");
  await page.getByRole("textbox", { name: "Comment" }).press("Control+Enter");

  const submission = await page.evaluate(() => globalThis.overlayHarness.submissions[0]) as {
    anchor: { element: { identity: string; selector: string } };
  };
  expect(submission.anchor.element.identity).toBe("a\fb");
  expect(submission.anchor.element.selector).toBe("[data-collab-review-id=\"a\\c b\"]");
});

test("a transformed target preserves the clicked element-local point across transform changes", async ({ page }) => {
  await loadOverlay(page);
  const action = page.getByRole("button", { name: "Synthetic prototype action" });
  await action.evaluate((element) => {
    (element as HTMLElement).style.transformOrigin = "0 0";
    (element as HTMLElement).style.transform = "scale(2)";
  });
  await page.evaluate(() => globalThis.overlayHarness.setMode("comment"));
  const transformedBox = await action.boundingBox();
  expect(transformedBox).not.toBeNull();
  await page.mouse.click(
    transformedBox!.x + (transformedBox!.width / 2),
    transformedBox!.y + (transformedBox!.height / 2),
  );
  await page.getByRole("textbox", { name: "Comment" }).fill("Transformed target feedback");
  await page.getByRole("textbox", { name: "Comment" }).press("Control+Enter");
  const anchor = await page.evaluate(() => (globalThis.overlayHarness.submissions[0] as { anchor: unknown }).anchor);
  expect((anchor as { element: { offset: unknown } }).element.offset).toEqual({ x: 80, y: 40 });

  await page.evaluate((value) => globalThis.overlayHarness.setThreads([{
    threadId: "thread-transformed-target",
    anchorGeneration: 1,
    label: "Transformed target thread",
    anchor: value,
  }]), anchor);
  const pin = page.getByRole("button", { name: "Open Transformed target thread" });
  await expect.poll(async () => {
    const targetBox = await action.boundingBox();
    const pinBox = await pin.boundingBox();
    return Math.round((pinBox?.x ?? 0) + ((pinBox?.width ?? 0) / 2) - (targetBox?.x ?? 0));
  }).toBe(160);

  await action.evaluate((element) => { (element as HTMLElement).style.transform = ""; });
  await expect.poll(async () => {
    const targetBox = await action.boundingBox();
    const pinBox = await pin.boundingBox();
    return {
      x: Math.round((pinBox?.x ?? 0) + ((pinBox?.width ?? 0) / 2) - (targetBox?.x ?? 0)),
      y: Math.round((pinBox?.y ?? 0) + ((pinBox?.height ?? 0) / 2) - (targetBox?.y ?? 0)),
    };
  }).toEqual({ x: 80, y: 40 });
});

test("an ancestor transform preserves the clicked element-local point across changes", async ({ page }) => {
  await loadOverlay(page);
  const target = page.getByRole("button", { name: "Ancestor transform target" });
  await page.locator("#ancestor-transform-parent").evaluate((element) => {
    (element as HTMLElement).style.transform = "rotate(12deg) scale(2)";
  });
  await page.evaluate(() => globalThis.overlayHarness.setMode("comment"));
  const transformedBox = await target.boundingBox();
  expect(transformedBox).not.toBeNull();
  await page.mouse.click(
    transformedBox!.x + (transformedBox!.width / 2),
    transformedBox!.y + (transformedBox!.height / 2),
  );
  await page.getByRole("textbox", { name: "Comment" }).fill("Ancestor transform feedback");
  await page.getByRole("textbox", { name: "Comment" }).press("Control+Enter");
  const anchor = await page.evaluate(() => (globalThis.overlayHarness.submissions[0] as { anchor: unknown }).anchor);
  const offset = (anchor as { element: { offset: { x: number; y: number } } }).element.offset;
  expect(offset.x).toBeCloseTo(80, 0);
  expect(offset.y).toBeCloseTo(40, 0);

  await page.evaluate((value) => globalThis.overlayHarness.setThreads([{
    threadId: "thread-ancestor-transform",
    anchorGeneration: 1,
    label: "Ancestor transform thread",
    anchor: value,
  }]), anchor);
  const pin = page.getByRole("button", { name: "Open Ancestor transform thread" });
  await page.locator("#ancestor-transform-parent").evaluate((element) => {
    (element as HTMLElement).style.transform = "";
  });
  await expect.poll(async () => {
    const targetBox = await target.boundingBox();
    const pinBox = await pin.boundingBox();
    return {
      x: Math.round((pinBox?.x ?? 0) + ((pinBox?.width ?? 0) / 2) - (targetBox?.x ?? 0)),
      y: Math.round((pinBox?.y ?? 0) + ((pinBox?.height ?? 0) / 2) - (targetBox?.y ?? 0)),
    };
  }).toEqual({ x: 80, y: 40 });
});

test("visually planar matrix3d transforms on a target and ancestor preserve element-local placement", async ({ page }) => {
  await loadOverlay(page);
  const target = page.getByRole("button", { name: "Ancestor transform target" });
  await page.locator("#ancestor-transform-parent").evaluate((element) => {
    (element as HTMLElement).style.transform = "translate3d(12px, 8px, 1px) scale3d(1.2, 1.2, 1)";
  });
  await target.evaluate((element) => {
    (element as HTMLElement).style.transformOrigin = "0 0";
    (element as HTMLElement).style.transform = "translateZ(1px) scale3d(1.5, 1.5, 1)";
  });
  expect(await page.evaluate(() => {
    const parentTransform = getComputedStyle(document.querySelector("#ancestor-transform-parent")!).transform;
    const targetTransform = getComputedStyle(document.querySelector("#ancestor-transform-target")!).transform;
    return {
      parentUsesMatrix3d: parentTransform.startsWith("matrix3d("),
      parentFlaggedAs2d: new DOMMatrix(parentTransform).is2D,
      targetUsesMatrix3d: targetTransform.startsWith("matrix3d("),
      targetFlaggedAs2d: new DOMMatrix(targetTransform).is2D,
    };
  })).toEqual({
    parentUsesMatrix3d: true,
    parentFlaggedAs2d: false,
    targetUsesMatrix3d: true,
    targetFlaggedAs2d: false,
  });
  await page.evaluate(() => globalThis.overlayHarness.setMode("comment"));
  const transformedBox = await target.boundingBox();
  expect(transformedBox).not.toBeNull();
  await page.mouse.click(
    transformedBox!.x + (transformedBox!.width / 2),
    transformedBox!.y + (transformedBox!.height / 2),
  );
  await page.getByRole("textbox", { name: "Comment" }).fill("Planar matrix3d feedback");
  await page.getByRole("textbox", { name: "Comment" }).press("Control+Enter");
  const anchor = await page.evaluate(() => (globalThis.overlayHarness.submissions[0] as { anchor: unknown }).anchor);
  expect((anchor as { element: { offset: unknown } }).element.offset).toEqual({ x: 80, y: 40 });

  await page.evaluate((value) => globalThis.overlayHarness.setThreads([{
    threadId: "thread-planar-matrix3d",
    anchorGeneration: 1,
    label: "Planar matrix3d thread",
    anchor: value,
  }]), anchor);
  const pin = page.getByRole("button", { name: "Open Planar matrix3d thread" });
  await page.locator("#ancestor-transform-parent").evaluate((element) => {
    (element as HTMLElement).style.transform = "";
  });
  await target.evaluate((element) => { (element as HTMLElement).style.transform = ""; });
  await expect.poll(async () => {
    const targetBox = await target.boundingBox();
    const pinBox = await pin.boundingBox();
    return {
      x: Math.round((pinBox?.x ?? 0) + ((pinBox?.width ?? 0) / 2) - (targetBox?.x ?? 0)),
      y: Math.round((pinBox?.y ?? 0) + ((pinBox?.height ?? 0) / 2) - (targetBox?.y ?? 0)),
    };
  }).toEqual({ x: 80, y: 40 });
});

test("a perspective transform without an affine element-plane projection fails closed", async ({ page }) => {
  await loadOverlay(page);
  const target = page.getByRole("button", { name: "Ancestor transform target" });
  await target.evaluate((element) => {
    (element as HTMLElement).style.transformOrigin = "0 0";
    (element as HTMLElement).style.transform = "perspective(500px) rotateX(20deg)";
  });
  await page.evaluate(() => globalThis.overlayHarness.setMode("comment"));
  const transformedBox = await target.boundingBox();
  expect(transformedBox).not.toBeNull();
  await page.mouse.click(
    transformedBox!.x + (transformedBox!.width / 2),
    transformedBox!.y + (transformedBox!.height / 2),
  );
  await expect(page.getByRole("textbox", { name: "Comment" })).toHaveCount(0);
  expect(await page.evaluate(() => globalThis.overlayHarness.submissions)).toEqual([]);
});

test("nested 3D transforms honor the browser's default flat rendering boundary", async ({ page }) => {
  await loadOverlay(page);
  const target = page.getByRole("button", { name: "Ancestor transform target" });
  const reference = page.locator("#nested-3d-reference");
  const [baselineTarget, baselineReference] = await Promise.all([target.boundingBox(), reference.boundingBox()]);
  expect(baselineTarget).not.toBeNull();
  expect(baselineReference).not.toBeNull();
  const offset = {
    x: (baselineReference!.x + (baselineReference!.width / 2)) - baselineTarget!.x,
    y: (baselineReference!.y + (baselineReference!.height / 2)) - baselineTarget!.y,
  };

  await page.locator("#ancestor-transform-parent").evaluate((element) => {
    (element as HTMLElement).style.transformOrigin = "0 0";
    (element as HTMLElement).style.transform = "rotateY(35deg)";
  });
  await target.evaluate((element) => {
    (element as HTMLElement).style.transformOrigin = "0 0";
    (element as HTMLElement).style.transform = "rotateX(40deg)";
  });
  expect(await page.locator("#ancestor-transform-parent").evaluate((element) => getComputedStyle(element).transformStyle)).toBe("flat");
  await page.evaluate((anchorOffset) => globalThis.overlayHarness.setThreads([{
    threadId: "thread-flat-3d",
    anchorGeneration: 1,
    label: "Flat 3D thread",
    anchor: {
      schemaVersion: 2,
      locationAvailability: "available",
      recoveryState: "not_required",
      context: globalThis.overlayHarness.context,
      element: {
        selector: "[data-collab-review-id=\"synthetic-ancestor-transform-target\"]",
        identity: "synthetic-ancestor-transform-target",
        offset: anchorOffset,
      },
      document: { x: 1, y: 1, width: 1280, height: 720 },
    },
  }]), offset);

  const pin = page.getByRole("button", { name: "Open Flat 3D thread", includeHidden: true });
  await expect.poll(async () => {
    const [pinBox, referenceBox] = await Promise.all([pin.boundingBox(), reference.boundingBox()]);
    return {
      x: Math.abs(Math.round((pinBox?.x ?? 0) + ((pinBox?.width ?? 0) / 2) - (referenceBox?.x ?? 0) - ((referenceBox?.width ?? 0) / 2))),
      y: Math.abs(Math.round((pinBox?.y ?? 0) + ((pinBox?.height ?? 0) / 2) - (referenceBox?.y ?? 0) - ((referenceBox?.height ?? 0) / 2))),
    };
  }).toEqual({ x: 0, y: 0 });
});

test("an open composer re-clamps when the active viewport changes", async ({ page }) => {
  await loadOverlay(page);
  await page.evaluate(() => globalThis.overlayHarness.setMode("comment"));
  await page.getByRole("button", { name: "Synthetic prototype action" }).click({ position: { x: 20, y: 15 } });
  const composer = page.getByRole("dialog", { name: "Add review comment" });
  await expect(composer).toBeVisible();

  await page.setViewportSize({ width: 320, height: 480 });
  await expect.poll(async () => {
    const box = await composer.boundingBox();
    return Boolean(box
      && box.x >= 0
      && box.y >= 0
      && box.x + box.width <= 320
      && box.y + box.height <= 480);
  }).toBe(true);
});

test("closing the composer restores focus to its prototype target", async ({ page }) => {
  await loadOverlay(page);
  await page.evaluate(() => globalThis.overlayHarness.setMode("comment"));
  const action = page.getByRole("button", { name: "Synthetic prototype action" });
  const composer = page.getByRole("dialog", { name: "Add review comment" });

  await action.focus();
  await action.press("Enter");
  await page.getByRole("textbox", { name: "Comment" }).press("Escape");
  await expect(composer).toHaveCount(0);
  await expect(action).toBeFocused();

  await action.press("Enter");
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(action).toBeFocused();

  await action.press("Enter");
  await page.evaluate(() => globalThis.overlayHarness.setMode("pointer"));
  await expect(action).toBeFocused();
  await page.evaluate(() => globalThis.overlayHarness.setMode("comment"));

  await action.press("Enter");
  await page.getByRole("textbox", { name: "Comment" }).fill("Focus-safe feedback");
  await page.getByRole("textbox", { name: "Comment" }).press("Control+Enter");
  await expect(action).toBeFocused();
});

test("closing the composer restores focus to a nested activated control", async ({ page }) => {
  await loadOverlay(page);
  await page.evaluate(() => globalThis.overlayHarness.setMode("comment"));
  const action = page.getByRole("button", { name: "Nested prototype control" });

  await action.focus();
  await action.press("Enter");
  await expect(page.getByRole("dialog", { name: "Add review comment" })).toBeVisible();
  await page.getByRole("textbox", { name: "Comment" }).press("Escape");
  await expect(action).toBeFocused();
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

test("mount rolls back owned DOM when browser observer setup fails", async ({ page }) => {
  await page.goto(`${HOST_ORIGIN}/overlay-observer-failure.html`);
  await expect.poll(() => page.evaluate(() => globalThis.overlayObserverFailureResult)).toEqual({
    name: "ReviewDocumentOverlayError",
    code: "environment_failure",
    message: "review overlay browser observers could not be attached",
  });
  await expect(page.locator("[data-collab-review-layer='overlay']")).toHaveCount(0);
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

test("the overlay preserves bounded legacy Review Context while rebinding invalid legacy surface identity", async ({ page }) => {
  const reviewId = "r".repeat(300);
  const route = "legacy route\ncorrelation";
  await page.goto(`${HOST_ORIGIN}/overlay.html?reviewId=${encodeURIComponent(reviewId)}&route=${encodeURIComponent(route)}`);
  await expect.poll(() => page.evaluate(() => Boolean(globalThis.overlayHarness))).toBe(true);
  const context = await page.evaluate(() => globalThis.overlayHarness.context);
  await page.evaluate((anchorContext) => globalThis.overlayHarness.setThreads([{
    threadId: "thread-legacy-context",
    anchorGeneration: 2,
    label: "Legacy context thread",
    anchor: {
      schemaVersion: 2,
      locationAvailability: "available",
      recoveryState: "not_required",
      context: anchorContext,
      element: {
        selector: "[data-collab-review-id=\"synthetic-action\"]",
        identity: "synthetic-action",
        offset: { x: 20, y: 15 },
      },
      document: { x: 60, y: 55, width: 1280, height: 720 },
    },
  }]), context);
  await expect(page.locator(".crl-overlay__pin")).toHaveCount(1);
  await page.evaluate(() => globalThis.overlayHarness.setThreads([]));
  await page.evaluate(() => globalThis.overlayHarness.setMode("comment"));
  await page.getByRole("button", { name: "Synthetic prototype action" }).click({ position: { x: 20, y: 15 } });
  expect(await page.evaluate(() => globalThis.overlayHarness.prototypeClicks())).toBe(1);
  await expect(page.getByRole("dialog", { name: "Add review comment" })).toHaveCount(0);

  await page.evaluate((anchorContext) => globalThis.overlayHarness.setThreads([{
    threadId: "thread-legacy-surface",
    anchorGeneration: 1,
    label: "Legacy surface thread",
    canReplaceAnchor: true,
    anchor: {
      schemaVersion: 2,
      locationAvailability: "unavailable",
      recoveryState: "legacy_replacement_required",
      context: { ...(anchorContext as Record<string, unknown>), deviceId: "legacy\ndevice", surfaceId: "legacy\nsurface" },
    },
  }]), context);
  await expect(page.getByRole("button", { name: "Re-place Legacy surface thread" })).toBeVisible();
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
  const pin = page.locator(".crl-overlay__pin");
  await expect(pin).toBeVisible();
  await expect(pin).toHaveAttribute("aria-label", "Open Synthetic thread");
  await expect(pin).toHaveAttribute("tabindex", "-1");
  await expect(pin).toHaveAttribute("aria-hidden", "true");
  const assertAttached = async (): Promise<void> => {
    const targetBox = await action.boundingBox();
    const pinBox = await pin.boundingBox();
    expect(targetBox).not.toBeNull();
    expect(pinBox).not.toBeNull();
    expect(pinBox!.x + (pinBox!.width / 2)).toBeCloseTo(targetBox!.x + 20, 0);
    expect(pinBox!.y + (pinBox!.height / 2)).toBeCloseTo(targetBox!.y + 15, 0);
  };
  await assertAttached();

  const idleAnimationFrames = await page.evaluate(async () => {
    const originalRequestAnimationFrame = window.requestAnimationFrame;
    let requestedFrames = 0;
    window.requestAnimationFrame = (callback) => {
      requestedFrames += 1;
      return originalRequestAnimationFrame.call(window, callback);
    };
    await new Promise((resolve) => setTimeout(resolve, 150));
    window.requestAnimationFrame = originalRequestAnimationFrame;
    return requestedFrames;
  });
  expect(idleAnimationFrames).toBeLessThanOrEqual(2);

  await action.evaluate((element) => { element.style.transform = "translateX(120px)"; });
  await expect.poll(async () => {
    const targetBox = await action.boundingBox();
    const currentPinBox = await pin.boundingBox();
    return Math.round((currentPinBox?.x ?? 0) + ((currentPinBox?.width ?? 0) / 2) - (targetBox?.x ?? 0));
  }).toBe(20);

  await action.evaluate((element) => { element.style.transform = ""; });
  await expect.poll(async () => {
    const targetBox = await action.boundingBox();
    const currentPinBox = await pin.boundingBox();
    return Math.round((currentPinBox?.x ?? 0) + ((currentPinBox?.width ?? 0) / 2) - (targetBox?.x ?? 0));
  }).toBe(20);
  await page.evaluate(() => globalThis.overlayHarness.animateTarget());
  await page.waitForTimeout(250);
  const movingBoxes = await Promise.all([action.boundingBox(), pin.boundingBox()]);
  expect(movingBoxes[0]).not.toBeNull();
  expect(movingBoxes[1]).not.toBeNull();
  expect(movingBoxes[0]!.x).toBeGreaterThan(45);
  expect(movingBoxes[0]!.x).toBeLessThan(160);
  expect(movingBoxes[1]!.x + (movingBoxes[1]!.width / 2) - movingBoxes[0]!.x).toBeCloseTo(20, 0);
  await expect.poll(async () => {
    const targetBox = await action.boundingBox();
    const currentPinBox = await pin.boundingBox();
    return {
      targetX: Math.round(targetBox?.x ?? 0),
      pinOffset: Math.round((currentPinBox?.x ?? 0) + ((currentPinBox?.width ?? 0) / 2) - (targetBox?.x ?? 0)),
    };
  }).toEqual({ targetX: 160, pinOffset: 20 });

  await page.evaluate(() => globalThis.overlayHarness.animateTargetCosmetically());
  await page.waitForTimeout(100);
  const cosmeticAnimationFrames = await page.evaluate(async () => {
    const originalRequestAnimationFrame = window.requestAnimationFrame;
    let requestedFrames = 0;
    window.requestAnimationFrame = (callback) => {
      requestedFrames += 1;
      return originalRequestAnimationFrame.call(window, callback);
    };
    await new Promise((resolve) => setTimeout(resolve, 150));
    window.requestAnimationFrame = originalRequestAnimationFrame;
    return requestedFrames;
  });
  expect(cosmeticAnimationFrames).toBeLessThanOrEqual(2);

  const pinBox = await pin.boundingBox();
  await page.mouse.click(pinBox!.x + (pinBox!.width / 2), pinBox!.y + (pinBox!.height / 2));
  expect(await page.evaluate(() => globalThis.overlayHarness.prototypeClicks())).toBe(1);
  expect(await page.evaluate(() => globalThis.overlayHarness.openedThreads)).toEqual([]);

  await page.evaluate(() => globalThis.overlayHarness.setMode("comment"));
  await expect(pin).toHaveAttribute("tabindex", "0");
  await expect(pin).not.toHaveAttribute("aria-hidden", "true");
  const scrollBeforeOpen = await page.evaluate(() => scrollY);
  await pin.click();
  expect(await page.evaluate(() => globalThis.overlayHarness.openedThreads)).toEqual(["thread-synthetic"]);
  expect(await page.evaluate(() => scrollY)).toBe(scrollBeforeOpen);
  await page.evaluate(() => globalThis.overlayHarness.refresh());
  await pin.click();
  expect(await page.evaluate(() => globalThis.overlayHarness.openedThreads)).toEqual(["thread-synthetic", "thread-synthetic"]);
  expect(await page.evaluate(() => scrollY)).toBe(scrollBeforeOpen);
  await pin.focus();
  await expect(pin).toBeFocused();
  await page.evaluate(() => globalThis.overlayHarness.setMode("pointer"));
  await expect(pin).not.toBeFocused();
  await expect(pin).toHaveAttribute("aria-hidden", "true");
  await page.evaluate(() => globalThis.overlayHarness.setMode("comment"));

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

  expect(await page.evaluate(() => globalThis.overlayHarness.temporarilyDetachTarget())).toBe(true);
  await expect(pin).toBeVisible();
  await page.waitForTimeout(600);
  expect(await page.evaluate(() => globalThis.overlayHarness.unavailableAnchors)).toEqual([]);

  await action.evaluate((element) => { (element as HTMLElement).hidden = true; });
  await expect(pin).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => globalThis.overlayHarness.unavailableAnchors)).toEqual([{
    threadId: "thread-synthetic",
    anchorGeneration: 1,
  }]);
  await page.locator("#prototype-action").evaluate((element) => { (element as HTMLElement).hidden = false; });
  await expect(pin).toBeVisible();

  await page.evaluate(() => globalThis.overlayHarness.removeTarget());
  await expect(pin).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => globalThis.overlayHarness.unavailableAnchors)).toEqual([{
    threadId: "thread-synthetic",
    anchorGeneration: 1,
  }, {
    threadId: "thread-synthetic",
    anchorGeneration: 1,
  }]);
});

test("an edge Anchor keeps the entire pin inside the active viewport", async ({ page }) => {
  await loadOverlay(page);
  await page.evaluate(() => {
    globalThis.overlayHarness.moveTargetToEdge();
    globalThis.overlayHarness.setThreads([{
      threadId: "thread-edge",
      anchorGeneration: 1,
      label: "Edge thread",
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
          offset: { x: 0, y: 0 },
        },
        document: { x: 0, y: 0, width: 1280, height: 720 },
      },
    }]);
  });

  const pinBox = await page.getByRole("button", { name: "Open Edge thread", includeHidden: true }).boundingBox();
  expect(pinBox).not.toBeNull();
  expect(pinBox!.x).toBeGreaterThanOrEqual(0);
  expect(pinBox!.y).toBeGreaterThanOrEqual(0);
  expect(pinBox!.x + pinBox!.width).toBeLessThanOrEqual(1280);
  expect(pinBox!.y + pinBox!.height).toBeLessThanOrEqual(720);
});

test("overlay coordinates remain viewport-bound when the prototype body is transformed", async ({ page }) => {
  await loadOverlay(page);
  await page.evaluate(() => {
    globalThis.overlayHarness.transformBody();
    globalThis.overlayHarness.setThreads([{
      threadId: "thread-transformed-body",
      anchorGeneration: 1,
      label: "Transformed body thread",
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
        document: { x: 160, y: 105, width: 1280, height: 720 },
      },
    }]);
  });

  const targetBox = await page.getByRole("button", { name: "Synthetic prototype action" }).boundingBox();
  const pinBox = await page.getByRole("button", { name: "Open Transformed body thread", includeHidden: true }).boundingBox();
  expect(targetBox).not.toBeNull();
  expect(pinBox).not.toBeNull();
  expect(pinBox!.x + (pinBox!.width / 2) - targetBox!.x).toBeCloseTo(20, 0);
  expect(pinBox!.y + (pinBox!.height / 2) - targetBox!.y).toBeCloseTo(15, 0);
});

test("a pin tracks layout motion caused by an animated sibling", async ({ page }) => {
  await loadOverlay(page);
  await page.evaluate(() => globalThis.overlayHarness.setThreads([{
    threadId: "thread-layout-motion",
    anchorGeneration: 1,
    label: "Layout motion thread",
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
        selector: "[data-collab-review-id=\"synthetic-layout-target\"]",
        identity: "synthetic-layout-target",
        offset: { x: 20, y: 15 },
      },
      document: { x: 80, y: 635, width: 1280, height: 720 },
    },
  }]));
  const target = page.getByRole("button", { name: "Layout motion target" });
  const pin = page.getByRole("button", { name: "Open Layout motion thread", includeHidden: true });
  await expect(pin).toBeVisible();

  await page.evaluate(() => globalThis.overlayHarness.moveLayoutSibling());
  await page.waitForTimeout(250);
  const [targetBox, pinBox] = await Promise.all([target.boundingBox(), pin.boundingBox()]);
  expect(targetBox).not.toBeNull();
  expect(pinBox).not.toBeNull();
  expect(targetBox!.x).toBeGreaterThan(70);
  expect(pinBox!.x + (pinBox!.width / 2) - targetBox!.x).toBeCloseTo(20, 0);
  await expect.poll(async () => {
    const finalTarget = await target.boundingBox();
    const finalPin = await pin.boundingBox();
    return Math.round((finalPin?.x ?? 0) + ((finalPin?.width ?? 0) / 2) - (finalTarget?.x ?? 0));
  }).toBe(20);
});

test("unavailable reports are one-shot per Thread generation and retry after callback failure", async ({ page }) => {
  await loadOverlay(page);
  await page.evaluate(() => globalThis.overlayHarness.removeTarget());
  const thread = {
    threadId: "thread-unavailable",
    anchorGeneration: 3,
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
  };

  await page.evaluate((value) => globalThis.overlayHarness.setThreads([value]), thread);
  await page.evaluate((value) => globalThis.overlayHarness.setThreads([value]), thread);
  await expect.poll(() => page.evaluate(() => globalThis.overlayHarness.unavailableAnchors)).toEqual([{
    threadId: "thread-unavailable",
    anchorGeneration: 3,
  }]);

  await page.evaluate(() => globalThis.overlayHarness.setThreads([]));
  await page.evaluate(() => globalThis.overlayHarness.failNextUnavailable());
  expect(await page.evaluate((value) => {
    globalThis.overlayHarness.setThreads([value]);
    return "accepted";
  }, thread)).toBe("accepted");
  await page.waitForTimeout(600);
  expect(await page.evaluate(() => globalThis.overlayHarness.unavailableAnchors)).toEqual([{
    threadId: "thread-unavailable",
    anchorGeneration: 3,
  }]);
  await page.evaluate(() => globalThis.overlayHarness.refresh());
  await expect.poll(() => page.evaluate(() => globalThis.overlayHarness.unavailableAnchors)).toEqual([{
    threadId: "thread-unavailable",
    anchorGeneration: 3,
  }, {
    threadId: "thread-unavailable",
    anchorGeneration: 3,
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
  await expect(page.getByRole("button", { name: "Re-place Legacy synthetic thread" })).toHaveCount(0);
  expect(await page.evaluate(() => globalThis.overlayHarness.replacementRequests.length)).toBe(1);
});

test("a cooperative nested document owns its styles and preserves Pointer and Comment behavior", async ({ page }) => {
  await page.goto(`${HOST_ORIGIN}/nested-overlay.html`);
  const nested = page.frameLocator("iframe[title='Synthetic nested prototype']");
  const action = nested.getByRole("button", { name: "Nested prototype action" });
  await expect(action).toBeVisible();
  const frame = page.frames().find((candidate) => candidate.url().includes("/nested-prototype.html"));
  expect(frame).toBeDefined();
  await expect.poll(() => page.evaluate(() => globalThis.nestedHostHarness.snapshot().state)).toBe("active");

  await page.evaluate(() => globalThis.nestedHostHarness.send({
    type: "anchor",
    mode: "request",
    threadId: "thread-bridged",
    anchorGeneration: 1,
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
        route: "/nested",
        deviceId: "desktop-chromium",
        surfaceId: "nested-cooperative-document",
      },
      element: {
        selector: "[data-collab-review-id=\"nested-action\"]",
        identity: "nested-action",
        offset: { x: 20, y: 15 },
      },
      document: { x: 60, y: 55, width: 1280, height: 720 },
    },
  }));
  await expect(nested.getByRole("button", { name: "Open Bridged nested thread", includeHidden: true })).toHaveCount(1);

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
    context: unknown;
    prototypeClicks(): number;
    unanchorableClicks(): number;
    snapshot(): unknown;
    setMode(mode: "pointer" | "comment"): unknown;
    setThreads(threads: unknown[]): unknown;
    refresh(): unknown;
    growAbove(): void;
    moveTargetToEdge(): void;
    animateTarget(): void;
    animateTargetCosmetically(): void;
    moveLayoutSibling(): void;
    transformBody(): void;
    temporarilyDetachTarget(): Promise<boolean>;
    removeTarget(): void;
    failNextUnavailable(): void;
    destroy(): void;
  };
  var nestedOverlayHarness: {
    prototypeClicks(): number;
    setMode(mode: "pointer" | "comment"): unknown;
  };
  var overlayWithoutStylesResult: unknown;
  var overlayObserverFailureResult: unknown;
  var nestedHostHarness: {
    snapshot(): { state: string };
    send(message: unknown): void;
  };
}
