import { defineConfig } from "vitest/config";

/** Tests that drive headless Chromium through Playwright (pnpm test:browser). */
export default defineConfig({
  test: {
    include: ["packages/*/test/browser/**/*.browser.ts"],
    globalSetup: ["packages/hatchmark/test/setup-runtime.ts"],
    testTimeout: 60_000,
  },
});
