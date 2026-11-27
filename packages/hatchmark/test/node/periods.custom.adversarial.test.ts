import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { run as cli } from "../../src/cli/main.js";
import type { DashboardData } from "../../src/compiler/dashboard-data.js";
import { runDashboard } from "../../src/compiler/index.js";
import { customRangeDashboard, type PeriodData } from "../../src/compiler/period-data.js";
import { createDuckDbExecutor } from "../../src/node/index.js";
import type { RangeSpec } from "../../src/spec/index.js";
import { loadAt, Oracle } from "./fixture.js";

const TZ = "America/New_York";
const SWEEP = process.env.HM_SWEEP === "full";
const DAY = 86_400_000;
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
const ms = (d: string) => Date.parse(`${d}T00:00:00Z`);
const addDays = (d: string, n: number) => iso(ms(d) + n * DAY);
const days = (a: string, b: string) => Math.round((ms(b) - ms(a)) / DAY);
const pad = (n: number, w = 2) => String(n).padStart(w, "0");
const localDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
/** The New York calendar day of an instant (epoch ms), by Intl. */
const dayOf = (t: number) => localDate.format(new Date(t));

function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const REGIONS = ["Americas", "EMEA", "APAC"];
const ORDERS_LAST = "2026-11-20T19:13:05Z";
const SESSIONS_LAST = "2026-11-18T20:41:00Z";
const LAG_HOURS = 6;

function generate(): { orders: string; sessions: string } {
  const rand = seeded(74);
  const orders = ["order_id,ordered_at,customer_id,region,status,amount"];
  const sessions = ["session_id,started_at,region"];
  let id = 1;
  const stamp = (t: number) => `${new Date(t).toISOString().slice(0, 19)}Z`;
  for (let d = "2025-01-05"; d <= "2026-11-20"; d = addDays(d, 1)) {
    const base = ms(d) + 5 * 3_600_000;
    const n = 3 + Math.floor(rand() * 9);
    for (let i = 0; i < n; i++) {
      const t = base + Math.floor(rand() * DAY);
      if (t >= Date.parse(ORDERS_LAST)) continue;
      const status = rand() < 0.12 ? "refunded" : "paid";
      const amount = (5 + rand() * 195).toFixed(2);
      const customer = `C${pad(Math.floor(rand() * 300), 4)}`;
      const region = REGIONS[Math.floor(rand() * 3)];
      orders.push([id++, stamp(t), customer, region, status, amount].join(","));
    }
    if (d >= "2025-01-10") {
      const s = 20 + Math.floor(rand() * 40);
      for (let i = 0; i < s; i++) {
        const t = base + Math.floor(rand() * DAY);
        if (t >= Date.parse(SESSIONS_LAST)) continue;
        sessions.push([id++, stamp(t), REGIONS[Math.floor(rand() * 3)]].join(","));
      }
    }
  }
  for (const t of [
    "2025-03-09T06:30:00Z",
    "2025-11-02T05:30:00Z",
    "2025-11-02T06:30:00Z",
    "2026-03-08T06:59:59Z",
    "2026-03-08T07:00:00Z",
  ]) {
    orders.push([id++, t, "C9999", "Americas", "paid", "1000.00"].join(","));
    sessions.push([id++, t, "Americas"].join(","));
  }
  orders.push([id++, ORDERS_LAST, "C9998", "EMEA", "paid", "77.77"].join(","));
  sessions.push([id++, SESSIONS_LAST, "EMEA"].join(","));
  return { orders: `${orders.join("\n")}\n`, sessions: `${sessions.join("\n")}\n` };
}

const paid = [{ column: "status", op: "eq", value: "paid" }];
const metric = (spec: Record<string, unknown>) => ({
  format: { type: "number" },
  better: "up",
  ...spec,
});
const METRICS: Record<string, unknown> = {
  revenue: metric({
    label: "Revenue",
    type: "aggregate",
    table: "orders",
    aggregate: "sum",
    column: "amount",
    filters: paid,
    time: "ordered_at",
    format: { type: "currency" },
  }),
  orders: metric({
    label: "Orders",
    type: "aggregate",
    table: "orders",
    aggregate: "count",
    filters: paid,
    time: "ordered_at",
  }),
  sessions: metric({
    label: "Sessions",
    type: "aggregate",
    table: "sessions",
    aggregate: "count",
    time: "started_at",
  }),
  lagged: metric({
    label: "Lagged events",
    type: "aggregate",
    table: "events",
    aggregate: "count",
    time: "ordered_at",
  }),
  conversion: metric({
    label: "Conversion",
    type: "ratio",
    numerator: "orders",
    denominator: "sessions",
    format: { type: "percent", decimals: 2 },
  }),
  customers: metric({
    label: "Customers",
    type: "aggregate",
    table: "orders",
    aggregate: "count_distinct",
    column: "customer_id",
    filters: paid,
    time: "ordered_at",
  }),
  aov: metric({
    label: "AOV",
    type: "ratio",
    numerator: "revenue",
    denominator: "orders",
    format: { type: "currency" },
  }),
  max_amount: metric({
    label: "Largest order",
    type: "aggregate",
    table: "orders",
    aggregate: "max",
    column: "amount",
    filters: paid,
    time: "ordered_at",
    format: { type: "currency" },
  }),
};
const KPIS = Object.keys(METRICS);
/** Metrics a custom range cannot compute from day sums. Formula metrics are left out of
 * dashboards until the planner evaluates them (HM4023), so none is listed here. */
const PRESET_ONLY = new Set(["customers"]);
const TABLE_METRICS = ["revenue", "orders", "conversion", "max_amount"];
const periodFilter = {
  type: "period",
  id: "period",
  options: [
    { last: 7, unit: "day" },
    { last: 30, unit: "day" },
    { to_date: "month" },
    { last_complete: "month" },
    { to_date: "year" },
  ],
  default: { last: 30, unit: "day" },
};
const blocks = [
  ...KPIS.map((m) => ({
    type: "kpi",
    id: `k_${m}`,
    metric: m,
    ...(m === "conversion" || m === "lagged" ? { sparkline: true } : {}),
  })),
  { type: "line", id: "rev_day", metrics: ["revenue"], grain: "day" },
  { type: "line", id: "conv_day", metrics: ["conversion"], grain: "day" },
  { type: "line", id: "lag_day", metrics: ["lagged"], grain: "day" },
  { type: "line", id: "sess_week", metrics: ["sessions"], grain: "week" },
  { type: "table", id: "regions", by: ["region"], metrics: TABLE_METRICS },
];
const DASHBOARDS: Record<string, unknown> = {
  pp: {
    title: "Previous period",
    period: { asOf: "latest_data", range: "last_30_days", compare: "previous_period" },
    filters: [periodFilter],
    blocks,
  },
  ly: {
    title: "Same period last year, Americas",
    period: { asOf: "latest_data", range: "last_30_days", compare: "previous_year" },
    filters: [
      periodFilter,
      { type: "select", id: "region", column: "region", default: "Americas" },
    ],
    blocks,
  },
};

let root: string;
const payloads: Record<string, PeriodData> = {};
let oracle: Oracle;
const H: Record<string, number> = {};

async function writeProject(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "hatchmark-periods-custom-"));
  const { orders, sessions } = generate();
  const files: Record<string, string> = {
    "hatchmark.json": JSON.stringify({
      version: 1,
      name: "Period custom range attacks",
      dataDir: "data",
      metricsDir: "metrics",
      dashboardsDir: "dashboards",
      outDir: "dist",
      locale: "en-US",
      currency: "USD",
      timezone: TZ,
      weekStart: "sunday",
      theme: "default",
      telemetry: false,
      sources: {
        orders: { type: "csv", path: "data/orders.csv" },
        sessions: { type: "csv", path: "data/sessions.csv" },
        events: {
          type: "csv",
          path: "data/orders.csv",
          freshness: { lag: { hours: LAG_HOURS } },
        },
      },
    }),
    "data/orders.csv": orders,
    "data/sessions.csv": sessions,
  };
  for (const [name, spec] of Object.entries(METRICS))
    files[`metrics/${name}.json`] = JSON.stringify(spec);
  for (const [name, spec] of Object.entries(DASHBOARDS))
    files[`dashboards/${name}.json`] = JSON.stringify(spec);
  for (const [file, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
    await writeFile(path.join(dir, file), text);
  }
  return dir;
}

beforeAll(async () => {
  root = await writeProject();
  let out = "";
  const code = await cli(["build", "--json", "--cwd", root], {
    stdout: (t) => {
      out += t;
    },
    stderr: (t) => {
      out += t;
    },
    cwd: root,
    env: {},
    stdoutIsTTY: false,
    isAgent: async () => false,
  });
  expect(code, out).toBe(0);
  for (const name of Object.keys(DASHBOARDS)) {
    const html = await readFile(path.join(root, "dist", name, "index.html"), "utf8");
    const m = /<script type="application\/json" data-hm-periods>(.*?)<\/script>/s.exec(html);
    if (!m) throw new Error(`no period data in ${name}`);
    payloads[name] = JSON.parse(m[1] as string);
  }
  oracle = await Oracle.open();
  const csv = (f: string) => path.join(root, "data", f).replaceAll("'", "''");
  await oracle.run(
    "CREATE TABLE orders AS SELECT * FROM read_csv('" +
      csv("orders.csv") +
      "', all_varchar = true)",
  );
  await oracle.run(
    "CREATE TABLE sessions AS SELECT * FROM read_csv('" +
      csv("sessions.csv") +
      "', all_varchar = true)",
  );
  const [o] = await oracle.rows("SELECT max(ordered_at) AS h FROM orders");
  const [s] = await oracle.rows("SELECT max(started_at) AS h FROM sessions");
  H.orders = Date.parse(o?.h as string);
  H.sessions = Date.parse(s?.h as string);
  H.events = H.orders - LAG_HOURS * 3_600_000;
}, 120_000);
afterAll(async () => {
  oracle?.close();
  if (root) await rm(root, { recursive: true, force: true });
});

type Win = { start: string; end: string; cut?: number };
const SOURCES: Record<string, string[]> = {
  revenue: ["orders"],
  orders: ["orders"],
  customers: ["orders"],
  max_amount: ["orders"],
  aov: ["orders"],
  sessions: ["sessions"],
  lagged: ["events"],
  conversion: ["orders", "sessions"],
};
/** RFC 6.1: the as-of instant T (latest_data: the newest horizon) capped by every source read. */
const horizonOf = (m: string) =>
  Math.min(
    Math.max(H.orders as number, H.sessions as number, H.events as number),
    ...(SOURCES[m] ?? []).map((s) => H[s] as number),
  );
/** RFC 6.4: KPI and table windows end at the local midnight at or before the horizon. */
const lastCompleteEnd = (m: string) => dayOf(horizonOf(m));

const AGG: Record<string, string> = {
  revenue: "sum(amount::DOUBLE) FILTER (WHERE status = 'paid')",
  orders: "count(*) FILTER (WHERE status = 'paid')",
  sessions: "count(*)",
  lagged: "count(*)",
  max_amount: "max(amount::DOUBLE) FILTER (WHERE status = 'paid')",
};

/** A leaf metric over raw rows: local days in [start, end), rows at or before cut, one region. */
async function leaf(m: string, w: Win, region?: string): Promise<number | null> {
  const table = m === "sessions" ? "sessions" : "orders";
  const t = table === "sessions" ? "started_at" : "ordered_at";
  const day = `strftime(timezone('${TZ}', ${t}::TIMESTAMPTZ), '%Y-%m-%d')`;
  const where = [`${day} >= '${w.start}'`, `${day} < '${w.end}'`];
  if (w.cut !== undefined)
    where.push(`${t}::TIMESTAMPTZ <= '${new Date(w.cut).toISOString()}'::TIMESTAMPTZ`);
  if (region) where.push(`region = '${region}'`);
  const [row] = await oracle.rows(
    `SELECT ${AGG[m]} AS v FROM ${table} WHERE ${where.join(" AND ")}`,
  );
  const v = (row?.v ?? null) as number | null;
  return v === null && m !== "max_amount" ? 0 : v;
}

async function value(m: string, w: Win, region?: string): Promise<number | null> {
  const div = (a: number | null, b: number | null) =>
    a === null || b === null || b === 0 ? null : a / b;
  if (m === "conversion")
    return div(await leaf("orders", w, region), await leaf("sessions", w, region));
  if (m === "aov") return div(await leaf("revenue", w, region), await leaf("orders", w, region));
  if (PRESET_ONLY.has(m)) return null;
  return leaf(m, w, region);
}

/** Last year's date, its day clamped to the month (Feb 29 back a year is Feb 28). */
function yearBack(d: string): string {
  const [y = 0, m = 1, dd = 1] = d.split("-").map(Number);
  const last = new Date(Date.UTC(y - 1, m, 0)).getUTCDate();
  return `${pad(y - 1, 4)}-${pad(m)}-${pad(Math.min(dd, last))}`;
}

/**
 * RFC 6.2 and 6.4 for an explicit range [s, e): the current window ends at the last complete day;
 * the comparison as written (previous_period: the same number of days before; previous_year: first
 * and last day a year back) is cut to the current window's day count from its own start.
 */
function kpiWindows(m: string, s: string, e: string, compare: "pp" | "ly") {
  const end = lastCompleteEnd(m) < e ? lastCompleteEnd(m) : e;
  const len = Math.max(0, days(s, end));
  const ps = compare === "pp" ? addDays(s, -days(s, e)) : yearBack(s);
  const pe = compare === "pp" ? s : addDays(yearBack(addDays(e, -1)), 1);
  const cut = addDays(ps, len);
  return {
    current: { start: s, end: len === 0 ? s : end },
    previous: { start: ps, end: [cut, pe].sort()[0] as string },
    empty: len === 0,
  };
}

class Diff {
  problems: string[] = [];
  cells = 0;
  num(where: string, got: unknown, want: number | null) {
    this.cells++;
    const ok =
      want === null
        ? got === null || got === undefined
        : typeof got === "number" && Math.abs(got - want) <= 1e-6 * Math.max(1, Math.abs(want));
    if (!ok) this.problems.push(`${where}: got ${JSON.stringify(got)}, want ${want}`);
  }
  same(where: string, got: unknown, want: unknown) {
    this.cells++;
    if (JSON.stringify(got) !== JSON.stringify(want))
      this.problems.push(`${where}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  }
}

/** Every number and key of two trees; skip names paths a custom range may legitimately differ on. */
function deepCompare(a: unknown, b: unknown, at: string, diff: Diff, skip: (p: string) => boolean) {
  if (skip(at)) return;
  if (typeof a === "number" && typeof b === "number") return diff.num(at, a, b);
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object")
    return diff.same(at, a, b);
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys)
    deepCompare(
      (a as Record<string, unknown>)[k],
      (b as Record<string, unknown>)[k],
      `${at}.${k}`,
      diff,
      skip,
    );
}

const custom = (p: PeriodData, w: Win) =>
  customRangeDashboard(p.custom as NonNullable<PeriodData["custom"]>, p.filter, {
    start: w.start,
    end: w.end,
  });

async function checkOracle(
  name: string,
  data: DashboardData,
  w: Win,
  diff: Diff,
  browser: boolean,
) {
  const region = name === "ly" ? "Americas" : undefined;
  const at = `${name} ${w.start}..${w.end} `;
  for (const b of data.blocks) {
    if (b.type === "kpi") {
      const k = kpiWindows(b.metric, w.start, w.end, name === "ly" ? "ly" : "pp");
      if (PRESET_ONLY.has(b.metric)) {
        if (!browser) continue;
        diff.same(`${at + b.id} presetOnly`, b.presetOnly, true);
        diff.num(`${at + b.id} value`, b.value, null);
        continue;
      }
      diff.same(`${at + b.id} current`, b.current, k.current);
      diff.num(
        `${at + b.id} value`,
        b.value,
        k.empty ? null : await value(b.metric, k.current, region),
      );
      diff.num(
        `${at + b.id} previousValue`,
        b.previousValue,
        k.empty ? null : await value(b.metric, k.previous, region),
      );
    }
    if (b.type === "line" && b.axis.grain === "day") {
      const m = b.series[0]?.metric as string;
      const h = horizonOf(m);
      for (const [i, bucket] of b.axis.buckets.entries()) {
        const hDay = dayOf(h);
        const want =
          bucket > hDay
            ? null
            : await value(
                m,
                { start: bucket, end: addDays(bucket, 1), ...(bucket === hDay ? { cut: h } : {}) },
                region,
              );
        diff.num(`${at + b.id}[${bucket}]`, b.series[0]?.values[i], want);
      }
    }
    if (b.type === "table") {
      for (const row of b.rows) {
        const key = row.keys[0];
        if (typeof key !== "string" || row.kind !== undefined) continue;
        for (const m of TABLE_METRICS) {
          const end = [lastCompleteEnd(m), w.end].sort()[0] as string;
          if (end <= w.start) continue;
          diff.num(
            `${at + b.id}[${key}].${m}`,
            row.values[m],
            await value(m, { start: w.start, end }, key),
          );
        }
      }
    }
  }
}

function ranges(p: PeriodData): Win[] {
  const span = p.custom?.span as { start: string; end: string };
  const last = addDays(span.end, -1);
  const out: Win[] = [
    { start: span.start, end: addDays(span.start, 1) },
    { start: "2025-03-08", end: "2025-03-11" },
    { start: "2025-11-01", end: "2025-11-04" },
    { start: "2026-03-07", end: "2026-03-09" },
    { start: "2026-03-08", end: "2026-03-09" },
    { start: "2025-11-02", end: "2025-11-03" },
    { start: "2025-02-28", end: "2025-03-02" },
    { start: "2026-02-28", end: "2026-03-01" },
    { start: last, end: span.end },
    { start: addDays(last, -1), end: span.end },
    { start: addDays(last, -3), end: span.end },
    { start: "2026-11-17", end: "2026-11-20" },
    { start: "2026-11-18", end: "2026-11-19" },
    { start: "2026-11-19", end: "2026-11-20" },
    { start: "2026-10-22", end: span.end },
    { start: span.start, end: span.end },
    // A link whose dates equal a preset's dates is still an explicit range (RFC 6.4: no slide).
    ...(Object.values(p.presets)[0]?.periodFilter?.options ?? []).flatMap((o) =>
      o.current ? [{ start: o.current.start, end: o.current.end }] : [],
    ),
  ];
  const rand = seeded(4674);
  const n = days(span.start, span.end);
  for (let i = 0; i < (SWEEP ? 300 : 2); i++) {
    const a = Math.floor(rand() * n);
    const len = 1 + Math.floor(rand() * Math.min(120, n - a));
    out.push({ start: addDays(span.start, a), end: addDays(span.start, Math.min(n, a + len)) });
  }
  return out;
}

async function sqlPath(name: string, w: Win): Promise<DashboardData> {
  const { project } = await loadAt(root);
  const config = project.config.spec;
  if (config === undefined) throw new Error("invalid hatchmark.json");
  const executor = await createDuckDbExecutor({ root, config });
  try {
    const binding = { start: w.start, end: w.end } as unknown as RangeSpec;
    const run = await runDashboard(project, name, executor, undefined, { period: binding });
    return run.data as DashboardData;
  } finally {
    await executor.close();
  }
}

const byId = (d: DashboardData) => Object.fromEntries(d.blocks.map((b) => [b.id, b]));
const presetOnlyPath = (p: string) => /\.presetOnly$/.test(p) || /k_customers/.test(p);
const report = (label: string, diff: Diff) =>
  console.log(`${label}: ${diff.cells} cells, ${diff.problems.length} mismatches`);

describe("custom ranges on two sources with different horizons", () => {
  it("the project has the horizons the attacks need", () => {
    expect(new Date(H.orders as number).toISOString()).toBe("2026-11-20T19:13:05.000Z");
    expect(new Date(H.sessions as number).toISOString()).toBe("2026-11-18T20:41:00.000Z");
    expect(payloads.pp?.custom?.span).toEqual({ start: "2025-01-05", end: "2026-11-21" });
  });

  for (const name of Object.keys(DASHBOARDS)) {
    it(`${name}: the oracle agrees with runDashboard's SQL path (oracle sanity)`, async () => {
      const diff = new Diff();
      for (const w of ranges(payloads[name] as PeriodData).slice(0, SWEEP ? 16 : 6))
        await checkOracle(name, await sqlPath(name, w), w, diff, false);
      report(`${name} SQL path vs oracle`, diff);
      expect(diff.problems.slice(0, 30)).toEqual([]);
    }, 600_000);

    it(`${name}: the browser path agrees with the oracle`, async () => {
      const diff = new Diff();
      for (const w of ranges(payloads[name] as PeriodData))
        await checkOracle(name, custom(payloads[name] as PeriodData, w), w, diff, true);
      report(`${name} browser vs oracle`, diff);
      expect(diff.problems.slice(0, 30)).toEqual([]);
    }, 600_000);

    it(`${name}: the browser path equals runDashboard's SQL path`, async () => {
      const diff = new Diff();
      for (const w of ranges(payloads[name] as PeriodData)) {
        const browser = byId(custom(payloads[name] as PeriodData, w));
        const sql = byId(await sqlPath(name, w));
        deepCompare(browser, sql, `${name} ${w.start}..${w.end}`, diff, presetOnlyPath);
      }
      report(`${name} browser vs SQL path`, diff);
      expect(diff.problems.slice(0, 30)).toEqual([]);
    }, 600_000);
  }

  it("the page's period engine keeps a dated link as that custom range", async () => {
    await import("../../runtime/periods.js");
    const engine = (
      globalThis as {
        hatchmarkPeriods?: {
          view: (
            p: PeriodData,
            k: string,
          ) => { key: string; name: string; dates?: string } | undefined;
        };
      }
    ).hatchmarkPeriods;
    const p = payloads.pp as PeriodData;
    const option = Object.values(p.presets)[0]?.periodFilter?.options.find(
      (o) => o.key === "last_7_days",
    );
    const link = `${option?.current?.start}..${addDays(option?.current?.end as string, -1)}`;
    const view = engine?.view(p, link);
    expect(view?.key).toBe(link);
  });
});

describe("planted bugs make the oracle check fail", () => {
  const failures = async (mutate: (p: PeriodData) => void) => {
    const p = structuredClone(payloads.pp) as PeriodData;
    mutate(p);
    const diff = new Diff();
    for (const w of ranges(p).slice(0, 12)) await checkOracle("pp", custom(p, w), w, diff, true);
    return diff.problems.length;
  };
  const components = (p: PeriodData) =>
    (p.custom?.plan.queries ?? []).flatMap((q) => q.measures.flatMap((m) => m.components));

  it("one cent added to the first day of every cube", async () => {
    const n = await failures((p) => {
      for (const cube of Object.values(p.custom?.cubes ?? {}))
        for (const vals of Object.values(cube.values)) {
          const i = cube.days.indexOf(0);
          if (i >= 0 && typeof vals[i] === "number") vals[i] = (vals[i] as number) + 0.01;
        }
    });
    expect(n).toBeGreaterThan(0);
  });
  it("cube days shifted by one (a UTC instead of local day)", async () => {
    const n = await failures((p) => {
      for (const cube of Object.values(p.custom?.cubes ?? {}))
        cube.days = cube.days.map((d) => d + 1);
    });
    expect(n).toBeGreaterThan(0);
  });
  it("max re-aggregated as a sum", async () => {
    const n = await failures((p) => {
      for (const c of components(p)) if (c.reaggregate === "max") c.reaggregate = "sum";
    });
    expect(n).toBeGreaterThan(0);
  });
  it("count_distinct re-aggregated as a sum", async () => {
    const n = await failures((p) => {
      for (const c of components(p)) if (c.reaggregate === "none") c.reaggregate = "sum";
      if (p.custom) p.custom.presetOnly = [];
    });
    expect(n).toBeGreaterThan(0);
  });
  it("source horizons dropped from the embedded context", async () => {
    const n = await failures((p) => {
      if (p.custom) p.custom.context = { ...p.custom.context, horizons: [] };
    });
    expect(n).toBeGreaterThan(0);
  });
});
