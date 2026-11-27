import type {
  BarData,
  DashboardData,
  KpiData,
  LineData,
  MetricInfo,
  Series,
  TableData,
  Value,
} from "../src/compiler/dashboard-data.js";

/**
 * Sample DashboardData for the component gallery, golden tests and the workerd smoke test: a
 * fictional global online store ("Northwind Outfitters") with realistic seasonality, written by a
 * seeded generator so every run produces the same numbers.
 */

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

const rand = random(20261127);
const round = (v: number, step = 1) => Math.round(v / step) * step;

export const MONTHS = Array.from({ length: 24 }, (_, i) => {
  const m = 10 + i;
  return `${2024 + Math.floor(m / 12)}-${String((m % 12) + 1).padStart(2, "0")}-01`;
});

const SEASON = [0.86, 0.84, 0.95, 0.97, 1.0, 0.98, 0.96, 1.0, 1.04, 1.08, 1.28, 1.42];
const season = (date: string) => SEASON[Number(date.slice(5, 7)) - 1] as number;
const trend = (i: number, n: number) => 1 + (0.28 * i) / Math.max(1, n - 1);

export const REGIONS = [
  { name: "North America", share: 0.47 },
  { name: "Europe", share: 0.29 },
  { name: "Asia-Pacific", share: 0.17 },
  { name: "Latin America", share: 0.07 },
];

export const COUNTRIES: { name: string; region: string; share: number; aov: number }[] = [
  { name: "United States", region: "North America", share: 0.392, aov: 92.4 },
  { name: "United Kingdom", region: "Europe", share: 0.094, aov: 81.2 },
  { name: "Canada", region: "North America", share: 0.071, aov: 86.5 },
  { name: "Germany", region: "Europe", share: 0.068, aov: 88.9 },
  { name: "Australia", region: "Asia-Pacific", share: 0.052, aov: 95.1 },
  { name: "France", region: "Europe", share: 0.044, aov: 79.8 },
  { name: "Japan", region: "Asia-Pacific", share: 0.041, aov: 101.3 },
  { name: "Mexico", region: "Latin America", share: 0.029, aov: 58.4 },
  { name: "Netherlands", region: "Europe", share: 0.027, aov: 84.0 },
  { name: "Brazil", region: "Latin America", share: 0.026, aov: 54.7 },
  { name: "Spain", region: "Europe", share: 0.022, aov: 72.3 },
  { name: "South Korea", region: "Asia-Pacific", share: 0.02, aov: 77.6 },
  { name: "Sweden", region: "Europe", share: 0.017, aov: 90.2 },
  { name: "Singapore", region: "Asia-Pacific", share: 0.016, aov: 98.8 },
  { name: "India", region: "Asia-Pacific", share: 0.015, aov: 41.9 },
  { name: "Italy", region: "Europe", share: 0.014, aov: 75.5 },
  { name: "Ireland", region: "Europe", share: 0.011, aov: 87.1 },
  { name: "Chile", region: "Latin America", share: 0.009, aov: 61.0 },
  { name: "New Zealand", region: "Asia-Pacific", share: 0.009, aov: 89.4 },
  { name: "Colombia", region: "Latin America", share: 0.007, aov: 49.8 },
  { name: "Poland", region: "Europe", share: 0.006, aov: 63.2 },
  { name: "Switzerland", region: "Europe", share: 0.005, aov: 118.6 },
  { name: "Argentina", region: "Latin America", share: 0.003, aov: 52.1 },
  { name: "Côte d’Ivoire", region: "Africa", share: 0.002, aov: 46.3 },
];

export const CHANNELS = [
  { name: "Online store", share: 0.58 },
  { name: "Marketplace", share: 0.27 },
  { name: "Retail partners", share: 0.15 },
];

/** Monthly revenue over the 24 months, with seasonality, growth and noise. */
export const MONTHLY_REVENUE = MONTHS.map((m, i) =>
  round(1_220_000 * season(m) * trend(i, MONTHS.length) * (0.97 + rand() * 0.06)),
);

const usd = { type: "currency", currency: "USD" } as const;

export const METRICS: Record<string, MetricInfo> = {
  revenue: { name: "revenue", label: "Revenue", format: usd, better: "up" },
  orders: { name: "orders", label: "Orders", format: { type: "number" }, better: "up" },
  avg_order_value: {
    name: "avg_order_value",
    label: "Average order value",
    format: { ...usd, decimals: 2 },
    better: "up",
  },
  refund_rate: {
    name: "refund_rate",
    label: "Refund rate",
    format: { type: "percent", decimals: 1 },
    better: "down",
  },
  customers: { name: "customers", label: "Customers", format: { type: "number" }, better: "up" },
  net_cash_flow: {
    name: "net_cash_flow",
    label: "Net cash flow",
    format: usd,
    better: "up",
  },
  operating_margin: {
    name: "operating_margin",
    label: "Operating margin",
    format: { type: "currency", currency: "EUR" },
    better: "up",
  },
  returns: { name: "returns", label: "Returns", format: { type: "number" }, better: "down" },
  sessions: { name: "sessions", label: "Sessions", format: { type: "number" }, better: "neutral" },
};

const span = (start: string, end: string) => ({ start, end });
const OCT = span("2026-10-01", "2026-11-01");
const SEP = span("2026-09-01", "2026-10-01");
const LAST_12 = span("2025-11-01", "2026-11-01");
const WINDOW_24 = span("2024-11-01", "2026-11-01");

function kpi(
  id: string,
  metric: string,
  value: Value,
  previousValue: Value | undefined,
  extra: Partial<KpiData> = {},
): KpiData {
  const points = METRICS[metric]?.format.type === "percent";
  const change =
    value === null || previousValue === undefined || previousValue === null
      ? null
      : value - previousValue;
  const changePct: Value =
    value === null || previousValue === undefined || previousValue === null
      ? null
      : points
        ? value - previousValue
        : previousValue === 0
          ? null
          : value / previousValue - 1;
  return {
    type: "kpi",
    id,
    span: 3,
    metric,
    value,
    compare: previousValue === undefined ? "none" : "previous_period",
    current: OCT,
    ...(previousValue === undefined
      ? {}
      : {
          previous: SEP,
          previousValue,
          change,
          changePct,
          changeKind: points ? ("points" as const) : ("relative" as const),
        }),
    ...extra,
  };
}

const lastOct = MONTHLY_REVENUE[23] as number;
const lastSep = MONTHLY_REVENUE[22] as number;

/** The KPI strip of the example dashboard. */
export const SALES_KPIS: KpiData[] = [
  kpi("revenue", "revenue", lastOct, lastSep),
  kpi("orders", "orders", 21_874, 21_102),
  kpi("aov", "avg_order_value", 84.12, 86.37),
  kpi("refund_rate", "refund_rate", 0.0412, 0.0386),
];

function series(metric: string, label: string, values: Value[], splitValue?: string): Series {
  return {
    key: splitValue === undefined ? metric : `${metric}:${splitValue}`,
    metric,
    label,
    ...(splitValue === undefined ? {} : { splitValue }),
    values,
  };
}

const monthAxis = (n = 24) => ({
  kind: "time" as const,
  grain: "month" as const,
  buckets: MONTHS.slice(24 - n),
  window: n === 24 ? WINDOW_24 : LAST_12,
});

export const REVENUE_LINE: LineData = {
  type: "line",
  id: "revenue_by_month",
  title: "Revenue reached a record $1.84M in October",
  span: 8,
  axis: monthAxis(),
  series: [series("revenue", "Revenue", MONTHLY_REVENUE)],
};

const byRegion = REGIONS.map((region, k) =>
  series(
    "revenue",
    region.name,
    MONTHLY_REVENUE.map((v, i) =>
      round(
        v * region.share * (1 + (k === 2 ? 0.18 : -0.04) * (i / 23 - 0.5)) * (0.96 + rand() * 0.08),
      ),
    ),
    region.name,
  ),
);

export const REGION_LINE: LineData = {
  type: "line",
  id: "revenue_by_region",
  title: "Asia-Pacific is the fastest-growing region",
  span: 8,
  axis: monthAxis(),
  series: byRegion,
};

const top = COUNTRIES.slice(0, 10);
const octCountry = (c: (typeof COUNTRIES)[number]) =>
  round(lastOct * c.share * (0.97 + rand() * 0.06));

export const COUNTRY_BAR: BarData = {
  type: "bar",
  id: "revenue_by_country",
  title: "The United States brings in 39% of revenue",
  span: 4,
  orientation: "horizontal",
  stack: false,
  axis: { kind: "category", column: "country", categories: top.map((c) => c.name) },
  series: [series("revenue", "Revenue", top.map(octCountry))],
  omittedCategories: COUNTRIES.length - top.length,
};

const countryRevenue = COUNTRIES.map((c) => round(lastOct * c.share));
const totalRevenue = countryRevenue.reduce((a, b) => a + b, 0);
const countryOrders = COUNTRIES.map((c, i) => round((countryRevenue[i] as number) / c.aov));
const totalOrders = countryOrders.reduce((a, b) => a + b, 0);

export const COUNTRY_TABLE: TableData = {
  type: "table",
  id: "countries",
  title: "Five countries make up 68% of October revenue",
  span: 12,
  by: [{ column: "country", label: "Country" }],
  metrics: ["revenue", "orders", "avg_order_value"],
  percentOfTotal: ["revenue"],
  rows: COUNTRIES.slice(0, 12).map((c, i) => ({
    keys: [c.name],
    values: {
      revenue: countryRevenue[i] as number,
      orders: countryOrders[i] as number,
      avg_order_value:
        Math.round(((countryRevenue[i] as number) / (countryOrders[i] as number)) * 100) / 100,
    },
    share: { revenue: (countryRevenue[i] as number) / totalRevenue },
  })),
  rowCount: COUNTRIES.length,
  total: {
    values: {
      revenue: totalRevenue,
      orders: totalOrders,
      avg_order_value: Math.round((totalRevenue / totalOrders) * 100) / 100,
    },
    share: { revenue: 1 },
  },
  window: OCT,
};

function dashboard(
  name: string,
  title: string,
  blocks: DashboardData["blocks"],
  description?: string,
): DashboardData {
  return {
    version: 2,
    name,
    title,
    ...(description === undefined ? {} : { description }),
    project: "Northwind Outfitters",
    asOf: "2026-10-31",
    period: {
      range: "last_complete_month",
      compare: "previous_period",
      current: OCT,
      previous: SEP,
    },
    locale: "en-US",
    currency: "USD",
    timezone: "America/New_York",
    anchors: { week: "monday", quarter: "01-01", year: "01-01" },
    metrics: METRICS,
    blocks,
  };
}

/** The example dashboard: KPI strip, revenue line, top countries and the country table. */
export const SALES: DashboardData = dashboard("sales", "Sales overview", [
  ...SALES_KPIS,
  REVENUE_LINE,
  COUNTRY_BAR,
  COUNTRY_TABLE,
]);

export { dashboard, kpi, LAST_12, monthAxis, OCT, rand, round, SEP, series, span, WINDOW_24 };
