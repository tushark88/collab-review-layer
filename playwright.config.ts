import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./test/browser",
  fullyParallel: false,
  workers: 1,
  timeout: 20_000,
  expect: { timeout: 5_000 },
  reporter: "line",
  use: {
    browserName: "chromium",
    headless: true,
  },
  webServer: {
    command: "node test/browser/server.mjs",
    url: "http://127.0.0.1:4173/health",
    reuseExistingServer: false,
    timeout: 10_000,
  },
});
