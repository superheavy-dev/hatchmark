import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  type DashboardExecutor,
  type ParamBindings,
  rangeKey,
  runDashboard,
  runDashboardBindings,
} from "../../src/compiler/index.js";
import { runPeriodData } from "../../src/compiler/period-build.js";
import {
  createCachedExecutor,
  createDuckDbExecutor,
  nodeProjectHost,
} from "../../src/node/index.js";
import { loadProject, type Project, type RangeSpec } from "../../src/spec/index.js";
import { toYaml } from "../yaml.js";

const SWEEP = process.env.HM_SWEEP === "full";
const SEEDS = SWEEP ? 40 : 3;
const NOW = new Date("2026-11-27T12:00:00Z");

vi.setConfig({ testTimeout: SWEEP ? 1_800_000 : 120_000, hookTimeout: 60_000 });

function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1));
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)] as T;
  const chance = (p: number) => next() < p;
  const some = <T>(xs: readonly T[], lo: number, hi: number): T[] => {
    const copy = [...xs];
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(next() * (i + 1));
      [copy[i], copy[j]] = [copy[j] as T, copy[i] as T];
    }
    return copy.slice(0, Math.min(copy.length, int(lo, hi)));
  };
  return { next, int, pick, chance, some };
}
type Rng = ReturnType<typeof rng>;

const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const REGIONS = ["Americas", "EMEA", "APAC", "", "Ünïcode ✓", "a,b"];
const CHANNELS = Array.from({ length: 23 }, (_, i) => "ch" + String(i).padStart(2, "0"));

async function writeData(r: Rng, root: string) {
  const last = Date.UTC(2025, 0, 1) + r.int(0, 600) * DAY;
  const span = r.pick([20, 45, 120, 400, 900]);
  const n = r.int(300, 2500) * Number(process.env.HM_ROWS ?? 1);
  const hugeFrom = r.chance(0.3) ? last - r.int(0, span) * DAY : Number.POSITIVE_INFINITY;
  const lines = ["id,d,ts,tz,qty,big,price,x,f,region,channel,flag,cust,nothing,score"];
  for (let i = 0; i < n; i++) {
    const day = last - Math.floor(r.next() ** r.pick([0.5, 1, 2]) * span) * DAY;
    const t = day + r.int(0, DAY / 1000 - 1) * 1000;
    const q = r.chance(0.05) ? "" : String(r.int(-20, 200));
    const big = String(r.int(0, 1000) * 2 ** 40 + r.int(0, 999));
    const price = r.chance(0.04) ? "" : (r.int(-5000, 500000) / 100).toFixed(2);
    let x: string;
    if (r.chance(0.04)) x = "";
    else if (t >= hugeFrom && r.chance(0.2)) x = String(r.int(1, 9) * 1e14 + r.next());
    else if (r.chance(0.02)) x = "-0.0";
    else x = String((r.next() - 0.2) * 10 ** r.int(-3, 6));
    const f = r.chance(0.05) ? "" : String(Math.fround(r.next() * 1000));
    const region = r.chance(0.08) ? "" : r.pick(REGIONS);
    const channel = r.chance(0.03) ? "" : r.pick(CHANNELS.slice(0, r.pick([3, 8, 23])));
    const flag = r.chance(0.05) ? "" : String(r.chance(0.6));
    const cust = r.chance(0.03) ? "" : "c" + r.int(1, r.pick([5, 50, 400]));
    const score = r.chance(0.05) ? "" : (r.int(0, 50) / 10).toFixed(1);
    const dcol = r.chance(0.01) ? "" : iso(day);
    const q2 = (s: string) => '"' + s.replaceAll('"', '""') + '"';
    lines.push(
      [
        i,
        dcol,
        new Date(t).toISOString().slice(0, 19).replace("T", " "),
        new Date(t).toISOString(),
        q,
        big,
        price,
        x,
        f,
        region === "" ? "" : q2(region),
        channel,
        flag,
        cust,
        "",
        score,
      ].join(","),
    );
  }
  await mkdir(path.join(root, "data"), { recursive: true });
  const csv = path.join(root, "data", "raw.csv");
  await writeFile(csv, lines.join("\n") + "\n");
  const db = await DuckDBInstance.create(":memory:");
  const c = await db.connect();
  await c.run("SET TimeZone = 'UTC'");
  const target = path.join(root, "data", "sales.parquet");
  await c.run(
    "COPY (SELECT id::INTEGER AS id, d::DATE AS d, ts::TIMESTAMP AS ts, tz::TIMESTAMPTZ AS tz, qty::INTEGER AS qty, big::BIGINT AS big, price::DECIMAL(12,2) AS price, x::DOUBLE AS x, f::FLOAT AS f, region::VARCHAR AS region, channel::VARCHAR AS channel, flag::BOOLEAN AS flag, cust::VARCHAR AS cust, nothing::INTEGER AS nothing, score::DECIMAL(5,1) AS score FROM read_csv('" +
      csv +
      "', all_varchar = true, header = true)) TO '" +
      target +
      "' (FORMAT parquet)",
  );
  c.closeSync();
  db.closeSync();
  await rm(csv);
  const evLast = last - r.int(0, 40) * DAY;
  const ev = ["day,n"];
  for (let i = 0; i < r.int(20, 300); i++) {
    if (r.chance(0.3)) continue;
    ev.push(iso(evLast - r.int(0, span) * DAY) + "," + (r.chance(0.05) ? "" : r.int(-3, 40)));
  }
  await writeFile(path.join(root, "data", "ev.csv"), ev.join("\n") + "\n");
  return { last, span };
}

type Spec = Record<string, unknown>;
function metricPool(r: Rng): Record<string, Spec> {
  const time = () => r.pick(["d", "ts", "tz"]);
  const num = { type: "number" };
  const agg = (aggregate: string, column?: string, extra: Spec = {}) => ({
    label: aggregate + " " + (column ?? "rows"),
    type: "aggregate",
    table: "sales",
    aggregate,
    ...(column ? { column } : {}),
    time: time(),
    format: num,
    better: "up",
    ...extra,
  });
  const sql = (s: string, additive: boolean, extra: Spec = {}) => ({
    label: "sql",
    type: "sql",
    table: "sales",
    sql: s,
    additive,
    time: time(),
    format: num,
    better: "up",
    ...extra,
  });
  const ratio = (a: string, b: string) => ({
    label: a + "/" + b,
    type: "ratio",
    numerator: a,
    denominator: b,
    format: r.pick([num, { type: "percent", decimals: 1 }]),
    better: "up",
  });
  const flt = () =>
    r.pick([
      [],
      [{ column: "flag", op: "eq", value: true }],
      [{ column: "region", op: "in", values: ["EMEA", "APAC"] }],
      [{ column: "region", op: "neq", value: "EMEA" }],
      [{ column: "qty", op: "gt", value: 10 }],
      [{ column: "d", op: "between", from: "2025-03-01", to: "2025-09-30" }],
      [{ column: "price", op: "not_null" }],
    ]);
  return {
    rev: agg("sum", "price", { filters: flt(), format: { type: "currency" } }),
    units: agg("sum", "qty", { filters: flt() }),
    bigsum: agg("sum", "big"),
    xsum: agg("sum", "x", { filters: flt() }),
    favg: agg("avg", "f"),
    xavg: agg("avg", "x"),
    pavg: agg("avg", "price"),
    cnt: agg("count", undefined, { filters: flt() }),
    cntq: agg("count", "qty"),
    custd: agg("count_distinct", "cust", { filters: flt() }),
    qmin: agg("min", "qty"),
    pmax: agg("max", "price"),
    med: agg("median", "price"),
    s_mul: sql("sum(qty) * 1.5", false),
    s_q90: sql("quantile_cont(x, 0.9)", false),
    s_list: sql("list_sort(list(qty))[1]", false),
    s_x: sql("sum(x)", true),
    s_null: sql("max(CAST(NULL AS DOUBLE))", false),
    s_nothing: sql("sum(nothing)", true),
    s_regions: sql("count(DISTINCT region)", false),
    s_dec: sql("CAST(sum(price) AS DECIMAL(18,4))", true),
    s_cte: sql("count(*) + (WITH t AS (SELECT 2 AS v ORDER BY v LIMIT 1) SELECT v FROM t)", false),
    s_filt: sql("sum(qty) FILTER (WHERE region IS NULL)", true, {
      filters: [{ column: "flag", op: "eq", value: true }],
    }),
    s_win: sql("max(price) - min(price)", false),
    s_stmt: sql("count(*) + length(current_query())", false),
    units2: agg("sum", "qty"),
    units3: agg("sum", "qty"),
    ev_n: {
      label: "ev",
      type: "aggregate",
      table: "ev",
      aggregate: "sum",
      column: "n",
      time: "day",
      format: num,
      better: "up",
    },
    r_aov: ratio("rev", "cnt"),
    r_upc: ratio("units", "custd"),
    r_x: ratio("xsum", "cnt"),
    r_sx: ratio("s_x", "cntq"),
    r_ev: ratio("ev_n", "cnt"),
    r_nul: ratio("rev", "s_nothing"),
  };
}

const ADDITIVE = ["rev", "units", "bigsum", "xsum", "cnt", "cntq", "s_x", "s_dec", "ev_n"];
const DIMS = ["region", "channel", "score", "flag", "cust", "ts"];

function presetPool(r: Rng, last: number, span: number) {
  const fixed = () => {
    const a = last - r.int(-30, span + 60) * DAY;
    const b = a + r.int(0, 200) * DAY;
    return { start: iso(a), end: iso(b) };
  };
  return [
    "last_7_days",
    "last_30_days",
    "last_90_days",
    "last_12_months",
    "month_to_date",
    "quarter_to_date",
    "year_to_date",
    "last_complete_month",
    "last_complete_quarter",
    "last_complete_year",
    "all_time",
    { last: r.int(1, 60), unit: "day" },
    { last: r.int(1, 10), unit: "week" },
    { last: r.int(1, 24), unit: "month" },
    { last: r.int(1, 6), unit: "quarter" },
    { last: r.int(1, 3), unit: "year" },
    { to_date: r.pick(["week", "month", "quarter", "year"]) },
    { last_complete: r.pick(["week", "month", "quarter", "year"]) },
    fixed(),
    fixed(),
    fixed(),
  ];
}

function dashboard(r: Rng, metrics: string[], last: number, span: number): Spec {
  const pool = presetPool(r, last, span);
  const seen = new Set<string>();
  const options: unknown[] = [];
  for (const p of r.some(pool, 2, 12)) {
    const key = rangeKey(p as RangeSpec);
    if (seen.has(key)) continue;
    seen.add(key);
    options.push(p);
  }
  const m = () => r.pick(metrics);
  const add = metrics.filter((x) => ADDITIVE.includes(x));
  const am = () => (add.length > 0 ? r.pick(add) : "cnt");
  const grain = () =>
    r.pick([
      "day",
      "week",
      "month",
      "quarter",
      "year",
      { unit: "year", anchor: "07-01" },
      { unit: "quarter", anchor: "02-15" },
    ]);
  const blocks: Spec[] = [];
  const nb = r.int(3, 9);
  const usesGrainFilter = r.chance(0.4);
  for (let i = 0; i < nb; i++) {
    const kind = r.pick([
      "kpi",
      "kpi",
      "line",
      "bar",
      "barg",
      "table",
      "table",
      "pie",
      "scatter",
      "stack",
    ]);
    if (kind === "kpi")
      blocks.push({
        type: "kpi",
        metric: m(),
        ...(r.chance(0.4) ? { sparkline: true } : {}),
        ...(r.chance(0.2) ? { compare: r.pick(["previous_period", "previous_year", "none"]) } : {}),
      });
    if (kind === "line") {
      const g = grain();
      const split = r.chance(0.4);
      blocks.push({
        type: "line",
        metrics: split ? [m()] : r.some(metrics, 1, 3),
        grain: usesGrainFilter && typeof g === "string" ? "week" : g,
        ...(usesGrainFilter ? { grains: ["day", "week", "month"] } : {}),
        ...(split ? { split: r.pick(["region", "channel"]) } : {}),
        ...(r.chance(0.3) ? { edges: "clip" } : {}),
        ...(r.chance(0.3) ? { incomplete: r.pick(["hide", "show", "mark"]) } : {}),
      });
    }
    if (kind === "bar") {
      const ms = r.some(metrics, 1, 2);
      const by = r.pick(DIMS);
      blocks.push({
        type: "bar",
        metrics: ms,
        by,
        ...(r.chance(0.6) ? { limit: r.int(1, 6) } : {}),
        ...(r.chance(0.5)
          ? { sort: { by: r.pick([...ms, by]), order: r.pick(["asc", "desc"]) } }
          : {}),
      });
    }
    if (kind === "barg")
      blocks.push({
        type: "bar",
        metrics: [am()],
        grain: grain(),
        ...(r.chance(0.5) ? { split: "region", stack: true } : {}),
      });
    if (kind === "stack")
      blocks.push({
        type: "line",
        area: undefined,
        metrics: [am()],
        grain: "month",
        split: "channel",
      });
    if (kind === "table") {
      const by = r.some(DIMS.slice(0, 4), 1, 3);
      const ms = r.some(metrics, 1, 5);
      const limit = r.chance(0.6) ? r.int(1, 8) : undefined;
      blocks.push({
        type: "table",
        by,
        metrics: ms,
        ...(limit !== undefined ? { limit, ...(r.chance(0.6) ? { other: true } : {}) } : {}),
        ...(by.length > 1 && r.chance(0.5) ? { subtotals: true } : {}),
        ...(r.chance(0.4)
          ? { percentOfTotal: ms.filter((x) => ADDITIVE.includes(x)).slice(0, 1) }
          : {}),
        ...(r.chance(0.3)
          ? { sort: { by: r.pick([...by, ...ms]), order: r.pick(["asc", "desc"]) } }
          : {}),
      });
    }
    if (kind === "pie")
      blocks.push({
        type: r.pick(["pie", "donut"]),
        metric: am(),
        by: r.pick(["region", "channel", "flag"]),
        limit: r.int(1, 6),
      });
    if (kind === "scatter")
      blocks.push({
        type: "scatter",
        x: m(),
        y: m(),
        by: r.pick(["channel", "cust", "region"]),
        ...(r.chance(0.5) ? { size: am() } : {}),
        ...(r.chance(0.4) ? { limit: r.int(1, 20) } : {}),
      });
  }
  for (const b of blocks) if ("area" in b) delete b.area;
  const filters: Spec[] = [];
  if (r.chance(0.4))
    filters.push({
      type: "select",
      id: "region",
      column: "region",
      multiple: true,
      ...(r.chance(0.6) ? { default: r.some(["EMEA", "APAC", "Americas"], 1, 2) } : {}),
    });
  filters.push({
    type: "period",
    id: "period",
    options,
    default: r.pick(options),
    ...(r.chance(0.3) ? { custom: false } : {}),
  });
  if (usesGrainFilter)
    filters.push({
      type: "grain",
      id: "grain",
      options: ["day", "week", "month"],
      default: "week",
    });
  return {
    title: "Random",
    period: {
      asOf: r.pick([
        "latest_data",
        "latest_data",
        "latest_common_data",
        iso(last - r.int(-10, 100) * DAY),
      ]),
      range: "last_12_months",
      compare: r.pick(["previous_period", "previous_year", "none"]),
    },
    filters,
    blocks,
  };
}

async function writeProjectAt(seed: number) {
  const r = rng(seed);
  const root = await mkdtemp(path.join(tmpdir(), "hatchmark-batch-sweep-"));
  const { last, span } = await writeData(r, root);
  const pool = metricPool(r);
  await mkdir(path.join(root, "metrics"));
  for (const [name, spec] of Object.entries(pool))
    await writeFile(path.join(root, "metrics", name + ".yaml"), toYaml(spec));
  await mkdir(path.join(root, "dashboards"));
  const names = Object.keys(pool);
  const dashboards: string[] = [];
  for (let i = 0; i < 3; i++) {
    const metrics = r.some(names, 2, 8);
    await writeFile(
      path.join(root, "dashboards", "d" + i + ".yaml"),
      toYaml(dashboard(r, metrics, last, span)),
    );
    dashboards.push("d" + i);
  }
  await writeFile(
    path.join(root, "hatchmark.yaml"),
    toYaml({
      version: 1,
      name: "Random",
      dataDir: "data",
      metricsDir: "metrics",
      dashboardsDir: "dashboards",
      outDir: "dist",
      locale: "en-US",
      currency: "USD",
      timezone: r.pick(["America/New_York", "UTC", "Pacific/Auckland", "America/Los_Angeles"]),
      weekStart: r.pick(["sunday", "monday"]),
      theme: "default",
      telemetry: false,
      sources: {
        sales: { type: "parquet", path: "data/sales.parquet" },
        ev: { type: "csv", path: "data/ev.csv" },
      },
    }),
  );
  return { root, dashboards, r };
}

const oneByOne = (inner: DashboardExecutor): DashboardExecutor => ({
  execute: (query, context) => inner.execute(query, context),
  horizon: (column) => inner.horizon(column),
});

async function pageOf(project: Project, name: string, executor: DashboardExecutor) {
  const base = await runDashboard(project, name, executor, NOW);
  const period =
    base.data === undefined
      ? undefined
      : await runPeriodData(project, name, executor, base.data, NOW);
  return JSON.stringify({ base, period });
}

function firstDiff(a: string, b: string) {
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  return {
    at: i,
    single: a.slice(Math.max(0, i - 160), i + 160),
    other: b.slice(Math.max(0, i - 160), i + 160),
  };
}

const roots: string[] = [];
afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

describe(`batched presets equal one query at a time on random projects (${SEEDS} seeds, HM_SWEEP=full for 40)`, () => {
  it.each(Array.from({ length: SEEDS }, (_, i) => i + 1))("seed %i", async (seed) => {
    const { root, dashboards, r } = await writeProjectAt(seed);
    roots.push(root);
    const { project } = await loadProject(nodeProjectHost(root));
    const config = project?.config.spec;
    if (project === undefined || config === undefined) throw new Error(`no project in ${root}`);
    const createInner = (at: string) => createDuckDbExecutor({ root: at, config });
    const db = await createDuckDbExecutor({ root, config });
    const mismatches: unknown[] = [];
    const pages: Record<string, Record<string, string>> = {};
    try {
      const cold = await createCachedExecutor({ root, config, createInner });
      try {
        for (const name of dashboards) {
          const single = await pageOf(project, name, oneByOne(db));
          pages[name] = {
            single,
            batched: await pageOf(project, name, db),
            cold: await pageOf(project, name, cold),
          };
        }
      } finally {
        await cold.close();
      }
      const warm = await createCachedExecutor({ root, config, createInner });
      try {
        for (const [name, page] of Object.entries(pages)) {
          page.warm = await pageOf(project, name, warm);
          for (const kind of ["batched", "cold", "warm"]) {
            if (page[kind] !== page.single) {
              mismatches.push({
                seed,
                name,
                kind,
                ...firstDiff(page.single as string, page[kind] as string),
              });
            }
          }
        }
      } finally {
        await warm.close();
      }
      for (const name of dashboards) {
        const spec = project.dashboards.get(name)?.spec;
        if (!spec?.filters?.some((f) => f.type === "select")) continue;
        const period = spec.filters.find((f) => f.type === "period");
        const options = period?.type === "period" ? period.options : [];
        const sets: ParamBindings[] = Array.from({ length: 6 }, () => ({
          ...(r.chance(0.8)
            ? {
                region: r.pick([
                  r.some(["EMEA", "APAC", "Americas", "nowhere"], 1, 2),
                  "EMEA",
                  null,
                  Number.NaN,
                  [],
                  ["EMEA", "EMEA"],
                  3,
                  Array(1),
                  [undefined],
                ]),
              }
            : {}),
          ...(r.chance(0.7) && options.length > 0 ? { period: r.pick(options) } : {}),
        })) as ParamBindings[];
        sets.push(sets[0] as ParamBindings);
        const many = await runDashboardBindings(project, name, db, sets, NOW);
        for (const [i, set] of sets.entries()) {
          const one = JSON.stringify(await runDashboard(project, name, oneByOne(db), NOW, set));
          const got = JSON.stringify(many[i]);
          if (one !== got)
            mismatches.push({ seed, name, kind: "bindings", set, ...firstDiff(one, got) });
        }
      }
    } finally {
      await db.close();
    }
    expect(mismatches.slice(0, 3)).toEqual([]);
  });
});
