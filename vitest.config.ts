import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "scripts/**/*.test.ts", "bench/test/**/*.test.ts"],
    globalSetup: ["packages/hatchmark/test/setup-runtime.ts"],
  },
});
