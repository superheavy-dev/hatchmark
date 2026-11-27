import type { Fix, Position } from "../../src/diagnostics/index.js";
import { type Project, parseSpecFile } from "../../src/spec/index.js";

function offsetOf(text: string, position: Position): number {
  let offset = 0;
  for (let line = 1; line < position.line; line++) {
    const brk = /\r\n|\r|\n/g;
    brk.lastIndex = offset;
    const match = brk.exec(text);
    if (!match) return text.length;
    offset = match.index + match[0].length;
  }
  let column = 1;
  while (column < position.column && offset < text.length) {
    offset += (text.codePointAt(offset) ?? 0) > 0xffff ? 2 : 1;
    column++;
  }
  return offset;
}

/** Applies one fix to the text it was produced from. */
export function applyFix(text: string, fix: Fix | undefined): string {
  if (fix === undefined) throw new Error("no fix");
  return (
    text.slice(0, offsetOf(text, fix.range.start)) +
    fix.text +
    text.slice(offsetOf(text, fix.range.end))
  );
}

export const CONFIG = {
  version: 1,
  name: "Parcelwise",
  dataDir: "data",
  metricsDir: "metrics",
  dashboardsDir: "dashboards",
  outDir: "dist",
  locale: "en-US",
  currency: "USD",
  timezone: "America/New_York",
  weekStart: "monday",
  theme: "default",
  telemetry: false,
  sources: {
    orders: { type: "csv", path: "data/orders.csv" },
    merchants: { type: "parquet", path: "data/merchants.parquet" },
  },
};

export const METRICS: Record<string, unknown> = {
  revenue: {
    label: "Revenue",
    type: "aggregate",
    table: "orders",
    aggregate: "sum",
    column: "amount",
    filters: [{ column: "status", op: "eq", value: "paid" }],
    time: "ordered_at",
    format: { type: "currency", compact: true },
    better: "up",
  },
  orders: {
    label: "Orders",
    type: "aggregate",
    table: "orders",
    aggregate: "count",
    time: "ordered_at",
    format: { type: "number" },
    better: "up",
  },
  avg_order_value: {
    label: "Average order value",
    type: "ratio",
    numerator: "revenue",
    denominator: "orders",
    format: { type: "currency" },
    better: "up",
  },
  merchants: {
    label: "Active merchants",
    type: "aggregate",
    table: "merchants",
    aggregate: "count_distinct",
    column: "merchant_id",
    format: { type: "number" },
    better: "up",
  },
  net_revenue: {
    label: "Net revenue",
    type: "sql",
    table: "orders",
    sql: "sum(amount) - sum(refund)",
    additive: true,
    time: "ordered_at",
    format: { type: "currency" },
    better: "up",
  },
};

export const DASHBOARD = {
  title: "Sales",
  period: { asOf: "latest_data", range: "last_12_months", compare: "previous_period" },
  filters: [{ type: "select", id: "region", column: "region" }],
  blocks: [
    { type: "kpi", metric: "revenue", span: 3 },
    { type: "kpi", metric: "merchants", compare: "none" },
    { type: "line", metrics: ["revenue", "net_revenue"], grain: "week" },
    { type: "area", metrics: ["revenue"], grain: "month", split: "plan", stack: true },
    { type: "bar", metrics: ["orders"], by: "plan", sort: { by: "orders", order: "desc" } },
    { type: "bar_list", metric: "revenue", by: "industry", limit: 8 },
    {
      type: "table",
      id: "by_country",
      by: ["region", "country"],
      metrics: ["revenue", "orders", "avg_order_value"],
      totals: true,
      percentOfTotal: ["revenue"],
    },
    { type: "text", markdown: "Revenue was {{revenue}}, {{ revenue.change_pct }} vs last month." },
  ],
};

/** Builds a project from in-memory JSON values (or raw text) without touching the disk. */
export function projectFrom(files: {
  config?: unknown;
  metrics?: Record<string, unknown>;
  dashboards?: Record<string, unknown>;
}): Project {
  const text = (v: unknown): string =>
    typeof v === "string" ? v : `${JSON.stringify(v, null, 2)}\n`;
  const project: Project = {
    config: parseSpecFile("project", "hatchmark.json", text(files.config ?? CONFIG)),
    metrics: new Map(),
    dashboards: new Map(),
    missingData: new Set(),
  };
  for (const [name, value] of Object.entries(files.metrics ?? METRICS)) {
    project.metrics.set(name, parseSpecFile("metric", `metrics/${name}.json`, text(value)));
  }
  for (const [name, value] of Object.entries(files.dashboards ?? { sales: DASHBOARD })) {
    project.dashboards.set(
      name,
      parseSpecFile("dashboard", `dashboards/${name}.json`, text(value)),
    );
  }
  return project;
}
