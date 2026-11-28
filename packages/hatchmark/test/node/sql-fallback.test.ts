import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  customRangeDashboard,
  type DashboardData,
  type ExecutionContext,
  type KpiData,
  type LineData,
  type PlannedQuery,
  runDashboard,
  runPeriodData,
  runSegmentData,
} from "../../src/compiler/index.js";
import { createDuckDbExecutor } from "../../src/node/index.js";
import { PROJECT_DEFAULTS } from "../../src/spec/index.js";
import { metric, Oracle, removeProjects, writeProject } from "./fixture.js";

const EVENTS = [
  "customer,day,status,region,amount",
  "a,2026-10-16,paid,US,2",
  "a,2026-10-17,paid,US,3",
  "b,2026-10-17,paid,US,5",
  "a,2026-10-17,void,US,7",
  "a,2026-10-17,paid,CA,11",
  ",2026-10-17,paid,US,13",
  "c,2026-10-18,paid,US,17",
  "a,2026-10-24,paid,US,19",
].join("\n");
const KEYS = "customer\na\na\n\n";
const RANGE = { start: "2026-10-17", end: "2026-10-19" };

let oracle: Oracle;
beforeAll(async () => {
  oracle = await Oracle.open();
});
afterAll(async () => {
  oracle.close();
  await removeProjects();
});

const sql = (text: string) =>
  metric({
    type: "sql",
    table: "rows",
    time: "day",
    sql: text,
    additive: true,
    segments: ["paid"],
  });

async function setup() {
  const { root, project } = await writeProject({
    "hatchmark.yaml": {
      ...PROJECT_DEFAULTS,
      name: "fallbacks",
      sources: {
        rows: { type: "csv", path: "data/rows.csv" },
        keys: { type: "csv", path: "data/keys.csv" },
      },
    },
    "data/rows.csv": EVENTS,
    "data/keys.csv": KEYS,
    "segments/paid.yaml": {
      label: "Paid",
      filters: [{ column: "status", op: "eq", value: "paid" }],
    },
    "segments/inside.yaml": {
      label: "Inside",
      filters: [{ column: "customer", op: "in_table", table: "keys", key: "customer" }],
    },
    "segments/outside.yaml": {
      label: "Outside",
      filters: [{ column: "customer", op: "not_in_table", table: "keys", key: "customer" }],
    },
    "metrics/row_count.yaml": metric({
      type: "aggregate",
      table: "rows",
      time: "day",
      aggregate: "count",
      segments: ["paid"],
    }),
    "metrics/zero_sum.yaml": sql("coalesce(sum(amount), 0)"),
    "metrics/fallback_sum.yaml": sql("coalesce(sum(amount), 99)"),
    "dashboards/d.yaml": {
      title: "Fallbacks",
      period: { asOf: "2026-10-31", range: "all_time", compare: "none" },
      filters: [
        { type: "period", id: "p", options: ["last_30_days"], default: "last_30_days" },
        { type: "segment", id: "seg", segments: ["inside", "outside"] },
        { type: "select", id: "region", column: "region", default: "US" },
      ],
      blocks: ["row_count", "zero_sum", "fallback_sum"].map((m) => ({
        type: "kpi",
        id: m,
        metric: m,
      })),
    },
    "dashboards/lines.yaml": {
      title: "Fallback lines",
      period: { asOf: "2026-10-31", range: "all_time", compare: "none" },
      filters: [{ type: "period", id: "p", options: ["last_30_days"], default: "last_30_days" }],
      blocks: [
        { type: "kpi", id: "k", metric: "fallback_sum" },
        { type: "line", id: "l", metrics: ["zero_sum", "fallback_sum"], grain: "day" },
      ],
    },
  });
  await oracle.run(
    `CREATE OR REPLACE TABLE fb_rows AS SELECT * FROM read_csv('${root}/data/rows.csv', header = true, columns = {'customer': 'VARCHAR', 'day': 'DATE', 'status': 'VARCHAR', 'region': 'VARCHAR', 'amount': 'INTEGER'})`,
  );
  await oracle.run(
    `CREATE OR REPLACE TABLE fb_keys AS SELECT * FROM read_csv('${root}/data/keys.csv', header = true, columns = {'customer': 'VARCHAR'})`,
  );
  const config = project.config.spec;
  if (config === undefined) throw new Error("invalid hatchmark.yaml");
  return { project, executor: await createDuckDbExecutor({ root, config, threads: 1 }) };
}

const values = (data: DashboardData | undefined) =>
  (data?.blocks ?? []).map((b) => (b as KpiData).value);

async function truth(selected: readonly string[], range?: { start: string; end: string }) {
  const where = [
    "status = 'paid'",
    "region = 'US'",
    ...selected.map(
      (s) =>
        `${s === "inside" ? "" : "NOT "}EXISTS (SELECT 1 FROM fb_keys k WHERE r.customer = k.customer)`,
    ),
    ...(range ? [`day >= DATE '${range.start}' AND day < DATE '${range.end}'`] : []),
  ].join(" AND ");
  const [row] = await oracle.rows(
    `SELECT count(*) AS n, coalesce(sum(amount), 0) AS z, coalesce(sum(amount), 99) AS f FROM fb_rows r WHERE ${where}`,
  );
  return [Number(row?.n), Number(row?.z), Number(row?.f)];
}

describe("SQL metrics with a fallback for no rows", () => {
  it("give what DuckDB gives over the rows, in presets and custom ranges, for every segment state", async () => {
    const { project, executor } = await setup();
    try {
      const base = await runDashboard(project, "d", executor);
      const segments = await runSegmentData(project, "d", executor, base.data as DashboardData);
      const states = Object.values(segments.data?.states ?? {});
      expect(states.length).toBe(4);
      for (const state of states) {
        const key = state.selected.join(",") || "none";
        expect(values(state.data), key).toEqual(await truth(state.selected));
        const periods = await runPeriodData(
          project,
          "d",
          executor,
          state.data,
          undefined,
          { seg: state.selected },
          "2026-10-16",
        );
        const custom = periods.data?.custom;
        if (custom === undefined) throw new Error("no custom range cube");
        expect(custom.presetOnly, key).toEqual(["fallback_sum"]);
        const cube = customRangeDashboard(custom, "p", RANGE);
        const [n, z] = await truth(state.selected, RANGE);
        expect(values(cube).slice(0, 2), key).toEqual([n, z]);
        expect((cube.blocks[2] as KpiData).presetOnly, key).toBe(true);
        const bound = await runDashboard(project, "d", executor, undefined, {
          p: RANGE,
          seg: state.selected,
        });
        expect(values(bound.data), key).toEqual(await truth(state.selected, RANGE));
      }
    } finally {
      await executor.close();
    }
  });

  it("leave days without rows empty and need a preset when the empty set fails to compute", async () => {
    const { project, executor } = await setup();
    const failing = new Proxy(executor, {
      get(target, key) {
        if (key === "execute")
          return (query: PlannedQuery, context: ExecutionContext) =>
            query.noRows
              ? Promise.reject(new Error("no empty set"))
              : target.execute(query, context);
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    try {
      const base = await runDashboard(project, "lines", failing);
      expect(base.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
      const data = base.data as DashboardData;
      const [paid] = await oracle.rows(
        "SELECT coalesce(sum(amount), 99) AS f FROM fb_rows WHERE status = 'paid' AND day >= DATE '2026-10-01' AND day < DATE '2026-10-31'",
      );
      expect((data.blocks[0] as KpiData).value).toBe(Number(paid?.f));
      const line = data.blocks[1] as LineData;
      if (line.axis.kind !== "time") throw new Error("no time axis");
      const quiet = line.axis.buckets.indexOf("2026-10-20");
      expect(quiet).toBeGreaterThanOrEqual(0);
      expect(line.series.map((s) => s.values[quiet])).toEqual([null, null]);
      const periods = await runPeriodData(
        project,
        "lines",
        failing,
        data,
        undefined,
        undefined,
        "2026-10-16",
      );
      const custom = periods.data?.custom;
      if (custom === undefined) throw new Error("no custom range cube");
      expect(custom.presetOnly).toEqual(["fallback_sum", "zero_sum"]);
      expect((customRangeDashboard(custom, "p", RANGE).blocks[0] as KpiData).presetOnly).toBe(true);
      expect(
        periods.diagnostics
          .filter((d) => d.code === "HM4041")
          .map((d) => [d.severity, d.message.includes("could not be computed")]),
      ).toEqual([
        ["note", true],
        ["note", true],
      ]);
      expect(periods.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    } finally {
      await executor.close();
    }
  });
});
