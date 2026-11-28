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

type Slot = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

/**
 * A colour a component may paint with: a chrome role, a categorical stroke slot c1..c8 (lines,
 * points, line keys, series-coloured text) or a categorical fill slot f1..f8 (bars, areas, slices,
 * square keys).
 */
export type ColorKey =
  | ChromeColor
  | `c${Slot}`
  | `f${Slot}`
  | `cg${number}-${number}`
  | `fg${number}-${number}`;

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
  categoricalFill?: Record<Mode, string[]>;
  /** Hue families a group of related series takes, in the order groups take them. */
  groups?: GroupTheme;
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

export interface GroupTheme {
  /** Dash pattern for a group's secondary members' lines, or null for lightness only. */
  dash: string | null;
  families: {
    name: string;
    /** Categorical slots of the same hue, which ungrouped series skip while a group holds the family. */
    slots: number[];
    /** Lightness steps, lead member first. */
    stroke: Record<Mode, string[]>;
    fill: Record<Mode, string[]>;
  }[];
}

interface GroupTokens {
  secondary: { dash: string | null };
  families: {
    name: string;
    slots: number[];
    light: { stroke: string[]; fill: string[] };
    dark: { stroke: string[]; fill: string[] };
  }[];
}

function groupTheme(tokens: GroupTokens | undefined): GroupTheme | undefined {
  if (tokens === undefined) return undefined;
  return {
    dash: tokens.secondary.dash,
    families: tokens.families.map((f) => ({
      name: f.name,
      slots: f.slots,
      stroke: { light: f.light.stroke, dark: f.dark.stroke },
      fill: { light: f.light.fill, dark: f.dark.fill },
    })),
  };
}

/** The Default theme, read from themes/default.json. */
export const DEFAULT_THEME: Theme = {
  id: defaultTokens.id,
  version: defaultTokens.version,
  font: { family: defaultTokens.font.sans.family, fallback: defaultTokens.font.sans.fallback },
  color: defaultTokens.color,
  categorical: {
    light: defaultTokens.data.light.categorical,
    dark: defaultTokens.data.dark.categorical,
  },
  categoricalFill: {
    light: defaultTokens.data.light.categoricalFill,
    dark: defaultTokens.data.dark.categoricalFill,
  },
  ...optionalGroups(groupTheme((defaultTokens.data as { groups?: GroupTokens }).groups)),
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

function optionalGroups(groups: GroupTheme | undefined): { groups?: GroupTheme } {
  return groups === undefined ? {} : { groups };
}

/** The colour a key resolves to in one mode. Series slots wrap after slot 8. */
export function colorValue(theme: Theme, mode: Mode, key: ColorKey): string {
  const group = /^([cf])g(\d+)-(\d+)$/.exec(key);
  if (group) {
    const family = theme.groups?.families[Number(group[2]) - 1];
    const steps = family?.[group[1] === "f" ? "fill" : "stroke"][mode] ?? [];
    return steps[Number(group[3]) - 1] ?? theme.color[mode].context;
  }
  if (/^[cf]\d$/.test(key)) {
    const palette = (
      key[0] === "f" ? (theme.categoricalFill ?? theme.categorical) : theme.categorical
    )[mode];
    return palette[(Number(key.slice(1)) - 1) % palette.length] as string;
  }
  return theme.color[mode][key as ChromeColor];
}

/** The categorical stroke slot of the series at index i (0-based): lines, points, line keys. */
export function seriesColor(i: number): ColorKey {
  return `c${(i % 8) + 1}` as ColorKey;
}

/** The categorical fill slot of the series at index i (0-based): bars, areas, slices, square keys. */
export function seriesFill(i: number): ColorKey {
  return `f${(i % 8) + 1}` as ColorKey;
}

/** The colours one series paints with, and whether it is a group's secondary member. */
export interface SeriesPaint {
  stroke: ColorKey;
  fill: ColorKey;
  secondary: boolean;
}

/**
 * Each series' colours. Without groups, series take the categorical slots in order, wrapping after
 * slot 8. A group takes the hue family at its index in theme.groups, and its members step through
 * the family's lightness in group order; ungrouped series then take the categorical slots in order,
 * skipping the slots of every family a group holds.
 */
export function seriesPaints(
  theme: Theme,
  series: readonly { group?: { index: number; step: number } }[],
): SeriesPaint[] {
  const families = theme.groups?.families ?? [];
  const familyOf = (s: { group?: { index: number } }) =>
    s.group === undefined ? undefined : families[s.group.index];
  if (!series.some((s) => familyOf(s) !== undefined)) {
    return series.map((_, k) => ({
      stroke: seriesColor(k),
      fill: seriesFill(k),
      secondary: false,
    }));
  }
  const held = new Set(series.flatMap((s) => familyOf(s)?.slots ?? []));
  const free = SLOTS.filter((slot) => !held.has(slot));
  const slots = free.length > 0 ? free : [...SLOTS];
  let next = 0;
  return series.map((s) => {
    const family = familyOf(s);
    if (family === undefined || s.group === undefined) {
      const slot = slots[next++ % slots.length] as Slot;
      return { stroke: `c${slot}`, fill: `f${slot}`, secondary: false };
    }
    const id = `g${s.group.index + 1}-${Math.min(s.group.step, family.stroke.light.length - 1) + 1}`;
    return {
      stroke: `c${id}` as ColorKey,
      fill: `f${id}` as ColorKey,
      secondary: s.group.step > 0,
    };
  });
}

/** Every group colour key a theme defines: each family's stroke and fill steps. */
export function groupColorKeys(theme: Theme): ColorKey[] {
  return (theme.groups?.families ?? []).flatMap((family, f) =>
    family.stroke.light.flatMap((_, s) => [
      `cg${f + 1}-${s + 1}` as ColorKey,
      `fg${f + 1}-${s + 1}` as ColorKey,
    ]),
  );
}

/** CSS custom property name of a colour key: cardAlt becomes --hm-card-alt. */
export function cssVar(key: ColorKey): string {
  return `--hm-${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
}

const SLOTS = [1, 2, 3, 4, 5, 6, 7, 8] as const;

/** Every colour key a component may use: chrome roles, then stroke slots, then fill slots. */
export const COLOR_KEYS: ColorKey[] = [
  ...CHROME_COLORS,
  ...SLOTS.map((i) => `c${i}` as const),
  ...SLOTS.map((i) => `f${i}` as const),
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
