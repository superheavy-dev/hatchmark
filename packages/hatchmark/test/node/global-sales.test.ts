import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type BarData,
  canonicalJson,
  type DashboardData,
  type KpiData,
  type LineData,
  planDashboard,
  planHash,
  type TableData,
} from "../../src/compiler/index.js";
import { checkReferences, parseDiagnostics } from "../../src/spec/index.js";
import { loadAt, Oracle, run } from "./fixture.js";

const ROOT = fileURLToPath(new URL("../../examples/global-sales/", import.meta.url));
const CSV = `${ROOT}data/orders.csv`;
const LOCAL = "(ordered_at AT TIME ZONE 'America/New_York')";
const CURRENT = `${LOCAL} >= TIMESTAMP '2025-11-01' AND ${LOCAL} < TIMESTAMP '2026-11-01'`;
const PREVIOUS = `${LOCAL} >= TIMESTAMP '2024-11-01' AND ${LOCAL} < TIMESTAMP '2025-11-01'`;
const PAID = "status = 'paid'";

let oracle: Oracle;
let example: Awaited<ReturnType<typeof loadAt>>;
let data: DashboardData;

function block<T>(id: string): T {
  const found = data.blocks.find((b) => b.id === id);
  if (found === undefined) throw new Error(`no block ${id}`);
  return found as T;
}

beforeAll(async () => {
  oracle = await Oracle.open();
  example = await loadAt(ROOT);
  const result = await run(example.root, example.project, "sales");
  expect(result.diagnostics).toEqual([]);
  if (result.data === undefined) throw new Error("no data");
  data = result.data;
});
afterAll(() => oracle.close());

describe("global-sales example", () => {
  it("passes check and resolves latest_data to the last order date", () => {
    expect([
      ...example.diagnostics,
      ...parseDiagnostics(example.project),
      ...checkReferences(example.project),
    ]).toEqual([]);
    expect(data.asOf).toBe("2026-10-31");
    expect(data.period).toEqual({
      range: "last_12_months",
      compare: "previous_period",
      current: { start: "2025-11-01", end: "2026-11-01" },
      previous: { start: "2024-11-01", end: "2025-11-01" },
    });
  });

  it("matches every KPI, current and previous, with the oracle", async () => {
    const window = async (where: string) =>
      (
        await oracle.rows(`
          SELECT CAST(sum(amount) FILTER (WHERE ${PAID}) AS DOUBLE) AS revenue,
            CAST(count(*) FILTER (WHERE ${PAID}) AS DOUBLE) AS orders,
            CAST(count(*) FILTER (WHERE status = 'refunded') AS DOUBLE) AS refunded,
            CAST(count(*) AS DOUBLE) AS placed
          FROM read_csv('${CSV}') WHERE ${where}`)
      )[0] ?? {};
    const [now, before] = [await window(CURRENT), await window(PREVIOUS)];
    const n = (row: Record<string, unknown>, key: string) => row[key] as number;
    const expected = {
      revenue: [n(now, "revenue"), n(before, "revenue")],
      orders: [n(now, "orders"), n(before, "orders")],
      aov: [n(now, "revenue") / n(now, "orders"), n(before, "revenue") / n(before, "orders")],
      refund_rate: [
        n(now, "refunded") / n(now, "placed"),
        n(before, "refunded") / n(before, "placed"),
      ],
    };
    for (const [id, [value = 0, previous = 0]] of Object.entries(expected)) {
      const kpi = block<KpiData>(id);
      expect(kpi.value, id).toBeCloseTo(value, 6);
      expect(kpi.previousValue, id).toBeCloseTo(previous, 6);
      const points = id === "refund_rate";
      expect(kpi.changeKind).toBe(points ? "points" : "relative");
      expect(kpi.changePct, id).toBeCloseTo(
        points ? value - previous : (value - previous) / previous,
        9,
      );
    }
    const months = await oracle.rows(`
      SELECT strftime(date_trunc('month', ${LOCAL}), '%Y-%m-%d') AS m, CAST(sum(amount) AS DOUBLE) AS revenue
      FROM read_csv('${CSV}') WHERE ${PAID} AND ${CURRENT} GROUP BY ALL ORDER BY m`);
    const sparkline = block<KpiData>("revenue").sparkline;
    expect(sparkline?.buckets).toEqual(months.map((r) => r.m));
    sparkline?.values.forEach((v, i) => {
      expect(v).toBeCloseTo(months[i]?.revenue as number, 6);
    });
  });

  it("matches the country table, its limit and its ROLLUP total with the oracle", async () => {
    const rows = await oracle.rows(`
      SELECT country, CAST(sum(amount) FILTER (WHERE ${PAID}) AS DOUBLE) AS revenue,
        CAST(count(*) FILTER (WHERE ${PAID}) AS DOUBLE) AS orders,
        CAST(count(DISTINCT customer_id) FILTER (WHERE ${PAID}) AS DOUBLE) AS customers,
        CAST(GROUPING(country) AS INTEGER) AS g
      FROM read_csv('${CSV}') WHERE ${CURRENT}
      GROUP BY ROLLUP (country)
      ORDER BY g, revenue DESC, country`);
    const leaves = rows.filter((r) => r.g === 0);
    const total = rows.find((r) => r.g === 1) ?? {};
    const table = block<TableData>("by_country");
    expect(table.rowCount).toBe(leaves.length);
    expect(table.rows.map((r) => r.keys[0])).toEqual(leaves.slice(0, 15).map((r) => r.country));
    const check = (got: Record<string, number | null>, want: Record<string, unknown>) => {
      expect(got.revenue).toBeCloseTo(want.revenue as number, 6);
      expect(got.orders).toBe(want.orders);
      expect(got.customers).toBe(want.customers);
      expect(got.avg_order_value).toBeCloseTo(
        (want.revenue as number) / (want.orders as number),
        9,
      );
    };
    table.rows.forEach((row, i) => {
      check(row.values, leaves[i] ?? {});
      expect(row.share?.revenue).toBeCloseTo(
        (leaves[i]?.revenue as number) / (total.revenue as number),
        12,
      );
    });
    check(table.total?.values ?? {}, total);
    expect(table.total?.values.customers).toBeLessThan(
      leaves.reduce((sum, r) => sum + (r.customers as number), 0),
    );
  });

  it("matches the channel bar, null channel included, and the monthly region series", async () => {
    const channels = await oracle.rows(`
      SELECT channel, CAST(sum(amount) AS DOUBLE) AS revenue FROM read_csv('${CSV}')
      WHERE ${PAID} AND ${CURRENT} GROUP BY channel ORDER BY revenue DESC`);
    const bar = block<BarData>("revenue_by_channel");
    expect(bar.axis.kind === "category" && bar.axis.categories).toEqual(
      channels.map((r) => r.channel),
    );
    expect(channels.some((r) => r.channel === null)).toBe(true);
    bar.series[0]?.values.forEach((v, i) => {
      expect(v).toBeCloseTo(channels[i]?.revenue as number, 6);
    });

    const cells = await oracle.rows(`
      SELECT region, strftime(date_trunc('month', ${LOCAL}), '%Y-%m-%d') AS m, CAST(sum(amount) AS DOUBLE) AS revenue
      FROM read_csv('${CSV}') WHERE ${PAID} AND ${CURRENT} GROUP BY ALL`);
    const line = block<LineData>("revenue_by_region");
    expect(line.series.map((s) => s.label)).toEqual(["Americas", "EMEA", "APAC"]);
    for (const series of line.series) {
      series.values.forEach((v, i) => {
        const cell = cells.find(
          (c) => c.region === series.splitValue && c.m === line.axis.buckets[i],
        );
        expect(v).toBeCloseTo((cell?.revenue as number | undefined) ?? 0, 6);
      });
    }
  });

  it("plans and runs deterministically, and matches the committed DashboardData", async () => {
    const first = planDashboard(example.project, "sales").plan;
    const second = planDashboard(example.project, "sales").plan;
    if (first === undefined || second === undefined) throw new Error("no plan");
    expect(canonicalJson(second)).toBe(canonicalJson(first));
    expect(planHash(second)).toBe(planHash(first));
    const again = await run(example.root, example.project, "sales");
    expect(JSON.stringify(again.data)).toBe(JSON.stringify(data));
    await expect(`${JSON.stringify(data, null, 2)}\n`).toMatchFileSnapshot(
      "../fixtures/global-sales/sales.data.json",
    );
  });
});
