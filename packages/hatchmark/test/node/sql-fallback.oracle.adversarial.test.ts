import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  customRangeDashboard,
  type DashboardData,
  type KpiData,
  type LineData,
  runDashboard,
  runPeriodData,
  type TableData,
} from "../../src/compiler/index.js";
import { createDuckDbExecutor } from "../../src/node/index.js";
import { PROJECT_DEFAULTS } from "../../src/spec/index.js";
import { metric, Oracle, removeProjects, writeProject } from "./fixture.js";

const FULL = process.env.HM_SWEEP === "full";
const CASES = Number(process.env.HM_FALLBACK_CASES ?? (FULL ? 400 : 40));
const FIRST = Number(process.env.HM_FALLBACK_SEED ?? 7001);

function rng(seed: number): () => number {
  let s = (seed * 2654435761) >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 2 ** 32;
  };
}
const pick = <T>(rand: () => number, items: readonly T[]): T =>
  items[Math.floor(rand() * items.length)] as T;
const DAY = 86_400_000;
const addDays = (d: string, n: number) =>
  new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const lit = (s: string) => `'${s.replaceAll("'", "''")}'`;

interface MetricCase {
  sql: string;
  additive: boolean;
  plain: boolean;
}

function templates(rand: () => number): MetricCase[] {
  const k = () => pick(rand, [0, 0, 7, -3, 99, 1]);
  const all: (() => MetricCase)[] = [
    () => ({ sql: "coalesce(sum(amount), 0)", additive: true, plain: false }),
    () => ({ sql: `coalesce(sum(amount), ${k()})`, additive: true, plain: false }),
    () => ({ sql: "sum(amount)", additive: true, plain: true }),
    () => ({ sql: "count(*)", additive: true, plain: true }),
    () => ({
      sql: "coalesce(sum(amount) FILTER (WHERE status = 'paid'), 0)",
      additive: true,
      plain: false,
    }),
    () => ({
      sql: `CASE WHEN count(*) = 0 THEN ${k()} ELSE coalesce(sum(amount), 0) END`,
      additive: true,
      plain: false,
    }),
    () => ({ sql: `coalesce(avg(amount), ${k()})`, additive: false, plain: false }),
    () => ({ sql: "sum(amount) * 2", additive: true, plain: false }),
    () => ({
      sql: `coalesce(count(amount), 0) + coalesce(sum(amount), ${pick(rand, [0, 0, 5])})`,
      additive: true,
      plain: false,
    }),
  ];
  const chosen = all.filter(() => rand() < 0.55);
  return (chosen.length > 0 ? chosen : [pick(rand, all)]).map((f) => f());
}

interface Case {
  seed: number;
  csv: string;
  keys: string;
  metrics: Record<string, MetricCase>;
  presets: { start: string; end: string }[];
  seg: string[];
  region: string[];
  ranges: { start: string; end: string }[];
}

const SPAN_START = "2026-09-01";
const AS_OF = "2026-10-31";
const LAST = "2026-10-30";

function generate(seed: number): Case {
  const rand = rng(seed);
  const lines = ["day,customer,region,status,amount"];
  const days: string[] = [];
  for (let d = 0; d < 60; d++) {
    const day = addDays(SPAN_START, d);
    if (rand() < 0.45) continue;
    days.push(day);
    const n = 1 + Math.floor(rand() * 3);
    for (let i = 0; i < n; i++) {
      const amount = rand() < 0.2 ? "" : String(Math.floor(rand() * 45) - 5);
      lines.push(
        [
          day,
          pick(rand, ["a", "b", "c", "d", ""]),
          pick(rand, ["east", "west", "north", ""]),
          pick(rand, ["paid", "paid", "void"]),
          amount,
        ].join(","),
      );
    }
  }
  lines.push(`${LAST},z,south,void,`);
  const keys = ["customer", ...["a", "b", "c", "d"].filter(() => rand() < 0.5)].join("\n");
  const metrics = Object.fromEntries(templates(rand).map((m, i) => [`m${i}`, m]));
  const range = () => {
    const start = addDays(SPAN_START, Math.floor(rand() * 58));
    const end = addDays(start, 1 + Math.floor(rand() * 20));
    return { start, end: end > AS_OF ? AS_OF : end };
  };
  const quiet = Array.from({ length: 60 }, (_, d) => addDays(SPAN_START, d)).find(
    (d) => !days.includes(d) && d >= (days[0] ?? SPAN_START),
  );
  const presets = [range(), range()];
  if (quiet !== undefined && rand() < 0.5) presets[1] = { start: quiet, end: addDays(quiet, 1) };
  if (presets[1]?.start === presets[0]?.start && presets[1]?.end === presets[0]?.end) presets.pop();
  const ranges = [
    range(),
    ...(quiet === undefined ? [] : [{ start: quiet, end: addDays(quiet, 1) }]),
  ];
  return {
    seed,
    csv: lines.join("\n"),
    keys,
    metrics,
    presets,
    seg: ["inside", "outside", "east"].filter(() => rand() < 0.35),
    region: ["east", "west", "north"].filter(() => rand() < 0.3),
    ranges,
  };
}

const SEGMENT_SQL: Record<string, string> = {
  inside: "EXISTS (SELECT 1 FROM fo_keys k WHERE k.customer = r.customer)",
  outside: "NOT EXISTS (SELECT 1 FROM fo_keys k WHERE k.customer = r.customer)",
  east: "region IS NOT DISTINCT FROM 'east'",
};

function project(c: Case) {
  const names = Object.keys(c.metrics);
  return {
    "hatchmark.yaml": {
      ...PROJECT_DEFAULTS,
      name: "fallback sweep",
      sources: {
        r: { type: "csv", path: "data/r.csv" },
        keys: { type: "csv", path: "data/keys.csv" },
      },
    },
    "data/r.csv": c.csv,
    "data/keys.csv": c.keys,
    "segments/inside.yaml": {
      label: "Inside",
      filters: [{ column: "customer", op: "in_table", table: "keys", key: "customer" }],
    },
    "segments/outside.yaml": {
      label: "Outside",
      filters: [{ column: "customer", op: "not_in_table", table: "keys", key: "customer" }],
    },
    "segments/east.yaml": {
      label: "East",
      filters: [{ column: "region", op: "eq", value: "east" }],
    },
    ...Object.fromEntries(
      Object.entries(c.metrics).map(([name, m]) => [
        `metrics/${name}.yaml`,
        metric({ type: "sql", table: "r", time: "day", sql: m.sql, additive: m.additive }),
      ]),
    ),
    "dashboards/d.yaml": {
      title: "Fallbacks",
      period: { asOf: AS_OF, range: c.presets[0], compare: "none" },
      filters: [
        { type: "period", id: "p", options: c.presets, default: c.presets[0] },
        { type: "segment", id: "seg", segments: ["inside", "outside", "east"] },
        { type: "select", id: "region", column: "region", multiple: true },
      ],
      blocks: [
        ...names.flatMap((m) => [
          { type: "kpi", id: `k_${m}`, metric: m },
          { type: "line", id: `l_${m}`, metrics: [m], grain: "day" },
        ]),
        { type: "table", id: "t", by: ["region"], metrics: names },
      ],
    },
  };
}

let oracle: Oracle;
beforeAll(async () => {
  oracle = await Oracle.open();
});
afterAll(async () => {
  oracle.close();
  await removeProjects();
});

const near = (a: unknown, b: number | null) =>
  b === null
    ? a === null || a === undefined
    : typeof a === "number" && Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b));

function rowFilter(c: Case, range: { start: string; end: string }): string {
  return [
    `day >= DATE ${lit(range.start)}`,
    `day < DATE ${lit(range.end)}`,
    ...c.seg.map((s) => SEGMENT_SQL[s] as string),
    ...(c.region.length > 0 ? [`region IN (${c.region.map(lit).join(", ")})`] : []),
  ].join(" AND ");
}

async function evaluate(
  m: MetricCase,
  where: string,
  by?: string,
): Promise<Map<string, { n: number; v: number | null }>> {
  const rows = await oracle.rows(
    `SELECT ${by === undefined ? "NULL" : `CAST(${by} AS VARCHAR)`} AS g, count(*) AS n, (${m.sql}) AS v FROM fo_rows r WHERE ${where}${by === undefined ? "" : ` GROUP BY ${by}`}`,
  );
  return new Map(
    rows.map((r) => [
      String(r.g),
      { n: Number(r.n), v: r.v === null || r.v === undefined ? null : Number(r.v) },
    ]),
  );
}

async function overNoRows(m: MetricCase): Promise<number | null> {
  const [row] = await oracle.rows(`SELECT (${m.sql}) AS v FROM fo_rows WHERE FALSE`);
  return row?.v === null || row?.v === undefined ? null : Number(row.v);
}

const total = (m: MetricCase, x: { n: number; v: number | null } | undefined) =>
  x === undefined ? null : m.plain && x.n === 0 ? 0 : x.v;

async function bucket(m: MetricCase, x: { n: number; v: number | null } | undefined) {
  if (x !== undefined && x.n > 0) return x.v;
  return m.additive ? ((await overNoRows(m)) ?? 0) : null;
}

async function check(
  c: Case,
  data: DashboardData | undefined,
  range: { start: string; end: string },
  where: string,
  presetOnly: ReadonlySet<string> = new Set(),
): Promise<string[]> {
  const out: string[] = [];
  if (data === undefined) return [`${where}: no data`];
  const filter = rowFilter(c, range);
  const regions = new Map<string, number | null>();
  for (const [name, m] of Object.entries(c.metrics)) {
    const k = data.blocks.find((b) => b.id === `k_${name}`) as KpiData | undefined;
    if (presetOnly.has(name)) {
      if (k?.presetOnly !== true) out.push(`${where} k_${name}: not marked preset-only`);
      continue;
    }
    const want = total(m, (await evaluate(m, filter)).get("null"));
    if (!near(k?.value, want))
      out.push(`${where} k_${name} ${m.sql}: got ${k?.value}, oracle ${want}`);
    const line = data.blocks.find((b) => b.id === `l_${name}`) as LineData | undefined;
    if (line?.axis.kind !== "time") {
      out.push(`${where} l_${name}: no time axis`);
      continue;
    }
    const byDay = await evaluate(m, filter, "day");
    for (const [j, day] of line.axis.buckets.entries()) {
      if (day < range.start || day >= range.end) continue;
      const got = line.series[0]?.values[j];
      const wantDay = await bucket(m, byDay.get(day));
      if (!near(got, wantDay))
        out.push(`${where} l_${name} ${m.sql} ${day}: got ${got}, oracle ${wantDay}`);
    }
    const table = data.blocks.find((b) => b.id === "t") as TableData | undefined;
    const groups = await evaluate(m, filter, "region");
    for (const row of table?.rows ?? []) {
      if (row.kind !== undefined) continue;
      const key = String(row.keys[0] ?? null);
      regions.set(key, null);
      const wantGroup = await bucket(m, groups.get(key));
      if (!near(row.values[name], wantGroup))
        out.push(`${where} t ${key} ${m.sql}: got ${row.values[name]}, oracle ${wantGroup}`);
    }
    if (!near(table?.total?.values[name], want))
      out.push(`${where} t total ${m.sql}: got ${table?.total?.values[name]}, oracle ${want}`);
    if (table !== undefined && regions.size !== groups.size)
      out.push(`${where} t: ${regions.size} rows, oracle ${groups.size}`);
    regions.clear();
  }
  return out;
}

describe("SQL metrics with fallbacks against DuckDB over the same rows", {
  timeout: 600_000,
}, () => {
  for (let seed = FIRST; seed < FIRST + CASES; seed++) {
    it(`case ${seed}`, async () => {
      const c = generate(seed);
      const { root, project: loaded } = await writeProject(project(c));
      await oracle.run(
        `CREATE OR REPLACE TABLE fo_rows AS SELECT * FROM read_csv(${lit(`${root}/data/r.csv`)}, header = true, columns = {'day': 'DATE', 'customer': 'VARCHAR', 'region': 'VARCHAR', 'status': 'VARCHAR', 'amount': 'INTEGER'})`,
      );
      await oracle.run(
        `CREATE OR REPLACE TABLE fo_keys AS SELECT * FROM read_csv(${lit(`${root}/data/keys.csv`)}, header = true, columns = {'customer': 'VARCHAR'})`,
      );
      const config = loaded.config.spec;
      if (config === undefined) throw new Error("invalid hatchmark.yaml");
      const executor = await createDuckDbExecutor({ root, config, threads: 1 });
      const failures: string[] = [];
      const bindings = { seg: c.seg, region: c.region };
      try {
        for (const preset of c.presets) {
          const run = await runDashboard(loaded, "d", executor, undefined, {
            ...bindings,
            p: preset,
          });
          expect(run.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
          failures.push(...(await check(c, run.data, preset, `preset ${JSON.stringify(preset)}`)));
        }
        const base = await runDashboard(loaded, "d", executor, undefined, bindings);
        const periods = await runPeriodData(
          loaded,
          "d",
          executor,
          base.data as DashboardData,
          undefined,
          bindings,
          SPAN_START,
        );
        const custom = periods.data?.custom;
        if (custom === undefined) throw new Error("no custom range cube");
        const expected: string[] = [];
        for (const [name, m] of Object.entries(c.metrics)) {
          const empty = await overNoRows(m);
          if (!m.additive || (empty !== null && empty !== 0)) expected.push(name);
        }
        expect(custom.presetOnly).toEqual(expected.sort());
        const presetOnly = new Set(custom.presetOnly);
        for (const range of c.ranges) {
          if (range.end > custom.span.end) continue;
          const label = JSON.stringify(range);
          const cube = customRangeDashboard(custom, "p", range);
          failures.push(...(await check(c, cube, range, `cube ${label}`, presetOnly)));
          const bound = await runDashboard(loaded, "d", executor, undefined, {
            ...bindings,
            p: range,
          });
          failures.push(...(await check(c, bound.data, range, `executor ${label}`)));
        }
      } finally {
        await executor.close();
      }
      expect(failures, JSON.stringify({ seed, seg: c.seg, region: c.region })).toEqual([]);
    });
  }
});
