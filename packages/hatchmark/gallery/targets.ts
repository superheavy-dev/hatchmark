import type {
  BarData,
  KpiData,
  LineData,
  Series,
  SeriesTarget,
  Value,
} from "../src/compiler/dashboard-data.js";
import {
  CHANNELS,
  COUNTRY_BAR,
  dashboard,
  kpi,
  MONTHLY_REVENUE,
  monthAxis,
  REGION_LINE,
  REVENUE_LINE,
  round,
} from "./fixtures.js";
import { incompleteBars, incompleteLine } from "./grains.js";
import type { GalleryVariant } from "./variants.js";

const PLAN = { id: "plan", label: "FY plan", metric: "revenue" };

const planned = (values: readonly Value[], lift = 1.04) =>
  values.map((v, i) =>
    typeof v === "number" ? round(v * lift * (1 + 0.035 * Math.sin(i * 1.3))) : null,
  );

const attained = (actual: readonly Value[], target: SeriesTarget): Value[] =>
  target.values.map((t, i) => {
    const against = target.pace?.[i] ?? t;
    const v = actual[i];
    return typeof v === "number" && typeof against === "number" && against > 0 ? v / against : null;
  });

const withTarget = (s: Series, target: SeriesTarget): Series => ({
  ...s,
  target: { ...target, attainment: attained(s.values, target) },
});

const totalTarget = (actual: readonly Value[], values: Value[]) => ({
  ...PLAN,
  values,
  attainment: attained(actual, { values }),
});

function wholeBuckets(s: Series): Value[] {
  return s.values.map((v, i) => {
    const p = s.partial?.find((q) => q.index === i);
    return p && typeof v === "number" ? v / p.elapsed : v;
  });
}

function paced(values: readonly Value[], partial: Series["partial"]): Value[] {
  return values.map((v, i) => {
    const p = partial?.find((q) => q.index === i);
    return p && typeof v === "number" ? round(v * p.elapsed) : null;
  });
}

const one = (
  component: GalleryVariant["component"],
  variant: string,
  title: string,
  ...blocks: GalleryVariantBlocks
): GalleryVariant => ({
  component,
  variant,
  title,
  data: dashboard(variant, title, blocks),
});

type GalleryVariantBlocks = GalleryVariant["data"]["blocks"];

const revenueSeries = REVENUE_LINE.series[0] as Series;
const lineTarget = planned(revenueSeries.values);

const TARGET_LINE: LineData = {
  ...REVENUE_LINE,
  id: "revenue_vs_plan",
  title: "Revenue ran ahead of the FY plan through the holidays",
  series: [withTarget(revenueSeries, { values: lineTarget })],
  target: PLAN,
};

const TARGET_AREA: LineData = {
  ...TARGET_LINE,
  id: "revenue_vs_plan_area",
  type: "area",
  title: "Revenue against the FY plan, as an area",
};

const gaps = lineTarget.map((v, i) => (i < 6 || i === 15 ? null : v));
const TARGET_GAPS: LineData = {
  ...TARGET_LINE,
  id: "revenue_plan_gaps",
  title: "The plan starts in April 2025 and has no figure for January 2026",
  series: [withTarget(revenueSeries, { values: gaps })],
};

const weekly = incompleteLine("revenue_weekly_pace", "Week to date: revenue is ahead of pace", {});
const weeklySeries = weekly.series[0] as Series;
const weeklyTarget = planned(wholeBuckets(weeklySeries), 0.94);
const TARGET_PACE: LineData = {
  ...weekly,
  series: [
    withTarget(weeklySeries, {
      values: weeklyTarget,
      pace: paced(weeklyTarget, weeklySeries.partial),
    }),
  ],
  target: PLAN,
};

const regionTotals = REGION_LINE.series[0]?.values.map((_, i) =>
  REGION_LINE.series.reduce((sum, s) => sum + ((s.values[i] as number) ?? 0), 0),
) as number[];
const TARGET_SPLIT_TOTAL: LineData = {
  ...REGION_LINE,
  id: "regions_vs_plan",
  type: "area",
  stack: true,
  title: "All regions together against the company plan",
  totals: regionTotals,
  target: totalTarget(regionTotals, planned(regionTotals)),
};

const TARGET_SPLIT_REGIONS: LineData = {
  ...REGION_LINE,
  id: "regions_own_plan",
  title: "Each region against its own plan",
  series: REGION_LINE.series.map((s, k) =>
    withTarget(s, { values: planned(s.values, k === 2 ? 0.95 : 1.06) }),
  ),
  target: totalTarget(regionTotals, planned(regionTotals)),
};

const TARGET_HIDDEN_GRAIN: LineData = {
  ...REVENUE_LINE,
  id: "revenue_hidden_grain",
  title: "A quarterly plan with prorate none on a monthly chart",
  target: { ...PLAN, label: "Quarterly plan", hidden: "grain" },
};

const countrySeries = COUNTRY_BAR.series[0] as Series;
const TARGET_COUNTRIES: BarData = {
  ...COUNTRY_BAR,
  id: "countries_vs_plan",
  title: "October revenue against each country's plan",
  series: [
    withTarget(countrySeries, {
      values: countrySeries.values.map((v, i) =>
        typeof v === "number" ? round(v * (i % 3 === 0 ? 0.92 : 1.07)) : null,
      ),
    }),
  ],
  target: PLAN,
};

const channelValues = CHANNELS.map((c) => round(1_850_000 * c.share));
const channelTotal = channelValues.reduce((a, b) => a + b, 0);
const TARGET_WINDOW: BarData = {
  type: "bar",
  id: "channels_vs_window",
  title: "Channels this month; the plan is set for the whole company",
  span: 6,
  orientation: "vertical",
  stack: false,
  axis: { kind: "category", column: "channel", categories: CHANNELS.map((c) => c.name) },
  series: [
    {
      key: "revenue",
      metric: "revenue",
      label: "Revenue",
      values: channelValues,
    },
  ],
  target: {
    ...PLAN,
    window: {
      value: round(channelTotal * 1.08),
      pace: round(channelTotal * 0.98),
      attainment: channelTotal / round(channelTotal * 0.98),
    },
  },
};

const monthly = incompleteBars("revenue_monthly_pace", "September is behind pace so far", {});
const monthlySeries = monthly.series[0] as Series;
const monthlyTarget = planned(wholeBuckets(monthlySeries), 1.12);
const TARGET_BARS_PACE: BarData = {
  ...monthly,
  series: [
    withTarget(monthlySeries, {
      values: monthlyTarget,
      pace: paced(monthlyTarget, monthlySeries.partial),
    }),
  ],
  target: PLAN,
};

const stackedChannels: Series[] = CHANNELS.slice(0, 3).map((c) => ({
  key: `revenue:${c.name}`,
  metric: "revenue",
  label: c.name,
  splitValue: c.name,
  values: MONTHLY_REVENUE.slice(18).map((v) => round(v * c.share)),
}));
const stackedTotals = stackedChannels[0]?.values.map((_, i) =>
  stackedChannels.reduce((sum, s) => sum + (s.values[i] as number), 0),
) as number[];
const TARGET_STACKED: BarData = {
  type: "bar",
  id: "channels_stacked_plan",
  title: "Three channels stacked against the combined plan",
  span: 6,
  orientation: "vertical",
  stack: true,
  axis: monthAxis(6),
  series: stackedChannels,
  totals: stackedTotals,
  target: totalTarget(stackedTotals, planned(stackedTotals)),
};

const goal = (
  value: number | null,
  attainment: number | null,
  extra: Partial<NonNullable<KpiData["target"]>> = {},
): NonNullable<KpiData["target"]> => ({ ...PLAN, value, attainment, ...extra });

const october = MONTHLY_REVENUE[23] as number;
const KPI_STATES: KpiData[] = [
  {
    ...kpi("on_track", "revenue", 1_172_450, 1_098_220, { title: "Revenue, month to date" }),
    target: goal(1_860_000, 1_172_450 / 1_140_000, { pace: 1_140_000 }),
  },
  {
    ...kpi("behind", "orders", 12_402, 12_960, { title: "Orders, month to date" }),
    target: goal(22_000, 12_402 / 13_490, { label: "Orders plan", pace: 13_490 }),
  },
  {
    ...kpi("over", "revenue", october, MONTHLY_REVENUE[22] as number, {
      title: "Revenue, October",
    }),
    target: goal(round(october / 1.24), 1.24),
  },
  {
    ...kpi("average", "avg_order_value", 86.4, 84.12, { title: "Average order value" }),
    target: goal(90, 86.4 / 90, { label: "AOV goal" }),
  },
];

const KPI_EDGES: KpiData[] = [
  {
    ...kpi("refunds", "refund_rate", 0.0412, 0.0386, { title: "Refund rate (lower is better)" }),
    target: goal(0.035, 0.0412 / 0.035, { label: "Refund ceiling" }),
  },
  {
    ...kpi("hidden_segment", "revenue", 642_118, 610_402, { title: "Revenue, Paid marketing on" }),
    target: goal(null, null, { hidden: "segment" }),
  },
  {
    ...kpi("hidden_filter", "revenue", 412_530, 398_014, { title: "Revenue, one country" }),
    target: goal(null, null, { hidden: "filter" }),
  },
  {
    ...kpi("no_target", "revenue", 1_843_210, 1_679_402, {
      title: "Revenue, a month without a plan",
    }),
    target: goal(null, null),
  },
  {
    ...kpi("zero_target", "orders", 38, 41, { title: "Orders from a channel being retired" }),
    target: goal(0, null, { label: "Orders plan" }),
  },
  {
    ...kpi("without", "revenue", 1_843_210, 1_679_402, { title: "Revenue, no target named" }),
  },
  {
    ...kpi("long_label", "revenue", 21_330_118, 19_802_440, {
      title: "Net revenue from returning wholesale customers in North America",
    }),
    target: goal(20_500_000, 21_330_118 / 19_900_000, {
      label: "FY2027 board-approved operating plan",
      pace: 19_900_000,
    }),
  },
  {
    ...kpi("negative", "revenue", -12_400, -8_100, { title: "Revenue net of chargebacks" }),
    target: goal(-5_000, null, { label: "Loss ceiling" }),
  },
];

export const TARGETS: GalleryVariant[] = [
  one("line", "target-line", "Line with a target", TARGET_LINE),
  one("line", "target-area", "Area with a target", TARGET_AREA),
  one("line", "target-pace", "A partial bucket with pace", TARGET_PACE),
  one("line", "target-gaps", "Gaps where the target has no value", TARGET_GAPS),
  one("stacked", "target-split-total", "Stacked split, total target", TARGET_SPLIT_TOTAL),
  one("line", "target-split-series", "Split line, a target per series", TARGET_SPLIT_REGIONS),
  one("line", "target-hidden", "A target hidden at this grain", TARGET_HIDDEN_GRAIN),
  one("kpi", "target-kpi-states", "KPI: on track, behind, over, an average", ...KPI_STATES),
  one("kpi", "target-kpi-edges", "KPI: lower is better, hidden, none, zero, long", ...KPI_EDGES),
  one("bar", "target-bar-categories", "Bar: a target per category", TARGET_COUNTRIES),
  one("bar", "target-bar-window", "Bar: a window target", TARGET_WINDOW),
  one("bar", "target-bar-pace", "Bar: monthly target with pace", TARGET_BARS_PACE),
  one("stacked", "target-bar-stacked", "Bar: stacked, total target", TARGET_STACKED),
];
