import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type {
  DashboardData,
  DateSpan,
  KpiData,
  LineData,
  TableData,
} from "../../src/compiler/dashboard-data.js";
import { runDashboard } from "../../src/compiler/index.js";
import { customRangeDashboard, type PeriodData } from "../../src/compiler/period-data.js";
import { createDuckDbExecutor } from "../../src/node/index.js";
import { PROJECT_DEFAULTS, type RangeSpec } from "../../src/spec/index.js";
import { buildProject, loadAt, metric, Oracle, removeProjects, writeProject } from "./fixture.js";
import { periodsOf } from "./periods.oracle.js";

vi.setConfig({ testTimeout: 240_000, hookTimeout: 240_000 });

const FULL = process.env.HM_SWEEP === "full";
const PROJECTS = Number(process.env.HM_EMPTY_PROJECTS ?? (FULL ? 24 : 4));
const RANGES = Number(process.env.HM_EMPTY_RANGES ?? (FULL ? 60 : 18));
const SQL_RANGES = Number(process.env.HM_EMPTY_SQL_RANGES ?? (FULL ? 20 : 6));
const SEED = Number(process.env.HM_EMPTY_SEED ?? 7001);

function rng(seed: number): () => number {
  let s = (seed * 2654435761) >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DAY = 86_400_000;
const addDays = (d: string, n: number) =>
  new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const daysBetween = (a: string, b: string) =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY);

type Value = number | null;
type Kind =
  | "sum"
  | "count"
  | "avg"
  | "min"
  | "distinct"
  | "sql_add"
  | "sql_old"
  | "sql_non"
  | "ratio";
type MetricDef = {
  kind: Kind;
  spec: Record<string, unknown>;
  pred?: string;
  rowsPred?: string;
  expr?: string;
  ratio?: [string, string];
};

const PAID = [{ column: "status", op: "eq", value: "paid" }];
const EMAIL_PAID = [...PAID, { column: "channel", op: "eq", value: "Email" }];
const time = { time: "ordered_at", table: "orders" };

const METRICS: Record<string, MetricDef> = {
  rev: {
    kind: "sum",
    spec: { type: "aggregate", aggregate: "sum", column: "amount", filters: PAID, ...time },
    pred: "status = 'paid'",
    expr: "amount",
  },
  n_paid: {
    kind: "count",
    spec: { type: "aggregate", aggregate: "count", filters: PAID, ...time },
    pred: "status = 'paid'",
    expr: "*",
  },
  n_amount: {
    kind: "count",
    spec: { type: "aggregate", aggregate: "count", column: "amount", ...time },
    pred: "TRUE",
    expr: "amount",
  },
  avg_amt: {
    kind: "avg",
    spec: { type: "aggregate", aggregate: "avg", column: "amount", filters: PAID, ...time },
    pred: "status = 'paid'",
    expr: "amount",
  },
  min_amt: {
    kind: "min",
    spec: { type: "aggregate", aggregate: "min", column: "amount", filters: PAID, ...time },
    pred: "status = 'paid'",
    expr: "amount",
  },
  custs: {
    kind: "distinct",
    spec: {
      type: "aggregate",
      aggregate: "count_distinct",
      column: "customer_id",
      filters: PAID,
      ...time,
    },
    pred: "status = 'paid'",
    expr: "customer_id",
  },
  disc_sum: {
    kind: "sum",
    spec: { type: "aggregate", aggregate: "sum", column: "discount", ...time },
    pred: "TRUE",
    expr: "discount",
  },
  email_sum: {
    kind: "sum",
    spec: { type: "aggregate", aggregate: "sum", column: "amount", filters: EMAIL_PAID, ...time },
    pred: "status = 'paid' AND channel = 'Email'",
    expr: "amount",
  },
  big_sum: {
    kind: "sum",
    spec: { type: "aggregate", aggregate: "sum", column: "amount", segments: ["big"], ...time },
    pred: "amount >= 100000",
    expr: "amount",
  },
  net_sql: {
    kind: "sql_add",
    spec: { type: "sql", sql: "sum(amount)", additive: true, filters: PAID, ...time },
    rowsPred: "status = 'paid'",
    expr: "sum(amount) FILTER (WHERE status = 'paid')",
  },
  net_inline_sql: {
    kind: "sql_old",
    spec: {
      type: "sql",
      sql: "sum(amount) FILTER (WHERE status = 'paid')",
      additive: true,
      ...time,
    },
    rowsPred: "TRUE",
    expr: "sum(amount) FILTER (WHERE status = 'paid')",
  },
  scaled_sql: {
    kind: "sql_old",
    spec: { type: "sql", sql: "sum(amount) * 2", additive: true, filters: PAID, ...time },
    rowsPred: "status = 'paid'",
    expr: "sum(amount) FILTER (WHERE status = 'paid') * 2",
  },
  disc_sql: {
    kind: "sql_add",
    spec: { type: "sql", sql: "sum(discount)", additive: true, ...time },
    rowsPred: "TRUE",
    expr: "sum(discount)",
  },
  cnt_sql: {
    kind: "sql_add",
    spec: { type: "sql", sql: "count(*)", additive: true, filters: PAID, ...time },
    rowsPred: "status = 'paid'",
    expr: "count(*) FILTER (WHERE status = 'paid')",
  },
  email_sql: {
    kind: "sql_add",
    spec: { type: "sql", sql: "sum(amount)", additive: true, filters: EMAIL_PAID, ...time },
    rowsPred: "status = 'paid' AND channel = 'Email'",
    expr: "sum(amount) FILTER (WHERE status = 'paid' AND channel = 'Email')",
  },
  big_sql: {
    kind: "sql_add",
    spec: { type: "sql", sql: "sum(amount)", additive: true, segments: ["big"], ...time },
    rowsPred: "amount >= 100000",
    expr: "sum(amount) FILTER (WHERE amount >= 100000)",
  },
  emea_sql: {
    kind: "sql_add",
    spec: { type: "sql", sql: "sum(amount)", additive: true, segments: ["emea"], ...time },
    rowsPred: "region = 'EMEA'",
    expr: "sum(amount) FILTER (WHERE region = 'EMEA')",
  },
  spread_sql: {
    kind: "sql_non",
    spec: {
      type: "sql",
      sql: "max(amount) - min(amount)",
      additive: false,
      filters: PAID,
      ...time,
    },
    rowsPred: "status = 'paid'",
    expr: "max(amount) FILTER (WHERE status = 'paid') - min(amount) FILTER (WHERE status = 'paid')",
  },
  rev_per_order: { kind: "ratio", spec: { type: "ratio" }, ratio: ["rev", "n_paid"] },
  net_per_cnt: { kind: "ratio", spec: { type: "ratio" }, ratio: ["net_sql", "cnt_sql"] },
  disc_per_cnt: { kind: "ratio", spec: { type: "ratio" }, ratio: ["disc_sql", "cnt_sql"] },
  rev_per_cust: { kind: "ratio", spec: { type: "ratio" }, ratio: ["rev", "custs"] },
};
const NAMES = Object.keys(METRICS);
const LEAVES = NAMES.filter((n) => METRICS[n]?.kind !== "ratio");
const PRESET_ONLY_LEAVES = new Set(["custs", "spread_sql"]);
const presetOnly = (name: string): boolean => {
  const m = METRICS[name];
  if (m?.ratio) return m.ratio.some(presetOnly);
  return PRESET_ONLY_LEAVES.has(name);
};
const LINE_METRICS = [
  "net_sql",
  "rev",
  "disc_sql",
  "cnt_sql",
  "email_sql",
  "big_sql",
  "avg_amt",
  "min_amt",
  "net_inline_sql",
  "scaled_sql",
];

type Day = "empty" | "normal" | "netzero" | "nullonly" | "refundonly" | "negonly";
type Project = {
  seed: number;
  root: string;
  tz: string;
  first: string;
  last: string;
  days: Record<string, Day>;
  gap: [string, string];
  payload: PeriodData;
};

let oracle: Oracle;
const projects: Project[] = [];
const tally = { cells: 0, nullVsZero: 0 };

beforeAll(async () => {
  oracle = await Oracle.open();
});
afterAll(async () => {
  console.log(
    `empty-sums: ${tally.cells} cells compared, ${tally.nullVsZero} null-vs-zero mismatches`,
  );
  oracle?.close();
  await removeProjects();
});

async function makeProject(seed: number): Promise<Project> {
  const random = rng(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(random() * xs.length)] as T;
  const tz = pick(["UTC", "America/Los_Angeles", "Pacific/Auckland", "Asia/Calcutta"]);
  const type = pick(["DECIMAL(12,2)", "DOUBLE", "INTEGER"]);
  const first = addDays("2025-01-01", Math.floor(random() * 300));
  const length = 80 + Math.floor(random() * 40);
  const gapStart = addDays(first, 20 + Math.floor(random() * 30));
  const gapEnd = addDays(gapStart, 10 + Math.floor(random() * 12));
  const days: Record<string, Day> = {};
  const rows: string[] = [];
  let id = 0;
  const amount = (v: number | null) =>
    v === null
      ? `CAST(NULL AS ${type})`
      : type === "INTEGER"
        ? String(Math.round(v))
        : v.toFixed(2);
  const row = (
    day: string,
    status: string,
    channel: string,
    region: string | null,
    a: number | null,
  ) => {
    const hh = String(9 + Math.floor(random() * 11)).padStart(2, "0");
    const mm = String(Math.floor(random() * 60)).padStart(2, "0");
    const customer = random() < 0.1 ? "NULL" : `'C${Math.floor(random() * 40)}'`;
    const g = region === null ? "NULL" : `'${region}'`;
    rows.push(
      `(${id++}, timezone('${tz}', TIMESTAMP '${day} ${hh}:${mm}:00'), ${customer}, ${g}, '${channel}', '${status}', ${amount(a)}, CAST(NULL AS ${type}))`,
    );
  };
  const value = () => Math.round((random() * 300 - 60) * 4) / 4;
  const region = (day: string) =>
    pick(
      daysBetween(first, day) < 30
        ? ["Americas", "EMEA", "APAC", null]
        : ["Americas", "EMEA", null],
    );
  for (let i = 0; i < length; i++) {
    const day = addDays(first, i);
    const inGap = day >= gapStart && day < gapEnd;
    const r = random();
    const kind: Day =
      i === 0 || i === length - 1
        ? "normal"
        : inGap || r < 0.3
          ? "empty"
          : r < 0.72
            ? "normal"
            : r < 0.8
              ? "netzero"
              : r < 0.87
                ? "nullonly"
                : r < 0.93
                  ? "refundonly"
                  : "negonly";
    days[day] = kind;
    if (kind === "empty") continue;
    if (kind === "netzero") {
      const x = Math.round(Math.abs(value())) + 2;
      const g = region(day);
      row(day, "paid", "Direct", g, x);
      row(day, "paid", "Social", g, -x);
      if (random() < 0.5) {
        row(day, "paid", "Direct", g, 1);
        row(day, "paid", "Direct", g, -1);
      }
      continue;
    }
    if (kind === "nullonly") {
      const n = 1 + Math.floor(random() * 3);
      for (let k = 0; k < n; k++) row(day, "paid", pick(["Direct", "Social"]), region(day), null);
      continue;
    }
    if (kind === "refundonly") {
      const n = 1 + Math.floor(random() * 3);
      for (let k = 0; k < n; k++) row(day, "refunded", "Email", region(day), value());
      continue;
    }
    if (kind === "negonly") {
      row(day, "paid", "Direct", region(day), -(Math.round(Math.abs(value())) + 1));
      continue;
    }
    const n = 1 + Math.floor(random() * 6);
    for (let k = 0; k < n; k++) {
      const channel = pick(["Direct", "Social", "Email"]);
      const status = channel === "Email" ? "refunded" : random() < 0.85 ? "paid" : "refunded";
      row(day, status, channel, region(day), random() < 0.06 ? null : value());
    }
  }
  const last = addDays(first, length - 1);
  const files: Record<string, unknown> = {
    "hatchmark.yaml": {
      ...PROJECT_DEFAULTS,
      name: `empty-sums-${seed}`,
      timezone: tz,
      sources: { orders: { type: "parquet", path: "data/orders.parquet" } },
    },
    "segments/big.yaml": {
      label: "Big",
      filters: [{ column: "amount", op: "gte", value: 100000 }],
    },
    "segments/emea.yaml": {
      label: "EMEA",
      filters: [{ column: "region", op: "eq", value: "EMEA" }],
    },
    ...Object.fromEntries(
      NAMES.map((n) => {
        const m = METRICS[n] as MetricDef;
        const body = m.ratio
          ? { type: "ratio", numerator: m.ratio[0], denominator: m.ratio[1] }
          : m.spec;
        return [`metrics/${n}.yaml`, metric({ label: n, ...body })];
      }),
    ),
    "dashboards/d.yaml": {
      title: "Empty sums",
      period: { asOf: "latest_data", range: { last: 30, unit: "day" }, compare: "previous_period" },
      filters: [
        {
          type: "period",
          id: "period",
          options: [
            { last: 30, unit: "day" },
            { last: 7, unit: "day" },
            { last_complete: "month" },
            { to_date: "month" },
            { start: gapStart, end: gapEnd },
            { start: addDays(gapStart, 2), end: addDays(gapStart, 3) },
          ],
          default: { last: 30, unit: "day" },
        },
      ],
      blocks: [
        ...NAMES.map((n) => ({ type: "kpi", id: `k_${n}`, metric: n })),
        { type: "table", id: "t_region_a", by: ["region"], metrics: NAMES.slice(0, 11) },
        { type: "table", id: "t_region_b", by: ["region"], metrics: NAMES.slice(11) },
        { type: "line", id: "l_day", metrics: LINE_METRICS.slice(0, 5), grain: "day" },
        { type: "line", id: "l_day2", metrics: LINE_METRICS.slice(5), grain: "day" },
        { type: "line", id: "l_split", metrics: ["net_sql"], split: "region", grain: "day" },
      ],
    },
  };
  const { root } = await writeProject(files);
  await mkdir(path.join(root, "data"), { recursive: true });
  const file = path.join(root, "data", "orders.parquet");
  await oracle.run("DROP TABLE IF EXISTS o");
  await oracle.run(
    `CREATE TABLE o (order_id INTEGER, ordered_at TIMESTAMPTZ, customer_id VARCHAR, region VARCHAR, channel VARCHAR, status VARCHAR, amount ${type}, discount ${type})`,
  );
  for (let i = 0; i < rows.length; i += 200)
    await oracle.run(`INSERT INTO o VALUES ${rows.slice(i, i + 200).join(", ")}`);
  await oracle.run(`COPY o TO '${file}' (FORMAT parquet)`);
  await oracle.run(`DROP TABLE IF EXISTS raw_${seed}`);
  await oracle.run(
    `CREATE TABLE raw_${seed} AS SELECT *, CAST(timezone('${tz}', ordered_at) AS DATE) AS d FROM read_parquet('${file}')`,
  );
  const built = await buildProject(root);
  expect(built.report, JSON.stringify(built.report)).toMatchObject({ ok: true });
  const payload = periodsOf(
    await readFile(path.join(root, "dist/d/index.html"), "utf8"),
  ) as PeriodData;
  return { seed, root, tz, first, last, days, gap: [gapStart, gapEnd], payload };
}

function windowSql(p: Project, span: DateSpan): string {
  const at = (bound: string, op: string) =>
    bound.endsWith("Z")
      ? `ordered_at ${op} TIMESTAMPTZ '${bound}'`
      : `timezone('${p.tz}', ordered_at) ${op} TIMESTAMP '${bound}'`;
  return [
    span.startAt ? at(span.startAt, ">=") : `d >= DATE '${span.start}'`,
    span.endAt ? at(span.endAt, "<") : `d < DATE '${span.end}'`,
  ].join(" AND ");
}

function leafColumns(): string {
  return LEAVES.flatMap((n) => {
    const m = METRICS[n] as MetricDef;
    switch (m.kind) {
      case "sum":
        return [`coalesce(sum(${m.expr}) FILTER (WHERE ${m.pred}), 0) AS "${n}"`];
      case "count":
        return [`count(${m.expr}) FILTER (WHERE ${m.pred}) AS "${n}"`];
      case "avg":
        return [
          `sum(${m.expr}) FILTER (WHERE ${m.pred}) AS "${n}__s"`,
          `count(${m.expr}) FILTER (WHERE ${m.pred}) AS "${n}__n"`,
        ];
      case "min":
        return [`min(${m.expr}) FILTER (WHERE ${m.pred}) AS "${n}"`];
      case "distinct":
        return [`count(DISTINCT ${m.expr}) FILTER (WHERE ${m.pred}) AS "${n}"`];
      default:
        return [`count(*) FILTER (WHERE ${m.rowsPred}) AS "${n}__rows"`, `${m.expr} AS "${n}__v"`];
    }
  }).join(", ");
}

const num = (v: unknown): Value => (v === null || v === undefined ? null : Number(v));
const div = (a: Value, b: Value): Value => (a === null || b === null || b === 0 ? null : a / b);

function valuesOf(r: Record<string, unknown>, grand = true): Record<string, Value> {
  const out: Record<string, Value> = {};
  for (const n of LEAVES) {
    const m = METRICS[n] as MetricDef;
    if (m.kind === "avg") out[n] = div(num(r[`${n}__s`]), num(r[`${n}__n`]));
    else if (m.kind === "sql_add") out[n] = num(r[`${n}__rows`]) === 0 ? 0 : num(r[`${n}__v`]);
    else if (m.kind === "sql_old")
      out[n] = num(r[`${n}__rows`]) === 0 && !grand ? 0 : num(r[`${n}__v`]);
    else if (m.kind === "sql_non") out[n] = num(r[`${n}__rows`]) === 0 ? null : num(r[`${n}__v`]);
    else out[n] = num(r[n]);
  }
  for (const n of NAMES) {
    const m = METRICS[n] as MetricDef;
    if (m.ratio) out[n] = div(out[m.ratio[0]] ?? null, out[m.ratio[1]] ?? null);
  }
  return out;
}

const keyOf = (v: unknown) =>
  v === null || v === undefined ? null : typeof v === "object" ? String(v) : v;

async function truth(
  p: Project,
  where: string,
  groupBy: string[] = [],
): Promise<Map<string, Record<string, Value>>> {
  const keys = groupBy.map((g, i) => `CAST(${g} AS VARCHAR) AS k${i}`);
  const group = groupBy.length ? ` GROUP BY ${groupBy.join(", ")}` : "";
  const rows = await oracle.rows(
    `SELECT ${[...keys, leafColumns()].join(", ")} FROM raw_${p.seed} WHERE ${where}${group}`,
  );
  const out = new Map<string, Record<string, Value>>();
  for (const r of rows)
    out.set(
      JSON.stringify(groupBy.map((_, i) => keyOf(r[`k${i}`]))),
      valuesOf(r, groupBy.length === 0),
    );
  return out;
}

const ZERO_ROWS: Record<string, Value> = valuesOf(
  Object.fromEntries(
    LEAVES.flatMap((n): [string, Value][] => {
      const m = METRICS[n] as MetricDef;
      if (m.kind === "avg")
        return [
          [`${n}__s`, null],
          [`${n}__n`, 0],
        ];
      if (m.kind === "sql_old")
        return [
          [`${n}__rows`, 0],
          [`${n}__v`, 0],
        ];
      if (m.kind === "sql_add" || m.kind === "sql_non")
        return [
          [`${n}__rows`, 0],
          [`${n}__v`, null],
        ];
      return [[n, m.kind === "min" ? null : 0]];
    }),
  ),
);

class Diff {
  problems: string[] = [];
  check(where: string, metricName: string, got: unknown, want: Value, custom: boolean): void {
    tally.cells += 1;
    const expected = custom && presetOnly(metricName) ? null : want;
    const g = got === undefined ? null : got;
    if (expected === null) {
      if (g !== null) this.problems.push(`${where} ${metricName}: got ${String(g)}, want null`);
      return;
    }
    if (typeof g !== "number" || Math.abs(g - expected) > 1e-6 * Math.max(1, Math.abs(expected))) {
      if (g === null && expected === 0) tally.nullVsZero += 1;
      this.problems.push(`${where} ${metricName}: got ${String(g)}, want ${expected}`);
    }
  }
}

async function checkData(
  p: Project,
  data: DashboardData,
  label: string,
  custom: boolean,
  diff: Diff,
): Promise<void> {
  for (const block of data.blocks) {
    if (block.type === "kpi") {
      const k = block as KpiData;
      if (k.empty !== undefined || k.current === undefined) {
        diff.check(`${label} ${k.id} value (empty window)`, k.metric, k.value, null, custom);
        continue;
      }
      const now = (await truth(p, windowSql(p, k.current))).get("[]") ?? ZERO_ROWS;
      diff.check(
        `${label} ${k.id} value ${JSON.stringify(k.current)}`,
        k.metric,
        k.value,
        now[k.metric] ?? null,
        custom,
      );
      if (k.previous !== undefined) {
        const before = (await truth(p, windowSql(p, k.previous))).get("[]") ?? ZERO_ROWS;
        diff.check(
          `${label} ${k.id} previousValue ${JSON.stringify(k.previous)}`,
          k.metric,
          k.previousValue,
          before[k.metric] ?? null,
          custom,
        );
      }
      continue;
    }
    if (block.type === "table") {
      const t = block as TableData;
      if (t.window === undefined) continue;
      const where = windowSql(p, t.window);
      const groups = await truth(p, where, ["region"]);
      const total = (await truth(p, where)).get("[]") ?? ZERO_ROWS;
      for (const row of t.rows) {
        if (row.kind !== undefined) continue;
        const want = groups.get(JSON.stringify(row.keys));
        if (want === undefined) {
          diff.problems.push(
            `${label} ${t.id} row ${JSON.stringify(row.keys)} has no rows in the window`,
          );
          continue;
        }
        for (const n of t.metrics)
          diff.check(
            `${label} ${t.id} ${JSON.stringify(row.keys)}`,
            n,
            row.values[n],
            want[n] ?? null,
            custom,
          );
      }
      if (t.total)
        for (const n of t.metrics)
          diff.check(`${label} ${t.id} total`, n, t.total.values[n], total[n] ?? null, custom);
      continue;
    }
    if (block.type === "line") {
      const l = block as LineData;
      const buckets = l.axis.buckets as string[];
      if (buckets.length === 0) continue;
      const span = { start: buckets[0] as string, end: addDays(buckets.at(-1) as string, 1) };
      const split = l.series.some((s) => s.splitValue !== undefined);
      const byDay = await truth(p, windowSql(p, span), split ? ["d", "region"] : ["d"]);
      for (const s of l.series) {
        s.values.forEach((v, i) => {
          const day = buckets[i] as string;
          if (day >= p.last) return;
          const key = JSON.stringify(split ? [day, s.splitValue ?? null] : [day]);
          diff.check(
            `${label} ${l.id} ${s.key} ${day}`,
            s.metric,
            v,
            (byDay.get(key) ?? ZERO_ROWS)[s.metric] ?? null,
            custom,
          );
        });
      }
    }
  }
}

function ranges(p: Project, n: number, seed: number): [string, string][] {
  const random = rng(seed);
  const span = p.payload.custom?.span as DateSpan;
  const total = daysBetween(span.start, span.end);
  const out: [string, string][] = [
    [p.gap[0], p.gap[1]],
    [addDays(p.gap[0], 1), addDays(p.gap[0], 2)],
    [span.start, addDays(span.start, 1)],
    [span.start, addDays(span.start, 3)],
  ];
  for (const kind of ["netzero", "nullonly", "refundonly", "negonly", "empty"] as const) {
    const day = Object.keys(p.days).find(
      (d) => p.days[d] === kind && d > span.start && d < span.end,
    );
    if (day) out.push([day, addDays(day, 1)]);
  }
  while (out.length < n) {
    const start = addDays(span.start, Math.floor(random() * (total - 1)));
    const len = 1 + Math.floor(random() * (random() < 0.6 ? 6 : 40));
    out.push([start, addDays(start, Math.min(len, daysBetween(start, span.end)))]);
  }
  return out;
}

describe("empty windows, empty segments and empty filter combinations against a DuckDB oracle", () => {
  beforeAll(async () => {
    for (let i = 0; i < PROJECTS; i++) projects.push(await makeProject(SEED + i));
  });

  it("build-time presets match the oracle", async () => {
    const diff = new Diff();
    for (const p of projects)
      for (const [key, data] of Object.entries(p.payload.presets))
        await checkData(p, data, `seed ${p.seed} preset ${key}`, false, diff);
    expect(diff.problems.slice(0, 15)).toEqual([]);
  });

  it("the runtime custom-range engine matches the oracle", async () => {
    const diff = new Diff();
    for (const p of projects) {
      const custom = p.payload.custom;
      expect(custom).toBeDefined();
      if (custom === undefined) continue;
      for (const [start, end] of ranges(p, RANGES, p.seed)) {
        const data = customRangeDashboard(custom, "period", { start, end });
        await checkData(p, data, `seed ${p.seed} custom ${start}..${end}`, true, diff);
      }
    }
    expect(diff.problems.slice(0, 15)).toEqual([]);
  });

  it("build-time SQL for a custom range matches the oracle and the runtime engine", async () => {
    const diff = new Diff();
    for (const p of projects) {
      const custom = p.payload.custom;
      if (custom === undefined) continue;
      const { project } = await loadAt(p.root);
      const config = project.config.spec;
      if (config === undefined) throw new Error("invalid hatchmark.yaml");
      const executor = await createDuckDbExecutor({ root: p.root, config });
      try {
        for (const [start, end] of ranges(p, SQL_RANGES, p.seed + 1)) {
          const binding = { start, end } as unknown as RangeSpec;
          const { data } = await runDashboard(project, "d", executor, undefined, {
            period: binding,
          });
          const label = `seed ${p.seed} sql ${start}..${end}`;
          if (data === undefined) {
            diff.problems.push(`${label}: runDashboard gave no data`);
            continue;
          }
          await checkData(p, data, label, false, diff);
          const browser = customRangeDashboard(custom, "period", { start, end });
          for (const b of browser.blocks) {
            if (b.type !== "kpi" || presetOnly(b.metric)) continue;
            const s = data.blocks.find((x) => x.id === b.id) as KpiData | undefined;
            for (const field of ["value", "previousValue"] as const)
              diff.check(
                `${label} ${b.id} ${field} browser vs sql`,
                b.metric,
                b[field],
                s?.[field] ?? null,
                false,
              );
          }
        }
      } finally {
        await executor.close();
      }
    }
    expect(diff.problems.slice(0, 15)).toEqual([]);
  });

  it("an additive SQL metric is 0 over no rows, null over rows whose SQL is NULL, and 0 over rows that net to 0", () => {
    const problems: string[] = [];
    const cases: [Day, string, Value][] = [
      ["empty", "net_sql", 0],
      ["empty", "disc_sql", 0],
      ["empty", "spread_sql", null],
      ["empty", "min_amt", null],
      ["empty", "avg_amt", null],
      ["empty", "net_per_cnt", null],
      ["empty", "net_inline_sql", null],
      ["empty", "scaled_sql", null],
      ["netzero", "scaled_sql", 0],
      ["netzero", "net_sql", 0],
      ["netzero", "rev", 0],
      ["netzero", "net_per_cnt", 0],
      ["nullonly", "disc_sql", null],
      ["nullonly", "net_sql", null],
      ["nullonly", "rev", 0],
      ["refundonly", "net_sql", 0],
      ["refundonly", "net_inline_sql", null],
      ["refundonly", "email_sql", 0],
      ["normal", "big_sql", 0],
      ["normal", "email_sql", 0],
    ];
    for (const p of projects) {
      const custom = p.payload.custom;
      if (custom === undefined) continue;
      for (const [kind, name, want] of cases) {
        const day = Object.keys(p.days).find(
          (d) => p.days[d] === kind && d > custom.span.start && d < custom.span.end,
        );
        if (day === undefined) continue;
        const data = customRangeDashboard(custom, "period", { start: day, end: addDays(day, 1) });
        const got = (data.blocks.find((b) => b.id === `k_${name}`) as KpiData).value;
        const ok =
          want === null ? got === null : typeof got === "number" && Math.abs(got - want) < 1e-9;
        if (!ok)
          problems.push(
            `seed ${p.seed} ${kind} day ${day} ${name}: got ${String(got)}, want ${String(want)}`,
          );
      }
    }
    expect(problems).toEqual([]);
  });
});
