import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type BarData,
  bucketStart,
  type DashboardData,
  type KpiData,
  type LineData,
  type PlannedQuery,
  planDashboard,
  planTimeColumns,
  type TableData,
} from "../../src/compiler/index.js";
import { createDuckDbExecutor } from "../../src/node/index.js";
import {
  checkReferences,
  DEFAULT_ANCHORS,
  PROJECT_DEFAULTS,
  type ResolvedGrain,
  WEEKDAYS,
} from "../../src/spec/index.js";
import { loadAt, metric, Oracle, removeProjects, run, writeProject } from "./fixture.js";

const NY = "America/New_York";

// Times are UTC; the project buckets in New York. Row 3 is Jan 31 23:30 in New York (Feb 1 UTC),
// rows 7 and 8 sit on either side of local midnight before Apr 30, March has no rows at all, and
// region and channel have nulls.
const ORDERS = `order_id,ordered_at,region,channel,status,amount,refund,customer_id
1,2026-01-05T15:00:00Z,West,web,paid,10.00,0,u1
2,2026-01-31T23:30:00Z,West,,paid,20.00,5,u2
3,2026-02-01T04:30:00Z,,web,paid,30.00,0,u1
4,2026-02-01T05:30:00Z,East,app,refunded,40.00,40,u3
5,2026-04-10T12:00:00Z,East,web,paid,50.00,0,u1
6,2026-04-11T12:00:00Z,,app,paid,60.00,10,u4
7,2026-04-30T03:59:00Z,West,web,paid,70.00,0,u2
8,2026-04-30T04:00:00Z,West,app,paid,80.00,0,u5
`;

// A second source with a DATE time column that ends later than orders.
const SESSIONS = `started_at,region
2026-01-10,West
2026-01-31,
2026-02-01,East
2026-04-15,West
2026-04-20,
2026-05-02,East
`;

const paid = [{ column: "status", op: "eq", value: "paid" }];
const orders = (body: Record<string, unknown>) =>
  metric({ type: "aggregate", table: "orders", time: "ordered_at", ...body });

const METRICS = {
  revenue: orders({ label: "Revenue", aggregate: "sum", column: "amount", filters: paid }),
  orders: orders({ label: "Orders", aggregate: "count", filters: paid }),
  aov: metric({ label: "AOV", type: "ratio", numerator: "revenue", denominator: "orders" }),
  avg_amount: orders({ aggregate: "avg", column: "amount", filters: paid }),
  customers: orders({ aggregate: "count_distinct", column: "customer_id", filters: paid }),
  net: metric({
    type: "sql",
    table: "orders",
    sql: "sum(amount) - sum(refund)",
    additive: true,
    time: "ordered_at",
  }),
  users_lie: metric({
    type: "sql",
    table: "orders",
    sql: "count(distinct customer_id)",
    additive: true,
    time: "ordered_at",
  }),
  sessions: metric({
    type: "aggregate",
    table: "sessions",
    aggregate: "count",
    time: "started_at",
  }),
  conversion: metric(
    { type: "ratio", numerator: "orders", denominator: "sessions" },
    { type: "percent" },
  ),
  not_west: orders({
    aggregate: "count",
    filters: [{ column: "region", op: "neq", value: "West" }],
  }),
  not_in_west: orders({
    aggregate: "count",
    filters: [{ column: "region", op: "not_in", values: ["West"] }],
  }),
  jan_between: orders({
    aggregate: "count",
    filters: [{ column: "ordered_at", op: "between", from: "2026-01-01", to: "2026-01-31" }],
  }),
  jan_31: orders({
    aggregate: "count",
    filters: [{ column: "ordered_at", op: "eq", value: "2026-01-31" }],
  }),
  after_jan: orders({
    aggregate: "count",
    filters: [{ column: "ordered_at", op: "gt", value: "2026-01-31" }],
  }),
  injected: orders({
    aggregate: "count",
    filters: [{ column: "channel", op: "eq", value: "web' OR '1' = '1" }],
  }),
  web_or_null: orders({
    aggregate: "count",
    filters: [{ column: "channel", op: "neq", value: "app" }],
  }),
};

const YTD = { asOf: "2026-04-30", range: "year_to_date", compare: "previous_period" };
const DASHBOARDS = {
  ytd: {
    title: "Year to date",
    period: YTD,
    blocks: [
      { type: "kpi", id: "revenue", metric: "revenue", sparkline: true },
      { type: "kpi", id: "aov", metric: "aov" },
      { type: "kpi", id: "customers", metric: "customers" },
      { type: "kpi", id: "conversion", metric: "conversion" },
      {
        type: "table",
        id: "by_region",
        by: ["region"],
        metrics: ["revenue", "orders", "aov", "avg_amount", "customers", "net"],
        percentOfTotal: ["revenue"],
      },
      { type: "table", id: "top_region", by: ["region"], metrics: ["revenue"], limit: 1 },
      {
        type: "table",
        id: "conversion_by_region",
        by: ["region"],
        metrics: ["orders", "sessions", "conversion"],
      },
      { type: "table", id: "lie", by: ["region"], metrics: ["users_lie", "net"] },
      {
        type: "line",
        id: "monthly",
        metrics: ["revenue", "orders", "aov", "customers"],
        grain: "month",
      },
      { type: "bar", id: "by_channel", metrics: ["orders"], by: "channel", split: "region" },
      { type: "bar_list", metric: "revenue", by: "region" },
    ],
  },
  filters: {
    title: "Filters",
    period: { asOf: "2026-04-30", range: "all_time", compare: "none" },
    blocks: [
      "not_west",
      "not_in_west",
      "jan_between",
      "jan_31",
      "after_jan",
      "web_or_null",
      "injected",
    ].map((m) => ({ type: "kpi", id: m, metric: m })),
  },
  weeks: {
    title: "Weeks",
    period: { asOf: "2026-04-30", range: "last_30_days", compare: "none" },
    blocks: [{ type: "line", id: "weekly", metrics: ["revenue", "aov"], grain: "week" }],
  },
  latest: {
    title: "Latest",
    period: { asOf: "latest_data", range: "last_7_days", compare: "none" },
    blocks: [
      { type: "kpi", id: "orders", metric: "orders" },
      { type: "kpi", id: "sessions", metric: "sessions" },
    ],
  },
  sorts: {
    title: "Sorts",
    period: YTD,
    blocks: [
      {
        type: "table",
        id: "t",
        by: ["region"],
        metrics: ["orders"],
        sort: { by: "region", order: "desc" },
      },
      {
        type: "bar",
        id: "b",
        by: "channel",
        metrics: ["orders"],
        sort: { by: "channel", order: "desc" },
      },
    ],
  },
  period_filter: {
    title: "Period filter",
    period: YTD,
    filters: [
      { type: "period", id: "period", options: ["all_time", "year_to_date"], default: "all_time" },
    ],
    blocks: [{ type: "kpi", id: "orders", metric: "orders" }],
  },
  region_west: {
    title: "West",
    period: { asOf: "2026-04-30", range: "all_time", compare: "none" },
    filters: [{ type: "select", id: "region", column: "Region", default: "West" }],
    blocks: [{ type: "kpi", id: "orders", metric: "orders" }],
  },
};

const CONFIG = {
  ...PROJECT_DEFAULTS,
  name: "Edge cases",
  timezone: NY,
  weekStart: "sunday",
  sources: {
    orders: { type: "csv", path: "data/orders.csv" },
    sessions: { type: "csv", path: "data/sessions.csv" },
  },
};

function files(config: unknown = CONFIG): Record<string, unknown> {
  return {
    "hatchmark.json": config,
    "data/orders.csv": ORDERS,
    "data/sessions.csv": SESSIONS,
    ...Object.fromEntries(Object.entries(METRICS).map(([n, m]) => [`metrics/${n}.json`, m])),
    ...Object.fromEntries(Object.entries(DASHBOARDS).map(([n, d]) => [`dashboards/${n}.json`, d])),
  };
}

function block<T>(data: DashboardData | undefined, id: string): T {
  const found = data?.blocks.find((b) => b.id === id);
  if (found === undefined) throw new Error(`no block ${id}`);
  return found as T;
}

let oracle: Oracle;
let edge: Awaited<ReturnType<typeof writeProject>>;
let ytd: Awaited<ReturnType<typeof run>>;
const local = `(ordered_at AT TIME ZONE '${NY}')`;

beforeAll(async () => {
  oracle = await Oracle.open();
  edge = await writeProject(files());
  ytd = await run(edge.root, edge.project, "ytd");
});
afterAll(async () => {
  oracle.close();
  await removeProjects();
});

describe("DuckDB executor against a SQL ROLLUP oracle", () => {
  it("loads and checks the fixture cleanly", () => {
    expect(edge.diagnostics).toEqual([]);
    expect(checkReferences(edge.project)).toEqual([]);
    expect(ytd.diagnostics.map((d) => d.code)).toEqual(["HM4002", "HM4003"]);
  });

  it("matches every table row and the total, including the null group and non-additive metrics", async () => {
    const csv = path.join(edge.root, "data/orders.csv");
    const expected = await oracle.rows(`
      SELECT region,
        CAST(sum(amount) FILTER (WHERE status = 'paid') AS DOUBLE) AS revenue,
        CAST(count(*) FILTER (WHERE status = 'paid') AS DOUBLE) AS orders,
        CAST(avg(amount) FILTER (WHERE status = 'paid') AS DOUBLE) AS avg_amount,
        CAST(count(DISTINCT customer_id) FILTER (WHERE status = 'paid') AS DOUBLE) AS customers,
        CAST(sum(amount) - sum(refund) AS DOUBLE) AS net,
        CAST(GROUPING(region) AS INTEGER) AS g
      FROM read_csv('${csv}')
      WHERE ${local} >= TIMESTAMP '2026-01-01' AND ${local} < TIMESTAMP '2026-05-01'
      GROUP BY ROLLUP (region)`);
    const table = block<TableData>(ytd.data, "by_region");
    const values = (row: Record<string, unknown>) => ({
      revenue: row.revenue,
      orders: row.orders,
      aov: (row.revenue as number) / (row.orders as number),
      avg_amount: row.avg_amount,
      customers: row.customers,
      net: row.net,
    });
    const leaves = expected.filter((r) => r.g === 0);
    expect(table.rowCount).toBe(leaves.length);
    for (const row of leaves) {
      const got = table.rows.find((r) => r.keys[0] === row.region);
      expect(got?.values, String(row.region)).toEqual(values(row));
    }
    const total = expected.find((r) => r.g === 1) ?? {};
    expect(table.total?.values).toEqual(values(total));
    expect(table.rows.map((r) => r.keys)).toEqual([["West"], [null], ["East"]]);
    expect(table.total?.values.customers).toBe(4);
    expect(table.rows.reduce((sum, r) => sum + (r.values.customers ?? 0), 0)).toBe(6);
    expect(table.rows.map((r) => r.share?.revenue)).toEqual([180 / 320, 90 / 320, 50 / 320]);
    expect(table.total?.share).toEqual({ revenue: 1 });
  });

  it("verifies additive SQL metrics against the recomputed total and warns when one lies", () => {
    const table = block<TableData>(ytd.data, "lie");
    const sum = (m: string) => table.rows.reduce((acc, r) => acc + (r.values[m] ?? 0), 0);
    expect(sum("net")).toBe(table.total?.values.net);
    expect(sum("users_lie")).toBe(7);
    expect(table.total?.values.users_lie).toBe(5);
    const warning = ytd.diagnostics.find((d) => d.code === "HM4003");
    expect(warning?.file).toBe("metrics/users_lie.json");
    expect(warning?.message).toContain("add up to 7, not the total 5");
  });

  it("applies limit to leaf rows only; the total still covers every row", () => {
    const table = block<TableData>(ytd.data, "top_region");
    expect(table.rows).toEqual([{ keys: ["West"], values: { revenue: 180 } }]);
    expect(table.rowCount).toBe(3);
    expect(table.total?.values.revenue).toBe(320);
  });

  it("matches ratio rows across sources null-safely, and divides the totals for the total row", async () => {
    const sessions = await oracle.rows(`
      SELECT region, CAST(count(*) AS DOUBLE) AS n, CAST(GROUPING(region) AS INTEGER) AS g
      FROM read_csv('${path.join(edge.root, "data/sessions.csv")}')
      WHERE started_at >= DATE '2026-01-01' AND started_at < DATE '2026-05-01'
      GROUP BY ROLLUP (region)`);
    expect(sessions.find((r) => r.region === null && r.g === 0)?.n).toBe(2);
    expect(sessions.find((r) => r.g === 1)?.n).toBe(5);
    const table = block<TableData>(ytd.data, "conversion_by_region");
    expect(table.rows).toEqual([
      { keys: ["West"], values: { orders: 4, sessions: 2, conversion: 2 } },
      { keys: [null], values: { orders: 2, sessions: 2, conversion: 1 } },
      { keys: ["East"], values: { orders: 1, sessions: 1, conversion: 1 } },
    ]);
    expect(table.total?.values).toEqual({ orders: 7, sessions: 5, conversion: 7 / 5 });
    expect(block<KpiData>(ytd.data, "conversion").value).toBe(7 / 5);
  });

  it("reads KPI windows and an empty comparison window: 0 for sums, null for ratios", () => {
    const revenue = block<KpiData>(ytd.data, "revenue");
    expect(revenue).toMatchObject({
      value: 320,
      current: { start: "2026-01-01", end: "2026-05-01" },
      previous: { start: "2025-01-01", end: "2025-05-01" },
      previousValue: 0,
      change: 320,
      changePct: null,
      changeKind: "relative",
      sparkline: {
        grain: "month",
        buckets: ["2026-01-01", "2026-02-01", "2026-03-01", "2026-04-01"],
        values: [60, 0, 0, 260],
      },
    });
    expect(block<KpiData>(ytd.data, "aov")).toMatchObject({
      value: 320 / 7,
      previousValue: null,
      change: null,
      changePct: null,
    });
    expect(block<KpiData>(ytd.data, "conversion").changeKind).toBe("points");
  });

  it("zero-fills empty months for sums and counts and leaves the others null", () => {
    const line = block<LineData>(ytd.data, "monthly");
    expect(line.axis.buckets).toEqual(["2026-01-01", "2026-02-01", "2026-03-01", "2026-04-01"]);
    const series = Object.fromEntries(line.series.map((s) => [s.key, s.values]));
    expect(series).toEqual({
      revenue: [60, 0, 0, 260],
      orders: [3, 0, 0, 4],
      aov: [20, null, null, 65],
      customers: [2, 0, null, 4],
    });
  });

  it("orders bar categories and split series with null as a real group", () => {
    const bar = block<BarData>(ytd.data, "by_channel");
    expect(bar.axis).toEqual({
      kind: "category",
      column: "channel",
      categories: ["web", "app", null],
    });
    expect(bar.series.map((s) => [s.key, s.splitValue, s.values])).toEqual([
      ["orders:West", "West", [2, 1, 1]],
      ["orders:(empty)", null, [1, 1, 0]],
      ["orders:East", "East", [1, 0, 0]],
    ]);
  });

  it("filters with null-keeping neq and not_in, and whole local days for dates on timestamps", async () => {
    const { data, diagnostics } = await run(edge.root, edge.project, "filters");
    expect(diagnostics).toEqual([]);
    const value = (id: string) => block<KpiData>(data, id).value;
    const csv = path.join(edge.root, "data/orders.csv");
    const [o] = await oracle.rows(`
      SELECT
        CAST(count(*) FILTER (WHERE region IS DISTINCT FROM 'West') AS DOUBLE) AS not_west,
        CAST(count(*) FILTER (WHERE region <> 'West') AS DOUBLE) AS sql_neq,
        CAST(count(*) FILTER (WHERE CAST(${local} AS DATE) BETWEEN DATE '2026-01-01' AND DATE '2026-01-31') AS DOUBLE) AS jan,
        CAST(count(*) FILTER (WHERE ordered_at BETWEEN '2026-01-01' AND '2026-01-31') AS DOUBLE) AS sql_between,
        CAST(count(*) FILTER (WHERE CAST(${local} AS DATE) = DATE '2026-01-31') AS DOUBLE) AS jan_31,
        CAST(count(*) FILTER (WHERE CAST(${local} AS DATE) > DATE '2026-01-31') AS DOUBLE) AS after_jan,
        CAST(count(*) FILTER (WHERE channel IS DISTINCT FROM 'app') AS DOUBLE) AS web_or_null
      FROM read_csv('${csv}')`);
    expect(o).toMatchObject({ not_west: 4, sql_neq: 2, jan: 3, sql_between: 1, jan_31: 2 });
    expect(value("not_west")).toBe(o?.not_west);
    expect(value("not_in_west")).toBe(o?.not_west);
    expect(value("jan_between")).toBe(o?.jan);
    expect(value("jan_31")).toBe(o?.jan_31);
    expect(value("after_jan")).toBe(o?.after_jan);
    expect(value("web_or_null")).toBe(o?.web_or_null);
    expect(value("injected")).toBe(0);
  });

  it("sorts by a column in either direction with the null group last", async () => {
    const { data } = await run(edge.root, edge.project, "sorts");
    expect(block<TableData>(data, "t").rows.map((r) => r.keys[0])).toEqual(["West", "East", null]);
    expect(block<BarData>(data, "b").axis).toMatchObject({ categories: ["web", "app", null] });
  });

  it("drops the comparison when a period filter reads all_time, instead of failing", async () => {
    const { data, diagnostics } = await run(edge.root, edge.project, "period_filter");
    expect(diagnostics).toEqual([]);
    expect(data?.period).toEqual({ range: "all_time", compare: "previous_period" });
    const kpi = block<KpiData>(data, "orders");
    expect(kpi.value).toBe(7);
    expect(Object.keys(kpi)).not.toContain("previousValue");
    expect(Object.keys(kpi)).not.toContain("current");
  });

  it("binds a select filter's default, matching the column case-insensitively", async () => {
    const { data, diagnostics } = await run(edge.root, edge.project, "region_west");
    expect(diagnostics).toEqual([]);
    expect(block<KpiData>(data, "orders").value).toBe(4);
  });

  it("clips partial weeks at the window edges and buckets Sunday weeks in New York", async () => {
    const { data } = await run(edge.root, edge.project, "weeks");
    const line = block<LineData>(data, "weekly");
    expect(line.axis).toEqual({
      kind: "time",
      grain: "week",
      buckets: ["2026-03-29", "2026-04-05", "2026-04-12", "2026-04-19", "2026-04-26"],
      window: { start: "2026-04-01", end: "2026-05-01" },
    });
    expect(line.series.map((s) => s.values)).toEqual([
      [0, 110, 0, 0, 150],
      [null, 55, null, null, 75],
    ]);
  });

  it("resolves latest_data once, as the last local date over every time column of the plan", async () => {
    const { plan } = planDashboard(edge.project, "latest");
    expect(plan && planTimeColumns(plan)).toEqual([
      { source: "orders", column: "ordered_at" },
      { source: "sessions", column: "started_at" },
    ]);
    const { data, diagnostics } = await run(edge.root, edge.project, "latest");
    expect(diagnostics).toEqual([]);
    expect(data?.asOf).toBe("2026-05-02");
    expect(block<KpiData>(data, "orders")).toMatchObject({
      value: 2,
      current: { start: "2026-04-26", end: "2026-05-03" },
    });
    expect(block<KpiData>(data, "sessions").value).toBe(1);
  });

  it("gives identical results, byte for byte, when run twice", async () => {
    const again = await run(edge.root, edge.project, "ytd");
    expect(JSON.stringify(again)).toBe(JSON.stringify(ytd));
  });
});

describe("DuckDB executor queries", () => {
  const weekQuery = (column: string, anchor: "monday" | "sunday"): PlannedQuery => ({
    id: "q_week",
    source: "events",
    input: { type: "csv", path: "events.csv" },
    measures: [
      {
        metric: "n",
        components: [{ id: "n__count", aggregate: "count", filters: [], reaggregate: "sum" }],
        combine: { op: "identity", component: "n__count" },
      },
    ],
    dimensions: [{ kind: "time", column, grain: { unit: "week", anchor } }],
    groupingSets: [[0]],
    window: { range: "all_time", shift: "none", column },
    params: [],
  });

  it("buckets weeks in the project time zone with its week start", async () => {
    const { root, project } = await writeProject({
      "hatchmark.json": { ...CONFIG, sources: { events: { type: "csv", path: "events.csv" } } },
      "events.csv": "at,naive\n2026-11-29T02:00:00Z,2026-11-29 02:00:00\n",
    });
    const config = project.config.spec;
    if (config === undefined) throw new Error("config");
    const executor = await createDuckDbExecutor({ root, config });
    try {
      const week = async (column: string, timezone: string, anchor: "monday" | "sunday") =>
        (
          await executor.execute(weekQuery(column, anchor), {
            asOf: "2026-11-30",
            timezone,
            anchors: DEFAULT_ANCHORS,
            bindings: {},
          })
        ).rows[0]?.[0];
      expect(await week("at", "UTC", "monday")).toBe("2026-11-23");
      expect(await week("at", NY, "sunday")).toBe("2026-11-22");
      expect(await week("naive", NY, "sunday")).toBe("2026-11-22");
      expect(await week("naive", "UTC", "sunday")).toBe("2026-11-29");
    } finally {
      await executor.close();
    }
  });

  it("buckets anchored grains on the same days as the core's bucketStart", async () => {
    const days: string[] = [];
    for (let t = Date.UTC(2023, 11, 1); t < Date.UTC(2027, 1, 1); t += 86400000) {
      days.push(new Date(t).toISOString().slice(0, 10));
    }
    const { root, project } = await writeProject({
      "hatchmark.json": { ...CONFIG, sources: { events: { type: "csv", path: "events.csv" } } },
      "events.csv": `at,label\n${days.map((d) => `${d} 12:00:00,d${d}`).join("\n")}\n`,
    });
    const config = project.config.spec;
    if (config === undefined) throw new Error("config");
    const grains: ResolvedGrain[] = [
      { unit: "day" },
      { unit: "month" },
      ...WEEKDAYS.map((anchor) => ({ unit: "week", anchor }) as const),
      ...["01-01", "02-01", "02-15", "07-01", "12-28"].map(
        (anchor) => ({ unit: "quarter", anchor }) as const,
      ),
      ...["01-01", "02-15", "07-01", "10-28"].map((anchor) => ({ unit: "year", anchor }) as const),
    ];
    const executor = await createDuckDbExecutor({ root, config });
    try {
      for (const grain of grains) {
        const query: PlannedQuery = {
          id: "q_buckets",
          source: "events",
          input: { type: "csv", path: "events.csv" },
          measures: [
            {
              metric: "n",
              components: [{ id: "n__count", aggregate: "count", filters: [], reaggregate: "sum" }],
              combine: { op: "identity", component: "n__count" },
            },
          ],
          dimensions: [
            { kind: "time", column: "at", grain },
            { kind: "column", column: "label" },
          ],
          groupingSets: [[0, 1]],
          window: { range: "all_time", shift: "none", column: "at" },
          params: [],
        };
        const { rows } = await executor.execute(query, {
          asOf: "2027-01-31",
          timezone: "UTC",
          anchors: DEFAULT_ANCHORS,
          bindings: {},
        });
        expect(rows).toHaveLength(days.length);
        const wrong = rows.filter(
          ([bucket, label]) => bucket !== bucketStart(String(label).slice(1), grain),
        );
        expect({ grain, wrong: wrong.slice(0, 3) }).toEqual({ grain, wrong: [] });
      }
    } finally {
      await executor.close();
    }
  });

  it("returns typed columns and a grouping set per row", async () => {
    const config = edge.project.config.spec;
    if (config === undefined) throw new Error("config");
    const { plan } = planDashboard(edge.project, "ytd");
    const executor = await createDuckDbExecutor({ root: edge.root, config });
    try {
      const query = plan?.queries.find(
        (q) => q.dimensions[0]?.kind === "column" && q.groupingSets.length === 2,
      );
      if (query === undefined) throw new Error("no table query");
      const result = await executor.execute(query, {
        asOf: "2026-04-30",
        timezone: NY,
        anchors: { ...DEFAULT_ANCHORS, week: "sunday" },
        bindings: {},
      });
      expect(result.columns[0]).toEqual({ name: "region", type: "string" });
      expect(result.groupingSet).toEqual([0, 0, 0, 1]);
      expect(result.rows.at(-1)?.[0]).toBeNull();
    } finally {
      await executor.close();
    }
  });

  it("refuses a binding a single select cannot take", async () => {
    const config = edge.project.config.spec;
    if (config === undefined) throw new Error("config");
    const { plan } = planDashboard(edge.project, "region_west");
    const query = plan?.queries[0];
    if (query === undefined) throw new Error("no query");
    const executor = await createDuckDbExecutor({ root: edge.root, config });
    try {
      const context = {
        asOf: "2026-04-30",
        timezone: NY,
        anchors: { ...DEFAULT_ANCHORS, week: "sunday" } as const,
      };
      await expect(
        executor.execute(query, { ...context, bindings: { region: ["West", "East"] } }),
      ).rejects.toThrow("takes one value");
      const all = await executor.execute(query, { ...context, bindings: { region: [] } });
      expect(all.rows[0]?.[0]).toBe(7);
    } finally {
      await executor.close();
    }
  });

  it("runs a comparison shifted before year 0000 without a previous value", async () => {
    const ancient = await writeProject({
      ...files(),
      "dashboards/ancient.json": {
        title: "Ancient",
        period: {
          asOf: "2026-04-30",
          range: { start: "2026-01-01", end: "2026-05-01" },
          compare: { shift: { unit: "year", by: -3000 } },
        },
        blocks: [{ type: "kpi", id: "orders", metric: "orders" }],
      },
    });
    const { data, diagnostics } = await run(ancient.root, ancient.project, "ancient");
    expect(diagnostics).toEqual([]);
    const kpi = block<KpiData>(data, "orders");
    expect(kpi.value).toBeTypeOf("number");
    expect(kpi.previousValue).toBeUndefined();
  });

  it("reports a missing column as HM2015 with the cause", async () => {
    const broken = await writeProject({
      ...files(),
      "metrics/revenue.json": orders({ aggregate: "sum", column: "price", filters: paid }),
    });
    broken.project.columns.delete("orders");
    const { data, diagnostics } = await run(broken.root, broken.project, "weeks");
    expect(data).toBeUndefined();
    expect(diagnostics.map((d) => [d.code, d.message])).toEqual([
      ["HM2015", 'query on source "orders" failed: source "orders" has no column "price"'],
    ]);
  });
});

describe("Parquet sources", () => {
  it("discovers Parquet columns for HM2013, case-insensitively, and gives the CSV numbers", async () => {
    const parquet = await writeProject({
      ...files({
        ...CONFIG,
        sources: {
          orders: { type: "parquet", path: "data/orders.parquet" },
          sessions: { type: "csv", path: "data/sessions.csv" },
        },
      }),
      "dashboards/conversion.json": {
        title: "Conversion",
        period: YTD,
        filters: [{ type: "select", id: "region", column: "region" }],
        blocks: [
          { type: "table", id: "t", by: ["region"], metrics: ["orders", "sessions", "conversion"] },
        ],
      },
    });
    await oracle.run(
      `COPY (SELECT * EXCLUDE (region), region AS "Region" FROM read_csv('${path.join(parquet.root, "data/orders.csv")}')) TO '${path.join(parquet.root, "data/orders.parquet")}' (FORMAT parquet)`,
    );
    const { project } = await loadAt(parquet.root);
    expect(project.columns.get("orders")).toContain("Region");
    expect(checkReferences(project)).toEqual([]);
    const result = await run(parquet.root, project, "conversion");
    expect(result.diagnostics).toEqual([]);
    const table = block<TableData>(result.data, "t");
    expect(table.rows).toEqual(block<TableData>(ytd.data, "conversion_by_region").rows);
    expect(table.total).toEqual(block<TableData>(ytd.data, "conversion_by_region").total);

    await oracle.run(
      `COPY (SELECT * EXCLUDE (region) FROM read_csv('${path.join(parquet.root, "data/orders.csv")}')) TO '${path.join(parquet.root, "data/orders.parquet")}' (FORMAT parquet)`,
    );
    const lacking = await loadAt(parquet.root);
    expect(lacking.project.columns.get("orders")).not.toContain("Region");
    const hm2013 = checkReferences(lacking.project).filter((d) => d.code === "HM2013");
    expect(hm2013.map((d) => d.message)).toEqual([
      'filter "region" would apply to sessions but not to orders in this block',
    ]);
  });

  it("keeps columns unknown when the file cannot be read", async () => {
    const unreadable = await writeProject({
      ...files({
        ...CONFIG,
        sources: { orders: { type: "parquet", path: "data/orders.parquet" } },
      }),
    });
    await writeFile(path.join(unreadable.root, "data/orders.parquet"), "not parquet");
    const { project } = await loadAt(unreadable.root);
    expect(project.columns.has("orders")).toBe(false);
  });

  it("reads JSON sources", async () => {
    const json = await writeProject({
      ...files({
        ...CONFIG,
        sources: {
          ...CONFIG.sources,
          orders: { type: "json", path: "data/orders.json", format: "ndjson" },
        },
      }),
    });
    await oracle.run(
      `COPY (SELECT * FROM read_csv('${path.join(json.root, "data/orders.csv")}')) TO '${path.join(json.root, "data/orders.json")}' (FORMAT json)`,
    );
    const { project } = await loadAt(json.root);
    expect(project.columns.get("orders")).toContain("customer_id");
    const result = await run(json.root, project, "weeks");
    expect(result.diagnostics).toEqual([]);
    expect(block<LineData>(result.data, "weekly").series[0]?.values).toEqual([0, 110, 0, 0, 150]);
  });
});
