import type { HeightPreset } from "../spec/layout.js";
import defaultTokens from "./themes/default.json" with { type: "json" };

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

export type ColorKey =
  | ChromeColor
  | `c${Slot}`
  | `f${Slot}`
  | `cg${number}-${number}`
  | `fg${number}-${number}`
  | MapColor;

type ClassIndex = 1 | 2 | 3 | 4 | 5 | 6 | 7;

/**
 * A colour only maps paint with: land under regions without data, and the fill of class k (1 for
 * the lowest) of a classed map scale with n classes, sequential for 3 to 7 classes and diverging
 * around a midpoint for 4 to 7.
 */
export type MapColor =
  | "land"
  | `seq${3 | 4 | 5 | 6 | 7}-${ClassIndex}`
  | `div${4 | 5 | 6 | 7}-${ClassIndex}`;

/** Every map colour: land, then the class colours in the order the theme lists them. */
export const MAP_COLORS: MapColor[] = [
  "land",
  ...([3, 4, 5, 6, 7] as const).flatMap((n) =>
    Array.from({ length: n }, (_, k) => `seq${n}-${k + 1}` as MapColor),
  ),
  ...([4, 5, 6, 7] as const).flatMap((n) =>
    Array.from({ length: n }, (_, k) => `div${n}-${k + 1}` as MapColor),
  ),
];

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

export type Device = "desktop" | "phone";

export interface BlockHeight {
  chart: number;
  pie: number;
  kpiSize: number;
  kpiLineHeight: number;
  sparkline: number;
  tableRows: number;
  barRow: number;
  barRowMax: number;
}

export interface Theme {
  id: string;
  version: string;
  font: { family: string; fallback: string };
  color: Record<Mode, Record<ChromeColor | "land", string>>;
  categorical: Record<Mode, string[]>;
  categoricalFill?: Record<Mode, string[]>;
  groups?: GroupTheme;
  /** Classed map fills by number of classes, lowest class first. */
  mapClasses: Record<
    Mode,
    { sequential: Record<string, string[]>; diverging: Record<string, string[]> }
  >;
  /** The no-data crosshatch on land: tile size in px, line width and line opacity per mode. */
  noData: { spacing: number; strokeWidth: number; opacity: Record<Mode, number> };
  /** Leader lines to labels for regions too small to label in place, in px. */
  leader: { size: number; lineWidth: number; dot: number; gap: number };
  /** Region borders and inset frames, in px at any scale. */
  map: { regionStroke: number; insetStroke: number };
  density: Density;
  height: Record<HeightPreset, Record<Device, BlockHeight>>;
  radius: { card: number; control: number; tooltip: number; bar: number };
  /** The partial-bucket treatment (RFC 0001 section 6.6, option B): hatch, hollow point, partial bars. */
  partial: {
    spacing: number;
    regionOpacity: Record<Mode, number>;
    areaHatchOpacity: number;
    barTint: number;
    barHatchOpacity: number;
    barHatchMin: number;
    pointRadius: number;
    pointRing: number;
  };
}

export interface GroupTheme {
  dash: string | null;
  families: {
    name: string;
    slots: number[];
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
  ...optionalGroups(groupTheme(defaultTokens.data.groups)),
  mapClasses: {
    light: {
      sequential: defaultTokens.data.light.sequentialClasses,
      diverging: defaultTokens.data.light.divergingClasses,
    },
    dark: {
      sequential: defaultTokens.data.dark.sequentialClasses,
      diverging: defaultTokens.data.dark.divergingClasses,
    },
  },
  noData: {
    spacing: defaultTokens.map.noData.light.spacing,
    strokeWidth: defaultTokens.map.noData.light.strokeWidth,
    opacity: {
      light: defaultTokens.map.noData.light.opacity,
      dark: defaultTokens.map.noData.dark.opacity,
    },
  },
  leader: {
    size: defaultTokens.map.leader.size,
    lineWidth: defaultTokens.map.leader.lineWidth,
    dot: defaultTokens.map.leader.dot,
    gap: defaultTokens.map.leader.gap,
  },
  map: {
    regionStroke: defaultTokens.map.regionStroke.width,
    insetStroke: defaultTokens.map.inset.width,
  },
  density: defaultTokens.density.compact,
  height: {
    compact: defaultTokens.blockHeight.compact,
    default: defaultTokens.blockHeight.default,
    tall: defaultTokens.blockHeight.tall,
  },
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

export function colorValue(theme: Theme, mode: Mode, key: ColorKey): string {
  const group = /^([cf])g(\d+)-(\d+)$/.exec(key);
  if (group) {
    const family = theme.groups?.families[Number(group[2]) - 1];
    const steps = family?.[group[1] === "f" ? "fill" : "stroke"][mode] ?? [];
    return steps[Number(group[3]) - 1] ?? theme.color[mode].context;
  }
  const map = /^(seq|div)(\d)-(\d)$/.exec(key);
  if (map) {
    const classes = theme.mapClasses[mode][map[1] === "seq" ? "sequential" : "diverging"];
    return classes[map[2] as string]?.[Number(map[3]) - 1] as string;
  }
  if (/^[cf]\d$/.test(key)) {
    const palette = (
      key[0] === "f" ? (theme.categoricalFill ?? theme.categorical) : theme.categorical
    )[mode];
    return palette[(Number(key.slice(1)) - 1) % palette.length] as string;
  }
  return theme.color[mode][key as ChromeColor | "land"];
}

export function seriesColor(i: number): ColorKey {
  return `c${(i % 8) + 1}` as ColorKey;
}

export function seriesFill(i: number): ColorKey {
  return `f${(i % 8) + 1}` as ColorKey;
}

export interface SeriesPaint {
  stroke: ColorKey;
  fill: ColorKey;
  secondary: boolean;
}

export function seriesPaints(
  theme: Theme,
  series: readonly {
    key?: string;
    label?: string;
    splitValue?: unknown;
    group?: { index: number; step: number };
    colorRank?: number;
  }[],
  declaredGroups = 0,
): SeriesPaint[] {
  const families = theme.groups?.families ?? [];
  const held = Math.min(
    families.length,
    Math.max(declaredGroups, ...series.map((s) => (s.group === undefined ? 0 : s.group.index + 1))),
  );
  if (held === 0) {
    return series.map((_, k) => ({
      stroke: seriesColor(k),
      fill: seriesFill(k),
      secondary: false,
    }));
  }
  const taken = new Set(families.slice(0, held).flatMap((f) => f.slots));
  const free = SLOTS.filter((slot) => !taken.has(slot));
  const slots = free.length > 0 ? free : [...SLOTS];
  const ungrouped = series
    .map((s, k) => ({ s, k }))
    .filter(({ s }) => s.group === undefined || s.group.index >= held);
  const slotOf = new Map(
    ungrouped.map(({ s, k }, i) => [k, slots[(s.colorRank ?? i) % slots.length] as Slot]),
  );
  return series.map((s, k) => {
    const family = s.group === undefined ? undefined : families[s.group.index];
    if (family === undefined || s.group === undefined || s.group.index >= held) {
      const slot = slotOf.get(k) as Slot;
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

export function groupColorKeys(theme: Theme): ColorKey[] {
  return (theme.groups?.families ?? []).flatMap((family, f) =>
    family.stroke.light.flatMap((_, s) => [
      `cg${f + 1}-${s + 1}` as ColorKey,
      `fg${f + 1}-${s + 1}` as ColorKey,
    ]),
  );
}

export function cssVar(key: ColorKey): string {
  return `--hm-${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
}

const SLOTS = [1, 2, 3, 4, 5, 6, 7, 8] as const;

export const COLOR_KEYS: ColorKey[] = [
  ...CHROME_COLORS,
  ...SLOTS.map((i) => `c${i}` as const),
  ...SLOTS.map((i) => `f${i}` as const),
];

// Rasterisers such as resvg do not read CSS custom properties, so a standalone SVG bakes hex
// literals.
export interface Paint {
  attrs(fill?: ColorKey | "none", stroke?: ColorKey, className?: string): string;
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
