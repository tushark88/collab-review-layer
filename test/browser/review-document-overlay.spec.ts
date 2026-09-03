import { expect, test, type Locator, type Page } from "@playwright/test";

const HOST_ORIGIN = "http://127.0.0.1:4173";

async function loadOverlay(page: Page, query = ""): Promise<void> {
  page.on("pageerror", (error) => console.error(`browser page error: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") console.error(`browser console error: ${message.text()}`);
  });
  await page.goto(`${HOST_ORIGIN}/overlay.html${query}`, { waitUntil: "domcontentloaded" });
  await expect.poll(
    () => page.evaluate(() => Boolean(globalThis.overlayHarness)),
    { timeout: 15_000 },
  ).toBe(true);
}

async function loadCoordinateOverlay(page: Page): Promise<void> {
  page.on("pageerror", (error) => console.error(`browser page error: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") console.error(`browser console error: ${message.text()}`);
  });
  await page.goto(`${HOST_ORIGIN}/coordinate-overlay.html`);
  await expect.poll(
    () => page.evaluate(() => Boolean(globalThis.coordinateOverlayHarness)),
    { timeout: 15_000 },
  ).toBe(true);
}

async function elementOffsetFromTarget(target: Locator, surface: Locator): Promise<{ x: number; y: number }> {
  const [targetBox, surfaceBox] = await Promise.all([target.boundingBox(), surface.boundingBox()]);
  if (!targetBox || !surfaceBox) throw new Error("missing attachment geometry");
  return {
    x: Math.round(surfaceBox.x - targetBox.x),
    y: Math.round(surfaceBox.y - targetBox.y),
  };
}

interface DriftSample {
  readonly scrollY: number;
  readonly targetTop: number;
  readonly driftX: number;
  readonly driftY: number;
  readonly coordinateSpace: string | undefined;
}

interface LayoutDriftSample extends DriftSample {
  readonly targetLeft: number;
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
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    });
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

function driftMetrics(samples: readonly DriftSample[]): { maximumDrift: number; maximumJump: number } {
  return {
    maximumDrift: Math.max(0, ...samples.map((sample) => Math.hypot(sample.driftX, sample.driftY))),
    maximumJump: Math.max(0, ...samples.slice(1).map((sample, index) => {
      const previous = samples[index]!;
      return Math.hypot(sample.driftX - previous.driftX, sample.driftY - previous.driftY);
    })),
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

async function measureElementScrollDrift(
  page: Page,
  scrollerSelector: string,
  targetSelector: string,
  pinLabel: string,
  offset: Readonly<{ x: number; y: number }>,
  destination: number,
): Promise<DriftSample[]> {
  return page.evaluate(async ({ scrollerSelector, targetSelector, pinLabel, offset, destination }) => {
    const scroller = document.querySelector(scrollerSelector);
    const target = document.querySelector(targetSelector);
    const pin = [...document.querySelectorAll(".crl-overlay__pin")].find((candidate) => {
      return candidate.getAttribute("aria-label") === pinLabel;
    });
    if (!(scroller instanceof HTMLElement) || !(target instanceof Element) || !(pin instanceof HTMLElement)) {
      throw new Error("missing element-scroll drift fixture");
    }
    const samples: DriftSample[] = [];
    scroller.scrollTo({ top: destination, behavior: "smooth" });
    await new Promise<void>((resolve, reject) => {
      let frames = 0;
      let stableFrames = 0;
      let previousScrollTop = scroller.scrollTop;
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
        stableFrames = Math.abs(scroller.scrollTop - previousScrollTop) < 0.01 ? stableFrames + 1 : 0;
        previousScrollTop = scroller.scrollTop;
        if (Math.abs(scroller.scrollTop - destination) <= 1 && stableFrames >= 3) return resolve();
        if (frames >= 180) return reject(new Error("element smooth scroll did not settle"));
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    return samples;
  }, { scrollerSelector, targetSelector, pinLabel, offset, destination });
}

async function measureElementScrollComposerAttachment(
  page: Page,
  scrollerSelector: string,
  targetSelector: string,
  destination: number,
): Promise<AttachmentSample[]> {
  return page.evaluate(async ({ scrollerSelector, targetSelector, destination }) => {
    const scroller = document.querySelector(scrollerSelector);
    const target = document.querySelector(targetSelector);
    const composer = document.querySelector(".crl-overlay__composer");
    if (!(scroller instanceof HTMLElement) || !(target instanceof Element) || !(composer instanceof HTMLElement)) {
      throw new Error("missing element-scroll composer fixture");
    }
    const targetStart = target.getBoundingClientRect();
    const composerStart = composer.getBoundingClientRect();
    const baseline = { x: composerStart.left - targetStart.left, y: composerStart.top - targetStart.top };
    const samples: AttachmentSample[] = [];
    scroller.scrollTo({ top: destination, behavior: "smooth" });
    await new Promise<void>((resolve, reject) => {
      let frames = 0;
      let stableFrames = 0;
      let previousScrollTop = scroller.scrollTop;
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
        stableFrames = Math.abs(scroller.scrollTop - previousScrollTop) < 0.01 ? stableFrames + 1 : 0;
        previousScrollTop = scroller.scrollTop;
        if (Math.abs(scroller.scrollTop - destination) <= 1 && stableFrames >= 3) return resolve();
        if (frames >= 180) return reject(new Error("element composer scroll did not settle"));
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    return samples;
  }, { scrollerSelector, targetSelector, destination });
}

async function measureRunningLayoutDrift(
  page: Page,
  targetSelector: string,
  pinLabel: string,
  offset: Readonly<{ x: number; y: number }>,
): Promise<LayoutDriftSample[]> {
  return page.evaluate(async ({ targetSelector, pinLabel, offset }) => {
    const target = document.querySelector(targetSelector);
    const pin = [...document.querySelectorAll(".crl-overlay__pin")].find((candidate) => {
      return candidate.getAttribute("aria-label") === pinLabel;
    });
    if (!(target instanceof Element) || !(pin instanceof HTMLElement)) throw new Error("missing layout-motion fixture");
    const samples: LayoutDriftSample[] = [];
    await new Promise<void>((resolve) => {
      let frames = 0;
      const sample = (): void => {
        const targetBox = target.getBoundingClientRect();
        const pinBox = pin.getBoundingClientRect();
        samples.push({
          scrollY,
          targetTop: targetBox.top,
          targetLeft: targetBox.left,
          driftX: (pinBox.left + (pinBox.width / 2)) - (targetBox.left + offset.x),
          driftY: (pinBox.top + (pinBox.height / 2)) - (targetBox.top + offset.y),
          coordinateSpace: pin.dataset.coordinateSpace,
        });
        frames += 1;
        if (frames >= 30) return resolve();
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    return samples;
  }, { targetSelector, pinLabel, offset });
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
  expect(metrics.maximumDrift).toBeLessThanOrEqual(1);
  expect(metrics.maximumJump).toBeLessThanOrEqual(1);
  expect(result.overlayAnimationFrames).toBeLessThanOrEqual(2);
  expect(result.overlayStyleReads).toBe(0);
  expect(await pin.evaluate((element) => getComputedStyle(element).position)).toBe("absolute");
  await expect(pin).toHaveAttribute("data-coordinate-space", "document");
});

test("ordinary document pins re-clamp at viewport edges without RAF or style reads", async ({ page }) => {
  await loadCoordinateOverlay(page);
  await page.evaluate(() => globalThis.coordinateOverlayHarness.setThread({
    threadId: "thread-document-edge",
    label: "Document edge thread",
    identity: "normal-scroll-target",
    offset: { x: 40, y: 4 },
  }));
  const result = await page.evaluate(async () => {
    const target = document.querySelector("#normal-scroll-target");
    const pin = [...document.querySelectorAll(".crl-overlay__pin")].find((candidate) => {
      return candidate.getAttribute("aria-label") === "Open Document edge thread";
    });
    if (!(target instanceof Element) || !(pin instanceof HTMLElement)) throw new Error("missing edge-clamp fixture");
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    });
    const nativeRequestAnimationFrame = requestAnimationFrame;
    const nativeGetComputedStyle = getComputedStyle;
    let overlayAnimationFrames = 0;
    let overlayStyleReads = 0;
    const samples: Array<{ pointY: number; pinTop: number; pinBottom: number }> = [];
    window.requestAnimationFrame = (callback) => {
      overlayAnimationFrames += 1;
      return nativeRequestAnimationFrame.call(window, callback);
    };
    window.getComputedStyle = (...args) => {
      overlayStyleReads += 1;
      return nativeGetComputedStyle.apply(window, args);
    };
    try {
      scrollTo({ top: 520, behavior: "smooth" });
      await new Promise<void>((resolve, reject) => {
        let frames = 0;
        let stableFrames = 0;
        let previousScrollY = scrollY;
        const sample = (): void => {
          const targetBox = target.getBoundingClientRect();
          const pinBox = pin.getBoundingClientRect();
          samples.push({ pointY: targetBox.top + 4, pinTop: pinBox.top, pinBottom: pinBox.bottom });
          frames += 1;
          stableFrames = Math.abs(scrollY - previousScrollY) < 0.01 ? stableFrames + 1 : 0;
          previousScrollY = scrollY;
          if (Math.abs(scrollY - 520) <= 1 && stableFrames >= 3) return resolve();
          if (frames >= 180) return reject(new Error("edge scroll did not settle"));
          nativeRequestAnimationFrame.call(window, sample);
        };
        nativeRequestAnimationFrame.call(window, sample);
      });
    } finally {
      window.requestAnimationFrame = nativeRequestAnimationFrame;
      window.getComputedStyle = nativeGetComputedStyle;
    }
    return { samples, overlayAnimationFrames, overlayStyleReads, viewportHeight: innerHeight };
  });
  const visiblePointSamples = result.samples.filter(({ pointY }) => pointY >= 0 && pointY <= result.viewportHeight);
  expect(visiblePointSamples.some(({ pointY }) => pointY < 10)).toBe(true);
  expect(Math.min(...visiblePointSamples.map(({ pinTop }) => pinTop))).toBeGreaterThanOrEqual(-0.5);
  expect(Math.max(...visiblePointSamples.map(({ pinBottom }) => pinBottom))).toBeLessThanOrEqual(result.viewportHeight + 0.5);
  expect(result.overlayAnimationFrames).toBeLessThanOrEqual(2);
  expect(result.overlayStyleReads).toBe(0);
});

test("an ordinary document composer re-clamps while its anchor remains in the viewport", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 640 });
  await loadCoordinateOverlay(page);
  await page.evaluate(() => {
    scrollTo(0, 300);
    globalThis.coordinateOverlayHarness.setMode("comment");
  });
  await page.getByRole("button", { name: "Normal scroll target" }).click({ position: { x: 80, y: 70 } });
  const composer = page.getByRole("dialog", { name: "Add review comment" });
  await expect(composer).toBeVisible();
  await expect(composer).toHaveAttribute("data-coordinate-space", "document");

  const result = await page.evaluate(async () => {
    const target = document.querySelector("#normal-scroll-target");
    const composer = document.querySelector(".crl-overlay__composer");
    if (!(target instanceof Element) || !(composer instanceof HTMLElement)) {
      throw new Error("missing document composer edge fixture");
    }
    scrollTo(0, 0);
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const targetBox = target.getBoundingClientRect();
    const composerBox = composer.getBoundingClientRect();
    return {
      anchorY: targetBox.top + 70,
      composerTop: composerBox.top,
      composerBottom: composerBox.bottom,
      viewportHeight: innerHeight,
      position: getComputedStyle(composer).position,
    };
  });

  expect(result.anchorY).toBeGreaterThanOrEqual(0);
  expect(result.anchorY).toBeLessThanOrEqual(result.viewportHeight);
  expect(result.composerTop).toBeGreaterThanOrEqual(7.5);
  expect(result.composerBottom).toBeLessThanOrEqual(result.viewportHeight - 7.5);
  expect(result.position).toBe("absolute");
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
  expect(metrics.maximumDrift).toBeLessThanOrEqual(1);
  expect(metrics.maximumJump).toBeLessThanOrEqual(1);
  expect(new Set(result.samples.map((sample) => sample.coordinateSpace))).toEqual(new Set(["document"]));
  expect(result.overlayAnimationFrames).toBeLessThanOrEqual(2);
  // Entering the viewport permits one bounded paint/placement revalidation; the
  // ceiling is deliberately independent of scroll duration and sampled frames.
  expect(result.overlayStyleReads).toBeLessThanOrEqual(40);
});

test("an off-screen document target is revalidated as it approaches the viewport", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 600 });
  await loadCoordinateOverlay(page);
  await page.evaluate(() => {
    const sheet = [...document.styleSheets].find((candidate) => candidate.href?.endsWith("/coordinate-overlay.css"));
    if (!sheet) throw new Error("missing writable coordinate fixture stylesheet");
    sheet.insertRule("#offscreen-revalidation-target { position:absolute;left:300px;top:1600px;width:140px;height:64px }");
    const target = document.createElement("button");
    target.id = "offscreen-revalidation-target";
    target.type = "button";
    target.dataset.collabReviewId = "offscreen-revalidation-target";
    target.textContent = "Offscreen revalidation target";
    document.body.appendChild(target);
    globalThis.coordinateOverlayHarness.setThread({
      threadId: "thread-offscreen-revalidation",
      label: "Offscreen revalidation thread",
      identity: "offscreen-revalidation-target",
      offset: { x: 40, y: 24 },
    });
  });
  const pin = page.getByRole("button", { name: "Open Offscreen revalidation thread", includeHidden: true });
  await expect(pin).toHaveAttribute("data-coordinate-space", "document");

  const result = await page.evaluate(async () => {
    const target = document.querySelector("#offscreen-revalidation-target");
    const pin = [...document.querySelectorAll(".crl-overlay__pin")].find((candidate) => {
      return candidate.getAttribute("aria-label") === "Open Offscreen revalidation thread";
    });
    const style = [...document.styleSheets].find((sheet) => {
      return [...sheet.cssRules].some((rule) => rule instanceof CSSStyleRule && rule.selectorText === "#offscreen-revalidation-target");
    });
    const rule = style && [...style.cssRules].find((candidate) => {
      return candidate instanceof CSSStyleRule && candidate.selectorText === "#offscreen-revalidation-target";
    });
    if (!(target instanceof Element) || !(pin instanceof HTMLElement) || !(rule instanceof CSSStyleRule)) {
      throw new Error("missing offscreen revalidation fixture");
    }
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const nativeRequestAnimationFrame = requestAnimationFrame;
    let overlayAnimationFrames = 0;
    window.requestAnimationFrame = (callback) => {
      overlayAnimationFrames += 1;
      return nativeRequestAnimationFrame.call(window, callback);
    };
    try {
      rule.style.top = "900px";
      scrollTo({ top: 700, behavior: "smooth" });
      await new Promise<void>((resolve, reject) => {
        let frames = 0;
        let stableFrames = 0;
        let previousScrollY = scrollY;
        const sample = (): void => {
          frames += 1;
          stableFrames = Math.abs(scrollY - previousScrollY) < 0.01 ? stableFrames + 1 : 0;
          previousScrollY = scrollY;
          if (Math.abs(scrollY - 700) <= 1 && stableFrames >= 3) return resolve();
          if (frames >= 180) return reject(new Error("offscreen revalidation scroll did not settle"));
          nativeRequestAnimationFrame.call(window, sample);
        };
        nativeRequestAnimationFrame.call(window, sample);
      });
    } finally {
      window.requestAnimationFrame = nativeRequestAnimationFrame;
    }
    const targetBox = target.getBoundingClientRect();
    const pinBox = pin.getBoundingClientRect();
    return {
      targetTop: targetBox.top,
      drift: Math.hypot(
        pinBox.left + (pinBox.width / 2) - (targetBox.left + 40),
        pinBox.top + (pinBox.height / 2) - (targetBox.top + 24),
      ),
      overlayAnimationFrames,
      viewportHeight: innerHeight,
    };
  });

  expect(result.targetTop).toBeGreaterThanOrEqual(0);
  expect(result.targetTop).toBeLessThan(result.viewportHeight);
  expect(result.drift).toBeLessThanOrEqual(1);
  expect(result.overlayAnimationFrames).toBeLessThanOrEqual(3);
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
  expect(metrics.maximumDrift).toBeLessThanOrEqual(1);
  expect(metrics.maximumJump).toBeLessThanOrEqual(1);
  expect(result.overlayAnimationFrames).toBeLessThanOrEqual(2);
  expect(result.overlayStyleReads).toBeGreaterThan(0);
  expect(await pin.evaluate((element) => getComputedStyle(element).position)).toBe("fixed");
});

test("a transformed sticky surface switches at its untransformed threshold without frame drift", async ({ page }) => {
  await loadCoordinateOverlay(page);
  await page.evaluate(() => {
    const surface = document.querySelector("#sticky-surface");
    if (!(surface instanceof HTMLElement)) throw new Error("missing transformed sticky fixture");
    surface.style.transform = "translateY(10px)";
    globalThis.coordinateOverlayHarness.setThread({
      threadId: "thread-transformed-sticky-scroll",
      label: "Transformed sticky scroll thread",
      identity: "sticky-scroll-target",
      offset: { x: 30, y: 20 },
    });
  });

  const result = await measureSmoothScrollDrift(
    page,
    "#sticky-scroll-target",
    "Open Transformed sticky scroll thread",
    { x: 30, y: 20 },
    650,
  );
  const beforeThreshold = result.samples.filter(({ scrollY }) => scrollY < 350);
  const activelySticky = result.samples.filter(({ scrollY }) => scrollY > 500);
  expect(new Set(beforeThreshold.map(({ coordinateSpace }) => coordinateSpace))).toEqual(new Set(["document"]));
  expect(new Set(activelySticky.map(({ coordinateSpace }) => coordinateSpace))).toEqual(new Set(["viewport"]));
  expect(driftMetrics(result.samples).maximumDrift).toBeLessThanOrEqual(1);
  expect(driftMetrics(result.samples).maximumJump).toBeLessThanOrEqual(1);
});

test("a translated wrapper does not distort a descendant sticky threshold", async ({ page }) => {
  await loadCoordinateOverlay(page);
  await page.evaluate(() => {
    const wrapper = document.querySelector("#coordinate-layout");
    if (!(wrapper instanceof HTMLElement)) throw new Error("missing translated sticky wrapper fixture");
    wrapper.style.transform = "translateY(10px)";
    globalThis.coordinateOverlayHarness.setThread({
      threadId: "thread-translated-sticky-wrapper",
      label: "Translated sticky wrapper thread",
      identity: "sticky-scroll-target",
      offset: { x: 30, y: 20 },
    });
  });

  const result = await measureSmoothScrollDrift(
    page,
    "#sticky-scroll-target",
    "Open Translated sticky wrapper thread",
    { x: 30, y: 20 },
    650,
  );
  const beforeThreshold = result.samples.filter(({ scrollY }) => scrollY < 350);
  const activelySticky = result.samples.filter(({ scrollY }) => scrollY > 500);
  expect(new Set(beforeThreshold.map(({ coordinateSpace }) => coordinateSpace))).toEqual(new Set(["document"]));
  expect(new Set(activelySticky.map(({ coordinateSpace }) => coordinateSpace))).toEqual(new Set(["viewport"]));
  expect(driftMetrics(result.samples).maximumDrift).toBeLessThanOrEqual(1);
  expect(driftMetrics(result.samples).maximumJump).toBeLessThanOrEqual(1);
});

test("an unsupported rotated sticky transform fails closed instead of chasing scroll", async ({ page }) => {
  await loadCoordinateOverlay(page);
  await page.evaluate(() => {
    const surface = document.querySelector("#sticky-surface");
    if (!(surface instanceof HTMLElement)) throw new Error("missing rotated sticky fixture");
    surface.style.rotate = "5deg";
    globalThis.coordinateOverlayHarness.setThread({
      threadId: "thread-rotated-sticky",
      label: "Rotated sticky thread",
      identity: "sticky-scroll-target",
      offset: { x: 60, y: 32 },
    });
  });

  await expect(page.getByRole("button", { name: "Open Rotated sticky thread" })).toHaveCount(0);
  expect(await page.evaluate(() => globalThis.coordinateOverlayHarness.placementDiagnostics)).toEqual([{
    kind: "placement_bug",
    reason: "unsupported_coordinate_projection",
    threadId: "thread-rotated-sticky",
    anchorGeneration: 1,
  }]);
  await page.evaluate(() => scrollTo(0, 650));
  await expect(page.getByRole("button", { name: "Open Rotated sticky thread" })).toHaveCount(0);
  expect(await page.evaluate(() => globalThis.coordinateOverlayHarness.placementDiagnostics)).toHaveLength(1);
});

test("a composer follows the transform-neutral sticky threshold frame by frame", async ({ page }) => {
  await loadCoordinateOverlay(page);
  await page.evaluate(() => {
    const surface = document.querySelector("#sticky-surface");
    if (!(surface instanceof HTMLElement)) throw new Error("missing transformed sticky composer fixture");
    surface.style.transform = "translateY(10px)";
    scrollTo(0, 300);
    globalThis.coordinateOverlayHarness.setMode("comment");
  });
  await page.getByRole("button", { name: "Sticky scroll target" }).click({ position: { x: 30, y: 20 } });
  await expect(page.getByRole("dialog", { name: "Add review comment" })).toBeVisible();

  const samples = await measureComposerScrollAttachment(page, "#sticky-scroll-target", 650);
  const beforeThreshold = samples.filter(({ scrollY }) => scrollY < 350);
  const activelySticky = samples.filter(({ scrollY }) => scrollY > 500);
  expect(new Set(beforeThreshold.map(({ coordinateSpace }) => coordinateSpace))).toEqual(new Set(["document"]));
  expect(new Set(activelySticky.map(({ coordinateSpace }) => coordinateSpace))).toEqual(new Set(["viewport"]));
  expect(driftMetrics(samples).maximumDrift).toBeLessThanOrEqual(1);
  expect(driftMetrics(samples).maximumJump).toBeLessThanOrEqual(1);
});

test("a root scrolling element remains the viewport scrollport for active sticky placement", async ({ page }) => {
  await loadCoordinateOverlay(page);
  await page.evaluate(() => {
    document.documentElement.style.overflowY = "scroll";
    globalThis.coordinateOverlayHarness.setThread({
      threadId: "thread-root-scroll-sticky",
      label: "Root scroll sticky thread",
      identity: "sticky-scroll-target",
      offset: { x: 30, y: 20 },
    });
  });
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).overflowY)).toBe("scroll");

  const result = await measureSmoothScrollDrift(
    page,
    "#sticky-scroll-target",
    "Open Root scroll sticky thread",
    { x: 30, y: 20 },
    650,
  );
  const beforeThreshold = result.samples.filter(({ scrollY }) => scrollY < 350);
  const activelySticky = result.samples.filter(({ scrollY }) => scrollY > 500);
  expect(new Set(beforeThreshold.map(({ coordinateSpace }) => coordinateSpace))).toEqual(new Set(["document"]));
  expect(new Set(activelySticky.map(({ coordinateSpace }) => coordinateSpace))).toEqual(new Set(["viewport"]));
  expect(driftMetrics(result.samples).maximumDrift).toBeLessThanOrEqual(1);
  expect(driftMetrics(result.samples).maximumJump).toBeLessThanOrEqual(1);
});

test("a body scrollport remains nested when root overflow prevents viewport propagation", async ({ page }) => {
  await loadCoordinateOverlay(page);
  const state = await page.evaluate(() => {
    const root = document.querySelector("[data-collab-review-layer='overlay']");
    for (const child of [...document.body.children]) {
      if (child !== root) child.remove();
    }
    document.documentElement.style.overflow = "hidden";
    document.body.style.minHeight = "0";
    document.body.style.height = "240px";
    document.body.style.overflow = "auto";
    const content = document.createElement("div");
    content.style.height = "900px";
    const target = document.createElement("button");
    target.type = "button";
    target.dataset.collabReviewId = "nested-body-sticky-target";
    target.textContent = "Nested body sticky target";
    target.style.cssText = "position:sticky;top:16px;display:block;width:140px;height:64px;margin-top:300px";
    content.appendChild(target);
    document.body.insertBefore(content, root);
    document.body.scrollTop = 160;
    globalThis.coordinateOverlayHarness.setThread({
      threadId: "thread-nested-body-sticky",
      label: "Nested body sticky thread",
      identity: "nested-body-sticky-target",
      offset: { x: 40, y: 24 },
    });
    return {
      scrollingElement: document.scrollingElement?.tagName,
      rootOverflow: getComputedStyle(document.documentElement).overflowY,
      bodyOverflow: getComputedStyle(document.body).overflowY,
      bodyClientHeight: document.body.clientHeight,
      bodyScrollHeight: document.body.scrollHeight,
    };
  });
  expect(state.scrollingElement).toBe("HTML");
  expect(state.rootOverflow).toBe("hidden");
  expect(state.bodyOverflow).toBe("auto");
  expect(state.bodyScrollHeight).toBeGreaterThan(state.bodyClientHeight);

  const pin = page.getByRole("button", { name: "Open Nested body sticky thread", includeHidden: true });
  await expect(pin).toHaveAttribute("data-coordinate-space", "document");
  const drift = await page.evaluate(async () => {
    const target = document.querySelector('[data-collab-review-id="nested-body-sticky-target"]');
    const pin = document.querySelector('.crl-overlay__pin[aria-label="Open Nested body sticky thread"]');
    if (!(target instanceof HTMLElement) || !(pin instanceof HTMLElement)) throw new Error("missing nested body fixture");
    const read = (): { x: number; y: number } => {
      const targetRect = target.getBoundingClientRect();
      const pinRect = pin.getBoundingClientRect();
      return {
        x: pinRect.left + (pinRect.width / 2) - (targetRect.left + 40),
        y: pinRect.top + (pinRect.height / 2) - (targetRect.top + 24),
      };
    };
    const before = read();
    document.body.scrollTop = 220;
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const after = read();
    return { before, after };
  });
  expect(Math.hypot(drift.before.x, drift.before.y)).toBeLessThanOrEqual(1);
  expect(Math.hypot(drift.after.x, drift.after.y)).toBeLessThanOrEqual(1);
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
  expect(metrics.maximumDrift).toBeLessThanOrEqual(1);
  expect(metrics.maximumJump).toBeLessThanOrEqual(1);
  expect(result.overlayAnimationFrames).toBeLessThanOrEqual(2);
  expect(result.overlayStyleReads).toBe(0);
  expect(await pin.evaluate((element) => getComputedStyle(element).position)).toBe("fixed");
});

test("a viewport-fixed target escapes unrelated ancestor overflow clipping", async ({ page }) => {
  await loadCoordinateOverlay(page);
  await page.evaluate(() => {
    const clip = document.createElement("div");
    clip.id = "fixed-overflow-ancestor";
    clip.style.cssText = "position:absolute;left:16px;top:360px;width:40px;height:40px;overflow:hidden";
    const target = document.createElement("button");
    target.type = "button";
    target.dataset.collabReviewId = "escaped-fixed-target";
    target.textContent = "Escaped fixed target";
    target.style.cssText = "position:fixed;left:360px;top:120px;width:140px;height:64px";
    clip.appendChild(target);
    document.body.appendChild(clip);
    globalThis.coordinateOverlayHarness.setThread({
      threadId: "thread-escaped-fixed",
      label: "Escaped fixed thread",
      identity: "escaped-fixed-target",
      offset: { x: 40, y: 24 },
    });
  });

  const target = page.getByRole("button", { name: "Escaped fixed target" });
  const pin = page.getByRole("button", { name: "Open Escaped fixed thread", includeHidden: true });
  await expect(target).toBeVisible();
  await expect(pin).toBeVisible();
  await expect(pin).toHaveAttribute("data-coordinate-space", "viewport");

  await page.evaluate(() => globalThis.coordinateOverlayHarness.setMode("comment"));
  await target.click({ position: { x: 100, y: 50 } });
  await expect(page.getByRole("dialog", { name: "Add review comment" })).toBeVisible();
});

test("a fixed target defers intermediate overflow clipping until its transformed containing block", async ({ page }) => {
  await loadCoordinateOverlay(page);
  await page.evaluate(() => {
    const containingBlock = document.createElement("div");
    containingBlock.id = "transformed-fixed-containing-block";
    containingBlock.style.cssText = "position:absolute;left:280px;top:100px;width:180px;height:120px;transform:translateZ(0)";
    const clip = document.createElement("div");
    clip.id = "intermediate-fixed-clip";
    clip.style.cssText = "width:40px;height:40px;overflow:hidden";
    const target = document.createElement("button");
    target.type = "button";
    target.dataset.collabReviewId = "contained-fixed-target";
    target.textContent = "Contained fixed target";
    target.style.cssText = "position:fixed;left:160px;top:20px;width:120px;height:64px";
    clip.appendChild(target);
    containingBlock.appendChild(clip);
    document.body.appendChild(containingBlock);
    globalThis.coordinateOverlayHarness.setThread({
      threadId: "thread-contained-fixed",
      label: "Contained fixed thread",
      identity: "contained-fixed-target",
      offset: { x: 40, y: 24 },
    });
  });

  const pin = page.getByRole("button", { name: "Open Contained fixed thread", includeHidden: true });
  await expect(pin).toBeVisible();
  await expect(pin).toHaveAttribute("data-coordinate-space", "document");

  await page.evaluate(() => {
    const containingBlock = document.querySelector("#transformed-fixed-containing-block");
    if (!(containingBlock instanceof HTMLElement)) throw new Error("missing transformed containing block");
    containingBlock.style.overflow = "hidden";
    globalThis.coordinateOverlayHarness.refresh();
  });
  await expect(pin).toBeHidden();
});

test("an absolute target defers intermediate overflow clipping until its positioned containing block", async ({ page }) => {
  await loadCoordinateOverlay(page);
  await page.evaluate(() => {
    const containingBlock = document.createElement("div");
    containingBlock.id = "positioned-absolute-containing-block";
    containingBlock.style.cssText = "position:relative;margin-left:280px;margin-top:100px;width:180px;height:120px";
    const clip = document.createElement("div");
    clip.id = "intermediate-absolute-clip";
    clip.style.cssText = "width:40px;height:40px;overflow:hidden";
    const target = document.createElement("button");
    target.type = "button";
    target.dataset.collabReviewId = "contained-absolute-target";
    target.textContent = "Contained absolute target";
    target.style.cssText = "position:absolute;left:160px;top:20px;width:120px;height:64px";
    clip.appendChild(target);
    containingBlock.appendChild(clip);
    document.body.appendChild(containingBlock);
    globalThis.coordinateOverlayHarness.setThread({
      threadId: "thread-contained-absolute",
      label: "Contained absolute thread",
      identity: "contained-absolute-target",
      offset: { x: 40, y: 24 },
    });
  });

  const pin = page.getByRole("button", { name: "Open Contained absolute thread", includeHidden: true });
  await expect(pin).toBeVisible();
  await expect(pin).toHaveAttribute("data-coordinate-space", "document");

  await page.evaluate(() => {
    const containingBlock = document.querySelector("#positioned-absolute-containing-block");
    if (!(containingBlock instanceof HTMLElement)) throw new Error("missing positioned containing block");
    containingBlock.style.overflow = "hidden";
    globalThis.coordinateOverlayHarness.refresh();
  });
  await expect(pin).toBeHidden();
});

test("a boxless positioned ancestor does not intercept an absolute target's containing block", async ({ page }) => {
  await loadCoordinateOverlay(page);
  await page.evaluate(() => {
    const containingBlock = document.createElement("div");
    containingBlock.id = "box-generating-absolute-containing-block";
    containingBlock.style.cssText = "position:relative;margin-left:280px;margin-top:100px;width:180px;height:120px";
    const clip = document.createElement("div");
    clip.id = "boxless-intermediate-absolute-clip";
    clip.style.cssText = "width:40px;height:40px;overflow:hidden";
    const boxless = document.createElement("div");
    boxless.style.cssText = "display:contents;position:relative";
    const target = document.createElement("button");
    target.type = "button";
    target.dataset.collabReviewId = "boxless-contained-absolute-target";
    target.textContent = "Boxless contained absolute target";
    target.style.cssText = "position:absolute;left:160px;top:20px;width:120px;height:64px";
    boxless.appendChild(target);
    clip.appendChild(boxless);
    containingBlock.appendChild(clip);
    document.body.appendChild(containingBlock);
    globalThis.coordinateOverlayHarness.setThread({
      threadId: "thread-boxless-contained-absolute",
      label: "Boxless contained absolute thread",
      identity: "boxless-contained-absolute-target",
      offset: { x: 40, y: 24 },
    });
  });

  const pin = page.getByRole("button", { name: "Open Boxless contained absolute thread", includeHidden: true });
  await expect(pin).toBeVisible();
  await expect(pin).toHaveAttribute("data-coordinate-space", "document");
});

test("an overflow-scrolled target and its composer stay attached frame by frame", async ({ page }) => {
  await loadCoordinateOverlay(page);
  await page.locator("#overflow-scroll-surface").evaluate((element) => { element.scrollTop = 220; });
  await page.evaluate(() => globalThis.coordinateOverlayHarness.setThread({
    threadId: "thread-overflow-scroll",
    label: "Overflow scroll thread",
    identity: "overflow-scroll-target",
    offset: { x: 40, y: 24 },
  }));
  const pin = page.getByRole("button", { name: "Open Overflow scroll thread", includeHidden: true });
  await expect(pin).toHaveAttribute("data-coordinate-space", "document");

  const pinSamples = await measureElementScrollDrift(
    page,
    "#overflow-scroll-surface",
    "#overflow-scroll-target",
    "Open Overflow scroll thread",
    { x: 40, y: 24 },
    300,
  );
  expect(driftMetrics(pinSamples).maximumDrift).toBeLessThanOrEqual(1);
  expect(driftMetrics(pinSamples).maximumJump).toBeLessThanOrEqual(1);
  expect(new Set(pinSamples.map((sample) => sample.coordinateSpace))).toEqual(new Set(["document"]));

  await page.locator("#overflow-scroll-surface").evaluate((element) => { element.scrollTop = 220; });
  await page.evaluate(() => globalThis.coordinateOverlayHarness.setMode("comment"));
  await page.getByRole("button", { name: "Overflow scroll target" }).click({ position: { x: 40, y: 24 } });
  const composerSamples = await measureElementScrollComposerAttachment(
    page,
    "#overflow-scroll-surface",
    "#overflow-scroll-target",
    300,
  );
  expect(driftMetrics(composerSamples).maximumDrift).toBeLessThanOrEqual(1);
  expect(driftMetrics(composerSamples).maximumJump).toBeLessThanOrEqual(1);
  expect(new Set(composerSamples.map((sample) => sample.coordinateSpace))).toEqual(new Set(["document"]));
});

test("an active sticky target inside a movable nested scrollport follows outer document scroll", async ({ page }) => {
  await loadCoordinateOverlay(page);
  await page.evaluate(() => {
    const scroller = document.createElement("div");
    scroller.id = "nested-sticky-scrollport";
    scroller.style.position = "absolute";
    scroller.style.top = "900px";
    scroller.style.left = "280px";
    scroller.style.width = "240px";
    scroller.style.height = "180px";
    scroller.style.overflow = "auto";
    const content = document.createElement("div");
    content.style.height = "800px";
    const target = document.createElement("button");
    target.id = "nested-sticky-target";
    target.type = "button";
    target.dataset.collabReviewId = "nested-sticky-target";
    target.textContent = "Nested sticky target";
    target.style.position = "sticky";
    target.style.top = "16px";
    target.style.width = "140px";
    target.style.height = "64px";
    target.style.marginTop = "300px";
    content.appendChild(target);
    scroller.appendChild(content);
    document.body.appendChild(scroller);
    scroller.scrollTop = 320;
    scrollTo(0, 650);
    globalThis.coordinateOverlayHarness.setThread({
      threadId: "thread-nested-sticky",
      label: "Nested sticky thread",
      identity: "nested-sticky-target",
      offset: { x: 40, y: 24 },
    });
  });
  const pin = page.getByRole("button", { name: "Open Nested sticky thread", includeHidden: true });
  await expect(pin).toHaveAttribute("data-coordinate-space", "document");

  const result = await measureSmoothScrollDrift(
    page,
    "#nested-sticky-target",
    "Open Nested sticky thread",
    { x: 40, y: 24 },
    820,
  );
  expect(Math.max(...result.samples.map(({ targetTop }) => targetTop)) - Math.min(...result.samples.map(({ targetTop }) => targetTop))).toBeGreaterThan(140);
  expect(new Set(result.samples.map(({ coordinateSpace }) => coordinateSpace))).toEqual(new Set(["document"]));
  expect(driftMetrics(result.samples).maximumDrift).toBeLessThanOrEqual(1);
  expect(driftMetrics(result.samples).maximumJump).toBeLessThanOrEqual(1);
});

test("overflow clipping hides detached pins without orphaning their anchors", async ({ page }) => {
  await loadCoordinateOverlay(page);
  const cases = [
    {
      threadId: "thread-auto-clip",
      label: "Auto clip thread",
      identity: "overflow-scroll-target",
      reveal: async () => page.locator("#overflow-scroll-surface").evaluate((element) => { element.scrollTop = 260; }),
    },
    {
      threadId: "thread-hidden-clip",
      label: "Hidden clip thread",
      identity: "hidden-clip-target",
      reveal: async () => page.evaluate(() => globalThis.coordinateOverlayHarness.revealHiddenClip()),
    },
    {
      threadId: "thread-nested-clip",
      label: "Nested clip thread",
      identity: "nested-clip-target",
      reveal: async () => page.evaluate(() => globalThis.coordinateOverlayHarness.revealNestedClip()),
    },
  ] as const;

  for (const scenario of cases) {
    await page.evaluate((value) => globalThis.coordinateOverlayHarness.setThread({
      threadId: value.threadId,
      label: value.label,
      identity: value.identity,
      offset: { x: 40, y: 24 },
    }), { threadId: scenario.threadId, label: scenario.label, identity: scenario.identity });
    const pin = page.getByRole("button", { name: `Open ${scenario.label}`, includeHidden: true });
    await expect(pin).toBeHidden();
    expect(await page.evaluate(() => globalThis.coordinateOverlayHarness.unavailableAnchors)).toEqual([]);
    expect(await page.evaluate(() => {
      const latest = globalThis.coordinateOverlayHarness.attachmentChanges.at(-1) as {
        attachment?: { locationAvailability?: string; visible?: boolean };
      } | undefined;
      return latest?.attachment;
    })).toMatchObject({ locationAvailability: "available", visible: false });
    await scenario.reveal();
    await expect(pin).toBeVisible();
    expect(await page.evaluate(() => {
      const latest = globalThis.coordinateOverlayHarness.attachmentChanges.at(-1) as { attachment?: { visible?: boolean } } | undefined;
      return latest?.attachment?.visible;
    })).toBe(true);
  }
});

test("overflow clipping uses the padding edge and honors the clip margin", async ({ page }) => {
  await loadCoordinateOverlay(page);
  await page.evaluate(() => {
    const clip = document.createElement("div");
    clip.id = "bordered-overflow-clip";
    clip.style.cssText = "position:absolute;left:300px;top:120px;width:200px;height:100px;border:40px solid transparent;overflow:hidden";
    const target = document.createElement("button");
    target.type = "button";
    target.dataset.collabReviewId = "bordered-overflow-target";
    target.textContent = "Bordered overflow target";
    target.style.cssText = "position:absolute;left:-40px;top:8px;width:64px;height:64px";
    clip.appendChild(target);
    document.body.appendChild(clip);
    globalThis.coordinateOverlayHarness.setThread({
      threadId: "thread-bordered-overflow",
      label: "Bordered overflow thread",
      identity: "bordered-overflow-target",
      offset: { x: 20, y: 24 },
    });
  });

  const pin = page.getByRole("button", { name: "Open Bordered overflow thread", includeHidden: true });
  await expect(pin).toBeHidden();

  const clipMarginResult = await page.evaluate(() => {
    const clip = document.querySelector("#bordered-overflow-clip");
    if (!(clip instanceof HTMLElement)) throw new Error("missing bordered overflow fixture");
    clip.style.borderWidth = "20px";
    clip.style.overflowX = "visible";
    clip.style.overflowY = "clip";
    clip.style.overflowClipMargin = "12px";
    const target = clip.querySelector("[data-collab-review-id='bordered-overflow-target']");
    if (!(target instanceof HTMLElement)) throw new Error("missing bordered overflow target");
    target.style.left = "-20px";
    target.style.top = "-20px";
    globalThis.coordinateOverlayHarness.setThread({
      threadId: "thread-bordered-overflow",
      label: "Bordered overflow thread",
      identity: "bordered-overflow-target",
      offset: { x: 14, y: 14 },
    });
    return getComputedStyle(clip).overflowClipMargin;
  });
  expect(clipMarginResult).toContain("12px");
  await expect(pin).toBeVisible();

  await page.evaluate(() => globalThis.coordinateOverlayHarness.setThread({
    threadId: "thread-bordered-overflow",
    label: "Bordered overflow thread",
    identity: "bordered-overflow-target",
    offset: { x: 14, y: 4 },
  }));
  await expect(pin).toBeHidden();
});

test("a target's own overflow clipping hides its signed-offset pin and open composer without orphaning", async ({ page }) => {
  await loadCoordinateOverlay(page);
  await page.evaluate(() => {
    const target = document.createElement("button");
    target.type = "button";
    target.dataset.collabReviewId = "self-clipped-target";
    target.textContent = "Self-clipped target";
    target.style.cssText = "position:fixed;left:300px;top:120px;box-sizing:border-box;width:120px;height:60px;padding:0;border:0;overflow:visible";
    document.body.appendChild(target);
    globalThis.coordinateOverlayHarness.setThread({
      threadId: "thread-self-clipped",
      label: "Self-clipped thread",
      identity: "self-clipped-target",
      schemaVersion: 3,
      offset: { x: -10, y: -5 },
    });
  });

  const pin = page.getByRole("button", { name: "Open Self-clipped thread", includeHidden: true });
  await expect(pin).toBeVisible();
  await page.evaluate(() => globalThis.coordinateOverlayHarness.setMode("comment"));
  await page.getByRole("button", { name: "Self-clipped target" }).click({ position: { x: 20, y: 20 } });
  const composer = page.getByRole("dialog", { name: "Add review comment", includeHidden: true });
  await expect(composer).toBeVisible();

  await page.evaluate(() => {
    const target = document.querySelector("[data-collab-review-id='self-clipped-target']");
    if (!(target instanceof HTMLElement)) throw new Error("missing self-clipped target");
    target.style.width = "8px";
    target.style.height = "8px";
    target.style.overflow = "hidden";
    globalThis.coordinateOverlayHarness.refresh();
  });
  await expect(pin).toBeHidden();
  await expect(composer).toBeHidden();
  expect(await page.evaluate(() => globalThis.coordinateOverlayHarness.unavailableAnchors)).toEqual([]);

  await page.evaluate(() => {
    const target = document.querySelector("[data-collab-review-id='self-clipped-target']");
    if (!(target instanceof HTMLElement)) throw new Error("missing self-clipped target");
    target.style.width = "120px";
    target.style.height = "60px";
    target.style.overflow = "visible";
    globalThis.coordinateOverlayHarness.refresh();
  });
  await expect(pin).toBeVisible();
  await expect(composer).toBeVisible();
});

test("an SVG viewport's own overflow clip hides a signed-offset pin without orphaning", async ({ page }) => {
  await loadCoordinateOverlay(page);
  await page.evaluate(() => {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.dataset.collabReviewId = "self-clipped-svg";
    svg.setAttribute("width", "100");
    svg.setAttribute("height", "60");
    svg.setAttribute("viewBox", "0 0 100 60");
    svg.style.cssText = "position:absolute;left:480px;top:120px;overflow:visible";
    const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    rect.setAttribute("x", "-20");
    rect.setAttribute("y", "-20");
    rect.setAttribute("width", "40");
    rect.setAttribute("height", "40");
    svg.append(rect);
    document.body.append(svg);
    globalThis.coordinateOverlayHarness.setThread({
      threadId: "thread-self-clipped-svg",
      label: "Self-clipped SVG thread",
      identity: "self-clipped-svg",
      schemaVersion: 3,
      offset: { x: -10, y: -5 },
    });
  });

  const pin = page.getByRole("button", { name: "Open Self-clipped SVG thread", includeHidden: true });
  await expect(pin).toBeVisible();
  await page.evaluate(() => {
    const svg = document.querySelector("[data-collab-review-id='self-clipped-svg']");
    if (!(svg instanceof SVGSVGElement)) throw new Error("missing self-clipped SVG");
    svg.style.overflow = "hidden";
    globalThis.coordinateOverlayHarness.refresh();
  });
  await expect(pin).toBeHidden();
  expect(await page.evaluate(() => globalThis.coordinateOverlayHarness.unavailableAnchors)).toEqual([]);
});

test("an open composer follows overflow clipping instead of covering unrelated content", async ({ page }) => {
  await loadCoordinateOverlay(page);
  const scroller = page.locator("#overflow-scroll-surface");
  await scroller.evaluate((element) => { element.scrollTop = 260; });
  await page.evaluate(() => globalThis.coordinateOverlayHarness.setMode("comment"));
  await page.getByRole("button", { name: "Overflow scroll target" }).click({ position: { x: 40, y: 24 } });
  const composer = page.getByRole("dialog", { name: "Add review comment", includeHidden: true });
  await expect(composer).toBeVisible();
  await scroller.evaluate((element) => { element.scrollTop = 0; });
  await expect(composer).toBeHidden();
  await scroller.evaluate((element) => { element.scrollTop = 260; });
  await expect(composer).toBeVisible();
});

test("a fixed target with a transformed containing block uses document placement", async ({ page }) => {
  await loadCoordinateOverlay(page);
  await page.evaluate(() => globalThis.coordinateOverlayHarness.setThread({
    threadId: "thread-transformed-fixed",
    label: "Transformed fixed thread",
    identity: "transformed-fixed-target",
    offset: { x: 40, y: 24 },
  }));
  const pin = page.getByRole("button", { name: "Open Transformed fixed thread", includeHidden: true });
  await expect(pin).toHaveAttribute("data-coordinate-space", "document");

  const result = await measureSmoothScrollDrift(
    page,
    "#transformed-fixed-target",
    "Open Transformed fixed thread",
    { x: 40, y: 24 },
    360,
  );
  const metrics = driftMetrics(result.samples);
  expect(Math.max(...result.samples.map((sample) => sample.targetTop)) - Math.min(...result.samples.map((sample) => sample.targetTop))).toBeGreaterThan(300);
  expect(new Set(result.samples.map((sample) => sample.coordinateSpace))).toEqual(new Set(["document"]));
  expect(metrics.maximumDrift).toBeLessThanOrEqual(1);
  expect(metrics.maximumJump).toBeLessThanOrEqual(1);
});

test("a fixed target with a used preserve-3d containing block uses document placement", async ({ page }) => {
  await loadCoordinateOverlay(page);
  await page.evaluate(() => globalThis.coordinateOverlayHarness.setThread({
    threadId: "thread-preserve-3d-fixed",
    label: "Preserve-3D fixed thread",
    identity: "preserve-3d-fixed-target",
    offset: { x: 40, y: 24 },
  }));
  const pin = page.getByRole("button", { name: "Open Preserve-3D fixed thread", includeHidden: true });
  await expect(pin).toHaveAttribute("data-coordinate-space", "document");

  const result = await measureSmoothScrollDrift(
    page,
    "#preserve-3d-fixed-target",
    "Open Preserve-3D fixed thread",
    { x: 40, y: 24 },
    360,
  );
  const metrics = driftMetrics(result.samples);
  expect(Math.max(...result.samples.map((sample) => sample.targetTop)) - Math.min(...result.samples.map((sample) => sample.targetTop))).toBeGreaterThan(300);
  expect(new Set(result.samples.map((sample) => sample.coordinateSpace))).toEqual(new Set(["document"]));
  expect(metrics.maximumDrift).toBeLessThanOrEqual(1);
  expect(metrics.maximumJump).toBeLessThanOrEqual(1);
});

test("a sticky target constrained on one axis still follows document movement on the other", async ({ page }) => {
  await loadCoordinateOverlay(page);
  await page.evaluate(() => globalThis.coordinateOverlayHarness.setThread({
    threadId: "thread-one-axis-sticky",
    label: "One-axis sticky thread",
    identity: "one-axis-sticky-target",
    offset: { x: 40, y: 24 },
  }));
  const pin = page.getByRole("button", { name: "Open One-axis sticky thread", includeHidden: true });
  await expect(pin).toHaveAttribute("data-coordinate-space", "viewport");

  const result = await measureSmoothScrollDrift(
    page,
    "#one-axis-sticky-target",
    "Open One-axis sticky thread",
    { x: 40, y: 24 },
    360,
  );
  const metrics = driftMetrics(result.samples);
  expect(Math.max(...result.samples.map((sample) => sample.targetTop)) - Math.min(...result.samples.map((sample) => sample.targetTop))).toBeGreaterThan(300);
  expect(new Set(result.samples.map((sample) => sample.coordinateSpace))).toEqual(new Set(["viewport"]));
  expect(metrics.maximumDrift).toBeLessThanOrEqual(1);
  expect(metrics.maximumJump).toBeLessThanOrEqual(1);
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
  expect(metrics.maximumDrift).toBeLessThanOrEqual(1);
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
  const result = await measureSmoothScrollDrift(
    page,
    "#sticky-scroll-target",
    "Open Open attachment thread",
    { x: 30, y: 20 },
    650,
  );
  expect(driftMetrics(result.samples).maximumDrift).toBeLessThanOrEqual(1);
  expect(driftMetrics(result.samples).maximumJump).toBeLessThanOrEqual(1);
  expect(new Set(result.samples.map(({ coordinateSpace }) => coordinateSpace))).toEqual(new Set(["document", "viewport"]));
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

test("a failed attachment callback retries on one explicit unchanged refresh", async ({ page }) => {
  await loadOverlay(page);
  await page.evaluate(() => globalThis.overlayHarness.setThreads([{
    threadId: "thread-attachment-retry",
    anchorGeneration: 1,
    label: "Attachment retry thread",
    anchor: {
      schemaVersion: 3,
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
  const initialAttempts = await page.evaluate(() => globalThis.overlayHarness.attachmentChanges.length);
  expect(initialAttempts).toBe(1);

  await page.evaluate(() => {
    globalThis.overlayHarness.failNextAttachmentChange();
    const target = document.querySelector("#prototype-action");
    if (!(target instanceof HTMLElement)) throw new Error("missing attachment retry target");
    target.style.position = "fixed";
    target.style.left = "40px";
    target.style.top = "40px";
    globalThis.overlayHarness.refresh();
  });
  expect(await page.evaluate(() => globalThis.overlayHarness.attachmentChanges.length)).toBe(2);
  expect(await page.evaluate(() => globalThis.overlayHarness.attachmentChanges.at(-1))).toMatchObject({
    threadId: "thread-attachment-retry",
    attachment: { locationAvailability: "available", coordinateSpace: "viewport" },
  });

  await page.evaluate(() => globalThis.overlayHarness.refresh());
  expect(await page.evaluate(() => globalThis.overlayHarness.attachmentChanges.length)).toBe(3);
  expect(await page.evaluate(() => globalThis.overlayHarness.attachmentChanges.at(-1))).toMatchObject({
    threadId: "thread-attachment-retry",
    attachment: { locationAvailability: "available", coordinateSpace: "viewport" },
  });

  await page.evaluate(() => globalThis.overlayHarness.refresh());
  expect(await page.evaluate(() => globalThis.overlayHarness.attachmentChanges.length)).toBe(3);
});

test("a Promise-returning attachment callback is consumed and retries on one unchanged refresh", async ({ page }) => {
  await loadOverlay(page);
  await page.evaluate(() => {
    globalThis.overlayHarness.rejectNextAttachmentAsynchronously();
    globalThis.overlayHarness.setThreads([{
      threadId: "thread-attachment-async-retry",
      anchorGeneration: 1,
      label: "Async attachment retry thread",
      anchor: {
        schemaVersion: 3,
        locationAvailability: "available",
        recoveryState: "not_required",
        context: globalThis.overlayHarness.context,
        element: {
          selector: '[data-collab-review-id="synthetic-action"]',
          identity: "synthetic-action",
          offset: { x: 20, y: 15 },
        },
        document: { x: 60, y: 55, width: 1280, height: 720 },
      },
    }]);
  });
  await page.evaluate(() => globalThis.overlayHarness.settleAsyncEvents());
  expect(await page.evaluate(() => globalThis.overlayHarness.unhandledSubmissionRejections())).toBe(0);
  expect(await page.evaluate(() => globalThis.overlayHarness.attachmentChanges.length)).toBe(1);

  await page.evaluate(() => globalThis.overlayHarness.refresh());
  expect(await page.evaluate(() => globalThis.overlayHarness.attachmentChanges.length)).toBe(2);
  await page.evaluate(() => globalThis.overlayHarness.refresh());
  expect(await page.evaluate(() => globalThis.overlayHarness.attachmentChanges.length)).toBe(2);
});

test("a reentrant newer attachment delivery supersedes an older callback failure", async ({ page }) => {
  await loadOverlay(page);
  await page.evaluate(() => globalThis.overlayHarness.setThreads([{
    threadId: "thread-attachment-reentrant",
    anchorGeneration: 1,
    label: "Reentrant attachment thread",
    anchor: {
      schemaVersion: 3,
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

  await page.evaluate(() => {
    globalThis.overlayHarness.failNextAttachmentChangeWithDocumentReentry();
    const target = document.querySelector("#prototype-action");
    if (!(target instanceof HTMLElement)) throw new Error("missing reentrant attachment target");
    target.style.position = "fixed";
    target.style.left = "40px";
    target.style.top = "40px";
    globalThis.overlayHarness.refresh();
  });
  expect(await page.evaluate(() => (globalThis.overlayHarness.attachmentChanges as Array<{
    attachment?: { coordinateSpace?: string };
  }>).map(({ attachment }) => attachment?.coordinateSpace))).toEqual([
    "document",
    "viewport",
    "document",
  ]);

  await page.evaluate(() => globalThis.overlayHarness.refresh());
  expect(await page.evaluate(() => globalThis.overlayHarness.attachmentChanges)).toHaveLength(3);
});

for (const device of [
  { name: "representative iPhone coordinate spaces", viewport: { width: 390, height: 844 } },
  { name: "representative Android coordinate spaces", viewport: { width: 412, height: 915 } },
]) {
  test(`${device.name} keep supported coordinate spaces attached frame by frame`, async ({ page }) => {
    await page.setViewportSize(device.viewport);
    await loadCoordinateOverlay(page);
    const cases = [
      { threadId: "mobile-normal", label: "Mobile normal", identity: "normal-scroll-target", selector: "#normal-scroll-target", offset: { x: 30, y: 20 }, destination: 650, spaces: ["document"] },
      { threadId: "mobile-sticky", label: "Mobile sticky", identity: "sticky-scroll-target", selector: "#sticky-scroll-target", offset: { x: 30, y: 20 }, destination: 650, spaces: ["document", "viewport"] },
      { threadId: "mobile-fixed", label: "Mobile fixed", identity: "fixed-scroll-target", selector: "#fixed-scroll-target", offset: { x: 30, y: 20 }, destination: 650, spaces: ["viewport"] },
      { threadId: "mobile-transformed-fixed", label: "Mobile transformed fixed", identity: "transformed-fixed-target", selector: "#transformed-fixed-target", offset: { x: 30, y: 20 }, destination: 300, spaces: ["document"] },
      { threadId: "mobile-one-axis-sticky", label: "Mobile one-axis sticky", identity: "one-axis-sticky-target", selector: "#one-axis-sticky-target", offset: { x: 30, y: 20 }, destination: 360, spaces: ["viewport"] },
    ] as const;
    for (const value of cases) {
      await page.evaluate(() => scrollTo(0, 0));
      await page.evaluate((input) => globalThis.coordinateOverlayHarness.setThread(input), value);
      const result = await measureSmoothScrollDrift(page, value.selector, `Open ${value.label}`, value.offset, value.destination);
      const metrics = driftMetrics(result.samples);
      expect(metrics.maximumDrift, value.label).toBeLessThanOrEqual(1);
      expect(metrics.maximumJump, value.label).toBeLessThanOrEqual(1);
      expect(new Set(result.samples.map((sample) => sample.coordinateSpace))).toEqual(new Set(value.spaces));
    }
    await page.evaluate(() => scrollTo(0, 0));
    await page.locator("#overflow-scroll-surface").evaluate((element) => { element.scrollTop = 220; });
    await page.evaluate(() => globalThis.coordinateOverlayHarness.setThread({
      threadId: "mobile-overflow",
      label: "Mobile overflow",
      identity: "overflow-scroll-target",
      offset: { x: 30, y: 20 },
    }));
    const overflowSamples = await measureElementScrollDrift(
      page,
      "#overflow-scroll-surface",
      "#overflow-scroll-target",
      "Open Mobile overflow",
      { x: 30, y: 20 },
      300,
    );
    expect(driftMetrics(overflowSamples).maximumDrift).toBeLessThanOrEqual(1);
    expect(driftMetrics(overflowSamples).maximumJump).toBeLessThanOrEqual(1);
    await page.evaluate(() => globalThis.coordinateOverlayHarness.setThread({
      threadId: "mobile-responsive",
      label: "Responsive layout thread",
      identity: "normal-scroll-target",
      offset: { x: 40, y: 24 },
    }));
    for (const state of ["closed", "open"] as const) {
      const responsiveSamples = await measureSidebarMotion(page, state);
      expect(driftMetrics(responsiveSamples).maximumDrift, `${device.name} ${state}`).toBeLessThanOrEqual(1);
      expect(driftMetrics(responsiveSamples).maximumJump, `${device.name} ${state}`).toBeLessThanOrEqual(1);
      expect(new Set(responsiveSamples.map(({ coordinateSpace }) => coordinateSpace))).toEqual(new Set(["document"]));
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
  expect(await page.evaluate(() => globalThis.overlayHarness.unanchorableClicks())).toBe(0);
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
      schemaVersion: 3,
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

test("nested open-shadow anchors resolve, follow inner scrolling, and capture from the composed path", async ({ page }) => {
  await loadOverlay(page, "?openShadowAnchors=true");
  await page.evaluate(() => globalThis.overlayHarness.setThreads([{
    threadId: "thread-open-shadow",
    anchorGeneration: 1,
    label: "Open shadow thread",
    anchor: {
      schemaVersion: 3,
      locationAvailability: "available",
      recoveryState: "not_required",
      context: globalThis.overlayHarness.context,
      element: {
        selector: '[data-collab-review-id="open-shadow-action"]',
        identity: "open-shadow-action",
        offset: { x: 20, y: 15 },
      },
      document: { x: 60, y: 95, width: 1280, height: 720 },
    },
  }]));
  const action = page.getByRole("button", { name: "Open shadow prototype action" });
  const pin = page.getByRole("button", { name: "Open Open shadow thread", includeHidden: true });
  await expect(pin).toBeVisible();

  await page.evaluate(() => globalThis.overlayHarness.scrollOpenShadow(190));
  await expect.poll(async () => {
    const [targetBox, pinBox] = await Promise.all([action.boundingBox(), pin.boundingBox()]);
    if (!targetBox || !pinBox) return Number.POSITIVE_INFINITY;
    return Math.hypot(
      (pinBox.x + (pinBox.width / 2)) - (targetBox.x + 20),
      (pinBox.y + (pinBox.height / 2)) - (targetBox.y + 15),
    );
  }).toBeLessThanOrEqual(1);

  await page.evaluate(() => {
    globalThis.overlayHarness.setThreads([]);
    globalThis.overlayHarness.setMode("comment");
  });
  await action.click({ position: { x: 20, y: 15 } });
  const composer = page.getByRole("dialog", { name: "Add review comment" });
  await expect(composer).toBeVisible();
  await composer.getByRole("textbox", { name: "Comment" }).fill("Open shadow feedback");
  await composer.getByRole("button", { name: "Submit comment" }).click();
  expect(await page.evaluate(() => globalThis.overlayHarness.submissions.at(-1)?.anchor.element)).toEqual({
    selector: '[data-collab-review-id="open-shadow-action"]',
    identity: "open-shadow-action",
    offset: { x: 20, y: 15 },
  });
});

test("duplicate identities across open shadow roots fail closed", async ({ page }) => {
  await loadOverlay(page, "?openShadowAnchors=true");
  await page.evaluate(() => globalThis.overlayHarness.setThreads([{
    threadId: "thread-duplicate-open-shadow",
    anchorGeneration: 1,
    label: "Duplicate open shadow thread",
    anchor: {
      schemaVersion: 3,
      locationAvailability: "available",
      recoveryState: "not_required",
      context: globalThis.overlayHarness.context,
      element: {
        selector: '[data-collab-review-id="open-shadow-action"]',
        identity: "open-shadow-action",
        offset: { x: 20, y: 15 },
      },
      document: { x: 60, y: 95, width: 1280, height: 720 },
    },
  }]));
  const pin = page.getByRole("button", { name: "Open Duplicate open shadow thread", includeHidden: true });
  await expect(pin).toBeVisible();
  await page.evaluate(() => globalThis.overlayHarness.addOpenShadowDuplicate());
  await expect(pin).toHaveCount(0);
});

test("a local composer tracks scrolling in an open shadow root attached after mount", async ({ page }) => {
  await loadOverlay(page);
  await page.evaluate(async () => {
    await globalThis.overlayHarness.attachDynamicOpenShadow();
    globalThis.overlayHarness.setMode("comment");
  });
  const action = page.getByRole("button", { name: "Dynamic open shadow action" });
  await action.click({ position: { x: 20, y: 15 } });
  const composer = page.getByRole("dialog", { name: "Add review comment" });
  await expect(composer).toBeVisible();
  const baseline = await elementOffsetFromTarget(action, composer);

  await page.evaluate(() => globalThis.overlayHarness.scrollDynamicOpenShadow(190));
  await expect.poll(() => elementOffsetFromTarget(action, composer)).toEqual(baseline);
});

test("an active composer discovers an open shadow scroll root attached after activation", async ({ page }) => {
  await loadOverlay(page, "?lateShadowAnchor=true");
  await page.evaluate(() => globalThis.overlayHarness.setMode("comment"));
  const action = page.getByRole("button", { name: "Synthetic prototype action" });
  await action.click({ position: { x: 20, y: 15 } });
  const composer = page.getByRole("dialog", { name: "Add review comment" });
  await expect(composer).toBeVisible();

  await page.evaluate(() => globalThis.overlayHarness.attachLateShadowAroundActiveAnchor());
  await page.evaluate(() => globalThis.overlayHarness.scrollLateShadowAnchor(30));
  await expect.poll(() => elementOffsetFromTarget(action, composer)).toEqual({ x: 32, y: 27 });
  const baseline = await elementOffsetFromTarget(action, composer);
  await page.evaluate(() => globalThis.overlayHarness.scrollLateShadowAnchor(60));
  await expect.poll(() => elementOffsetFromTarget(action, composer)).toEqual(baseline);
});

test("Comment mode anchors a visible descendant protruding above and left of its marker", async ({ page }) => {
  await loadOverlay(page);
  await page.evaluate(() => {
    const marker = document.createElement("div");
    marker.dataset.collabReviewId = "protruding-marker";
    marker.style.cssText = "position:absolute;left:400px;top:300px;width:80px;height:60px";
    const action = document.createElement("button");
    action.type = "button";
    action.textContent = "Protruding prototype action";
    action.style.cssText = "position:absolute;left:-30px;top:-20px;width:40px;height:30px";
    action.addEventListener("click", () => {
      marker.dataset.prototypeClicks = String(Number(marker.dataset.prototypeClicks ?? "0") + 1);
    });
    marker.appendChild(action);
    document.body.appendChild(marker);
    globalThis.overlayHarness.setMode("comment");
  });

  const protrudingPoint = await page.evaluate(() => {
    const marker = document.querySelector('[data-collab-review-id="protruding-marker"]');
    const action = [...document.querySelectorAll("button")].find((candidate) => candidate.textContent === "Protruding prototype action");
    if (!(marker instanceof HTMLElement) || !(action instanceof HTMLButtonElement)) throw new Error("missing protruding fixture");
    const markerBox = marker.getBoundingClientRect();
    const actionBox = action.getBoundingClientRect();
    const x = actionBox.left + (actionBox.width / 2);
    const y = actionBox.top + (actionBox.height / 2);
    return { x, y, offset: { x: x - markerBox.left, y: y - markerBox.top } };
  });
  expect(protrudingPoint.offset.x).toBeLessThan(0);
  expect(protrudingPoint.offset.y).toBeLessThan(0);
  await page.mouse.click(protrudingPoint.x, protrudingPoint.y);
  await expect(page.getByRole("dialog", { name: "Add review comment" })).toBeVisible();
  expect(await page.locator('[data-collab-review-id="protruding-marker"]').getAttribute("data-prototype-clicks")).toBeNull();
  await page.getByRole("textbox", { name: "Comment" }).fill("Protruding feedback");
  await page.getByRole("textbox", { name: "Comment" }).press("Control+Enter");

  const capturedAnchor = await page.evaluate(() => {
    const submission = globalThis.overlayHarness.submissions.at(-1) as { anchor: unknown } | undefined;
    return submission?.anchor;
  }) as { element: { offset: { x: number; y: number } } };
  const capturedOffset = capturedAnchor.element.offset;
  expect(capturedOffset.x).toBeCloseTo(protrudingPoint.offset.x, 6);
  expect(capturedOffset.y).toBeCloseTo(protrudingPoint.offset.y, 6);

  await page.evaluate((anchor) => globalThis.overlayHarness.setThreads([{
    threadId: "thread-protruding-marker",
    anchorGeneration: 1,
    label: "Protruding marker thread",
    anchor,
  }]), capturedAnchor);
  const pinBox = await page.getByRole("button", { name: "Open Protruding marker thread" }).boundingBox();
  expect(pinBox).not.toBeNull();
  expect(pinBox!.x + (pinBox!.width / 2)).toBeCloseTo(protrudingPoint.x, 6);
  expect(pinBox!.y + (pinBox!.height / 2)).toBeCloseTo(protrudingPoint.y, 6);
});

test("Comment mode suppresses prototype press handlers before click placement", async ({ page }) => {
  await loadOverlay(page);
  const action = page.getByRole("button", { name: "Synthetic prototype action" });
  await action.click({ position: { x: 20, y: 15 } });
  expect(await page.evaluate(() => globalThis.overlayHarness.prototypePressCounts())).toEqual({
    pointerdown: 1,
    mousedown: 1,
  });

  await page.evaluate(() => globalThis.overlayHarness.setMode("comment"));
  await action.click({ position: { x: 20, y: 15 } });

  expect(await page.evaluate(() => globalThis.overlayHarness.prototypePressCounts())).toEqual({
    pointerdown: 1,
    mousedown: 1,
  });
  await expect(page.getByRole("dialog", { name: "Add review comment" })).toBeVisible();
});

test("Comment mode cancels native pointer defaults on unmarked controls", async ({ page }) => {
  await loadOverlay(page);
  await page.evaluate(() => {
    const input = document.createElement("input");
    input.setAttribute("aria-label", "Unmarked prototype input");
    input.style.cssText = "position:absolute;left:240px;top:40px;width:180px;height:40px";
    document.body.appendChild(input);
    const range = document.createElement("input");
    range.type = "range";
    range.min = "0";
    range.max = "100";
    range.value = "50";
    range.setAttribute("aria-label", "Unmarked prototype range");
    range.style.cssText = "position:absolute;left:440px;top:40px;width:200px;height:40px";
    document.body.appendChild(range);
    globalThis.overlayHarness.setMode("comment");
  });

  const input = page.getByRole("textbox", { name: "Unmarked prototype input" });
  await input.click();
  await expect(input).not.toBeFocused();

  const range = page.getByRole("slider", { name: "Unmarked prototype range" });
  const box = await range.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width - 5, box!.y + (box!.height / 2));
  await page.mouse.down();
  await expect(range).toHaveValue("50");
  await page.mouse.up();
  await expect(page.getByRole("dialog", { name: "Add review comment" })).toHaveCount(0);
});

test("Comment mode requires a primary gesture to begin and end on the same marker", async ({ page }) => {
  await loadOverlay(page);
  const points = await page.evaluate(() => {
    const unmarked = document.createElement("div");
    unmarked.style.cssText = "position:absolute;left:300px;top:120px;width:80px;height:80px";
    document.body.appendChild(unmarked);
    globalThis.overlayHarness.setMode("comment");
    const start = unmarked.getBoundingClientRect();
    const end = document.querySelector("#prototype-action")!.getBoundingClientRect();
    return {
      start: { x: start.left + 20, y: start.top + 20 },
      end: { x: end.left + 20, y: end.top + 15 },
    };
  });

  await page.mouse.move(points.start.x, points.start.y);
  await page.mouse.down();
  await page.mouse.move(points.end.x, points.end.y);
  await page.mouse.up();

  await expect(page.getByRole("dialog", { name: "Add review comment" })).toHaveCount(0);
});

test("Comment mode ignores a captured touch gesture released outside its starting marker", async ({ browser }) => {
  const context = await browser.newContext({ hasTouch: true, viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  try {
    await loadOverlay(page);
    await page.evaluate(() => globalThis.overlayHarness.setMode("comment"));
    const box = await page.getByRole("button", { name: "Synthetic prototype action" }).boundingBox();
    expect(box).not.toBeNull();
    const start = { x: box!.x + 20, y: box!.y + 15 };
    const outside = { x: Math.min(380, box!.x + box!.width + 80), y: start.y };
    const client = await context.newCDPSession(page);

    await client.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ ...start, id: 1 }],
    });
    await client.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ ...outside, id: 1 }],
    });
    await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });

    await expect(page.getByRole("dialog", { name: "Add review comment" })).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("the no-PointerEvent fallback cancels placement when a second touch joins", async ({ browser }) => {
  const context = await browser.newContext({ hasTouch: true, viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  try {
    await loadOverlay(page, "?disablePointerEvents=true");
    const points = await page.evaluate(() => {
      const unmarked = document.createElement("div");
      unmarked.style.cssText = "position:absolute;left:260px;top:120px;width:80px;height:80px";
      document.body.appendChild(unmarked);
      globalThis.overlayHarness.setMode("comment");
      const first = document.querySelector("#prototype-action")!.getBoundingClientRect();
      const second = unmarked.getBoundingClientRect();
      return {
        first: { x: first.left + 20, y: first.top + 20, id: 1 },
        second: { x: second.left + 20, y: second.top + 15, id: 2 },
      };
    });
    const client = await context.newCDPSession(page);

    await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [points.first] });
    await client.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [points.first, points.second],
    });
    await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [points.second] });
    await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });

    await expect(page.getByRole("dialog", { name: "Add review comment" })).toHaveCount(0);
    await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [points.first] });
    await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await expect(page.getByRole("dialog", { name: "Add review comment" })).toBeVisible();
  } finally {
    await context.close();
  }
});

test("the no-PointerEvent fallback cancels placement when a second touch reaches owned UI", async ({ browser }) => {
  const context = await browser.newContext({ hasTouch: true, viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  try {
    await loadOverlay(page, "?disablePointerEvents=true");
    const points = await page.evaluate(() => {
      globalThis.overlayHarness.setThreads([{
        threadId: "thread-touch-recovery",
        anchorGeneration: 1,
        label: "Touch recovery thread",
        anchor: {
          schemaVersion: 1,
          locationAvailability: "unavailable",
          recoveryState: "legacy_replacement_required",
        },
      }]);
      globalThis.overlayHarness.setMode("comment");
      const first = document.querySelector("#prototype-action")!.getBoundingClientRect();
      const recovery = document.querySelector<HTMLButtonElement>('[data-recovery-thread-id="thread-touch-recovery"]');
      if (!recovery) throw new Error("missing synthetic recovery control");
      const second = recovery.getBoundingClientRect();
      return {
        first: { x: first.left + 20, y: first.top + 20, id: 1 },
        second: { x: second.left + 10, y: second.top + 10, id: 2 },
      };
    });
    const client = await context.newCDPSession(page);

    await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [points.first] });
    await client.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [points.first, points.second],
    });
    await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [points.second] });
    await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });

    await expect(page.getByRole("dialog", { name: "Add review comment" })).toHaveCount(0);
    await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [points.first] });
    await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await expect(page.getByRole("dialog", { name: "Add review comment" })).toBeVisible();
  } finally {
    await context.close();
  }
});

test("Comment mode suppresses trusted touch activation before click placement", async ({ browser }) => {
  const context = await browser.newContext({ hasTouch: true, viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  try {
    await loadOverlay(page);
    const action = page.getByRole("button", { name: "Synthetic prototype action" });
    const box = await action.boundingBox();
    expect(box).not.toBeNull();
    await page.touchscreen.tap(box!.x + 20, box!.y + 15);
    expect(await page.evaluate(() => globalThis.overlayHarness.prototypeTouchStarts())).toBe(1);

    await page.evaluate(() => globalThis.overlayHarness.setMode("comment"));
    await page.touchscreen.tap(box!.x + 20, box!.y + 15);

    expect(await page.evaluate(() => globalThis.overlayHarness.prototypeTouchStarts())).toBe(1);
    await expect(page.getByRole("dialog", { name: "Add review comment" })).toBeVisible();
  } finally {
    await context.close();
  }
});

test("Comment mode cancels native touch defaults and preserves marked placement", async ({ browser }) => {
  const context = await browser.newContext({ hasTouch: true, viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  try {
    await loadOverlay(page);
    const positions = await page.evaluate(() => {
      const input = document.createElement("input");
      input.setAttribute("aria-label", "Unmarked touch input");
      input.style.cssText = "position:absolute;left:200px;top:140px;width:160px;height:44px";
      document.body.appendChild(input);
      const range = document.createElement("input");
      range.type = "range";
      range.min = "0";
      range.max = "100";
      range.value = "50";
      range.setAttribute("aria-label", "Unmarked touch range");
      range.style.cssText = "position:absolute;left:160px;top:210px;width:200px;height:44px";
      document.body.appendChild(range);
      globalThis.overlayHarness.setMode("comment");
      const inputRect = input.getBoundingClientRect();
      const rangeRect = range.getBoundingClientRect();
      const targetRect = document.querySelector("#prototype-action")!.getBoundingClientRect();
      return {
        input: { x: inputRect.left + 20, y: inputRect.top + 20 },
        range: { x: rangeRect.right - 5, y: rangeRect.top + (rangeRect.height / 2) },
        target: { x: targetRect.left + 20, y: targetRect.top + 15 },
      };
    });

    await page.touchscreen.tap(positions.input.x, positions.input.y);
    await expect(page.getByRole("textbox", { name: "Unmarked touch input" })).not.toBeFocused();
    await page.touchscreen.tap(positions.range.x, positions.range.y);
    await expect(page.getByRole("slider", { name: "Unmarked touch range" })).toHaveValue("50");
    await page.touchscreen.tap(positions.target.x, positions.target.y);
    await expect(page.getByRole("dialog", { name: "Add review comment" })).toBeVisible();
    await page.getByRole("textbox", { name: "Comment" }).fill("Touch placement");
    await page.getByRole("textbox", { name: "Comment" }).press("Control+Enter");
    expect(await page.evaluate(() => globalThis.overlayHarness.submissions.at(-1)?.anchor.element.offset)).toEqual({
      x: 20,
      y: 15,
    });
  } finally {
    await context.close();
  }
});

test("Comment mode consumes actions from a boxless explicit marker without creating or replacing an Anchor", async ({ page }) => {
  await loadOverlay(page);
  await page.evaluate(() => {
    const marker = document.createElement("div");
    marker.id = "boxless-marker";
    marker.dataset.collabReviewId = "synthetic-boxless-marker";
    marker.style.display = "contents";
    const action = document.createElement("button");
    action.id = "boxless-action";
    action.type = "button";
    action.textContent = "Boxless marker action";
    for (const type of ["pointerdown", "mousedown", "keydown", "keyup", "click"] as const) {
      action.addEventListener(type, () => { marker.dataset[type] = String(Number(marker.dataset[type] ?? 0) + 1); });
    }
    marker.appendChild(action);
    document.body.appendChild(marker);
    globalThis.overlayHarness.setMode("comment");
  });

  const action = page.getByRole("button", { name: "Boxless marker action" });
  await action.click();
  await action.focus();
  await action.press("Enter");
  expect(await page.locator("#boxless-marker").evaluate((element) => ({
    pointerdown: element.getAttribute("data-pointerdown"),
    mousedown: element.getAttribute("data-mousedown"),
    keydown: element.getAttribute("data-keydown"),
    keyup: element.getAttribute("data-keyup"),
    click: element.getAttribute("data-click"),
  }))).toEqual({ pointerdown: null, mousedown: null, keydown: null, keyup: null, click: null });
  await expect(page.getByRole("dialog", { name: "Add review comment" })).toHaveCount(0);
  expect(await page.evaluate(() => globalThis.overlayHarness.submissions)).toEqual([]);

  await page.evaluate(() => {
    globalThis.overlayHarness.setThreads([{
      threadId: "thread-boxless-replacement",
      anchorGeneration: 1,
      canReplaceAnchor: true,
      anchor: {
        schemaVersion: 1,
        locationAvailability: "unavailable",
        recoveryState: "legacy_replacement_required",
      },
    }]);
    globalThis.overlayHarness.beginAnchorReplacement("thread-boxless-replacement");
  });
  await action.click();
  expect(await page.locator("#boxless-marker").getAttribute("data-click")).toBeNull();
  expect(await page.evaluate(() => globalThis.overlayHarness.replacementRequests)).toEqual([]);
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
      schemaVersion: 3,
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

test("Comment mode owns keyboard activation before prototype key handlers", async ({ page }) => {
  await loadOverlay(page);
  await page.evaluate(() => globalThis.overlayHarness.setMode("comment"));
  const action = page.getByRole("button", { name: "Synthetic prototype action" });
  await action.focus();
  await action.press("Enter");
  let composer = page.getByRole("dialog", { name: "Add review comment" });
  await expect(composer).toBeVisible();
  expect(await page.evaluate(() => globalThis.overlayHarness.prototypeKeyDowns())).toBe(0);
  expect(await page.evaluate(() => globalThis.overlayHarness.prototypeClicks())).toBe(0);

  await page.getByRole("textbox", { name: "Comment" }).press("Escape");
  await expect(action).toBeFocused();
  await action.press("Space");
  composer = page.getByRole("dialog", { name: "Add review comment" });
  await expect(composer).toBeVisible();
  expect(await page.evaluate(() => globalThis.overlayHarness.prototypeKeyDowns())).toBe(0);
  expect(await page.evaluate(() => globalThis.overlayHarness.prototypeClicks())).toBe(0);
});

test("script-generated prototype clicks remain prototype-owned in Comment mode", async ({ page }) => {
  await loadOverlay(page);
  await page.evaluate(() => globalThis.overlayHarness.setMode("comment"));
  await page.locator("#prototype-action").evaluate((element) => (element as HTMLElement).click());

  expect(await page.evaluate(() => globalThis.overlayHarness.prototypeClicks())).toBe(1);
  await expect(page.getByRole("dialog", { name: "Add review comment" })).toHaveCount(0);
  expect(await page.evaluate(() => globalThis.overlayHarness.submissions)).toEqual([]);
});

test("script-generated pin clicks cannot open consumer-owned thread UI", async ({ page }) => {
  await loadOverlay(page);
  await page.evaluate(() => {
    globalThis.overlayHarness.setMode("comment");
    globalThis.overlayHarness.setThreads([{
      threadId: "thread-untrusted-open",
      anchorGeneration: 1,
      label: "Untrusted open thread",
      anchor: {
        schemaVersion: 3,
        locationAvailability: "available",
        recoveryState: "not_required",
        context: globalThis.overlayHarness.context,
        element: {
          selector: '[data-collab-review-id="synthetic-action"]',
          identity: "synthetic-action",
          offset: { x: 20, y: 15 },
        },
        document: { x: 60, y: 55, width: 1280, height: 720 },
      },
    }]);
    (document.querySelector(".crl-overlay__pin") as HTMLButtonElement).click();
  });

  expect(await page.evaluate(() => globalThis.overlayHarness.openedThreads)).toEqual([]);
  await page.evaluate(() => globalThis.overlayHarness.rejectNextOpenThreadAsynchronously());
  await page.getByRole("button", { name: "Open Untrusted open thread" }).click();
  await page.evaluate(() => globalThis.overlayHarness.settleAsyncEvents());
  expect(await page.evaluate(() => globalThis.overlayHarness.unhandledSubmissionRejections())).toBe(0);
  expect(await page.evaluate(() => globalThis.overlayHarness.openedThreads)).toEqual([]);
  await page.getByRole("button", { name: "Open Untrusted open thread" }).click();
  expect(await page.evaluate(() => globalThis.overlayHarness.openedThreads)).toHaveLength(1);
});

test("an unrelated infinite transform animation does not drive overlay refresh frames", async ({ page }) => {
  await loadOverlay(page);
  await page.evaluate(() => globalThis.overlayHarness.setMode("comment"));
  await page.getByRole("button", { name: "Synthetic prototype action" }).click({ position: { x: 20, y: 15 } });
  await expect(page.getByRole("dialog", { name: "Add review comment" })).toBeVisible();
  await page.evaluate(() => globalThis.overlayHarness.animateUnrelatedSpinner());
  await page.waitForTimeout(100);

  const requestedFrames = await page.evaluate(async () => {
    const nativeRequestAnimationFrame = window.requestAnimationFrame;
    let frames = 0;
    window.requestAnimationFrame = (callback) => {
      frames += 1;
      return nativeRequestAnimationFrame.call(window, callback);
    };
    await new Promise((resolve) => setTimeout(resolve, 150));
    window.requestAnimationFrame = nativeRequestAnimationFrame;
    return frames;
  });

  expect(requestedFrames).toBeLessThanOrEqual(2);
});

test("instantaneous hover and focus styles revalidate pin placement", async ({ page }) => {
  await loadOverlay(page);
  await page.evaluate(() => {
    globalThis.overlayHarness.enableInteractionStateStyles();
    globalThis.overlayHarness.setThreads([{
      threadId: "thread-interaction-state-style",
      anchorGeneration: 1,
      label: "Interaction state style thread",
      anchor: {
        schemaVersion: 3,
        locationAvailability: "available",
        recoveryState: "not_required",
        context: globalThis.overlayHarness.context,
        element: {
          selector: '[data-collab-review-id="synthetic-action"]',
          identity: "synthetic-action",
          offset: { x: 20, y: 15 },
        },
        document: { x: 60, y: 55, width: 1280, height: 720 },
      },
    }]);
  });
  const target = page.getByRole("button", { name: "Synthetic prototype action" });
  const pin = page.getByRole("button", { name: "Open Interaction state style thread", includeHidden: true });
  await expect(pin).toBeVisible();

  await target.hover();
  await expect(pin).toBeHidden();
  await page.mouse.move(1, 1);
  await expect(pin).toBeVisible();

  await target.focus();
  await expect.poll(async () => {
    const targetBox = await target.boundingBox();
    const pinBox = await pin.boundingBox();
    return Math.round((pinBox?.x ?? 0) + ((pinBox?.width ?? 0) / 2) - (targetBox?.x ?? 0));
  }).toBe(20);
});

test("a composer tracks target motion that began before the draft opened", async ({ page }) => {
  await loadOverlay(page);
  await page.evaluate(() => globalThis.overlayHarness.setMode("comment"));
  await page.evaluate(() => globalThis.overlayHarness.animateTargetBeforeComposer());
  const movingTarget = await page.locator("#prototype-action").boundingBox();
  expect(movingTarget).not.toBeNull();
  await page.mouse.click(movingTarget!.x + 20, movingTarget!.y + 15);
  await expect(page.getByRole("dialog", { name: "Add review comment" })).toBeVisible();

  const samples = await page.evaluate(async () => {
    const target = document.querySelector("#prototype-action");
    const composer = document.querySelector(".crl-overlay__composer");
    if (!(target instanceof Element) || !(composer instanceof HTMLElement)) {
      throw new Error("missing precomposer-motion fixture");
    }
    const targetStart = target.getBoundingClientRect();
    const composerStart = composer.getBoundingClientRect();
    const baseline = composerStart.left - targetStart.left;
    const values: Array<{ targetLeft: number; driftX: number }> = [];
    await new Promise<void>((resolve) => {
      let frames = 0;
      const sample = (): void => {
        const targetBox = target.getBoundingClientRect();
        const composerBox = composer.getBoundingClientRect();
        values.push({
          targetLeft: targetBox.left,
          driftX: (composerBox.left - targetBox.left) - baseline,
        });
        frames += 1;
        if (frames >= 30) return resolve();
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    return values;
  });

  const targetRange = Math.max(...samples.map(({ targetLeft }) => targetLeft))
    - Math.min(...samples.map(({ targetLeft }) => targetLeft));
  const driftRange = Math.max(...samples.map(({ driftX }) => driftX))
    - Math.min(...samples.map(({ driftX }) => driftX));
  const maximumJump = Math.max(
    0,
    ...samples.slice(1).map(({ driftX }, index) => Math.abs(driftX - samples[index]!.driftX)),
  );
  expect(targetRange).toBeGreaterThan(2);
  expect(driftRange).toBeLessThanOrEqual(1);
  expect(maximumJump).toBeLessThanOrEqual(1);
});

test("refresh registers late Web Animations on a placed target and open composer", async ({ page }) => {
  await loadOverlay(page);
  await page.evaluate(() => {
    globalThis.overlayHarness.setThreads([{
      threadId: "thread-late-waapi",
      anchorGeneration: 1,
      label: "Late Web Animation thread",
      anchor: {
        schemaVersion: 2,
        locationAvailability: "available",
        recoveryState: "not_required",
        context: globalThis.overlayHarness.context,
        element: {
          selector: '[data-collab-review-id="synthetic-action"]',
          identity: "synthetic-action",
          offset: { x: 20, y: 15 },
        },
        document: { x: 60, y: 55, width: 1280, height: 720 },
      },
    }]);
    globalThis.overlayHarness.setMode("comment");
  });
  await page.getByRole("button", { name: "Synthetic prototype action" }).click({ position: { x: 100, y: 50 } });
  await expect(page.getByRole("dialog", { name: "Add review comment" })).toBeVisible();

  const samples = await page.evaluate(async () => {
    const target = document.querySelector("#prototype-action");
    const pin = document.querySelector('.crl-overlay__pin[aria-label="Open Late Web Animation thread"]');
    const composer = document.querySelector(".crl-overlay__composer");
    if (!(target instanceof HTMLElement) || !(pin instanceof HTMLElement) || !(composer instanceof HTMLElement)) {
      throw new Error("missing late Web Animation fixture");
    }
    const targetStart = target.getBoundingClientRect();
    const composerStart = composer.getBoundingClientRect();
    const composerBaseline = {
      x: composerStart.left - targetStart.left,
      y: composerStart.top - targetStart.top,
    };
    const animation = target.animate(
      [{ transform: "translateX(0)" }, { transform: "translateX(120px)" }],
      { duration: 700, easing: "linear", fill: "forwards" },
    );
    globalThis.overlayHarness.refresh();
    const values: Array<{ targetLeft: number; pinDrift: number; composerDrift: number }> = [];
    await new Promise<void>((resolve, reject) => {
      let frames = 0;
      const sample = (): void => {
        const targetBox = target.getBoundingClientRect();
        const pinBox = pin.getBoundingClientRect();
        const composerBox = composer.getBoundingClientRect();
        values.push({
          targetLeft: targetBox.left,
          pinDrift: Math.hypot(
            (pinBox.left + (pinBox.width / 2)) - targetBox.left - 20,
            (pinBox.top + (pinBox.height / 2)) - targetBox.top - 15,
          ),
          composerDrift: Math.hypot(
            (composerBox.left - targetBox.left) - composerBaseline.x,
            (composerBox.top - targetBox.top) - composerBaseline.y,
          ),
        });
        frames += 1;
        if (animation.playState === "finished" && frames >= 3) return resolve();
        if (frames >= 90) return reject(new Error("late Web Animation did not settle"));
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    return values;
  });

  expect(Math.max(...samples.map(({ targetLeft }) => targetLeft)) - Math.min(...samples.map(({ targetLeft }) => targetLeft))).toBeGreaterThan(80);
  expect(Math.max(...samples.map(({ pinDrift }) => pinDrift))).toBeLessThanOrEqual(1);
  expect(Math.max(...samples.map(({ composerDrift }) => composerDrift))).toBeLessThanOrEqual(1);
});

for (const invalidation of ["removed", "hidden", "identity-changed", "unsupported-projection"] as const) {
  test(`an open composer closes when its target becomes ${invalidation}`, async ({ page }) => {
    await loadOverlay(page);
    await page.evaluate(() => globalThis.overlayHarness.setMode("comment"));
    const action = page.locator("#prototype-action");
    await action.click({ position: { x: 20, y: 15 } });
    const composer = page.getByRole("dialog", { name: "Add review comment" });
    await expect(composer).toBeVisible();
    await page.getByRole("textbox", { name: "Comment" }).fill("Must not be submitted");

    await action.evaluate((element, kind) => {
      if (kind === "removed") element.remove();
      else if (kind === "hidden") (element as HTMLElement).style.visibility = "hidden";
      else if (kind === "identity-changed") element.setAttribute("data-collab-review-id", "changed-identity");
      else (element as HTMLElement).style.transform = "perspective(500px) rotateX(20deg)";
    }, invalidation);

    await expect(composer).toHaveCount(0);
    expect(await page.evaluate(() => globalThis.overlayHarness.submissions)).toEqual([]);
  });
}

test("submission revalidates the draft target before observers can refresh", async ({ page }) => {
  await loadOverlay(page);
  await page.evaluate(() => globalThis.overlayHarness.setMode("comment"));
  await page.getByRole("button", { name: "Synthetic prototype action" }).click({ position: { x: 20, y: 15 } });
  await expect(page.getByRole("dialog", { name: "Add review comment" })).toBeVisible();

  await page.evaluate(() => {
    document.querySelector("#prototype-action")?.remove();
    const textarea = document.querySelector(".crl-overlay__textarea");
    const form = textarea?.closest("form");
    if (!(textarea instanceof HTMLTextAreaElement) || !(form instanceof HTMLFormElement)) {
      throw new Error("missing composer race fixture");
    }
    textarea.value = "Must fail closed";
    form.requestSubmit();
  });

  await expect(page.getByRole("dialog", { name: "Add review comment" })).toHaveCount(0);
  expect(await page.evaluate(() => globalThis.overlayHarness.submissions)).toEqual([]);
});

test("a Promise-returning local submit callback preserves the draft and consumes rejection", async ({ page }) => {
  await loadOverlay(page);
  await page.evaluate(() => globalThis.overlayHarness.setMode("comment"));
  await page.getByRole("button", { name: "Synthetic prototype action" }).click();
  const composer = page.getByRole("dialog", { name: "Add review comment" });
  const textarea = composer.getByRole("textbox", { name: "Comment" });
  await textarea.fill("Preserve this local draft");
  await page.evaluate(() => globalThis.overlayHarness.rejectNextSubmissionAsynchronously());
  await textarea.press("Control+Enter");
  await page.evaluate(() => globalThis.overlayHarness.settleAsyncEvents());

  await expect(composer).toBeVisible();
  await expect(textarea).toHaveValue("Preserve this local draft");
  expect(await page.evaluate(() => globalThis.overlayHarness.submissions)).toEqual([]);
  expect(await page.evaluate(() => globalThis.overlayHarness.unhandledSubmissionRejections())).toBe(0);
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

test("existing Anchors fail unavailable when marker identity becomes ambiguous", async ({ page }) => {
  await loadOverlay(page);
  await page.evaluate(() => globalThis.overlayHarness.setMode("comment"));
  await page.getByRole("button", { name: "Synthetic prototype action" }).click({ position: { x: 20, y: 15 } });
  await page.getByRole("textbox", { name: "Comment" }).fill("Identity ambiguity fixture");
  await page.getByRole("textbox", { name: "Comment" }).press("Control+Enter");
  const anchor = await page.evaluate(() => (globalThis.overlayHarness.submissions[0] as { anchor: unknown }).anchor);

  await page.evaluate((value) => {
    const duplicate = document.createElement("button");
    duplicate.id = "duplicate-prototype-action";
    duplicate.type = "button";
    duplicate.dataset.collabReviewId = "synthetic-action";
    duplicate.textContent = "Duplicate identity action";
    document.body.appendChild(duplicate);
    const current = value as {
      element: { identity: string; offset: { x: number; y: number } };
    };
    globalThis.overlayHarness.setThreads([{
      threadId: "thread-duplicate-identity",
      anchorGeneration: 1,
      label: "Duplicate identity thread",
      anchor: {
        ...(value as Record<string, unknown>),
        element: { ...current.element, selector: "#prototype-action" },
      },
    }]);
  }, anchor);

  await expect(page.locator(".crl-overlay__pin")).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => globalThis.overlayHarness.unavailableAnchors)).toEqual([{
    threadId: "thread-duplicate-identity",
    anchorGeneration: 1,
  }]);
  expect(await page.evaluate(() => globalThis.overlayHarness.placementDiagnostics)).toEqual([{
    kind: "anchor_unavailable",
    reason: "identity_unresolved",
    threadId: "thread-duplicate-identity",
    anchorGeneration: 1,
  }]);
});

test("motion-path targets fail closed before their local point can drift", async ({ page }) => {
  await loadOverlay(page);
  const action = page.getByRole("button", { name: "Synthetic prototype action" });
  await page.evaluate(() => globalThis.overlayHarness.setMode("comment"));
  await action.click({ position: { x: 20, y: 15 } });
  await page.getByRole("textbox", { name: "Comment" }).fill("Motion path fixture");
  await page.getByRole("textbox", { name: "Comment" }).press("Control+Enter");
  const anchor = await page.evaluate(() => (globalThis.overlayHarness.submissions[0] as { anchor: unknown }).anchor);

  await page.evaluate((value) => {
    const target = document.querySelector("#prototype-action");
    if (!(target instanceof HTMLElement)) throw new Error("missing motion path fixture");
    target.style.setProperty("offset-path", "path('M 0 0 C 60 120 140 -40 220 80')");
    target.style.setProperty("offset-distance", "25%");
    target.style.setProperty("offset-rotate", "auto");
    globalThis.overlayHarness.setThreads([{
      threadId: "thread-motion-path",
      anchorGeneration: 1,
      label: "Motion path thread",
      anchor: value,
    }]);
  }, anchor);

  await expect(page.locator(".crl-overlay__pin")).toHaveCount(0);
  expect(await page.evaluate(() => globalThis.overlayHarness.placementDiagnostics)).toEqual([{
    kind: "placement_bug",
    reason: "unsupported_coordinate_projection",
    threadId: "thread-motion-path",
    anchorGeneration: 1,
  }]);

  await action.evaluate((target) => target.style.setProperty("offset-distance", "75%"));
  await page.evaluate(() => globalThis.overlayHarness.refresh());
  await expect(page.locator(".crl-overlay__pin")).toHaveCount(0);

  const currentPoint = await page.evaluate(() => {
    globalThis.overlayHarness.setThreads([]);
    const target = document.querySelector("#prototype-action");
    if (!(target instanceof HTMLElement)) throw new Error("missing motion path fixture");
    target.style.setProperty("offset-path", "path('M 120 80 L 121 80')");
    target.style.setProperty("offset-distance", "0%");
    target.style.setProperty("offset-rotate", "0deg");
    const rect = target.getBoundingClientRect();
    const point = { x: rect.left + (rect.width / 2), y: rect.top + (rect.height / 2) };
    if (document.elementFromPoint(point.x, point.y)?.closest("[data-collab-review-id]") !== target) {
      throw new Error("motion path capture fixture is not hit-testable");
    }
    return point;
  });
  await page.mouse.click(currentPoint.x, currentPoint.y);
  await expect(page.getByRole("dialog", { name: "Add review comment" })).toHaveCount(0);
  expect(await page.evaluate(() => globalThis.overlayHarness.submissions)).toHaveLength(1);
});

test("a reflowed multi-fragment marker fails closed instead of changing fragments", async ({ page }) => {
  await loadOverlay(page);
  const initialPoint = await page.evaluate(() => {
    const wrapper = document.createElement("div");
    wrapper.id = "fragment-wrapper";
    wrapper.style.cssText = "width: 700px; margin: 40px; font: 16px sans-serif";
    const target = document.createElement("span");
    target.id = "fragment-target";
    target.dataset.collabReviewId = "fragment-target";
    target.textContent = "A synthetic inline marker with enough words to wrap after its containing block becomes narrower.";
    wrapper.appendChild(target);
    document.body.appendChild(wrapper);
    const rects = target.getClientRects();
    if (rects.length !== 1) throw new Error("wide marker did not begin as one fragment");
    const rect = rects[0]!;
    globalThis.overlayHarness.setMode("comment");
    return { x: rect.left + 24, y: rect.top + (rect.height / 2) };
  });
  await page.mouse.click(initialPoint.x, initialPoint.y);
  await page.getByRole("textbox", { name: "Comment" }).fill("Fragment reflow fixture");
  await page.getByRole("textbox", { name: "Comment" }).press("Control+Enter");
  const anchor = await page.evaluate(() => (globalThis.overlayHarness.submissions[0] as { anchor: unknown }).anchor);

  await page.evaluate((value) => {
    globalThis.overlayHarness.setThreads([{
      threadId: "thread-fragmented-marker",
      anchorGeneration: 1,
      label: "Fragmented marker thread",
      anchor: value,
    }]);
    const wrapper = document.querySelector("#fragment-wrapper");
    if (!(wrapper instanceof HTMLElement)) throw new Error("missing fragment wrapper");
    wrapper.style.width = "120px";
    globalThis.overlayHarness.refresh();
  }, anchor);

  await expect.poll(() => page.locator("#fragment-target").evaluate((target) => target.getClientRects().length)).toBeGreaterThan(1);
  await expect(page.locator(".crl-overlay__pin")).toHaveCount(0);
  expect(await page.evaluate(() => globalThis.overlayHarness.placementDiagnostics)).toEqual([{
    kind: "placement_bug",
    reason: "unsupported_coordinate_projection",
    threadId: "thread-fragmented-marker",
    anchorGeneration: 1,
  }]);

  const wrappedPoint = await page.evaluate(() => {
    globalThis.overlayHarness.setThreads([]);
    const target = document.querySelector("#fragment-target");
    if (!(target instanceof HTMLElement)) throw new Error("missing fragmented marker");
    const rect = target.getClientRects()[1];
    if (!rect) throw new Error("missing second marker fragment");
    return { x: rect.left + 4, y: rect.top + (rect.height / 2) };
  });
  await page.mouse.click(wrappedPoint.x, wrappedPoint.y);
  await expect(page.getByRole("dialog", { name: "Add review comment" })).toHaveCount(0);
  expect(await page.evaluate(() => globalThis.overlayHarness.submissions)).toHaveLength(1);
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

test("a transformed SVG target preserves its local geometry across transform changes", async ({ page }) => {
  await loadOverlay(page);
  const clickPoint = await page.evaluate(() => {
    const namespace = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(namespace, "svg");
    svg.id = "synthetic-svg";
    svg.setAttribute("width", "220");
    svg.setAttribute("height", "160");
    svg.setAttribute("viewBox", "0 0 110 80");
    svg.style.position = "absolute";
    svg.style.left = "360px";
    svg.style.top = "180px";
    const target = document.createElementNS(namespace, "rect");
    target.id = "synthetic-svg-target";
    target.setAttribute("x", "20");
    target.setAttribute("y", "10");
    target.setAttribute("width", "120");
    target.setAttribute("height", "70");
    target.setAttribute("fill", "#88aadd");
    target.dataset.collabReviewId = "synthetic-svg-target";
    target.style.transformBox = "fill-box";
    target.style.transformOrigin = "0 0";
    target.style.transform = "rotate(28deg)";
    svg.appendChild(target);
    document.body.appendChild(svg);
    globalThis.overlayHarness.setMode("comment");
    const matrix = target.getScreenCTM();
    if (!matrix) throw new Error("missing SVG transform matrix");
    const point = new DOMPoint(72, 42).matrixTransform(matrix);
    return { x: point.x, y: point.y };
  });
  await page.mouse.click(clickPoint.x, clickPoint.y);
  await page.getByRole("textbox", { name: "Comment" }).fill("Synthetic SVG feedback");
  await page.getByRole("textbox", { name: "Comment" }).press("Control+Enter");
  const anchor = await page.evaluate(() => (globalThis.overlayHarness.submissions[0] as { anchor: unknown }).anchor);
  const offset = (anchor as { element: { offset: { x: number; y: number } } }).element.offset;
  expect(Math.abs(offset.x - 52)).toBeLessThanOrEqual(1.5);
  expect(Math.abs(offset.y - 32)).toBeLessThanOrEqual(1.5);

  await page.evaluate((value) => {
    globalThis.overlayHarness.setThreads([{
      threadId: "thread-svg-transform",
      anchorGeneration: 1,
      label: "SVG transform thread",
      anchor: value,
    }]);
    const target = document.querySelector("#synthetic-svg-target");
    if (!(target instanceof SVGGraphicsElement)) throw new Error("missing SVG target");
    target.style.transform = "rotate(-19deg) scale(1.25, .8)";
  }, anchor);
  const pin = page.getByRole("button", { name: "Open SVG transform thread" });
  await expect.poll(async () => page.evaluate(() => {
    const target = document.querySelector("#synthetic-svg-target");
    const pin = document.querySelector(".crl-overlay__pin");
    if (!(target instanceof SVGGraphicsElement) || !(pin instanceof HTMLElement)) return Number.POSITIVE_INFINITY;
    const matrix = target.getScreenCTM();
    if (!matrix) return Number.POSITIVE_INFINITY;
    const box = target.getBBox();
    const submission = globalThis.overlayHarness.submissions[0] as { anchor: { element: { offset: { x: number; y: number } } } };
    const expected = new DOMPoint(
      box.x + submission.anchor.element.offset.x,
      box.y + submission.anchor.element.offset.y,
    ).matrixTransform(matrix);
    const pinRect = pin.getBoundingClientRect();
    return Math.hypot(
      pinRect.left + (pinRect.width / 2) - expected.x,
      pinRect.top + (pinRect.height / 2) - expected.y,
    );
  })).toBeLessThanOrEqual(1);
  await expect(pin).toBeVisible();
});

test("an SVG pin follows geometry-attribute movement", async ({ page }) => {
  await loadOverlay(page);
  const clickPoint = await page.evaluate(() => {
    const namespace = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(namespace, "svg");
    svg.setAttribute("width", "320");
    svg.setAttribute("height", "220");
    svg.style.cssText = "position:absolute;left:300px;top:160px";
    const target = document.createElementNS(namespace, "rect");
    target.setAttribute("x", "40");
    target.setAttribute("y", "30");
    target.setAttribute("width", "120");
    target.setAttribute("height", "60");
    target.setAttribute("fill", "#6688aa");
    target.dataset.collabReviewId = "svg-geometry-target";
    svg.appendChild(target);
    document.body.appendChild(svg);
    globalThis.overlayHarness.setMode("comment");
    const matrix = target.getScreenCTM();
    if (!matrix) throw new Error("missing SVG geometry matrix");
    const point = new DOMPoint(70, 50).matrixTransform(matrix);
    return { x: point.x, y: point.y };
  });

  await page.mouse.click(clickPoint.x, clickPoint.y);
  await page.getByRole("textbox", { name: "Comment" }).fill("SVG geometry feedback");
  await page.getByRole("textbox", { name: "Comment" }).press("Control+Enter");
  const anchor = await page.evaluate(() => (globalThis.overlayHarness.submissions.at(-1) as { anchor: unknown }).anchor);
  expect((anchor as { element: { offset: unknown } }).element.offset).toEqual({ x: 30, y: 20 });

  await page.evaluate((value) => {
    globalThis.overlayHarness.setThreads([{
      threadId: "thread-svg-geometry",
      anchorGeneration: 1,
      label: "SVG geometry thread",
      anchor: value,
    }]);
    const target = document.querySelector('[data-collab-review-id="svg-geometry-target"]');
    if (!(target instanceof SVGRectElement)) throw new Error("missing SVG geometry target");
    target.setAttribute("x", "140");
    target.setAttribute("y", "90");
  }, anchor);

  await expect.poll(async () => page.evaluate(() => {
    const target = document.querySelector('[data-collab-review-id="svg-geometry-target"]');
    const pin = document.querySelector('.crl-overlay__pin[aria-label="Open SVG geometry thread"]');
    if (!(target instanceof SVGGraphicsElement) || !(pin instanceof HTMLElement)) return Number.POSITIVE_INFINITY;
    const matrix = target.getScreenCTM();
    if (!matrix) return Number.POSITIVE_INFINITY;
    const box = target.getBBox();
    const expected = new DOMPoint(box.x + 30, box.y + 20).matrixTransform(matrix);
    const pinBox = pin.getBoundingClientRect();
    return Math.hypot(
      pinBox.left + (pinBox.width / 2) - expected.x,
      pinBox.top + (pinBox.height / 2) - expected.y,
    );
  })).toBeLessThanOrEqual(1);
});

test("an offset rotated nested SVG viewport clips in its local user space", async ({ page }) => {
  await loadOverlay(page);
  const insidePoint = await page.evaluate(() => {
    const namespace = "http://www.w3.org/2000/svg";
    const outer = document.createElementNS(namespace, "svg");
    outer.setAttribute("width", "500");
    outer.setAttribute("height", "300");
    outer.style.cssText = "position:absolute;left:280px;top:120px;overflow:visible";
    const nested = document.createElementNS(namespace, "svg");
    nested.setAttribute("x", "80");
    nested.setAttribute("y", "50");
    nested.setAttribute("width", "160");
    nested.setAttribute("height", "100");
    nested.setAttribute("viewBox", "0 0 80 100");
    nested.setAttribute("preserveAspectRatio", "xMidYMid meet");
    nested.setAttribute("transform", "rotate(18 160 100)");
    const inside = document.createElementNS(namespace, "rect");
    inside.setAttribute("x", "0");
    inside.setAttribute("y", "0");
    inside.setAttribute("width", "20");
    inside.setAttribute("height", "20");
    inside.setAttribute("transform", "translate(-30 20)");
    inside.setAttribute("fill", "#5588cc");
    inside.dataset.collabReviewId = "nested-svg-inside";
    const outside = document.createElementNS(namespace, "rect");
    outside.setAttribute("x", "0");
    outside.setAttribute("y", "0");
    outside.setAttribute("width", "20");
    outside.setAttribute("height", "20");
    outside.setAttribute("transform", "translate(-60 20)");
    outside.setAttribute("fill", "#cc8855");
    outside.dataset.collabReviewId = "nested-svg-outside";
    nested.append(inside, outside);
    outer.appendChild(nested);
    document.body.appendChild(outer);
    globalThis.overlayHarness.setMode("comment");
    const matrix = inside.getScreenCTM();
    if (!matrix) throw new Error("missing nested SVG screen matrix");
    const point = new DOMPoint(10, 10).matrixTransform(matrix);
    const nestedMatrix = nested.getScreenCTM();
    if (!nestedMatrix) throw new Error("missing nested SVG viewport matrix");
    const nestedLocal = point.matrixTransform(nestedMatrix.inverse());
    return {
      x: point.x,
      y: point.y,
      hitIdentity: (document.elementFromPoint(point.x, point.y) as HTMLElement | SVGElement | null)?.dataset.collabReviewId,
      nestedLocal: { x: nestedLocal.x, y: nestedLocal.y },
    };
  });

  expect(insidePoint.hitIdentity).toBe("nested-svg-inside");
  expect(insidePoint.nestedLocal.x).toBeCloseTo(-20, 6);
  expect(insidePoint.nestedLocal.y).toBeCloseTo(30, 6);
  await page.mouse.click(insidePoint.x, insidePoint.y);
  await expect(page.getByRole("dialog", { name: "Add review comment" })).toBeVisible();
  await page.keyboard.press("Escape");

  await page.evaluate(() => globalThis.overlayHarness.setThreads([
    {
      threadId: "thread-nested-svg-inside",
      anchorGeneration: 1,
      label: "Nested SVG inside thread",
      anchor: {
        schemaVersion: 2,
        locationAvailability: "available",
        recoveryState: "not_required",
        context: globalThis.overlayHarness.context,
        element: {
          selector: '[data-collab-review-id="nested-svg-inside"]',
          identity: "nested-svg-inside",
          offset: { x: 10, y: 10 },
        },
        document: { x: 1, y: 1, width: 1280, height: 720 },
      },
    },
    {
      threadId: "thread-nested-svg-outside",
      anchorGeneration: 1,
      label: "Nested SVG outside thread",
      anchor: {
        schemaVersion: 2,
        locationAvailability: "available",
        recoveryState: "not_required",
        context: globalThis.overlayHarness.context,
        element: {
          selector: '[data-collab-review-id="nested-svg-outside"]',
          identity: "nested-svg-outside",
          offset: { x: 10, y: 10 },
        },
        document: { x: 1, y: 1, width: 1280, height: 720 },
      },
    },
  ]));

  await expect(page.getByRole("button", { name: "Open Nested SVG inside thread", includeHidden: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open Nested SVG outside thread", includeHidden: true })).toBeHidden();
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

test("CSS zoom on a target preserves the captured local point across zoom changes", async ({ page }) => {
  await loadOverlay(page);
  const target = page.getByRole("button", { name: "Synthetic prototype action" });
  await page.evaluate(() => {
    globalThis.overlayHarness.setTargetZoom("2");
    globalThis.overlayHarness.setMode("comment");
  });
  const capturedBox = await target.boundingBox();
  expect(capturedBox).not.toBeNull();
  await page.mouse.click(capturedBox!.x + 80, capturedBox!.y + 40);
  await page.getByRole("textbox", { name: "Comment" }).fill("Zoomed target feedback");
  await page.getByRole("textbox", { name: "Comment" }).press("Control+Enter");
  const anchor = await page.evaluate(() => (globalThis.overlayHarness.submissions[0] as { anchor: unknown }).anchor);
  const offset = (anchor as { element: { offset: { x: number; y: number } } }).element.offset;
  expect(offset.x).toBeCloseTo(40, 1);
  expect(offset.y).toBeCloseTo(20, 1);

  await page.evaluate((value) => globalThis.overlayHarness.setThreads([{
    threadId: "thread-zoom-target",
    anchorGeneration: 1,
    label: "Zoom target thread",
    anchor: value,
  }]), anchor);
  await page.evaluate(() => globalThis.overlayHarness.setTargetZoom("1.25"));
  const pin = page.getByRole("button", { name: "Open Zoom target thread", includeHidden: true });
  await expect.poll(async () => {
    const targetBox = await target.boundingBox();
    const pinBox = await pin.boundingBox();
    return {
      x: Math.round((pinBox?.x ?? 0) + ((pinBox?.width ?? 0) / 2) - (targetBox?.x ?? 0)),
      y: Math.round((pinBox?.y ?? 0) + ((pinBox?.height ?? 0) / 2) - (targetBox?.y ?? 0)),
    };
  }).toEqual({ x: 50, y: 25 });
});

test("inherited ancestor CSS zoom preserves the captured local point", async ({ page }) => {
  await loadOverlay(page);
  const target = page.getByRole("button", { name: "Ancestor transform target" });
  await page.evaluate(() => {
    globalThis.overlayHarness.setAncestorZoom("2");
    globalThis.overlayHarness.setMode("comment");
  });
  const capturedBox = await target.boundingBox();
  expect(capturedBox).not.toBeNull();
  await page.mouse.click(capturedBox!.x + 80, capturedBox!.y + 40);
  await page.getByRole("textbox", { name: "Comment" }).fill("Ancestor zoom feedback");
  await page.getByRole("textbox", { name: "Comment" }).press("Control+Enter");
  const anchor = await page.evaluate(() => (globalThis.overlayHarness.submissions[0] as { anchor: unknown }).anchor);
  const offset = (anchor as { element: { offset: { x: number; y: number } } }).element.offset;
  expect(offset.x).toBeCloseTo(40, 1);
  expect(offset.y).toBeCloseTo(20, 1);

  await page.evaluate((value) => globalThis.overlayHarness.setThreads([{
    threadId: "thread-ancestor-zoom",
    anchorGeneration: 1,
    label: "Ancestor zoom thread",
    anchor: value,
  }]), anchor);
  await page.evaluate(() => globalThis.overlayHarness.setAncestorZoom("1.25"));
  const pin = page.getByRole("button", { name: "Open Ancestor zoom thread", includeHidden: true });
  await expect.poll(async () => {
    const targetBox = await target.boundingBox();
    const pinBox = await pin.boundingBox();
    return {
      x: Math.round((pinBox?.x ?? 0) + ((pinBox?.width ?? 0) / 2) - (targetBox?.x ?? 0)),
      y: Math.round((pinBox?.y ?? 0) + ((pinBox?.height ?? 0) / 2) - (targetBox?.y ?? 0)),
    };
  }).toEqual({ x: 50, y: 25 });
});

test("independent transforms on a target and ancestor preserve element-local placement", async ({ page }) => {
  await loadOverlay(page);
  const target = page.getByRole("button", { name: "Ancestor transform target" });
  const expectedOffset = await page.evaluate(() => {
    const target = document.querySelector("#ancestor-transform-target")!.getBoundingClientRect();
    const reference = document.querySelector("#nested-3d-reference")!.getBoundingClientRect();
    return {
      x: (reference.left + (reference.width / 2)) - target.left,
      y: (reference.top + (reference.height / 2)) - target.top,
    };
  });
  await page.locator("#ancestor-transform-parent").evaluate((element) => {
    const htmlElement = element as HTMLElement;
    htmlElement.style.transformOrigin = "0 0";
    htmlElement.style.translate = "18px 12px";
    htmlElement.style.rotate = "12deg";
    htmlElement.style.scale = "1.25 1.1";
  });
  await target.evaluate((element) => {
    const htmlElement = element as HTMLElement;
    htmlElement.style.transformOrigin = "0 0";
    htmlElement.style.translate = "10px 6px";
    htmlElement.style.rotate = "-6deg";
    htmlElement.style.scale = "1.3 1.2";
  });
  await page.evaluate(() => globalThis.overlayHarness.setMode("comment"));
  const transformedBox = await page.locator("#nested-3d-reference").boundingBox();
  expect(transformedBox).not.toBeNull();
  await page.mouse.click(
    transformedBox!.x + (transformedBox!.width / 2),
    transformedBox!.y + (transformedBox!.height / 2),
  );
  await page.getByRole("textbox", { name: "Comment" }).fill("Independent transform feedback");
  await page.getByRole("textbox", { name: "Comment" }).press("Control+Enter");
  const anchor = await page.evaluate(() => (globalThis.overlayHarness.submissions[0] as { anchor: unknown }).anchor);
  const offset = (anchor as { element: { offset: { x: number; y: number } } }).element.offset;
  expect(offset.x).toBeCloseTo(expectedOffset.x, 0);
  expect(offset.y).toBeCloseTo(expectedOffset.y, 0);

  await page.evaluate((value) => globalThis.overlayHarness.setThreads([{
    threadId: "thread-independent-transform",
    anchorGeneration: 1,
    label: "Independent transform thread",
    anchor: value,
  }]), anchor);
  const pin = page.getByRole("button", { name: "Open Independent transform thread" });
  await page.locator("#ancestor-transform-parent").evaluate((element) => {
    const htmlElement = element as HTMLElement;
    htmlElement.style.translate = "";
    htmlElement.style.rotate = "";
    htmlElement.style.scale = "";
  });
  await target.evaluate((element) => {
    const htmlElement = element as HTMLElement;
    htmlElement.style.translate = "";
    htmlElement.style.rotate = "";
    htmlElement.style.scale = "";
  });
  await expect.poll(async () => {
    const targetBox = await target.boundingBox();
    const pinBox = await pin.boundingBox();
    return {
      x: Math.round((pinBox?.x ?? 0) + ((pinBox?.width ?? 0) / 2) - (targetBox?.x ?? 0)),
      y: Math.round((pinBox?.y ?? 0) + ((pinBox?.height ?? 0) / 2) - (targetBox?.y ?? 0)),
    };
  }).toEqual({ x: Math.round(expectedOffset.x), y: Math.round(expectedOffset.y) });
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

test("a grouping property forces a computed preserve-3d ancestor to flatten", async ({ page }) => {
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
    const htmlElement = element as HTMLElement;
    htmlElement.style.transformOrigin = "0 0";
    htmlElement.style.transform = "rotateY(35deg)";
    htmlElement.style.transformStyle = "preserve-3d";
    htmlElement.style.opacity = "0.8";
  });
  await target.evaluate((element) => {
    const htmlElement = element as HTMLElement;
    htmlElement.style.transformOrigin = "0 0";
    htmlElement.style.transform = "rotateX(40deg)";
  });
  expect(await page.locator("#ancestor-transform-parent").evaluate((element) => getComputedStyle(element).transformStyle)).toBe("preserve-3d");
  await page.evaluate((anchorOffset) => globalThis.overlayHarness.setThreads([{
    threadId: "thread-forced-flat-3d",
    anchorGeneration: 1,
    label: "Forced flat 3D thread",
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

  const pin = page.getByRole("button", { name: "Open Forced flat 3D thread", includeHidden: true });
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

test("IME composition owns Escape and submit-shortcut key events", async ({ page }) => {
  await loadOverlay(page);
  await page.evaluate(() => globalThis.overlayHarness.setMode("comment"));
  await page.getByRole("button", { name: "Synthetic prototype action" }).click({ position: { x: 20, y: 15 } });
  const textarea = page.getByRole("textbox", { name: "Comment" });
  await textarea.fill("Composing synthetic text");

  const dispatchComposingKey = async (key: string, control = false): Promise<void> => {
    await textarea.evaluate((element, value) => {
      element.dispatchEvent(new KeyboardEvent("keydown", {
        key: value.key,
        ctrlKey: value.control,
        isComposing: true,
        bubbles: true,
        cancelable: true,
        composed: true,
      }));
    }, { key, control });
  };
  await dispatchComposingKey("Escape");
  await expect(textarea).toHaveValue("Composing synthetic text");
  await expect(page.getByRole("dialog", { name: "Add review comment" })).toBeVisible();

  await dispatchComposingKey("Enter", true);
  await expect(page.getByRole("dialog", { name: "Add review comment" })).toBeVisible();
  expect(await page.evaluate(() => globalThis.overlayHarness.submissions)).toEqual([]);
});

test("script-generated Escape remains prototype-owned while a draft is open", async ({ page }) => {
  await loadOverlay(page);
  await page.evaluate(() => globalThis.overlayHarness.setMode("comment"));
  await page.getByRole("button", { name: "Synthetic prototype action" }).click({ position: { x: 20, y: 15 } });
  const textarea = page.getByRole("textbox", { name: "Comment" });
  await textarea.fill("Preserve this draft");

  const result = await textarea.evaluate((element) => {
    let reachedPrototype = false;
    document.addEventListener("keydown", () => { reachedPrototype = true; }, { once: true });
    const event = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
      composed: true,
    });
    return {
      dispatched: element.dispatchEvent(event),
      defaultPrevented: event.defaultPrevented,
      reachedPrototype,
    };
  });

  expect(result).toEqual({ dispatched: true, defaultPrevented: false, reachedPrototype: true });
  await expect(textarea).toHaveValue("Preserve this draft");
  await expect(page.getByRole("dialog", { name: "Add review comment" })).toBeVisible();
});

test("the overlay relocates into an active modal dialog and returns to the document afterward", async ({ page }) => {
  await loadOverlay(page);
  await page.evaluate(() => {
    const dialog = document.createElement("dialog");
    dialog.id = "synthetic-modal";
    const action = document.createElement("button");
    action.type = "button";
    action.dataset.collabReviewId = "synthetic-modal-action";
    action.textContent = "Modal prototype action";
    action.style.width = "160px";
    action.style.height = "80px";
    dialog.appendChild(action);
    document.body.appendChild(dialog);
    dialog.showModal();
    globalThis.overlayHarness.setMode("comment");
  });
  await expect.poll(() => page.locator("[data-collab-review-layer='overlay']").evaluate((element) => element.parentElement?.id)).toBe("synthetic-modal");

  await page.getByRole("button", { name: "Modal prototype action" }).click({ position: { x: 30, y: 20 } });
  const textarea = page.getByRole("textbox", { name: "Comment" });
  await expect(textarea).toBeFocused();
  await textarea.fill("Synthetic modal feedback");
  await textarea.press("Control+Enter");
  const anchor = await page.evaluate(() => (globalThis.overlayHarness.submissions.at(-1) as { anchor: unknown }).anchor);
  await page.evaluate((value) => globalThis.overlayHarness.setThreads([{
    threadId: "thread-modal",
    anchorGeneration: 1,
    label: "Modal thread",
    anchor: value,
  }]), anchor);
  const pin = page.getByRole("button", { name: "Open Modal thread" });
  await expect(pin).toBeVisible();
  await pin.click();
  expect(await page.evaluate(() => globalThis.overlayHarness.openedThreads.at(-1)?.threadId)).toBe("thread-modal");

  await page.evaluate(() => (document.querySelector("#synthetic-modal") as HTMLDialogElement).close());
  await expect.poll(() => page.locator("[data-collab-review-layer='overlay']").evaluate((element) => element.parentElement?.tagName)).toBe("BODY");
});

test("the overlay follows modal top-layer order instead of dialog DOM order", async ({ page }) => {
  await loadOverlay(page);
  await page.evaluate(() => {
    const first = document.createElement("dialog");
    first.id = "first-modal-in-dom";
    const firstAction = document.createElement("button");
    firstAction.type = "button";
    firstAction.dataset.collabReviewId = "first-modal-action";
    firstAction.textContent = "Top modal action";
    first.appendChild(firstAction);
    const second = document.createElement("dialog");
    second.id = "second-modal-in-dom";
    const secondAction = document.createElement("button");
    secondAction.type = "button";
    secondAction.textContent = "Lower modal action";
    second.appendChild(secondAction);
    document.body.append(first, second);
    second.showModal();
    first.showModal();
    globalThis.overlayHarness.setMode("comment");
    globalThis.overlayHarness.refresh();
  });

  const root = page.locator("[data-collab-review-layer='overlay']");
  await expect.poll(() => root.evaluate((element) => element.parentElement?.id)).toBe("first-modal-in-dom");
  await page.getByRole("button", { name: "Top modal action" }).click({ position: { x: 20, y: 15 } });
  await expect(page.getByRole("textbox", { name: "Comment" })).toBeFocused();

  await page.evaluate(() => {
    (document.querySelector("#first-modal-in-dom") as HTMLDialogElement).close();
    globalThis.overlayHarness.refresh();
  });
  await expect.poll(() => root.evaluate((element) => element.parentElement?.id)).toBe("second-modal-in-dom");

  await page.evaluate(() => {
    (document.querySelector("#second-modal-in-dom") as HTMLDialogElement).close();
    globalThis.overlayHarness.refresh();
  });
  await expect.poll(() => root.evaluate((element) => element.parentElement?.tagName)).toBe("BODY");
});

test("a later prototype popover cannot cover existing pins or a new composer", async ({ page }) => {
  await loadOverlay(page);
  await page.evaluate(() => {
    globalThis.overlayHarness.setMode("comment");
    globalThis.overlayHarness.setThreads([{
      threadId: "thread-later-popover",
      anchorGeneration: 1,
      label: "Later popover thread",
      anchor: {
        schemaVersion: 2,
        locationAvailability: "available",
        recoveryState: "not_required",
        context: globalThis.overlayHarness.context,
        element: {
          selector: '[data-collab-review-id="synthetic-action"]',
          identity: "synthetic-action",
          offset: { x: 20, y: 15 },
        },
        document: { x: 60, y: 55, width: 1280, height: 720 },
      },
    }]);
  });
  const root = page.locator("[data-collab-review-layer='overlay']");
  const originalRoot = await root.elementHandle();
  expect(originalRoot).not.toBeNull();
  const pin = page.getByRole("button", { name: "Open Later popover thread" });
  await expect(pin).toBeVisible();

  await page.evaluate(() => {
    const popover = document.createElement("div");
    popover.id = "later-prototype-popover";
    popover.popover = "manual";
    popover.style.cssText = "position:fixed;inset:0;width:100vw;height:100vh;margin:0;padding:120px 40px;background:rgb(245 247 250)";
    const action = document.createElement("button");
    action.type = "button";
    action.dataset.collabReviewId = "later-popover-action";
    action.textContent = "Later popover action";
    action.style.cssText = "width:160px;height:80px";
    popover.appendChild(action);
    document.body.appendChild(popover);
    popover.showPopover();
  });

  await expect.poll(async () => pin.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return document.elementFromPoint(rect.left + (rect.width / 2), rect.top + (rect.height / 2)) === element;
  })).toBe(true);
  await pin.click();
  expect(await page.evaluate(() => globalThis.overlayHarness.openedThreads.at(-1)?.threadId)).toBe("thread-later-popover");

  await page.getByRole("button", { name: "Later popover action" }).click({ position: { x: 30, y: 20 } });
  const textarea = page.getByRole("textbox", { name: "Comment" });
  await expect(textarea).toBeVisible();
  expect(await textarea.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return document.elementFromPoint(rect.left + (rect.width / 2), rect.top + (rect.height / 2)) === element;
  })).toBe(true);
  expect(await page.evaluate(() => (document.querySelector("#later-prototype-popover") as HTMLElement).matches(":popover-open"))).toBe(true);
  expect(await page.evaluate((element) => document.querySelector("[data-collab-review-layer='overlay']") === element, originalRoot)).toBe(true);
});

test("a programmatic popover in an open shadow root cannot cover active review controls", async ({ page }) => {
  await loadOverlay(page, "?openShadowAnchors=true");
  await page.evaluate(() => {
    globalThis.overlayHarness.setMode("comment");
    globalThis.overlayHarness.setThreads([{
      threadId: "thread-shadow-popover",
      anchorGeneration: 1,
      label: "Shadow popover thread",
      anchor: {
        schemaVersion: 2,
        locationAvailability: "available",
        recoveryState: "not_required",
        context: globalThis.overlayHarness.context,
        element: {
          selector: '[data-collab-review-id="synthetic-action"]',
          identity: "synthetic-action",
          offset: { x: 20, y: 15 },
        },
        document: { x: 60, y: 55, width: 1280, height: 720 },
      },
    }]);
    globalThis.overlayHarness.openShadowPopover();
  });
  const pin = page.getByRole("button", { name: "Open Shadow popover thread" });
  await expect(pin).toBeVisible();
  await expect.poll(() => pin.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return document.elementFromPoint(rect.left + (rect.width / 2), rect.top + (rect.height / 2)) === element;
  })).toBe(true);
});

test("a styled modal inside open shadow DOM keeps its focused composer styled and hosted", async ({ page }) => {
  await loadOverlay(page);
  await page.evaluate(async () => {
    await globalThis.overlayHarness.openShadowModal(true);
    globalThis.overlayHarness.setMode("comment");
  });
  await page.getByRole("button", { name: "Styled shadow modal action" }).click({ position: { x: 20, y: 15 } });
  const composer = page.getByRole("dialog", { name: "Add review comment" });
  await expect(composer).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Comment" })).toBeFocused();
  await page.evaluate(() => globalThis.overlayHarness.refresh());
  await expect.poll(() => page.locator("[data-collab-review-layer='overlay']").evaluate((root) => ({
    parent: root.parentElement?.id,
    style: getComputedStyle(root).getPropertyValue("--crl-overlay-owned").trim(),
  }))).toEqual({ parent: "styled-shadow-modal", style: "1" });

  await page.evaluate(() => globalThis.overlayHarness.setThreads([{
    threadId: "thread-styled-shadow-modal",
    anchorGeneration: 1,
    label: "Styled shadow modal thread",
    anchor: {
      schemaVersion: 2,
      locationAvailability: "available",
      recoveryState: "not_required",
      context: globalThis.overlayHarness.context,
      element: {
        selector: '[data-collab-review-id="styled-shadow-modal-action"]',
        identity: "styled-shadow-modal-action",
        offset: { x: 20, y: 15 },
      },
      document: { x: 20, y: 15, width: 1280, height: 720 },
    },
  }]));
  const shadowPin = page.locator('.crl-overlay__pin[aria-label="Open Styled shadow modal thread"]');
  await shadowPin.focus();
  await expect(shadowPin).toBeFocused();
  await page.evaluate(() => globalThis.overlayHarness.setMode("pointer"));
  await expect(shadowPin).not.toBeFocused();
  await expect(shadowPin).toHaveAttribute("aria-hidden", "true");
});

test("one composed-tree index serves every anchor lookup in a placement refresh", async ({ page }) => {
  await loadOverlay(page);
  await page.evaluate(() => globalThis.overlayHarness.setThreads(Array.from({ length: 40 }, (_, index) => ({
    threadId: `thread-index-${index}`,
    anchorGeneration: 1,
    label: `Indexed thread ${index}`,
    anchor: {
      schemaVersion: 2,
      locationAvailability: "available",
      recoveryState: "not_required",
      context: globalThis.overlayHarness.context,
      element: {
        selector: '[data-collab-review-id="synthetic-action"]',
        identity: "synthetic-action",
        offset: { x: 20, y: 15 },
      },
      document: { x: 60, y: 55, width: 1280, height: 720 },
    },
  }))));

  expect(await page.evaluate(() => globalThis.overlayHarness.measureRefreshOpenTreeScans())).toBeLessThanOrEqual(2);
});

test("a rehosted overlay still prevents a second overlay from mounting", async ({ page }) => {
  await loadOverlay(page);
  await page.evaluate(async () => {
    await globalThis.overlayHarness.openShadowModal(true);
    globalThis.overlayHarness.refresh();
  });
  await expect.poll(() => page.locator("[data-collab-review-layer='overlay']").evaluate((root) => root.parentElement?.id))
    .toBe("styled-shadow-modal");

  expect(await page.evaluate(() => globalThis.overlayHarness.tryMountSecondOverlay())).toEqual({
    accepted: false,
    errorName: "ReviewDocumentOverlayError",
    code: "invalid_state",
  });
  await expect(page.locator("[data-collab-review-layer='overlay']")).toHaveCount(1);
});

test("an unstyled modal inside open shadow DOM hides review controls instead of rehosting them unstyled", async ({ page }) => {
  await loadOverlay(page);
  await page.evaluate(async () => {
    await globalThis.overlayHarness.openShadowModal(false);
    globalThis.overlayHarness.setMode("comment");
  });
  await page.getByRole("button", { name: "Unstyled shadow modal action" }).click({ position: { x: 20, y: 15 } });
  await expect.poll(() => page.locator("[data-collab-review-layer='overlay']").evaluate((root) => ({
    hidden: (root as HTMLElement).hidden,
    parent: root.parentElement?.tagName,
    style: getComputedStyle(root).getPropertyValue("--crl-overlay-owned").trim(),
  }))).toEqual({ hidden: true, parent: "BODY", style: "1" });
});

test("an open shadow modal can recover after its owned styles finish loading", async ({ page }) => {
  await loadOverlay(page);
  await page.evaluate(async () => {
    await globalThis.overlayHarness.openShadowModal(false);
    globalThis.overlayHarness.setMode("comment");
  });
  expect(await page.evaluate(() => {
    const root = document.body.querySelector("[data-collab-review-layer='overlay']");
    return { count: root ? 1 : 0, hidden: (root as HTMLElement | null)?.hidden };
  })).toEqual({ count: 1, hidden: true });

  await page.evaluate(async () => {
    await globalThis.overlayHarness.styleOpenShadowModal();
    globalThis.overlayHarness.refresh();
  });
  await expect.poll(() => page.evaluate(() => {
    const host = document.querySelector("#unstyled-shadow-modal-host");
    const root = host?.shadowRoot?.querySelector("[data-collab-review-layer='overlay']");
    return root ? {
      hidden: (root as HTMLElement).hidden,
      parent: root.parentElement?.id,
      style: getComputedStyle(root).getPropertyValue("--crl-overlay-owned").trim(),
    } : undefined;
  })).toEqual({ hidden: false, parent: "unstyled-shadow-modal", style: "1" });

  await page.getByRole("button", { name: "Unstyled shadow modal action" }).click({ position: { x: 20, y: 15 } });
  const composer = page.getByRole("dialog", { name: "Add review comment" });
  await expect(composer).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Comment" })).toBeFocused();
});

test("modal hosting uses the supplied document realm", async ({ page }) => {
  await loadOverlay(page);
  const result = await page.evaluate(() => globalThis.overlayHarness.createCrossRealmModalOverlay());
  expect(result).toEqual({
    activeElement: "Foreign top modal action",
    rootParent: "foreign-first-modal",
    rootOpen: true,
  });
});

test("construction rejects every supplied non-function optional callback", async ({ page }) => {
  await loadOverlay(page);
  const results = await page.evaluate(() => [
    "onReplaceAnchor",
    "onOpenThread",
    "onThreadAttachmentChange",
    "onAnchorUnavailable",
    "onPlacementDiagnostic",
  ].map((name) => globalThis.overlayHarness.tryInvalidCallback(name)));
  expect(results).toEqual([
    "onReplaceAnchor",
    "onOpenThread",
    "onThreadAttachmentChange",
    "onAnchorUnavailable",
    "onPlacementDiagnostic",
  ].map((name) => ({ name, accepted: false, errorName: "ReviewDocumentOverlayError", code: "invalid_config" })));
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

test("schema 3 unavailable Anchors reject the schema-2-only legacy recovery state", async ({ page }) => {
  await loadOverlay(page);
  const results = await page.evaluate(() => [
    { schemaVersion: 2, recoveryState: "legacy_replacement_required" },
    { schemaVersion: 3, recoveryState: "legacy_replacement_required" },
    { schemaVersion: 3, recoveryState: "orphaned_replacement_required" },
  ].map(({ schemaVersion, recoveryState }) => {
    try {
      globalThis.overlayHarness.setThreads([{
        threadId: `thread-unavailable-${schemaVersion}-${recoveryState}`,
        anchorGeneration: 1,
        anchor: {
          schemaVersion,
          locationAvailability: "unavailable",
          recoveryState,
          context: globalThis.overlayHarness.context,
        },
      }]);
      return { schemaVersion, recoveryState, accepted: true };
    } catch (error) {
      const typed = error as { name?: unknown; code?: unknown };
      return { schemaVersion, recoveryState, name: typed.name, code: typed.code };
    }
  }));

  expect(results).toEqual([
    { schemaVersion: 2, recoveryState: "legacy_replacement_required", accepted: true },
    {
      schemaVersion: 3,
      recoveryState: "legacy_replacement_required",
      name: "ReviewDocumentOverlayError",
      code: "invalid_config",
    },
    { schemaVersion: 3, recoveryState: "orphaned_replacement_required", accepted: true },
  ]);
});

test("setThreads normalizes optional Anchor evidence or rejects it as invalid config", async ({ page }) => {
  await loadOverlay(page);
  const results = await page.evaluate(() => {
    const current = {
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
    };
    const candidates = [
      { ...current, semantic: { role: 42 } },
      { ...current, text: { prefix: "missing exact text" } },
      { ...current, semantic: { role: "button", extension: () => undefined } },
    ];
    return candidates.map((anchor, index) => {
      try {
        globalThis.overlayHarness.setThreads([{
          threadId: `thread-invalid-evidence-${index}`,
          anchorGeneration: 1,
          anchor,
        }]);
        return { accepted: true };
      } catch (error) {
        const typed = error as { name?: unknown; code?: unknown };
        return { name: typed.name, code: typed.code };
      }
    });
  });

  expect(results).toEqual([
    { name: "ReviewDocumentOverlayError", code: "invalid_config" },
    { name: "ReviewDocumentOverlayError", code: "invalid_config" },
    { name: "ReviewDocumentOverlayError", code: "invalid_config" },
  ]);
  await expect(page.locator(".crl-overlay__pin")).toHaveCount(0);
});

test("setThreads scopes signed element offsets to Anchor schema version 3", async ({ page }) => {
  await loadOverlay(page);
  const results = await page.evaluate(() => {
    const anchor = {
      locationAvailability: "available",
      recoveryState: "not_required",
      context: globalThis.overlayHarness.context,
      element: {
        selector: "[data-collab-review-id=\"synthetic-action\"]",
        identity: "synthetic-action",
        offset: { x: -20, y: -15 },
      },
      document: { x: 60, y: 55, width: 1280, height: 720 },
    };
    return [2, 3].map((schemaVersion) => {
      try {
        globalThis.overlayHarness.setThreads([{
          threadId: `thread-signed-schema-${schemaVersion}`,
          anchorGeneration: 1,
          anchor: { ...anchor, schemaVersion },
        }]);
        return { schemaVersion, accepted: true };
      } catch (error) {
        const typed = error as { name?: unknown; code?: unknown };
        return { schemaVersion, name: typed.name, code: typed.code };
      }
    });
  });

  expect(results).toEqual([
    { schemaVersion: 2, name: "ReviewDocumentOverlayError", code: "invalid_config" },
    { schemaVersion: 3, accepted: true },
  ]);
});

test("setThreads accepts Anchor evidence limits and rejects every maximum plus one", async ({ page }) => {
  await loadOverlay(page);
  const result = await page.evaluate(() => {
    const current = {
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
    };
    globalThis.overlayHarness.setThreads([{
      threadId: "thread-maximum-evidence",
      anchorGeneration: 1,
      anchor: {
        ...current,
        semantic: {
          role: "r".repeat(256),
          accessibleName: "a".repeat(2_048),
          testId: "i".repeat(256),
        },
        text: {
          exact: "e".repeat(4_096),
          prefix: "p".repeat(1_024),
          suffix: "s".repeat(1_024),
        },
      },
    }]);
    const overLimitEvidence = [
      { semantic: { role: "r".repeat(257) } },
      { semantic: { accessibleName: "a".repeat(2_049) } },
      { semantic: { testId: "i".repeat(257) } },
      { text: { exact: "e".repeat(4_097) } },
      { text: { exact: "exact", prefix: "p".repeat(1_025) } },
      { text: { exact: "exact", suffix: "s".repeat(1_025) } },
    ];
    const rejected = overLimitEvidence.map((evidence, index) => {
      try {
        globalThis.overlayHarness.setThreads([{
          threadId: `thread-over-limit-evidence-${index}`,
          anchorGeneration: 1,
          anchor: { ...current, ...evidence },
        }]);
        return { accepted: true };
      } catch (error) {
        const typed = error as { name?: unknown; code?: unknown };
        return { name: typed.name, code: typed.code };
      }
    });
    return { maximumAccepted: true, rejected };
  });

  expect(result).toEqual({
    maximumAccepted: true,
    rejected: Array.from({ length: 6 }, () => ({
      name: "ReviewDocumentOverlayError",
      code: "invalid_config",
    })),
  });
});

test("setThreads rejects inherited and accessor-backed Anchor evidence without invoking getters", async ({ page }) => {
  await loadOverlay(page);
  const results = await page.evaluate(() => {
    const current = {
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
    };
    let getterCalls = 0;
    const accessorSemantic = {};
    Object.defineProperty(accessorSemantic, "role", {
      enumerable: true,
      get: () => { getterCalls += 1; return "button"; },
    });
    const candidates = [
      { ...current, semantic: Object.create({ role: "button" }) },
      { ...current, text: Object.create({ exact: "inherited" }) },
      { ...current, semantic: accessorSemantic },
    ];
    const rejected = candidates.map((anchor, index) => {
      try {
        globalThis.overlayHarness.setThreads([{
          threadId: `thread-unsafe-evidence-${index}`,
          anchorGeneration: 1,
          anchor,
        }]);
        return { accepted: true };
      } catch (error) {
        const typed = error as { name?: unknown; code?: unknown };
        return { name: typed.name, code: typed.code };
      }
    });
    return { rejected, getterCalls };
  });

  expect(results).toEqual({
    rejected: Array.from({ length: 3 }, () => ({
      name: "ReviewDocumentOverlayError",
      code: "invalid_config",
    })),
    getterCalls: 0,
  });
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

test("external root removal reattaches and reopens the mounted overlay", async ({ page }) => {
  await loadOverlay(page);
  await page.evaluate(() => globalThis.overlayHarness.setThreads([{
    threadId: "thread-external-root-removal",
    anchorGeneration: 1,
    label: "External root removal thread",
    anchor: {
      schemaVersion: 2,
      locationAvailability: "available",
      recoveryState: "not_required",
      context: globalThis.overlayHarness.context,
      element: {
        selector: '[data-collab-review-id="synthetic-action"]',
        identity: "synthetic-action",
        offset: { x: 20, y: 15 },
      },
      document: { x: 60, y: 55, width: 1280, height: 720 },
    },
  }]));
  const root = page.locator("[data-collab-review-layer='overlay']");
  const pin = page.getByRole("button", { name: "Open External root removal thread", includeHidden: true });
  await expect(pin).toBeVisible();

  await root.evaluate((element) => element.remove());

  await expect(root).toHaveCount(1);
  await expect.poll(() => root.evaluate((element) => element.parentElement?.tagName)).toBe("BODY");
  await expect.poll(() => root.evaluate((element) => element.matches(":popover-open"))).toBe(true);
  await expect(pin).toBeVisible();
  expect(await page.evaluate(() => globalThis.overlayHarness.snapshot())).toMatchObject({ state: "mounted" });
});

test("document body replacement reattaches the overlay and observes the new body", async ({ page }) => {
  await loadOverlay(page, "?instrumentResizeObserver=true");
  await page.evaluate(() => globalThis.overlayHarness.setThreads([{
    threadId: "thread-body-replacement",
    anchorGeneration: 1,
    label: "Body replacement thread",
    anchor: {
      schemaVersion: 2,
      locationAvailability: "available",
      recoveryState: "not_required",
      context: globalThis.overlayHarness.context,
      element: {
        selector: '[data-collab-review-id="synthetic-action"]',
        identity: "synthetic-action",
        offset: { x: 20, y: 15 },
      },
      document: { x: 60, y: 55, width: 1280, height: 720 },
    },
  }]));

  const originalRoot = await page.locator("[data-collab-review-layer='overlay']").elementHandle();
  if (!originalRoot) throw new Error("missing original overlay root");
  await page.evaluate(() => {
    const replacement = document.createElement("body");
    const action = document.createElement("button");
    action.id = "replacement-body-action";
    action.type = "button";
    action.dataset.collabReviewId = "synthetic-action";
    action.textContent = "Replacement body action";
    replacement.appendChild(action);
    document.documentElement.replaceChild(replacement, document.body);
  });

  const root = page.locator("[data-collab-review-layer='overlay']");
  const pin = page.getByRole("button", { name: "Open Body replacement thread", includeHidden: true });
  await expect(root).toHaveCount(1);
  expect(await page.evaluate((element) => document.querySelector("[data-collab-review-layer='overlay']") === element, originalRoot)).toBe(true);
  await expect.poll(() => root.evaluate((element) => element.parentElement?.tagName)).toBe("BODY");
  await expect.poll(() => root.evaluate((element) => element.matches(":popover-open"))).toBe(true);
  await expect(pin).toBeVisible();
  expect((await page.evaluate(() => globalThis.overlayHarness.resizeObserverOperations())).filter(({ target }) => target.endsWith("body"))).toEqual([
    { type: "observe", target: "initial-body" },
    { type: "unobserve", target: "initial-body" },
    { type: "observe", target: "current-body" },
  ]);
  const before = await pin.boundingBox();

  await page.evaluate(() => {
    const sheet = document.styleSheets[0];
    if (!sheet) throw new Error("missing same-origin fixture stylesheet");
    sheet.insertRule("#replacement-body-action { margin-left: 180px; }");
    globalThis.overlayHarness.flushResizeObserver();
  });
  await expect.poll(async () => (await pin.boundingBox())?.x).toBeGreaterThan((before?.x ?? 0) + 100);

  await page.evaluate(() => globalThis.overlayHarness.setMode("comment"));
  await page.getByRole("button", { name: "Replacement body action" }).click({ position: { x: 120, y: 15 } });
  await expect(page.getByRole("dialog", { name: "Add review comment" })).toBeVisible();
  expect(await page.evaluate(() => globalThis.overlayHarness.snapshot())).toMatchObject({ state: "mounted" });
  await page.evaluate(() => globalThis.overlayHarness.destroy());
  expect(await page.evaluate(() => globalThis.overlayHarness.resizeObserverOperations())).toContainEqual({
    type: "disconnect",
    target: "observer",
  });
});

test("destroy removes every owned surface and restores prototype interaction", async ({ page }) => {
  await loadOverlay(page);
  expect(await page.evaluate(() => globalThis.overlayHarness.shadowAttachmentObserverInstalled())).toBe(true);
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
  expect(await page.evaluate(() => globalThis.overlayHarness.shadowAttachmentObserverInstalled())).toBe(false);
});

test("destroy releases observed prototype targets", async ({ page }) => {
  await loadOverlay(page);
  await page.evaluate(() => {
    const target = document.createElement("button");
    target.type = "button";
    target.textContent = "Disposable observed target";
    target.dataset.collabReviewId = "disposable-observed-target";
    document.body.appendChild(target);
    (globalThis as typeof globalThis & { destroyTargetReference?: WeakRef<Element> }).destroyTargetReference = new WeakRef(target);
    globalThis.overlayHarness.setThreads([{
      threadId: "thread-disposable-observed-target",
      anchorGeneration: 1,
      anchor: {
        schemaVersion: 2,
        locationAvailability: "available",
        recoveryState: "not_required",
        context: globalThis.overlayHarness.context,
        element: {
          selector: "[data-collab-review-id=\"disposable-observed-target\"]",
          identity: "disposable-observed-target",
          offset: { x: 10, y: 10 },
        },
        document: { x: 10, y: 10, width: 1280, height: 720 },
      },
    }]);
    globalThis.overlayHarness.destroy();
    target.remove();
  });

  const cdp = await page.context().newCDPSession(page);
  try {
    await expect.poll(async () => {
      await cdp.send("HeapProfiler.collectGarbage");
      return page.evaluate(() => {
        return (globalThis as typeof globalThis & { destroyTargetReference?: WeakRef<Element> })
          .destroyTargetReference?.deref() === undefined;
      });
    }).toBe(true);
  } finally {
    await cdp.detach();
  }
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
  expect(await page.evaluate(() => globalThis.overlayHarness.prototypeClicks())).toBe(0);
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
  const movingBoxes = await page.evaluate(() => {
    const target = document.querySelector("[data-collab-review-id='synthetic-action']");
    const currentPin = document.querySelector(".crl-overlay__pin");
    if (!(target instanceof Element) || !(currentPin instanceof HTMLElement)) throw new Error("missing moving Anchor fixture");
    const targetBox = target.getBoundingClientRect();
    const pinBox = currentPin.getBoundingClientRect();
    return {
      target: { x: targetBox.x, width: targetBox.width },
      pin: { x: pinBox.x, width: pinBox.width },
    };
  });
  expect(movingBoxes.target.x).toBeGreaterThan(45);
  expect(movingBoxes.target.x).toBeLessThan(160);
  expect(movingBoxes.pin.x + (movingBoxes.pin.width / 2) - movingBoxes.target.x).toBeCloseTo(20, 0);
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

test("a pin tracks sibling layout motion that began before the overlay mounted", async ({ page }) => {
  await loadOverlay(page, "?preexistingLayoutMotion=true");
  await page.evaluate(() => globalThis.overlayHarness.setThreads([{
    threadId: "thread-preexisting-layout-motion",
    anchorGeneration: 1,
    label: "Preexisting layout motion thread",
    anchor: {
      schemaVersion: 2,
      locationAvailability: "available",
      recoveryState: "not_required",
      context: globalThis.overlayHarness.context,
      element: {
        selector: "[data-collab-review-id=\"synthetic-layout-target\"]",
        identity: "synthetic-layout-target",
        offset: { x: 20, y: 15 },
      },
      document: { x: 80, y: 635, width: 1280, height: 720 },
    },
  }]));
  const samples = await measureRunningLayoutDrift(
    page,
    "[data-collab-review-id=\"synthetic-layout-target\"]",
    "Open Preexisting layout motion thread",
    { x: 20, y: 15 },
  );
  const targetRange = Math.max(...samples.map((sample) => sample.targetLeft))
    - Math.min(...samples.map((sample) => sample.targetLeft));
  expect(samples).toHaveLength(30);
  expect(targetRange).toBeGreaterThan(2);
  expect(driftMetrics(samples).maximumDrift).toBeLessThanOrEqual(1);
  expect(driftMetrics(samples).maximumJump).toBeLessThanOrEqual(1);
});

test("a delayed intrinsic sibling resize refreshes placement without a DOM mutation", async ({ page }) => {
  await loadOverlay(page, "?delayedLayoutShift=true");
  await page.evaluate(() => globalThis.overlayHarness.setThreads([{
    threadId: "thread-delayed-layout-shift",
    anchorGeneration: 1,
    label: "Delayed layout shift thread",
    anchor: {
      schemaVersion: 2,
      locationAvailability: "available",
      recoveryState: "not_required",
      context: globalThis.overlayHarness.context,
      element: {
        selector: "[data-collab-review-id=\"synthetic-layout-target\"]",
        identity: "synthetic-layout-target",
        offset: { x: 20, y: 15 },
      },
      document: { x: 80, y: 635, width: 1280, height: 720 },
    },
  }]));
  const target = page.getByRole("button", { name: "Layout motion target" });
  const pin = page.getByRole("button", { name: "Open Delayed layout shift thread", includeHidden: true });
  const initialTarget = await target.boundingBox();
  expect(initialTarget).not.toBeNull();
  const release = await page.request.get(`${HOST_ORIGIN}/release-layout`);
  expect(release.ok()).toBe(true);
  await expect.poll(async () => (await target.boundingBox())?.x ?? 0).toBeGreaterThan(initialTarget!.x + 100);
  await expect.poll(async () => {
    const targetBox = await target.boundingBox();
    const pinBox = await pin.boundingBox();
    return Math.round((pinBox?.x ?? 0) + ((pinBox?.width ?? 0) / 2) - (targetBox?.x ?? 0));
  }).toBe(20);
});

test("an open draft follows an intrinsic resize of its own target", async ({ page }) => {
  await loadOverlay(page, "?disableLayoutShiftObserver=true");
  const initial = await page.evaluate(() => {
    const target = document.createElement("button");
    target.type = "button";
    target.dataset.collabReviewId = "intrinsic-draft-target";
    target.setAttribute("aria-label", "Intrinsic draft target");
    target.style.cssText = "position:absolute;left:500px;top:180px;padding:0;border:0;transform:rotate(15deg)";
    const image = document.createElement("img");
    image.alt = "";
    image.src = "/controlled-layout";
    image.style.cssText = "display:block;min-width:40px;min-height:30px";
    const reference = document.createElement("span");
    reference.id = "intrinsic-draft-reference";
    reference.style.cssText = "position:absolute;left:10px;top:10px;width:1px;height:1px";
    target.append(image, reference);
    document.body.appendChild(target);
    globalThis.overlayHarness.setMode("comment");
    const box = reference.getBoundingClientRect();
    return { x: box.left + (box.width / 2), y: box.top + (box.height / 2), width: target.getBoundingClientRect().width };
  });
  await page.mouse.click(initial.x, initial.y);
  const composer = page.getByRole("dialog", { name: "Add review comment" });
  await expect(composer).toBeVisible();
  const baseline = await page.evaluate(() => {
    const reference = document.querySelector("#intrinsic-draft-reference");
    const composer = document.querySelector(".crl-overlay__composer");
    if (!(reference instanceof HTMLElement) || !(composer instanceof HTMLElement)) throw new Error("missing draft resize fixture");
    const referenceBox = reference.getBoundingClientRect();
    const composerBox = composer.getBoundingClientRect();
    return {
      x: composerBox.left - (referenceBox.left + (referenceBox.width / 2)),
      y: composerBox.top - (referenceBox.top + (referenceBox.height / 2)),
    };
  });

  const release = await page.request.get(`${HOST_ORIGIN}/release-layout`);
  expect(release.ok()).toBe(true);
  await expect.poll(() => page.locator('[data-collab-review-id="intrinsic-draft-target"]').evaluate((element) => {
    return element.getBoundingClientRect().width;
  })).toBeGreaterThan(initial.width + 80);
  await expect.poll(() => page.evaluate((expected) => {
    const reference = document.querySelector("#intrinsic-draft-reference");
    const composer = document.querySelector(".crl-overlay__composer");
    if (!(reference instanceof HTMLElement) || !(composer instanceof HTMLElement)) return Number.POSITIVE_INFINITY;
    const referenceBox = reference.getBoundingClientRect();
    const composerBox = composer.getBoundingClientRect();
    return Math.hypot(
      composerBox.left - (referenceBox.left + (referenceBox.width / 2)) - expected.x,
      composerBox.top - (referenceBox.top + (referenceBox.height / 2)) - expected.y,
    );
  }, baseline)).toBeLessThanOrEqual(1);
});

test("unavailable reports are one-shot per Thread generation and retry after callback failure", async ({ page }) => {
  await loadOverlay(page, "?preexistingLayoutMotion=true");
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
  expect(await page.evaluate(() => globalThis.overlayHarness.unavailableCallbackAttempts())).toBe(1);

  await page.evaluate(() => globalThis.overlayHarness.setThreads([]));
  await page.evaluate(() => globalThis.overlayHarness.failNextUnavailable());
  expect(await page.evaluate((value) => {
    globalThis.overlayHarness.setThreads([value]);
    return "accepted";
  }, thread)).toBe("accepted");
  await page.waitForTimeout(1_200);
  expect(await page.evaluate(() => globalThis.overlayHarness.unavailableAnchors)).toEqual([{
    threadId: "thread-unavailable",
    anchorGeneration: 3,
  }]);
  expect(await page.evaluate(() => globalThis.overlayHarness.unavailableCallbackAttempts())).toBe(2);
  await page.evaluate(() => globalThis.overlayHarness.refresh());
  await expect.poll(() => page.evaluate(() => globalThis.overlayHarness.unavailableAnchors)).toEqual([{
    threadId: "thread-unavailable",
    anchorGeneration: 3,
  }, {
    threadId: "thread-unavailable",
    anchorGeneration: 3,
  }]);
  expect(await page.evaluate(() => globalThis.overlayHarness.unavailableCallbackAttempts())).toBe(3);

  await page.evaluate(() => globalThis.overlayHarness.setThreads([]));
  await page.evaluate(() => globalThis.overlayHarness.rejectNextUnavailableAsynchronously());
  await page.evaluate((value) => globalThis.overlayHarness.setThreads([value]), thread);
  await page.waitForTimeout(1_200);
  await page.evaluate(() => globalThis.overlayHarness.settleAsyncEvents());
  expect(await page.evaluate(() => globalThis.overlayHarness.unhandledSubmissionRejections())).toBe(0);
  expect(await page.evaluate(() => globalThis.overlayHarness.unavailableAnchors)).toHaveLength(2);
  expect(await page.evaluate(() => globalThis.overlayHarness.unavailableCallbackAttempts())).toBe(4);
  await page.evaluate(() => globalThis.overlayHarness.refresh());
  await expect.poll(() => page.evaluate(() => globalThis.overlayHarness.unavailableAnchors)).toHaveLength(3);
  expect(await page.evaluate(() => globalThis.overlayHarness.unavailableCallbackAttempts())).toBe(5);
});

test("a Promise-returning unavailable diagnostic retries only on explicit refresh", async ({ page }) => {
  await loadOverlay(page);
  await page.evaluate(() => {
    globalThis.overlayHarness.removeTarget();
    globalThis.overlayHarness.rejectNextPlacementDiagnosticAsynchronously();
    globalThis.overlayHarness.setThreads([{
      threadId: "thread-unavailable-diagnostic-retry",
      anchorGeneration: 1,
      anchor: {
        schemaVersion: 3,
        locationAvailability: "available",
        recoveryState: "not_required",
        context: globalThis.overlayHarness.context,
        element: {
          selector: '[data-collab-review-id="synthetic-action"]',
          identity: "synthetic-action",
          offset: { x: 20, y: 15 },
        },
        document: { x: 60, y: 55, width: 1280, height: 720 },
      },
    }]);
    globalThis.overlayHarness.moveLayoutSibling();
  });
  await page.waitForTimeout(600);
  await page.evaluate(() => globalThis.overlayHarness.settleAsyncEvents());
  expect(await page.evaluate(() => globalThis.overlayHarness.unhandledSubmissionRejections())).toBe(0);
  expect(await page.evaluate(() => globalThis.overlayHarness.placementDiagnostics)).toEqual([]);
  expect(await page.evaluate(() => globalThis.overlayHarness.placementDiagnosticAttempts())).toBe(1);
  expect(await page.evaluate(() => globalThis.overlayHarness.unavailableAnchors)).toHaveLength(1);

  await page.evaluate(() => globalThis.overlayHarness.refresh());
  await expect.poll(() => page.evaluate(() => globalThis.overlayHarness.placementDiagnostics)).toEqual([{
    kind: "anchor_unavailable",
    reason: "identity_unresolved",
    threadId: "thread-unavailable-diagnostic-retry",
    anchorGeneration: 1,
  }]);
  expect(await page.evaluate(() => globalThis.overlayHarness.placementDiagnosticAttempts())).toBe(2);
  expect(await page.evaluate(() => globalThis.overlayHarness.unavailableAnchors)).toHaveLength(1);
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
  await recovery.evaluate((button) => (button as HTMLButtonElement).click());
  expect(await page.evaluate(() => globalThis.overlayHarness.openedThreads)).toEqual([]);
  await page.evaluate(() => globalThis.overlayHarness.rejectNextOpenThreadAsynchronously());
  await recovery.click();
  await page.evaluate(() => globalThis.overlayHarness.settleAsyncEvents());
  expect(await page.evaluate(() => globalThis.overlayHarness.unhandledSubmissionRejections())).toBe(0);
  expect(await page.evaluate(() => globalThis.overlayHarness.openedThreads)).toEqual([]);
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
      schemaVersion: 3,
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

test("a Promise-returning relocation callback is consumed and leaves the same relocation retryable", async ({ page }) => {
  await loadOverlay(page);
  await page.evaluate(() => {
    globalThis.overlayHarness.setThreads([{
      threadId: "thread-async-relocation",
      anchorGeneration: 2,
      label: "Async relocation thread",
      canReplaceAnchor: true,
      anchor: {
        schemaVersion: 1,
        locationAvailability: "unavailable",
        recoveryState: "legacy_replacement_required",
      },
    }]);
    globalThis.overlayHarness.setMode("comment");
    globalThis.overlayHarness.beginAnchorReplacement("thread-async-relocation");
    globalThis.overlayHarness.rejectNextReplacementAsynchronously();
  });

  const target = page.getByRole("button", { name: "Synthetic prototype action" });
  await target.click({ position: { x: 35, y: 25 } });
  await page.evaluate(() => globalThis.overlayHarness.settleAsyncEvents());
  expect(await page.evaluate(() => globalThis.overlayHarness.unhandledSubmissionRejections())).toBe(0);
  expect(await page.evaluate(() => globalThis.overlayHarness.replacementRequests)).toEqual([]);

  await target.click({ position: { x: 35, y: 25 } });
  expect(await page.evaluate(() => globalThis.overlayHarness.replacementRequests)).toEqual([expect.objectContaining({
    threadId: "thread-async-relocation",
    anchorGeneration: 2,
  })]);
});

test("an unchanged unavailable Thread retains keyboard focus across reconciliation", async ({ page }) => {
  await loadOverlay(page);
  const thread = {
    threadId: "thread-focused-recovery",
    anchorGeneration: 2,
    label: "Focused recovery thread",
    canReplaceAnchor: true,
    anchor: {
      schemaVersion: 1,
      locationAvailability: "unavailable",
      recoveryState: "legacy_replacement_required",
    },
  };
  await page.evaluate((value) => {
    globalThis.overlayHarness.setThreads([value]);
    globalThis.overlayHarness.setMode("comment");
  }, thread);
  const recovery = page.getByRole("button", { name: "Open Focused recovery thread" });
  await recovery.focus();
  await expect(recovery).toBeFocused();

  await page.evaluate((value) => globalThis.overlayHarness.setThreads([value]), thread);

  await expect(recovery).toBeFocused();
});

test("an armed Anchor relocation survives an unchanged Thread generation update", async ({ page }) => {
  await loadOverlay(page);
  const thread = {
    threadId: "thread-relocation-update",
    anchorGeneration: 7,
    label: "Relocation update thread",
    canReplaceAnchor: true,
    anchor: {
      schemaVersion: 1,
      locationAvailability: "unavailable",
      recoveryState: "legacy_replacement_required",
    },
  };
  await page.evaluate((value) => {
    globalThis.overlayHarness.setThreads([value]);
    globalThis.overlayHarness.setMode("comment");
    globalThis.overlayHarness.beginAnchorReplacement(value.threadId);
    globalThis.overlayHarness.setThreads([{ ...value, label: "Relocation update thread with reply" }]);
  }, thread);

  await page.getByRole("button", { name: "Synthetic prototype action" }).click({ position: { x: 35, y: 25 } });

  await expect(page.getByRole("dialog", { name: "Add review comment" })).toHaveCount(0);
  expect(await page.evaluate(() => globalThis.overlayHarness.submissions)).toEqual([]);
  expect(await page.evaluate(() => globalThis.overlayHarness.replacementRequests)).toEqual([{
    threadId: "thread-relocation-update",
    anchorGeneration: 7,
    anchor: expect.objectContaining({
      schemaVersion: 3,
      locationAvailability: "available",
      recoveryState: "not_required",
    }),
  }]);
});

test("script-generated Escape cannot cancel an armed Anchor relocation", async ({ page }) => {
  await loadOverlay(page);
  await page.evaluate(() => {
    globalThis.overlayHarness.setThreads([{
      threadId: "thread-scripted-relocation",
      anchorGeneration: 3,
      canReplaceAnchor: true,
      anchor: {
        schemaVersion: 1,
        locationAvailability: "unavailable",
        recoveryState: "legacy_replacement_required",
      },
    }]);
    globalThis.overlayHarness.setMode("comment");
    globalThis.overlayHarness.beginAnchorReplacement("thread-scripted-relocation");
  });

  expect(await page.locator("#prototype-action").evaluate((element) => {
    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true, composed: true });
    return element.dispatchEvent(event);
  })).toBe(true);
  await page.getByRole("button", { name: "Synthetic prototype action" }).click({ position: { x: 35, y: 25 } });
  expect(await page.evaluate(() => globalThis.overlayHarness.replacementRequests)).toMatchObject([{
    threadId: "thread-scripted-relocation",
    anchorGeneration: 3,
  }]);
  await expect(page.getByRole("dialog", { name: "Add review comment" })).toHaveCount(0);
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
  await page.evaluate(() => {
    globalThis.overlayHarness.setThreads([{
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
    }]);
    globalThis.overlayHarness.refresh();
  });
  expect(await page.evaluate(() => globalThis.overlayHarness.placementDiagnostics)).toHaveLength(1);
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

test("a Promise-returning placement diagnostic retries only on explicit refresh", async ({ page }) => {
  await loadOverlay(page);
  await page.evaluate(() => {
    globalThis.overlayHarness.rejectNextPlacementDiagnosticAsynchronously();
    const target = document.querySelector("#prototype-action");
    if (!(target instanceof HTMLElement)) throw new Error("missing diagnostic retry target");
    target.style.transformOrigin = "0 0";
    target.style.transform = "perspective(500px) rotateX(20deg)";
    globalThis.overlayHarness.setThreads([{
      threadId: "thread-placement-diagnostic-retry",
      anchorGeneration: 1,
      anchor: {
        schemaVersion: 3,
        locationAvailability: "available",
        recoveryState: "not_required",
        context: globalThis.overlayHarness.context,
        element: {
          selector: '[data-collab-review-id="synthetic-action"]',
          identity: "synthetic-action",
          offset: { x: 20, y: 15 },
        },
        document: { x: 60, y: 55, width: 1280, height: 720 },
      },
    }]);
    globalThis.overlayHarness.moveLayoutSibling();
  });
  await page.evaluate(() => globalThis.overlayHarness.settleAsyncEvents());
  expect(await page.evaluate(() => globalThis.overlayHarness.unhandledSubmissionRejections())).toBe(0);
  expect(await page.evaluate(() => globalThis.overlayHarness.placementDiagnostics)).toEqual([]);
  expect(await page.evaluate(() => globalThis.overlayHarness.placementDiagnosticAttempts())).toBe(1);
  await page.evaluate(() => globalThis.overlayHarness.refresh());
  await expect.poll(() => page.evaluate(() => globalThis.overlayHarness.placementDiagnostics)).toEqual([{
    kind: "placement_bug",
    reason: "unsupported_coordinate_projection",
    threadId: "thread-placement-diagnostic-retry",
    anchorGeneration: 1,
  }]);
  expect(await page.evaluate(() => globalThis.overlayHarness.placementDiagnosticAttempts())).toBe(2);
});

test("singular target transforms fail closed instead of placing at a collapsed origin", async ({ page }) => {
  await loadOverlay(page);
  await page.evaluate(() => {
    const target = document.querySelector("#prototype-action");
    if (!(target instanceof HTMLElement)) throw new Error("missing singular-transform target");
    target.style.transformOrigin = "0 0";
    target.style.transform = "scale(0)";
    globalThis.overlayHarness.setThreads([{
      threadId: "thread-singular-transform",
      anchorGeneration: 1,
      label: "Singular transform thread",
      anchor: {
        schemaVersion: 3,
        locationAvailability: "available",
        recoveryState: "not_required",
        context: globalThis.overlayHarness.context,
        element: {
          selector: '[data-collab-review-id="synthetic-action"]',
          identity: "synthetic-action",
          offset: { x: 20, y: 15 },
        },
        document: { x: 60, y: 55, width: 1280, height: 720 },
      },
    }]);
  });

  await expect(page.getByRole("button", { name: "Open Singular transform thread" })).toHaveCount(0);
  expect(await page.evaluate(() => globalThis.overlayHarness.placementDiagnostics)).toEqual([{
    kind: "placement_bug",
    reason: "unsupported_coordinate_projection",
    threadId: "thread-singular-transform",
    anchorGeneration: 1,
  }]);
});

test("a resolved visibility-hidden marker recovers after an explicit CSSOM refresh", async ({ page }) => {
  await loadOverlay(page);
  const documentSize = await page.evaluate(() => {
    const target = document.querySelector("#prototype-action");
    const sheet = [...document.styleSheets].find((candidate) => candidate.href?.endsWith("/overlay-fixture.css"));
    if (!(target instanceof HTMLElement) || !sheet) throw new Error("missing CSSOM visibility fixture");
    target.dataset.cssomVisibilityFixture = "true";
    sheet.insertRule('#prototype-action[data-cssom-visibility-fixture="true"] {}', sheet.cssRules.length);
    globalThis.overlayHarness.setThreads([{
      threadId: "thread-cssom-visibility",
      anchorGeneration: 1,
      label: "CSSOM visibility thread",
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
    }]);
    return { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight };
  });
  const pin = page.getByRole("button", { name: "Open CSSOM visibility thread", includeHidden: true });
  await expect(pin).toBeVisible();

  await page.evaluate(() => {
    const sheet = [...document.styleSheets].find((candidate) => candidate.href?.endsWith("/overlay-fixture.css"));
    const rule = sheet && [...sheet.cssRules].find((candidate) => {
      return candidate instanceof CSSStyleRule
        && candidate.selectorText === '#prototype-action[data-cssom-visibility-fixture="true"]';
    });
    if (!(rule instanceof CSSStyleRule)) throw new Error("missing CSSOM visibility rule");
    rule.style.visibility = "hidden";
    globalThis.overlayHarness.refresh();
  });
  await expect(pin).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => globalThis.overlayHarness.unavailableAnchors)).toEqual([{
    threadId: "thread-cssom-visibility",
    anchorGeneration: 1,
  }]);
  expect(await page.evaluate(() => ({
    width: document.documentElement.scrollWidth,
    height: document.documentElement.scrollHeight,
  }))).toEqual(documentSize);

  await page.evaluate(() => {
    const sheet = [...document.styleSheets].find((candidate) => candidate.href?.endsWith("/overlay-fixture.css"));
    const rule = sheet && [...sheet.cssRules].find((candidate) => {
      return candidate instanceof CSSStyleRule
        && candidate.selectorText === '#prototype-action[data-cssom-visibility-fixture="true"]';
    });
    if (!(rule instanceof CSSStyleRule)) throw new Error("missing CSSOM visibility rule");
    rule.style.removeProperty("visibility");
    globalThis.overlayHarness.refresh();
  });
  await expect(pin).toBeVisible();
});

for (const scope of ["target", "ancestor"] as const) {
  for (const effect of ["opacity", "clip-path", "mask", "legacy-clip"] as const) {
    const article = scope === "ancestor" ? "an" : "a";
    test(`${article} ${scope}-level ${effect} paint effect hides and recovers an existing pin`, async ({ page }) => {
      await loadOverlay(page);
      await page.evaluate(() => {
        const target = document.querySelector("#prototype-action");
        if (!(target instanceof HTMLElement)) throw new Error("missing paint-visibility target");
        const ancestor = document.createElement("div");
        ancestor.id = "paint-visibility-ancestor";
        target.before(ancestor);
        ancestor.append(target);
        globalThis.overlayHarness.setThreads([{
          threadId: "thread-paint-visibility",
          anchorGeneration: 1,
          label: "Paint visibility thread",
          anchor: {
            schemaVersion: 2,
            locationAvailability: "available",
            recoveryState: "not_required",
            context: globalThis.overlayHarness.context,
            element: {
              selector: '[data-collab-review-id="synthetic-action"]',
              identity: "synthetic-action",
              offset: { x: 20, y: 15 },
            },
            document: { x: 60, y: 55, width: 1280, height: 720 },
          },
        }]);
      });
      const pin = page.getByRole("button", { name: "Open Paint visibility thread", includeHidden: true });
      await expect(pin).toBeVisible();

      await page.evaluate(({ scope, effect }) => {
        const affected = scope === "target"
          ? document.querySelector("#prototype-action")
          : document.querySelector("#paint-visibility-ancestor");
        if (!(affected instanceof HTMLElement)) throw new Error("missing paint-visibility fixture");
        if (effect === "opacity") affected.style.opacity = "0";
        else if (effect === "clip-path") affected.style.clipPath = "inset(100%)";
        else if (effect === "mask") affected.style.maskImage = "linear-gradient(transparent, transparent)";
        else {
          affected.style.position = "absolute";
          affected.style.clip = "rect(0px, 0px, 0px, 0px)";
        }
        globalThis.overlayHarness.refresh();
      }, { scope, effect });
      await expect(pin).toHaveCount(0);
      if (effect === "opacity") {
        await expect.poll(() => page.evaluate(() => globalThis.overlayHarness.unavailableAnchors)).toEqual([{
          threadId: "thread-paint-visibility",
          anchorGeneration: 1,
        }]);
      } else {
        expect(await page.evaluate(() => globalThis.overlayHarness.unavailableAnchors)).toEqual([]);
        expect(await page.evaluate(() => globalThis.overlayHarness.placementDiagnostics)).toEqual([{
          kind: "placement_bug",
          reason: "unsupported_coordinate_projection",
          threadId: "thread-paint-visibility",
          anchorGeneration: 1,
        }]);
      }

      await page.evaluate(({ scope, effect }) => {
        const affected = scope === "target"
          ? document.querySelector("#prototype-action")
          : document.querySelector("#paint-visibility-ancestor");
        if (!(affected instanceof HTMLElement)) throw new Error("missing paint-visibility fixture");
        if (effect === "opacity") affected.style.removeProperty("opacity");
        else if (effect === "clip-path") affected.style.removeProperty("clip-path");
        else if (effect === "mask") affected.style.removeProperty("mask-image");
        else {
          affected.style.removeProperty("clip");
          affected.style.removeProperty("position");
        }
        globalThis.overlayHarness.refresh();
      }, { scope, effect });
      await expect(pin).toBeVisible();
    });

    test(`an open composer closes for ${article} ${scope}-level ${effect} paint effect`, async ({ page }) => {
      await loadOverlay(page);
      await page.evaluate(() => {
        const target = document.querySelector("#prototype-action");
        if (!(target instanceof HTMLElement)) throw new Error("missing paint-visibility target");
        const ancestor = document.createElement("div");
        ancestor.id = "paint-visibility-ancestor";
        target.before(ancestor);
        ancestor.append(target);
        globalThis.overlayHarness.setMode("comment");
      });
      await page.getByRole("button", { name: "Synthetic prototype action" }).click({ position: { x: 20, y: 15 } });
      const composer = page.getByRole("dialog", { name: "Add review comment" });
      await expect(composer).toBeVisible();
      await composer.getByRole("textbox", { name: "Comment" }).fill("Must not survive hidden paint");

      await page.evaluate(({ scope, effect }) => {
        const affected = scope === "target"
          ? document.querySelector("#prototype-action")
          : document.querySelector("#paint-visibility-ancestor");
        if (!(affected instanceof HTMLElement)) throw new Error("missing paint-visibility fixture");
        if (effect === "opacity") affected.style.opacity = "0";
        else if (effect === "clip-path") affected.style.clipPath = "inset(100%)";
        else if (effect === "mask") affected.style.maskImage = "linear-gradient(transparent, transparent)";
        else {
          affected.style.position = "absolute";
          affected.style.clip = "rect(0px, 0px, 0px, 0px)";
        }
        globalThis.overlayHarness.refresh();
      }, { scope, effect });

      await expect(composer).toHaveCount(0);
      expect(await page.evaluate(() => globalThis.overlayHarness.submissions)).toEqual([]);
    });
  }
}

test("partial target and ancestor opacity remains anchorable", async ({ page }) => {
  await loadOverlay(page);
  await page.evaluate(() => {
    const target = document.querySelector("#prototype-action");
    if (!(target instanceof HTMLElement)) throw new Error("missing partial-opacity target");
    const ancestor = document.createElement("div");
    target.before(ancestor);
    ancestor.append(target);
    ancestor.style.opacity = "0.5";
    target.style.opacity = "0.5";
    globalThis.overlayHarness.setThreads([{
      threadId: "thread-partial-opacity",
      anchorGeneration: 1,
      label: "Partial opacity thread",
      anchor: {
        schemaVersion: 2,
        locationAvailability: "available",
        recoveryState: "not_required",
        context: globalThis.overlayHarness.context,
        element: {
          selector: '[data-collab-review-id="synthetic-action"]',
          identity: "synthetic-action",
          offset: { x: 20, y: 15 },
        },
        document: { x: 60, y: 55, width: 1280, height: 720 },
      },
    }]);
  });

  await expect(page.getByRole("button", { name: "Open Partial opacity thread", includeHidden: true })).toBeVisible();
  await page.evaluate(() => globalThis.overlayHarness.setMode("comment"));
  await page.getByRole("button", { name: "Synthetic prototype action" }).click({ position: { x: 100, y: 50 } });
  await expect(page.getByRole("dialog", { name: "Add review comment" })).toBeVisible();
});

test("an inert legacy clip on a statically positioned target remains anchorable", async ({ page }) => {
  await loadOverlay(page);
  await page.evaluate(() => {
    const target = document.querySelector("#prototype-action");
    if (!(target instanceof HTMLElement)) throw new Error("missing inert-clip target");
    target.style.clip = "rect(0px, 0px, 0px, 0px)";
    globalThis.overlayHarness.setThreads([{
      threadId: "thread-inert-legacy-clip",
      anchorGeneration: 1,
      label: "Inert legacy clip thread",
      anchor: {
        schemaVersion: 3,
        locationAvailability: "available",
        recoveryState: "not_required",
        context: globalThis.overlayHarness.context,
        element: {
          selector: '[data-collab-review-id="synthetic-action"]',
          identity: "synthetic-action",
          offset: { x: 20, y: 15 },
        },
        document: { x: 60, y: 55, width: 1280, height: 720 },
      },
    }]);
  });

  await expect(page.getByRole("button", { name: "Open Inert legacy clip thread", includeHidden: true })).toBeVisible();
});

for (const effect of ["clip-path", "mask"] as const) {
  test(`a visible ${effect} is a placement limitation, not an unavailable Anchor`, async ({ page }) => {
    await loadOverlay(page);
    await page.evaluate((effect) => {
      const target = document.querySelector("#prototype-action");
      if (!(target instanceof HTMLElement)) throw new Error("missing visible paint-effect target");
      if (effect === "clip-path") target.style.clipPath = "inset(0px)";
      else target.style.maskImage = "linear-gradient(black, black)";
      globalThis.overlayHarness.setThreads([{
        threadId: "thread-visible-paint-effect",
        anchorGeneration: 1,
        label: "Visible paint effect thread",
        canReplaceAnchor: true,
        anchor: {
          schemaVersion: 2,
          locationAvailability: "available",
          recoveryState: "not_required",
          context: globalThis.overlayHarness.context,
          element: {
            selector: '[data-collab-review-id="synthetic-action"]',
            identity: "synthetic-action",
            offset: { x: 20, y: 15 },
          },
          document: { x: 60, y: 55, width: 1280, height: 720 },
        },
      }]);
    }, effect);

    await page.waitForTimeout(600);
    expect(await page.evaluate(() => globalThis.overlayHarness.unavailableAnchors)).toEqual([]);
    expect(await page.evaluate(() => globalThis.overlayHarness.placementDiagnostics)).toEqual([{
      kind: "placement_bug",
      reason: "unsupported_coordinate_projection",
      threadId: "thread-visible-paint-effect",
      anchorGeneration: 1,
    }]);
    await page.evaluate(() => globalThis.overlayHarness.setMode("comment"));
    await expect(page.getByRole("button", { name: "Open Visible paint effect thread" })).toHaveCount(0);
  });
}

test("a zero-opacity filter removes an existing pin", async ({ page }) => {
  await loadOverlay(page);
  await page.evaluate(() => {
    globalThis.overlayHarness.setThreads([{
      threadId: "thread-filter-opacity",
      anchorGeneration: 1,
      label: "Filter opacity thread",
      anchor: {
        schemaVersion: 2,
        locationAvailability: "available",
        recoveryState: "not_required",
        context: globalThis.overlayHarness.context,
        element: {
          selector: '[data-collab-review-id="synthetic-action"]',
          identity: "synthetic-action",
          offset: { x: 20, y: 15 },
        },
        document: { x: 60, y: 55, width: 1280, height: 720 },
      },
    }]);
    const target = document.querySelector("#prototype-action");
    if (!(target instanceof HTMLElement)) throw new Error("missing filter target");
    target.style.filter = "blur(0px) opacity(0)";
    globalThis.overlayHarness.refresh();
  });

  await expect(page.getByRole("button", { name: "Open Filter opacity thread", includeHidden: true })).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => globalThis.overlayHarness.unavailableAnchors)).toHaveLength(1);
});

test("a one-time refresh tracks opacity-only WAAPI motion through its filled endpoint", async ({ page }) => {
  await loadOverlay(page);
  await page.evaluate(() => {
    globalThis.overlayHarness.setThreads([{
      threadId: "thread-waapi-opacity",
      anchorGeneration: 1,
      label: "WAAPI opacity thread",
      anchor: {
        schemaVersion: 2,
        locationAvailability: "available",
        recoveryState: "not_required",
        context: globalThis.overlayHarness.context,
        element: {
          selector: '[data-collab-review-id="synthetic-action"]',
          identity: "synthetic-action",
          offset: { x: 20, y: 15 },
        },
        document: { x: 60, y: 55, width: 1280, height: 720 },
      },
    }]);
    const target = document.querySelector("#prototype-action");
    if (!(target instanceof HTMLElement)) throw new Error("missing animated-opacity target");
    target.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 120, fill: "forwards" });
    globalThis.overlayHarness.refresh();
  });

  await expect(page.getByRole("button", { name: "Open WAAPI opacity thread", includeHidden: true })).toHaveCount(0);
});

test("paint containment clips pins and composers at its expanded overflow edge", async ({ page }) => {
  await loadOverlay(page);
  await page.evaluate(() => {
    const target = document.querySelector("#prototype-action");
    if (!(target instanceof HTMLElement)) throw new Error("missing paint-contained target");
    const ancestor = document.createElement("div");
    ancestor.id = "paint-containment-ancestor";
    ancestor.style.position = "relative";
    ancestor.style.width = "60px";
    ancestor.style.height = "80px";
    ancestor.style.contain = "paint";
    ancestor.style.overflow = "visible";
    ancestor.style.overflowClipMargin = "40px";
    target.before(ancestor);
    ancestor.append(target);
    target.style.position = "absolute";
    target.style.left = "70px";
    target.style.margin = "0";
    globalThis.overlayHarness.setMode("comment");
  });
  await page.locator("#prototype-action").click({ position: { x: 20, y: 15 } });
  const composer = page.getByRole("dialog", { name: "Add review comment" });
  await expect(composer).toBeVisible();
  await page.evaluate(() => globalThis.overlayHarness.setThreads([{
      threadId: "thread-paint-containment",
      anchorGeneration: 1,
      label: "Paint containment thread",
      anchor: {
        schemaVersion: 2,
        locationAvailability: "available",
        recoveryState: "not_required",
        context: globalThis.overlayHarness.context,
        element: {
          selector: '[data-collab-review-id="synthetic-action"]',
          identity: "synthetic-action",
          offset: { x: 20, y: 15 },
        },
        document: { x: 90, y: 15, width: 1280, height: 720 },
      },
    }]));
  const pin = page.getByRole("button", { name: "Open Paint containment thread", includeHidden: true });
  await expect(pin).toBeVisible();

  await page.evaluate(() => {
    const target = document.querySelector("#prototype-action");
    if (!(target instanceof HTMLElement)) throw new Error("missing paint-contained target");
    target.style.left = "90px";
    globalThis.overlayHarness.refresh();
  });
  await expect(pin).toBeHidden();
  await expect(composer).toBeHidden();
});

test("viewport-propagated body overflow does not clip a visible document Anchor", async ({ page }) => {
  await loadOverlay(page);
  await page.evaluate(() => {
    document.documentElement.style.overflow = "visible";
    document.body.style.overflow = "hidden";
    document.body.style.minWidth = "0";
    document.body.style.width = "20px";
    const target = document.querySelector("#prototype-action");
    if (!(target instanceof HTMLElement)) throw new Error("missing propagated-body target");
    target.style.margin = "40px";
    globalThis.overlayHarness.setThreads([{
      threadId: "thread-propagated-body",
      anchorGeneration: 1,
      label: "Propagated body thread",
      anchor: {
        schemaVersion: 2,
        locationAvailability: "available",
        recoveryState: "not_required",
        context: globalThis.overlayHarness.context,
        element: {
          selector: '[data-collab-review-id="synthetic-action"]',
          identity: "synthetic-action",
          offset: { x: 20, y: 15 },
        },
        document: { x: 60, y: 55, width: 1280, height: 720 },
      },
    }]);
  });

  await expect(page.getByRole("button", { name: "Open Propagated body thread", includeHidden: true })).toBeVisible();
});

test("a rounded overflow corner hides a document pin outside the painted curve", async ({ page }) => {
  await loadOverlay(page);
  await page.evaluate(() => {
    const target = document.querySelector("#prototype-action");
    if (!(target instanceof HTMLElement)) throw new Error("missing rounded-clip target");
    const ancestor = document.createElement("div");
    ancestor.style.position = "relative";
    ancestor.style.width = "100px";
    ancestor.style.height = "100px";
    ancestor.style.overflow = "hidden";
    ancestor.style.borderRadius = "50%";
    target.before(ancestor);
    ancestor.append(target);
    target.style.position = "absolute";
    target.style.inset = "0 auto auto 0";
    target.style.margin = "0";
    globalThis.overlayHarness.setThreads([{
      threadId: "thread-rounded-document-clip",
      anchorGeneration: 1,
      label: "Rounded document clip thread",
      anchor: {
        schemaVersion: 2,
        locationAvailability: "available",
        recoveryState: "not_required",
        context: globalThis.overlayHarness.context,
        element: {
          selector: '[data-collab-review-id="synthetic-action"]',
          identity: "synthetic-action",
          offset: { x: 2, y: 2 },
        },
        document: { x: 2, y: 2, width: 1280, height: 720 },
      },
    }]);
  });

  await expect(page.getByRole("button", { name: "Open Rounded document clip thread", includeHidden: true })).toBeHidden();
});

test("pointer-inert rounded overflow keeps an interior document anchor visible and a corner anchor clipped", async ({ page }) => {
  await loadOverlay(page);
  await page.evaluate(() => {
    const target = document.querySelector("#prototype-action");
    if (!(target instanceof HTMLElement)) throw new Error("missing pointer-inert rounded-clip target");
    const ancestor = document.createElement("div");
    ancestor.style.cssText = "position:relative;width:100px;height:100px;overflow:hidden;border-radius:50%;pointer-events:none";
    target.before(ancestor);
    ancestor.append(target);
    target.style.cssText = "position:absolute;inset:0 auto auto 0;width:100px;height:100px;margin:0";
    const anchor = (threadId: string, label: string, x: number, y: number) => ({
      threadId,
      anchorGeneration: 1,
      label,
      anchor: {
        schemaVersion: 2 as const,
        locationAvailability: "available" as const,
        recoveryState: "not_required" as const,
        context: globalThis.overlayHarness.context,
        element: {
          selector: '[data-collab-review-id="synthetic-action"]',
          identity: "synthetic-action",
          offset: { x, y },
        },
        document: { x, y, width: 1280, height: 720 },
      },
    });
    globalThis.overlayHarness.setThreads([
      anchor("thread-pointer-inert-center", "Pointer inert center", 50, 50),
      anchor("thread-pointer-inert-corner", "Pointer inert corner", 2, 2),
    ]);
  });

  await expect(page.getByRole("button", { name: "Open Pointer inert center", includeHidden: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open Pointer inert corner", includeHidden: true })).toBeHidden();
});

test("an expanded rounded clip keeps a pointer-inert interior anchor visible and its extreme corner clipped", async ({ page }) => {
  await loadOverlay(page);
  await page.evaluate(() => {
    const target = document.querySelector("#prototype-action");
    if (!(target instanceof HTMLElement)) throw new Error("missing expanded pointer-inert rounded-clip target");
    const ancestor = document.createElement("div");
    ancestor.style.cssText = "position:relative;width:100px;height:100px;overflow:clip;overflow-clip-margin:20px;border-radius:50%;pointer-events:none";
    target.before(ancestor);
    ancestor.append(target);
    target.style.cssText = "position:absolute;inset:0 auto auto 0;width:100px;height:100px;margin:0";
    const anchor = (threadId: string, label: string, x: number, y: number) => ({
      threadId,
      anchorGeneration: 1,
      label,
      anchor: {
        schemaVersion: 2 as const,
        locationAvailability: "available" as const,
        recoveryState: "not_required" as const,
        context: globalThis.overlayHarness.context,
        element: {
          selector: '[data-collab-review-id="synthetic-action"]',
          identity: "synthetic-action",
          offset: { x, y },
        },
        document: { x, y, width: 1280, height: 720 },
      },
    });
    globalThis.overlayHarness.setThreads([
      anchor("thread-expanded-pointer-inert-center", "Expanded pointer inert center", 50, 50),
      anchor("thread-expanded-pointer-inert-corner", "Expanded pointer inert corner", 0, 0),
    ]);
  });

  await expect(page.getByRole("button", { name: "Open Expanded pointer inert center", includeHidden: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open Expanded pointer inert corner", includeHidden: true })).toBeHidden();
});

test("an in-viewport stylesheet CSSOM move follows the explicit refresh contract", async ({ page }) => {
  await loadOverlay(page);
  await page.evaluate(() => {
    const target = document.querySelector("#prototype-action");
    const sheet = [...document.styleSheets].find((candidate) => candidate.href?.endsWith("/overlay-fixture.css"));
    if (!(target instanceof HTMLElement) || !sheet) throw new Error("missing in-viewport CSSOM movement fixture");
    target.dataset.cssomInViewportFixture = "true";
    sheet.insertRule('#prototype-action[data-cssom-in-viewport-fixture="true"] {}', sheet.cssRules.length);
    globalThis.overlayHarness.setThreads([{
      threadId: "thread-cssom-in-viewport",
      anchorGeneration: 1,
      label: "In-viewport CSSOM thread",
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
    }]);
  });
  const target = page.locator("#prototype-action");
  const pin = page.getByRole("button", { name: "Open In-viewport CSSOM thread", includeHidden: true });
  await expect(target).toBeInViewport();
  await expect(pin).toBeInViewport();

  const drift = async (): Promise<number> => {
    const targetBox = await target.boundingBox();
    const pinBox = await pin.boundingBox();
    if (!targetBox || !pinBox) return Number.POSITIVE_INFINITY;
    return Math.hypot(
      (pinBox.x + (pinBox.width / 2)) - (targetBox.x + 20),
      (pinBox.y + (pinBox.height / 2)) - (targetBox.y + 15),
    );
  };
  await page.evaluate(async () => {
    const sheet = [...document.styleSheets].find((candidate) => candidate.href?.endsWith("/overlay-fixture.css"));
    const rule = sheet && [...sheet.cssRules].find((candidate) => {
      return candidate instanceof CSSStyleRule
        && candidate.selectorText === '#prototype-action[data-cssom-in-viewport-fixture="true"]';
    });
    if (!(rule instanceof CSSStyleRule)) throw new Error("missing in-viewport CSSOM movement rule");
    rule.style.transform = "translate(30px, 20px)";
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
  expect(await drift()).toBeGreaterThan(20);

  await page.evaluate(() => globalThis.overlayHarness.refresh());
  await expect.poll(drift).toBeLessThan(1);
});

test("a CSSOM-only transform moving an observed target out of view refreshes its pin", async ({ page }) => {
  await loadOverlay(page);
  await page.evaluate(() => {
    const target = document.querySelector("#prototype-action");
    const sheet = [...document.styleSheets].find((candidate) => candidate.href?.endsWith("/overlay-fixture.css"));
    if (!(target instanceof HTMLElement) || !sheet) throw new Error("missing CSSOM movement fixture");
    target.dataset.cssomMovementFixture = "true";
    sheet.insertRule('#prototype-action[data-cssom-movement-fixture="true"] {}', sheet.cssRules.length);
    globalThis.overlayHarness.setThreads([{
      threadId: "thread-cssom-movement",
      anchorGeneration: 1,
      label: "CSSOM movement thread",
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
    }]);
  });
  const target = page.locator("#prototype-action");
  const pin = page.getByRole("button", { name: "Open CSSOM movement thread", includeHidden: true });
  await expect(target).toBeInViewport();
  await expect(pin).toBeInViewport();

  await page.evaluate(() => {
    const sheet = [...document.styleSheets].find((candidate) => candidate.href?.endsWith("/overlay-fixture.css"));
    const rule = sheet && [...sheet.cssRules].find((candidate) => {
      return candidate instanceof CSSStyleRule
        && candidate.selectorText === '#prototype-action[data-cssom-movement-fixture="true"]';
    });
    if (!(rule instanceof CSSStyleRule)) throw new Error("missing CSSOM movement rule");
    rule.style.transform = "translateY(1200px)";
  });

  await expect(target).not.toBeInViewport();
  await expect.poll(async () => {
    const targetBox = await target.boundingBox();
    const pinBox = await pin.boundingBox();
    if (!targetBox || !pinBox) return Number.POSITIVE_INFINITY;
    return Math.hypot(
      (pinBox.x + (pinBox.width / 2)) - (targetBox.x + 20),
      (pinBox.y + (pinBox.height / 2)) - (targetBox.y + 15),
    );
  }).toBeLessThan(1);
});

test("Comment mode captures nonnegative document evidence in a negatively scrolled RTL document", async ({ page }) => {
  await loadOverlay(page);
  const scroll = await page.evaluate(async () => {
    document.documentElement.dir = "rtl";
    document.body.style.minWidth = "2400px";
    const target = document.createElement("button");
    target.type = "button";
    target.textContent = "RTL fixed review target";
    target.dataset.collabReviewId = "rtl-fixed-review-target";
    target.style.position = "fixed";
    target.style.left = "20px";
    target.style.top = "100px";
    target.style.width = "160px";
    target.style.height = "60px";
    document.body.appendChild(target);
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    window.scrollTo({ left: -1000, top: 0 });
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    globalThis.overlayHarness.setMode("comment");
    return {
      x: window.scrollX,
      maximum: document.scrollingElement!.scrollWidth - document.scrollingElement!.clientWidth,
    };
  });
  expect(scroll.x).toBeLessThan(0);
  expect(scroll.maximum).toBeGreaterThan(0);

  await page.getByRole("button", { name: "RTL fixed review target" }).click({ position: { x: 20, y: 20 } });
  const composer = page.getByRole("dialog", { name: "Add review comment" });
  await expect(composer).toBeVisible();
  await composer.getByRole("textbox", { name: "Comment" }).fill("RTL anchor evidence");
  await composer.getByRole("button", { name: "Submit comment" }).click();

  const submissions = await page.evaluate(() => globalThis.overlayHarness.submissions);
  expect(submissions).toHaveLength(1);
  expect(submissions[0]!.anchor.document.x).toBeGreaterThanOrEqual(0);
  expect(submissions[0]!.anchor.document.x).toBeLessThanOrEqual(submissions[0]!.anchor.document.width);
});

for (const actionName of ["Cancel", "Submit comment"] as const) {
  test(`Escape dismisses a cooperative nested draft from the ${actionName} button`, async ({ page }) => {
    await page.goto(`${HOST_ORIGIN}/nested-overlay.html`);
    const frame = page.frames().find((candidate) => candidate.url().includes("/nested-prototype.html"));
    expect(frame).toBeDefined();
    await expect.poll(() => page.evaluate(() => globalThis.nestedHostHarness.snapshot().state)).toBe("active");
    await frame!.evaluate(() => globalThis.nestedOverlayHarness.setMode("comment"));
    await frame!.getByRole("button", { name: "Nested prototype action" }).click();
    const composer = page.getByRole("dialog", { name: "Add review comment" });
    await expect(composer).toBeVisible();
    const action = composer.getByRole("button", { name: actionName });
    await action.focus();

    await action.press("Escape");

    await expect(composer).toHaveCount(0);
    await expect.poll(() => frame!.evaluate(() => globalThis.nestedOverlayHarness.snapshot().composerOpen)).toBe(false);
  });
}

test("a cooperative draft is hosted above its active popover", async ({ page }) => {
  await page.goto(`${HOST_ORIGIN}/nested-overlay.html?popover=true`);
  const frame = page.frames().find((candidate) => candidate.url().includes("/nested-prototype.html"));
  expect(frame).toBeDefined();
  await expect.poll(() => page.evaluate(() => globalThis.nestedHostHarness.snapshot().state)).toBe("active");
  await frame!.evaluate(() => globalThis.nestedOverlayHarness.setMode("comment"));
  await frame!.getByRole("button", { name: "Nested prototype action" }).click();

  const composer = page.getByRole("dialog", { name: "Add review comment" });
  await expect(composer).toBeVisible();
  expect(await composer.evaluate((element) => element.parentElement?.id)).toBe("nested-frame-popover");
  const textarea = composer.getByRole("textbox", { name: "Comment" });
  const box = await textarea.boundingBox();
  expect(box).not.toBeNull();
  expect(await page.evaluate(({ x, y }) => {
    return Boolean(document.elementFromPoint(x, y)?.closest(".crl-frame-draft"));
  }, { x: box!.x + (box!.width / 2), y: box!.y + (box!.height / 2) })).toBe(true);
});

test("Escape dismisses a hidden cooperative draft through the shell focus sentinel", async ({ page }) => {
  await page.goto(`${HOST_ORIGIN}/nested-overlay.html`);
  const frame = page.frames().find((candidate) => candidate.url().includes("/nested-prototype.html"));
  expect(frame).toBeDefined();
  await expect.poll(() => page.evaluate(() => globalThis.nestedHostHarness.snapshot().state)).toBe("active");
  await frame!.evaluate(() => globalThis.nestedOverlayHarness.setMode("comment"));
  await frame!.getByRole("button", { name: "Nested prototype action" }).click();
  const composer = page.getByRole("dialog", { name: "Add review comment" });
  await composer.getByRole("textbox", { name: "Comment" }).fill("Hidden protected draft");
  await frame!.evaluate(() => globalThis.nestedOverlayHarness.reportDraftVisibility(false));
  await expect(composer).toBeHidden();
  await expect(page.locator(".crl-frame-draft-focus-sentinel")).toBeFocused();

  await page.keyboard.press("Escape");

  await expect(composer).toHaveCount(0);
  await expect.poll(() => frame!.evaluate(() => globalThis.nestedOverlayHarness.snapshot().composerOpen)).toBe(false);
});

for (const focusAction of ["close", "replace"] as const) {
  test(`a ${focusAction} during draft-open focus suppresses the stale child message`, async ({ page }) => {
    await page.goto(`${HOST_ORIGIN}/nested-overlay.html`);
    const frame = page.frames().find((candidate) => candidate.url().includes("/nested-prototype.html"));
    expect(frame).toBeDefined();
    await expect.poll(() => page.evaluate(() => globalThis.nestedHostHarness.snapshot().state)).toBe("active");
    await page.evaluate((action) => globalThis.nestedHostHarness.setDraftOpenFocusAction(action), focusAction);
    await frame!.evaluate(() => globalThis.nestedOverlayHarness.setMode("comment"));
    await frame!.getByRole("button", { name: "Nested prototype action" }).click();

    if (focusAction === "close") {
      await expect.poll(() => page.evaluate(() => globalThis.nestedHostHarness.snapshot().state)).toBe("closed");
    } else {
      await expect.poll(() => page.evaluate(() => globalThis.nestedHostHarness.snapshot())).toEqual(
        expect.objectContaining({ state: "active", sessionId: "draft-open-focus-replacement" }),
      );
    }
    expect(await page.evaluate(() => globalThis.nestedHostHarness.draftRequests)).toEqual([]);
    await expect(page.getByRole("dialog", { name: "Add review comment" })).toHaveCount(0);
  });
}

for (const peerFailure of ["duplicate", "reload"] as const) {
  test(`a ${peerFailure} peer failure preserves protected shell draft text`, async ({ page }) => {
    await page.goto(`${HOST_ORIGIN}/nested-overlay.html`);
    const frame = page.frames().find((candidate) => candidate.url().includes("/nested-prototype.html"));
    expect(frame).toBeDefined();
    await expect.poll(() => page.evaluate(() => globalThis.nestedHostHarness.snapshot().state)).toBe("active");
    await frame!.evaluate(() => globalThis.nestedOverlayHarness.setMode("comment"));
    await frame!.getByRole("button", { name: "Nested prototype action" }).click();
    const composer = page.getByRole("dialog", { name: "Add review comment" });
    const textarea = composer.getByRole("textbox", { name: "Comment" });
    await textarea.fill(`Protected through ${peerFailure}`);

    await page.evaluate((failure) => {
      if (failure === "duplicate") globalThis.nestedHostHarness.sendDuplicateDraftOpen();
      else globalThis.nestedHostHarness.reloadFrame();
    }, peerFailure);

    await expect.poll(() => page.evaluate(() => globalThis.nestedHostHarness.snapshot().state)).toBe("idle");
    await expect(composer).toBeVisible();
    await expect(textarea).toHaveValue(`Protected through ${peerFailure}`);
    await expect(composer.getByText("Comment location unavailable. Your draft is preserved.")).toBeVisible();
    await expect(composer.getByRole("button", { name: "Submit comment" })).toBeDisabled();
    await textarea.press("Escape");
    await expect(composer).toHaveCount(0);
  });
}

test("moving an active frame container into a closed shadow root fails closed without losing draft text", async ({ page }) => {
  await page.goto(`${HOST_ORIGIN}/nested-overlay.html`);
  const frame = page.frames().find((candidate) => candidate.url().includes("/nested-prototype.html"));
  expect(frame).toBeDefined();
  await expect.poll(() => page.evaluate(() => globalThis.nestedHostHarness.snapshot().state)).toBe("active");
  await frame!.evaluate(() => globalThis.nestedOverlayHarness.setMode("comment"));
  await frame!.getByRole("button", { name: "Nested prototype action" }).click();
  const composer = page.getByRole("dialog", { name: "Add review comment" });
  const textarea = composer.getByRole("textbox", { name: "Comment" });
  await textarea.fill("Protected across opaque reparenting");

  await page.evaluate(() => globalThis.nestedHostHarness.moveContainerIntoClosedShadow());

  await expect.poll(() => page.evaluate(() => globalThis.nestedHostHarness.snapshot().state)).toBe("idle");
  await expect(composer).toBeVisible();
  await expect(textarea).toHaveValue("Protected across opaque reparenting");
  expect(await page.evaluate(() => globalThis.nestedHostHarness.events.some((event) => {
    return event.type === "error" && event.error?.code === "invalid_state";
  }))).toBe(true);
});

test("a cooperative nested document keeps protected draft text in shell-owned DOM", async ({ page }) => {
  await page.goto(`${HOST_ORIGIN}/nested-overlay.html`);
  const nested = page.frameLocator("iframe[title='Synthetic nested prototype']");
  const action = nested.getByRole("button", { name: "Nested prototype action" });
  await expect(action).toBeVisible();
  const frame = page.frames().find((candidate) => candidate.url().includes("/nested-prototype.html"));
  expect(frame).toBeDefined();
  await expect.poll(() => page.evaluate(() => globalThis.nestedHostHarness.snapshot().state)).toBe("active");
  expect(await frame!.evaluate(() => globalThis.nestedOverlayHarness.unsafeDraftResult)).toEqual({
    accepted: false,
    name: "ReviewDocumentOverlayError",
    code: "invalid_config",
  });

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
  await expect(nested.locator(".crl-overlay__textarea")).toHaveCount(0);
  const composer = page.getByRole("dialog", { name: "Add review comment" });
  await expect(composer).toBeVisible();
  await expect(composer).toHaveClass("crl-frame-draft");
  expect(await composer.evaluate((element) => {
    return getComputedStyle(element).getPropertyValue("--crl-frame-draft-owned").trim();
  })).toBe("1");
  const composerBox = await composer.boundingBox();
  expect(composerBox).not.toBeNull();
  const frameViewport = page.viewportSize()!;
  expect(composerBox!.x).toBeGreaterThanOrEqual(0);
  expect(composerBox!.y).toBeGreaterThanOrEqual(0);
  expect(composerBox!.x + composerBox!.width).toBeLessThanOrEqual(frameViewport.width);
  expect(composerBox!.y + composerBox!.height).toBeLessThanOrEqual(frameViewport.height);
  const textarea = page.getByRole("textbox", { name: "Comment" });
  await textarea.fill("Protected shell-owned draft");
  expect(await frame!.evaluate(() => document.querySelector("textarea")?.value ?? null)).toBeNull();
  expect(await page.evaluate(() => globalThis.nestedHostHarness.draftRequests)).toHaveLength(1);
  expect(await page.evaluate(() => "body" in globalThis.nestedHostHarness.draftRequests[0]!)).toBe(false);
  await textarea.press("Escape");
  await expect(composer).toHaveCount(0);

  await nested.locator("#nested-action-content").click();
  const submittedTextarea = page.getByRole("textbox", { name: "Comment" });
  await submittedTextarea.fill("Submitted protected draft");
  await submittedTextarea.press("Control+Enter");
  await expect(composer).toHaveCount(0);
  expect(await page.evaluate(() => globalThis.nestedHostHarness.draftSubmissions)).toEqual([{
    requestId: "review-draft-2",
    body: "Submitted protected draft",
    anchor: expect.objectContaining({
      schemaVersion: 3,
      locationAvailability: "available",
      element: expect.objectContaining({ identity: "nested-action" }),
    }),
  }]);
  expect(await frame!.evaluate(() => document.querySelector("textarea")?.value ?? null)).toBeNull();
});

test("a shell-owned composer tracks scrolling in an open shadow root attached after child mount", async ({ page }) => {
  await page.goto(`${HOST_ORIGIN}/nested-overlay.html`);
  const frame = page.frames().find((candidate) => candidate.url().includes("/nested-prototype.html"));
  expect(frame).toBeDefined();
  await expect.poll(() => page.evaluate(() => globalThis.nestedHostHarness.snapshot().state)).toBe("active");
  await frame!.evaluate(async () => {
    await globalThis.nestedOverlayHarness.attachDynamicOpenShadow();
    globalThis.nestedOverlayHarness.setMode("comment");
  });
  const action = frame!.getByRole("button", { name: "Nested dynamic open shadow action" });
  await action.click({ position: { x: 20, y: 15 } });
  const composer = page.getByRole("dialog", { name: "Add review comment" });
  await expect(composer).toBeVisible();
  const baseline = await elementOffsetFromTarget(action, composer);
  const updatesBeforeScroll = await page.evaluate(() => (
    globalThis.nestedHostHarness.draftRequests.filter((message) => message.action === "update").length
  ));

  await frame!.evaluate(() => globalThis.nestedOverlayHarness.scrollDynamicOpenShadow(190));
  await expect.poll(() => page.evaluate(() => (
    globalThis.nestedHostHarness.draftRequests.filter((message) => message.action === "update").length
  ))).toBeGreaterThan(updatesBeforeScroll);
  await expect.poll(() => elementOffsetFromTarget(action, composer)).toEqual(baseline);
});

test("a Promise-returning shell draft submit callback consumes rejection before failing closed", async ({ page }) => {
  await page.goto(`${HOST_ORIGIN}/nested-overlay.html`);
  const frame = page.frames().find((candidate) => candidate.url().includes("/nested-prototype.html"));
  expect(frame).toBeDefined();
  await expect.poll(() => page.evaluate(() => globalThis.nestedHostHarness.snapshot().state)).toBe("active");
  await frame!.evaluate(() => globalThis.nestedOverlayHarness.setMode("comment"));
  await frame!.getByRole("button", { name: "Nested prototype action" }).click();
  const textarea = page.getByRole("textbox", { name: "Comment" });
  await textarea.fill("Synthetic rejected shell draft");
  await page.evaluate(() => globalThis.nestedHostHarness.rejectNextDraftSubmissionAsynchronously());
  await textarea.press("Control+Enter");
  await page.evaluate(() => globalThis.nestedHostHarness.settleAsyncEvents());

  expect(await page.evaluate(() => globalThis.nestedHostHarness.unhandledDraftSubmissionRejections())).toBe(0);
  expect(await page.evaluate(() => globalThis.nestedHostHarness.draftSubmissions)).toEqual([]);
  await expect.poll(() => page.evaluate(() => globalThis.nestedHostHarness.snapshot().state)).toBe("idle");
  expect(await page.evaluate(() => globalThis.nestedHostHarness.events.some((event) => {
    return event.type === "error" && event.error?.code === "invalid_config";
  }))).toBe(true);
});

test("a rounded overflow ancestor clips shell composer visibility at its corner", async ({ page }) => {
  await page.goto(`${HOST_ORIGIN}/nested-overlay.html`);
  const frame = page.frames().find((candidate) => candidate.url().includes("/nested-prototype.html"));
  expect(frame).toBeDefined();
  await expect.poll(() => page.evaluate(() => globalThis.nestedHostHarness.snapshot().state)).toBe("active");
  await frame!.evaluate(() => globalThis.nestedOverlayHarness.setMode("comment"));
  await frame!.getByRole("button", { name: "Nested prototype action" }).click({ position: { x: 2, y: 2 } });
  const composer = page.getByRole("dialog", { name: "Add review comment", includeHidden: true });
  await expect(composer).toBeVisible();

  await page.evaluate(() => globalThis.nestedHostHarness.roundFrameClip());
  expect(await page.evaluate(() => {
    const latest = globalThis.nestedHostHarness.draftRequests.at(-1) as { attachment?: { visible?: boolean } } | undefined;
    return latest?.attachment?.visible;
  })).toBe(true);
  await expect(composer).toBeHidden();
});

test("an expanded iframe overflow clip margin keeps painted shell composer content visible", async ({ page }) => {
  await page.goto(`${HOST_ORIGIN}/nested-overlay.html`);
  const frame = page.frames().find((candidate) => candidate.url().includes("/nested-prototype.html"));
  expect(frame).toBeDefined();
  await expect.poll(() => page.evaluate(() => globalThis.nestedHostHarness.snapshot().state)).toBe("active");
  await frame!.evaluate(() => globalThis.nestedOverlayHarness.setMode("comment"));
  await frame!.getByRole("button", { name: "Nested prototype action" }).click({ position: { x: 2, y: 2 } });
  await expect(page.getByRole("dialog", { name: "Add review comment" })).toBeVisible();
  await page.evaluate(() => globalThis.nestedHostHarness.expandFrameClipMargin());
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
  await expect(page.getByRole("dialog", { name: "Add review comment" })).toBeVisible();
});

test("paint-contained iframe content remains visible within its expanded clip margin", async ({ page }) => {
  await page.goto(`${HOST_ORIGIN}/nested-overlay.html`);
  const frame = page.frames().find((candidate) => candidate.url().includes("/nested-prototype.html"));
  expect(frame).toBeDefined();
  await expect.poll(() => page.evaluate(() => globalThis.nestedHostHarness.snapshot().state)).toBe("active");
  await frame!.evaluate(() => globalThis.nestedOverlayHarness.setMode("comment"));
  await frame!.getByRole("button", { name: "Nested prototype action" }).click({ position: { x: 2, y: 2 } });
  await expect(page.getByRole("dialog", { name: "Add review comment" })).toBeVisible();
  await page.evaluate(() => globalThis.nestedHostHarness.expandPaintContainmentClipMargin());
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
  await expect(page.getByRole("dialog", { name: "Add review comment" })).toBeVisible();
});

test("a cooperative frame inside nested shadow DOM remains paint-visible to its shell composer", async ({ page }) => {
  await page.goto(`${HOST_ORIGIN}/nested-overlay.html?shadow=true`);
  const frame = page.frames().find((candidate) => candidate.url().includes("/nested-prototype.html"));
  expect(frame).toBeDefined();
  await expect.poll(() => page.evaluate(() => globalThis.nestedHostHarness.snapshot().state)).toBe("active");
  await frame!.evaluate(() => globalThis.nestedOverlayHarness.setMode("comment"));
  await frame!.getByRole("button", { name: "Nested prototype action" }).click();
  const composer = page.getByRole("dialog", { name: "Add review comment" });
  const textarea = composer.getByRole("textbox", { name: "Comment" });
  await expect(composer).toBeVisible();
  await frame!.evaluate(() => globalThis.nestedOverlayHarness.focusPrototypeLookalike());
  await expect(textarea).toBeFocused();
});

test("a fixed frame escapes unrelated ancestor overflow without losing its shell composer", async ({ page }) => {
  await page.goto(`${HOST_ORIGIN}/nested-overlay.html`);
  const frame = page.frames().find((candidate) => candidate.url().includes("/nested-prototype.html"));
  expect(frame).toBeDefined();
  await expect.poll(() => page.evaluate(() => globalThis.nestedHostHarness.snapshot().state)).toBe("active");
  await page.evaluate(() => globalThis.nestedHostHarness.fixFrameOutsideUnrelatedClip());
  await frame!.evaluate(() => globalThis.nestedOverlayHarness.setMode("comment"));
  await frame!.getByRole("button", { name: "Nested prototype action" }).click();

  await expect(page.getByRole("dialog", { name: "Add review comment" })).toBeVisible();
  expect(await page.evaluate(() => globalThis.nestedHostHarness.snapshot().state)).toBe("active");
});

test("an absolute frame escapes unrelated ancestor overflow without losing its shell composer", async ({ page }) => {
  await page.goto(`${HOST_ORIGIN}/nested-overlay.html`);
  const frame = page.frames().find((candidate) => candidate.url().includes("/nested-prototype.html"));
  expect(frame).toBeDefined();
  await expect.poll(() => page.evaluate(() => globalThis.nestedHostHarness.snapshot().state)).toBe("active");
  await page.evaluate(() => globalThis.nestedHostHarness.positionAbsoluteFrameOutsideUnrelatedClip());
  await frame!.evaluate(() => globalThis.nestedOverlayHarness.setMode("comment"));
  await frame!.getByRole("button", { name: "Nested prototype action" }).click();

  await expect(page.getByRole("dialog", { name: "Add review comment" })).toBeVisible();
  expect(await page.evaluate(() => globalThis.nestedHostHarness.snapshot().state)).toBe("active");
});

test("a boxless positioned ancestor does not intercept an absolute frame's containing block", async ({ page }) => {
  await page.goto(`${HOST_ORIGIN}/nested-overlay.html`);
  const frame = page.frames().find((candidate) => candidate.url().includes("/nested-prototype.html"));
  expect(frame).toBeDefined();
  await expect.poll(() => page.evaluate(() => globalThis.nestedHostHarness.snapshot().state)).toBe("active");
  await page.evaluate(() => globalThis.nestedHostHarness.positionAbsoluteFrameThroughBoxlessAncestor());
  await frame!.evaluate(() => globalThis.nestedOverlayHarness.setMode("comment"));
  await frame!.getByRole("button", { name: "Nested prototype action" }).click();

  await expect(page.getByRole("dialog", { name: "Add review comment" })).toBeVisible();
  expect(await page.evaluate(() => globalThis.nestedHostHarness.snapshot().state)).toBe("active");
});

test("a static frame inside a viewport-fixed ancestor escapes unrelated overflow", async ({ page }) => {
  await page.goto(`${HOST_ORIGIN}/nested-overlay.html`);
  const frame = page.frames().find((candidate) => candidate.url().includes("/nested-prototype.html"));
  expect(frame).toBeDefined();
  await expect.poll(() => page.evaluate(() => globalThis.nestedHostHarness.snapshot().state)).toBe("active");
  await page.evaluate(() => globalThis.nestedHostHarness.fixFrameAncestorOutsideUnrelatedClip());
  await frame!.evaluate(() => globalThis.nestedOverlayHarness.setMode("comment"));
  await frame!.getByRole("button", { name: "Nested prototype action" }).click();

  await expect(page.getByRole("dialog", { name: "Add review comment" })).toBeVisible();
  expect(await page.evaluate(() => globalThis.nestedHostHarness.snapshot().state)).toBe("active");
});

test("a pointer-inert frame inside a fixed ancestor escapes an unrelated rounded clip", async ({ page }) => {
  await page.goto(`${HOST_ORIGIN}/nested-overlay.html`);
  const frame = page.frames().find((candidate) => candidate.url().includes("/nested-prototype.html"));
  expect(frame).toBeDefined();
  await expect.poll(() => page.evaluate(() => globalThis.nestedHostHarness.snapshot().state)).toBe("active");
  await frame!.evaluate(() => globalThis.nestedOverlayHarness.setMode("comment"));
  await frame!.getByRole("button", { name: "Nested prototype action" }).click();
  const composer = page.getByRole("dialog", { name: "Add review comment" });
  await expect(composer).toBeVisible();

  await page.evaluate(() => {
    globalThis.nestedHostHarness.fixFrameAncestorOutsideUnrelatedClip();
    globalThis.nestedHostHarness.roundUnrelatedFrameClip();
    globalThis.nestedHostHarness.setFramePointerEvents("frame");
  });
  await frame!.evaluate(() => globalThis.nestedOverlayHarness.nudgeDraftTarget());
  await expect(composer).toBeVisible();
});

test("an open shell composer follows its frame when a dialog changes modal state", async ({ page }) => {
  await page.goto(`${HOST_ORIGIN}/nested-overlay.html?dialog=true`);
  const frame = page.frames().find((candidate) => candidate.url().includes("/nested-prototype.html"));
  expect(frame).toBeDefined();
  await expect.poll(() => page.evaluate(() => globalThis.nestedHostHarness.snapshot().state)).toBe("active");
  await frame!.evaluate(() => globalThis.nestedOverlayHarness.setMode("comment"));
  await frame!.getByRole("button", { name: "Nested prototype action" }).click();
  const composer = page.getByRole("dialog", { name: "Add review comment" });
  const textarea = composer.getByRole("textbox", { name: "Comment" });
  await textarea.fill("Draft survives modal promotion");
  await expect(page.locator("body > .crl-frame-draft")).toBeVisible();

  await page.evaluate(() => globalThis.nestedHostHarness.setModalState("modal"));
  const modal = page.getByRole("dialog", { name: "Synthetic review modal" });
  await expect(modal.locator(":scope > .crl-frame-draft")).toBeVisible();
  await expect(textarea).toHaveValue("Draft survives modal promotion");
  await expect(textarea).toBeFocused();

  await page.evaluate(() => globalThis.nestedHostHarness.setModalState("nonmodal"));
  await expect(page.locator("body > .crl-frame-draft")).toBeVisible();
  await expect(textarea).toHaveValue("Draft survives modal promotion");
});

test("a nested draft fails closed when its package-owned shell stylesheet is absent", async ({ page }) => {
  await page.goto(`${HOST_ORIGIN}/nested-overlay.html?withoutDraftStyles=true`);
  const frame = page.frames().find((candidate) => candidate.url().includes("/nested-prototype.html"));
  expect(frame).toBeDefined();
  await expect.poll(() => page.evaluate(() => globalThis.nestedHostHarness.snapshot().state)).toBe("active");
  await frame!.evaluate(() => globalThis.nestedOverlayHarness.setMode("comment"));
  await frame!.getByRole("button", { name: "Nested prototype action" }).click();

  await expect.poll(() => page.evaluate(() => globalThis.nestedHostHarness.snapshot().state)).toBe("idle");
  expect(await page.evaluate(() => globalThis.nestedHostHarness.events.some((event) => {
    return event.type === "error" && event.error?.code === "missing_styles";
  }))).toBe(true);
  await expect(page.getByRole("dialog", { name: "Add review comment" })).toHaveCount(0);
});

test("a recreated nested overlay keeps draft request identity unique within its bridge session", async ({ page }) => {
  await page.goto(`${HOST_ORIGIN}/nested-overlay.html`);
  const frame = page.frames().find((candidate) => candidate.url().includes("/nested-prototype.html"));
  expect(frame).toBeDefined();
  await expect.poll(() => page.evaluate(() => globalThis.nestedHostHarness.snapshot().state)).toBe("active");
  await frame!.evaluate(() => globalThis.nestedOverlayHarness.setMode("comment"));
  const action = frame!.getByRole("button", { name: "Nested prototype action" });
  await action.click();
  await page.getByRole("textbox", { name: "Comment" }).press("Escape");
  await frame!.evaluate(() => globalThis.nestedOverlayHarness.recreate());
  await action.click();

  await expect.poll(() => page.evaluate(() => ({
    state: globalThis.nestedHostHarness.snapshot().state,
    requestIds: globalThis.nestedHostHarness.draftRequests
      .filter(({ action }) => action === "open")
      .map(({ requestId }) => requestId),
  }))).toEqual({ state: "active", requestIds: ["review-draft-1", "review-draft-2"] });
  await expect(page.getByRole("dialog", { name: "Add review comment" })).toBeVisible();
});

test("a bordered and CSS-scaled frame maps child draft coordinates into the rendered shell viewport", async ({ page }) => {
  await page.goto(`${HOST_ORIGIN}/nested-overlay.html`);
  const frame = page.frames().find((candidate) => candidate.url().includes("/nested-prototype.html"));
  expect(frame).toBeDefined();
  await expect.poll(() => page.evaluate(() => globalThis.nestedHostHarness.snapshot().state)).toBe("active");
  await page.evaluate(() => globalThis.nestedHostHarness.styleFrame());
  await frame!.evaluate(() => globalThis.nestedOverlayHarness.setMode("comment"));
  const target = frame!.getByRole("button", { name: "Nested prototype action" });
  await target.click();
  const composer = page.getByRole("dialog", { name: "Add review comment" });
  await expect(composer).toBeVisible();
  const [targetBox, composerBox] = await Promise.all([target.boundingBox(), composer.boundingBox()]);
  expect(targetBox).not.toBeNull();
  expect(composerBox).not.toBeNull();
  expect(Math.abs(composerBox!.x - (targetBox!.x + (targetBox!.width / 2) + 12))).toBeLessThanOrEqual(1);
  expect(Math.abs(composerBox!.y - (targetBox!.y + (targetBox!.height / 2) + 12))).toBeLessThanOrEqual(1);
});

test("a padded, bordered, and CSS-scaled frame maps from the child content viewport", async ({ page }) => {
  await page.goto(`${HOST_ORIGIN}/nested-overlay.html`);
  const frame = page.frames().find((candidate) => candidate.url().includes("/nested-prototype.html"));
  expect(frame).toBeDefined();
  await expect.poll(() => page.evaluate(() => globalThis.nestedHostHarness.snapshot().state)).toBe("active");
  await page.evaluate(() => globalThis.nestedHostHarness.styleFrame("scale(0.75)", "18px 24px"));
  await frame!.evaluate(() => globalThis.nestedOverlayHarness.setMode("comment"));
  const target = frame!.getByRole("button", { name: "Nested prototype action" });
  await target.click();

  const composer = page.getByRole("dialog", { name: "Add review comment" });
  await expect(composer).toBeVisible();
  const [targetBox, composerBox] = await Promise.all([target.boundingBox(), composer.boundingBox()]);
  expect(targetBox).not.toBeNull();
  expect(composerBox).not.toBeNull();
  expect(Math.abs(composerBox!.x - (targetBox!.x + (targetBox!.width / 2) + 12))).toBeLessThanOrEqual(1);
  expect(Math.abs(composerBox!.y - (targetBox!.y + (targetBox!.height / 2) + 12))).toBeLessThanOrEqual(1);
});

test("a two-axis scale longhand frame keeps its shell composer attached", async ({ page }) => {
  await page.goto(`${HOST_ORIGIN}/nested-overlay.html`);
  const frame = page.frames().find((candidate) => candidate.url().includes("/nested-prototype.html"));
  expect(frame).toBeDefined();
  await expect.poll(() => page.evaluate(() => globalThis.nestedHostHarness.snapshot().state)).toBe("active");
  await page.evaluate(() => globalThis.nestedHostHarness.styleFrameScale("0.75 0.5"));
  await frame!.evaluate(() => globalThis.nestedOverlayHarness.setMode("comment"));
  await frame!.getByRole("button", { name: "Nested prototype action" }).click();

  await expect(page.getByRole("dialog", { name: "Add review comment" })).toBeVisible();
});

for (const scope of ["frame", "ancestor"] as const) {
  test(`a pointer-inert ${scope} remains painted for shell composer visibility`, async ({ page }) => {
    await page.goto(`${HOST_ORIGIN}/nested-overlay.html`);
    const frame = page.frames().find((candidate) => candidate.url().includes("/nested-prototype.html"));
    expect(frame).toBeDefined();
    await expect.poll(() => page.evaluate(() => globalThis.nestedHostHarness.snapshot().state)).toBe("active");
    await frame!.evaluate(() => globalThis.nestedOverlayHarness.setMode("comment"));
    await frame!.getByRole("button", { name: "Nested prototype action" }).click();
    const composer = page.getByRole("dialog", { name: "Add review comment" });
    await expect(composer).toBeVisible();

    await page.evaluate((value) => globalThis.nestedHostHarness.setFramePointerEvents(value), scope);
    await expect(composer).toBeVisible();
  });

  test(`an inert legacy clip on a static ${scope} keeps the shell composer visible`, async ({ page }) => {
    await page.goto(`${HOST_ORIGIN}/nested-overlay.html`);
    const frame = page.frames().find((candidate) => candidate.url().includes("/nested-prototype.html"));
    expect(frame).toBeDefined();
    await expect.poll(() => page.evaluate(() => globalThis.nestedHostHarness.snapshot().state)).toBe("active");
    await frame!.evaluate(() => globalThis.nestedOverlayHarness.setMode("comment"));
    await frame!.getByRole("button", { name: "Nested prototype action" }).click();
    const composer = page.getByRole("dialog", { name: "Add review comment" });
    await expect(composer).toBeVisible();

    await page.evaluate((value) => globalThis.nestedHostHarness.setInertLegacyClip(value), scope);
    await expect(composer).toBeVisible();
  });
}

test("a pointer-inert frame inside a rounded non-clipping card remains painted", async ({ page }) => {
  await page.goto(`${HOST_ORIGIN}/nested-overlay.html`);
  const frame = page.frames().find((candidate) => candidate.url().includes("/nested-prototype.html"));
  expect(frame).toBeDefined();
  await expect.poll(() => page.evaluate(() => globalThis.nestedHostHarness.snapshot().state)).toBe("active");
  await frame!.evaluate(() => globalThis.nestedOverlayHarness.setMode("comment"));
  await frame!.getByRole("button", { name: "Nested prototype action" }).click();
  const composer = page.getByRole("dialog", { name: "Add review comment" });
  await expect(composer).toBeVisible();

  await page.evaluate(() => {
    globalThis.nestedHostHarness.roundFrameWithoutClipping();
    globalThis.nestedHostHarness.setFramePointerEvents("frame");
  });
  await frame!.evaluate(() => globalThis.nestedOverlayHarness.nudgeDraftTarget());
  await expect(composer).toBeVisible();
});

test("viewport-propagated body overflow does not clip a visible nested frame", async ({ page }) => {
  await page.goto(`${HOST_ORIGIN}/nested-overlay.html`);
  const frame = page.frames().find((candidate) => candidate.url().includes("/nested-prototype.html"));
  expect(frame).toBeDefined();
  await expect.poll(() => page.evaluate(() => globalThis.nestedHostHarness.snapshot().state)).toBe("active");
  await frame!.evaluate(() => globalThis.nestedOverlayHarness.setMode("comment"));
  await frame!.getByRole("button", { name: "Nested prototype action" }).click();
  const composer = page.getByRole("dialog", { name: "Add review comment" });
  await expect(composer).toBeVisible();

  await page.evaluate(() => globalThis.nestedHostHarness.propagateBodyOverflow());
  await expect(composer).toBeVisible();
});

test("viewport-propagated rounded body overflow does not hide a pointer-inert frame", async ({ page }) => {
  await page.goto(`${HOST_ORIGIN}/nested-overlay.html`);
  const frame = page.frames().find((candidate) => candidate.url().includes("/nested-prototype.html"));
  expect(frame).toBeDefined();
  await expect.poll(() => page.evaluate(() => globalThis.nestedHostHarness.snapshot().state)).toBe("active");
  await frame!.evaluate(() => globalThis.nestedOverlayHarness.setMode("comment"));
  await frame!.getByRole("button", { name: "Nested prototype action" }).click();
  const composer = page.getByRole("dialog", { name: "Add review comment" });
  await expect(composer).toBeVisible();

  await page.evaluate(() => {
    document.documentElement.style.overflow = "visible";
    document.body.style.overflow = "hidden";
    document.body.style.borderRadius = "60px";
    globalThis.nestedHostHarness.setFramePointerEvents("frame");
  });
  await frame!.evaluate(() => globalThis.nestedOverlayHarness.nudgeDraftTarget());
  await expect(composer).toBeVisible();
});

for (const transform of ["rotate(8deg)", "skewX(12deg)"]) {
  test(`a ${transform} frame fails closed instead of misplacing its shell composer`, async ({ page }) => {
    await page.goto(`${HOST_ORIGIN}/nested-overlay.html`);
    const frame = page.frames().find((candidate) => candidate.url().includes("/nested-prototype.html"));
    expect(frame).toBeDefined();
    await expect.poll(() => page.evaluate(() => globalThis.nestedHostHarness.snapshot().state)).toBe("active");
    await page.evaluate((value) => globalThis.nestedHostHarness.styleFrame(value), transform);
    await frame!.evaluate(() => globalThis.nestedOverlayHarness.setMode("comment"));
    await frame!.getByRole("button", { name: "Nested prototype action" }).click();

    await expect(page.getByRole("dialog", { name: "Add review comment" })).toBeHidden();
    expect(await page.evaluate(() => globalThis.nestedHostHarness.snapshot().state)).toBe("active");
  });
}

test("a frame slotted below a transformed shadow wrapper fails closed", async ({ page }) => {
  await page.goto(`${HOST_ORIGIN}/nested-overlay.html`);
  const frame = page.frames().find((candidate) => candidate.url().includes("/nested-prototype.html"));
  expect(frame).toBeDefined();
  await expect.poll(() => page.evaluate(() => globalThis.nestedHostHarness.snapshot().state)).toBe("active");
  await frame!.evaluate(() => globalThis.nestedOverlayHarness.setMode("comment"));
  await frame!.getByRole("button", { name: "Nested prototype action" }).click();
  const composer = page.getByRole("dialog", { name: "Add review comment" });
  await expect(composer).toBeVisible();
  await page.evaluate(() => globalThis.nestedHostHarness.nestFrameInTransformedSlot("rotate(2deg)"));

  await expect(composer).toBeHidden();
  expect(await page.evaluate(() => globalThis.nestedHostHarness.snapshot().state)).toBe("active");
});

test("a frame inside an active modal keeps its shell-owned composer interactive in that modal", async ({ page }) => {
  await page.goto(`${HOST_ORIGIN}/nested-overlay.html?modal=true`);
  const frame = page.frames().find((candidate) => candidate.url().includes("/nested-prototype.html"));
  expect(frame).toBeDefined();
  await expect.poll(() => page.evaluate(() => globalThis.nestedHostHarness.snapshot().state)).toBe("active");
  await frame!.evaluate(() => globalThis.nestedOverlayHarness.setMode("comment"));
  await frame!.getByRole("button", { name: "Nested prototype action" }).click();

  const modal = page.getByRole("dialog", { name: "Synthetic review modal" });
  const composer = modal.getByRole("dialog", { name: "Add review comment" });
  await expect(composer).toBeVisible();
  const textarea = composer.getByRole("textbox", { name: "Comment" });
  await expect(textarea).toBeFocused();
  await textarea.fill("Modal-owned synthetic draft");
  await composer.getByRole("button", { name: "Cancel" }).click();
  await expect(composer).toHaveCount(0);
});

test("a styled open-shadow modal hosts the shell-owned composer in its own style scope", async ({ page }) => {
  await page.goto(`${HOST_ORIGIN}/nested-overlay.html?shadowModal=true`);
  const frame = page.frames().find((candidate) => candidate.url().includes("/nested-prototype.html"));
  expect(frame).toBeDefined();
  await expect.poll(() => page.evaluate(() => globalThis.nestedHostHarness.snapshot().state)).toBe("active");
  await frame!.evaluate(() => globalThis.nestedOverlayHarness.setMode("comment"));
  await frame!.getByRole("button", { name: "Nested prototype action" }).click();

  const modal = page.getByRole("dialog", { name: "Synthetic shadow review modal" });
  const composer = modal.getByRole("dialog", { name: "Add review comment" });
  await expect(composer).toBeVisible();
  await expect(composer).toHaveCSS("position", "fixed");
  await expect(composer.getByRole("textbox", { name: "Comment" })).toBeFocused();

  await page.evaluate(() => globalThis.nestedHostHarness.removeShadowModalStyles());
  await expect(composer).toBeHidden();
  await expect.poll(() => frame!.evaluate(() => globalThis.nestedOverlayHarness.snapshot().composerOpen)).toBe(false);
  expect(await page.evaluate(() => globalThis.nestedHostHarness.snapshot().state)).toBe("active");
});

test("an active draft entering an unstyled shadow modal is dismissed with focus in the shell", async ({ page }) => {
  await page.goto(`${HOST_ORIGIN}/nested-overlay.html?shadowDialog=true`);
  const frame = page.frames().find((candidate) => candidate.url().includes("/nested-prototype.html"));
  expect(frame).toBeDefined();
  await expect.poll(() => page.evaluate(() => globalThis.nestedHostHarness.snapshot().state)).toBe("active");
  await frame!.evaluate(() => globalThis.nestedOverlayHarness.setMode("comment"));
  await frame!.getByRole("button", { name: "Nested prototype action" }).click();
  const composer = page.getByRole("dialog", { name: "Add review comment" });
  await expect(composer).toBeVisible();
  await composer.getByRole("textbox", { name: "Comment" }).fill("Discard when the owned asset is unavailable");

  await page.evaluate(() => globalThis.nestedHostHarness.promoteUnstyledShadowDialog());

  await expect(composer).toHaveCount(0);
  await expect.poll(() => frame!.evaluate(() => globalThis.nestedOverlayHarness.snapshot().composerOpen)).toBe(false);
  expect(await page.evaluate(() => {
    const host = document.querySelector("#nested-unstyled-shadow-dialog-host");
    const root = host?.shadowRoot;
    return {
      documentActive: document.activeElement?.id,
      shadowActive: root?.activeElement?.getAttribute("aria-label"),
      state: globalThis.nestedHostHarness.snapshot().state,
    };
  })).toEqual({
    documentActive: "nested-unstyled-shadow-dialog-host",
    shadowActive: "Synthetic unstyled shadow dialog",
    state: "active",
  });
});

for (const focusAction of ["close", "replace"] as const) {
  test(`unstyled-modal focus ${focusAction} reentrancy preserves the newer frame lifecycle`, async ({ page }) => {
    await page.goto(`${HOST_ORIGIN}/nested-overlay.html?shadowDialog=true`);
    const frame = page.frames().find((candidate) => candidate.url().includes("/nested-prototype.html"));
    expect(frame).toBeDefined();
    await expect.poll(() => page.evaluate(() => globalThis.nestedHostHarness.snapshot().state)).toBe("active");
    await frame!.evaluate(() => globalThis.nestedOverlayHarness.setMode("comment"));
    await frame!.getByRole("button", { name: "Nested prototype action" }).click();
    await expect(page.getByRole("dialog", { name: "Add review comment" })).toBeVisible();

    await page.evaluate((action) => {
      globalThis.nestedHostHarness.promoteUnstyledShadowDialogWithFocusAction(action);
    }, focusAction);

    if (focusAction === "close") {
      await expect.poll(() => page.evaluate(() => globalThis.nestedHostHarness.snapshot().state)).toBe("closed");
    } else {
      await expect.poll(() => page.evaluate(() => globalThis.nestedHostHarness.snapshot())).toEqual(
        expect.objectContaining({ state: "active", sessionId: "nested-overlay-replacement" }),
      );
    }
    await expect(page.getByRole("dialog", { name: "Add review comment" })).toHaveCount(0);
  });
}

for (const focusAction of ["close", "replace"] as const) {
  test(`trusted draft dismissal preserves a ${focusAction} lifecycle created during focus restoration`, async ({ page }) => {
    await page.goto(`${HOST_ORIGIN}/nested-overlay.html`);
    await expect.poll(() => page.evaluate(() => globalThis.nestedHostHarness.snapshot().state)).toBe("active");
    await page.evaluate(() => globalThis.nestedHostHarness.prepareDraftFocusReturnTrigger());
    await page.getByRole("button", { name: "Open synthetic child draft" }).click();
    const textarea = page.getByRole("textbox", { name: "Comment" });
    await textarea.fill("Trusted dismissal reentrancy");
    await page.evaluate((action) => globalThis.nestedHostHarness.setDraftFocusReturnAction(action), focusAction);

    await textarea.press("Escape");

    if (focusAction === "close") {
      await expect.poll(() => page.evaluate(() => globalThis.nestedHostHarness.snapshot().state)).toBe("closed");
    } else {
      await expect.poll(() => page.evaluate(() => globalThis.nestedHostHarness.snapshot())).toEqual(
        expect.objectContaining({ state: "active", sessionId: "draft-focus-replacement" }),
      );
    }
    await expect(page.getByRole("dialog", { name: "Add review comment" })).toHaveCount(0);
  });
}

test("remote draft update and dismissal delivery retry transactionally after callback failure", async ({ page }) => {
  await page.goto(`${HOST_ORIGIN}/nested-overlay.html`);
  const frame = page.frames().find((candidate) => candidate.url().includes("/nested-prototype.html"));
  expect(frame).toBeDefined();
  await expect.poll(() => page.evaluate(() => globalThis.nestedHostHarness.snapshot().state)).toBe("active");
  await frame!.evaluate(() => globalThis.nestedOverlayHarness.setMode("comment"));
  await frame!.getByRole("button", { name: "Nested prototype action" }).click();

  const unavailableRetry = await frame!.evaluate(() => globalThis.nestedOverlayHarness.retryUnavailableAfterFailure());
  expect(unavailableRetry.firstError).toMatch(/synthetic draft event failure/u);
  expect(unavailableRetry.attempts).toHaveLength(2);
  await expect(page.getByRole("dialog", { name: "Add review comment" })).toHaveCount(0);

  await frame!.evaluate(() => globalThis.nestedOverlayHarness.recreate());
  await frame!.getByRole("button", { name: "Nested sticky action" }).click();
  await expect(page.getByRole("dialog", { name: "Add review comment" })).toBeVisible();
  const dismissalRetry = await frame!.evaluate(() => globalThis.nestedOverlayHarness.retryDestroyAfterFailure());
  expect(dismissalRetry.firstError).toMatch(/synthetic draft event failure/u);
  expect(dismissalRetry.afterFailure).toEqual(expect.objectContaining({ state: "mounted", composerOpen: true }));
  expect(dismissalRetry.afterRetry).toEqual(expect.objectContaining({ state: "destroyed", composerOpen: false }));
  expect(dismissalRetry.attempts).toHaveLength(2);
  await expect(page.getByRole("dialog", { name: "Add review comment" })).toHaveCount(0);
});

test("the shell rejects a cooperative draft whose Anchor Context differs from its opened review", async ({ page }) => {
  await page.goto(`${HOST_ORIGIN}/nested-overlay.html`);
  const frame = page.frames().find((candidate) => candidate.url().includes("/nested-prototype.html"));
  expect(frame).toBeDefined();
  await expect.poll(() => page.evaluate(() => globalThis.nestedHostHarness.snapshot().state)).toBe("active");
  await frame!.evaluate(() => {
    globalThis.nestedOverlayHarness.forgeNextDraftContext();
    globalThis.nestedOverlayHarness.setMode("comment");
  });
  await frame!.getByRole("button", { name: "Nested prototype action" }).click();

  await expect.poll(() => page.evaluate(() => globalThis.nestedHostHarness.snapshot().state)).toBe("idle");
  expect(await page.evaluate(() => globalThis.nestedHostHarness.events.some((event) => {
    return event.type === "error" && event.error?.code === "invalid_message";
  }))).toBe(true);
  await expect(page.getByRole("dialog", { name: "Add review comment" })).toHaveCount(0);
  expect(await page.evaluate(() => globalThis.nestedHostHarness.draftSubmissions)).toEqual([]);
});

test("remote draft update and dismissal delivery tolerate synchronous refresh re-entry", async ({ page }) => {
  await page.goto(`${HOST_ORIGIN}/nested-overlay.html`);
  const frame = page.frames().find((candidate) => candidate.url().includes("/nested-prototype.html"));
  expect(frame).toBeDefined();
  await expect.poll(() => page.evaluate(() => globalThis.nestedHostHarness.snapshot().state)).toBe("active");
  await frame!.evaluate(() => globalThis.nestedOverlayHarness.setMode("comment"));
  await frame!.getByRole("button", { name: "Nested prototype action" }).click();

  expect(await frame!.evaluate(() => globalThis.nestedOverlayHarness.reenterUnavailableUpdate())).toBe(1);
  await expect(page.getByRole("dialog", { name: "Add review comment" })).toHaveCount(0);
  await expect.poll(() => frame!.evaluate(() => globalThis.nestedOverlayHarness.snapshot().composerOpen)).toBe(false);

  await frame!.evaluate(() => globalThis.nestedOverlayHarness.recreate());
  await frame!.getByRole("button", { name: "Nested sticky action" }).click();
  await expect(page.getByRole("dialog", { name: "Add review comment" })).toBeVisible();
  expect(await frame!.evaluate(() => globalThis.nestedOverlayHarness.reenterDismissal())).toEqual({ state: "destroyed", attempts: 1 });
  await expect(page.getByRole("dialog", { name: "Add review comment" })).toHaveCount(0);
});

test("promise-returning draft lifecycle callbacks fail synchronously without unhandled rejections", async ({ page }) => {
  await page.goto(`${HOST_ORIGIN}/nested-overlay.html`);
  const frame = page.frames().find((candidate) => candidate.url().includes("/nested-prototype.html"));
  expect(frame).toBeDefined();
  await expect.poll(() => page.evaluate(() => globalThis.nestedHostHarness.snapshot().state)).toBe("active");
  await frame!.evaluate(() => {
    globalThis.nestedOverlayHarness.rejectNextDraftEventAsynchronously("open");
    globalThis.nestedOverlayHarness.setMode("comment");
  });
  await frame!.getByRole("button", { name: "Nested prototype action" }).click();
  await frame!.evaluate(() => globalThis.nestedOverlayHarness.settleAsyncEvents());

  expect(await frame!.evaluate(() => globalThis.nestedOverlayHarness.snapshot())).toEqual(
    expect.objectContaining({ state: "mounted", composerOpen: false }),
  );
  expect(await frame!.evaluate(() => globalThis.nestedOverlayHarness.unhandledDraftRejections())).toBe(0);
  await expect(page.getByRole("dialog", { name: "Add review comment" })).toHaveCount(0);

  await frame!.getByRole("button", { name: "Nested prototype action" }).click();
  await expect(page.getByRole("dialog", { name: "Add review comment" })).toBeVisible();
  const unavailableRetry = await frame!.evaluate(() => globalThis.nestedOverlayHarness.retryUnavailableAfterAsyncReturn());
  expect(unavailableRetry.firstError).toMatch(/callbacks must be synchronous/u);
  expect(unavailableRetry.attempts).toHaveLength(2);
  await expect(page.getByRole("dialog", { name: "Add review comment" })).toHaveCount(0);

  await frame!.evaluate(() => globalThis.nestedOverlayHarness.recreate());
  await frame!.getByRole("button", { name: "Nested sticky action" }).click();
  await expect(page.getByRole("dialog", { name: "Add review comment" })).toBeVisible();
  const dismissalRetry = await frame!.evaluate(() => globalThis.nestedOverlayHarness.retryDestroyAfterAsyncReturn());
  expect(dismissalRetry.firstError).toMatch(/callbacks must be synchronous/u);
  expect(dismissalRetry.afterFailure).toEqual(expect.objectContaining({ state: "mounted", composerOpen: true }));
  expect(dismissalRetry.afterRetry).toEqual(expect.objectContaining({ state: "destroyed", composerOpen: false }));
  expect(dismissalRetry.attempts).toHaveLength(2);
  await frame!.evaluate(() => globalThis.nestedOverlayHarness.settleAsyncEvents());
  expect(await frame!.evaluate(() => globalThis.nestedOverlayHarness.unhandledDraftRejections())).toBe(0);
  await expect(page.getByRole("dialog", { name: "Add review comment" })).toHaveCount(0);
});

test("non-transportable remote attachment coordinates become unavailable before bridge delivery", async ({ page }) => {
  await page.goto(`${HOST_ORIGIN}/nested-overlay.html`);
  const frame = page.frames().find((candidate) => candidate.url().includes("/nested-prototype.html"));
  expect(frame).toBeDefined();
  await expect.poll(() => page.evaluate(() => globalThis.nestedHostHarness.snapshot().state)).toBe("active");
  await frame!.evaluate(() => globalThis.nestedOverlayHarness.setMode("comment"));
  await frame!.getByRole("button", { name: "Nested prototype action" }).click();
  await expect(page.getByRole("dialog", { name: "Add review comment" })).toBeVisible();

  const result = await frame!.evaluate(() => globalThis.nestedOverlayHarness.moveDraftTargetBeyondBridgeLimit());
  expect(result.error).toBeUndefined();
  expect(result.snapshot).toEqual(expect.objectContaining({ state: "mounted", composerOpen: true }));
  expect(result.attempts.at(-1)).toEqual(expect.objectContaining({
    action: "update",
    attachment: { locationAvailability: "unavailable" },
  }));
  await expect(page.getByRole("dialog", { name: "Add review comment" })).toHaveCount(0);
  await expect.poll(() => frame!.evaluate(() => globalThis.nestedOverlayHarness.snapshot().composerOpen)).toBe(false);
  expect(await page.evaluate(() => globalThis.nestedHostHarness.snapshot().state)).toBe("active");
});

for (const obscuring of [
  "frame-visibility",
  "frame-filter-opacity",
  "ancestor-opacity",
  "ancestor-filter-opacity",
  "ancestor-clip",
  "frame-legacy-clip",
  "ancestor-legacy-clip",
] as const) {
  test(`${obscuring} hides the shell composer even while the child still reports a visible point`, async ({ page }) => {
    await page.goto(`${HOST_ORIGIN}/nested-overlay.html`);
    const frame = page.frames().find((candidate) => candidate.url().includes("/nested-prototype.html"));
    expect(frame).toBeDefined();
    await expect.poll(() => page.evaluate(() => globalThis.nestedHostHarness.snapshot().state)).toBe("active");
    await frame!.evaluate(() => globalThis.nestedOverlayHarness.setMode("comment"));
    await frame!.getByRole("button", { name: "Nested prototype action" }).click();
    const composer = page.getByRole("dialog", { name: "Add review comment" });
    await expect(composer).toBeVisible();

    await page.evaluate((kind) => globalThis.nestedHostHarness.obscureFrame(kind), obscuring);
    expect(await page.evaluate(() => {
      const latest = globalThis.nestedHostHarness.draftRequests.at(-1) as { attachment?: { visible?: boolean } } | undefined;
      return latest?.attachment?.visible;
    })).toBe(true);
    await expect(composer).toBeHidden();
  });
}

for (const testCase of [
  { host: "body", transform: "translate(24px, 16px)" },
  { host: "body", transform: "scale(0.9)" },
  { host: "modal", transform: "translate(24px, 16px)" },
  { host: "modal", transform: "scale(0.9)" },
] as const) {
  test(`a transformed ${testCase.host} composer host fails closed for ${testCase.transform}`, async ({ page }) => {
    const query = testCase.host === "modal" ? "?modal=true" : "";
    await page.goto(`${HOST_ORIGIN}/nested-overlay.html${query}`);
    const frame = page.frames().find((candidate) => candidate.url().includes("/nested-prototype.html"));
    expect(frame).toBeDefined();
    await expect.poll(() => page.evaluate(() => globalThis.nestedHostHarness.snapshot().state)).toBe("active");
    await page.evaluate((transform) => globalThis.nestedHostHarness.transformComposerHost(transform), testCase.transform);
    await frame!.evaluate(() => globalThis.nestedOverlayHarness.setMode("comment"));
    await frame!.getByRole("button", { name: "Nested prototype action" }).click();

    const composer = page.locator(".crl-frame-draft");
    await expect(composer).toHaveAttribute("hidden", "");
    expect(await page.evaluate(() => {
      const latest = globalThis.nestedHostHarness.draftRequests.at(-1) as { attachment?: { visible?: boolean } } | undefined;
      return latest?.attachment?.visible;
    })).toBe(true);
  });
}

for (const host of ["body", "modal"] as const) {
  test(`a preserve-3d ${host} composer host fails closed`, async ({ page }) => {
    const query = host === "modal" ? "?modal=true" : "";
    await page.goto(`${HOST_ORIGIN}/nested-overlay.html${query}`);
    const frame = page.frames().find((candidate) => candidate.url().includes("/nested-prototype.html"));
    expect(frame).toBeDefined();
    await expect.poll(() => page.evaluate(() => globalThis.nestedHostHarness.snapshot().state)).toBe("active");
    await page.evaluate(() => globalThis.nestedHostHarness.styleComposerHost("transform-style", "preserve-3d"));
    await frame!.evaluate(() => globalThis.nestedOverlayHarness.setMode("comment"));
    await frame!.getByRole("button", { name: "Nested prototype action" }).click();

    const composer = page.locator(".crl-frame-draft");
    await expect(composer).toHaveAttribute("hidden", "");
    expect(await page.evaluate(() => {
      const latest = globalThis.nestedHostHarness.draftRequests.at(-1) as { attachment?: { visible?: boolean } } | undefined;
      return latest?.attachment?.visible;
    })).toBe(true);
  });
}

test("a transformed shell-owned composer fails closed", async ({ page }) => {
  await page.goto(`${HOST_ORIGIN}/nested-overlay.html`);
  const frame = page.frames().find((candidate) => candidate.url().includes("/nested-prototype.html"));
  expect(frame).toBeDefined();
  await expect.poll(() => page.evaluate(() => globalThis.nestedHostHarness.snapshot().state)).toBe("active");
  await frame!.evaluate(() => globalThis.nestedOverlayHarness.setMode("comment"));
  await frame!.getByRole("button", { name: "Nested prototype action" }).click();
  const composer = page.getByRole("dialog", { name: "Add review comment" });
  await expect(composer).toBeVisible();

  await page.evaluate(() => globalThis.nestedHostHarness.styleComposer("transform", "translate(24px, 16px)"));
  await expect(composer).toBeHidden();
});

test("a hidden nested composer parks focus in shell-owned DOM and restores it only after visibility recovers", async ({ page }) => {
  await page.goto(`${HOST_ORIGIN}/nested-overlay.html`);
  const frame = page.frames().find((candidate) => candidate.url().includes("/nested-prototype.html"));
  expect(frame).toBeDefined();
  await expect.poll(() => page.evaluate(() => globalThis.nestedHostHarness.snapshot().state)).toBe("active");
  await frame!.evaluate(() => globalThis.nestedOverlayHarness.setMode("comment"));
  await frame!.getByRole("button", { name: "Nested prototype action" }).click();
  const composer = page.getByRole("dialog", { name: "Add review comment" });
  const textarea = page.getByRole("textbox", { name: "Comment" });
  await expect(textarea).toBeFocused();

  await page.evaluate(() => globalThis.nestedHostHarness.transformComposerHost("translate(24px, 16px)"));
  await expect(composer).toBeHidden();
  expect(await page.evaluate(() => ({
    className: document.activeElement?.className,
    trappedInHiddenComposer: Boolean(document.activeElement?.closest(".crl-frame-draft[hidden]")),
  }))).toEqual({ className: "crl-frame-draft-focus-sentinel", trappedInHiddenComposer: false });

  await page.evaluate(() => globalThis.nestedHostHarness.transformComposerHost(""));
  await expect(composer).toBeVisible();
  await expect(textarea).toBeFocused();
});

test("prototype-driven draft hiding and dismissal keep focus in shell-owned DOM", async ({ page }) => {
  await page.goto(`${HOST_ORIGIN}/nested-overlay.html`);
  const frame = page.frames().find((candidate) => candidate.url().includes("/nested-prototype.html"));
  expect(frame).toBeDefined();
  await expect.poll(() => page.evaluate(() => globalThis.nestedHostHarness.snapshot().state)).toBe("active");
  await frame!.evaluate(() => globalThis.nestedOverlayHarness.setMode("comment"));
  await frame!.getByRole("button", { name: "Nested prototype action" }).click();
  const composer = page.getByRole("dialog", { name: "Add review comment" });
  const textarea = composer.getByRole("textbox", { name: "Comment" });
  await textarea.fill("Protected while hidden");

  await frame!.evaluate(() => globalThis.nestedOverlayHarness.focusPrototypeLookalike());
  await expect(textarea).toBeFocused();
  await frame!.evaluate(() => globalThis.nestedOverlayHarness.reportDraftVisibility(false));
  await expect(composer).toBeHidden();
  expect(await page.evaluate(() => document.activeElement?.className)).toBe("crl-frame-draft-focus-sentinel");

  await frame!.evaluate(() => globalThis.nestedOverlayHarness.focusPrototypeLookalike());
  await expect.poll(() => page.evaluate(() => document.activeElement?.className)).toBe("crl-frame-draft-focus-sentinel");

  await frame!.evaluate(() => globalThis.nestedOverlayHarness.reportDraftVisibility(true));
  await expect(composer).toBeVisible();
  await expect(textarea).toBeFocused();
  await expect(textarea).toHaveValue("Protected while hidden");

  await frame!.evaluate(() => globalThis.nestedOverlayHarness.focusPrototypeLookalike());
  await expect(textarea).toBeFocused();
  await frame!.evaluate(() => globalThis.nestedOverlayHarness.reportDraftUnavailable());
  await expect(composer).toBeVisible();
  await expect(textarea).toHaveValue("Protected while hidden");
  await expect(composer.getByText("Comment location unavailable. Your draft is preserved.")).toBeVisible();
  await expect(composer.getByRole("button", { name: "Submit comment" })).toBeDisabled();

  await frame!.evaluate(() => globalThis.nestedOverlayHarness.reportDraftVisibility(true));
  await expect(composer.getByText("Comment location unavailable. Your draft is preserved.")).toBeHidden();
  await expect(composer.getByRole("button", { name: "Submit comment" })).toBeEnabled();

  await frame!.evaluate(() => globalThis.nestedOverlayHarness.dismissDraftFromPrototype());
  await expect(composer).toBeVisible();
  await expect(textarea).toHaveValue("Protected while hidden");
  await expect(composer.getByText("Comment location unavailable. Your draft is preserved.")).toBeVisible();
  await textarea.press("Escape");
  await expect(composer).toHaveCount(0);
});

test("an unsolicited prototype draft open fails closed without current user activation", async ({ page }) => {
  await page.goto(`${HOST_ORIGIN}/nested-overlay.html`);
  const frame = page.frames().find((candidate) => candidate.url().includes("/nested-prototype.html"));
  expect(frame).toBeDefined();
  await expect.poll(() => page.evaluate(() => globalThis.nestedHostHarness.snapshot().state)).toBe("active");

  await frame!.evaluate(() => globalThis.nestedOverlayHarness.sendUnsolicitedDraftOpen());

  await expect.poll(() => page.evaluate(() => globalThis.nestedHostHarness.snapshot().state)).toBe("idle");
  await expect(page.getByRole("dialog", { name: "Add review comment" })).toHaveCount(0);
  expect(await page.evaluate(() => globalThis.nestedHostHarness.events.some((event) => {
    return event.type === "error" && event.error?.code === "invalid_state";
  }))).toBe(true);
});

test("the shell composer paints above a high frame stacking context", async ({ page }) => {
  await page.goto(`${HOST_ORIGIN}/nested-overlay.html`);
  const frame = page.frames().find((candidate) => candidate.url().includes("/nested-prototype.html"));
  expect(frame).toBeDefined();
  await expect.poll(() => page.evaluate(() => globalThis.nestedHostHarness.snapshot().state)).toBe("active");
  await page.evaluate(() => globalThis.nestedHostHarness.raiseFrameStackingContext());
  await frame!.evaluate(() => globalThis.nestedOverlayHarness.setMode("comment"));
  await frame!.getByRole("button", { name: "Nested prototype action" }).click();
  const textarea = page.getByRole("textbox", { name: "Comment" });
  const box = await textarea.boundingBox();
  expect(box).not.toBeNull();
  expect(await page.evaluate(({ x, y }) => {
    return Boolean(document.elementFromPoint(x, y)?.closest(".crl-frame-draft"));
  }, { x: box!.x + (box!.width / 2), y: box!.y + (box!.height / 2) })).toBe(true);
});

for (const host of ["body", "modal"] as const) {
  test(`a container-query-only ${host} remains a valid viewport-fixed composer host`, async ({ page }) => {
    const query = host === "modal" ? "?modal=true" : "";
    await page.goto(`${HOST_ORIGIN}/nested-overlay.html${query}`);
    const frame = page.frames().find((candidate) => candidate.url().includes("/nested-prototype.html"));
    expect(frame).toBeDefined();
    await expect.poll(() => page.evaluate(() => globalThis.nestedHostHarness.snapshot().state)).toBe("active");
    if (host === "modal") {
      await page.evaluate(() => {
        globalThis.nestedHostHarness.styleComposerHost("width", "80vw");
        globalThis.nestedHostHarness.styleComposerHost("height", "80vh");
      });
    }
    await page.evaluate(() => globalThis.nestedHostHarness.styleComposerHost("container-type", "inline-size"));
    await frame!.evaluate(() => globalThis.nestedOverlayHarness.setMode("comment"));
    const target = frame!.getByRole("button", { name: "Nested prototype action" });
    await target.click();

    const composer = page.getByRole("dialog", { name: "Add review comment" });
    await expect(composer).toBeVisible();
    const [targetBox, composerBox] = await Promise.all([target.boundingBox(), composer.boundingBox()]);
    expect(targetBox).not.toBeNull();
    expect(composerBox).not.toBeNull();
    expect(Math.abs(composerBox!.x - (targetBox!.x + (targetBox!.width / 2) + 12))).toBeLessThanOrEqual(1);
    expect(Math.abs(composerBox!.y - (targetBox!.y + (targetBox!.height / 2) + 12))).toBeLessThanOrEqual(1);
  });
}

test("a shell-owned nested composer follows coordinate spaces and preserves text through temporary target loss", async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto(`${HOST_ORIGIN}/nested-overlay.html`);
  const frame = page.frames().find((candidate) => candidate.url().includes("/nested-prototype.html"));
  expect(frame).toBeDefined();
  await expect.poll(() => page.evaluate(() => globalThis.nestedHostHarness.snapshot().state)).toBe("active");
  await frame!.evaluate(() => globalThis.nestedOverlayHarness.setMode("comment"));

  const sampleAttachment = async (targetSelector: string, scrollDelta: number, count: number) => {
    const samples: Array<{ x: number; y: number; coordinateSpace: string | null }> = [];
    for (let index = 0; index < count; index += 1) {
      await frame!.evaluate((delta) => {
        window.scrollBy({ top: delta });
        return new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }, scrollDelta);
      const [targetBox, composerBox, coordinateSpace] = await Promise.all([
        frame!.locator(targetSelector).boundingBox(),
        page.getByRole("dialog", { name: "Add review comment" }).boundingBox(),
        page.getByRole("dialog", { name: "Add review comment" }).getAttribute("data-coordinate-space"),
      ]);
      if (!targetBox || !composerBox) throw new Error("missing nested attachment sample");
      samples.push({
        x: composerBox.x - (targetBox.x + (targetBox.width / 2)),
        y: composerBox.y - (targetBox.y + (targetBox.height / 2)),
        coordinateSpace,
      });
    }
    return samples;
  };

  const normal = frame!.getByRole("button", { name: "Nested prototype action" });
  await normal.click();
  const normalSamples = await sampleAttachment("#prototype-action", 2, 8);
  expect(Math.max(...normalSamples.map(({ x }) => Math.abs(x - 12)))).toBeLessThanOrEqual(2);
  expect(Math.max(...normalSamples.map(({ y }) => Math.abs(y - 12)))).toBeLessThanOrEqual(2);
  expect(new Set(normalSamples.map(({ coordinateSpace }) => coordinateSpace))).toEqual(new Set(["document"]));
  await page.evaluate(() => globalThis.nestedHostHarness.setSidebar("open"));
  const responsiveSamples = await sampleAttachment("#prototype-action", 0, 18);
  expect(Math.max(...responsiveSamples.map(({ x }) => Math.abs(x - 12)))).toBeLessThanOrEqual(2);
  expect(Math.max(...responsiveSamples.map(({ y }) => Math.abs(y - 12)))).toBeLessThanOrEqual(2);
  await page.evaluate(() => globalThis.nestedHostHarness.setSidebar("closed"));
  await page.getByRole("textbox", { name: "Comment" }).press("Escape");

  await frame!.evaluate(() => globalThis.nestedOverlayHarness.scrollTo(350));
  expect(await page.evaluate(() => ({
    state: globalThis.nestedHostHarness.snapshot().state,
    errors: globalThis.nestedHostHarness.events
      .filter((event) => event.type === "error")
      .map((event) => ({ code: event.error?.code, message: event.error?.message })),
  }))).toEqual({ state: "active", errors: [] });
  const sticky = frame!.getByRole("button", { name: "Nested sticky action" });
  await sticky.click();
  await expect(page.getByRole("dialog", { name: "Add review comment" })).toHaveAttribute("data-coordinate-space", "document");
  const stickySamples = await sampleAttachment("[data-collab-review-id='nested-sticky-action']", 8, 28);
  expect(Math.max(...stickySamples.map(({ x }) => Math.abs(x - 12)))).toBeLessThanOrEqual(5);
  expect(Math.max(...stickySamples.map(({ y }) => Math.abs(y - 12)))).toBeLessThanOrEqual(5);
  expect(new Set(stickySamples.map(({ coordinateSpace }) => coordinateSpace))).toEqual(new Set(["document", "viewport"]));
  await page.getByRole("textbox", { name: "Comment" }).press("Escape");

  const fixed = frame!.getByRole("button", { name: "Nested fixed action" });
  await fixed.click();
  const fixedSamples = await sampleAttachment("#nested-fixed-action", 8, 8);
  expect(Math.max(...fixedSamples.map(({ x }) => Math.abs(x - 12)))).toBeLessThanOrEqual(2);
  expect(Math.max(...fixedSamples.map(({ y }) => Math.abs(y - 12)))).toBeLessThanOrEqual(2);
  expect(new Set(fixedSamples.map(({ coordinateSpace }) => coordinateSpace))).toEqual(new Set(["viewport"]));
  await page.getByRole("textbox", { name: "Comment" }).press("Escape");

  await frame!.evaluate(() => globalThis.nestedOverlayHarness.scrollTo(0));
  await normal.click();
  const recoveryComposer = page.getByRole("dialog", { name: "Add review comment" });
  const recoveryTextarea = recoveryComposer.getByRole("textbox", { name: "Comment" });
  await recoveryTextarea.fill("Preserved through temporary target loss");
  await frame!.evaluate(() => globalThis.nestedOverlayHarness.removeTarget("nested-action"));
  await expect.poll(() => page.evaluate(() => globalThis.nestedHostHarness.draftRequests.some((message) => {
    const attachment = message.attachment as { locationAvailability?: unknown } | undefined;
    return message.action === "update" && attachment?.locationAvailability === "unavailable";
  }))).toBe(true);
  await expect(recoveryComposer).toBeVisible();
  await expect(recoveryTextarea).toHaveValue("Preserved through temporary target loss");
  await expect(recoveryComposer.getByText("Comment location unavailable. Your draft is preserved.")).toBeVisible();
  expect(await frame!.evaluate(() => globalThis.nestedOverlayHarness.snapshot().composerOpen)).toBe(true);

  await frame!.evaluate(() => globalThis.nestedOverlayHarness.restoreTarget("nested-action"));
  await expect(recoveryComposer.getByText("Comment location unavailable. Your draft is preserved.")).toBeHidden();
  await expect(recoveryTextarea).toHaveValue("Preserved through temporary target loss");
  await expect(recoveryComposer.getByRole("button", { name: "Submit comment" })).toBeEnabled();
  await recoveryTextarea.press("Escape");
  await expect.poll(() => frame!.evaluate(() => globalThis.nestedOverlayHarness.snapshot().composerOpen)).toBe(false);

  await normal.click();
  await frame!.evaluate(() => globalThis.nestedOverlayHarness.removeTarget("nested-action"));
  await expect(page.getByRole("dialog", { name: "Add review comment" })).toHaveCount(0);
  await expect.poll(() => frame!.evaluate(() => globalThis.nestedOverlayHarness.snapshot().composerOpen)).toBe(false);
});

for (const device of [
  { name: "representative nested iPhone", viewport: { width: 390, height: 844 } },
  { name: "representative nested Android", viewport: { width: 412, height: 915 } },
]) {
  test(`${device.name} viewport keeps the package-owned composer private, in bounds, and keyboard operable`, async ({ page }) => {
    await page.setViewportSize(device.viewport);
    await page.goto(`${HOST_ORIGIN}/nested-overlay.html`);
    const frame = page.frames().find((candidate) => candidate.url().includes("/nested-prototype.html"));
    expect(frame).toBeDefined();
    await expect.poll(() => page.evaluate(() => globalThis.nestedHostHarness.snapshot().state)).toBe("active");
    await frame!.evaluate(() => globalThis.nestedOverlayHarness.setMode("comment"));
    const action = frame!.getByRole("button", { name: "Nested prototype action" });
    await action.click();
    const composer = page.getByRole("dialog", { name: "Add review comment" });
    await expect(composer).toBeVisible();
    const box = await composer.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(device.viewport.width);
    expect(box!.y + box!.height).toBeLessThanOrEqual(device.viewport.height);
    const textarea = page.getByRole("textbox", { name: "Comment" });
    await textarea.press("Escape");
    await expect(composer).toHaveCount(0);

    await action.click();
    await textarea.fill(`${device.name} feedback`);
    await textarea.press("Control+Enter");
    await expect(composer).toHaveCount(0);
    expect(await page.evaluate(() => globalThis.nestedHostHarness.draftSubmissions)).toHaveLength(1);
    expect(await frame!.evaluate(() => document.querySelector("textarea")?.value ?? null)).toBeNull();
  });
}

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
    setThread(input: { threadId: string; label: string; identity: string; offset: { x: number; y: number }; schemaVersion?: 2 | 3 }): unknown;
    setSidebar(state: "open" | "closed"): void;
    revealHiddenClip(): void;
    revealNestedClip(): void;
    refresh(): unknown;
  };
  var overlayHarness: {
    submissions: Array<{
      anchor: {
        element: {
          identity: string;
          selector: string;
          offset: { x: number; y: number };
        };
        document: { x: number; y: number; width: number; height: number };
      };
    }>;
    replacementRequests: unknown[];
    openedThreads: Array<{ threadId: string; attachment: unknown }>;
    attachmentChanges: unknown[];
    unavailableAnchors: Array<{ threadId: string; anchorGeneration: number }>;
    unavailableCallbackAttempts(): number;
    placementDiagnostics: unknown[];
    placementDiagnosticAttempts(): number;
    context: unknown;
    prototypeClicks(): number;
    unanchorableClicks(): number;
    prototypePressCounts(): { pointerdown: number; mousedown: number };
    prototypeTouchStarts(): number;
    prototypeKeyDowns(): number;
    snapshot(): unknown;
    setMode(mode: "pointer" | "comment"): unknown;
    setThreads(threads: unknown[]): unknown;
    beginAnchorReplacement(threadId: string): unknown;
    refresh(): unknown;
    measureRefreshOpenTreeScans(): number;
    rejectNextSubmissionAsynchronously(): void;
    rejectNextUnavailableAsynchronously(): void;
    rejectNextReplacementAsynchronously(): void;
    rejectNextOpenThreadAsynchronously(): void;
    rejectNextAttachmentAsynchronously(): void;
    rejectNextPlacementDiagnosticAsynchronously(): void;
    settleAsyncEvents(): Promise<void>;
    unhandledSubmissionRejections(): number;
    scrollOpenShadow(top: number): void;
    attachDynamicOpenShadow(): Promise<void>;
    scrollDynamicOpenShadow(top: number): void;
    attachLateShadowAroundActiveAnchor(): Promise<void>;
    scrollLateShadowAnchor(top: number): void;
    openShadowPopover(): void;
    openShadowModal(styled: boolean): Promise<void>;
    styleOpenShadowModal(): Promise<void>;
    tryMountSecondOverlay(): { accepted: boolean; errorName?: string; code?: string };
    addOpenShadowDuplicate(): void;
    growAbove(): void;
    moveTargetToEdge(): void;
    animateTarget(): void;
    animateTargetBeforeComposer(): Promise<void>;
    animateTargetCosmetically(): void;
    enableInteractionStateStyles(): void;
    animateUnrelatedSpinner(): void;
    moveLayoutSibling(): void;
    setTargetZoom(zoom: string): void;
    setAncestorZoom(zoom: string): void;
    failNextAttachmentChange(): void;
    failNextAttachmentChangeWithDocumentReentry(): void;
    resizeObserverOperations(): Array<{ type: string; target: string }>;
    flushResizeObserver(): void;
    shadowAttachmentObserverInstalled(): boolean;
    tryInvalidCallback(name: string): unknown;
    createCrossRealmModalOverlay(): Promise<{
      activeElement: string | null | undefined;
      rootParent: string | undefined;
      rootOpen: boolean | undefined;
    }>;
    transformBody(): void;
    temporarilyDetachTarget(): Promise<boolean>;
    removeTarget(): void;
    failNextUnavailable(): void;
    destroy(): void;
  };
  var nestedOverlayHarness: {
    unsafeDraftResult: { accepted: boolean; name?: string; code?: string };
    prototypeClicks(): number;
    snapshot(): { state: string; composerOpen: boolean };
    setMode(mode: "pointer" | "comment"): unknown;
    scrollTo(top: number): void;
    nudgeDraftTarget(): void;
    removeTarget(identity: string): void;
    restoreTarget(identity: string): void;
    rejectNextDraftEventAsynchronously(action: "open" | "update" | "dismiss"): void;
    settleAsyncEvents(): Promise<void>;
    unhandledDraftRejections(): number;
    moveDraftTargetBeyondBridgeLimit(): {
      error?: string;
      snapshot: { state: string; composerOpen: boolean };
      attempts: Array<Record<string, unknown>>;
    };
    retryUnavailableAfterFailure(): { firstError?: string; attempts: unknown[] };
    retryUnavailableAfterAsyncReturn(): { firstError?: string; attempts: unknown[] };
    retryDestroyAfterFailure(): {
      firstError?: string;
      afterFailure: { state: string; composerOpen: boolean };
      afterRetry: { state: string; composerOpen: boolean };
      attempts: unknown[];
    };
    retryDestroyAfterAsyncReturn(): {
      firstError?: string;
      afterFailure: { state: string; composerOpen: boolean };
      afterRetry: { state: string; composerOpen: boolean };
      attempts: unknown[];
    };
    reenterUnavailableUpdate(): number;
    reenterDismissal(): { state: string; attempts: number };
    recreate(): void;
    forgeNextDraftContext(): void;
    attachDynamicOpenShadow(): Promise<void>;
    scrollDynamicOpenShadow(top: number): void;
    reportDraftVisibility(visible: boolean): void;
    reportDraftUnavailable(): void;
    sendUnsolicitedDraftOpen(): Promise<void>;
    focusPrototypeLookalike(): void;
    dismissDraftFromPrototype(): void;
  };
  var overlayWithoutStylesResult: unknown;
  var overlayObserverFailureResult: unknown;
  var nestedHostHarness: {
    events: Array<{ type: string; error?: { code?: string; message?: string } }>;
    draftRequests: Array<Record<string, unknown>>;
    draftSubmissions: Array<Record<string, unknown>>;
    snapshot(): { state: string; sessionId?: string };
    send(message: unknown): void;
    setSidebar(state: "open" | "closed"): void;
    rejectNextDraftSubmissionAsynchronously(): void;
    settleAsyncEvents(): Promise<void>;
    unhandledDraftSubmissionRejections(): number;
    setModalState(state: "modal" | "nonmodal" | "closed"): void;
    moveContainerIntoClosedShadow(): void;
    reloadFrame(): void;
    sendDuplicateDraftOpen(): void;
    setDraftOpenFocusAction(action: "close" | "replace"): void;
    styleFrame(transform?: string, padding?: string): void;
    styleFrameScale(scale: string): void;
    raiseFrameStackingContext(): void;
    setFramePointerEvents(scope: "frame" | "ancestor"): void;
    roundFrameWithoutClipping(): void;
    setInertLegacyClip(scope: "frame" | "ancestor"): void;
    propagateBodyOverflow(): Promise<void>;
    obscureFrame(kind: "frame-visibility" | "frame-filter-opacity" | "ancestor-opacity" | "ancestor-filter-opacity" | "ancestor-clip" | "frame-legacy-clip" | "ancestor-legacy-clip"): void;
    roundFrameClip(): void;
    expandFrameClipMargin(): void;
    expandPaintContainmentClipMargin(): void;
    fixFrameOutsideUnrelatedClip(): void;
    positionAbsoluteFrameOutsideUnrelatedClip(): void;
    positionAbsoluteFrameThroughBoxlessAncestor(): void;
    removeShadowModalStyles(): void;
    promoteUnstyledShadowDialog(): void;
    promoteUnstyledShadowDialogWithFocusAction(action: "close" | "replace"): void;
    setDraftFocusReturnAction(action: "close" | "replace"): void;
    prepareDraftFocusReturnTrigger(): void;
    fixFrameAncestorOutsideUnrelatedClip(): void;
    roundUnrelatedFrameClip(): void;
    transformComposerHost(transform: string): void;
    styleComposerHost(property: string, value: string): void;
    styleComposer(property: string, value: string): void;
    nestFrameInTransformedSlot(transform: string): void;
  };
}
