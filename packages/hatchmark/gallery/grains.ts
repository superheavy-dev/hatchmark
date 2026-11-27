import { grainLabels } from "../src/compiler/assemble.js";
import type {
  BarData,
  DateSpan,
  GrainSwitch,
  LineData,
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

/** One series' values per bucket of a grain over a window, summed from the daily values. */
function bucketed(
  window: DateSpan,
  grain: ResolvedGrain,
  share = 1,
): { buckets: string[]; values: Value[] } {
  const buckets = timeBuckets(window.start, window.end, grain);
  const values = buckets.map((start, i) => {
    const end = buckets[i + 1] ?? window.end;
    let sum = 0;
    for (const [date, v] of DAILY)
      if (date >= start && date < end && date >= window.start && date < window.end) sum += v;
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
        window,
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

export { MONTH, QUARTER, WEEK };
