import { describe, expect, it } from "vitest";
import { textWidth, truncateMiddle } from "../../src/render/index.js";

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

describe("truncateMiddle", () => {
  const style = { size: 13 };
  it("keeps text that fits and shortens the middle of text that does not", () => {
    expect(truncateMiddle("Canada", 200, style)).toBe("Canada");
    const short = truncateMiddle("Technical shells and insulated outerwear", 120, style);
    expect(short).toMatch(/^Techn.+\u2026.+wear$/);
    expect(textWidth(short, style)).toBeLessThanOrEqual(120);
    expect(truncateMiddle("Outerwear", 5, style)).toBe("\u2026");
  });
});
