import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("published package", () => {
  it("ships the diagnostics format reference", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as {
      files: string[];
    };
    expect(manifest.files).toContain("docs");
    const doc = readFileSync(new URL("../../docs/diagnostics.md", import.meta.url), "utf8");
    expect(doc).toContain('format_version "1"');
  });
});
