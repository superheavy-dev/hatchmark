import defaultTokens from "./themes/default.json" with { type: "json" };

/** The colour roles a theme defines for each mode, as named in the tokens file. */
export const CHROME_COLORS = [
  "page",
  "card",
  "cardAlt",
  "border",
  "borderStrong",
  "grid",
  "baseline",
  "text",
  "textMuted",
  "textSubtle",
  "accent",
  "accentContrast",
  "good",
  "bad",
  "context",
  "focus",
] as const;
export type ChromeColor = (typeof CHROME_COLORS)[number];

/** A colour a component may paint with: a chrome role or a categorical series slot c1..c8. */
export type ColorKey = ChromeColor | `c${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8}`;

export type Mode = "light" | "dark";

export interface Density {
  tableRow: number;
  cardPadding: number;
  gap: number;
  page: number;
  kpiPadding: number;
  barRow: number;
  chartHeight: number;
  kpiSize: number;
  kpiLineHeight: number;
}

/** The parts of a hatchmark-tokens file the renderer reads. */
export interface Theme {
  id: string;
  version: string;
  font: { family: string; fallback: string };
  color: Record<Mode, Record<ChromeColor, string>>;
  categorical: Record<Mode, string[]>;
  density: Density;
  radius: { card: number; control: number; tooltip: number; bar: number };
  /** The partial-bucket treatment (RFC 0001 section 6.6, option B): hatch, hollow point, partial bars. */
  partial: {
    /** Hatch tile in px: 45° lines this far apart along x + y. */
    spacing: number;
    regionOpacity: Record<Mode, number>;
    areaHatchOpacity: number;
    barTint: number;
    barHatchOpacity: number;
    /** Stack parts shorter than this keep tint and outline and drop the hatch. */
    barHatchMin: number;
    pointRadius: number;
    pointRing: number;
  };
}

/** The Default theme (tokens v1.0.0 from HAT-8, exported from Paper). */
export const DEFAULT_THEME: Theme = {
  id: defaultTokens.id,
  version: defaultTokens.version,
  font: { family: defaultTokens.font.sans.family, fallback: defaultTokens.font.sans.fallback },
  color: defaultTokens.color,
  categorical: {
    light: defaultTokens.data.light.categorical,
    dark: defaultTokens.data.dark.categorical,
  },
  density: defaultTokens.density.compact,
  radius: defaultTokens.radius,
  partial: {
    spacing: defaultTokens.chart.partial.region.pattern.spacing,
    regionOpacity: defaultTokens.chart.partial.region.opacity,
    areaHatchOpacity: defaultTokens.chart.partial.area.patternOpacity.light,
    barTint: defaultTokens.chart.partial.bar.tint.opacity,
    barHatchOpacity: defaultTokens.chart.partial.bar.patternOpacity.light,
    barHatchMin: 6,
    pointRadius: defaultTokens.chart.partial.point.radius,
    pointRing: defaultTokens.chart.partial.point.ring,
  },
};

/** The colour a key resolves to in one mode. Series slots wrap after c8. */
export function colorValue(theme: Theme, mode: Mode, key: ColorKey): string {
  if (key.startsWith("c") && /^c\d$/.test(key)) {
    const palette = theme.categorical[mode];
    return palette[(Number(key.slice(1)) - 1) % palette.length] as string;
  }
  return theme.color[mode][key as ChromeColor];
}

/** The categorical slot of the series at index i (0-based). */
export function seriesColor(i: number): ColorKey {
  return `c${(i % 8) + 1}` as ColorKey;
}

/** CSS custom property name of a colour key: cardAlt becomes --hm-card-alt. */
export function cssVar(key: ColorKey): string {
  return `--hm-${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
}

/** Every colour key a component may use, chrome roles first. */
export const COLOR_KEYS: ColorKey[] = [
  ...CHROME_COLORS,
  ...([1, 2, 3, 4, 5, 6, 7, 8] as const).map((i) => `c${i}` as const),
];

/**
 * How SVG elements get their colours. In a page, CSS classes point at custom properties so light,
 * dark and the data-theme override work without re-rendering. A standalone SVG bakes hex literals,
 * which rasterisers such as resvg understand.
 */
export interface Paint {
  /** Attribute text for an element: fill and stroke keys, "none", or nothing. */
  attrs(fill?: ColorKey | "none", stroke?: ColorKey, className?: string): string;
  /** The mode a standalone SVG is baked for; a page leaves it to CSS. */
  mode?: Mode;
}

export const cssPaint: Paint = {
  attrs(fill, stroke, className) {
    const classes = [
      ...(className ? [className] : []),
      ...(fill && fill !== "none" ? [`hm-f-${fill}`] : []),
      ...(stroke ? [`hm-s-${stroke}`] : []),
    ];
    return `${fill === "none" ? ' fill="none"' : ""}${classes.length > 0 ? ` class="${classes.join(" ")}"` : ""}`;
  },
};

export function hexPaint(theme: Theme, mode: Mode): Paint {
  return {
    mode,
    attrs(fill, stroke, className) {
      return [
        className ? ` class="${className}"` : "",
        fill ? ` fill="${fill === "none" ? "none" : colorValue(theme, mode, fill)}"` : "",
        stroke ? ` stroke="${colorValue(theme, mode, stroke)}"` : "",
      ].join("");
    },
  };
}
