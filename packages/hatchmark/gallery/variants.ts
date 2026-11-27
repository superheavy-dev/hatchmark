import type {
  BarData,
  DashboardData,
  KpiData,
  LineData,
  TableData,
  Value,
} from "../src/compiler/dashboard-data.js";
import {
  CHANNELS,
  COUNTRIES,
  COUNTRY_BAR,
  COUNTRY_TABLE,
  dashboard,
  kpi,
  LAST_12,
  MONTHLY_REVENUE,
  MONTHS,
  monthAxis,
  OCT,
  REGION_LINE,
  REGIONS,
  REVENUE_LINE,
  rand,
  round,
  SALES,
  series,
  span,
} from "./fixtures.js";
import { FISCAL_BARS, MONTH, QUARTER_BARS, REGION_SWITCH, revenueSwitch, WEEK } from "./grains.js";

/** One gallery entry: a component variant on sample data, wrapped as a one-block dashboard. */
export interface GalleryVariant {
  component: "kpi" | "line" | "bar" | "table";
  variant: string;
  title: string;
  data: DashboardData;
}

const one = (
  component: GalleryVariant["component"],
  variant: string,
  title: string,
  ...blocks: DashboardData["blocks"]
): GalleryVariant => ({ component, variant, title, data: dashboard(variant, title, blocks) });

const sparkline = {
  grain: "month" as const,
  buckets: MONTHS.slice(12),
  values: MONTHLY_REVENUE.slice(12),
};

const KPIS: GalleryVariant[] = [
  one(
    "kpi",
    "kpi-up-good",
    "Up, higher is better",
    kpi("revenue", "revenue", 1_843_210, 1_679_402),
  ),
  one("kpi", "kpi-down-bad", "Down, higher is better", kpi("aov", "avg_order_value", 84.12, 86.37)),
  one(
    "kpi",
    "kpi-lower-is-better",
    "Up, lower is better (percentage points)",
    kpi("refund_rate", "refund_rate", 0.0412, 0.0386),
  ),
  one(
    "kpi",
    "kpi-improved-lower",
    "Down, lower is better",
    kpi("returns", "returns", 1_204, 1_391),
  ),
  one("kpi", "kpi-neutral", "Neutral metric", kpi("sessions", "sessions", 1_482_330, 1_391_002)),
  one("kpi", "kpi-flat", "No change", kpi("customers", "customers", 9_412, 9_412)),
  one("kpi", "kpi-zero", "A real zero", kpi("returns", "returns", 0, 37)),
  one("kpi", "kpi-null", "Undefined value", kpi("aov", "avg_order_value", null, 86.37)),
  one(
    "kpi",
    "kpi-no-previous",
    "No previous-period data",
    kpi("customers", "customers", 312, null),
  ),
  one("kpi", "kpi-previous-zero", "Previous period was zero", kpi("orders", "orders", 48, 0)),
  one("kpi", "kpi-no-compare", "No comparison", kpi("revenue", "revenue", 21_330_118, undefined)),
  one(
    "kpi",
    "kpi-sparkline",
    "With sparkline",
    kpi("revenue", "revenue", 1_843_210, 1_679_402, { sparkline }),
  ),
  one("kpi", "kpi-strip", "Strip of four (example dashboard)", ...SALES.blocks.slice(0, 4)),
];

const weeks = Array.from({ length: 52 }, (_, i) => {
  const d = new Date(Date.UTC(2025, 10, 3 + i * 7));
  return d.toISOString().slice(0, 10);
});
const days = Array.from({ length: 92 }, (_, i) => {
  const d = new Date(Date.UTC(2026, 7, 1 + i));
  return d.toISOString().slice(0, 10);
});

const line = (
  id: string,
  title: string,
  extra: Partial<LineData> & Pick<LineData, "series">,
): LineData => ({
  type: "line",
  id,
  title,
  span: 12,
  axis: monthAxis(),
  ...extra,
});

const withGaps: Value[] = MONTHLY_REVENUE.map((v, i) =>
  i === 7 || i === 8 || i === 15 ? null : v,
);
const cashFlow = MONTHLY_REVENUE.map((v, i) =>
  round((v - 1_400_000) * (i % 5 === 0 ? 1.6 : 0.6), 1000),
);
const sevenChannels = [
  "Online store",
  "Marketplace",
  "Retail partners",
  "Wholesale",
  "Social commerce",
  "Mobile app",
  "Pop-up stores",
].map((name, k) =>
  series(
    "revenue",
    name,
    MONTHLY_REVENUE.map((v) => round(v * (0.3 - k * 0.035) * (0.95 + rand() * 0.1))),
    name,
  ),
);

/** World Bank region names: long, multi-word series names that must never be middle-truncated. */
const WORLD_REGIONS = [
  { name: "North America", share: 0.38 },
  { name: "Europe & Central Asia", share: 0.24 },
  { name: "East Asia & Pacific", share: 0.18 },
  { name: "Latin America & Caribbean", share: 0.1 },
  { name: "Middle East & North Africa", share: 0.06 },
  { name: "Sub-Saharan Africa", share: 0.04 },
];
const worldRegions = WORLD_REGIONS.map((region, k) =>
  series(
    "revenue",
    region.name,
    MONTHLY_REVENUE.map((v, i) =>
      round(v * region.share * (1 + (k - 2) * 0.03 * (i / 23)) * (1 + 0.04 * Math.sin(i + k))),
    ),
    region.name,
  ),
);

const LINES: GalleryVariant[] = [
  one("line", "line-single", "One series, 24 months", { ...REVENUE_LINE, span: 12 }),
  one("line", "line-split", "Split by region, direct labels", { ...REGION_LINE, span: 12 }),
  one("line", "line-narrow", "Narrow card: a key above the plot instead of direct labels", {
    ...REGION_LINE,
    id: "region_narrow",
    span: 4,
  }),
  one(
    "line",
    "line-long-names",
    "Long series names: full direct labels, the key wraps on phones",
    line("world_regions", "North America still brings in the most revenue", {
      span: 8,
      series: worldRegions,
    }),
  ),
  one(
    "line",
    "line-long-names-narrow",
    "Long series names in a narrow card: the key wraps across the card",
    line("world_regions_narrow", "Revenue by world region", { span: 4, series: worldRegions }),
  ),
  one(
    "line",
    "line-weekly",
    "Weekly grain, 52 weeks",
    line("weekly", "Weekly revenue by channel", {
      axis: {
        kind: "time",
        grain: "week",
        buckets: weeks,
        window: span("2025-11-03", "2026-11-02"),
      },
      series: CHANNELS.map((c) =>
        series(
          "revenue",
          c.name,
          weeks.map((w, i) =>
            round(392_000 * c.share * season(w) * (1 + i / 180) * (0.94 + rand() * 0.12)),
          ),
          c.name,
        ),
      ),
    }),
  ),
  one(
    "line",
    "line-daily",
    "Daily grain, one quarter",
    line("daily", "Orders per day", {
      axis: { kind: "time", grain: "day", buckets: days, window: span("2026-08-01", "2026-11-01") },
      series: [
        series(
          "orders",
          "Orders",
          days.map((d) =>
            round(
              690 *
                ([0, 6].includes(new Date(`${d}T00:00:00Z`).getUTCDay()) ? 1.25 : 1) *
                (0.9 + rand() * 0.2),
            ),
          ),
        ),
      ],
    }),
  ),
  one(
    "line",
    "line-gaps",
    "Missing values leave gaps",
    line("gaps", "Average order value has gaps where no orders were tagged", {
      series: [
        series(
          "avg_order_value",
          "Average order value",
          withGaps.map((v) => (v === null ? null : Math.round(v / 18_000) + 12.5)),
        ),
      ],
    }),
  ),
  one(
    "line",
    "line-negative",
    "Negative values",
    line("cash", "Net cash flow turned negative in four months", {
      series: [series("net_cash_flow", "Net cash flow", cashFlow)],
    }),
  ),
  one(
    "line",
    "line-percent",
    "Percent metric",
    line("refunds", "Refund rate by month", {
      series: [
        series(
          "refund_rate",
          "Refund rate",
          MONTHS.map((_, i) => Math.round((0.035 + 0.008 * Math.sin(i / 3)) * 10000) / 10000),
        ),
      ],
    }),
  ),
  one(
    "line",
    "line-many",
    "Seven series: key instead of direct labels",
    line("many", "Revenue by channel", { series: sevenChannels }),
  ),
  one(
    "line",
    "line-empty",
    "No data in the window",
    line("empty", "Revenue will appear after the first order", {
      series: [
        series(
          "revenue",
          "Revenue",
          MONTHS.map(() => null),
        ),
      ],
    }),
  ),
  one(
    "line",
    "line-single-point",
    "One bucket",
    line("one_point", "Revenue this month", {
      axis: { kind: "time", grain: "month", buckets: ["2026-10-01"], window: OCT },
      series: [series("revenue", "Revenue", [1_843_210])],
    }),
  ),
  one("line", "area", "Area", { ...REVENUE_LINE, id: "area", type: "area", span: 12 }),
  one("line", "area-stacked", "Stacked area by region", {
    ...REGION_LINE,
    id: "area_stacked",
    type: "area",
    stack: true,
    span: 12,
  }),
];

function season(date: string): number {
  return [0.86, 0.84, 0.95, 0.97, 1.0, 0.98, 0.96, 1.0, 1.04, 1.08, 1.28, 1.42][
    Number(date.slice(5, 7)) - 1
  ] as number;
}

const bar = (
  id: string,
  title: string,
  extra: Partial<BarData> & Pick<BarData, "series" | "axis">,
): BarData => ({
  type: "bar",
  id,
  title,
  span: 12,
  orientation: "vertical",
  stack: false,
  ...extra,
});

const regionAxis = {
  kind: "category" as const,
  column: "region",
  categories: REGIONS.map((r) => r.name),
};
const channelSplit = (values: (share: number, i: number) => Value) =>
  CHANNELS.map((c) =>
    series(
      "revenue",
      c.name,
      REGIONS.map((r, i) => values(c.share * r.share, i)),
      c.name,
    ),
  );
const last12 = MONTHLY_REVENUE.slice(12);

const worldAxis = {
  kind: "category" as const,
  column: "channel",
  categories: CHANNELS.map((c) => c.name),
};

const BARS: GalleryVariant[] = [
  one("bar", "bar-horizontal", "Horizontal, top 10 of 24 countries", { ...COUNTRY_BAR, span: 6 }),
  one(
    "bar",
    "bar-vertical",
    "Vertical, by region",
    bar("by_region", "North America brings in almost half of revenue", {
      axis: regionAxis,
      series: [
        series(
          "revenue",
          "Revenue",
          REGIONS.map((r) => round(1_843_210 * r.share)),
        ),
      ],
    }),
  ),
  one(
    "bar",
    "bar-time",
    "Vertical, by month",
    bar("by_month", "Revenue by month", {
      axis: monthAxis(12),
      series: [series("revenue", "Revenue", last12)],
    }),
  ),
  one(
    "bar",
    "bar-grouped",
    "Grouped by channel",
    bar("grouped", "The online store leads in every region", {
      axis: regionAxis,
      series: channelSplit((s) => round(1_843_210 * s)),
    }),
  ),
  one(
    "bar",
    "bar-long-series",
    "Long series names: the key reflows, nothing is cut",
    bar("long_series", "North America leads in every channel", {
      axis: worldAxis,
      stack: true,
      orientation: "horizontal",
      span: 6,
      series: WORLD_REGIONS.map((region) =>
        series(
          "revenue",
          region.name,
          CHANNELS.map((c) => round(1_843_210 * c.share * region.share)),
          region.name,
        ),
      ),
    }),
  ),
  one(
    "bar",
    "bar-stacked",
    "Stacked by channel, by month",
    bar("stacked", "Marketplace grew its share through the holidays", {
      axis: monthAxis(12),
      stack: true,
      series: CHANNELS.map((c, k) =>
        series(
          "revenue",
          c.name,
          last12.map((v, i) => round(v * c.share * (1 + (k === 1 ? 0.012 : -0.006) * i))),
          c.name,
        ),
      ),
    }),
  ),
  one(
    "bar",
    "bar-horizontal-stacked",
    "Horizontal, stacked",
    bar("h_stacked", "Revenue by region and channel", {
      orientation: "horizontal",
      stack: true,
      axis: regionAxis,
      series: channelSplit((s) => round(1_843_210 * s)),
    }),
  ),
  one(
    "bar",
    "bar-horizontal-grouped",
    "Horizontal, grouped",
    bar("h_grouped", "Orders by region and channel", {
      orientation: "horizontal",
      axis: regionAxis,
      series: CHANNELS.slice(0, 2).map((c) =>
        series(
          "orders",
          c.name,
          REGIONS.map((r) => round(21_874 * c.share * r.share)),
          c.name,
        ),
      ),
    }),
  ),
  one(
    "bar",
    "bar-negative",
    "Negative values",
    bar("margin", "Two categories lost money in October", {
      axis: {
        kind: "category",
        column: "category",
        categories: ["Outerwear", "Footwear", "Accessories", "Bags", "Kids", "Home"],
      },
      series: [
        series(
          "net_cash_flow",
          "Net cash flow",
          [182_400, 96_100, 41_800, -12_300, 22_900, -31_700],
        ),
      ],
    }),
  ),
  one(
    "bar",
    "bar-long-labels",
    "Long category names",
    bar("long", "Revenue by product line", {
      orientation: "vertical",
      axis: {
        kind: "category",
        column: "product_line",
        categories: [
          "Technical shells and insulated outerwear",
          "Trail running footwear",
          "Base layers",
          "Travel bags and organizers",
          "Kids' outdoor clothing",
          "Camp kitchen",
          null,
        ],
      },
      series: [
        series("revenue", "Revenue", [512_300, 401_220, 288_000, 203_410, 151_900, 98_500, 12_040]),
      ],
    }),
  ),
  one(
    "bar",
    "bar-long-categories",
    "Long category names: rows wrap to two lines, nothing is cut in the middle",
    bar("long_rows", "Technical shells lead the product lines", {
      orientation: "horizontal",
      span: 6,
      axis: {
        kind: "category",
        column: "product_line",
        categories: [
          "Technical shells & outerwear",
          "Trail running footwear",
          "Base layers & midlayers",
          "Travel bags & organizers",
          "Climbing hardware, ropes, harnesses and protection",
          "Camp kitchen",
        ],
      },
      series: [series("revenue", "Revenue", [512_300, 401_220, 288_000, 203_410, 151_900, 98_500])],
    }),
  ),
  one(
    "bar",
    "bar-empty",
    "No data",
    bar("empty_bar", "Revenue by region", {
      axis: regionAxis,
      series: [
        series(
          "revenue",
          "Revenue",
          REGIONS.map(() => null),
        ),
      ],
    }),
  ),
];

const { total: _countryTotal, ...TABLE_BASE } = COUNTRY_TABLE;
const table = (id: string, title: string, extra: Partial<TableData>): TableData => ({
  ...TABLE_BASE,
  id,
  title,
  ...extra,
});

const regionRows = REGIONS.flatMap((r) =>
  COUNTRIES.filter((c) => c.region === r.name)
    .slice(0, 3)
    .map((c) => {
      const revenue = round(1_843_210 * c.share);
      return { keys: [r.name, c.name], values: { revenue, orders: round(revenue / c.aov) } };
    }),
);

const TABLES: GalleryVariant[] = [
  one("table", "table-countries", "By country, % of total, totals, limited rows", COUNTRY_TABLE),
  one(
    "table",
    "table-two-columns",
    "Two by columns",
    table("regions", "Revenue by region and country", {
      by: [
        { column: "region", label: "Region" },
        { column: "country", label: "Country" },
      ],
      metrics: ["revenue", "orders"],
      percentOfTotal: [],
      rows: regionRows,
      rowCount: regionRows.length,
      total: {
        values: {
          revenue: regionRows.reduce((a, r) => a + r.values.revenue, 0),
          orders: regionRows.reduce((a, r) => a + r.values.orders, 0),
        },
      },
    }),
  ),
  one(
    "table",
    "table-nulls",
    "Empty group and undefined values",
    table("nulls", "Revenue by acquisition channel", {
      by: [{ column: "channel", label: "Acquisition channel" }],
      metrics: ["revenue", "avg_order_value"],
      percentOfTotal: ["revenue"],
      rows: [
        {
          keys: ["Paid search"],
          values: { revenue: 612_400, avg_order_value: 81.2 },
          share: { revenue: 0.5 },
        },
        {
          keys: ["Email"],
          values: { revenue: 388_000, avg_order_value: 92.04 },
          share: { revenue: 0.3167 },
        },
        {
          keys: [null],
          values: { revenue: 224_600, avg_order_value: null },
          share: { revenue: 0.1833 },
        },
        {
          keys: ["Affiliates"],
          values: { revenue: 0, avg_order_value: null },
          share: { revenue: 0 },
        },
      ],
      rowCount: 4,
      total: { values: { revenue: 1_225_000, avg_order_value: 84.5 }, share: { revenue: 1 } },
    }),
  ),
  one(
    "table",
    "table-no-totals",
    "Without a total row",
    table("no_totals", "Average order value by country", {
      metrics: ["avg_order_value"],
      percentOfTotal: [],
      rows: COUNTRY_TABLE.rows.slice(0, 6).map((r) => ({
        keys: r.keys,
        values: { avg_order_value: r.values.avg_order_value ?? null },
      })),
      rowCount: 6,
    }),
  ),
  one(
    "table",
    "table-empty",
    "No rows",
    table("empty_table", "Revenue by country", { rows: [], rowCount: 0, window: LAST_12 }),
  ),
];

/** Every gallery variant, by component. */
const GRAIN_LINES: GalleryVariant[] = [
  one(
    "line",
    "line-grains",
    "Grain switch: week, month or quarter (month selected)",
    revenueSwitch(MONTH),
  ),
  one("line", "line-grains-week", "Grain switch with week selected", revenueSwitch(WEEK)),
  one(
    "line",
    "line-grains-split",
    "Grain switch on a split line (quarter selected)",
    REGION_SWITCH,
  ),
];

const GRAIN_BARS: GalleryVariant[] = [
  one("bar", "bar-grains", "Time bars that switch between quarter and month", QUARTER_BARS),
  one(
    "bar",
    "bar-grains-anchors",
    "Calendar or retail quarters: options of one unit name their anchors",
    FISCAL_BARS,
  ),
];

export const GALLERY: GalleryVariant[] = [
  ...KPIS,
  ...LINES,
  ...GRAIN_LINES,
  ...BARS,
  ...GRAIN_BARS,
  ...TABLES,
];

export type { KpiData };
/** The example dashboard rendered as a whole. */
export { SALES };
