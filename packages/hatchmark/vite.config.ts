import { defineConfig } from "vite";

/**
 * Builds the browser scripts into small classic scripts, so pages work from any static host and
 * from file:// (module scripts do not load from file URLs). hatchmark build copies them into
 * <outDir>/_hatchmark/ under content-hashed names.
 *
 * - runtime/main.ts (default mode): hatchmark.js, on every page.
 * - runtime/periods.ts (`vite build --mode periods`): hatchmark-periods.js, the period engine,
 *   which the runtime loads only when a reader picks another range.
 */
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
