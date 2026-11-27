import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { KpiData, LineData, TableData } from "../../src/compiler/index.js";
import { PROJECT_DEFAULTS } from "../../src/spec/index.js";
import { metric, Oracle, removeProjects, run, writeProject } from "./fixture.js";

// Windows ended at each measure's horizon, comparisons over the same elapsed span, and partial
// buckets (RFC 0001 sections 6.4 and 6.5).

let oracle: Oracle;
beforeAll(async () => {
  oracle = await Oracle.open();
});
afterAll(async () => {
  oracle.close();
  await removeProjects();
});

async function dashboard(options: {
  sources: Record<string, string>;
  period: Record<string, unknown>;
  blocks: unknown[];
  metrics?: Record<string, unknown>;
  timezone?: string;
  freshness?: Record<string, unknown>;
}) {
  const fixture = await writeProject({
    "hatchmark.json": {
      ...PROJECT_DEFAULTS,
      name: "Incomplete",
      timezone: options.timezone ?? "UTC",
      sources: Object.fromEntries(
        Object.keys(options.sources).map((n) => [
          n,
          {
            type: "csv",
            path: `${n}.csv`,
            ...(options.freshness && { freshness: options.freshness }),
          },
        ]),
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
  return { data, diagnostics, block, root: fixture.root };
}

const rows = (...pairs: [string, number][]) =>
  `at,v\n${pairs.map(([at, v]) => `${at},${v}`).join("\n")}\n`;

describe("windows end at the measure's horizon", () => {
  it("reads a to-date range through the last complete day and compares the same days", async () => {
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
    const kpi = block<KpiData>("orders");
    expect(kpi).toMatchObject({
      value: 8,
      previousValue: 1,
      current: { start: "2026-11-01", end: "2026-11-26" },
      previous: { start: "2026-10-01", end: "2026-10-26" },
    });
    expect(kpi.current).not.toHaveProperty("endAt");
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

describe("windows at the horizon against SQL written here", () => {
  // Hourly rows from Oct 1, 12:30 a.m. to Nov 29, 2:30 p.m. New York time, so Nov 28 is the last
  // complete day. Each KPI is checked against a query with its whole-day bounds spelled out.
  const at = (hours: number) =>
    new Date(Date.UTC(2026, 9, 1, 4, 30) + hours * 3_600_000).toISOString();
  const hourly = (count: number) =>
    rows(...Array.from({ length: count }, (_, h): [string, number] => [at(h), (h % 7) + 1]));
  const ranges: [string, unknown, string, string, string, string][] = [
    ["mtd", "month_to_date", "2026-11-01", "2026-11-29", "2026-10-01", "2026-10-29"],
    ["l7", { last: 7, unit: "day" }, "2026-11-22", "2026-11-29", "2026-11-15", "2026-11-22"],
    ["l2m", { last: 2, unit: "month" }, "2026-09-29", "2026-11-29", "2026-07-30", "2026-09-29"],
  ];
  for (const [id, range, s, e, ps, pe] of ranges) {
    it(`${id}: value and comparison match SQL with explicit local bounds`, async () => {
      const count = 59 * 24 + 16;
      const { block, root } = await dashboard({
        timezone: "America/New_York",
        sources: { orders: hourly(count) },
        period: { asOf: "latest_data", range, compare: "previous_period" },
        blocks: [{ type: "kpi", id: "k", metric: "orders" }],
      });
      const csv = path.join(root, "orders.csv");
      const sum = async (from: string, to: string) => {
        const [r] = await oracle.rows(`
          SELECT coalesce(sum(v), 0) AS v FROM read_csv('${csv}')
          WHERE timezone('America/New_York', "at") >= TIMESTAMP '${from}'
            AND timezone('America/New_York', "at") < TIMESTAMP '${to}'`);
        return Number(r?.v);
      };
      const kpi = block<KpiData>("k");
      expect(kpi.value).toBeGreaterThan(0);
      expect(kpi.value).toBe(await sum(s, e));
      expect(kpi.previousValue).toBe(await sum(ps, pe));
    });
  }
});

describe("whole days in KPIs, instants in series", () => {
  // Rows as [UTC instant, value]; each expectation is summed here from the instants.
  const between = (pairs: [string, number][], from: string, to: string) =>
    pairs
      .filter(([at]) => Date.parse(at) >= Date.parse(from) && Date.parse(at) < Date.parse(to))
      .reduce((n, [, v]) => n + v, 0);

  it("cuts a series inside the repeated hour of a fall-back day by instant", async () => {
    const pairs: [string, number][] = [
      ["2026-11-01T05:40:00Z", 1],
      ["2026-11-01T05:50:00Z", 2],
      ["2026-11-01T06:40:00Z", 8],
      ["2026-11-01T06:50:00Z", 16],
      ["2026-11-01T08:45:00Z", 32],
    ];
    const { block } = await dashboard({
      timezone: "America/New_York",
      freshness: { lag: { hours: 2 } },
      sources: { orders: rows(...pairs) },
      period: { asOf: "2026-11-01", range: "month_to_date", compare: "none" },
      blocks: [
        { type: "kpi", id: "k", metric: "orders" },
        { type: "line", id: "l", metrics: ["orders"], grain: "day" },
      ],
    });
    // Complete through 1:45 a.m. EST (06:45Z): the series includes the EDT 1:50 row and leaves out
    // the EST 1:50 row; no day of November is complete, so the KPI shows no value.
    const expected = between(pairs, "2026-11-01T04:00:00Z", "2026-11-01T06:45:00.001Z");
    expect(expected).toBe(11);
    expect(block<LineData>("l").series[0]?.values[0]).toBe(expected);
    expect(block<KpiData>("k")).toMatchObject({
      value: null,
      empty: "no_complete_day",
      current: { start: "2026-11-01", end: "2026-11-01" },
    });
  });

  it("shows no value, never 0, for a KPI or table with no complete day yet", async () => {
    const { block, diagnostics } = await dashboard({
      sources: { orders: rows(["2026-10-31T12:00:00Z", 1], ["2026-11-01T09:00:00Z", 2]) },
      period: { asOf: "latest_data", range: "month_to_date", compare: "previous_period" },
      blocks: [
        { type: "kpi", id: "k", metric: "orders" },
        { type: "table", id: "t", by: ["v"], metrics: ["orders"] },
        { type: "line", id: "l", metrics: ["orders"], grain: "day" },
      ],
    });
    expect(block<KpiData>("k")).toMatchObject({
      value: null,
      empty: "no_complete_day",
      previousValue: null,
      change: null,
      changePct: null,
      current: { start: "2026-11-01", end: "2026-11-01" },
    });
    expect(block<TableData>("t")).toMatchObject({
      rows: [],
      rowCount: 0,
      total: { values: { orders: null } },
      empty: "no_complete_day",
    });
    expect(block<LineData>("l").series[0]?.values).toEqual([2]);
    expect(diagnostics.map((d) => [d.code, d.severity, d.pointer])).toEqual([
      ["HM4024", "note", "/blocks/0"],
      ["HM4024", "note", "/blocks/1"],
    ]);
    expect(diagnostics[0]?.message).toContain("no complete day yet");
  });

  it("shifts a slid window a month back from March 31 by its first and last day", async () => {
    const pairs: [string, number][] = [
      ["2026-02-27T11:00:00Z", 1],
      ["2026-02-28T12:00:00Z", 4],
      ["2026-03-30T09:00:00Z", 2],
      ["2026-03-31T12:00:00Z", 8],
    ];
    const { block } = await dashboard({
      sources: { orders: rows(...pairs) },
      period: {
        asOf: "latest_data",
        range: { last: 1, unit: "day" },
        compare: { shift: { unit: "month", by: -1 } },
      },
      blocks: [{ type: "kpi", id: "k", metric: "orders" }],
    });
    expect(block<KpiData>("k")).toMatchObject({
      value: between(pairs, "2026-03-30T00:00:00Z", "2026-03-31T00:00:00Z"),
      previousValue: between(pairs, "2026-02-28T00:00:00Z", "2026-03-01T00:00:00Z"),
      current: { start: "2026-03-30", end: "2026-03-31" },
      previous: { start: "2026-02-28", end: "2026-03-01" },
    });
  });

  it("slides last N months back by whole days to the last complete day, keeping its day count", async () => {
    const pairs: [string, number][] = [
      ["2026-04-08T12:00:00Z", 32],
      ["2026-05-10T12:00:00Z", 1],
      ["2026-07-10T11:00:00Z", 2],
      ["2026-07-10T13:00:00Z", 4],
      ["2026-09-01T00:00:00Z", 8],
      ["2026-10-10T12:00:00Z", 16],
    ];
    const { block } = await dashboard({
      sources: { orders: rows(...pairs) },
      period: {
        asOf: "latest_data",
        range: { last: 3, unit: "month" },
        compare: "previous_period",
      },
      blocks: [{ type: "kpi", id: "k", metric: "orders" }],
    });
    // As of Oct 10, last 3 months is Aug 1 to Oct 10, 71 days. Oct 10 isn't complete, so it slides
    // back a day to Jul 31 to Oct 9, and previous_period is the 71 days before it.
    expect(block<KpiData>("k")).toMatchObject({
      value: between(pairs, "2026-07-31T00:00:00Z", "2026-10-10T00:00:00Z"),
      previousValue: between(pairs, "2026-05-21T00:00:00Z", "2026-07-31T00:00:00Z"),
      current: { start: "2026-07-31", end: "2026-10-10" },
      previous: { start: "2026-05-21", end: "2026-07-31" },
    });
  });

  it("keeps the exact as-of in the axis of an all_time chart", async () => {
    const { block } = await dashboard({
      sources: { orders: rows(["2026-10-01T12:00:00Z", 2], ["2026-11-03T12:00:00Z", 4]) },
      period: { asOf: "latest_data", range: "all_time", compare: "none" },
      blocks: [
        { type: "line", id: "l", metrics: ["orders"], grain: "month" },
        { type: "kpi", id: "k", metric: "orders" },
      ],
    });
    expect(block<LineData>("l").axis.window).toEqual({
      start: "2026-10-01",
      end: "2026-11-04",
      endAt: "2026-11-03T12:00:00.000001",
    });
    expect(block<LineData>("l").series[0]?.values).toEqual([2, 4]);
    expect(block<KpiData>("k").value).toBe(2);
  });
});
