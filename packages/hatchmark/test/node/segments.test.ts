import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type DashboardData,
  type KpiData,
  runDashboard,
  type TableData,
} from "../../src/compiler/index.js";
import { createCachedExecutor, createDuckDbExecutor } from "../../src/node/index.js";
import { PROJECT_DEFAULTS } from "../../src/spec/index.js";
import { loadAt, metric, Oracle, removeProjects, run, writeProject } from "./fixture.js";

const ORDERS = [
  "ordered_at,customer,customer_no,region,status,amount",
  "2026-01-05,acme,1001,emea,paid,120",
  "2026-01-09,staff,1002,emea,paid,40",
  "2026-01-17,,1003,amer,paid,75",
  "2026-02-02,acme,1001,amer,refunded,300",
  "2026-02-14,globex,,apac,paid,90",
  "2026-02-20,staff,1002,,paid,10",
  "2026-03-03,initech,1004,apac,paid,210",
  "2026-03-08,globex,1005,,paid,15",
  "2026-03-21,qa_bot,1006,amer,paid,500",
].join("\n");

const INTERNAL = ["customer", "staff", "qa_bot", "", "staff"].join("\n");
const VIP = ["code", "1001", "1004", "", "1004"].join("\n");

const external = { column: "customer", op: "not_in_table", table: "internal", key: "customer" };
const vip = { column: "customer_no", op: "in_table", table: "vip", key: "code" };
const sum = {
  type: "aggregate",
  table: "orders",
  aggregate: "sum",
  column: "amount",
  time: "ordered_at",
};
const count = { type: "aggregate", table: "orders", aggregate: "count", time: "ordered_at" };

const METRICS = {
  revenue: sum,
  external_revenue: { ...sum, segments: ["external"] },
  external_customers: {
    ...sum,
    aggregate: "count_distinct",
    column: "customer",
    segments: ["external"],
  },
  external_avg: { ...sum, aggregate: "avg", segments: ["external"] },
  external_paid_large: {
    ...sum,
    filters: [{ column: "status", op: "eq", value: "paid" }],
    segments: ["external", "large"],
  },
  internal_orders: { ...count, filters: [{ ...external, op: "in_table" }] },
  vip_orders: { ...count, filters: [vip] },
  non_vip_orders: { ...count, filters: [{ ...vip, op: "not_in_table" }] },
  external_share: { type: "ratio", numerator: "external_revenue", denominator: "revenue" },
  external_net: {
    type: "sql",
    table: "orders",
    sql: "sum(amount) - count(*)",
    additive: false,
    time: "ordered_at",
    filters: [external],
  },
  external_net_segment: {
    type: "sql",
    table: "orders",
    sql: "sum(amount) - count(*)",
    additive: false,
    time: "ordered_at",
    segments: ["external"],
  },
  numbered_orders: {
    ...count,
    filters: [{ column: "customer_no", op: "in_table", table: "orders", key: "customer_no" }],
  },
};

const TABLE_METRICS = [
  "revenue",
  "external_revenue",
  "external_customers",
  "external_avg",
  "vip_orders",
] as const;

const DASHBOARD = {
  title: "Segments",
  period: { asOf: "2026-03-21", range: "all_time", compare: "none" },
  blocks: [
    ...Object.keys(METRICS).map((name) => ({ type: "kpi", id: name, metric: name })),
    { type: "table", id: "by_region", by: ["region"], metrics: [...TABLE_METRICS] },
  ],
};

const EXTERNAL_ROW =
  "(o.customer IS NULL OR NOT EXISTS (SELECT 1 FROM internal i WHERE i.customer = o.customer))";
const VIP_ROW = "EXISTS (SELECT 1 FROM vip v WHERE v.code = o.customer_no)";

let oracle: Oracle;
let data: DashboardData | undefined;
let diagnostics: { code: string }[];

const project = () =>
  writeProject({
    "hatchmark.yaml": {
      ...PROJECT_DEFAULTS,
      name: "segments",
      sources: {
        orders: { type: "csv", path: "data/orders.csv" },
        internal: { type: "csv", path: "data/internal.csv" },
        vip: { type: "csv", path: "data/vip.csv" },
      },
    },
    "data/orders.csv": ORDERS,
    "data/internal.csv": INTERNAL,
    "data/vip.csv": VIP,
    "segments/external.yaml": { label: "External customers", filters: [external] },
    "segments/large.yaml": {
      label: "Large orders",
      filters: [{ column: "amount", op: "gte", value: 100 }],
    },
    ...Object.fromEntries(
      Object.entries(METRICS).map(([n, m]) => [`metrics/${n}.yaml`, metric(m)]),
    ),
    "dashboards/d.yaml": DASHBOARD,
  });

beforeAll(async () => {
  const { root, project: loaded } = await project();
  const result = await run(root, loaded, "d");
  data = result.data;
  diagnostics = result.diagnostics;
  oracle = await Oracle.open();
  for (const name of ["orders", "internal", "vip"]) {
    await oracle.run(
      `CREATE TABLE ${name === "orders" ? "o" : name} AS SELECT * FROM read_csv('${root}/data/${name}.csv', sample_size = -1)`,
    );
  }
});

afterAll(async () => {
  oracle?.close();
  await removeProjects();
});

function block<T>(id: string): T {
  const found = data?.blocks.find((b) => b.id === id);
  if (found === undefined) throw new Error(`no block ${id}`);
  return found as T;
}

async function one(sql: string): Promise<number | null> {
  const [row] = await oracle.rows(sql);
  const value = Object.values(row ?? {})[0];
  return value === null || value === undefined ? null : Number(value);
}

function close(actual: number | null | undefined, expected: number | null, label: string) {
  if (expected === null) expect(actual, label).toBeNull();
  else expect(actual, label).toBeCloseTo(expected, 12);
}

describe("segments and in_table filters", () => {
  it("builds every block with no warning", () => {
    expect(diagnostics).toEqual([]);
    expect(data?.blocks.map((b) => b.id)).toEqual([...Object.keys(METRICS), "by_region"]);
  });

  it("filters KPIs exactly as the SQL oracle does", async () => {
    const value = (id: string) => block<KpiData>(id).value;
    const ext = `FROM o WHERE ${EXTERNAL_ROW}`;
    const expected: Record<string, string> = {
      revenue: "SELECT sum(amount) FROM o",
      external_revenue: `SELECT sum(amount) ${ext}`,
      external_customers: `SELECT count(DISTINCT customer) ${ext}`,
      external_avg: `SELECT avg(amount) ${ext}`,
      external_paid_large: `SELECT sum(amount) ${ext} AND status = 'paid' AND amount >= 100`,
      internal_orders:
        "SELECT count(*) FROM o WHERE EXISTS (SELECT 1 FROM internal i WHERE i.customer = o.customer)",
      vip_orders: `SELECT count(*) FROM o WHERE ${VIP_ROW}`,
      non_vip_orders: `SELECT count(*) FROM o WHERE NOT ${VIP_ROW}`,
      external_share: `SELECT (SELECT sum(amount) ${ext}) / (SELECT sum(amount) FROM o)`,
      external_net: `SELECT sum(amount) - count(*) ${ext}`,
      external_net_segment: `SELECT sum(amount) - count(*) ${ext}`,
      numbered_orders: "SELECT count(*) FROM o WHERE customer_no IS NOT NULL",
    };
    for (const [id, sql] of Object.entries(expected)) close(value(id), await one(sql), id);
  });

  it("keeps a null customer outside the internal list and a null customer number out of the VIP list", () => {
    expect(block<KpiData>("external_customers").value).toBe(3);
    expect(block<KpiData>("internal_orders").value).toBe(3);
    expect(block<KpiData>("vip_orders").value).toBe(3);
    expect(block<KpiData>("non_vip_orders").value).toBe(6);
  });

  it("splits a table by region, null group and total included, as the oracle's ROLLUP does", async () => {
    const table = block<TableData>("by_region");
    const rows = await oracle.rows(
      `SELECT region, sum(amount) AS revenue,
        coalesce(sum(amount) FILTER (WHERE ${EXTERNAL_ROW}), 0) AS external_revenue,
        count(DISTINCT customer) FILTER (WHERE ${EXTERNAL_ROW}) AS external_customers,
        avg(amount) FILTER (WHERE ${EXTERNAL_ROW}) AS external_avg,
        count(*) FILTER (WHERE ${VIP_ROW}) AS vip_orders,
        GROUPING(region) AS g
      FROM o GROUP BY ROLLUP (region)`,
    );
    const compare = (
      values: Record<string, number | null> | undefined,
      want: Record<string, unknown> | undefined,
      label: string,
    ) => {
      for (const m of TABLE_METRICS) {
        const w = want?.[m];
        close(values?.[m], w === null || w === undefined ? null : Number(w), `${label} ${m}`);
      }
    };
    const groups = rows.filter((r) => r.g === 0);
    expect(table.rows).toHaveLength(groups.length);
    for (const row of table.rows) {
      const want = groups.find((r) => r.region === row.keys[0]);
      expect(want, `group ${String(row.keys[0])}`).toBeDefined();
      compare(row.values, want, String(row.keys[0]));
    }
    compare(
      table.total?.values,
      rows.find((r) => r.g === 1),
      "total",
    );
  });
  it("reads a changed key table again instead of reusing a cached result", async () => {
    const { root, project: loaded } = await project();
    const config = loaded.config.spec;
    if (config === undefined) throw new Error("invalid hatchmark.yaml");
    const externalRevenue = async () => {
      const executor = await createCachedExecutor({
        root,
        config,
        createInner: (at) => createDuckDbExecutor({ root: at, config }),
      });
      try {
        const { project: current } = await loadAt(root);
        const { data } = await runDashboard(current, "d", executor);
        const kpi = data?.blocks.find((b) => b.id === "external_revenue") as KpiData | undefined;
        return { value: kpi?.value, stats: executor.stats() };
      } finally {
        await executor.close();
      }
    };
    const cold = await externalRevenue();
    const warm = await externalRevenue();
    expect(warm.value).toBe(cold.value);
    expect(warm.stats.hits).toBeGreaterThan(0);
    await writeFile(path.join(root, "data", "internal.csv"), `${INTERNAL}\nacme`);
    const edited = await externalRevenue();
    expect(edited.stats.misses).toBeGreaterThan(warm.stats.misses);
    expect(edited.value).toBe(Number(cold.value) - 120 - 300);
  });
  it("rejects a key column of another type instead of coercing it (HM2029)", async () => {
    const { root, project } = await writeProject({
      "hatchmark.yaml": {
        ...PROJECT_DEFAULTS,
        name: "typed",
        sources: {
          orders: { type: "csv", path: "data/orders.csv" },
          codes: { type: "csv", path: "data/codes.csv" },
        },
      },
      "data/orders.csv": ORDERS,
      "data/codes.csv": ["code", "1001", "x9"].join("\n"),
      "segments/coded.yaml": {
        label: "Coded",
        filters: [{ column: "customer_no", op: "in_table", table: "codes", key: "code" }],
      },
      "metrics/coded.yaml": metric({ ...count, segments: ["coded"] }),
      "dashboards/d.yaml": {
        title: "D",
        period: { asOf: "2026-03-21", range: "all_time", compare: "none" },
        blocks: [{ type: "kpi", id: "coded", metric: "coded" }],
      },
    });
    const result = await run(root, project, "d");
    expect(result.data).toBeUndefined();
    expect(result.diagnostics.map((d) => [d.code, d.file, d.pointer, d.message])).toEqual([
      [
        "HM2029",
        "metrics/coded.yaml",
        "/segments/0",
        'in_table compares column "customer_no" (BIGINT) of "orders" with key "code" (VARCHAR) of "codes"',
      ],
    ]);
  });
});
