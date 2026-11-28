import { appendFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { DashboardData, TableData } from "../../src/compiler/dashboard-data.js";
import { runDashboard } from "../../src/compiler/index.js";
import { customRangeDashboard, type PeriodData } from "../../src/compiler/period-data.js";
import { parseDaysKey } from "../../src/compiler/periods.js";
import { createDuckDbExecutor } from "../../src/node/index.js";
import type { RangeSpec } from "../../src/spec/index.js";
import { fromYaml, toYaml } from "../yaml.js";
import { buildProject, EXAMPLE, loadAt, Oracle, removeProjects, writeExample } from "./fixture.js";
import {
  type Anchors,
  addDays,
  checkDashboard,
  compareData,
  Diff,
  ended,
  type Horizon,
  horizonOf,
  periodsOf,
  type Range,
  type Row,
  randomRanges,
  readRows,
  type SpecBlock,
  type Window,
} from "./periods.oracle.js";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const tally = { cells: 0, mismatches: 0 };
const record = (d: Diff) => {
  tally.cells += d.cells;
  tally.mismatches += d.problems.length;
  return d;
};
afterAll(async () => {
  console.log(`periods.attacks: ${tally.cells} cells compared, ${tally.mismatches} mismatches`);
  await removeProjects();
});

const EXTRA = [
  "900001,2025-06-15T15:00:00Z,C90001,,,,,paid,50.00",
  "900002,2025-06-15T16:00:00Z,C90002,Atlantis,,Direct,,refunded,20.00",
  "900003,2025-06-15T17:00:00Z,,United States,Americas,,Toys,paid,",
  "900004,2025-06-16T03:30:00Z,C90003,,EMEA,Direct,,,10.00",
  "900005,2026-03-08T06:30:00Z,C90004,,,Email,,paid,77.00",
  "900006,2026-03-08T04:59:59Z,C90005,Canada,Americas,Email,Home,paid,12.50",
  "900007,2025-11-02T05:30:00Z,C90006,Canada,Americas,Email,Home,paid,13.25",
  "900008,2025-11-02T04:00:00Z,C90007,Canada,Americas,Email,Home,paid,14.75",
  "900009,2025-11-02T03:59:59Z,C90008,Canada,Americas,Email,Home,refunded,15.00",
  "900010,,C90009,France,EMEA,Direct,Home,paid,1000.00",
];

const PAID = { filters: [{ column: "status", op: "eq", value: "paid" }], time: "ordered_at" };
const amount = (aggregate: string) => ({
  type: "aggregate",
  table: "orders",
  aggregate,
  column: "amount",
  ...PAID,
});
const EXTRA_METRICS: Record<string, Record<string, unknown>> = {
  avg_amount: amount("avg"),
  min_amount: amount("min"),
  max_amount: amount("max"),
  median_amount: amount("median"),
  net_sql: { type: "sql", table: "orders", sql: "sum(amount)", additive: true, ...PAID },
  spread_sql: {
    type: "sql",
    table: "orders",
    sql: "max(amount) - min(amount)",
    additive: false,
    ...PAID,
  },
  rev_per_customer: { type: "ratio", numerator: "revenue", denominator: "customers" },
  orders_per_rpc: { type: "ratio", numerator: "orders", denominator: "rev_per_customer" },
  spread_per_order: { type: "ratio", numerator: "spread_sql", denominator: "orders" },
};
const BLIND = new Set([
  "customers",
  "median_amount",
  "spread_sql",
  "rev_per_customer",
  "orders_per_rpc",
  "spread_per_order",
]);
const METRIC_BLOCKS: SpecBlock[] = [
  ...Object.keys(EXTRA_METRICS).map((m) => ({ type: "kpi", id: `k_${m}`, metric: m })),
  {
    type: "line",
    id: "amounts",
    metrics: ["avg_amount", "min_amount", "max_amount"],
    grain: "week",
    grains: ["day", "week", "month"],
  },
  {
    type: "table",
    id: "by_country",
    by: ["country"],
    metrics: [...Object.keys(EXTRA_METRICS), "orders"],
    sort: { by: "orders", order: "desc" },
    limit: 8,
  },
];

type Filter = {
  type: string;
  id: string;
  options?: Range[];
  default?: unknown;
  [k: string]: unknown;
};
const periodFilter = (options: Range[], extra: Record<string, unknown> = {}): Filter => ({
  type: "period",
  id: "period",
  options,
  default: { last: 12, unit: "month" },
  ...extra,
});
const grainFilter = (d: string): Filter => ({
  type: "grain",
  id: "grain",
  options: ["day", "week", "month"],
  default: d,
});
const NULL_BLOCKS: SpecBlock[] = [
  { type: "kpi", id: "k_rev", metric: "revenue", sparkline: true },
  { type: "kpi", id: "k_refund", metric: "refund_rate" },
  { type: "kpi", id: "k_aov", metric: "avg_order_value" },
  { type: "kpi", id: "k_cust", metric: "customers" },
  {
    type: "line",
    id: "rev_region",
    metrics: ["revenue"],
    split: "region",
    grain: "week",
    grains: ["day", "week", "month", "quarter", "year"],
  },
  { type: "area", id: "orders_cat", metrics: ["orders"], split: "category", grain: "month" },
  {
    type: "line",
    id: "ratios",
    metrics: ["avg_order_value", "refund_rate"],
    grain: "month",
    grains: ["week", "month"],
  },
  {
    type: "bar",
    id: "cat",
    metrics: ["revenue", "orders"],
    by: "category",
    sort: { by: "revenue", order: "desc" },
    limit: 3,
  },
  {
    type: "bar",
    id: "aov_asc",
    metrics: ["avg_order_value"],
    by: "country",
    sort: { by: "avg_order_value", order: "asc" },
    limit: 5,
  },
  {
    type: "table",
    id: "region_cat",
    by: ["region", "category"],
    metrics: ["revenue", "orders", "avg_order_value", "refund_rate"],
    percentOfTotal: ["revenue", "orders"],
    sort: { by: "orders", order: "desc" },
    limit: 5,
  },
];
const NULL_OPTIONS: Range[] = [
  { last: 30, unit: "day" },
  { last_complete: "quarter" },
  { to_date: "year" },
  { start: "2025-06-01", end: "2025-07-01" },
  { last: 12, unit: "month" },
];
const dash = (title: string, filters: Filter[], blocks: SpecBlock[], asOf = "latest_data") => ({
  title,
  period: { asOf, range: "last_12_months", compare: "previous_period" },
  filters,
  blocks,
});

type Built = { root: string; rows: Row[]; payloads: Record<string, PeriodData> };
async function build(
  config: Record<string, unknown>,
  dashboards: Record<string, unknown>,
  extra = false,
  truncate?: string,
): Promise<Built> {
  const root = await writeExample(config, dashboards);
  if (truncate) {
    const csv = path.join(root, "data/orders.csv");
    const [header, ...lines] = (await readFile(csv, "utf8")).trimEnd().split("\n");
    const kept = lines.filter((l) => (l.split(",")[1] ?? "") < truncate);
    const last = `999999,${truncate},C99999,United States,Americas,Direct,Home,paid,1.00`;
    await writeFile(csv, `${[header, ...kept, last].join("\n")}\n`);
  }
  for (const [name, m] of Object.entries(extra ? EXTRA_METRICS : {}))
    await writeFile(
      path.join(root, `metrics/${name}.yaml`),
      toYaml({ label: name, format: { type: "number" }, better: "up", ...m }),
    );
  if (extra) {
    const csv = path.join(root, "data/orders.csv");
    const text = await readFile(csv, "utf8");
    await appendFile(csv, `${text.endsWith("\n") ? "" : "\n"}${EXTRA.join("\n")}\n`);
  }
  const built = await buildProject(root);
  expect(built.report).toMatchObject({ ok: true });
  const payloads: Record<string, PeriodData> = {};
  for (const name of Object.keys(dashboards))
    payloads[name] = periodsOf(
      await readFile(path.join(root, `dist/${name}/index.html`), "utf8"),
    ) as PeriodData;
  return { root, rows: await readRows(root), payloads };
}

type Case = {
  payload: PeriodData;
  rows: Row[];
  asOf: string;
  horizon: Horizon;
  anchors: Anchors;
  blocks: SpecBlock[];
  options: Range[];
  grainDefault: string;
  where?: (r: Row) => boolean;
  compare?: "previous_year";
  blind?: Set<string>;
};
function checkPresets(c: Case, diff: Diff): void {
  const rows = c.where ? c.rows.filter(c.where) : c.rows;
  for (const option of c.options) {
    const data = Object.values(c.payload.presets).find(
      (d) => JSON.stringify(d.period.range) === JSON.stringify(option),
    );
    if (data === undefined) {
      diff.problems.push(`no preset for ${JSON.stringify(option)}`);
      continue;
    }
    checkDashboard(
      data,
      c.blocks,
      {
        rows,
        range: option,
        horizon: c.horizon,
        anchors: c.anchors,
        grainDefault: c.grainDefault,
        ...(c.compare ? { compare: c.compare } : {}),
      },
      diff,
    );
  }
}
function customOf(c: Case, w: Window): DashboardData {
  return customRangeDashboard(
    c.payload.custom as NonNullable<PeriodData["custom"]>,
    c.payload.filter,
    { start: w[0], end: w[1] },
  );
}
function checkCustom(c: Case, w: Window, diff: Diff): DashboardData {
  const rows = c.where ? c.rows.filter(c.where) : c.rows;
  const data = customOf(c, w);
  checkDashboard(
    data,
    c.blocks,
    {
      rows,
      range: { start: w[0], end: w[1] },
      horizon: c.horizon,
      ...(c.compare ? { compare: c.compare } : {}),
      anchors: c.anchors,
      grainDefault: c.grainDefault,
      presetOnly: c.blind ?? new Set(c.payload.custom?.presetOnly),
    },
    diff,
  );
  return data;
}

const NULL_EDGES: Window[] = [
  ["2025-06-15", "2025-06-16"],
  ["2025-06-14", "2025-06-17"],
  ["2025-06-16", "2025-06-17"],
  ["2025-11-01", "2025-11-03"],
  ["2026-03-07", "2026-03-09"],
  ["2025-06-11", "2025-06-18"],
  ["2024-11-01", "2026-11-01"],
];

describe("empty and null groups, non-additive metrics, and a select default with the period and grain filters", () => {
  let b: Built;
  let nulls: Case;
  let combo: Case;
  let metrics: Case;
  let prevyear: Case;
  beforeAll(async () => {
    b = await build(
      {},
      {
        nulls: dash("Nulls", [periodFilter(NULL_OPTIONS), grainFilter("month")], NULL_BLOCKS),
        combo: dash(
          "Combo",
          [
            {
              type: "select",
              id: "region",
              column: "region",
              multiple: true,
              default: ["EMEA", "APAC"],
            },
            periodFilter(NULL_OPTIONS),
            grainFilter("week"),
          ],
          NULL_BLOCKS,
        ),
        fixed: dash(
          "Presets only",
          [periodFilter(NULL_OPTIONS, { custom: false })],
          NULL_BLOCKS.slice(0, 4),
        ),
        metrics: dash("Metrics", [periodFilter(NULL_OPTIONS), grainFilter("day")], METRIC_BLOCKS),
        prevyear: {
          ...dash("Previous year", [periodFilter(NULL_OPTIONS), grainFilter("month")], NULL_BLOCKS),
          period: { asOf: "latest_data", range: "last_12_months", compare: "previous_year" },
        },
      },
      true,
    );
    const base = {
      rows: b.rows,
      asOf: "2026-10-31",
      horizon: horizonOf(b.rows, "latest_data"),
      anchors: { week: "sunday", quarter: "01-01", year: "01-01" },
      blocks: NULL_BLOCKS,
      options: NULL_OPTIONS,
    };
    nulls = { ...base, payload: b.payloads.nulls as PeriodData, grainDefault: "month" };
    combo = {
      ...base,
      payload: b.payloads.combo as PeriodData,
      grainDefault: "week",
      where: (r) => r.region === "EMEA" || r.region === "APAC",
    };
    metrics = {
      ...base,
      blocks: METRIC_BLOCKS,
      payload: b.payloads.metrics as PeriodData,
      grainDefault: "day",
      blind: BLIND,
    };
    prevyear = {
      ...base,
      payload: b.payloads.prevyear as PeriodData,
      grainDefault: "month",
      compare: "previous_year",
    };
  });

  it("avg, min, max, median, SQL and nested-ratio metrics: presets exact, custom ranges exact or null with presetOnly", () => {
    expect(metrics.payload.custom?.presetOnly).toEqual([
      "customers",
      "median_amount",
      "spread_sql",
    ]);
    const diff = new Diff();
    checkPresets(metrics, diff);
    const first: Window[] = [
      ["2024-11-01", "2024-11-02"],
      ["2024-11-01", "2024-12-01"],
    ];
    for (const w of [
      ...first,
      ...NULL_EDGES,
      ...randomRanges(40, metrics.payload.custom?.span as { start: string; end: string }, 11),
    ])
      checkCustom(metrics, w, diff);
    record(diff);
    expect(diff.problems.slice(0, 10)).toEqual([]);
  });

  it("the browser path equals runDashboard's SQL path for the metrics dashboard and the null groups, but for preset-only metrics", async () => {
    const { project } = await loadAt(b.root);
    const config = project.config.spec;
    if (config === undefined) throw new Error("invalid hatchmark.yaml");
    const executor = await createDuckDbExecutor({ root: b.root, config });
    const diff = new Diff();
    try {
      for (const [name, c] of [
        ["metrics", metrics],
        ["nulls", nulls],
        ["combo", combo],
      ] as const) {
        const skipBlocks = new Set(
          c.blocks.filter((x) => x.metric !== undefined && BLIND.has(x.metric)).map((x) => x.id),
        );
        for (const w of [
          ...NULL_EDGES,
          ...randomRanges(10, c.payload.custom?.span as { start: string; end: string }, 5),
        ]) {
          const binding = { start: w[0], end: w[1] } as unknown as RangeSpec;
          const sql = await runDashboard(project, name, executor, undefined, { period: binding });
          const browser = customOf(c, w);
          const blank = (d: unknown) =>
            JSON.parse(JSON.stringify(d), (k, v) => (BLIND.has(k) ? undefined : v));
          compareData(
            blank(browser),
            blank(sql.data),
            new Set(["periodFilter", "presetOnly"]),
            skipBlocks,
            diff,
            `${name} ${w}`,
          );
        }
      }
    } finally {
      await executor.close();
    }
    record(diff);
    expect(diff.problems.slice(0, 10)).toEqual([]);
  });

  it.fails("an additive SQL sum is 0, like revenue, over a comparison window before the first data day", () => {
    const data = customOf(metrics, ["2024-11-01", "2024-12-01"]);
    const k = data.blocks.find((x) => x.id === "k_net_sql");
    expect(k).toMatchObject({ previousValue: 0 });
  });

  it("compare previous_year: presets and custom ranges (Feb 28 to Mar 1, comparisons before the data) match the oracle", () => {
    const diff = new Diff();
    checkPresets(prevyear, diff);
    const edges: Window[] = [
      ["2025-02-28", "2025-03-02"],
      ["2026-02-28", "2026-03-01"],
      ["2025-11-01", "2025-11-08"],
      ["2026-01-31", "2026-03-31"],
    ];
    for (const w of [
      ...edges,
      ...NULL_EDGES,
      ...randomRanges(40, prevyear.payload.custom?.span as { start: string; end: string }, 12),
    ])
      checkCustom(prevyear, w, diff);
    record(diff);
    expect(diff.problems.slice(0, 10)).toEqual([]);
  });

  it("the extra rows land on their New York days (the oracle sees what the attacks need)", () => {
    const day = (id: number) => b.rows[b.rows.length - EXTRA.length + id - 1]?.d;
    expect([day(4), day(5), day(6), day(7), day(8), day(9), day(10)]).toEqual([
      "2025-06-15",
      "2026-03-08",
      "2026-03-07",
      "2025-11-02",
      "2025-11-02",
      "2025-11-01",
      null,
    ]);
  });

  it("presets match the oracle with null groups (no select filter)", () => {
    const diff = new Diff();
    checkPresets(nulls, diff);
    record(diff);
    expect(diff.problems.slice(0, 10)).toEqual([]);
    expect(diff.cells).toBeGreaterThan(3000);
  });

  it("presets match the oracle with a select default, the period filter and the grain filter", () => {
    const diff = new Diff();
    checkPresets(combo, diff);
    record(diff);
    expect(diff.problems.slice(0, 10)).toEqual([]);
  });

  it("custom ranges (null-group days, DST edges, 60 random) match the oracle, with and without the select default", () => {
    const diff = new Diff();
    const span = nulls.payload.custom?.span as { start: string; end: string };
    for (const w of [...NULL_EDGES, ...randomRanges(60, span, 7)]) {
      checkCustom(nulls, w, diff);
      checkCustom(combo, w, diff);
    }
    record(diff);
    expect(diff.problems.slice(0, 10)).toEqual([]);
  });

  it("null groups are real groups: a null category and a null region show, labelled (empty)", () => {
    for (const data of [
      customOf(nulls, ["2025-06-15", "2025-06-16"]),
      nulls.payload.presets["2025-06-01..2025-06-30"] as DashboardData,
    ]) {
      const keys = (id: string) => {
        const block = data.blocks.find((x) => x.id === id);
        return block?.type === "line" || block?.type === "area"
          ? block.series.map((x) => x.key)
          : [];
      };
      expect(keys("orders_cat")).toContain("orders:(empty)");
      expect(keys("rev_region")).toContain("revenue:(empty)");
      const table = data.blocks.find((x) => x.id === "region_cat") as TableData;
      expect(table.rowCount).toBeGreaterThan(table.rows.length);
    }
  });

  it("customers (count_distinct) is null with presetOnly on every custom range, and the payload says so", () => {
    expect(nulls.payload.custom?.presetOnly).toEqual(["customers"]);
    for (const w of NULL_EDGES) {
      const k = customOf(nulls, w).blocks.find((x) => x.id === "k_cust");
      expect(k).toMatchObject({ value: null, presetOnly: true });
    }
  });

  it("a period filter with custom: false embeds presets only", () => {
    const p = b.payloads.fixed as PeriodData;
    expect(p.custom).toBeUndefined();
    expect(Object.keys(p.presets)).toHaveLength(NULL_OPTIONS.length);
  });

  it("table totals and leaf rows equal an SQL ROLLUP over the oracle's rows, for presets and custom ranges", async () => {
    const file = path.join(b.root, "oracle-rows.csv");
    const q = (v: string | null) => (v === null ? "\\N" : `"${v.replaceAll('"', '""')}"`);
    await writeFile(
      file,
      `t,d,region,category,status,a\n${b.rows.map((r) => [q(r.t === null ? null : new Date(r.t).toISOString()), q(r.d), q(r.region), q(r.category), q(r.status), r.a === null ? "\\N" : String(r.a)].join(",")).join("\n")}\n`,
    );
    const oracle = await Oracle.open();
    const diff = new Diff();
    try {
      await oracle.run(
        `CREATE TABLE t AS SELECT * FROM read_csv('${file.replaceAll("'", "''")}', nullstr = '\\N', columns = {'t': 'TIMESTAMPTZ', 'd': 'VARCHAR', 'region': 'VARCHAR', 'category': 'VARCHAR', 'status': 'VARCHAR', 'a': 'DOUBLE'})`,
      );
      const cases: [string, Case, DashboardData, Window][] = [];
      for (const c of [nulls, combo]) {
        for (const d of Object.values(c.payload.presets)) {
          cases.push([
            `${c.grainDefault} ${JSON.stringify(d.period.range)}`,
            c,
            d,
            ended(d.period.range as Range, c.horizon, c.anchors).current,
          ]);
        }
        for (const w of [
          ...NULL_EDGES,
          ...randomRanges(20, c.payload.custom?.span as { start: string; end: string }, 99),
        ])
          cases.push([
            `${c.grainDefault} custom ${w}`,
            c,
            customOf(c, w),
            ended({ start: w[0], end: w[1] }, c.horizon, c.anchors).current,
          ]);
      }
      for (const [at, c, data, w] of cases) {
        const where = c.where ? "AND region IN ('EMEA', 'APAC')" : "";
        const end = w[1].endsWith("Z") ? `t < '${w[1]}'::TIMESTAMPTZ` : `d < '${w[1]}'`;
        const got = await oracle.rows(
          `SELECT region, category, GROUPING(region, category) AS g, coalesce(sum(a) FILTER (WHERE status = 'paid'), 0) AS revenue, count(*) FILTER (WHERE status = 'paid') AS orders, count(*) FILTER (WHERE status = 'refunded') AS refunded, count(*) AS placed FROM t WHERE d >= '${w[0]}' AND ${end} ${where} GROUP BY ROLLUP (region, category)`,
        );
        const table = data.blocks.find((x) => x.id === "region_cat") as TableData;
        const metrics = (r: Record<string, unknown>) => {
          const [rev, orders, refunded, placed] = [r.revenue, r.orders, r.refunded, r.placed].map(
            Number,
          ) as [number, number, number, number];
          return {
            revenue: rev,
            orders,
            avg_order_value: orders ? rev / orders : null,
            refund_rate: placed ? refunded / placed : null,
          };
        };
        const total = got.find((r) => r.g === 3);
        const want =
          w[0] >= w[1]
            ? { revenue: null, orders: null, avg_order_value: null, refund_rate: null }
            : total
              ? metrics(total)
              : { revenue: 0, orders: 0, avg_order_value: null, refund_rate: null };
        for (const [m, v] of Object.entries(want))
          diff.num(`${at} total ${m}`, table.total?.values[m], v);
        const leaves = got.filter((r) => r.g === 0);
        diff.same(`${at} rowCount`, table.rowCount, leaves.length);
        for (const row of table.rows) {
          const leaf = leaves.find((r) => r.region === row.keys[0] && r.category === row.keys[1]);
          if (leaf === undefined) {
            diff.problems.push(`${at}: no ROLLUP leaf for ${JSON.stringify(row.keys)}`);
            continue;
          }
          for (const [m, v] of Object.entries(metrics(leaf)))
            diff.num(`${at} ${JSON.stringify(row.keys)} ${m}`, row.values[m], v);
        }
      }
    } finally {
      oracle.close();
    }
    record(diff);
    expect(diff.problems.slice(0, 10)).toEqual([]);
    expect(diff.cells).toBeGreaterThan(1000);
  });
});

const ANCHOR_OPTIONS: Range[] = [
  { last: 7, unit: "day" },
  { to_date: "week" },
  { last_complete: "week" },
  { to_date: "month" },
  { last_complete: "month" },
  { to_date: "quarter" },
  { last_complete: "quarter" },
  { to_date: "year" },
  { last_complete: "year" },
  { last: 3, unit: "month" },
  { last: 12, unit: "month" },
];

describe.each([
  {
    name: "shifted anchors (week wednesday, quarter 02-15, year 08-15)",
    config: {
      weekStart: undefined,
      anchors: { week: "wednesday", quarter: "02-15", year: "08-15" },
    },
    anchors: { week: "wednesday", quarter: "02-15", year: "08-15" },
    asOf: "latest_data",
    truncate: undefined,
    dayElapsed: 0.788113,
    edges: [
      ["2026-02-14", "2026-02-16"],
      ["2025-08-14", "2025-08-16"],
      ["2025-05-15", "2025-08-15"],
      ["2025-06-10", "2025-06-17"],
      ["2025-11-14", "2025-11-16"],
    ] as Window[],
  },
  {
    name: "a partial period: as-of 2026-03-30, mid-month, just after the March DST change",
    config: {},
    anchors: { week: "sunday", quarter: "01-01", year: "01-01" },
    asOf: "2026-03-30",
    truncate: undefined,
    dayElapsed: undefined,
    edges: [
      ["2026-03-30", "2026-03-31"],
      ["2026-03-07", "2026-03-10"],
      ["2026-02-28", "2026-03-31"],
      ["2024-11-01", "2026-03-31"],
      ["2026-03-25", "2026-03-31"],
    ] as Window[],
  },
  {
    name: "a horizon at 12:30 p.m. on Oct 1, the first day of a month and a quarter (to-date windows cover only its partial first day)",
    config: {},
    anchors: { week: "sunday", quarter: "01-01", year: "01-01" },
    asOf: "latest_data",
    truncate: "2026-10-01T16:30:00Z",
    dayElapsed: 0.520833,
    edges: [["2026-09-30", "2026-10-02"]] as Window[],
  },
  {
    name: "a horizon at 3 p.m. on the 23-hour DST start day, 2026-03-08 (elapsed in wall-clock time)",
    config: {},
    anchors: { week: "sunday", quarter: "01-01", year: "01-01" },
    asOf: "latest_data",
    truncate: "2026-03-08T19:00:00Z",
    dayElapsed: 0.625,
    edges: [["2026-03-01", "2026-03-09"]] as Window[],
  },
  {
    name: "a horizon in the repeated fall-back hour, 1:30 a.m. EST on 2025-11-02 (wall-clock 1.5 of 25 hours)",
    config: {
      weekStart: undefined,
      anchors: { week: "wednesday", quarter: "02-15", year: "08-15" },
    },
    anchors: { week: "wednesday", quarter: "02-15", year: "08-15" },
    asOf: "latest_data",
    truncate: "2025-11-02T06:30:00Z",
    dayElapsed: 0.0625,
    edges: [["2025-10-29", "2025-11-03"]] as Window[],
  },
  {
    name: "a fixed as-of before the newest data on a timestamp horizon day: 2026-10-30",
    config: {},
    anchors: { week: "sunday", quarter: "01-01", year: "01-01" },
    asOf: "2026-10-30",
    truncate: undefined,
    dayElapsed: undefined,
    edges: [["2026-10-25", "2026-10-31"]] as Window[],
  },
])("$name", ({ config, anchors, asOf, edges, truncate, dayElapsed }) => {
  let c: Case;
  beforeAll(async () => {
    const explorer = fromYaml(
      await readFile(path.join(EXAMPLE, "dashboards/explorer.yaml"), "utf8"),
    );
    const blocks: SpecBlock[] = [
      ...explorer.blocks,
      {
        type: "line",
        id: "anchored",
        metrics: ["revenue", "avg_order_value"],
        grain: "quarter",
        grains: ["week", "quarter", "year"],
      },
    ];
    const filters = [periodFilter(ANCHOR_OPTIONS), grainFilter("week")];
    const b = await build(config, { a: dash("Anchors", filters, blocks, asOf) }, false, truncate);
    const last = b.rows.reduce((m, r) => (r.d !== null && r.d > m ? r.d : m), "");
    c = {
      payload: b.payloads.a as PeriodData,
      rows: b.rows,
      asOf: asOf === "latest_data" ? last : asOf,
      horizon: horizonOf(b.rows, asOf),
      anchors,
      blocks,
      options: ANCHOR_OPTIONS,
      grainDefault: "week",
    };
  });

  it("the custom span ends the day after the as-of date", () => {
    expect(c.payload.custom?.span).toEqual({ start: "2024-11-01", end: addDays(c.asOf, 1) });
  });

  it("every preset matches the oracle", () => {
    const diff = new Diff();
    checkPresets(c, diff);
    record(diff);
    expect(diff.problems.slice(0, 10)).toEqual([]);
    expect(diff.cells).toBeGreaterThan(2000);
  });

  it("the default preset's day series ends with the partial share the RFC's wall-clock rule gives", () => {
    const line = c.payload.presets.last_12_months?.blocks.find((x) => x.id === "revenue_by_region");
    const day =
      line?.type === "line" ? line.grains?.options.find((o) => o.key === "day") : undefined;
    const partial = day?.series.map((x) => x.partial?.[0]?.elapsed);
    expect(new Set(partial)).toEqual(new Set([dayElapsed]));
    if (truncate === "2026-10-01T16:30:00Z") {
      const revenue = (from: string, through: string) =>
        c.rows
          .filter(
            (r) =>
              r.status === "paid" &&
              r.t !== null &&
              r.t >= Date.parse(from) &&
              r.t <= Date.parse(through),
          )
          .reduce((sum, r) => sum + (r.a ?? 0), 0);
      for (const [key, previous] of [
        ["month_to_date", "2026-09-01"],
        ["quarter_to_date", "2026-07-01"],
      ] as const) {
        const k = c.payload.presets[key]?.blocks.find((x) => x.id === "revenue");
        expect(k, key).toMatchObject({
          current: { start: "2026-10-01", end: "2026-10-02", endAt: "2026-10-01T12:30:00.000001" },
          previous: {
            start: previous,
            end: addDays(previous, 1),
            endAt: `${previous}T12:30:00.000001`,
          },
        });
        expect(k?.type === "kpi" ? k.empty : "not a kpi", key).toBeUndefined();
        const value = revenue("2026-10-01T04:00:00Z", truncate);
        const previousValue = revenue(`${previous}T04:00:00Z`, `${previous}T16:30:00Z`);
        expect(previousValue, key).toBeGreaterThan(0);
        expect(k?.type === "kpi" ? k.value : undefined, key).toBeCloseTo(value, 9);
        expect(k?.type === "kpi" ? k.previousValue : undefined, key).toBeCloseTo(previousValue, 9);
      }
    }
  });

  it("custom ranges at anchor boundaries, ranges ending on the as-of day, and 60 random ones match the oracle", () => {
    const diff = new Diff();
    const end = c.payload.custom?.span.end as string;
    const tail = [1, 2, 8, 31].map((n): Window => [addDays(end, -n), end]);
    for (const w of [
      ...edges,
      ...tail,
      ...randomRanges(60, c.payload.custom?.span as { start: string; end: string }, 2026),
    ])
      checkCustom(c, w, diff);
    record(diff);
    expect(diff.problems.slice(0, 10)).toEqual([]);
  });
});

describe("invalid custom ranges throw instead of returning numbers", () => {
  let payload: PeriodData;
  beforeAll(async () => {
    const explorer = fromYaml(
      await readFile(path.join(EXAMPLE, "dashboards/explorer.yaml"), "utf8"),
    );
    payload = (await build({}, { explorer })).payloads.explorer as PeriodData;
  });
  it.each([
    ["starting before the span", "2024-10-31", "2024-11-05"],
    ["ending after the span", "2026-10-25", "2026-11-02"],
    ["entirely after the span", "2026-12-01", "2026-12-05"],
    ["end before start", "2025-06-10", "2025-06-05"],
    ["empty (end equals start)", "2025-06-10", "2025-06-10"],
    ["an empty start", "", "2025-03-05"],
    ["text", "garbage", "zzz"],
    ["February 30", "2025-02-30", "2025-03-05"],
    ["June 31 as the end", "2025-06-01", "2025-06-31"],
    ["month 13", "2025-13-01", "2025-13-05"],
    ["month 00", "2025-00-10", "2025-01-05"],
    ["an unpadded end", "2025-03-01", "2025-4-1"],
    ["a timestamp start", "2025-03-01T00:00:00Z", "2025-03-05"],
  ])("%s: %s to %s", (_, start, end) => {
    expect(() =>
      customRangeDashboard(payload.custom as NonNullable<PeriodData["custom"]>, payload.filter, {
        start,
        end,
      }),
    ).toThrow();
  });
  it("parseDaysKey rejects malformed URL keys", () => {
    for (const key of [
      "2026-02-30..2026-03-01",
      "2026-03-05..2026-03-01",
      "2026-3-1..2026-3-5",
      "last_7_days",
      "2026-03-01..",
      "2026-03-01...2026-03-02",
    ])
      expect(parseDaysKey(key), key).toBeUndefined();
  });
});
