import type {
  BarData,
  DashboardData,
  KpiData,
  LineData,
  MetricInfo,
  PieData,
  ScatterData,
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
  METRICS,
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
import {
  FISCAL_BARS,
  incompleteBars,
  incompleteLine,
  MONTH,
  QUARTER_BARS,
  REGION_SWITCH,
  revenueSwitch,
  WEEK,
} from "./grains.js";
import {
  TABLE_GROUP_CAMPAIGNS,
  TABLE_GROUP_CITIES,
  TABLE_GROUP_EMPTY,
  TABLE_GROUP_PRODUCTS,
  TABLE_GROUP_SEATS,
  TABLE_GROUP_TEAMS,
  TABLE_GROUP_YEARS,
} from "./table-groups.js";
import {
  TABLE_BARS,
  TABLE_BARS_NEGATIVE,
  TABLE_OTHER_DISTINCT,
  TABLE_SORTED,
  TABLE_SUBTOTALS,
  TABLE_SUBTOTALS_OTHER,
  TABLE_TALL,
  TABLE_TOP_OTHER,
} from "./tables.js";

/** One gallery entry: a component variant on sample data, wrapped as a one-block dashboard. */
export interface GalleryVariant {
  component: "kpi" | "line" | "bar" | "stacked" | "pie" | "scatter" | "table";
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
  one("table", "table-sorted", "Sorted by a column other than the default", TABLE_SORTED),
  one("table", "table-top-other", "Top 8 plus Other, with % of total", TABLE_TOP_OTHER),
  one(
    "table",
    "table-other-distinct",
    "Other row on a distinct count: shown as — (check warns HM4063)",
    TABLE_OTHER_DISTINCT,
  ),
  one("table", "table-subtotals", "Subtotals by region, with in-cell bars", TABLE_SUBTOTALS),
  one(
    "table",
    "table-subtotals-other",
    "Subtotals with the top 3 per region and an Other row in each",
    TABLE_SUBTOTALS_OTHER,
  ),
  one("table", "table-bars", "In-cell bars on two metrics", TABLE_BARS),
  one("table", "table-bars-negative", "In-cell bars across zero", TABLE_BARS_NEGATIVE),
  one(
    "table",
    "table-tall",
    "50 rows alone in their row: the table grows with the page, header and total pinned to the screen",
    TABLE_TALL,
  ),
  one(
    "table",
    "table-tall-scroll",
    'Alone in its row with "overflow": "scroll": scrolls inside its card',
    { ...TABLE_TALL, id: "tall_scroll", overflow: "scroll" },
  ),
  one(
    "table",
    "table-tall-shared",
    "Sharing a row with a chart: scrolls inside its card",
    { ...TABLE_TALL, id: "tall_shared", span: 8 },
    { ...COUNTRY_BAR, id: "beside_shared", span: 4 },
  ),
  one(
    "table",
    "table-tall-shared-page",
    'Sharing a row with "overflow": "page": grows, and the chart beside it stretches (check warns HM2026)',
    { ...TABLE_TALL, id: "tall_shared_page", span: 8, overflow: "page" },
    { ...COUNTRY_BAR, id: "beside_page", span: 4 },
  ),
  one(
    "table",
    "table-group-products",
    "Category and product, long product names",
    TABLE_GROUP_PRODUCTS,
  ),
  one(
    "table",
    "table-group-campaigns",
    "Channel and campaign with subtotals, long names, top 3 plus Other",
    TABLE_GROUP_CAMPAIGNS,
  ),
  one("table", "table-group-teams", "Subtotals with a one-person team", TABLE_GROUP_TEAMS),
  one("table", "table-group-cities", "Three levels: region, country, city", TABLE_GROUP_CITIES),
  one("table", "table-group-years", "Year and quarter with subtotals", TABLE_GROUP_YEARS),
  one("table", "table-group-seats", "Plan tier and a numeric seat count", TABLE_GROUP_SEATS),
  one("table", "table-group-empty", "An empty group value", TABLE_GROUP_EMPTY),
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

/** The edges and incomplete options over a quarter whose data ends mid-week (RFC 0001 6.5). */
const INCOMPLETE_LINES: GalleryVariant[] = [
  one(
    "line",
    "line-incomplete-mark",
    "Data through Sep 23: the last week is partial (incomplete: mark, the default)",
    incompleteLine("weeks_mark", "Weekly revenue, third quarter", {}),
  ),
  one(
    "line",
    "line-incomplete-hide",
    "The partial last week left out (incomplete: hide)",
    incompleteLine("weeks_hide", "Weekly revenue, third quarter", { hide: true }),
  ),
  one(
    "line",
    "line-edges-clip",
    "The first week clipped at Jul 1 (edges: clip) instead of starting on Jun 29",
    incompleteLine("weeks_clip", "Weekly revenue, third quarter", { clip: true }),
  ),
];

const INCOMPLETE_BARS: GalleryVariant[] = [
  one(
    "bar",
    "bar-incomplete-mark",
    "September is 23 of 30 days in (incomplete: mark, the default)",
    incompleteBars("months_mark", "Monthly revenue, third quarter", {}),
  ),
  one(
    "bar",
    "bar-incomplete-hide",
    "The partial month left out (incomplete: hide)",
    incompleteBars("months_hide", "Monthly revenue, third quarter", { hide: true }),
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

/**
 * A stacked block's engine output for sample data: totals per position and each value's share.
 * totals overrides the sum, as the engine does for a split metric that is recomputed from rows.
 */
function stacked<T extends BarData | LineData>(block: T, percent = false, totals?: Value[]): T {
  const n = block.series[0]?.values.length ?? 0;
  const sums =
    totals ??
    Array.from({ length: n }, (_, i) => {
      const values = block.series.map((s) => s.values[i] ?? null).filter((v) => v !== null);
      return values.length === 0 ? null : values.reduce((a, b) => a + b, 0);
    });
  return {
    ...block,
    stack: true,
    series: block.series.map((s) => ({
      ...s,
      share: s.values.map((v, i) => {
        const t = sums[i] ?? null;
        return v === null || t === null || t === 0 ? null : v / t;
      }),
    })),
    totals: sums,
    ...(percent ? { percent: true as const } : {}),
  };
}

/** How each region's revenue splits across channels: marketplaces matter more outside the US. */
const CHANNEL_MIX: Record<string, number[]> = {
  "North America": [0.64, 0.22, 0.14],
  Europe: [0.52, 0.31, 0.17],
  "Asia-Pacific": [0.41, 0.44, 0.15],
  "Latin America": [0.33, 0.55, 0.12],
};
const channelMix = (total: number) =>
  CHANNELS.map((c, k) =>
    series(
      "revenue",
      c.name,
      REGIONS.map((r) => round(total * r.share * (CHANNEL_MIX[r.name]?.[k] ?? 0))),
      c.name,
    ),
  );

const DEVICES = [
  { name: "Mobile", start: 0.48, end: 0.61 },
  { name: "Desktop", start: 0.44, end: 0.33 },
  { name: "Tablet", start: 0.08, end: 0.06 },
];
const deviceOrders = DEVICES.map((d) =>
  series(
    "orders",
    d.name,
    last12.map((v, i) => round((v / 84) * (d.start + ((d.end - d.start) * i) / 11))),
    d.name,
  ),
);

/** Payment methods by country: cards everywhere, wallets and local methods vary by market. */
const PAYMENTS: [string, number[]][] = [
  ["United States", [0.62, 0.18, 0.14, 0.06]],
  ["United Kingdom", [0.55, 0.19, 0.16, 0.1]],
  ["Canada", [0.68, 0.15, 0.12, 0.05]],
  ["Germany", [0.29, 0.38, 0.06, 0.27]],
  ["Australia", [0.51, 0.14, 0.21, 0.14]],
  ["France", [0.66, 0.17, 0.09, 0.08]],
  ["Japan", [0.71, 0.04, 0.12, 0.13]],
  ["Netherlands", [0.18, 0.21, 0.05, 0.56]],
];
const paymentAxis = {
  kind: "category" as const,
  column: "country",
  categories: PAYMENTS.map(([c]) => c),
};
const paymentSeries = ["Card", "PayPal", "Apple Pay", "Local methods"].map((name, k) =>
  series(
    "orders",
    name,
    PAYMENTS.map(([country, mix]) => {
      const share = COUNTRIES.find((c) => c.name === country)?.share ?? 0;
      return round(21_874 * share * (mix[k] ?? 0));
    }),
    name,
  ),
);

const STACKED: GalleryVariant[] = [
  one(
    "stacked",
    "bar-stacked",
    "Stacked bars by month",
    stacked(
      bar("stacked", "Marketplace grew its share through the holidays", {
        axis: monthAxis(12),
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
  ),
  one(
    "stacked",
    "bar-horizontal-stacked",
    "Horizontal stacked bars",
    stacked(
      bar("h_stacked", "Marketplaces bring in more than half of Latin American revenue", {
        orientation: "horizontal",
        axis: regionAxis,
        series: channelMix(1_843_210),
      }),
    ),
  ),
  one(
    "stacked",
    "bar-percent",
    "100% stacked bars by region",
    stacked(
      bar("percent", "Marketplaces matter more outside North America", {
        axis: regionAxis,
        series: channelMix(1_843_210),
      }),
      true,
    ),
  ),
  one(
    "stacked",
    "bar-percent-time",
    "100% stacked bars by month",
    stacked(
      bar("device_mix", "Mobile passed 60% of orders in October", {
        axis: monthAxis(12),
        series: deviceOrders,
      }),
      true,
    ),
  ),
  one(
    "stacked",
    "bar-horizontal-percent",
    "Horizontal 100% stacked bars",
    stacked(
      bar("payments", "Local methods lead in the Netherlands and Germany", {
        orientation: "horizontal",
        axis: paymentAxis,
        span: 8,
        series: paymentSeries,
      }),
      true,
    ),
  ),
  one(
    "stacked",
    "bar-stacked-negative",
    "Stacked with negative values: parts diverge from zero",
    stacked(
      bar("cash_by_region", "Europe's refunds outweighed its sales in two categories", {
        axis: {
          kind: "category",
          column: "category",
          categories: ["Outerwear", "Footwear", "Accessories", "Bags", "Kids", "Home"],
        },
        series: [
          series(
            "net_cash_flow",
            "North America",
            [98_200, 61_400, 24_100, 8_300, 15_900, 4_200],
            "North America",
          ),
          series(
            "net_cash_flow",
            "Europe",
            [52_600, 21_900, 11_300, -14_800, 4_100, -22_500],
            "Europe",
          ),
          series(
            "net_cash_flow",
            "Asia-Pacific",
            [31_600, 12_800, 6_400, -5_800, 2_900, -13_400],
            "Asia-Pacific",
          ),
        ],
      }),
    ),
  ),
  one(
    "stacked",
    "area-stacked",
    "Stacked area by region",
    stacked({ ...REGION_LINE, id: "area_stacked", type: "area", span: 12 }),
  ),
  one(
    "stacked",
    "area-percent",
    "100% stacked area by region",
    stacked(
      {
        ...REGION_LINE,
        id: "area_percent",
        type: "area",
        title: "Asia-Pacific's share of revenue grew to 18%",
        span: 12,
      },
      true,
    ),
  ),
  one(
    "stacked",
    "area-percent-narrow",
    "100% stacked area, narrow card: the key replaces direct labels",
    stacked(
      {
        ...REGION_LINE,
        id: "area_percent_narrow",
        type: "area",
        title: "Revenue share by region",
        span: 4,
      },
      true,
    ),
  ),
];

/** A pie or donut's engine output for sample data: the largest positive slices, then Other. */
function pie(
  type: "pie" | "donut",
  id: string,
  title: string,
  metric: string,
  column: string,
  rows: [string | null, number | null][],
  extra: { limit?: number; span?: number } = {},
): PieData {
  const limit = extra.limit ?? 5;
  const positive = rows
    .filter((r): r is [string | null, number] => r[1] !== null && r[1] > 0)
    .sort((a, b) => b[1] - a[1]);
  const negative = rows.filter((r): r is [string | null, number] => r[1] !== null && r[1] < 0);
  const empty = rows.length - positive.length - negative.length;
  const whole = positive.reduce((s, r) => s + r[1], 0);
  const total = rows.reduce((s, r) => s + (r[1] ?? 0), 0);
  const label = (k: string | null) => (k === null ? "(empty)" : k);
  const rest = positive.slice(limit);
  const otherValue = rest.reduce((s, r) => s + r[1], 0);
  return {
    type,
    id,
    title,
    span: extra.span ?? 6,
    metric,
    column,
    slices: positive
      .slice(0, limit)
      .map(([key, value]) => ({ key, label: label(key), value, share: value / whole })),
    ...(rest.length > 0
      ? { other: { count: rest.length, value: otherValue, share: otherValue / whole } }
      : {}),
    total: rows.length === 0 ? null : total,
    whole,
    ...(negative.length > 0 || empty > 0
      ? {
          excluded: {
            negative: negative.map(([key, value]) => ({ key, label: label(key), value })),
            empty,
          },
        }
      : {}),
    window: OCT,
  };
}

const PIES: GalleryVariant[] = [
  one(
    "pie",
    "pie-countries",
    "Pie: top 5 countries and Other",
    pie(
      "pie",
      "pie_countries",
      "The United States brings in 39% of revenue",
      "revenue",
      "country",
      COUNTRIES.map((c) => [c.name, round(1_843_210 * c.share)]),
    ),
  ),
  one(
    "pie",
    "donut-channels",
    "Donut: three channels, total in the hole",
    pie(
      "donut",
      "donut_channels",
      "The online store takes 58% of revenue",
      "revenue",
      "channel",
      CHANNELS.map((c) => [c.name, round(1_843_210 * c.share)]),
    ),
  ),
  one(
    "pie",
    "donut-devices",
    "Donut: orders by device",
    pie("donut", "donut_devices", "Six in ten orders come from phones", "orders", "device", [
      ["Mobile", 13_342],
      ["Desktop", 7_219],
      ["Tablet", 1_313],
    ]),
  ),
  one(
    "pie",
    "pie-two",
    "Pie: two slices",
    pie("pie", "pie_two", "New customers placed a third of orders", "orders", "customer_type", [
      ["Returning", 14_583],
      ["New", 7_291],
    ]),
  ),
  one(
    "pie",
    "pie-six",
    "Pie: six slices (the readable maximum)",
    pie(
      "pie",
      "pie_six",
      "Outerwear leads revenue by category",
      "revenue",
      "category",
      [
        ["Outerwear", 512_400],
        ["Footwear", 398_100],
        ["Apparel", 344_900],
        ["Accessories", 221_800],
        ["Bags", 182_300],
        ["Home", 96_200],
        ["Kids", 87_510],
      ],
      { limit: 6 },
    ),
  ),
  one(
    "pie",
    "donut-long-labels",
    "Donut: long category names wrap, never cut in the middle",
    pie(
      "donut",
      "donut_regions",
      "Revenue by World Bank region",
      "revenue",
      "region",
      [
        ["North America", 866_309],
        ["Europe and Central Asia", 534_531],
        ["East Asia and Pacific", 263_347],
        ["Latin America and the Caribbean", 129_025],
        ["Middle East, North Africa, Afghanistan and Pakistan", 33_178],
        ["Sub-Saharan Africa", 16_820],
      ],
      { span: 6 },
    ),
  ),
  one(
    "pie",
    "pie-negative",
    "Pie with negative values: left out and listed",
    pie("pie", "pie_negative", "Net revenue by channel after refunds", "net_cash_flow", "channel", [
      ["Online store", 612_300],
      ["Marketplace", 288_900],
      ["Retail partners", 141_200],
      ["Wholesale", -12_300],
      ["Pop-up stores", null],
    ]),
  ),
  one(
    "pie",
    "pie-single",
    "Pie: one category",
    pie(
      "pie",
      "pie_single",
      "All October orders shipped from one warehouse",
      "orders",
      "warehouse",
      [["Reno, NV", 21_874]],
    ),
  ),
  one(
    "pie",
    "donut-narrow",
    "Donut, narrow card: the key goes under the ring",
    pie(
      "donut",
      "donut_narrow",
      "Revenue by region",
      "revenue",
      "region",
      REGIONS.map((r) => [r.name, round(1_843_210 * r.share)]),
      { span: 4 },
    ),
  ),
  one(
    "pie",
    "pie-empty",
    "No data",
    pie("pie", "pie_empty", "Revenue by country", "revenue", "country", []),
  ),
];

/** Deterministic noise in [-1, 1] per index and salt, so scatter samples need no shared generator. */
const wobble = (i: number, salt: number) => Math.sin(i * 12.9898 + salt * 78.233);

const pct = (name: string, label: string, better: MetricInfo["better"] = "up"): MetricInfo => ({
  name,
  label,
  format: { type: "percent", decimals: 1 },
  better,
});

const SCATTER_METRICS: Record<string, MetricInfo> = {
  conversion_rate: pct("conversion_rate", "Conversion rate"),
  revenue_growth: pct("revenue_growth", "Revenue growth"),
  contribution_margin: pct("contribution_margin", "Contribution margin"),
  revenue_per_customer: {
    name: "revenue_per_customer",
    label: "Revenue per customer",
    format: { type: "currency", currency: "USD", decimals: 2 },
    better: "up",
  },
};

const scatter = (variant: string, title: string, block: ScatterData): GalleryVariant => {
  const data = dashboard(variant, title, [block]);
  return {
    component: "scatter",
    variant,
    title,
    data: { ...data, metrics: { ...METRICS, ...SCATTER_METRICS } },
  };
};

const octRevenue = MONTHLY_REVENUE[23] as number;
const countryPoints = COUNTRIES.map((c) => {
  const revenue = round(octRevenue * c.share);
  const orders = round(revenue / c.aov);
  return { key: c.name, label: c.name, x: orders, y: revenue / orders, size: revenue };
}).sort((a, b) => b.size - a.size);

const countries = (id: string, span: number, title?: string): ScatterData => ({
  type: "scatter",
  id,
  ...(title === undefined ? {} : { title }),
  span,
  x: "orders",
  y: "avg_order_value",
  size: "revenue",
  column: "country",
  points: countryPoints,
  window: OCT,
});

const MARKETING = [
  ["Organic search", 412_300, 0.031],
  ["Paid search", 268_900, 0.042],
  ["Direct", 221_400, 0.048],
  ["Email", 96_800, 0.067],
  ["Paid social", 188_200, 0.014],
  ["Organic social", 74_500, 0.011],
  ["Referral", 41_900, 0.037],
  ["Affiliates", 52_600, 0.029],
  ["Display ads", 133_700, 0.006],
  ["SMS", 18_400, 0.081],
] as const;

const CATEGORY_GROWTH = [
  ["Rain jackets", 0.184, 0.214, 412_000],
  ["Trail running shoes", 0.262, 0.162, 356_000],
  ["Backpacks", 0.071, 0.238, 298_000],
  ["Tents", -0.124, 0.087, 241_000],
  ["Sleeping bags", -0.058, 0.121, 132_000],
  ["Climbing gear", 0.033, -0.042, 118_000],
  ["Base layers", 0.142, 0.276, 204_000],
  ["Cycling", -0.211, -0.087, 96_000],
  ["Water sports", -0.036, 0.018, 74_000],
  ["Kids", 0.097, 0.064, 88_000],
  ["Accessories", 0.012, 0.311, 157_000],
  ["Ski and snowboard", -0.167, 0.142, 189_000],
] as const;

/** US states and DC with rounded 2023 populations in millions. */
const STATES = [
  ["California", 39.0],
  ["Texas", 30.5],
  ["Florida", 22.6],
  ["New York", 19.6],
  ["Pennsylvania", 13.0],
  ["Illinois", 12.5],
  ["Ohio", 11.8],
  ["Georgia", 11.0],
  ["North Carolina", 10.8],
  ["Michigan", 10.0],
  ["New Jersey", 9.3],
  ["Virginia", 8.7],
  ["Washington", 7.8],
  ["Arizona", 7.4],
  ["Tennessee", 7.1],
  ["Massachusetts", 7.0],
  ["Indiana", 6.9],
  ["Missouri", 6.2],
  ["Maryland", 6.2],
  ["Wisconsin", 5.9],
  ["Colorado", 5.9],
  ["Minnesota", 5.7],
  ["South Carolina", 5.4],
  ["Alabama", 5.1],
  ["Louisiana", 4.6],
  ["Kentucky", 4.5],
  ["Oregon", 4.2],
  ["Oklahoma", 4.1],
  ["Connecticut", 3.6],
  ["Utah", 3.4],
  ["Iowa", 3.2],
  ["Nevada", 3.2],
  ["Arkansas", 3.1],
  ["Mississippi", 2.9],
  ["Kansas", 2.9],
  ["New Mexico", 2.1],
  ["Nebraska", 2.0],
  ["Idaho", 2.0],
  ["West Virginia", 1.8],
  ["Hawaii", 1.4],
  ["New Hampshire", 1.4],
  ["Maine", 1.4],
  ["Montana", 1.1],
  ["Rhode Island", 1.1],
  ["Delaware", 1.0],
  ["South Dakota", 0.9],
  ["North Dakota", 0.8],
  ["Alaska", 0.7],
  ["District of Columbia", 0.7],
  ["Vermont", 0.6],
  ["Wyoming", 0.6],
] as const;

const OUTDOOR_STATES = new Set([
  "Colorado",
  "Utah",
  "Oregon",
  "Washington",
  "Montana",
  "Vermont",
  "Alaska",
  "Idaho",
  "Wyoming",
]);

const LONG_LINES = [
  ["Men's waterproof three-layer technical shell jackets", 3_420, 248.5],
  ["Women's lightweight trail running shoes with rock plates", 5_870, 139.9],
  ["Ultralight two-person backpacking tents and footprints", 1_240, 389.0],
  ["Merino wool base layers and midweight thermal tops", 7_310, 84.2],
  ["Insulated stainless steel bottles and camp kitchen sets", 9_860, 36.7],
  ["Kids' fleece jackets, rain pants and all-weather boots", 4_150, 72.4],
] as const;

const SCATTER: GalleryVariant[] = [
  scatter(
    "scatter-countries",
    "Countries: orders against average order value, sized by revenue",
    countries("scatter_countries", 12, "Bigger markets do not mean bigger baskets"),
  ),
  scatter("scatter-channels", "Without size: marketing channels, one without data", {
    type: "scatter",
    id: "scatter_channels",
    title: "Email and SMS convert best on little traffic",
    span: 6,
    x: "sessions",
    y: "conversion_rate",
    column: "channel",
    points: MARKETING.map(([name, sessions, rate]) => ({
      key: name,
      label: name,
      x: sessions,
      y: rate,
    })).sort((a, b) => b.y - a.y),
    omittedPoints: 1,
    window: OCT,
  }),
  scatter("scatter-negative", "Negative values on both axes", {
    type: "scatter",
    id: "scatter_negative",
    title: "Shrinking categories also earn the least",
    span: 6,
    x: "revenue_growth",
    y: "contribution_margin",
    size: "revenue",
    column: "category",
    points: CATEGORY_GROWTH.map(([name, growth, margin, revenue]) => ({
      key: name,
      label: name,
      x: growth,
      y: margin,
      size: revenue,
    })).sort((a, b) => b.size - a.size),
    window: LAST_12,
  }),
  scatter("scatter-states", "Many points: 50 states and DC", {
    type: "scatter",
    id: "scatter_states",
    title: "Mountain states spend the most per customer",
    span: 12,
    x: "customers",
    y: "revenue_per_customer",
    column: "state",
    points: STATES.map(([name, population], i) => ({
      key: name,
      label: name,
      x: round(population * 1_180 * (1 + 0.18 * wobble(i, 1))),
      y: round((OUTDOOR_STATES.has(name) ? 214 : 158) * (1 + 0.12 * wobble(i, 2)), 0.01),
    })).sort((a, b) => b.y - a.y),
    window: LAST_12,
  }),
  scatter("scatter-long-labels", "Long category names", {
    type: "scatter",
    id: "scatter_long",
    title: "Tents sell rarely but carry the largest baskets",
    span: 6,
    x: "orders",
    y: "avg_order_value",
    size: "revenue",
    column: "product_line",
    points: LONG_LINES.map(([name, orders, aov]) => ({
      key: name,
      label: name,
      x: orders,
      y: aov,
      size: round(orders * aov),
    })).sort((a, b) => b.size - a.size),
    window: OCT,
  }),
  scatter("scatter-empty", "No data in the period", {
    type: "scatter",
    id: "scatter_empty",
    span: 6,
    x: "orders",
    y: "avg_order_value",
    size: "revenue",
    column: "country",
    points: [],
    window: OCT,
  }),
  scatter(
    "scatter-narrow",
    "Narrow card (span 4)",
    countries("scatter_narrow", 4, "Average order value against orders"),
  ),
];

export const GALLERY: GalleryVariant[] = [
  ...KPIS,
  ...LINES,
  ...GRAIN_LINES,
  ...INCOMPLETE_LINES,
  ...BARS,
  ...GRAIN_BARS,
  ...STACKED,
  ...INCOMPLETE_BARS,
  ...PIES,
  ...SCATTER,
  ...TABLES,
];

export type { KpiData };
/** The example dashboard rendered as a whole. */
export { SALES };
