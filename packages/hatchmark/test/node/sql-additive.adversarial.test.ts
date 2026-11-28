import { afterAll, describe, expect, it } from "vitest";
import { metric, removeProjects, run, writeProject } from "./fixture.js";
import { METRICS } from "./periods.oracle.js";

afterAll(removeProjects);

async function kpi(sql: string, range: { start: string; end: string }) {
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
      "sold,amount,status\n2025-04-01,3,paid\n2025-04-03,,paid\n2025-04-05,10,paid\n2025-04-09,1,paid\n",
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
      blocks: [{ id: "net", type: "kpi", metric: "net" }],
    },
  });
  expect(diagnostics).toEqual([]);
  const result = await run(root, project, "probe");
  expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  const block = result.data?.blocks.find((b) => b.id === "net");
  return block?.type === "kpi" ? block.value : undefined;
}

const rows = { start: "2025-04-05", end: "2025-04-06" };
const nullRows = { start: "2025-04-03", end: "2025-04-04" };
const noRows = { start: "2025-04-06", end: "2025-04-08" };

describe("an additive SQL metric over no rows, null rows and non-numeric results", () => {
  it("a numeric result over no rows is 0, like a sum", async () => {
    expect(await kpi("sum(amount)", noRows)).toBe(0);
    expect(await kpi("sum(amount)", rows)).toBe(10);
  });

  it("rows that exist with only NULL values stay NULL, as SQL SUM does, and the oracle agrees", async () => {
    expect(await kpi("sum(amount)", nullRows)).toBeNull();
    expect(METRICS.net_sql?.([{ status: "paid", a: null } as never])).toBeNull();
    expect(METRICS.net_sql?.([])).toBe(0);
  });

  it.each(["sum(amount)::VARCHAR", "sum(amount)::BOOLEAN"])(
    "%s is not zero-filled: empty over rows and over no rows",
    async (sql) => {
      expect(await kpi(sql, rows)).toBeNull();
      expect(await kpi(sql, noRows)).toBeNull();
    },
  );
});
