import { afterAll, describe, expect, it, vi } from "vitest";
import type { BarData, DashboardData, KpiData, LineData } from "../../src/compiler/index.js";
import { PROJECT_DEFAULTS } from "../../src/spec/index.js";
import { metric, removeProjects, run, writeProject } from "./fixture.js";

vi.setConfig({ testTimeout: 120_000 });

afterAll(removeProjects);

const ORDERS = ["day,region,amount,units", "2026-01-10,East,80,5", "2026-01-20,West,20,6"].join(
  "\n",
);

const ORACLE = {
  revenue: 80 + 20,
  revenuePlan: 100,
  elapsed: 20 / 31,
  average: (80 + 20) / 2,
  averagePlan: 50,
};

const block = (type: string, id: string, rest: Record<string, unknown>) => ({ type, id, ...rest });

async function build(): Promise<DashboardData> {
  const { root, project } = await writeProject({
    "hatchmark.yaml": {
      ...PROJECT_DEFAULTS,
      name: "attainment",
      sources: { orders: { type: "csv", path: "data/orders.csv" } },
    },
    "data/orders.csv": ORDERS,
    "metrics/revenue.yaml": metric({
      type: "aggregate",
      table: "orders",
      aggregate: "sum",
      column: "amount",
      time: "day",
      targets: [{ id: "plan", grain: "month", values: { "2026-01-01": ORACLE.revenuePlan } }],
    }),
    "metrics/units.yaml": metric({
      type: "aggregate",
      table: "orders",
      aggregate: "sum",
      column: "units",
      time: "day",
    }),
    "metrics/average.yaml": metric({
      type: "aggregate",
      table: "orders",
      aggregate: "avg",
      column: "amount",
      time: "day",
      targets: [{ id: "avg", grain: "month", values: { "2026-01-01": ORACLE.averagePlan } }],
    }),
    "dashboards/d.yaml": {
      title: "D",
      period: {
        asOf: "2026-02-15",
        range: { start: "2026-01-01", end: "2026-02-01" },
        compare: "none",
      },
      blocks: [
        block("kpi", "kpi", { metric: "revenue", target: "plan" }),
        block("bar", "limited", { metrics: ["revenue"], by: "region", limit: 1, target: "plan" }),
        block("bar", "grouped", { metrics: ["units", "revenue"], by: "region", target: "plan" }),
        block("line", "split", {
          metrics: ["revenue"],
          grain: "month",
          split: "region",
          target: "plan",
        }),
        block("kpi", "avg_kpi", { metric: "average", target: "avg" }),
        block("bar", "avg_bar", { metrics: ["average"], by: "region", target: "avg" }),
        block("line", "avg_split", {
          metrics: ["average"],
          grain: "month",
          split: "region",
          target: "avg",
        }),
      ],
    },
  });
  return (await run(root, project, "d")).data as DashboardData;
}

const find = <T>(data: DashboardData, id: string) => data.blocks.find((b) => b.id === id) as T;

describe("attainment pairs each target with the value of the metric that owns it", () => {
  it("agrees across a KPI, a limited bar, a grouped bar and a split line", async () => {
    const data = await build();
    const expected = ORACLE.revenue / (ORACLE.revenuePlan * ORACLE.elapsed);
    expect(find<KpiData>(data, "kpi").target?.attainment).toBeCloseTo(expected, 12);
    const limited = find<BarData>(data, "limited");
    expect(limited.axis.kind === "category" && limited.axis.categories).toEqual(["East"]);
    expect(limited.target?.window?.attainment).toBeCloseTo(expected, 12);
    expect(find<BarData>(data, "grouped").target?.window?.attainment).toBeCloseTo(expected, 12);
    const split = find<LineData>(data, "split");
    expect(split.target?.attainment?.[0]).toBeCloseTo(expected, 12);
  });

  it("reads a non-additive metric over the whole scope, never as a sum of its parts", async () => {
    const data = await build();
    const expected = ORACLE.average / ORACLE.averagePlan;
    expect(find<KpiData>(data, "avg_kpi").target?.attainment).toBeCloseTo(expected, 12);
    expect(find<BarData>(data, "avg_bar").target?.window?.attainment).toBeCloseTo(expected, 12);
    expect(find<LineData>(data, "avg_split").target?.attainment?.[0]).toBeCloseTo(expected, 12);
  });
});
