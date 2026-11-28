import { copyFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type KpiData,
  planDashboard,
  planHash,
  runDashboard,
  runPeriodData,
  type TableData,
} from "../../src/compiler/index.js";
import { createCachedExecutor, createDuckDbExecutor } from "../../src/node/index.js";
import { DEFAULT_ANCHORS, PROJECT_DEFAULTS } from "../../src/spec/index.js";
import { loadAt, metric, Oracle, removeProjects, run, writeProject } from "./fixture.js";

const FULL = process.env.HM_SWEEP === "full";
const CASES = Number(process.env.HM_SEG_CASES ?? (FULL ? 300 : 40));

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

const TYPES = {
  int: "INTEGER",
  bigint: "BIGINT",
  dec: "DECIMAL(12,2)",
  dbl: "DOUBLE",
  str: "VARCHAR",
  date: "DATE",
  flt: "FLOAT",
} as const;
type Kind = keyof typeof TYPES;
const KINDS = Object.keys(TYPES) as Kind[];
const INTEGER = new Set<Kind>(["int", "bigint"]);
const comparable = (a: Kind, b: Kind) => a === b || (INTEGER.has(a) && INTEGER.has(b));

const DOMAIN: Record<Kind, string[]> = {
  int: ["1", "2", "3", "1001"],
  bigint: ["1", "2", "1001", "5000000000", "16777217"],
  dec: ["1.00", "1.50", "2.00", "1001.00"],
  dbl: ["1.0", "1.5", "2.0", "1001.0"],
  str: ["'1'", "'2'", "'1001'", "'1.5'", "'1.0'", "'2026-01-05'", "'a'", "'A'", "''"],
  date: ["DATE '2026-01-05'", "DATE '2026-01-06'", "DATE '2026-02-01'"],
  flt: ["1.0", "1.5", "2.0", "16777216"],
};

const literal = (kind: Kind, v: string | null) =>
  v === null ? `CAST(NULL AS ${TYPES[kind]})` : `CAST(${v} AS ${TYPES[kind]})`;

const REGIONS = ["'emea'", "'amer'", "'apac'", "NULL"];
const TIERS = ["'gold'", "'silver'", "'bronze'", "'free'", "NULL"];

type Op = "in_table" | "not_in_table";
interface TableRef {
  column: Kind;
  op: Op;
  table: "k1" | "k2" | "orders";
  keyKind: Kind;
}

const SQL_METRICS = new Set(["q_sql", "q_seg"]);
const nearFor = (name: string, a: unknown, b: number | null) =>
  SQL_METRICS.has(name) ? near(a ?? 0, b ?? 0) : near(a, b);
const near = (a: unknown, b: number | null) =>
  b === null
    ? a === null || a === undefined
    : typeof a === "number" && Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b));
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

let oracle: Oracle;
beforeAll(async () => {
  oracle = await Oracle.open();
});
afterAll(async () => {
  oracle?.close();
  await removeProjects();
});

function membership(ref: TableRef): string {
  const own = `o.c_${ref.column}`;
  const relation = ref.table === "orders" ? "o" : ref.table;
  const keyColumn = ref.table === "orders" ? `c_${ref.keyKind}` : '"Key"';
  if (!comparable(ref.column, ref.keyKind))
    throw new Error("the oracle never evaluates HM2029 pairs");
  const left = own;
  const right = "kk.k";
  const member = `(${own} IS NOT NULL AND EXISTS (SELECT 1 FROM (SELECT DISTINCT ${keyColumn} AS k FROM ${relation} WHERE ${keyColumn} IS NOT NULL) kk WHERE ${left} = ${right}))`;
  return ref.op === "in_table" ? `coalesce(${member}, false)` : `NOT coalesce(${member}, false)`;
}

function tableFilter(ref: TableRef) {
  return {
    column: `c_${ref.column}`,
    op: ref.op,
    table: ref.table,
    key: ref.table === "orders" ? `C_${ref.keyKind.toUpperCase()}` : "key",
  };
}

interface Options {
  periodFilter?: boolean;
  sqlSegments?: boolean;
  noSql?: boolean;
  comparable?: boolean;
}

interface Built {
  root: string;
  files: Record<string, unknown>;
  preds: Record<string, string>;
  window: string;
  label: string;
  keyKinds: Record<"k1" | "k2", Kind>;
  incomparable: boolean;
}

async function writeKeys(root: string, name: string, kind: Kind, values: (string | null)[]) {
  await oracle.run(`DROP TABLE IF EXISTS ${name}`);
  await oracle.run(`CREATE TABLE ${name} ("Key" ${TYPES[kind]}, note VARCHAR)`);
  for (const v of values) await oracle.run(`INSERT INTO ${name} VALUES (${literal(kind, v)}, 'x')`);
  await oracle.run(
    `COPY ${name} TO '${path.join(root, "data", `${name}.parquet`)}' (FORMAT parquet)`,
  );
}

async function buildCase(seed: number, opts: Options = {}): Promise<Built> {
  const random = rng(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(random() * xs.length)] as T;
  const maybe = (p: number) => random() < p;
  const keyKinds = { k1: pick(KINDS), k2: pick(KINDS) };
  const fit = (key: Kind): Kind =>
    !opts.comparable && maybe(0.15)
      ? pick(KINDS)
      : INTEGER.has(key)
        ? pick(["int", "bigint"] as const)
        : key;
  const ref = (table: "k1" | "k2"): TableRef => {
    const self = maybe(0.12);
    const keyKind = self ? pick(KINDS) : keyKinds[table];
    return {
      column: fit(keyKind),
      op: pick(["in_table", "not_in_table"] as const),
      table: self ? "orders" : table,
      keyKind,
    };
  };
  const refA = ref("k1");
  const refB = ref("k2");
  const refDirect = ref(pick(["k1", "k2"] as const));
  const segAExtra = maybe(0.4) ? [{ column: "amount", op: "gte", value: 200 }] : [];
  const segBExtra = maybe(0.4) ? [{ column: "region", op: "in", values: ["emea", "apac"] }] : [];
  const f1 = [
    ...(maybe(0.4) ? [{ column: "status", op: "eq", value: "paid" }] : []),
    ...(maybe(0.3) ? [tableFilter(refDirect)] : []),
    ...(maybe(0.3) ? [{ column: "tier", op: "in", values: ["gold", "silver"] }] : []),
  ];
  const f2 = maybe(0.5) ? [{ column: "status", op: "neq", value: "refunded" }] : [];
  const s1 = maybe(0.5) ? ["a", "b"] : maybe(0.6) ? ["a"] : ["b"];
  const s2 = maybe(0.5) ? ["b"] : [];
  const regionFilter = maybe(0.4) ? ["emea", "amer"].filter(() => maybe(0.7)) : [];
  const strFilter = maybe(0.25) ? ["1", "a", "2026-01-05"].filter(() => maybe(0.7)) : [];

  const cmp = (f: Record<string, unknown>): string => {
    const col = `o.${String(f.column)}`;
    switch (f.op) {
      case "eq":
        return `coalesce(${col} = '${String(f.value)}', false)`;
      case "neq":
        return `(${col} IS DISTINCT FROM '${String(f.value)}')`;
      case "gte":
        return `coalesce(${col} >= ${Number(f.value)}, false)`;
      case "in":
        return `coalesce(${col} IN (${(f.values as string[]).map((v) => `'${v}'`).join(", ")}), false)`;
      default: {
        const r = [refA, refB, refDirect].find(
          (x) =>
            tableFilter(x).column === f.column &&
            tableFilter(x).table === f.table &&
            tableFilter(x).op === f.op,
        );
        if (r === undefined) throw new Error("unknown filter");
        return membership(r);
      }
    }
  };
  const segFilters: Record<"a" | "b", Record<string, unknown>[]> = {
    a: [tableFilter(refA), ...segAExtra],
    b: [tableFilter(refB), ...segBExtra],
  };
  const pred = (filters: Record<string, unknown>[], segs: string[]) => {
    const all = [...filters, ...segs.flatMap((s) => segFilters[s as "a" | "b"])];
    return all.length === 0 ? "TRUE" : all.map(cmp).join(" AND ");
  };
  const used = [
    ...(s1.includes("a") ? [refA] : []),
    ...(s1.includes("b") || s2.includes("b") ? [refB] : []),
    ...(f1.some((f) => "table" in f) || !opts.noSql ? [refDirect] : []),
  ];
  const incomparable = used.some((r) => !comparable(r.column, r.keyKind));
  const safe = (build: () => string) => (incomparable ? "FALSE" : build());
  const p1 = safe(() => pred(f1, s1));
  const p2 = safe(() => pred(f2, s2));
  const p3 = safe(() => pred([tableFilter(refDirect)], []));
  const base = { type: "aggregate", table: "orders", time: "d" };
  const withF = (f: unknown[], s: string[]) => ({
    ...(f.length > 0 ? { filters: f } : {}),
    ...(s.length > 0 ? { segments: s } : {}),
  });
  const metrics: Record<string, Record<string, unknown>> = {
    m_sum: { ...base, aggregate: "sum", column: "amount", ...withF(f1, s1) },
    m_cnt: { ...base, aggregate: "count", ...withF(f1, s1) },
    m_cd: { ...base, aggregate: "count_distinct", column: "c_str", ...withF(f1, s1) },
    m_avg: { ...base, aggregate: "avg", column: "amount", ...withF(f1, s1) },
    m_max: { ...base, aggregate: "max", column: "amount", ...withF(f1, s1) },
    n_sum: { ...base, aggregate: "sum", column: "amount", ...withF(f2, s2) },
    all_sum: { ...base, aggregate: "sum", column: "amount" },
    share: { type: "ratio", numerator: "m_sum", denominator: "all_sum" },
    cross: { type: "ratio", numerator: "m_sum", denominator: "n_sum" },
    ...(opts.noSql
      ? {}
      : {
          q_sql: {
            type: "sql",
            table: "orders",
            sql: "sum(amount) - count(*)",
            additive: false,
            time: "d",
            filters: [tableFilter(refDirect)],
          },
        }),
    ...(opts.sqlSegments
      ? {
          q_seg: {
            type: "sql",
            table: "orders",
            sql: "sum(amount)",
            additive: true,
            time: "d",
            ...withF(f1, s1),
          },
        }
      : {}),
  };
  const preds: Record<string, string> = { m: p1, n: p2, q: p3 };
  const names = Object.keys(metrics);
  const window: string[] = [];
  if (regionFilter.length > 0)
    window.push(`o.region IN (${regionFilter.map((r) => `'${r}'`).join(", ")})`);
  if (strFilter.length > 0)
    window.push(`o.c_str IN (${strFilter.map((r) => `'${r}'`).join(", ")})`);
  const filters = [
    ...(regionFilter.length > 0
      ? [{ type: "select", id: "region", column: "region", multiple: true, default: regionFilter }]
      : []),
    ...(strFilter.length > 0
      ? [{ type: "select", id: "code", column: "c_str", multiple: true, default: strFilter }]
      : []),
    ...(opts.periodFilter
      ? [
          {
            type: "period",
            id: "period",
            options: [
              { last: 12, unit: "month" },
              { last: 30, unit: "day" },
            ],
            default: { last: 12, unit: "month" },
          },
        ]
      : []),
  ];
  const files: Record<string, unknown> = {
    "hatchmark.yaml": {
      ...PROJECT_DEFAULTS,
      name: "seg-oracle",
      sources: {
        orders: { type: "parquet", path: "data/orders.parquet" },
        k1: { type: "parquet", path: "data/k1.parquet" },
        k2: { type: "parquet", path: "data/k2.parquet" },
      },
    },
    "segments/a.yaml": { label: "A", filters: segFilters.a },
    "segments/b.yaml": { label: "B", filters: segFilters.b },
    ...Object.fromEntries(
      Object.entries(metrics).map(([n, m]) => [`metrics/${n}.yaml`, metric(m)]),
    ),
    "dashboards/d.yaml": {
      title: "D",
      period: { asOf: "2026-03-31", range: "all_time", compare: "none" },
      ...(filters.length > 0 ? { filters } : {}),
      blocks: [
        ...names.map((n) => ({ type: "kpi", id: n, metric: n })),
        { type: "table", id: "by_region", by: ["region"], metrics: names },
        {
          type: "table",
          id: "by_tier",
          by: ["tier"],
          metrics: ["all_sum", "m_sum", "m_cd", "m_avg", "m_cnt"],
          sort: { by: "all_sum", order: "desc" },
          limit: 2,
          other: true,
        },
      ],
    },
  };
  const { root } = await writeProject(files);
  await mkdir(path.join(root, "data"), { recursive: true });
  await oracle.run("DROP TABLE IF EXISTS o");
  await oracle.run(
    `CREATE TABLE o (d DATE, region VARCHAR, tier VARCHAR, status VARCHAR, amount DOUBLE, ${KINDS.map((k) => `c_${k} ${TYPES[k]}`).join(", ")})`,
  );
  const n = 15 + Math.floor(random() * 40);
  for (let i = 0; i < n; i++) {
    const day = String(1 + Math.floor(random() * 28)).padStart(2, "0");
    const cols = KINDS.map((k) => literal(k, maybe(0.15) ? null : pick(DOMAIN[k])));
    await oracle.run(
      `INSERT INTO o VALUES (DATE '2026-0${1 + Math.floor(random() * 3)}-${day}', ${pick(REGIONS)}, ${pick(TIERS)}, '${pick(["paid", "refunded"])}', ${(Math.floor(random() * 50000) + i / 1000).toFixed(3)}, ${cols.join(", ")})`,
    );
  }
  await oracle.run(`COPY o TO '${path.join(root, "data", "orders.parquet")}' (FORMAT parquet)`);
  for (const k of ["k1", "k2"] as const) {
    const count = maybe(0.15) ? 0 : 1 + Math.floor(random() * 6);
    const values = Array.from({ length: count }, () =>
      maybe(0.2) ? null : pick(DOMAIN[keyKinds[k]]),
    );
    if (count > 0 && maybe(0.4)) values.push(values[0] ?? null);
    await writeKeys(root, k, keyKinds[k], values);
  }
  return {
    root,
    files,
    preds,
    window: window.length > 0 ? window.join(" AND ") : "TRUE",
    label: JSON.stringify({
      seed,
      refA,
      refB,
      refDirect,
      s1,
      s2,
      f1: f1.length,
      f2: f2.length,
      regionFilter,
      strFilter,
      keyKinds,
    }),
    keyKinds,
    incomparable,
  };
}

function oracleSql(b: Built, groupBy: string, extra = "TRUE"): string {
  const { m, n, q } = b.preds;
  return `SELECT ${groupBy === "" ? "" : `${groupBy} AS g, `}
    coalesce(sum(amount) FILTER (WHERE ${m}), 0) AS m_sum,
    count(*) FILTER (WHERE ${m}) AS m_cnt,
    count(DISTINCT c_str) FILTER (WHERE ${m}) AS m_cd,
    avg(amount) FILTER (WHERE ${m}) AS m_avg,
    max(amount) FILTER (WHERE ${m}) AS m_max,
    coalesce(sum(amount) FILTER (WHERE ${n}), 0) AS n_sum,
    coalesce(sum(amount), 0) AS all_sum,
    sum(amount) FILTER (WHERE ${q}) - count(*) FILTER (WHERE ${q}) AS q_sql,
    sum(amount) FILTER (WHERE ${m}) AS q_seg
  FROM o WHERE ${b.window} AND ${extra} ${groupBy === "" ? "" : `GROUP BY ${groupBy}`}`;
}

function expected(r: Record<string, unknown> | undefined): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const k of [
    "m_sum",
    "m_cnt",
    "m_cd",
    "m_avg",
    "m_max",
    "n_sum",
    "all_sum",
    "q_sql",
    "q_seg",
  ])
    out[k] = num(r?.[k]);
  for (const k of ["m_sum", "m_cnt", "m_cd", "n_sum", "all_sum"]) out[k] = out[k] ?? 0;
  out.share = out.all_sum === 0 ? null : (out.m_sum ?? 0) / (out.all_sum ?? 1);
  out.cross = out.n_sum === 0 ? null : (out.m_sum ?? 0) / (out.n_sum ?? 1);
  return out;
}

async function compare(b: Built, blocks: unknown[], metricNames: string[]): Promise<string[]> {
  const problems: string[] = [];
  const find = <T>(id: string) =>
    blocks.find((x) => (x as { id: string }).id === id) as T | undefined;
  const [grandRow] = await oracle.rows(oracleSql(b, ""));
  const grand = expected(grandRow);
  for (const name of metricNames) {
    const kpi = find<KpiData>(name);
    if (!nearFor(name, kpi?.value, grand[name] ?? null))
      problems.push(`kpi ${name}: ${kpi?.value} != ${grand[name]}`);
  }
  const region = find<TableData>("by_region");
  const groups = await oracle.rows(oracleSql(b, "region"));
  if (region?.rows.length !== groups.length)
    problems.push(`by_region rows ${region?.rows.length} != ${groups.length}`);
  for (const row of region?.rows ?? []) {
    const want = expected(groups.find((g) => (g.g ?? null) === row.keys[0]));
    for (const name of metricNames) {
      if (!nearFor(name, row.values[name], want[name] ?? null))
        problems.push(
          `by_region ${String(row.keys[0])} ${name}: ${row.values[name]} != ${want[name]}`,
        );
    }
  }
  for (const name of metricNames) {
    if (!nearFor(name, region?.total?.values[name], grand[name] ?? null))
      problems.push(`by_region total ${name}: ${region?.total?.values[name]} != ${grand[name]}`);
  }
  const tier = find<TableData>("by_tier");
  const tiers = (await oracle.rows(oracleSql(b, "tier"))).sort(
    (x, y) => Number(y.all_sum) - Number(x.all_sum),
  );
  const shown = tiers.slice(0, 2);
  const rest = tiers.slice(2);
  const tierMetrics = ["all_sum", "m_sum", "m_cd", "m_avg", "m_cnt"];
  for (const [i, want] of shown.entries()) {
    const row = tier?.rows[i];
    if (row === undefined || row.kind !== undefined || row.keys[0] !== (want.g ?? null)) {
      problems.push(`by_tier row ${i}: ${JSON.stringify(row?.keys)} != ${String(want.g)}`);
      continue;
    }
    const e = expected(want);
    for (const name of tierMetrics)
      if (!near(row.values[name], e[name] ?? null))
        problems.push(`by_tier ${String(want.g)} ${name}: ${row.values[name]} != ${e[name]}`);
  }
  const other = tier?.rows.find((r) => r.kind === "other");
  if (rest.length === 0) {
    if (other !== undefined) problems.push("by_tier has an Other row with nothing folded");
  } else {
    const inList = rest
      .map((r) => (r.g === null ? "tier IS NULL" : `tier = '${String(r.g)}'`))
      .join(" OR ");
    const [otherRow] = await oracle.rows(oracleSql(b, "", `(${inList})`));
    const e: Record<string, number | null> = { ...expected(otherRow), m_cd: null };
    if (other === undefined) problems.push("by_tier Other row missing");
    else
      for (const name of tierMetrics)
        if (!near(other.values[name], e[name] ?? null))
          problems.push(`by_tier Other ${name}: ${other.values[name]} != ${e[name]}`);
  }
  for (const name of tierMetrics) {
    if (!near(tier?.total?.values[name], grand[name] ?? null))
      problems.push(`by_tier total ${name}: ${tier?.total?.values[name]} != ${grand[name]}`);
  }
  return problems;
}

const BASE_METRICS = [
  "m_sum",
  "m_cnt",
  "m_cd",
  "m_avg",
  "m_max",
  "n_sum",
  "all_sum",
  "share",
  "cross",
  "q_sql",
];

async function sweepCase(seed: number, opts: Options = {}): Promise<string[]> {
  const b = await buildCase(seed, opts);
  const { project, diagnostics: loadDiagnostics } = await loadAt(b.root);
  let result: Awaited<ReturnType<typeof run>>;
  try {
    result = await run(b.root, project, "d");
  } catch (error) {
    return [`${b.label}: threw ${String(error)}`];
  }
  const diagnostics = [...loadDiagnostics, ...result.diagnostics].filter(
    (d) => d.code !== "HM4010" && d.code !== "HM4013",
  );
  if (b.incomparable) {
    const codes = [...new Set(diagnostics.map((d) => d.code))];
    const ok = codes.length === 1 && codes[0] === "HM2029" && result.data === undefined;
    return ok
      ? []
      : [
          `${b.label}: expected only HM2029 and no data, got ${codes.join(", ") || "no diagnostic"}${result.data ? " with data" : ""}`,
        ];
  }
  if (diagnostics.length > 0)
    return [
      `${b.label}: diagnostics ${diagnostics.map((d) => `${d.code} ${d.message}`).join("; ")}`,
    ];
  const names = opts.sqlSegments ? [...BASE_METRICS, "q_seg"] : BASE_METRICS;
  return (await compare(b, result.data?.blocks ?? [], names)).map((p) => `${b.label}: ${p}`);
}

describe("segments and in_table filters against a plain-SQL oracle", {
  timeout: FULL ? 3_600_000 : 600_000,
}, () => {
  it(`agrees over ${CASES} random projects: six column types, nulls, duplicates, empty and self key tables, overlapping filters, totals and Other`, async () => {
    const problems: string[] = [];
    let rejected = 0;
    for (let seed = 1; seed <= CASES; seed++) {
      problems.push(...(await sweepCase(seed)));
      if ((await buildCase(seed)).incomparable) rejected++;
    }
    expect(problems.slice(0, 15)).toEqual([]);
    expect(rejected, "some cases compare incomparable types").toBeGreaterThan(0);
    expect(rejected, "most cases reach the numbers").toBeLessThan(CASES / 2);
  });

  it("applies a sql metric's segments to its source rows", async () => {
    const problems: string[] = [];
    for (let seed = 1001; seed <= 1012; seed++)
      problems.push(...(await sweepCase(seed, { sqlSegments: true, comparable: true })));
    expect(problems.slice(0, 10)).toEqual([]);
  });

  it("builds a dashboard with a period filter and still agrees", async () => {
    const problems: string[] = [];
    for (let seed = 2001; seed <= 2008; seed++)
      problems.push(...(await sweepCase(seed, { periodFilter: true, comparable: true })));
    expect(problems.slice(0, 10)).toEqual([]);
  });

  it("fills the custom-range day cubes of a period filter with the segmented rows", async () => {
    let checked = 0;
    for (let seed = 3001; seed <= 3006; seed++) {
      const b = await buildCase(seed, { periodFilter: true, comparable: true, noSql: true });
      const { project } = await loadAt(b.root);
      const config = project.config.spec;
      if (config === undefined) throw new Error("invalid hatchmark.yaml");
      const executor = await createDuckDbExecutor({ root: b.root, config });
      try {
        const base = await runDashboard(project, "d", executor);
        if (base.data === undefined) throw new Error(b.label);
        const periods = await runPeriodData(project, "d", executor, base.data);
        expect(
          periods.diagnostics.map((d) => d.message),
          b.label,
        ).toEqual([]);
        const custom = periods.data?.custom;
        const [rows] = await oracle.rows(`SELECT count(*) AS n FROM o WHERE ${b.window}`);
        expect(custom !== undefined, b.label).toBe(Number(rows?.n) > 0);
        if (custom === undefined) continue;
        checked++;
        const [want] = await oracle.rows(oracleSql(b, ""));
        for (const name of ["m_sum", "m_cnt", "n_sum"] as const) {
          const block = custom.plan.blocks.find((x) => x.blockId === name);
          const expression = block?.measures[name];
          if (expression?.op !== "ref") throw new Error(`${b.label}: ${name} is not one query`);
          const query = custom.plan.queries.find((q) => q.id === expression.queryId);
          const component = query?.measures.find((m) => m.metric === name)?.components[0]?.id ?? "";
          const entry = custom.queries[expression.queryId];
          const cube = entry && "cube" in entry ? custom.cubes[entry.cube] : undefined;
          const total = (cube?.values[component] ?? []).reduce<number>(
            (a, v) => a + (typeof v === "number" ? v : 0),
            0,
          );
          expect(
            near(total, num(want?.[name]) ?? 0),
            `${b.label}: cube ${name} ${total} != ${String(want?.[name])}`,
          ).toBe(true);
        }
      } finally {
        await executor.close();
      }
    }
    expect(checked).toBeGreaterThan(2);
  });

  it("recomputes from the cache when a key table read only through a segment changes, and when the change is undone", async () => {
    const b = await buildCase(77, { noSql: true, comparable: true });
    const config = (await loadAt(b.root)).project.config.spec;
    if (config === undefined) throw new Error("invalid hatchmark.yaml");
    const once = async () => {
      const executor = await createCachedExecutor({
        root: b.root,
        config,
        createInner: (at) => createDuckDbExecutor({ root: at, config }),
      });
      try {
        const { project } = await loadAt(b.root);
        const { data } = await runDashboard(project, "d", executor);
        return { blocks: data?.blocks ?? [], stats: executor.stats() };
      } finally {
        await executor.close();
      }
    };
    const names = BASE_METRICS.filter((n) => n !== "q_sql");
    const versions: (string | null)[][] = [
      [],
      DOMAIN[b.keyKinds.k2].slice(0, 2),
      [null, ...DOMAIN[b.keyKinds.k2]],
      [],
    ];
    for (const values of versions) {
      await writeKeys(b.root, "k2", b.keyKinds.k2, values);
      await writeKeys(b.root, "k1", b.keyKinds.k1, DOMAIN[b.keyKinds.k1].slice(1));
      const cold = await once();
      const warm = await once();
      expect(warm.stats.hits).toBeGreaterThan(0);
      expect(await compare(b, cold.blocks, names)).toEqual([]);
      expect(await compare(b, warm.blocks, names)).toEqual([]);
    }
  });
  it("rejects a plan whose key table changed in hatchmark.yaml, and gives the new plan other ids", async () => {
    const b = await buildCase(91, { noSql: true, comparable: true });
    const before = await loadAt(b.root);
    const planBefore = planDashboard(before.project, "d").plan;
    await copyFile(
      path.join(b.root, "data", "k2.parquet"),
      path.join(b.root, "data", "k2b.parquet"),
    );
    const config = b.files["hatchmark.yaml"] as { sources: Record<string, unknown> };
    await writeFile(
      path.join(b.root, "hatchmark.yaml"),
      JSON.stringify({
        ...config,
        sources: { ...config.sources, k2: { type: "parquet", path: "data/k2b.parquet" } },
      }),
    );
    const after = await loadAt(b.root);
    const planAfter = planDashboard(after.project, "d").plan;
    if (planBefore === undefined || planAfter === undefined) throw new Error("no plan");
    const reads = (q: { tables?: Record<string, unknown> }) =>
      Object.keys(q.tables ?? {}).includes("k2");
    const stale = planBefore.queries.find(reads);
    expect(stale, "a query reads k2").toBeDefined();
    expect(planHash(planBefore)).not.toBe(planHash(planAfter));
    expect(planAfter.queries.find(reads)?.id).not.toBe(stale?.id);
    const spec = after.project.config.spec;
    if (spec === undefined || stale === undefined) throw new Error("no config");
    const executor = await createDuckDbExecutor({ root: b.root, config: spec });
    try {
      const context = {
        asOf: "2026-03-31",
        timezone: "UTC",
        anchors: { ...DEFAULT_ANCHORS, week: "monday" } as const,
        bindings: {},
      };
      await expect(executor.execute(stale, context)).rejects.toThrow("differs from hatchmark.yaml");
    } finally {
      await executor.close();
    }
  });
});
