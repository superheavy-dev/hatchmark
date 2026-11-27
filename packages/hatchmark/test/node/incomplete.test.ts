import { afterAll, describe, expect, it } from "vitest";
import type { KpiData, LineData } from "../../src/compiler/index.js";
import { PROJECT_DEFAULTS } from "../../src/spec/index.js";
import { metric, removeProjects, run, writeProject } from "./fixture.js";

// Windows ended at each measure's horizon, comparisons over the same elapsed span, and partial
// buckets (RFC 0001 sections 6.4 and 6.5).

afterAll(removeProjects);

async function dashboard(options: {
  sources: Record<string, string>;
  period: Record<string, unknown>;
  blocks: unknown[];
  metrics?: Record<string, unknown>;
  timezone?: string;
}) {
  const fixture = await writeProject({
    "hatchmark.json": {
      ...PROJECT_DEFAULTS,
      name: "Incomplete",
      timezone: options.timezone ?? "UTC",
      sources: Object.fromEntries(
        Object.keys(options.sources).map((n) => [n, { type: "csv", path: `${n}.csv` }]),
      ),
    },
    ...Object.fromEntries(Object.entries(options.sources).map(([n, text]) => [`${n}.csv`, text])),
    ...Object.fromEntries(
      Object.keys(options.sources).map((n) => [
        `metrics/${n}.json`,
        metric({ type: "aggregate", table: n, aggregate: "sum", column: "v", time: "at" }),
      ]),
    ),
    ...Object.fromEntries(
      Object.entries(options.metrics ?? {}).map(([n, m]) => [`metrics/${n}.json`, m]),
    ),
    "dashboards/d.json": { title: "D", period: options.period, blocks: options.blocks },
  });
  const { data, diagnostics } = await run(fixture.root, fixture.project, "d");
  const block = <T>(id: string) => data?.blocks.find((b) => b.id === id) as T;
  return { data, diagnostics, block };
}

const rows = (...pairs: [string, number][]) =>
  `at,v\n${pairs.map(([at, v]) => `${at},${v}`).join("\n")}\n`;

describe("windows end at the measure's horizon", () => {
  it("reads a to-date range through the horizon and compares the same elapsed time", async () => {
    const { block } = await dashboard({
      sources: {
        orders: rows(
          ["2026-10-01T09:00:00Z", 1],
          ["2026-10-26T14:00:00Z", 2],
          ["2026-10-26T15:00:00Z", 4],
          ["2026-11-01T09:00:00Z", 8],
          ["2026-11-26T14:03:00Z", 16],
        ),
      },
      period: { asOf: "latest_data", range: "month_to_date", compare: "previous_period" },
      blocks: [{ type: "kpi", id: "orders", metric: "orders" }],
    });
    expect(block<KpiData>("orders")).toMatchObject({
      value: 24,
      previousValue: 3,
      current: { start: "2026-11-01", end: "2026-11-27", endAt: "2026-11-26T14:03:00.000001" },
      previous: { start: "2026-10-01", end: "2026-10-27", endAt: "2026-10-26T14:03:00.000001" },
    });
  });

  it("slides last N days back to end at a lagging source's horizon, keeping its length", async () => {
    const { block, diagnostics } = await dashboard({
      sources: {
        fresh: rows(["2026-06-10", 1]),
        stale: rows(["2026-05-31", 1], ["2026-06-01", 2], ["2026-06-07", 4], ["2026-06-08", 8]),
      },
      period: { asOf: "latest_data", range: { last: 7, unit: "day" }, compare: "previous_period" },
      blocks: [
        { type: "kpi", id: "fresh", metric: "fresh" },
        { type: "kpi", id: "stale", metric: "stale" },
      ],
    });
    expect(diagnostics.map((d) => d.code)).toEqual(["HM4010"]);
    expect(block<KpiData>("fresh")).toMatchObject({
      value: 1,
      current: { start: "2026-06-04", end: "2026-06-11" },
    });
    expect(block<KpiData>("stale")).toMatchObject({
      value: 12,
      previousValue: 3,
      current: { start: "2026-06-02", end: "2026-06-09" },
      previous: { start: "2026-05-26", end: "2026-06-02" },
    });
  });

  it("ends a complete unit at the horizon and cuts its comparison to the same span", async () => {
    const { block } = await dashboard({
      sources: {
        fresh: rows(["2026-11-05", 1]),
        stale: rows(["2026-09-27", 1], ["2026-09-28", 2], ["2026-10-27", 4], ["2026-10-28", 8]),
      },
      period: { asOf: "2026-11-05", range: "last_complete_month", compare: "previous_period" },
      blocks: [{ type: "kpi", id: "stale", metric: "stale" }],
    });
    expect(block<KpiData>("stale")).toMatchObject({
      value: 12,
      previousValue: 3,
      current: { start: "2026-10-01", end: "2026-10-29" },
      previous: { start: "2026-09-01", end: "2026-09-29" },
    });
  });

  it("ignores rows after a fixed as-of in an all_time window", async () => {
    const { block } = await dashboard({
      sources: { orders: rows(["2026-01-10", 1], ["2026-02-10", 2], ["2026-03-10", 4]) },
      period: { asOf: "2026-02-28", range: "all_time", compare: "none" },
      blocks: [{ type: "kpi", id: "orders", metric: "orders" }],
    });
    expect(block<KpiData>("orders").value).toBe(3);
  });
});

describe("partial buckets", () => {
  it("ends each series at its own horizon and marks the bucket it cuts", async () => {
    const { block } = await dashboard({
      sources: {
        fresh: rows(["2026-06-01", 1], ["2026-06-15", 2], ["2026-06-24", 4]),
        stale: rows(["2026-06-01", 1], ["2026-06-09", 2]),
      },
      period: {
        asOf: "latest_data",
        range: { start: "2026-06-01", end: "2026-07-01" },
        compare: "none",
      },
      blocks: [
        {
          type: "line",
          id: "weekly",
          metrics: ["fresh", "stale"],
          grain: { unit: "week", anchor: "monday" },
        },
      ],
    });
    const line = block<LineData>("weekly");
    expect(line.axis.buckets).toEqual(["2026-06-01", "2026-06-08", "2026-06-15", "2026-06-22"]);
    expect(line.series.map((s) => [s.key, s.values, s.partial])).toEqual([
      ["fresh", [1, 0, 2, 4], [{ index: 3, elapsed: 0.428571 }]],
      ["stale", [1, 2, null, null], [{ index: 1, elapsed: 0.285714 }]],
    ]);
  });

  it("measures elapsed in local wall-clock time, also on a 23-hour DST day", async () => {
    const { block } = await dashboard({
      timezone: "America/New_York",
      sources: { orders: rows(["2026-03-08T05:00:00Z", 1], ["2026-03-08T17:59:59Z", 2]) },
      period: {
        asOf: "latest_data",
        range: { start: "2026-03-08", end: "2026-03-09" },
        compare: "none",
      },
      blocks: [{ type: "line", id: "hourly", metrics: ["orders"], grain: "day" }],
    });
    const series = block<LineData>("hourly").series[0];
    expect(series?.values).toEqual([3]);
    expect(series?.partial?.[0]?.index).toBe(0);
    expect(series?.partial?.[0]?.elapsed).toBeCloseTo(14 / 24, 4);
  });

  it("marks nothing when every source is complete through the window end", async () => {
    const { block } = await dashboard({
      sources: { orders: rows(["2026-06-01", 1], ["2026-06-30", 2]) },
      period: {
        asOf: "2026-06-30",
        range: { start: "2026-06-01", end: "2026-07-01" },
        compare: "none",
      },
      blocks: [{ type: "line", id: "monthly", metrics: ["orders"], grain: "month" }],
    });
    expect(block<LineData>("monthly").series[0]).toEqual({
      key: "orders",
      metric: "orders",
      label: "Metric",
      values: [3],
    });
  });
});
