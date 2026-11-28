import { defineConfig } from "vitest/config";

/** Tests that drive headless Chromium and WebKit through Playwright (pnpm test:browser, CI job browser). */
export default defineConfig({
  test: {
    include: ["packages/*/test/browser/**/*.browser.ts"],
    globalSetup: ["packages/hatchmark/test/setup-runtime.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
