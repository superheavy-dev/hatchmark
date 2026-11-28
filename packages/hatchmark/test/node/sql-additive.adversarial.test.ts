import { afterAll, describe, expect, it } from "vitest";
import { runPeriodData } from "../../src/compiler/period-build.js";
import { customRangeDashboard } from "../../src/compiler/period-data.js";
import { planDashboard } from "../../src/compiler/planner.js";
import { createDuckDbExecutor } from "../../src/node/index.js";
import { metric, removeProjects, run, writeProject } from "./fixture.js";
import { METRICS } from "./periods.oracle.js";

afterAll(removeProjects);

type Range = { start: string; end: string };

async function kpi(
  sql: string,
  range: Range,
): Promise<{ preset: unknown; custom: unknown; counted: boolean }> {
  const { root, project, diagnostics } = await writeProject({
    "hatchmark.yaml": {
      version: 1,
      name: "Additive SQL",
      timezone: "UTC",
      telemetry: false,
      locale: "en-US",
      currency: "USD",
      weekStart: "sunday",
      theme: "default",
      dataDir: "data",
      metricsDir: "metrics",
      dashboardsDir: "dashboards",
      outDir: "dist",
      sources: { sales: { type: "csv", path: "data/sales.csv" } },
    },
    "data/sales.csv":
      "sold,amount,status,flag\n2025-04-01,3,paid,true\n2025-04-03,,paid,false\n2025-04-05,10,paid,true\n2025-04-09,1,paid,false\n",
    "metrics/net.yaml": metric({
      type: "sql",
      table: "sales",
      time: "sold",
      sql,
      additive: true,
      filters: [{ column: "status", op: "eq", value: "paid" }],
    }),
    "dashboards/probe.yaml": {
      title: "Probe",
      period: { asOf: "2025-04-09", range, compare: "none" },
      filters: [{ type: "period", id: "period", options: [range], default: range }],
      blocks: [{ id: "net", type: "kpi", metric: "net" }],
    },
  });
  expect(diagnostics).toEqual([]);
  const result = await run(root, project, "probe");
  expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  const config = project.config.spec;
  if (config === undefined || result.data === undefined) throw new Error("no dashboard data");
  const executor = await createDuckDbExecutor({ root, config });
  try {
    const { data } = await runPeriodData(project, "probe", executor, result.data);
    if (data?.custom === undefined) throw new Error("no custom range data");
    const custom = customRangeDashboard(data.custom, "period", range);
    const value = (blocks: readonly { id: string; type: string }[]) => {
      const block = blocks.find((b) => b.id === "net");
      return block !== undefined && "value" in block ? block.value : undefined;
    };
    const plan = planDashboard(project, "probe").plan;
    const counted =
      plan?.queries.some((q) => q.measures.some((m) => m.rows !== undefined)) ?? false;
    return { preset: value(result.data.blocks), custom: value(custom.blocks), counted };
  } finally {
    await executor.close();
  }
}

const rows = { start: "2025-04-05", end: "2025-04-06" };
const nullRows = { start: "2025-04-03", end: "2025-04-04" };
const noRows = { start: "2025-04-06", end: "2025-04-08" };

describe("an additive SQL metric over no rows: plain SUM and COUNT zero-fill, nothing else does", () => {
  it("a numeric result over no rows is 0, like a sum, in presets and custom ranges", async () => {
    expect(await kpi("sum(amount)", noRows)).toEqual({ preset: 0, custom: 0, counted: true });
    expect(await kpi("sum(amount)", rows)).toEqual({ preset: 10, custom: 10, counted: true });
    expect(await kpi("count(*)", noRows)).toEqual({ preset: 0, custom: 0, counted: true });
  });

  it("a plain sum over a BOOLEAN column plans exactly as before: no row count", async () => {
    expect(await kpi("sum(flag)", rows)).toMatchObject({ preset: 1, counted: false });
  });

  it("an expression with its own fallback keeps it over no rows in a preset", async () => {
    expect((await kpi("coalesce(sum(coalesce(amount, 0)), 99)", noRows)).preset).toBe(99);
  });

  it("rows that exist with only NULL values stay NULL, as SQL SUM does, and the oracle agrees", async () => {
    expect((await kpi("sum(amount)", nullRows)).preset).toBeNull();
    expect(METRICS.net_sql?.([{ status: "paid", a: null } as never])).toBeNull();
    expect(METRICS.net_sql?.([])).toBe(0);
  });

  it.each([
    "sum(amount)::VARCHAR",
    "sum(amount)::BOOLEAN",
    "sum(amount) * INTERVAL '1 day'",
    "list(amount)",
    "sum(amount) * 1",
  ])("%s is not zero-filled: empty over no rows in presets and custom ranges", async (sql) => {
    expect(await kpi(sql, noRows)).toEqual({ preset: null, custom: null, counted: false });
  });

  it.each(["sum(amount)::VARCHAR", "sum(amount)::BOOLEAN", "sum(amount) * INTERVAL '1 day'"])(
    "%s stays empty over rows",
    async (sql) => {
      expect((await kpi(sql, rows)).preset).toBeNull();
    },
  );
});
