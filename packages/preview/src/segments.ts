import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";

/**
 * Dashboards that show every variant of the segment filter on the global-sales sample data, built
 * into the preview's segments/ folder: toggles alone, toggles with one segment on by default, and
 * toggles next to period presets, and toggles next to the calendar and the grain filter.
 */
const KPIS = [
  { type: "kpi", id: "revenue", metric: "revenue", sparkline: true },
  { type: "kpi", id: "orders", metric: "orders" },
  { type: "kpi", id: "aov", metric: "avg_order_value" },
  { type: "kpi", id: "refund_rate", metric: "refund_rate" },
];
const REGION_LINE = {
  type: "line",
  id: "revenue_by_region",
  title: "Revenue by region",
  metrics: ["revenue"],
  grain: "month",
  split: "region",
  span: 8,
};
const CHANNEL_BARS = {
  type: "bar",
  id: "revenue_by_channel",
  title: "Revenue by channel",
  metrics: ["revenue"],
  by: "channel",
  orientation: "horizontal",
  span: 4,
};
const COUNTRIES = {
  type: "table",
  id: "countries",
  title: "Top countries",
  by: ["country"],
  metrics: ["revenue", "orders", "customers"],
  percentOfTotal: ["revenue"],
  limit: 8,
};

const SEGMENTS: Record<string, unknown> = {
  paid_marketing: {
    label: "Paid marketing",
    description: "Orders from paid search, social and affiliate channels.",
    filters: [{ column: "channel", op: "in", values: ["Paid search", "Social", "Affiliate"] }],
  },
  americas: { label: "Americas", filters: [{ column: "region", op: "eq", value: "Americas" }] },
  large_orders: {
    label: "Orders of $100+",
    filters: [{ column: "amount", op: "gte", value: 100 }],
  },
};

const DASHBOARDS: Record<string, unknown> = {
  toggles: {
    title: "Segment toggles",
    description: "Three segments, none on: every chart reads all orders until you turn one on.",
    filters: [
      {
        type: "segment",
        id: "segments",
        segments: ["paid_marketing", "americas", "large_orders"],
      },
    ],
    blocks: [...KPIS, REGION_LINE, CHANNEL_BARS, COUNTRIES],
  },
  "default-on": {
    title: "Paid marketing first",
    description: "Opens with Paid marketing on; turn it off to see every channel.",
    filters: [
      {
        type: "segment",
        id: "audience",
        label: "Audience",
        segments: ["paid_marketing", "large_orders"],
        default: ["paid_marketing"],
      },
    ],
    blocks: [...KPIS, CHANNEL_BARS, { ...REGION_LINE, span: 8 }],
  },
  explorer: {
    title: "Segments with every filter",
    description:
      "Segments next to the calendar and the grain filter: every range and grain follows.",
    period: { asOf: "latest_data", range: "last_12_months", compare: "previous_period" },
    filters: [
      {
        type: "period",
        id: "period",
        options: [{ last: 30, unit: "day" }, { to_date: "quarter" }, { last: 12, unit: "month" }],
        default: { last: 12, unit: "month" },
      },
      { type: "grain", id: "grain", options: ["week", "month"], default: "month" },
      { type: "segment", id: "segments", segments: ["paid_marketing", "americas"] },
    ],
    blocks: [...KPIS, { ...REGION_LINE, grains: ["week", "month"] }, CHANNEL_BARS, COUNTRIES],
  },
  "with-periods": {
    title: "Segments and presets",
    description:
      "A segment filter next to period presets: each preset is built for each combination.",
    filters: [
      {
        type: "period",
        id: "period",
        options: ["last_30_days", "last_90_days", "year_to_date", "last_12_months"],
        default: "last_90_days",
        custom: false,
      },
      { type: "segment", id: "segments", segments: ["paid_marketing", "americas"] },
    ],
    blocks: [...KPIS, { ...REGION_LINE, grain: "week" }, CHANNEL_BARS],
  },
};

/** A copy of the global-sales example with the segment variants added; remove it when done. */
export function segmentProject(example: string): string {
  const root = mkdtempSync(join(tmpdir(), "hatchmark-preview-segments-"));
  cpSync(example, root, { recursive: true });
  rmSync(join(root, "dist"), { recursive: true, force: true });
  mkdirSync(join(root, "segments"));
  for (const [name, spec] of Object.entries(SEGMENTS)) {
    writeFileSync(join(root, "segments", `${name}.yaml`), stringify(spec));
  }
  for (const [name, spec] of Object.entries(DASHBOARDS)) {
    writeFileSync(join(root, "dashboards", `${name}.yaml`), stringify(spec));
  }
  return root;
}
