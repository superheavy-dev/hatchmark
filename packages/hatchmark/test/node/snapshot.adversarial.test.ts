import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type BarData,
  customRangeDashboard,
  type DashboardData,
  type DateSpan,
  type KpiData,
  type LineData,
  runDashboard,
  runPeriodData,
  type TableData,
} from "../../src/compiler/index.js";
import { createDuckDbExecutor } from "../../src/node/index.js";
import { PROJECT_DEFAULTS, parseDiagnostics, WEEKDAYS } from "../../src/spec/index.js";
import { metric, Oracle, removeProjects, writeProject } from "./fixture.js";

const FULL = process.env.HM_SWEEP === "full";
const CASES = Number(process.env.HM_SNAPSHOT_CASES ?? (FULL ? 400 : 40));
const FIRST = Number(process.env.HM_SNAPSHOT_SEED ?? 1);

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
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
const ms = (d: string) => Date.parse(`${d}T00:00:00Z`);
const addDays = (d: string, n: number) => iso(ms(d) + n * DAY);
function addMonths(d: string, n: number): string {
  const t = new Date(ms(d));
  t.setUTCMonth(t.getUTCMonth() + n);
  return iso(t.getTime());
}

const ZONES = [
  "UTC",
  "America/New_York",
  "America/Los_Angeles",
  "America/Sao_Paulo",
  "Europe/London",
  "America/St_Johns",
  "Asia/Tokyo",
  "Australia/Sydney",
  "Pacific/Auckland",
];
const YEAR_ANCHORS = ["01-01", "02-01", "04-01", "07-01", "10-01", "03-15"];
const TIMES = ["05:00:00", "09:30:00", "12:00:00", "17:45:00", "23:30:00"];
const REGIONS = ["east", "west", "north", null];
const PICKS = ["last", "first", "avg", "min", "max"] as const;
type Pick = (typeof PICKS)[number];
type Kind = "date" | "local" | "utc";
const UNITS = { day: 1, week: 7 } as const;

interface Case {
  seed: number;
  tz: string;
  kind: Kind;
  anchors: { week: string; quarter: string; year: string };
  csv: string;
  dataEnd: string;
  dataStart: string;
  asOf: string;
  range: unknown;
  other: unknown;
  compare: string;
  grain: string;
  select: string[];
  segmentOn: boolean;
  segment: keyof typeof SEGMENTS;
  keys: string;
}

function pick<T>(rand: () => number, items: readonly T[]): T {
  return items[Math.floor(rand() * items.length)] as T;
}

function generate(seed: number): Case {
  const rand = rng(seed);
  const tz = pick(rand, ZONES);
  const kind = pick(rand, ["date", "local", "utc"] as const);
  const year = pick(rand, YEAR_ANCHORS);
  const start = addDays("2024-03-01", Math.floor(rand() * 500));
  const span = 60 + Math.floor(rand() * 420);
  const count = 4 + Math.floor(rand() * 26);
  const offsets = [...new Set(Array.from({ length: count }, () => Math.floor(rand() * span)))].sort(
    (a, b) => a - b,
  );
  const instants: string[] = [];
  for (const o of offsets) {
    const day = addDays(start, o);
    if (kind === "date") {
      instants.push(day);
      continue;
    }
    const times = [...new Set([pick(rand, TIMES), ...(rand() < 0.3 ? [pick(rand, TIMES)] : [])])];
    for (const t of times.sort()) instants.push(`${day} ${t}`);
  }
  const accounts = ["a1", "a2", "a3", "a4", "a5", "a6"];
  const home = new Map(accounts.map((a) => [a, pick(rand, REGIONS)]));
  const lines = ["snapshot_at,account,region,status,balance"];
  instants.forEach((at, n) => {
    const last = n === instants.length - 1;
    const present = accounts.filter(() => rand() < (last && rand() < 0.5 ? 0.25 : 0.65));
    for (const account of present) {
      const copies = rand() < 0.15 ? 2 : 1;
      for (let c = 0; c < copies; c++) {
        const region = rand() < 0.2 ? pick(rand, REGIONS) : (home.get(account) ?? null);
        const status = rand() < 0.3 ? "closed" : "active";
        const balance = rand() < 0.1 ? "" : String(Math.floor(rand() * 420) - 20);
        lines.push(`${at},${account},${region ?? ""},${status},${balance}`);
      }
    }
  });
  lines.push(`,a1,east,active,999`);
  const dataStart = (instants[0] ?? start).slice(0, 10);
  const dataEnd = (instants[instants.length - 1] ?? start).slice(0, 10);
  const asOf = rand() < 0.5 ? "latest_data" : addDays(dataEnd, Math.floor(rand() * 80) - 60);
  const explicitStart = addDays(dataStart, Math.floor(rand() * span * 0.7));
  const ranges: unknown[] = [
    { last: 30, unit: "day" },
    { last: 90, unit: "day" },
    { last: 8, unit: "week" },
    { last: 6, unit: "month" },
    "last_12_months",
    { to_date: "month" },
    { to_date: "quarter" },
    { to_date: "year" },
    { last_complete: "month" },
    { last_complete: "quarter" },
    { last_complete: "week" },
    "all_time",
    { start: explicitStart, end: addDays(explicitStart, 10 + Math.floor(rand() * 200)) },
  ];
  const range = pick(rand, ranges);
  const short =
    typeof range === "object" && range !== null && "unit" in range && range.unit === "day";
  return {
    seed,
    tz,
    kind,
    anchors: { week: pick(rand, WEEKDAYS), quarter: year, year },
    csv: lines.join("\n"),
    dataStart,
    dataEnd,
    asOf,
    range,
    other: pick(
      rand,
      ranges.filter((r) => r !== range),
    ),
    compare:
      range === "all_time"
        ? "none"
        : pick(rand, ["previous_period", "previous_period", "previous_year"]),
    grain: short ? pick(rand, ["day", "week"]) : pick(rand, ["week", "month", "quarter", "year"]),
    select: rand() < 0.4 ? [] : REGIONS.filter((r): r is string => r !== null && rand() < 0.5),
    segmentOn: rand() < 0.5,
    segment: pick(rand, Object.keys(SEGMENTS) as (keyof typeof SEGMENTS)[]),
    keys: [
      "account",
      ...accounts.filter(() => rand() < 0.4),
      ...(rand() < 0.3 ? [""] : []),
      ...(rand() < 0.3 ? ["a1", "zz"] : []),
    ].join("\n"),
  };
}

const base = {
  type: "aggregate",
  table: "balances",
  time: "snapshot_at",
  aggregate: "sum",
  column: "balance",
};
const SEGMENTS = {
  big: { filter: { column: "balance", op: "gte", value: 100 }, where: "balance >= 100" },
  vips: {
    filter: { column: "account", op: "in_table", table: "vip", key: "account" },
    where: "account IN (SELECT account FROM vip_keys WHERE account IS NOT NULL)",
  },
  nonvip: {
    filter: { column: "account", op: "not_in_table", table: "vip", key: "account" },
    where:
      "NOT coalesce(account IN (SELECT account FROM vip_keys WHERE account IS NOT NULL), FALSE)",
  },
} as const;

const METRICS: Record<
  string,
  { pick: Pick; agg: "sum" | "count"; active: boolean; vip?: boolean }
> = {};
for (const p of PICKS) {
  METRICS[p] = { pick: p, agg: "sum", active: false };
  METRICS[`${p}_active`] = { pick: p, agg: "sum", active: true };
}
METRICS.count_last = { pick: "last", agg: "count", active: false };
METRICS.count_avg = { pick: "avg", agg: "count", active: false };
METRICS.last_vip = { pick: "last", agg: "sum", active: false, vip: true };
METRICS.min_vip = { pick: "min", agg: "sum", active: false, vip: true };

const TABLE_METRICS = Object.keys(METRICS).filter((m) => !m.startsWith("count_"));

function project(c: Case) {
  const files: Record<string, unknown> = {
    "hatchmark.yaml": {
      ...PROJECT_DEFAULTS,
      name: "snapshots",
      timezone: c.tz,
      anchors: c.anchors,
      sources: {
        vip: { type: "csv", path: "data/vip.csv" },
        balances: {
          type: "csv",
          path: "data/balances.csv",
          snapshot: "snapshot_at",
          ...(c.kind === "local" ? { timezone: c.tz } : {}),
        },
      },
    },
    "data/balances.csv": c.csv,
    "data/vip.csv": c.keys,
    ...Object.fromEntries(
      Object.entries(SEGMENTS).map(([name, s]) => [
        `segments/${name}.yaml`,
        { label: name, filters: [s.filter] },
      ]),
    ),
  };
  for (const [name, m] of Object.entries(METRICS)) {
    files[`metrics/${name}.yaml`] = metric({
      ...base,
      over_time: m.pick,
      ...(m.agg === "count" ? { aggregate: "count" } : {}),
      ...(m.active ? { filters: [{ column: "status", op: "eq", value: "active" }] } : {}),
      ...(m.vip ? { segments: ["vips"] } : {}),
    });
  }
  const splitMetric = PICKS[c.seed % PICKS.length] as Pick;
  files["dashboards/d.yaml"] = {
    title: "Snapshots",
    period: { asOf: c.asOf, range: c.range, compare: c.compare },
    filters: [
      { type: "period", id: "period", options: [c.range, c.other], default: c.range },
      {
        type: "select",
        id: "region",
        column: "region",
        multiple: true,
        ...(c.select.length > 0 ? { default: c.select } : {}),
      },
      {
        type: "segment",
        id: "seg",
        segments: [c.segment],
        ...(c.segmentOn ? { default: [c.segment] } : {}),
      },
    ],
    blocks: [
      ...Object.keys(METRICS).map((m) => ({ type: "kpi", id: `k_${m}`, metric: m })),
      { type: "line", id: "series", metrics: [...PICKS], grain: c.grain },
      { type: "line", id: "split", metrics: [splitMetric], grain: c.grain, split: "region" },
      {
        type: "bar",
        id: "stacked",
        metrics: [splitMetric],
        grain: c.grain,
        split: "region",
        stack: true,
      },
      { type: "table", id: "table", by: ["region"], metrics: TABLE_METRICS },
      { type: "bar", id: "cats", metrics: [...PICKS], by: "region" },
    ],
  };
  return files;
}

let oracle: Oracle;
beforeAll(async () => {
  oracle = await Oracle.open();
});
afterAll(async () => {
  oracle.close();
  await removeProjects();
});

const lit = (s: string) => `'${s.replaceAll("'", "''")}'`;

async function load(c: Case, path: string): Promise<void> {
  const type = c.kind === "date" ? "DATE" : "TIMESTAMP";
  await oracle.run(
    `CREATE OR REPLACE TABLE bal AS SELECT * FROM read_csv(${lit(path)}, header = true, columns = {'snapshot_at': '${type}', 'account': 'VARCHAR', 'region': 'VARCHAR', 'status': 'VARCHAR', 'balance': 'INTEGER'})`,
  );
  await oracle.run(
    `CREATE OR REPLACE TABLE vip_keys AS SELECT * FROM read_csv(${lit(path.replace(/balances\.csv$/, "vip.csv"))}, header = true, columns = {'account': 'VARCHAR'})`,
  );
  const tz = lit(c.tz);
  const instant =
    c.kind === "date"
      ? `timezone(${tz}, CAST(snapshot_at AS TIMESTAMP))`
      : c.kind === "local"
        ? `timezone(${tz}, snapshot_at)`
        : `timezone('UTC', snapshot_at)`;
  const day =
    c.kind === "date"
      ? "snapshot_at"
      : c.kind === "local"
        ? "CAST(snapshot_at AS DATE)"
        : `CAST(timezone(${tz}, timezone('UTC', snapshot_at)) AS DATE)`;
  await oracle.run(
    `CREATE OR REPLACE VIEW v AS SELECT *, ${instant} AS i, ${day} AS d FROM bal WHERE snapshot_at IS NOT NULL`,
  );
}

function rowFilter(c: Case, active: boolean, vip = false): string {
  return [
    "TRUE",
    ...(active ? ["status = 'active'"] : []),
    ...(c.select.length > 0 ? [`region IN (${c.select.map(lit).join(", ")})`] : []),
    ...(c.segmentOn ? [SEGMENTS[c.segment].where] : []),
    ...(vip ? [SEGMENTS.vips.where] : []),
  ].join(" AND ");
}

async function evaluate(
  name: string,
  where: string,
  domain: string,
  c: Case,
  group: boolean,
): Promise<Map<string, number | null>> {
  const m = METRICS[name];
  if (m === undefined) throw new Error(name);
  const filter = rowFilter(c, m.active, m.vip);
  const chosen =
    m.pick === "last"
      ? "i = (SELECT max(i) FROM w)"
      : m.pick === "first"
        ? "i = (SELECT min(i) FROM w)"
        : "TRUE";
  const outer = m.pick === "avg" ? "avg" : m.pick === "min" ? "min" : "max";
  const agg = m.agg === "sum" ? "coalesce(sum(balance), 0)" : "count(balance)";
  const rows = await oracle.rows(`
    WITH w AS (SELECT * FROM v WHERE ${where}),
    instants AS (SELECT DISTINCT i FROM w WHERE ${chosen}),
    groups AS (${group ? `SELECT DISTINCT region AS g FROM v WHERE (${domain}) AND ${rowFilter(c, false)}` : "SELECT NULL AS g"})
    SELECT g, ${outer}(t) AS value FROM (
      SELECT groups.g, (SELECT ${agg} FROM w x WHERE x.i = instants.i AND ${filter}${group ? " AND x.region IS NOT DISTINCT FROM groups.g" : ""}) AS t
      FROM instants, groups
    ) GROUP BY g`);
  return new Map(rows.map((r) => [String(r.g), r.value === null ? null : Number(r.value)]));
}

function spanWhere(c: Case, span: DateSpan | undefined, current: boolean): string {
  if (span === undefined) {
    if (c.range !== "all_time") return "FALSE";
    const asOf = c.asOf === "latest_data" ? "TRUE" : `d <= DATE ${lit(c.asOf)}`;
    if (c.kind === "date") return asOf;
    return `${asOf} AND i < timezone(${lit(c.tz)}, CAST((SELECT max(d) FROM v) AS TIMESTAMP))`;
  }
  const tz = lit(c.tz);
  const at = (wall: string) => `timezone(${tz}, CAST(${lit(wall.replace("T", " "))} AS TIMESTAMP))`;
  const start = at(span.startAt ?? span.start);
  const end = span.endAt === undefined ? at(span.end) : current ? undefined : at(span.endAt);
  return `i >= ${start}${end === undefined ? "" : ` AND i < ${end}`}`;
}

function bucketEnd(start: string, grain: string): string {
  if (grain === "day" || grain === "week") return addDays(start, UNITS[grain]);
  return addMonths(start, grain === "month" ? 1 : grain === "quarter" ? 3 : 12);
}

const near = (a: unknown, b: number | null | undefined) =>
  b === null || b === undefined
    ? a === null || a === undefined
    : typeof a === "number" && Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b));

async function check(c: Case, data: DashboardData | undefined, where: string): Promise<string[]> {
  const out: string[] = [];
  if (data === undefined) return [`${where}: no data`];
  const blocks = new Map(data.blocks.map((b) => [b.id, b]));
  for (const name of Object.keys(METRICS)) {
    const k = blocks.get(`k_${name}`) as KpiData | undefined;
    if (k === undefined) {
      out.push(`${where} k_${name}: missing`);
      continue;
    }
    const value = (await evaluate(name, spanWhere(c, k.current, true), "TRUE", c, false)).get(
      "null",
    );
    if (!near(k.value, value ?? null))
      out.push(
        `${where} k_${name}: got ${k.value}, oracle ${value} over ${JSON.stringify(k.current)}`,
      );
    if (k.previous !== undefined) {
      const prev = (await evaluate(name, spanWhere(c, k.previous, false), "TRUE", c, false)).get(
        "null",
      );
      if (!near(k.previousValue, prev ?? null))
        out.push(
          `${where} k_${name} previous: got ${k.previousValue}, oracle ${prev} over ${JSON.stringify(k.previous)}`,
        );
    }
  }
  const series = blocks.get("series") as LineData | undefined;
  const buckets = series?.axis.buckets ?? [];
  const cut = series?.axis.window
    ? spanWhere(c, { ...series.axis.window, start: "0001-01-01" }, true)
    : "FALSE";
  const inBucket = (b: string) =>
    `d >= DATE ${lit(b)} AND d < DATE ${lit(bucketEnd(b, c.grain))} AND ${cut}`;
  const axisWindow =
    buckets.length === 0
      ? "FALSE"
      : `d >= DATE ${lit(buckets[0] ?? "")} AND d < DATE ${lit(bucketEnd(buckets[buckets.length - 1] ?? "", c.grain))} AND ${cut}`;
  for (const s of series?.series ?? []) {
    for (const [j, b] of buckets.entries()) {
      const want = (await evaluate(s.metric, inBucket(b), "TRUE", c, false)).get("null") ?? null;
      if (!near(s.values[j], want))
        out.push(`${where} series ${s.metric} ${b}: got ${s.values[j]}, oracle ${want}`);
    }
  }
  for (const id of ["split", "stacked"]) {
    const block = blocks.get(id) as LineData | BarData | undefined;
    if (block === undefined) {
      out.push(`${where} ${id}: missing`);
      continue;
    }
    const axis = (block.axis as { buckets?: string[] }).buckets ?? [];
    const metricName = block.series[0]?.metric ?? (PICKS[c.seed % PICKS.length] as string);
    const seen = new Set<string>();
    for (const [j, b] of axis.entries()) {
      const groups = await evaluate(metricName, inBucket(b), axisWindow, c, true);
      for (const s of block.series) {
        const key = String(s.splitValue ?? null);
        seen.add(key);
        const want = groups.has(key) ? (groups.get(key) ?? null) : null;
        if (!near(s.values[j], want))
          out.push(`${where} ${id} ${key} ${b}: got ${s.values[j]}, oracle ${want}`);
      }
      for (const key of groups.keys()) {
        if (!seen.has(key)) out.push(`${where} ${id}: no series for ${key}`);
      }
      if (id === "stacked" && block.series.length > 0) {
        const total =
          (await evaluate(metricName, inBucket(b), "TRUE", c, false)).get("null") ?? null;
        if (!near(block.totals?.[j], total))
          out.push(`${where} stacked total ${b}: got ${block.totals?.[j]}, oracle ${total}`);
      }
    }
  }
  const table = blocks.get("table") as TableData | undefined;
  const tableWhere = spanWhere(c, table?.window, true);
  for (const name of TABLE_METRICS) {
    const groups = await evaluate(name, tableWhere, tableWhere, c, true);
    const rows = table?.rows.filter((r) => r.kind === undefined) ?? [];
    for (const row of rows) {
      const key = String(row.keys[0] ?? null);
      if (!near(row.values[name], groups.get(key) ?? null))
        out.push(
          `${where} table ${key} ${name}: got ${row.values[name]}, oracle ${groups.get(key)}`,
        );
    }
    if (rows.length !== groups.size)
      out.push(`${where} table: ${rows.length} rows, oracle ${groups.size}`);
    const total = (await evaluate(name, tableWhere, "TRUE", c, false)).get("null");
    if (!near(table?.total?.values[name], total ?? null))
      out.push(`${where} table total ${name}: got ${table?.total?.values[name]}, oracle ${total}`);
  }
  const cats = blocks.get("cats") as BarData | undefined;
  const categories = (cats?.axis as { categories?: unknown[] } | undefined)?.categories ?? [];
  for (const s of cats?.series ?? []) {
    const groups = await evaluate(s.metric, tableWhere, tableWhere, c, true);
    categories.forEach((cat, j) => {
      const want = groups.get(String(cat ?? null)) ?? null;
      if (!near(s.values[j], want))
        out.push(`${where} cats ${s.metric} ${String(cat)}: got ${s.values[j]}, oracle ${want}`);
    });
  }
  return out;
}

function sameBlocks(
  a: DashboardData | undefined,
  b: DashboardData | undefined,
  where: string,
): string[] {
  const out: string[] = [];
  for (const block of a?.blocks ?? []) {
    const other = b?.blocks.find((x) => x.id === block.id);
    const values = (d: unknown): unknown[] => {
      const x = d as Record<string, unknown> | undefined;
      if (x === undefined) return [];
      if (x.type === "kpi") return [x.value, x.previousValue ?? null];
      if (x.type === "table") {
        const t = x as unknown as TableData;
        return [
          ...t.rows.flatMap((r) => [JSON.stringify(r.keys), ...Object.values(r.values)]),
          ...Object.values(t.total?.values ?? {}),
        ];
      }
      const s = x as unknown as LineData;
      return [...s.series.flatMap((r) => [r.key, ...r.values]), ...(s.totals ?? [])];
    };
    const got = values(block);
    const want = values(other);
    if (
      got.length !== want.length ||
      got.some((v, i) =>
        typeof v === "number" ? !near(v, want[i] as number | null) : v !== want[i],
      )
    ) {
      out.push(
        `${where} ${block.id}: custom ${JSON.stringify(got)} vs executor ${JSON.stringify(want)}`,
      );
    }
  }
  return out;
}

describe("snapshot over_time against a DuckDB oracle", () => {
  for (let seed = FIRST; seed < FIRST + CASES; seed++) {
    it(`case ${seed}`, async () => {
      const c = generate(seed);
      const { root, project: loaded } = await writeProject(project(c));
      expect(parseDiagnostics(loaded).map((d) => d.message)).toEqual([]);
      await load(c, `${root}/data/balances.csv`);
      const config = loaded.config.spec;
      if (config === undefined) throw new Error("invalid hatchmark.yaml");
      const executor = await createDuckDbExecutor({ root, config });
      const failures: string[] = [];
      try {
        const base = await runDashboard(loaded, "d", executor);
        const errors = base.diagnostics.filter(
          (d) => d.severity === "error" || d.code === "HM4023",
        );
        expect(errors.map((d) => `${d.code} ${d.message}`)).toEqual([]);
        failures.push(...(await check(c, base.data, "default")));
        const periods = await runPeriodData(loaded, "d", executor, base.data as DashboardData);
        const custom = periods.data?.custom;
        if (custom !== undefined && base.data !== undefined) {
          const rand = rng(seed * 7 + 3);
          const spanDays = Math.round((ms(custom.span.end) - ms(custom.span.start)) / DAY);
          for (let n = 0; n < 2 && spanDays > 1; n++) {
            const startAt = Math.floor(rand() * (spanDays - 1));
            const length = 1 + Math.floor(rand() * Math.min(150, spanDays - startAt - 1));
            const range = {
              start: addDays(custom.span.start, startAt),
              end: addDays(custom.span.start, startAt + length),
            };
            const fromCube = customRangeDashboard(custom, "period", range);
            const bound = await runDashboard(loaded, "d", executor, undefined, { period: range });
            failures.push(...sameBlocks(fromCube, bound.data, `custom ${JSON.stringify(range)}`));
            failures.push(
              ...(await check({ ...c, range }, bound.data, `bound ${JSON.stringify(range)}`)),
            );
          }
        }
      } finally {
        await executor.close();
      }
      expect(
        failures,
        JSON.stringify({
          tz: c.tz,
          kind: c.kind,
          asOf: c.asOf,
          range: c.range,
          grain: c.grain,
          select: c.select,
          segment: c.segmentOn ? c.segment : "off",
        }),
      ).toEqual([]);
    }, 60_000);
  }
});
