import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";

const KPIS = [
  { type: "kpi", id: "revenue", metric: "revenue", sparkline: true },
  { type: "kpi", id: "orders", metric: "orders" },
  { type: "kpi", id: "aov", metric: "avg_order_value" },
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

const DASHBOARDS: Record<string, unknown> = {
  "presets-only": {
    title: "Presets only",
    description:
      'A period filter with "custom": false: named presets, no calendar, a smaller page.',
    filters: [
      {
        type: "period",
        id: "period",
        options: ["last_7_days", "last_30_days", "last_90_days", "year_to_date", "last_12_months"],
        default: "last_90_days",
        custom: false,
      },
    ],
    blocks: [...KPIS, { ...REGION_LINE, grain: "week" }, CHANNEL_BARS],
  },
  "distinct-counts": {
    title: "Distinct customers",
    description:
      "Customers is a distinct count: every preset is exact, and a custom range asks for a preset.",
    filters: [
      {
        type: "period",
        id: "period",
        options: [
          { to_date: "month" },
          { last_complete: "month" },
          { last_complete: "quarter" },
          { to_date: "year" },
        ],
        default: { last_complete: "quarter" },
      },
    ],
    blocks: [...KPIS, { type: "kpi", id: "customers", metric: "customers" }, COUNTRIES],
  },
  "fixed-dates": {
    title: "Holiday season",
    description: "Presets that are fixed dates, next to all time.",
    period: { asOf: "latest_data", range: "all_time", compare: "none" },
    filters: [
      {
        type: "period",
        id: "season",
        label: "Season",
        options: [
          { start: "2024-11-01", end: "2025-01-01" },
          { start: "2025-11-01", end: "2026-01-01" },
          { start: "2025-11-28", end: "2025-12-02" },
          "all_time",
        ],
        default: { start: "2025-11-01", end: "2026-01-01" },
      },
      { type: "grain", id: "grain", options: ["day", "week"], default: "day" },
    ],
    blocks: [
      { type: "kpi", id: "revenue", metric: "revenue" },
      { type: "kpi", id: "orders", metric: "orders" },
      { ...REGION_LINE, grain: "day", grains: ["day", "week"], span: 12 },
    ],
  },
};

export function periodProject(example: string): string {
  const root = mkdtempSync(join(tmpdir(), "hatchmark-preview-periods-"));
  cpSync(example, root, { recursive: true });
  rmSync(join(root, "dist"), { recursive: true, force: true });
  for (const [name, spec] of Object.entries(DASHBOARDS)) {
    writeFileSync(join(root, "dashboards", `${name}.yaml`), stringify(spec));
  }
  return root;
}
