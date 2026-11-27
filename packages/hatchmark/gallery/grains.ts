import { grainLabels } from "../src/compiler/assemble.js";
import type {
  BarData,
  DateSpan,
  GrainSwitch,
  LineData,
  PartialBucket,
  Series,
  Value,
} from "../src/compiler/dashboard-data.js";
import { timeBuckets } from "../src/compiler/windows.js";
import { grainKey, type ResolvedGrain } from "../src/spec/index.js";
import { MONTHLY_REVENUE, MONTHS, REGIONS, round, series, span } from "./fixtures.js";

/**
 * Grain-switch samples: Northwind's monthly revenue spread over days (weekday shape plus seeded
 * noise, each month adding up to its MONTHLY_REVENUE total), then summed into week, month, quarter
 * and year buckets with the engine's own bucket spine, the way the engine builds every grain ahead.
 */

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

const noise = random(20261128);
const WEEKDAY = [0.94, 1.01, 1.03, 1.04, 1.08, 1.0, 0.9];
const DAY = 86_400_000;

/** Daily revenue from 2024-11-01 through 2026-10-31, by date. */
const DAILY = new Map<string, number>();
MONTHS.forEach((month, i) => {
  const start = Date.parse(month);
  const end = Date.parse(MONTHS[i + 1] ?? "2026-11-01");
  const days: { date: string; weight: number }[] = [];
  for (let t = start; t < end; t += DAY) {
    const weekday = (new Date(t).getUTCDay() + 6) % 7;
    days.push({
      date: new Date(t).toISOString().slice(0, 10),
      weight: (WEEKDAY[weekday] as number) * (0.85 + noise() * 0.3),
    });
  }
  const total = days.reduce((s, d) => s + d.weight, 0);
  for (const d of days) DAILY.set(d.date, ((MONTHLY_REVENUE[i] as number) * d.weight) / total);
});

/**
 * One series' values per bucket of a grain over a window, summed from the daily values. The window
 * starts at its first bucket, as edges "snap" (the default) does; clip keeps the window's own start.
 */
function bucketed(
  window: DateSpan,
  grain: ResolvedGrain,
  share = 1,
  clip = false,
): { buckets: string[]; values: Value[] } {
  const buckets = timeBuckets(window.start, window.end, grain);
  const from = clip ? window.start : (buckets[0] ?? window.start);
  const values = buckets.map((start, i) => {
    const end = buckets[i + 1] ?? window.end;
    let sum = 0;
    for (const [date, v] of DAILY)
      if (date >= start && date < end && date >= from && date < window.end) sum += v;
    return round(sum * share);
  });
  return { buckets, values };
}

/** A GrainSwitch over the given grains, with series made by `make` from each grain's buckets. */
function grainSwitch(
  window: DateSpan,
  grains: ResolvedGrain[],
  selected: ResolvedGrain,
  make: (grain: ResolvedGrain) => Series[],
): GrainSwitch {
  const labels = grainLabels(grains);
  return {
    selected: grainKey(selected),
    options: grains.map((grain, i) => ({
      key: grainKey(grain),
      label: labels[i] ?? grain.unit,
      axis: {
        kind: "time",
        grain: grain.unit,
        buckets: timeBuckets(window.start, window.end, grain),
        window: {
          ...window,
          start: timeBuckets(window.start, window.end, grain)[0] ?? window.start,
        },
      },
      series: make(grain),
    })),
  };
}

/** The block with its selected grain's axis and series at the top level, like the engine writes it. */
function withGrains<T extends LineData | BarData>(
  block: Omit<T, "axis" | "series">,
  grains: GrainSwitch,
): T {
  const shown = grains.options.find((o) => o.key === grains.selected) ?? grains.options[0];
  if (shown === undefined) throw new Error("no grain options");
  return { ...block, axis: shown.axis, series: shown.series, grains } as T;
}

const WEEK: ResolvedGrain = { unit: "week", anchor: "monday" };
const MONTH: ResolvedGrain = { unit: "month" };
const QUARTER: ResolvedGrain = { unit: "quarter", anchor: "01-01" };
const RETAIL_QUARTER: ResolvedGrain = { unit: "quarter", anchor: "02-01" };

/** Four complete calendar quarters, and seven, so quarter buckets are whole at both edges. */
const LAST_4Q = span("2025-10-01", "2026-10-01");
const LAST_7Q = span("2025-01-01", "2026-10-01");
/** Six complete retail quarters starting on February 1. */
const RETAIL = span("2025-02-01", "2026-08-01");

const revenue = (window: DateSpan) => (grain: ResolvedGrain) => [
  series("revenue", "Revenue", bucketed(window, grain).values),
];

/** Revenue over the last 12 months, switchable by week, month and quarter. */
export function revenueSwitch(selected: ResolvedGrain): LineData {
  return withGrains<LineData>(
    {
      type: "line",
      id: `revenue_switch_${selected.unit}`,
      title: "Revenue peaked in the holiday quarter",
      span: 8,
    },
    grainSwitch(LAST_4Q, [WEEK, MONTH, QUARTER], selected, revenue(LAST_4Q)),
  );
}

/** Revenue by region, split, switchable by month and quarter. */
export const REGION_SWITCH: LineData = withGrains<LineData>(
  {
    type: "line",
    id: "region_switch",
    title: "Asia-Pacific grows fastest at every grain",
    span: 12,
  },
  grainSwitch(LAST_7Q, [MONTH, QUARTER], QUARTER, (grain) =>
    REGIONS.map((region, k) =>
      series(
        "revenue",
        region.name,
        bucketed(LAST_7Q, grain, region.share * (k === 2 ? 1.04 : 0.99)).values,
        region.name,
      ),
    ),
  ),
);

/** Revenue as time bars, by quarter or by month. */
export const QUARTER_BARS: BarData = withGrains<BarData>(
  {
    type: "bar",
    id: "revenue_bars",
    title: "Every quarter beat the one a year before",
    span: 6,
    orientation: "vertical",
    stack: false,
  },
  grainSwitch(LAST_7Q, [QUARTER, MONTH], QUARTER, revenue(LAST_7Q)),
);

/** Calendar and retail (February) quarters side by side: two options of one unit carry their anchors. */
export const FISCAL_BARS: BarData = withGrains<BarData>(
  {
    type: "bar",
    id: "fiscal_bars",
    title: "Revenue by calendar or retail quarter",
    span: 6,
    orientation: "vertical",
    stack: false,
  },
  grainSwitch(RETAIL, [QUARTER, RETAIL_QUARTER], RETAIL_QUARTER, revenue(RETAIL)),
);

/**
 * The third quarter with data through Wednesday, Sep 23, 2026, the way the engine writes a series
 * whose horizon cuts its last bucket (RFC 0001 section 6.5): by week (Sep 21 is 3 of 7 days in) or
 * by month (September is 23 of 30). edges "clip" keeps the Jul 1 start, so the first week (Jun 29)
 * is 5 of 7 days in; incomplete "hide" leaves the partial buckets out.
 */
const Q3_TO_SEP_23 = span("2026-07-01", "2026-09-24");

function incompleteSeries(
  grain: ResolvedGrain,
  options: { clip?: boolean; hide?: boolean },
): { axis: LineData["axis"]; series: Series[] } {
  const { buckets, values } = bucketed(Q3_TO_SEP_23, grain, 1, options.clip);
  const last = buckets.length - 1;
  const partial: PartialBucket[] = [
    ...(options.clip && buckets[0] !== Q3_TO_SEP_23.start
      ? [{ index: 0, elapsed: grain.unit === "week" ? 0.714285 : 1, edge: "start" as const }]
      : []),
    { index: last, elapsed: grain.unit === "week" ? 0.428571 : 0.766666 },
  ];
  const window = options.clip
    ? Q3_TO_SEP_23
    : { ...Q3_TO_SEP_23, start: buckets[0] ?? Q3_TO_SEP_23.start };
  if (!options.hide) {
    return {
      axis: { kind: "time", grain: grain.unit, buckets, window },
      series: [{ ...series("revenue", "Revenue", values), partial }],
    };
  }
  const keep = buckets.map((_, i) => !partial.some((p) => p.index === i));
  const kept = buckets.filter((_, i) => keep[i]);
  const shown = { start: kept[0] ?? window.start, end: buckets[last] ?? window.end };
  return {
    axis: { kind: "time", grain: grain.unit, buckets: kept, window: shown },
    series: [
      series(
        "revenue",
        "Revenue",
        values.filter((_, i) => keep[i]),
      ),
    ],
  };
}

/** Weekly revenue lines (or an area) over the partial third quarter: marked (default), clipped, or hidden. */
export function incompleteLine(
  id: string,
  title: string,
  options: { clip?: boolean; hide?: boolean; area?: boolean },
): LineData {
  return {
    type: options.area ? "area" : "line",
    id,
    title,
    span: 6,
    ...incompleteSeries(WEEK, options),
  };
}

/** Monthly revenue bars over the partial third quarter, September marked or hidden. */
export function incompleteBars(id: string, title: string, options: { hide?: boolean }): BarData {
  return {
    type: "bar",
    id,
    title,
    span: 6,
    orientation: "vertical",
    stack: false,
    ...incompleteSeries(MONTH, options),
  };
}

/** The same months split by channel, each part carrying the partial September. */
export function incompleteChannelBars(id: string, title: string): BarData {
  const {
    axis,
    series: [total],
  } = incompleteSeries(MONTH, {}) as {
    axis: LineData["axis"];
    series: [Series];
  };
  const channels: [string, number][] = [
    ["Online store", 0.58],
    ["Marketplaces", 0.3],
    ["Retail partners", 0.12],
  ];
  return {
    type: "bar",
    id,
    title,
    span: 6,
    orientation: "vertical",
    stack: true,
    axis,
    series: channels.map(([name, share]) => ({
      ...series(
        "revenue",
        name,
        total.values.map((v) => (v === null ? null : Math.round(v * share))),
        name,
      ),
      ...(total.partial ? { partial: total.partial } : {}),
    })),
  };
}

export { MONTH, QUARTER, WEEK };
