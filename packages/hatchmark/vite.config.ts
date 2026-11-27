import { defineConfig } from "vite";

/**
 * Builds the browser runtime (runtime/main.ts) into one small classic script, so pages work from
 * any static host and from file:// (module scripts do not load from file URLs). hatchmark build
 * copies it into <outDir>/_hatchmark/ under a content-hashed name.
 */
export default defineConfig({
  logLevel: "warn",
  build: {
    outDir: "assets/runtime",
    emptyOutDir: true,
    target: "es2020",
    lib: {
      entry: "runtime/main.ts",
      formats: ["iife"],
      name: "hatchmark",
      fileName: () => "hatchmark.js",
    },
  },
});
