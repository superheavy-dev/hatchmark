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
const WHOLE = `${LOCAL} >= TIMESTAMP '2025-10-31' AND ${LOCAL} < TIMESTAMP '2026-10-31'`;
const WHOLE_PREVIOUS = `${LOCAL} >= TIMESTAMP '2024-10-31' AND ${LOCAL} < TIMESTAMP '2025-10-31'`;
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
    const [now, before] = [await window(WHOLE), await window(WHOLE_PREVIOUS)];
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
      FROM read_csv('${CSV}') WHERE ${WHOLE}
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
      WHERE ${PAID} AND ${WHOLE} GROUP BY channel ORDER BY revenue DESC`);
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

describe("global-sales trends dashboard (grain switching)", () => {
  let trends: DashboardData;
  const FIRST: Record<string, string> = {
    "week:sunday": "2025-09-28",
    month: "2025-10-01",
    "quarter:01-01": "2025-10-01",
  };
  const current = (key: string) =>
    `${LOCAL} >= TIMESTAMP '${FIRST[key]}' AND ${LOCAL} < TIMESTAMP '2026-10-01'`;
  const BUCKET: Record<string, string> = {
    "week:sunday": `date_trunc('week', CAST(${LOCAL} AS DATE) + INTERVAL 1 DAY) - INTERVAL 1 DAY`,
    month: `date_trunc('month', ${LOCAL})`,
    "quarter:01-01": `date_trunc('quarter', ${LOCAL})`,
  };

  beforeAll(async () => {
    const result = await run(example.root, example.project, "trends");
    expect(result.diagnostics).toEqual([]);
    if (result.data === undefined) throw new Error("no data");
    trends = result.data;
  });

  const of = <T>(id: string) => trends.blocks.find((b) => b.id === id) as T;

  it("carries the grain filter and selects its default in every block that lists it", () => {
    expect(trends.grainFilter).toEqual({
      id: "grain",
      label: "Grain",
      options: [
        { key: "week:sunday", label: "Week" },
        { key: "month", label: "Month" },
        { key: "quarter:01-01", label: "Quarter" },
      ],
      selected: "month",
    });
    const line = of<LineData>("revenue_by_region");
    const bar = of<BarData>("orders_over_time");
    const area = of<LineData>("revenue_by_channel");
    expect(line.grains?.selected).toBe("month");
    expect(bar.grains?.options.map((o) => o.key)).toEqual(["month", "quarter:01-01"]);
    expect(area.grains?.selected).toBe("month");
    for (const b of [line, bar, area]) {
      const shown = b.grains?.options.find((o) => o.key === b.grains?.selected);
      expect(b.axis).toEqual(shown?.axis);
      expect(b.series).toEqual(shown?.series);
    }
  });

  it("matches every grain of the region line with the oracle, bucket by bucket", async () => {
    const line = of<LineData>("revenue_by_region");
    for (const option of line.grains?.options ?? []) {
      const cells = await oracle.rows(`
        SELECT region, strftime(${BUCKET[option.key]}, '%Y-%m-%d') AS b, CAST(sum(amount) AS DOUBLE) AS revenue
        FROM read_csv('${CSV}') WHERE ${PAID} AND ${current(option.key)} GROUP BY ALL`);
      expect(option.series.map((s) => s.splitValue).sort()).toEqual(["APAC", "Americas", "EMEA"]);
      for (const series of option.series) {
        series.values.forEach((v, i) => {
          const cell = cells.find(
            (c) => c.region === series.splitValue && c.b === option.axis.buckets[i],
          );
          expect(v, `${option.key} ${series.label} ${option.axis.buckets[i]}`).toBeCloseTo(
            (cell?.revenue as number | undefined) ?? 0,
            6,
          );
        });
      }
      const total = option.series
        .flatMap((s) => s.values)
        .reduce((a: number, v) => a + (v ?? 0), 0);
      const [all] = await oracle.rows(
        `SELECT CAST(sum(amount) AS DOUBLE) AS v FROM read_csv('${CSV}') WHERE ${PAID} AND ${current(option.key)}`,
      );
      expect(total).toBeCloseTo(all?.v as number, 6);
    }
  });

  it("matches the committed DashboardData", async () => {
    await expect(`${JSON.stringify(trends, null, 2)}\n`).toMatchFileSnapshot(
      "../fixtures/global-sales/trends.data.json",
    );
  });
});
