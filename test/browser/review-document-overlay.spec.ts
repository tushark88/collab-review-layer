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

async function loadCoordinateOverlay(page: Page): Promise<void> {
  page.on("pageerror", (error) => console.error(`browser page error: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") console.error(`browser console error: ${message.text()}`);
  });
  await page.goto(`${HOST_ORIGIN}/coordinate-overlay.html`);
  await expect.poll(() => page.evaluate(() => Boolean(globalThis.coordinateOverlayHarness))).toBe(true);
}

interface DriftSample {
  readonly scrollY: number;
  readonly targetTop: number;
  readonly driftX: number;
  readonly driftY: number;
  readonly coordinateSpace: string | undefined;
}

interface AttachmentSample {
  readonly scrollY: number;
  readonly targetTop: number;
  readonly driftX: number;
  readonly driftY: number;
  readonly coordinateSpace: string | undefined;
}

async function measureSmoothScrollDrift(
  page: Page,
  targetSelector: string,
  pinLabel: string,
  offset: Readonly<{ x: number; y: number }>,
  destination: number,
): Promise<{ samples: DriftSample[]; overlayAnimationFrames: number; overlayStyleReads: number }> {
  return page.evaluate(async ({ targetSelector, pinLabel, offset, destination }) => {
    const target = document.querySelector(targetSelector);
    const pin = [...document.querySelectorAll(".crl-overlay__pin")].find((candidate) => {
      return candidate.getAttribute("aria-label") === pinLabel;
    });
    if (!(target instanceof Element) || !(pin instanceof HTMLElement)) throw new Error("missing drift fixture");
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const samples: DriftSample[] = [];
    const nativeRequestAnimationFrame = requestAnimationFrame;
    const nativeGetComputedStyle = getComputedStyle;
    let overlayAnimationFrames = 0;
    let overlayStyleReads = 0;
    window.requestAnimationFrame = (callback) => {
      overlayAnimationFrames += 1;
      return nativeRequestAnimationFrame.call(window, callback);
    };
    window.getComputedStyle = (...args) => {
      overlayStyleReads += 1;
      return nativeGetComputedStyle.apply(window, args);
    };
    try {
      scrollTo({ top: destination, behavior: "smooth" });
      await new Promise<void>((resolve, reject) => {
        let frames = 0;
        let stableFrames = 0;
        let previousScrollY = scrollY;
        const sample = (): void => {
          const targetBox = target.getBoundingClientRect();
          const pinBox = pin.getBoundingClientRect();
          samples.push({
            scrollY,
            targetTop: targetBox.top,
            driftX: (pinBox.left + (pinBox.width / 2)) - (targetBox.left + offset.x),
            driftY: (pinBox.top + (pinBox.height / 2)) - (targetBox.top + offset.y),
            coordinateSpace: pin.dataset.coordinateSpace,
          });
          frames += 1;
          stableFrames = Math.abs(scrollY - previousScrollY) < 0.01 ? stableFrames + 1 : 0;
          previousScrollY = scrollY;
          if (Math.abs(scrollY - destination) <= 1 && stableFrames >= 3) return resolve();
          if (frames >= 180) return reject(new Error("smooth scroll did not settle"));
          nativeRequestAnimationFrame.call(window, sample);
        };
        nativeRequestAnimationFrame.call(window, sample);
      });
    } finally {
      window.requestAnimationFrame = nativeRequestAnimationFrame;
      window.getComputedStyle = nativeGetComputedStyle;
    }
    return { samples, overlayAnimationFrames, overlayStyleReads };
  }, { targetSelector, pinLabel, offset, destination });
}

function driftMetrics(samples: readonly DriftSample[]): { range: number; maximumJump: number } {
  const drift = samples.map((sample) => Math.hypot(sample.driftX, sample.driftY));
  return {
    range: Math.max(...drift) - Math.min(...drift),
    maximumJump: Math.max(0, ...drift.slice(1).map((value, index) => Math.abs(value - drift[index]!))),
  };
}

async function measureSidebarMotion(
  page: Page,
  state: "open" | "closed",
): Promise<DriftSample[]> {
  return page.evaluate(async (state) => {
    const target = document.querySelector("#normal-scroll-target");
    const pin = [...document.querySelectorAll(".crl-overlay__pin")].find((candidate) => {
      return candidate.getAttribute("aria-label") === "Open Responsive layout thread";
    });
    const layout = document.querySelector("#coordinate-layout");
    if (!(target instanceof Element) || !(pin instanceof HTMLElement) || !(layout instanceof HTMLElement)) {
      throw new Error("missing responsive fixture");
    }
    const samples: DriftSample[] = [];
    layout.dataset.sidebar = state;
    await new Promise<void>((resolve, reject) => {
      let frames = 0;
      let stableFrames = 0;
      let previousLeft = Number.NaN;
      const scheduleSample = (): void => {
        requestAnimationFrame(() => setTimeout(sample, 0));
      };
      const sample = (): void => {
        const targetBox = target.getBoundingClientRect();
        const pinBox = pin.getBoundingClientRect();
        samples.push({
          scrollY,
          targetTop: targetBox.top,
          driftX: (pinBox.left + (pinBox.width / 2)) - (targetBox.left + 40),
          driftY: (pinBox.top + (pinBox.height / 2)) - (targetBox.top + 24),
          coordinateSpace: pin.dataset.coordinateSpace,
        });
        frames += 1;
        stableFrames = Math.abs(targetBox.left - previousLeft) < 0.01 ? stableFrames + 1 : 0;
        previousLeft = targetBox.left;
        if (frames > 10 && stableFrames >= 5) return resolve();
        if (frames >= 120) return reject(new Error("responsive transition did not settle"));
        scheduleSample();
      };
      scheduleSample();
    });
    return samples;
  }, state);
}

async function measureComposerScrollAttachment(
  page: Page,
  targetSelector: string,
  destination: number,
): Promise<AttachmentSample[]> {
  return page.evaluate(async ({ targetSelector, destination }) => {
    const target = document.querySelector(targetSelector);
    const composer = document.querySelector(".crl-overlay__composer");
    if (!(target instanceof Element) || !(composer instanceof HTMLElement)) {
      throw new Error("missing composer attachment fixture");
    }
    const targetStart = target.getBoundingClientRect();
    const composerStart = composer.getBoundingClientRect();
    const baseline = {
      x: composerStart.left - targetStart.left,
      y: composerStart.top - targetStart.top,
    };
    const samples: AttachmentSample[] = [];
    const nativeRequestAnimationFrame = requestAnimationFrame;
    scrollTo({ top: destination, behavior: "smooth" });
    await new Promise<void>((resolve, reject) => {
      let frames = 0;
      let stableFrames = 0;
      let previousScrollY = scrollY;
      const sample = (): void => {
        const targetBox = target.getBoundingClientRect();
        const composerBox = composer.getBoundingClientRect();
        samples.push({
          scrollY,
          targetTop: targetBox.top,
          driftX: (composerBox.left - targetBox.left) - baseline.x,
          driftY: (composerBox.top - targetBox.top) - baseline.y,
          coordinateSpace: composer.dataset.coordinateSpace,
        });
        frames += 1;
        stableFrames = Math.abs(scrollY - previousScrollY) < 0.01 ? stableFrames + 1 : 0;
        previousScrollY = scrollY;
        if (Math.abs(scrollY - destination) <= 1 && stableFrames >= 3) return resolve();
        if (frames >= 180) return reject(new Error("composer smooth scroll did not settle"));
        nativeRequestAnimationFrame.call(window, sample);
      };
      nativeRequestAnimationFrame.call(window, sample);
    });
    return samples;
  }, { targetSelector, destination });
}

test("normal document targets scroll without overlay RAF chasing or frame drift", async ({ page }) => {
  await loadCoordinateOverlay(page);
  await page.evaluate(() => globalThis.coordinateOverlayHarness.setThread({
    threadId: "thread-normal-scroll",
    label: "Normal scroll thread",
    identity: "normal-scroll-target",
    offset: { x: 40, y: 24 },
  }));
  const pin = page.getByRole("button", { name: "Open Normal scroll thread", includeHidden: true });
  await expect(pin).toBeVisible();

  const result = await measureSmoothScrollDrift(
    page,
    "#normal-scroll-target",
    "Open Normal scroll thread",
    { x: 40, y: 24 },
    360,
  );
  const metrics = driftMetrics(result.samples);
  expect(result.samples.length).toBeGreaterThan(3);
  expect(Math.max(...result.samples.map((sample) => sample.scrollY))).toBeGreaterThan(300);
  expect(metrics.range).toBeLessThanOrEqual(1);
  expect(metrics.maximumJump).toBeLessThanOrEqual(1);
  expect(result.overlayAnimationFrames).toBeLessThanOrEqual(2);
  expect(result.overlayStyleReads).toBe(0);
  expect(await pin.evaluate((element) => getComputedStyle(element).position)).toBe("absolute");
  await expect(pin).toHaveAttribute("data-coordinate-space", "document");
});

test("an initially off-screen document target keeps its raw document point while scrolling into view", async ({ page }) => {
  await loadCoordinateOverlay(page);
  await page.evaluate(() => {
    scrollTo(0, 900);
    globalThis.coordinateOverlayHarness.setThread({
      threadId: "thread-offscreen-document",
      label: "Offscreen document thread",
      identity: "normal-scroll-target",
      offset: { x: 40, y: 24 },
    });
  });

  const result = await measureSmoothScrollDrift(
    page,
    "#normal-scroll-target",
    "Open Offscreen document thread",
    { x: 40, y: 24 },
    200,
  );
  const metrics = driftMetrics(result.samples);
  expect(result.samples.some((sample) => sample.targetTop < 0)).toBe(true);
  expect(result.samples.some((sample) => sample.targetTop > 0)).toBe(true);
  expect(metrics.range).toBeLessThanOrEqual(1);
  expect(metrics.maximumJump).toBeLessThanOrEqual(1);
  expect(new Set(result.samples.map((sample) => sample.coordinateSpace))).toEqual(new Set(["document"]));
  expect(result.overlayAnimationFrames).toBeLessThanOrEqual(2);
  expect(result.overlayStyleReads).toBeLessThan(result.samples.length);
});

test("a sticky target switches coordinate space at its threshold without frame drift", async ({ page }) => {
  await loadCoordinateOverlay(page);
  await page.evaluate(() => globalThis.coordinateOverlayHarness.setThread({
    threadId: "thread-sticky-scroll",
    label: "Sticky scroll thread",
    identity: "sticky-scroll-target",
    offset: { x: 30, y: 20 },
  }));
  const pin = page.getByRole("button", { name: "Open Sticky scroll thread", includeHidden: true });
  await expect(pin).toBeVisible();
  await expect(pin).toHaveAttribute("data-coordinate-space", "document");

  const result = await measureSmoothScrollDrift(
    page,
    "#sticky-scroll-target",
    "Open Sticky scroll thread",
    { x: 30, y: 20 },
    650,
  );
  const metrics = driftMetrics(result.samples);
  const beforeThreshold = result.samples.filter((sample) => sample.scrollY < 350);
  const activelySticky = result.samples.filter((sample) => sample.scrollY > 500);
  expect(beforeThreshold.length).toBeGreaterThan(1);
  expect(activelySticky.length).toBeGreaterThan(1);
  expect(new Set(beforeThreshold.map((sample) => sample.coordinateSpace))).toEqual(new Set(["document"]));
  expect(new Set(activelySticky.map((sample) => sample.coordinateSpace))).toEqual(new Set(["viewport"]));
  expect(Math.max(...activelySticky.map((sample) => sample.targetTop)) - Math.min(...activelySticky.map((sample) => sample.targetTop))).toBeLessThanOrEqual(1);
  expect(metrics.range).toBeLessThanOrEqual(1);
  expect(metrics.maximumJump).toBeLessThanOrEqual(1);
  expect(result.overlayAnimationFrames).toBeLessThanOrEqual(2);
  expect(result.overlayStyleReads).toBeGreaterThan(0);
  expect(await pin.evaluate((element) => getComputedStyle(element).position)).toBe("fixed");
});

test("a fixed target and its pin remain viewport-stationary during smooth document scroll", async ({ page }) => {
  await loadCoordinateOverlay(page);
  await page.evaluate(() => globalThis.coordinateOverlayHarness.setThread({
    threadId: "thread-fixed-scroll",
    label: "Fixed scroll thread",
    identity: "fixed-scroll-target",
    offset: { x: 30, y: 20 },
  }));
  const pin = page.getByRole("button", { name: "Open Fixed scroll thread", includeHidden: true });
  await expect(pin).toBeVisible();
  await expect(pin).toHaveAttribute("data-coordinate-space", "viewport");

  const result = await measureSmoothScrollDrift(
    page,
    "#fixed-scroll-target",
    "Open Fixed scroll thread",
    { x: 30, y: 20 },
    650,
  );
  const metrics = driftMetrics(result.samples);
  expect(Math.max(...result.samples.map((sample) => sample.targetTop)) - Math.min(...result.samples.map((sample) => sample.targetTop))).toBeLessThanOrEqual(1);
  expect(new Set(result.samples.map((sample) => sample.coordinateSpace))).toEqual(new Set(["viewport"]));
  expect(metrics.range).toBeLessThanOrEqual(1);
  expect(metrics.maximumJump).toBeLessThanOrEqual(1);
  expect(result.overlayAnimationFrames).toBeLessThanOrEqual(2);
  expect(result.overlayStyleReads).toBe(0);
  expect(await pin.evaluate((element) => getComputedStyle(element).position)).toBe("fixed");
});

test("responsive sidebar close and open keep a document pin attached on every frame", async ({ page }) => {
  await loadCoordinateOverlay(page);
  await page.evaluate(() => globalThis.coordinateOverlayHarness.setThread({
    threadId: "thread-responsive-layout",
    label: "Responsive layout thread",
    identity: "normal-scroll-target",
    offset: { x: 40, y: 24 },
  }));

  const closedSamples = await measureSidebarMotion(page, "closed");
  const closedTargetX = await page.locator("#normal-scroll-target").evaluate((element) => element.getBoundingClientRect().left);
  const openedSamples = await measureSidebarMotion(page, "open");
  const openTargetX = await page.locator("#normal-scroll-target").evaluate((element) => element.getBoundingClientRect().left);
  for (const samples of [closedSamples, openedSamples]) {
    const metrics = driftMetrics(samples);
    expect(Math.max(...samples.map((sample) => sample.driftX)) - Math.min(...samples.map((sample) => sample.driftX))).toBeLessThanOrEqual(1);
    expect(metrics.maximumJump).toBeLessThanOrEqual(1);
    expect(new Set(samples.map((sample) => sample.coordinateSpace))).toEqual(new Set(["document"]));
  }
  expect(Math.max(...closedSamples.map((sample) => sample.driftX))).toBeLessThanOrEqual(1);
  expect(Math.abs(closedSamples.at(-1)!.driftX)).toBeLessThanOrEqual(1);
  expect(Math.abs(closedTargetX - openTargetX)).toBeGreaterThan(50);
});

test("a composer switches with its sticky target and stays attached frame by frame", async ({ page }) => {
  await loadCoordinateOverlay(page);
  await page.evaluate(() => {
    scrollTo(0, 300);
    globalThis.coordinateOverlayHarness.setMode("comment");
  });
  await page.getByRole("button", { name: "Sticky scroll target" }).click({ position: { x: 30, y: 20 } });
  const composer = page.getByRole("dialog", { name: "Add review comment" });
  await expect(composer).toHaveAttribute("data-coordinate-space", "document");

  const samples = await measureComposerScrollAttachment(page, "#sticky-scroll-target", 650);
  const metrics = driftMetrics(samples);
  expect(new Set(samples.filter((sample) => sample.scrollY < 350).map((sample) => sample.coordinateSpace))).toEqual(new Set(["document"]));
  expect(new Set(samples.filter((sample) => sample.scrollY > 500).map((sample) => sample.coordinateSpace))).toEqual(new Set(["viewport"]));
  expect(metrics.range).toBeLessThanOrEqual(1);
  expect(metrics.maximumJump).toBeLessThanOrEqual(1);
  await expect(composer).toHaveCSS("position", "fixed");
});

test("opening a thread reports the pin's current document or viewport attachment", async ({ page }) => {
  await loadCoordinateOverlay(page);
  await page.evaluate(() => {
    globalThis.coordinateOverlayHarness.setMode("comment");
    globalThis.coordinateOverlayHarness.setThread({
      threadId: "thread-open-attachment",
      label: "Open attachment thread",
      identity: "sticky-scroll-target",
      offset: { x: 30, y: 20 },
    });
  });
  const pin = page.getByRole("button", { name: "Open Open attachment thread" });
  await pin.click();
  await page.evaluate(() => scrollTo(0, 650));
  await expect(pin).toHaveAttribute("data-coordinate-space", "viewport");
  await pin.click();

  const opened = await page.evaluate(() => globalThis.coordinateOverlayHarness.openedThreads) as Array<{
    threadId: string;
    attachment: { locationAvailability: string; coordinateSpace: string; x: number; y: number };
  }>;
  expect(opened.map(({ threadId, attachment }) => ({
    threadId,
    locationAvailability: attachment.locationAvailability,
    coordinateSpace: attachment.coordinateSpace,
  }))).toEqual([
    { threadId: "thread-open-attachment", locationAvailability: "available", coordinateSpace: "document" },
    { threadId: "thread-open-attachment", locationAvailability: "available", coordinateSpace: "viewport" },
  ]);
  expect(opened.every(({ attachment }) => Number.isFinite(attachment.x) && Number.isFinite(attachment.y))).toBe(true);
  const changes = await page.evaluate(() => globalThis.coordinateOverlayHarness.attachmentChanges) as Array<{
    threadId: string;
    attachment: { locationAvailability: string; coordinateSpace: string } | undefined;
  }>;
  expect(changes.filter(({ attachment }) => attachment?.locationAvailability === "available").map(({ attachment }) => attachment!.coordinateSpace)).toEqual([
    "document",
    "viewport",
  ]);
});

for (const device of [
  { name: "representative iPhone coordinate spaces", viewport: { width: 390, height: 844 } },
  { name: "representative Android coordinate spaces", viewport: { width: 412, height: 915 } },
]) {
  test(`${device.name} keep normal, sticky, and fixed pins attached frame by frame`, async ({ page }) => {
    await page.setViewportSize(device.viewport);
    await loadCoordinateOverlay(page);
    const cases = [
      { threadId: "mobile-normal", label: "Mobile normal", identity: "normal-scroll-target", selector: "#normal-scroll-target", offset: { x: 30, y: 20 }, spaces: ["document"] },
      { threadId: "mobile-sticky", label: "Mobile sticky", identity: "sticky-scroll-target", selector: "#sticky-scroll-target", offset: { x: 30, y: 20 }, spaces: ["document", "viewport"] },
      { threadId: "mobile-fixed", label: "Mobile fixed", identity: "fixed-scroll-target", selector: "#fixed-scroll-target", offset: { x: 30, y: 20 }, spaces: ["viewport"] },
    ] as const;
    for (const value of cases) {
      await page.evaluate(() => scrollTo(0, 0));
      await page.evaluate((input) => globalThis.coordinateOverlayHarness.setThread(input), value);
      const result = await measureSmoothScrollDrift(page, value.selector, `Open ${value.label}`, value.offset, 650);
      const metrics = driftMetrics(result.samples);
      expect(metrics.range).toBeLessThanOrEqual(1);
      expect(metrics.maximumJump).toBeLessThanOrEqual(1);
      expect(new Set(result.samples.map((sample) => sample.coordinateSpace))).toEqual(new Set(value.spaces));
    }
  });
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
  await expect(page.getByRole("button", { name: "Open Legacy surface thread" })).toBeVisible();
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
  expect(await page.evaluate(() => globalThis.overlayHarness.openedThreads.map(({ threadId }: { threadId: string }) => threadId))).toEqual(["thread-synthetic"]);
  expect(await page.evaluate(() => scrollY)).toBe(scrollBeforeOpen);
  await page.evaluate(() => globalThis.overlayHarness.refresh());
  await pin.click();
  expect(await page.evaluate(() => globalThis.overlayHarness.openedThreads.map(({ threadId }: { threadId: string }) => threadId))).toEqual(["thread-synthetic", "thread-synthetic"]);
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
  expect(await page.evaluate(() => globalThis.overlayHarness.placementDiagnostics)).toEqual([{
    kind: "anchor_unavailable",
    reason: "target_not_rendered",
    threadId: "thread-synthetic",
    anchorGeneration: 1,
  }, {
    kind: "anchor_unavailable",
    reason: "identity_unresolved",
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

test("an unavailable Anchor has no pin and owner-authorized relocation preserves the existing Thread identity", async ({ page }) => {
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
  await expect(page.getByRole("button", { name: "Open Legacy synthetic thread" })).toHaveCount(0);
  await page.evaluate(() => globalThis.overlayHarness.setMode("comment"));
  const recovery = page.getByRole("button", { name: "Open Legacy synthetic thread" });
  await expect(recovery).toBeVisible();
  await recovery.click();
  expect(await page.evaluate(() => globalThis.overlayHarness.openedThreads)).toEqual([{
    threadId: "thread-legacy",
    attachment: {
      locationAvailability: "unavailable",
      recoveryState: "legacy_replacement_required",
    },
  }]);
  expect(await page.evaluate(() => globalThis.overlayHarness.replacementRequests)).toEqual([]);
  await page.evaluate(() => globalThis.overlayHarness.beginAnchorReplacement("thread-legacy"));
  await page.getByRole("button", { name: "Synthetic prototype action" }).click({ position: { x: 35, y: 25 } });

  await expect(recovery).toBeVisible();
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
  await expect(page.getByRole("button", { name: "Open Legacy synthetic thread" })).toBeVisible();
  expect(await page.evaluate(() => globalThis.overlayHarness.replacementRequests.length)).toBe(1);
});

test("unsupported placement is diagnosed as a placement bug and never offered as relocation", async ({ page }) => {
  await loadOverlay(page);
  await page.getByRole("button", { name: "Synthetic prototype action" }).evaluate((element) => {
    (element as HTMLElement).style.transformOrigin = "0 0";
    (element as HTMLElement).style.transform = "perspective(500px) rotateX(20deg)";
  });
  await page.evaluate(() => globalThis.overlayHarness.setThreads([{
    threadId: "thread-placement-bug",
    anchorGeneration: 2,
    label: "Placement bug thread",
    canReplaceAnchor: true,
    anchor: {
      schemaVersion: 2,
      locationAvailability: "available",
      recoveryState: "not_required",
      context: globalThis.overlayHarness.context,
      element: {
        selector: "[data-collab-review-id=\"synthetic-action\"]",
        identity: "synthetic-action",
        offset: { x: 20, y: 15 },
      },
      document: { x: 60, y: 55, width: 1280, height: 720 },
    },
  }]));

  await page.waitForTimeout(600);
  expect(await page.evaluate(() => globalThis.overlayHarness.unavailableAnchors)).toEqual([]);
  expect(await page.evaluate(() => globalThis.overlayHarness.placementDiagnostics)).toEqual([{
    kind: "placement_bug",
    reason: "unsupported_coordinate_projection",
    threadId: "thread-placement-bug",
    anchorGeneration: 2,
  }]);
  await page.evaluate(() => globalThis.overlayHarness.setMode("comment"));
  await expect(page.getByRole("button", { name: "Open Placement bug thread" })).toHaveCount(0);
  expect(await page.evaluate(() => {
    try {
      globalThis.overlayHarness.beginAnchorReplacement("thread-placement-bug");
      return undefined;
    } catch (error) {
      return { name: (error as Error).name, code: (error as { code?: string }).code };
    }
  })).toEqual({ name: "ReviewDocumentOverlayError", code: "invalid_state" });
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
  var coordinateOverlayHarness: {
    submissions: unknown[];
    openedThreads: unknown[];
    attachmentChanges: unknown[];
    unavailableAnchors: unknown[];
    placementDiagnostics: unknown[];
    context: unknown;
    setMode(mode: "pointer" | "comment"): unknown;
    setThread(input: { threadId: string; label: string; identity: string; offset: { x: number; y: number } }): unknown;
    setSidebar(state: "open" | "closed"): void;
    refresh(): unknown;
  };
  var overlayHarness: {
    submissions: unknown[];
    replacementRequests: unknown[];
    openedThreads: Array<{ threadId: string; attachment: unknown }>;
    attachmentChanges: unknown[];
    unavailableAnchors: Array<{ threadId: string; anchorGeneration: number }>;
    placementDiagnostics: unknown[];
    context: unknown;
    prototypeClicks(): number;
    unanchorableClicks(): number;
    snapshot(): unknown;
    setMode(mode: "pointer" | "comment"): unknown;
    setThreads(threads: unknown[]): unknown;
    beginAnchorReplacement(threadId: string): unknown;
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
