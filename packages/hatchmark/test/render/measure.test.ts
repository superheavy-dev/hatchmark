import { describe, expect, it } from "vitest";
import { textWidth, truncateEnd, wrapLines } from "../../src/render/index.js";

describe("textWidth", () => {
  it("measures IBM Plex Sans advances with kerning, scaled by size", () => {
    expect(textWidth("0", { size: 10 })).toBe(6);
    expect(textWidth("AV", { size: 10 })).toBeLessThan(
      textWidth("A", { size: 10 }) + textWidth("V", { size: 10 }),
    );
    expect(textWidth("Revenue", { size: 24 })).toBeCloseTo(
      textWidth("Revenue", { size: 12 }) * 2,
      10,
    );
    expect(textWidth("Revenue", { size: 12, weight: 600 })).toBeGreaterThan(
      textWidth("Revenue", { size: 12 }),
    );
  });

  it("estimates characters outside the bundled subsets instead of failing", () => {
    expect(textWidth("東京", { size: 12 })).toBe(24);
  });
});

describe("truncateEnd", () => {
  const style = { size: 13 };
  it("keeps text that fits and cuts the end of text that does not", () => {
    expect(truncateEnd("Canada", 200, style)).toBe("Canada");
    const short = truncateEnd("Technical shells and insulated outerwear", 120, style);
    expect(short).toMatch(/^Technical.+\u2026$/);
    expect(textWidth(short, style)).toBeLessThanOrEqual(120);
    expect(truncateEnd("Outerwear", 5, style)).toBe("\u2026");
  });
});

describe("wrapLines", () => {
  const style = { size: 13 };
  it("wraps at spaces and cuts the end only when the lines run out", () => {
    expect(wrapLines("Base layers", 200, style, 2)).toEqual({ lines: ["Base layers"], cut: false });
    const two = wrapLines("Technical shells & outerwear", 120, style, 2);
    expect(two).toEqual({ lines: ["Technical shells &", "outerwear"], cut: false });
    const cut = wrapLines("Technical shells and insulated outerwear", 100, style, 2);
    expect(cut.cut).toBe(true);
    expect(cut.lines).toHaveLength(2);
    expect(cut.lines[1]).toMatch(/\u2026$/);
    for (const line of cut.lines) expect(textWidth(line, style)).toBeLessThanOrEqual(100);
  });
});
