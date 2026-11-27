import { fileURLToPath } from "node:url";
import { DuckDBInstance } from "@duckdb/node-api";
import { afterAll, describe, expect, it } from "vitest";
import {
  explainDashboard,
  explainMetric,
  planDashboard,
  printSql,
} from "../../src/compiler/index.js";
import { createDuckDbExecutor } from "../../src/node/index.js";
import { PROJECT_DEFAULTS } from "../../src/spec/index.js";
import { loadAt, metric, removeProjects, writeProject } from "./fixture.js";

const ROOT = fileURLToPath(new URL("../../examples/global-sales/", import.meta.url));

afterAll(removeProjects);

async function withExecutor<T>(
  root: string,
  project: Awaited<ReturnType<typeof loadAt>>["project"],
  f: (executor: Awaited<ReturnType<typeof createDuckDbExecutor>>) => Promise<T>,
): Promise<T> {
  const config = project.config.spec;
  if (config === undefined) throw new Error("invalid hatchmark.json");
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
      const sales = await explainDashboard(project, "sales", executor);
      const metrics = await Promise.all(
        [...project.metrics.keys()].map((m) => explainMetric(project, m, executor)),
      );
      return { sales, metrics };
    });
    expect(explained.sales.diagnostics).toEqual([]);
    const queries = [
      ...(explained.sales.blocks ?? []).flatMap((b) => b.queries),
      ...explained.metrics.flatMap((m) => m.queries ?? []),
    ];
    const plan = planDashboard(project, "sales").plan;
    expect(new Set(queries.map((q) => q.id))).toEqual(
      new Set([...(plan?.queries.map((q) => q.id) ?? []), ...queries.map((q) => q.id)]),
    );
    expect(queries.length).toBeGreaterThan(8);

    const connection = await (await DuckDBInstance.create(":memory:")).connect();
    await connection.run("SET TimeZone = 'UTC'");
    await connection.run(
      `CREATE TEMP TABLE "__hm_source_orders" AS SELECT *, row_number() OVER () AS "__hm_ord" FROM read_csv('${ROOT}data/orders.csv', sample_size = -1)`,
    );
    const rows = async (text: string, params?: Record<string, string | number | boolean>) =>
      JSON.stringify((await connection.runAndReadAll(text, params)).getRows(), (_, v) =>
        typeof v === "bigint" ? v.toString() : v,
      );
    for (const query of queries) {
      const bound = await rows(query.sql, query.params);
      expect(bound.length, query.id).toBeGreaterThan(2);
      expect(await rows(printSql({ text: query.sql, params: query.params })), query.id).toBe(bound);
    }
    connection.closeSync();
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
    expect(printed).toContain("< CAST('2026-11-01' AS DATE)");
    expect(printed).toContain("\"status\" = 'paid'");
  });

  it("reads a metric without a time column once, over all rows", async () => {
    const { root, project } = await writeProject({
      "hatchmark.json": {
        ...PROJECT_DEFAULTS,
        name: "t",
        sources: { items: { type: "csv", path: "data/items.csv" } },
      },
      "data/items.csv": "sku,price\na,1\nb,2\n",
      "metrics/skus.json": metric({ type: "aggregate", table: "items", aggregate: "count" }),
      "dashboards/d.json": {
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
