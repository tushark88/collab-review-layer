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

test.beforeEach(async ({ page }) => loadShell(page));

test("renders labelled native controls, scoped styles, visible focus, and touch-sized targets", async ({ page }) => {
  await expect(page.getByRole("region", { name: "Prototype review" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Prototype review" })).toBeVisible();
  for (const name of ["Prototype", "Revision", "Variant", "Viewport"]) {
    await expect(page.getByRole("combobox", { name, exact: true })).toBeVisible();
  }
  await expect(page.getByRole("textbox", { name: "Route", exact: true })).toBeVisible();
  await expect(page.getByRole("group", { name: "Interaction mode" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Pointer" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "Comment" })).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByRole("region", { name: "Live prototype preview" })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Variant", exact: true }).locator("option")).toContainText([
    "Default",
    "Markup <img src=x> remains text",
  ]);
  await expect(page.locator("[data-collab-review-layer='shell'] img")).toHaveCount(0);

  const prototype = page.getByRole("combobox", { name: "Prototype", exact: true });
  await prototype.focus();
  const visual = await prototype.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      outlineOffset: style.outlineOffset,
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth,
      height: element.getBoundingClientRect().height,
    };
  });
  expect(visual.outlineStyle).not.toBe("none");
  expect(Number.parseFloat(visual.outlineWidth)).toBeGreaterThanOrEqual(3);
  expect(visual.outlineOffset).toBe("2px");
  expect(visual.height).toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(() => [...document.styleSheets].some((sheet) => sheet.href?.endsWith("/dist/review-shell.css")))).toBe(true);

  expect(await page.evaluate(() => globalThis.shellHarness.changes)).toEqual([]);
  expect(await page.evaluate(() => globalThis.shellHarness.snapshot())).toEqual(expect.objectContaining({
    state: "mounted",
    shell: expect.objectContaining({ prototypeId: "prototype-a", route: "/overview", interactionMode: "pointer" }),
  }));
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

  const changes = await page.evaluate(() => globalThis.shellHarness.changes);
  expect(changes.map((change) => change.action)).toEqual(["prototype", "interaction-mode", "route"]);
  expect(changes.at(-1)?.bridgeRequests.navigation.route).toBe("/settings");
  const countBeforeRefresh = changes.length;
  await page.evaluate(() => globalThis.shellHarness.refresh());
  expect((await page.evaluate(() => globalThis.shellHarness.changes)).length).toBe(countBeforeRefresh);
});

test("applies custom dimensions atomically and keeps the preview internally scrollable", async ({ page }) => {
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

  await page.evaluate(() => globalThis.shellHarness.openFrame());
  await expect.poll(() => page.evaluate(() => globalThis.shellHarness.frameSnapshot().state)).toBe("active");
  await page.getByRole("combobox", { name: "Viewport", exact: true }).selectOption("mobile");
  const dimensions = await page.locator(".crl-shell__viewport-frame").evaluate((element) => {
    const frame = element.querySelector("iframe");
    if (!frame) throw new Error("hosted prototype frame is missing");
    const frameRect = frame.getBoundingClientRect();
    return {
      contentWidth: element.clientWidth,
      contentHeight: element.clientHeight,
      outerWidth: element.getBoundingClientRect().width,
      outerHeight: element.getBoundingClientRect().height,
      frameWidth: frameRect.width,
      frameHeight: frameRect.height,
    };
  });
  expect(dimensions).toEqual({
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

  await page.emulateMedia({ forcedColors: "active" });
  await page.getByRole("button", { name: "Comment" }).focus();
  expect(await page.getByRole("button", { name: "Comment" }).evaluate((element) => getComputedStyle(element).outlineStyle)).not.toBe("none");

  await page.emulateMedia({ forcedColors: "none" });
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
