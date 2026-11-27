import { afterAll, expect, it } from "vitest";
import { runDashboard } from "../../src/compiler/index.js";
import { runPeriodData } from "../../src/compiler/period-build.js";
import { customRangeDashboard } from "../../src/compiler/period-data.js";
import { createDuckDbExecutor } from "../../src/node/index.js";
import { PROJECT_DEFAULTS } from "../../src/spec/index.js";
import { metric, removeProjects, writeProject } from "./fixture.js";

afterAll(removeProjects);

it("keeps the exact series cutoff (HAT-73) for a timestamp source with a freshness lag", async () => {
  const pairs = [
    ["2026-10-31T19:00:00Z", 4],
    ["2026-11-01T05:40:00Z", 1],
    ["2026-11-01T05:50:00Z", 2],
    ["2026-11-01T06:40:00Z", 8],
    ["2026-11-01T06:50:00Z", 16],
    ["2026-11-01T08:45:00Z", 32],
  ] as const;
  const range = { start: "2026-10-31", end: "2026-11-02" };
  const { root, project } = await writeProject({
    "hatchmark.json": {
      ...PROJECT_DEFAULTS,
      name: "Horizon repro",
      timezone: "America/New_York",
      sources: { orders: { type: "csv", path: "orders.csv", freshness: { lag: { hours: 2 } } } },
    },
    "orders.csv": `at,v\n${pairs.map((pair) => pair.join(",")).join("\n")}\n`,
    "metrics/orders.json": metric({
      type: "aggregate",
      table: "orders",
      aggregate: "sum",
      column: "v",
      time: "at",
    }),
    "dashboards/d.json": {
      title: "D",
      period: { asOf: "2026-11-01", range: "last_7_days", compare: "none" },
      filters: [{ type: "period", id: "period", options: ["last_7_days"], default: "last_7_days" }],
      blocks: [
        { type: "kpi", id: "k", metric: "orders" },
        { type: "line", id: "l", metrics: ["orders"], grain: "day" },
      ],
    },
  });
  const db = await createDuckDbExecutor({ root, config: project.config.spec! });
  try {
    const base = await runDashboard(project, "d", db);
    const { data } = await runPeriodData(project, "d", db, base.data!);
    expect(data?.custom).toBeDefined();
    const sql = await runDashboard(project, "d", db, undefined, { period: range });
    const custom = customRangeDashboard(data!.custom!, "period", range);
    const values = (result: typeof custom) =>
      result.blocks.flatMap((b) => (b.type === "line" ? (b.series[0]?.values ?? []) : []));
    const oracle = pairs
      .filter(([t]) => t >= "2026-11-01T04:00:00Z" && t < "2026-11-01T06:45:00Z")
      .reduce((sum, [, v]) => sum + v, 0);
    expect(oracle).toBe(11);
    expect(values(sql.data!)).toEqual([4, oracle]);
    expect(custom.blocks.find((b) => b.id === "k")).toMatchObject({ value: 4 });
    expect(values(custom)).toEqual([4, oracle]);
  } finally {
    await db.close();
  }
});
