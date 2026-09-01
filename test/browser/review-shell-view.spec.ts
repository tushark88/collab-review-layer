import { expect, test, type Page } from "@playwright/test";

const HOST_ORIGIN = "http://127.0.0.1:4173";

async function loadShell(page: Page): Promise<void> {
  page.on("pageerror", (error) => console.error(`browser page error: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") console.error(`browser console error: ${message.text()}`);
  });
  await page.goto(`${HOST_ORIGIN}/shell.html`);
  await expect.poll(() => page.evaluate(() => Boolean(globalThis.shellHarness))).toBe(true);
}

interface RenderedViewportDimensions {
  readonly contentWidth: number;
  readonly contentHeight: number;
  readonly outerWidth: number;
  readonly outerHeight: number;
  readonly frameWidth: number | null;
  readonly frameHeight: number | null;
}

function contrastRatio(first: string, second: string): number {
  const luminance = (color: string): number => {
    const channels = color.match(/[\d.]+/g)?.slice(0, 3).map(Number);
    if (!channels || channels.length !== 3) throw new Error(`cannot parse CSS color: ${color}`);
    const [red, green, blue] = channels.map((channel) => {
      const normalized = channel / 255;
      return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
    });
    return (0.2126 * red!) + (0.7152 * green!) + (0.0722 * blue!);
  };
  const lighter = Math.max(luminance(first), luminance(second));
  const darker = Math.min(luminance(first), luminance(second));
  return (lighter + 0.05) / (darker + 0.05);
}

async function renderedViewportDimensions(page: Page): Promise<RenderedViewportDimensions> {
  return page.locator(".crl-shell__viewport-frame").evaluate((element) => {
    const frameRect = element.querySelector("iframe")?.getBoundingClientRect();
    return {
      contentWidth: element.clientWidth,
      contentHeight: element.clientHeight,
      outerWidth: element.getBoundingClientRect().width,
      outerHeight: element.getBoundingClientRect().height,
      frameWidth: frameRect?.width ?? null,
      frameHeight: frameRect?.height ?? null,
    };
  });
}

test.beforeEach(async ({ page }) => loadShell(page));

test("renders labelled native controls, scoped styles, visible focus, and touch-sized targets", async ({ page }) => {
  await expect(page.getByRole("region", { name: "Prototype review" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Prototype review", level: 2 })).toBeVisible();
  for (const name of ["Prototype", "Revision", "Variant", "Viewport"]) {
    await expect(page.getByRole("combobox", { name, exact: true })).toBeVisible();
  }
  await expect(page.getByRole("textbox", { name: "Route", exact: true })).toBeVisible();
  await expect(page.getByRole("group", { name: "Interaction mode" })).toBeVisible();
  await expect(page.getByRole("main")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Pointer" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "Comment" })).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByRole("region", { name: "Live prototype preview" })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Variant", exact: true }).locator("option")).toContainText([
    "Default",
    "Markup <img src=x> remains text",
  ]);
  await expect(page.locator("[data-collab-review-layer='shell'] img")).toHaveCount(0);

  const prototype = page.getByRole("combobox", { name: "Prototype", exact: true });
  const revision = page.getByRole("combobox", { name: "Revision", exact: true });
  const variant = page.getByRole("combobox", { name: "Variant", exact: true });
  const route = page.getByRole("textbox", { name: "Route", exact: true });
  const routeSubmit = page.getByRole("button", { name: "Go" });
  const viewport = page.getByRole("combobox", { name: "Viewport", exact: true });
  const pointer = page.getByRole("button", { name: "Pointer" });
  const comment = page.getByRole("button", { name: "Comment" });
  const scroller = page.getByRole("region", { name: "Scrollable prototype viewport" });
  for (const control of [prototype, revision, variant, route, routeSubmit, viewport, pointer, comment, scroller]) {
    await page.keyboard.press("Tab");
    await expect(control).toBeFocused();
  }

  await pointer.click();
  await expect(page.getByRole("status")).toHaveText("");
  expect(await page.evaluate(() => globalThis.shellHarness.changes)).toEqual([]);

  await prototype.focus();
  const visual = await prototype.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      focusColor: style.outlineColor,
      panelColor: getComputedStyle(element.closest(".crl-shell__header")!).backgroundColor,
      shellColor: getComputedStyle(element.closest(".crl-shell")!).backgroundColor,
      outlineOffset: style.outlineOffset,
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth,
      height: element.getBoundingClientRect().height,
    };
  });
  expect(visual.outlineStyle).not.toBe("none");
  expect(Number.parseFloat(visual.outlineWidth)).toBeGreaterThanOrEqual(3);
  expect(visual.outlineOffset).toBe("2px");
  expect(contrastRatio(visual.focusColor, visual.panelColor)).toBeGreaterThanOrEqual(3);
  expect(contrastRatio(visual.focusColor, visual.shellColor)).toBeGreaterThanOrEqual(3);
  expect(visual.height).toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(() => [...document.styleSheets].some((sheet) => sheet.href?.endsWith("/dist/review-shell.css")))).toBe(true);

  expect(await page.evaluate(() => globalThis.shellHarness.changes)).toEqual([]);
  expect(await page.evaluate(() => globalThis.shellHarness.snapshot())).toEqual(expect.objectContaining({
    state: "mounted",
    shell: expect.objectContaining({ prototypeId: "prototype-a", route: "/overview", interactionMode: "pointer" }),
  }));
});

test("keeps revision focus while resetting revision-owned route and variant", async ({ page }) => {
  const revision = page.getByRole("combobox", { name: "Revision", exact: true });
  await revision.focus();
  await revision.selectOption("revision-a2");
  await expect(revision).toBeFocused();
  await expect(page.getByRole("combobox", { name: "Prototype", exact: true })).toHaveValue("prototype-a");
  await expect(page.getByRole("combobox", { name: "Variant", exact: true })).toHaveValue("variant-a2-default");
  await expect(page.getByRole("textbox", { name: "Route", exact: true })).toHaveValue("/confirmation");
  await expect(page.getByRole("status")).toHaveText("Revision changed to Revision A2.");
  expect((await page.evaluate(() => globalThis.shellHarness.changes)).map((change) => change.action)).toEqual(["revision"]);
});

test("preserves focus while dependent selections, route, and interaction mode commit", async ({ page }) => {
  const prototype = page.getByRole("combobox", { name: "Prototype", exact: true });
  await prototype.focus();
  await prototype.selectOption("prototype-b");
  await expect(prototype).toBeFocused();
  await expect(page.getByRole("combobox", { name: "Revision", exact: true })).toHaveValue("revision-b1");
  await expect(page.getByRole("combobox", { name: "Variant", exact: true })).toHaveValue("variant-b1-default");
  await expect(page.getByRole("textbox", { name: "Route", exact: true })).toHaveValue("/dashboard");
  await expect(page.getByRole("status")).toHaveText(/Prototype changed to Account flow/u);

  const comment = page.getByRole("button", { name: "Comment" });
  await comment.focus();
  await comment.press("Enter");
  await expect(comment).toBeFocused();
  await expect(comment).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "Pointer" })).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByRole("status")).toHaveText("Comment mode selected.");

  const route = page.getByRole("textbox", { name: "Route", exact: true });
  await route.fill("/settings");
  await page.getByRole("button", { name: "Go" }).click();
  await expect(route).toHaveValue("/settings");
  await route.fill("https://attacker.invalid/");
  await page.getByRole("button", { name: "Go" }).click();
  await expect(route).toHaveAttribute("aria-invalid", "true");
  expect((await page.evaluate(() => globalThis.shellHarness.snapshot())).shell.route).toBe("/settings");

  await page.evaluate(() => globalThis.shellHarness.refresh());
  await expect(route).not.toHaveAttribute("aria-invalid");
  await expect(route).toHaveValue("/settings");

  const changes = await page.evaluate(() => globalThis.shellHarness.changes);
  expect(changes.map((change) => change.action)).toEqual(["prototype", "interaction-mode", "route"]);
  expect(changes.at(-1)?.bridgeRequests.navigation.route).toBe("/settings");
  const countBeforeRefresh = changes.length;
  await page.evaluate(() => globalThis.shellHarness.refresh());
  expect((await page.evaluate(() => globalThis.shellHarness.changes)).length).toBe(countBeforeRefresh);
});

test("applies custom dimensions atomically and keeps the preview internally scrollable", async ({ page }) => {
  expect(await renderedViewportDimensions(page)).toEqual({
    contentWidth: 1280,
    contentHeight: 720,
    outerWidth: 1282,
    outerHeight: 722,
    frameWidth: null,
    frameHeight: null,
  });
  await page.getByRole("combobox", { name: "Viewport", exact: true }).selectOption("custom");
  const width = page.getByLabel("Width", { exact: true });
  const height = page.getByLabel("Height", { exact: true });
  const pixelRatio = page.getByLabel("Pixel ratio", { exact: true });
  await expect(width).toBeVisible();

  const changeCount = (await page.evaluate(() => globalThis.shellHarness.changes)).length;
  await width.fill("0");
  await page.getByRole("button", { name: "Apply dimensions" }).click();
  expect((await page.evaluate(() => globalThis.shellHarness.changes)).length).toBe(changeCount);
  expect((await page.evaluate(() => globalThis.shellHarness.snapshot())).shell.viewport.width).toBe(640);

  await width.fill("412");
  await height.fill("915");
  await pixelRatio.fill("2.55");
  await page.getByRole("button", { name: "Apply dimensions" }).click();
  await expect(page.getByRole("status")).toHaveText(/412 by 915 CSS pixels at 2.55 pixel ratio/u);
  expect((await page.evaluate(() => globalThis.shellHarness.snapshot())).shell.viewport).toEqual(expect.objectContaining({
    id: "custom",
    width: 412,
    height: 915,
    devicePixelRatio: 2.55,
  }));
  expect(await renderedViewportDimensions(page)).toEqual({
    contentWidth: 412,
    contentHeight: 915,
    outerWidth: 414,
    outerHeight: 917,
    frameWidth: null,
    frameHeight: null,
  });

  await page.evaluate(() => globalThis.shellHarness.openFrame());
  await expect.poll(() => page.evaluate(() => globalThis.shellHarness.frameSnapshot().state)).toBe("active");
  expect(await renderedViewportDimensions(page)).toEqual({
    contentWidth: 412,
    contentHeight: 915,
    outerWidth: 414,
    outerHeight: 917,
    frameWidth: 412,
    frameHeight: 915,
  });
  await page.getByRole("combobox", { name: "Viewport", exact: true }).selectOption("mobile");
  expect(await renderedViewportDimensions(page)).toEqual({
    contentWidth: 390,
    contentHeight: 844,
    outerWidth: 402,
    outerHeight: 856,
    frameWidth: 390,
    frameHeight: 844,
  });
});

test("reflows shell chrome at 320 CSS pixels without styling consumer controls", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.evaluate(() => globalThis.shellHarness.setRootWidth(320));
  expect(await page.locator("#shell-root").evaluate((element) => ({ client: element.clientWidth, scroll: element.scrollWidth }))).toEqual({
    client: 320,
    scroll: 320,
  });
  const scroller = page.getByRole("region", { name: "Scrollable prototype viewport" });
  expect(await scroller.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);

  await page.evaluate(() => globalThis.shellHarness.setRootWidth());
  await page.setViewportSize({ width: 320, height: 800 });
  expect(await page.evaluate(() => ({ client: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }))).toEqual({
    client: 320,
    scroll: 320,
  });

  await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" });
  const mediaBehavior = await page.locator("[data-collab-review-layer='shell']").evaluate((shell) => {
    const hasPositiveDuration = (value: string): boolean => value.split(",").some((duration) => Number.parseFloat(duration) > 0);
    const moving = [shell, ...shell.querySelectorAll<HTMLElement>("*")]
      .filter((element) => {
        const style = getComputedStyle(element);
        return hasPositiveDuration(style.animationDuration) || hasPositiveDuration(style.transitionDuration);
      })
      .map((element) => element.className || element.tagName);
    return { reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches, moving };
  });
  expect(mediaBehavior).toEqual({ reducedMotion: true, moving: [] });
  const pointer = page.getByRole("button", { name: "Pointer" });
  await pointer.focus();
  expect(await pointer.evaluate((element) => Number.parseFloat(getComputedStyle(element).borderWidth))).toBeGreaterThanOrEqual(2);
  await expect(pointer.locator(".crl-shell__selection-mark")).toBeVisible();
  expect(await pointer.evaluate((element) => getComputedStyle(element).outlineStyle)).not.toBe("none");

  await page.emulateMedia({ forcedColors: "none", reducedMotion: "no-preference" });
  const previewAction = page.getByRole("button", { name: "Synthetic preview action" });
  await previewAction.focus();
  const matchingShellFocusRules = await previewAction.evaluate((element) => {
    return [...document.styleSheets].flatMap((sheet) => [...sheet.cssRules])
      .filter((rule): rule is CSSStyleRule => rule instanceof CSSStyleRule)
      .filter((rule) => rule.style.outline && element.matches(rule.selectorText))
      .map((rule) => rule.selectorText);
  });
  expect(matchingShellFocusRules).toEqual([]);
});

test("teardown removes only owned DOM and leaves the consumer preview detached", async ({ page }) => {
  await expect(page.evaluate(() => globalThis.shellHarness.mount())).rejects.toThrow(/only mount once/u);
  await page.evaluate(() => globalThis.shellHarness.destroy());
  expect(await page.evaluate(() => globalThis.shellHarness.snapshot().state)).toBe("destroyed");
  expect(await page.evaluate(() => globalThis.shellHarness.shellPresent())).toBe(false);
  expect(await page.evaluate(() => globalThis.shellHarness.previewDetached())).toBe(true);
  await expect(page.evaluate(() => globalThis.shellHarness.refresh())).rejects.toThrow(/not mounted/u);
});

declare global {
  var shellHarness: {
    changes: Array<{
      action: string;
      bridgeRequests: { navigation: { route: string } };
    }>;
    snapshot(): {
      state: string;
      shell: {
        prototypeId: string;
        route: string;
        interactionMode: string;
        viewport: { id: string; width: number; height: number; devicePixelRatio: number };
      };
    };
    mount(): unknown;
    refresh(): unknown;
    destroy(): void;
    openFrame(): unknown;
    frameSnapshot(): { state: string };
    setRootWidth(width?: number): void;
    previewDetached(): boolean;
    shellPresent(): boolean;
  };
}
