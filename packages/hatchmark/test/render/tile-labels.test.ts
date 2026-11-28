import { describe, expect, it } from "vitest";
import {
  colorValue,
  contrastRatio,
  DEFAULT_THEME,
  MAP_COLORS,
  onMapColor,
} from "../../src/render/theme.js";

const AA = 4.5;

function over(top: string, base: string, opacity: number): string {
  const channel = (hex: string, i: number) => Number.parseInt(hex.slice(i, i + 2), 16);
  return `#${[1, 3, 5]
    .map((i) =>
      Math.round(channel(top, i) * opacity + channel(base, i) * (1 - opacity))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

describe("tile map labels", () => {
  for (const mode of ["light", "dark"] as const) {
    it(`reach WCAG AA on every class fill in the ${mode} theme`, () => {
      const short = MAP_COLORS.filter((k) => k !== "land").flatMap((k) => {
        const fill = colorValue(DEFAULT_THEME, mode, k);
        const ratio = contrastRatio(fill, onMapColor(DEFAULT_THEME, mode, k));
        return ratio < AA ? [`${k} ${fill} ${ratio.toFixed(2)}`] : [];
      });
      expect(short).toEqual([]);
    });

    it(`reach WCAG AA on a no-data tile's crosshatch lines and land in the ${mode} theme`, () => {
      const { text, textSubtle, land } = DEFAULT_THEME.color[mode];
      const line = over(textSubtle, land, DEFAULT_THEME.noData.opacity[mode]);
      expect(contrastRatio(text, line)).toBeGreaterThanOrEqual(AA);
      expect(contrastRatio(text, land)).toBeGreaterThanOrEqual(AA);
    });
  }

  it("pick the higher-contrast text, dark on light fills and light on dark fills", () => {
    const light = DEFAULT_THEME.color.light.accentContrast;
    const dark = DEFAULT_THEME.color.dark.accentContrast;
    expect(onMapColor(DEFAULT_THEME, "light", "seq5-1")).toBe(dark);
    expect(onMapColor(DEFAULT_THEME, "light", "seq5-5")).toBe(light);
  });

  it("measures contrast as WCAG does", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#777777", "#ffffff")).toBeCloseTo(4.48, 2);
  });
});
