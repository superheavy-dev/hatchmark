import { fileURLToPath } from "node:url";
import { type DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";
import { afterAll, describe, expect, it } from "vitest";
import {
  explainDashboard,
  explainMetric,
  type KpiData,
  planDashboard,
  printSql,
  type SqlValue,
} from "../../src/compiler/index.js";
import { boundParams } from "../../src/node/duckdb.js";
import { createDuckDbExecutor } from "../../src/node/index.js";
import { PROJECT_DEFAULTS } from "../../src/spec/index.js";
import { loadAt, metric, removeProjects, run, writeProject } from "./fixture.js";

const ROOT = fileURLToPath(new URL("../../examples/global-sales/", import.meta.url));

afterAll(removeProjects);

async function bothWays(
  connection: DuckDBConnection,
  query: { sql: string; params: Record<string, SqlValue> },
): Promise<[string, string]> {
  const rows = async (text: string, params?: Record<string, SqlValue>) => {
    const bound = params && boundParams(params);
    return JSON.stringify(
      (await connection.runAndReadAll(text, bound?.values, bound?.types)).getRows(),
      (_, v) => (typeof v === "bigint" ? v.toString() : v),
    );
  };
  return [
    await rows(query.sql, query.params),
    await rows(printSql({ text: query.sql, params: query.params })),
  ];
}

async function withExecutor<T>(
  root: string,
  project: Awaited<ReturnType<typeof loadAt>>["project"],
  f: (executor: Awaited<ReturnType<typeof createDuckDbExecutor>>) => Promise<T>,
): Promise<T> {
  const config = project.config.spec;
  if (config === undefined) throw new Error("invalid hatchmark.yaml");
  const executor = await createDuckDbExecutor({ root, config });
  try {
    return await f(executor);
  } finally {
    await executor.close();
  }
}

describe("explain", () => {
  it("prints SQL that returns what the bound SQL returns, for every query of the example", async () => {
    const { project } = await loadAt(ROOT);
    const explained = await withExecutor(ROOT, project, async (executor) => {
      const dashboards = [];
      for (const name of [...project.dashboards.keys()].sort()) {
        dashboards.push(await explainDashboard(project, name, executor));
      }
      const metrics = [];
      for (const m of project.metrics.keys())
        metrics.push(await explainMetric(project, m, executor));
      return { dashboards, metrics };
    });
    for (const d of explained.dashboards) expect(d.diagnostics).toEqual([]);
    const queries = [
      ...explained.dashboards.flatMap((d) => (d.blocks ?? []).flatMap((b) => b.queries)),
      ...explained.metrics.flatMap((m) => m.queries ?? []),
    ];
    const planned = [...project.dashboards.keys()].flatMap(
      (name) => planDashboard(project, name).plan?.queries.map((q) => q.id) ?? [],
    );
    const ids = new Set(queries.map((q) => q.id));
    expect(planned.filter((id) => !ids.has(id))).toEqual([]);
    expect(queries.length).toBeGreaterThan(8);

    const connection = await (await DuckDBInstance.create(":memory:")).connect();
    await connection.run("SET TimeZone = 'UTC'");
    await connection.run(
      `CREATE TEMP TABLE "__hm_source_orders" AS SELECT *, row_number() OVER () AS "__hm_ord" FROM read_csv('${ROOT}data/orders.csv', sample_size = -1)`,
    );
    for (const query of queries) {
      const [bound, printed] = await bothWays(connection, query);
      expect(bound.length, query.id).toBeGreaterThan(2);
      expect(printed, query.id).toBe(bound);
    }
    connection.closeSync();
  });

  it("prints a fractional filter on a FLOAT column with the type it runs with", async () => {
    const { root } = await writeProject({
      "hatchmark.yaml": {
        ...PROJECT_DEFAULTS,
        name: "t",
        sources: { t: { type: "parquet", path: "data/t.parquet" } },
      },
      "metrics/tenths.yaml": metric({
        type: "aggregate",
        table: "t",
        aggregate: "count",
        time: "d",
        filters: [{ column: "x", op: "eq", value: 0.1 }],
      }),
      "data/.keep": "",
    });
    const connection = await (await DuckDBInstance.create(":memory:")).connect();
    await connection.run(
      `COPY (SELECT 0.1::FLOAT AS x, DATE '2026-01-15' AS d) TO '${root}/data/t.parquet' (FORMAT parquet)`,
    );
    const { project } = await loadAt(root);
    const result = await withExecutor(root, project, (e) => explainMetric(project, "tenths", e));
    expect(result.diagnostics).toEqual([]);
    const query = result.queries?.[0];
    if (query === undefined) throw new Error("no query");
    expect(printSql({ text: query.sql, params: query.params })).toContain(
      '"x" = CAST(0.1 AS DOUBLE)',
    );
    await connection.run(
      `CREATE TEMP TABLE "__hm_source_t" AS SELECT *, row_number() OVER () AS "__hm_ord" FROM read_parquet('${root}/data/t.parquet')`,
    );
    const [bound, printed] = await bothWays(connection, query);
    expect(printed).toBe(bound);
    connection.closeSync();
  });

  it("filters adjacent BIGINT values exactly, and prints what runs", async () => {
    const { root, project } = await writeProject({
      "hatchmark.yaml": {
        ...PROJECT_DEFAULTS,
        name: "t",
        sources: { t: { type: "csv", path: "data/t.csv" } },
      },
      "data/t.csv": "d,x\n2026-01-15,9007199254740996\n2026-01-15,9007199254740997\n",
      "metrics/exact.yaml": metric({
        type: "aggregate",
        table: "t",
        aggregate: "count",
        time: "d",
        filters: [{ column: "x", op: "eq", value: 9007199254740996 }],
      }),
      "dashboards/d.yaml": {
        title: "D",
        period: { asOf: "2026-01-31", range: "all_time", compare: "none" },
        blocks: [{ type: "kpi", metric: "exact" }],
      },
    });
    const built = await run(root, project, "d");
    expect((built.data?.blocks[0] as KpiData | undefined)?.value).toBe(1);
    const result = await withExecutor(root, project, (e) => explainMetric(project, "exact", e));
    const query = result.queries?.[0];
    if (query === undefined) throw new Error("no query");
    expect(printSql({ text: query.sql, params: query.params })).toContain(
      '"x" = CAST(9007199254740996 AS BIGINT)',
    );
    const connection = await (await DuckDBInstance.create(":memory:")).connect();
    await connection.run(
      `CREATE TEMP TABLE "__hm_source_t" AS SELECT *, row_number() OVER () AS "__hm_ord" FROM read_csv('${root}/data/t.csv', sample_size = -1)`,
    );
    const [bound, printed] = await bothWays(connection, query);
    expect(printed).toBe(bound);
    expect(JSON.parse(bound)[0][1]).toBe("1");
    connection.closeSync();
  });

  it("builds and prints a whole-number filter past int64 as HUGEINT", async () => {
    const { root, project } = await writeProject({
      "hatchmark.yaml": {
        ...PROJECT_DEFAULTS,
        name: "t",
        sources: { t: { type: "csv", path: "data/t.csv" } },
      },
      "data/t.csv": "d,x\n2026-01-15,5\n",
      "metrics/huge.yaml": metric({
        type: "aggregate",
        table: "t",
        aggregate: "count",
        time: "d",
        filters: [{ column: "x", op: "lt", value: 1e19 }],
      }),
      "dashboards/d.yaml": {
        title: "D",
        period: { asOf: "2026-01-15", range: "all_time", compare: "none" },
        blocks: [{ type: "kpi", metric: "huge" }],
      },
    });
    const built = await run(root, project, "d");
    expect(built.diagnostics).toEqual([]);
    expect((built.data?.blocks[0] as KpiData | undefined)?.value).toBe(1);
    const result = await withExecutor(root, project, (e) => explainMetric(project, "huge", e));
    const query = result.queries?.[0];
    if (query === undefined) throw new Error("no query");
    expect(printSql({ text: query.sql, params: query.params })).toContain(
      '"x" < CAST(10000000000000000000 AS HUGEINT)',
    );
    const connection = await (await DuckDBInstance.create(":memory:")).connect();
    await connection.run(
      `CREATE TEMP TABLE "__hm_source_t" AS SELECT *, row_number() OVER () AS "__hm_ord" FROM read_csv('${root}/data/t.csv', sample_size = -1)`,
    );
    const [bound, printed] = await bothWays(connection, query);
    expect(printed).toBe(bound);
    connection.closeSync();
  });

  it("reports the planner's warning for a block it leaves out, with no queries", async () => {
    const { root, project } = await writeProject({
      "hatchmark.yaml": {
        ...PROJECT_DEFAULTS,
        name: "t",
        sources: { orders: { type: "csv", path: "data/orders.csv" } },
      },
      "data/orders.csv": "ordered_at,status\n2026-01-01,paid\n",
      "segments/paid.yaml": {
        label: "Paid",
        filters: [{ column: "status", op: "eq", value: "paid" }],
      },
      "metrics/paid.yaml": metric({
        type: "aggregate",
        table: "orders",
        aggregate: "count",
        time: "ordered_at",
        segments: ["paid"],
      }),
      "dashboards/d.yaml": { title: "D", blocks: [{ type: "kpi", id: "k", metric: "paid" }] },
    });
    const [byMetric, byBlock] = await withExecutor(root, project, async (e) => [
      await explainMetric(project, "paid", e),
      await explainDashboard(project, "d", e, "k"),
    ]);
    expect(byMetric.queries).toBeUndefined();
    expect(byMetric.diagnostics.map((d) => [d.code, d.file])).toEqual([["HM4023", undefined]]);
    expect(byBlock.blocks).toBeUndefined();
    expect(byBlock.diagnostics.map((d) => [d.code, d.pointer])).toEqual([["HM4023", "/blocks/0"]]);
  });

  it("reads a metric by month over the last 12 months as of latest_data", async () => {
    const { project } = await loadAt(ROOT);
    const result = await withExecutor(ROOT, project, (e) => explainMetric(project, "revenue", e));
    expect(result.diagnostics).toEqual([]);
    expect(result.asOf).toBe("2026-10-31");
    expect(result.queries).toHaveLength(1);
    const printed = printSql({
      text: result.queries?.[0]?.sql ?? "",
      params: result.queries?.[0]?.params ?? {},
    });
    expect(printed).toContain("date_trunc('month'");
    expect(printed).toContain(">= CAST('2025-11-01' AS DATE)");
    expect(printed).toContain(
      "\"ordered_at\" < CAST('2026-10-31T22:54:53.000001Z' AS TIMESTAMPTZ)",
    );
    expect(printed).toContain("\"status\" = 'paid'");
  });

  it("reads a metric without a time column once, over all rows", async () => {
    const { root, project } = await writeProject({
      "hatchmark.yaml": {
        ...PROJECT_DEFAULTS,
        name: "t",
        sources: { items: { type: "csv", path: "data/items.csv" } },
      },
      "data/items.csv": "sku,price\na,1\nb,2\n",
      "metrics/skus.yaml": metric({ type: "aggregate", table: "items", aggregate: "count" }),
      "dashboards/d.yaml": {
        title: "D",
        period: { asOf: "2026-01-01" },
        blocks: [{ type: "kpi", metric: "skus" }],
      },
    });
    const result = await withExecutor(root, project, (e) => explainMetric(project, "skus", e));
    expect(result.diagnostics).toEqual([]);
    expect(result.asOf).toBeUndefined();
    expect(result.queries?.map((q) => q.sql)).toEqual([
      'SELECT count(*)\nFROM (SELECT * FROM "__hm_source_items") AS "hm_rows"',
    ]);
  });
});
