import { defineConfig } from "vite";

// Browsers do not load module scripts from file: URLs, so the runtime builds as classic scripts.
export default defineConfig(({ mode }) => {
  const periods = mode === "periods";
  return {
    logLevel: "warn",
    build: {
      outDir: "assets/runtime",
      emptyOutDir: !periods,
      target: "es2020",
      rollupOptions: { treeshake: { moduleSideEffects: false } },
      lib: {
        entry: periods ? "runtime/periods.ts" : "runtime/main.ts",
        formats: ["iife"],
        name: periods ? "hatchmarkPeriods" : "hatchmark",
        fileName: () => (periods ? "hatchmark-periods.js" : "hatchmark.js"),
      },
    },
  };
});
