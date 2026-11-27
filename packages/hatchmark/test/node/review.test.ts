import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type BlockData,
  type KpiData,
  planDashboard,
  planHash,
  type TableData,
} from "../../src/compiler/index.js";
import { createDuckDbExecutor } from "../../src/node/index.js";
import { checkReferences, PROJECT_DEFAULTS, parseDiagnostics } from "../../src/spec/index.js";
import { applyFix } from "../spec/helpers.js";
import { loadAt, metric, Oracle, removeProjects, run, writeProject } from "./fixture.js";

// Regression tests for the review of hatchmark#8: HAT-22's probes and HAT-23's blockers.

let oracle: Oracle;
beforeAll(async () => {
  oracle = await Oracle.open();
});
afterAll(async () => {
  oracle.close();
  await removeProjects();
});

const MONTH = { asOf: "2026-02-28", range: "month_to_date", compare: "previous_period" };
const ALL = { asOf: "2026-02-28", range: "all_time", compare: "none" };
const CSV =
  "day,region,status,amount\n2026-01-15,West,paid,10.00\n2026-02-02,East,paid,20.00\n2026-02-10,West,void,30.00\n";
const REVENUE = metric({
  type: "aggregate",
  table: "orders",
  aggregate: "sum",
  column: "amount",
  time: "day",
});

async function probe(
  block: unknown,
  options: {
    period?: unknown;
    filters?: unknown[];
    extra?: Record<string, unknown>;
    text?: string;
  } = {},
) {
  const fixture = await writeProject({
    "hatchmark.json": {
      ...PROJECT_DEFAULTS,
      name: "Probe",
      sources: { orders: { type: "csv", path: "orders.csv" } },
    },
    "orders.csv": options.text ?? CSV,
    "metrics/revenue.json": REVENUE,
    "dashboards/probe.json": {
      title: "Probe",
      period: options.period ?? MONTH,
      filters: options.filters ?? [],
      blocks: [block],
    },
    ...options.extra,
  });
  return {
    ...fixture,
    checks: [...parseDiagnostics(fixture.project), ...checkReferences(fixture.project)],
  };
}

async function first(fixture: Awaited<ReturnType<typeof probe>>): Promise<BlockData> {
  expect(fixture.checks).toEqual([]);
  const { data, diagnostics } = await run(fixture.root, fixture.project, "probe");
  expect(diagnostics).toEqual([]);
  const block = data?.blocks[0];
  if (block === undefined) throw new Error("no block");
  return block;
}

describe("HAT-22 probes", () => {
  it("groups by the requested column when the source has a column named hm_d0", async () => {
    const text = CSV.trimEnd()
      .split("\n")
      .map((line, i) => `${line},${i === 0 ? "hm_d0" : "wrong"}`)
      .join("\n");
    const table = (await first(
      await probe({ type: "table", by: ["region"], metrics: ["revenue"] }, { text: `${text}\n` }),
    )) as TableData;
    expect(table.rows).toEqual([
      { keys: ["West"], values: { revenue: 30 } },
      { keys: ["East"], values: { revenue: 20 } },
    ]);
  });

  it("plans the comparison a bounded period filter default gives an all_time base", async () => {
    const kpi = await first(
      await probe(
        { type: "kpi", metric: "revenue" },
        {
          period: { ...ALL, compare: "previous_period" },
          filters: [
            {
              id: "period",
              type: "period",
              options: ["all_time", "month_to_date"],
              default: "month_to_date",
            },
          ],
        },
      ),
    );
    expect(kpi).toMatchObject({
      value: 50,
      previousValue: 10,
      change: 40,
      current: { start: "2026-02-01", end: "2026-03-01" },
    });
  });

  it("rejects a second period filter, so the dashboard and every block read one range", async () => {
    const fixture = await probe(
      { type: "kpi", metric: "revenue" },
      {
        filters: [
          { id: "a", type: "period", options: ["last_7_days"], default: "last_7_days" },
          { id: "b", type: "period", options: ["month_to_date"], default: "month_to_date" },
        ],
      },
    );
    expect(fixture.checks.map((d) => [d.code, d.pointer])).toEqual([["HM3007", "/filters/1"]]);
    const { data, diagnostics } = await run(fixture.root, fixture.project, "probe");
    expect(data).toBeUndefined();
    expect(diagnostics.map((d) => d.code)).toEqual(["HM3007"]);
  });

  it("rejects sort and limit on a time bar instead of ignoring them", async () => {
    const fixture = await probe({
      type: "bar",
      metrics: ["revenue"],
      grain: "day",
      limit: 1,
      sort: { by: "revenue", order: "desc" },
    });
    expect(fixture.checks.map((d) => [d.code, d.pointer])).toEqual([
      ["HM3007", "/blocks/0/sort"],
      ["HM3007", "/blocks/0/limit"],
    ]);
  });

  it("keeps an undefined SQL result null even when the metric is additive", async () => {
    const kpi = await first(
      await probe(
        { type: "kpi", metric: "unbounded" },
        {
          extra: {
            "metrics/unbounded.json": metric({
              type: "sql",
              table: "orders",
              time: "day",
              sql: "sum(amount / 0)",
              additive: true,
            }),
          },
        },
      ),
    );
    expect((kpi as KpiData).value).toBeNull();
  });

  it("puts each query's source file and reader options in the plan and its hash", async () => {
    const a = await probe({ type: "kpi", metric: "revenue" });
    const b = await probe(
      { type: "kpi", metric: "revenue" },
      {
        extra: {
          "hatchmark.json": {
            ...PROJECT_DEFAULTS,
            name: "Probe",
            sources: { orders: { type: "csv", path: "other.csv", delimiter: ";" } },
          },
          "other.csv": "day;amount\n2026-02-03;123\n",
        },
      },
    );
    expect(((await first(a)) as KpiData).value).toBe(50);
    expect(((await first(b)) as KpiData).value).toBe(123);
    const [planA, planB] = [
      planDashboard(a.project, "probe").plan,
      planDashboard(b.project, "probe").plan,
    ];
    if (planA === undefined || planB === undefined) throw new Error("no plan");
    expect(planB.queries[0]?.input).toEqual({ type: "csv", path: "other.csv", delimiter: ";" });
    expect(planHash(planA)).not.toBe(planHash(planB));
    expect(planA.queries[0]?.id).not.toBe(planB.queries[0]?.id);

    const config = b.project.config.spec;
    const query = planA.queries[0];
    if (config === undefined || query === undefined) throw new Error("no config");
    const executor = await createDuckDbExecutor({ root: b.root, config });
    try {
      const context = {
        asOf: "2026-02-28",
        timezone: "UTC",
        weekStart: "monday" as const,
        bindings: {},
      };
      await expect(executor.execute(query, context)).rejects.toThrow("differs from hatchmark.json");
    } finally {
      await executor.close();
    }
  });

  async function threadOutputs(blocks: unknown[], csv: string, runs: number) {
    const fixture = await writeProject({
      "hatchmark.json": {
        ...PROJECT_DEFAULTS,
        name: "Probe",
        sources: { orders: { type: "csv", path: "orders.csv" } },
      },
      "metrics/total.json": metric({
        type: "aggregate",
        table: "orders",
        aggregate: "sum",
        column: "amount",
      }),
      "metrics/mean.json": metric({
        type: "aggregate",
        table: "orders",
        aggregate: "avg",
        column: "amount",
      }),
      "dashboards/probe.json": { title: "Probe", period: ALL, blocks },
    });
    await oracle.run(`COPY (${csv}) TO '${path.join(fixture.root, "orders.csv")}' (HEADER)`);
    const loaded = await loadAt(fixture.root);
    const outputs = new Set<string>();
    let diagnostics: unknown[] = [];
    for (const threads of [1, 4, 8]) {
      for (let i = 0; i < runs; i++) {
        const result = await run(loaded.root, loaded.project, "probe", { threads });
        diagnostics = result.diagnostics;
        outputs.add(JSON.stringify(result.data?.blocks));
      }
    }
    return { outputs: [...outputs], diagnostics };
  }

  it("sums HAT-22's cancelling floats in file order, the same bytes at 1, 4 and 8 threads", async () => {
    const { outputs, diagnostics } = await threadOutputs(
      [
        { type: "kpi", id: "total", metric: "total" },
        { type: "kpi", id: "mean", metric: "mean" },
        { type: "table", by: ["k"], metrics: ["total", "mean"] },
      ],
      `SELECT CAST(i % 3 AS VARCHAR) AS k, v AS amount
       FROM (VALUES (0, 1e100), (1, 1e30), (2, 0.1), (3, -1e30), (4, -1e100), (5, 0.0)) b(block, v),
            range(122880) r(i)
       ORDER BY block, i`,
      4,
    );
    expect(outputs).toHaveLength(1);
    expect(diagnostics).toMatchObject([
      { code: "HM4004", severity: "warning", message: expect.stringContaining('"amount"') },
    ]);
  }, 120_000);

  it("sums 2M cents to the exact total, the same bytes at 1, 4 and 8 threads", async () => {
    const csv = `SELECT CASE i % 4 WHEN 0 THEN 'West' WHEN 1 THEN 'East' WHEN 2 THEN 'North' ELSE 'South' END AS region,
                        CAST((i * 7919) % 100000 AS DOUBLE) / 100 AS amount
                 FROM range(2000000) r(i)`;
    const { outputs, diagnostics } = await threadOutputs(
      [
        { type: "kpi", id: "total", metric: "total" },
        { type: "table", by: ["region"], metrics: ["total", "mean"] },
      ],
      csv,
      1,
    );
    expect(outputs).toHaveLength(1);
    expect(diagnostics).toEqual([]);
    const [exact] = await oracle.rows(
      `SELECT CAST(sum((i * 7919) % 100000) AS DOUBLE) / 100 AS total FROM range(2000000) r(i)`,
    );
    const blocks = JSON.parse(outputs[0] ?? "[]") as BlockData[];
    expect((blocks[0] as KpiData).value).toBe(exact?.total);
    expect((blocks[1] as TableData).total?.values.total).toBe(exact?.total);
  }, 120_000);

  it("warns with HM4004 only when a summed float column holds a value beyond ±1e15", async () => {
    const at = async (amount: string) => {
      const fixture = await probe(
        { type: "kpi", metric: "revenue" },
        { period: ALL, text: `day,amount\n2026-01-15,${amount}\n2026-01-16,0.5\n` },
      );
      const { diagnostics } = await run(fixture.root, fixture.project, "probe");
      return diagnostics.map((d) => d.code);
    };
    expect(await at("1e15")).toEqual([]);
    expect(await at("-1e15")).toEqual([]);
    expect(await at("1.5e15")).toEqual(["HM4004"]);
    expect(await at("-2e15")).toEqual(["HM4004"]);
  });
});

const NY = "America/New_York";
const ORDERS = `id,ordered_at,amount,p
1,2026-02-01T02:00:00Z,10.25,0.0000000004
2,2026-02-01T06:00:00Z,20.50,0.0000000004
3,2026-03-08T06:59:00Z,1,0.0000000015
4,2026-03-08T07:00:00Z,2,0.0000000015
5,2026-11-01T05:30:00Z,32,0.0000000004
`;

describe("HAT-23 blockers", () => {
  const count = (value: unknown, op = "gte") =>
    metric({
      type: "aggregate",
      table: "orders",
      aggregate: "count",
      time: "ordered_at",
      filters: [{ column: "ordered_at", op, value }],
    });
  const files = (metrics: Record<string, unknown>) => ({
    "hatchmark.json": {
      ...PROJECT_DEFAULTS,
      name: "Adv",
      timezone: NY,
      sources: { orders: { type: "csv", path: "orders.csv" } },
    },
    "orders.csv": ORDERS,
    ...Object.fromEntries(Object.entries(metrics).map(([n, m]) => [`metrics/${n}.json`, m])),
    "dashboards/probe.json": {
      title: "P",
      period: { asOf: "2026-12-31", range: "all_time", compare: "none" },
      blocks: Object.keys(metrics).map((m) => ({ type: "kpi", id: m, metric: m })),
    },
  });

  it("compares offset date-times as exact instants and local ones in the project time zone", async () => {
    const fixture = await writeProject(
      files({
        utc: count("2026-02-01T00:00:00Z"),
        tokyo: count("2026-02-01T00:00:00+09:00"),
        after_utc_4am: count("2026-02-01T04:00Z"),
        local_midnight: count("2026-02-01T00:00"),
        local_fraction: count("2026-03-08T01:59:00.5", "lte"),
        day: count("2026-02-01", "eq"),
      }),
    );
    expect(checkReferences(fixture.project)).toEqual([]);
    const { data, diagnostics } = await run(fixture.root, fixture.project, "probe");
    expect(diagnostics).toEqual([]);
    const csv = path.join(fixture.root, "orders.csv");
    const [o] = await oracle.rows(`
      SELECT count(*) FILTER (WHERE ordered_at >= TIMESTAMPTZ '2026-02-01 00:00:00+00') AS utc,
        count(*) FILTER (WHERE ordered_at >= TIMESTAMPTZ '2026-02-01 00:00:00+09') AS tokyo,
        count(*) FILTER (WHERE ordered_at >= TIMESTAMPTZ '2026-02-01 04:00:00+00') AS after_utc_4am,
        count(*) FILTER (WHERE ordered_at >= TIMESTAMPTZ '2026-02-01 05:00:00+00') AS local_midnight,
        count(*) FILTER (WHERE ordered_at <= TIMESTAMPTZ '2026-03-08 06:59:00.5+00') AS local_fraction,
        count(*) FILTER (WHERE CAST(ordered_at AT TIME ZONE '${NY}' AS DATE) = DATE '2026-02-01') AS day
      FROM read_csv('${csv}')`);
    expect(o).toEqual({
      utc: 5,
      tokyo: 5,
      after_utc_4am: 4,
      local_midnight: 4,
      local_fraction: 3,
      day: 1,
    });
    for (const [id, value] of Object.entries(o ?? {})) {
      expect((data?.blocks.find((b) => b.id === id) as KpiData | undefined)?.value, id).toBe(value);
    }
  });

  it("rejects values that are not strict ISO 8601 with HM3009, fixing near misses", async () => {
    const fixture = await writeProject(
      files({
        unpadded: count("2026-2-1", "eq"),
        spaced: count("2026-02-01 10:00"),
        number: count(20260201),
        word: count("yesterday"),
      }),
    );
    const found = checkReferences(fixture.project).filter((d) => d.code === "HM3009");
    expect(found.map((d) => [d.file, d.pointer, d.fix?.text, d.fix?.applicability])).toEqual([
      ["metrics/number.json", "/filters/0/value", undefined, undefined],
      ["metrics/spaced.json", "/filters/0/value", '"2026-02-01T10:00"', "unsafe"],
      ["metrics/unpadded.json", "/filters/0/value", '"2026-02-01"', "unsafe"],
      ["metrics/word.json", "/filters/0/value", undefined, undefined],
    ]);
    const unpadded = found.find((d) => d.file === "metrics/unpadded.json");
    const fixed = applyFix(
      fixture.project.metrics.get("unpadded")?.document.text ?? "",
      unpadded?.fix,
    );
    expect(JSON.parse(fixed).filters[0].value).toBe("2026-02-01");
    const { data, diagnostics } = await run(fixture.root, fixture.project, "probe");
    expect(data).toBeUndefined();
    expect(diagnostics.every((d) => d.code === "HM3009")).toBe(true);
  });

  it("sums and averages tiny floats without rounding them to a fixed number of decimals", async () => {
    const p = (aggregate: string, filters: unknown[] = []) =>
      metric({
        type: "aggregate",
        table: "orders",
        aggregate,
        column: "p",
        time: "ordered_at",
        filters,
      });
    const small = [{ column: "p", op: "lt", value: 0.000000001 }];
    const large = [{ column: "p", op: "gt", value: 0.000000001 }];
    const fixture = await writeProject(
      files({
        tiny_sum: p("sum", small),
        tiny_avg: p("avg", small),
        gwei_avg: p("avg", large),
        all_sum: p("sum"),
      }),
    );
    const { data, diagnostics } = await run(fixture.root, fixture.project, "probe");
    expect(diagnostics).toEqual([]);
    const value = (id: string) =>
      (data?.blocks.find((b) => b.id === id) as KpiData | undefined)?.value;
    expect(value("tiny_sum")).toBe(1.2e-9);
    expect(value("tiny_avg")).toBe(4e-10);
    expect(value("gwei_avg")).toBe(1.5e-9);
    expect(value("all_sum")).toBe(4.2e-9);
  });
});
