import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type BarData,
  type BlockData,
  customRangeDashboard,
  type DashboardData,
  type KpiData,
  type LineData,
  type PieData,
  runDashboard,
  runPeriodData,
  type Series,
  type TableData,
  type TimeAxis,
  type Value,
} from "../../src/compiler/index.js";
import { rangeKey } from "../../src/compiler/periods.js";
import { createDuckDbExecutor } from "../../src/node/index.js";
import { PROJECT_DEFAULTS, WEEKDAYS } from "../../src/spec/index.js";
import { metric, Oracle, removeProjects, writeProject } from "./fixture.js";

const FULL = process.env.HM_SWEEP === "full";
const CASES = Number(process.env.HM_SNAP_ORACLE_CASES ?? (FULL ? 300 : 10));
const FIRST = Number(process.env.HM_SNAP_ORACLE_SEED ?? 9001);
const ONLY = (process.env.HM_SNAP_ORACLE_ONLY ?? "").split(",").filter(Boolean).map(Number);

function rng(seed: number): () => number {
  let s = (seed * 2246822519) >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
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
const bucketEnd = (b: string, g: string) =>
  g === "day"
    ? addDays(b, 1)
    : g === "week"
      ? addDays(b, 7)
      : addMonths(b, g === "month" ? 1 : g === "quarter" ? 3 : 12);
const pickOf = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;
const lit = (s: string) => `'${s.replaceAll("'", "''")}'`;

const ZONES = [
  "UTC",
  "America/New_York",
  "America/Los_Angeles",
  "Europe/London",
  "Asia/Tokyo",
  "Australia/Sydney",
  "America/St_Johns",
  "Pacific/Auckland",
];
const KINDS = ["date", "naive", "local", "tstz"] as const;
const CADENCES = ["daily", "irregular", "intraday", "gappy", "monthly"] as const;
const TIMES = [
  "00:00:00",
  "00:30:00",
  "06:15:00",
  "09:00:00",
  "12:00:00",
  "18:45:00",
  "23:30:00",
  "23:59:59",
];
const OFFSETS = ["-08:00", "+00:00", "+05:30", "+09:00", "-03:30"];
const REGIONS = ["east", "west", "north", null];
const PLANS = ["free", "pro", "ent"];
const PICKS = ["last", "first", "avg", "min", "max"] as const;
type Pick = (typeof PICKS)[number];
const AGGS: Record<string, { aggregate: string; column?: string }> = {
  sb: { aggregate: "sum", column: "balance" },
  sa: { aggregate: "sum", column: "amount" },
  n: { aggregate: "count" },
  nb: { aggregate: "count", column: "balance" },
  cd: { aggregate: "count_distinct", column: "account" },
  av: { aggregate: "avg", column: "balance" },
  mn: { aggregate: "min", column: "balance" },
  mx: { aggregate: "max", column: "balance" },
  md: { aggregate: "median", column: "balance" },
};
interface M {
  pick: Pick;
  agg: string;
  act?: boolean;
  seg?: boolean;
}
const METRICS: Record<string, M> = {};
for (const p of PICKS)
  for (const a of Object.keys(AGGS)) METRICS[`${p}_${a}`] = { pick: p, agg: a };
METRICS.last_sb_act = { pick: "last", agg: "sb", act: true };
METRICS.avg_sb_act = { pick: "avg", agg: "sb", act: true };
METRICS.min_sb_act = { pick: "min", agg: "sb", act: true };
METRICS.max_av_act = { pick: "max", agg: "av", act: true };
METRICS.last_sb_seg = { pick: "last", agg: "sb", seg: true };
METRICS.avg_n_seg = { pick: "avg", agg: "n", seg: true };
const SEGMENTS: Record<string, { filter: unknown; where: string }> = {
  big: { filter: { column: "balance", op: "gte", value: 100 }, where: "balance >= 100" },
  paid: {
    filter: { column: "plan", op: "in_table", table: "paid", key: "plan" },
    where: "plan IN (SELECT plan FROM paid_keys WHERE plan IS NOT NULL)",
  },
  free: {
    filter: { column: "plan", op: "not_in_table", table: "paid", key: "plan" },
    where: "NOT coalesce(plan IN (SELECT plan FROM paid_keys WHERE plan IS NOT NULL), FALSE)",
  },
};
const TABLE2 = [
  "last_sb",
  "first_sb",
  "avg_sb",
  "min_sb",
  "max_sb",
  "last_av",
  "avg_mx",
  "last_cd",
  "last_md",
  "avg_n",
  "last_sa",
  "min_sb_act",
];
const TABLE1 = [
  "first_av",
  "max_av",
  "min_mx",
  "last_mn",
  "avg_cd",
  "max_md",
  "first_nb",
  "last_n",
  "min_sa",
  "avg_sa",
  "last_sb_seg",
  "avg_sb_act",
];
const SERIES2 = ["last_av", "avg_mx", "max_md", "first_cd", "min_nb", "avg_sa", "max_av_act"];

interface Case {
  seed: number;
  tz: string;
  kind: (typeof KINDS)[number];
  cadence: string;
  csv: string;
  orders?: string;
  anchors: { week: string; quarter: string; year: string };
  asOf: string;
  range: unknown;
  other: unknown;
  compare: string;
  grain: string;
  grain2: string;
  region: string[];
  plan: string[];
  segment: string;
  segmentOn: boolean;
  split: string;
  stackMetric: string;
  subtotals: boolean;
  limit?: number;
  paid: string;
  target: Record<string, number>;
  path: string;
}

function generate(seed: number): Case {
  const r = rng(seed);
  const tz = pickOf(r, ZONES);
  const kind = pickOf(r, KINDS);
  const cadence = pickOf(r, CADENCES);
  const start = addDays("2024-05-01", Math.floor(r() * 700));
  let days: string[] = [];
  if (cadence === "daily") {
    const n = 30 + Math.floor(r() * 120);
    for (let i = 0; i < n; i++) if (r() > 0.1) days.push(addDays(start, i));
  } else if (cadence === "irregular" || cadence === "intraday") {
    const span = 40 + Math.floor(r() * 360);
    const n = 5 + Math.floor(r() * 25);
    days = [...new Set(Array.from({ length: n }, () => addDays(start, Math.floor(r() * span))))];
  } else if (cadence === "gappy") {
    let at = start;
    for (let c = 0; c < 3; c++) {
      const n = 3 + Math.floor(r() * 12);
      for (let i = 0; i < n; i++) days.push(addDays(at, i));
      at = addDays(at, n + 40 + Math.floor(r() * 70));
    }
  } else {
    const n = 5 + Math.floor(r() * 14);
    for (let i = 0; i < n; i++) {
      const m = addMonths(`${start.slice(0, 8)}01`, i);
      const late = r() < 0.3;
      days.push(
        late
          ? addDays(addMonths(m, 1), Math.floor(r() * 3))
          : addDays(addMonths(m, 1), -1 - Math.floor(r() * 4)),
      );
    }
  }
  days = [...new Set(days)].sort();
  const instants: string[] = [];
  for (const d of days) {
    if (kind === "date") {
      instants.push(d);
      continue;
    }
    const k = cadence === "intraday" ? 1 + Math.floor(r() * 4) : 1;
    const times = [...new Set(Array.from({ length: k }, () => pickOf(r, TIMES)))].sort();
    for (const t of times) instants.push(`${d} ${t}${kind === "tstz" ? pickOf(r, OFFSETS) : ""}`);
  }
  const accounts = ["a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8"];
  const home = new Map(
    accounts.map((a) => [a, { region: pickOf(r, REGIONS), plan: pickOf(r, PLANS) }]),
  );
  const lines = ["t,account,region,plan,status,balance,amount"];
  for (const at of instants) {
    for (const a of accounts) {
      if (r() > 0.7) continue;
      const copies = r() < 0.1 ? 2 : 1;
      for (let c = 0; c < copies; c++) {
        const h = home.get(a) as { region: string | null; plan: string };
        const region = r() < 0.15 ? pickOf(r, REGIONS) : h.region;
        const plan = r() < 0.1 ? pickOf(r, PLANS) : h.plan;
        const nullish = region === "north" ? r() < 0.5 : r() < 0.08;
        const balance = nullish ? "" : String(Math.floor(r() * 400) - 30);
        const amount = r() < 0.05 ? "" : (Math.floor(r() * 100000) / 100 - 50).toFixed(2);
        lines.push(
          [at, a, region ?? "", plan, r() < 0.3 ? "closed" : "active", balance, amount].join(","),
        );
      }
    }
  }
  lines.push(",a1,east,pro,active,999,1.5");
  const dataEnd = (days[days.length - 1] ?? start) as string;
  const dataStart = (days[0] ?? start) as string;
  let orders: string | undefined;
  if (r() < 0.45) {
    const lead = Math.floor(r() * 3);
    const o = ["at,amt"];
    for (let d = dataStart; d <= addDays(dataEnd, lead); d = addDays(d, 1 + Math.floor(r() * 6)))
      o.push(`${d} ${pickOf(r, TIMES)},${Math.floor(r() * 90)}`);
    o.push(`${addDays(dataEnd, lead)} ${pickOf(r, ["03:00:00", "13:20:00", "21:10:00"])},5`);
    orders = o.join("\n");
  }
  const asOf = r() < 0.6 ? "latest_data" : addDays(dataEnd, Math.floor(r() * 50) - 40);
  const span = Math.max(10, Math.round((ms(dataEnd) - ms(dataStart)) / DAY));
  const xs = addDays(dataStart, Math.floor(r() * span * 0.6));
  const ranges: unknown[] = [
    { last: 30, unit: "day" },
    { last: 14, unit: "day" },
    { last: 8, unit: "week" },
    { last: 6, unit: "month" },
    "last_12_months",
    { to_date: "month" },
    { to_date: "quarter" },
    { to_date: "year" },
    { last_complete: "month" },
    { last_complete: "quarter" },
    { last_complete: "week" },
    { last_complete: "year" },
    "all_time",
    { start: xs, end: addDays(xs, 7 + Math.floor(r() * 200)) },
  ];
  const range = pickOf(r, ranges);
  const short =
    typeof range === "object" &&
    range !== null &&
    "unit" in range &&
    (range as { unit: string }).unit !== "month";
  const grain = short ? pickOf(r, ["day", "week"]) : pickOf(r, ["week", "month", "quarter"]);
  const grain2 =
    grain === "day"
      ? "week"
      : grain === "week"
        ? pickOf(r, ["day", "month"])
        : grain === "month"
          ? pickOf(r, ["week", "quarter"])
          : "month";
  const yr = pickOf(r, ["01-01", "02-01", "04-01", "07-01", "10-01"]);
  const names = Object.keys(METRICS);
  const target: Record<string, number> = {};
  const t0 = addMonths(`${dataStart.slice(0, 8)}01`, Math.floor(r() * 3) - 1);
  const months = Math.max(1, Math.round((ms(dataEnd) - ms(t0)) / (30 * DAY)) + 2);
  const stride = 1 + Math.floor(r() * 3);
  for (let i = 0; i <= months + stride; i += stride)
    target[addMonths(t0, i)] = 50 + Math.floor(r() * 900);
  const unfiltered = seed % 3 === 0;
  return {
    seed,
    tz,
    kind,
    cadence,
    csv: lines.join("\n"),
    ...(orders === undefined ? {} : { orders }),
    anchors: { week: pickOf(r, WEEKDAYS), quarter: yr, year: yr },
    asOf,
    range,
    other: pickOf(
      r,
      ranges.filter((x) => x !== range),
    ),
    compare:
      range === "all_time"
        ? "none"
        : pickOf(r, ["previous_period", "previous_year", "previous_period", "none"]),
    grain,
    grain2,
    region:
      r() < 0.4 || unfiltered ? [] : REGIONS.filter((x): x is string => x !== null && r() < 0.5),
    plan: r() < 0.6 || unfiltered ? [] : [pickOf(r, PLANS)],
    segment: pickOf(r, Object.keys(SEGMENTS)),
    segmentOn: r() < 0.5 && !unfiltered,
    split: pickOf(r, names),
    stackMetric: pickOf(r, ["last_sb", "first_sb", "avg_sb", "avg_n", "last_sa", "last_nb"]),
    subtotals: r() < 0.5,
    ...(r() < 0.6 ? { limit: 1 + Math.floor(r() * 3) } : {}),
    paid: ["plan", ...PLANS.filter(() => r() < 0.5), ...(r() < 0.3 ? [""] : [])].join("\n"),
    target,
    path: pickOf(r, ["linear", "compound"]),
  };
}

function project(c: Case) {
  const files: Record<string, unknown> = {
    "hatchmark.yaml": {
      ...PROJECT_DEFAULTS,
      name: "snapshot-oracle",
      timezone: c.tz,
      anchors: c.anchors,
      sources: {
        paid: { type: "csv", path: "data/paid.csv" },
        bal: {
          type: "csv",
          path: "data/bal.csv",
          snapshot: "t",
          ...(c.kind === "local" ? { timezone: c.tz } : {}),
        },
        ...(c.orders === undefined ? {} : { orders: { type: "csv", path: "data/orders.csv" } }),
      },
    },
    "data/bal.csv": c.csv,
    "data/paid.csv": c.paid,
    ...(c.orders === undefined
      ? {}
      : {
          "data/orders.csv": c.orders,
          "metrics/ord.yaml": metric({
            type: "aggregate",
            table: "orders",
            time: "at",
            aggregate: "sum",
            column: "amt",
          }),
        }),
    ...Object.fromEntries(
      Object.entries(SEGMENTS).map(([n, s]) => [
        `segments/${n}.yaml`,
        { label: n, filters: [s.filter] },
      ]),
    ),
  };
  for (const [name, m] of Object.entries(METRICS)) {
    files[`metrics/${name}.yaml`] = metric({
      type: "aggregate",
      table: "bal",
      time: "t",
      over_time: m.pick,
      ...AGGS[m.agg],
      ...(m.act ? { filters: [{ column: "status", op: "eq", value: "active" }] } : {}),
      ...(m.seg ? { segments: ["paid"] } : {}),
      ...(name === "last_sb"
        ? { targets: [{ id: "tg", grain: "month", values: c.target, path: c.path }] }
        : {}),
    });
  }
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
        ...(c.region.length ? { default: c.region } : {}),
      },
      {
        type: "select",
        id: "plan",
        column: "plan",
        multiple: true,
        ...(c.plan.length ? { default: c.plan } : {}),
      },
      {
        type: "segment",
        id: "seg",
        segments: [c.segment],
        ...(c.segmentOn ? { default: [c.segment] } : {}),
      },
    ],
    blocks: [
      ...Object.keys(METRICS).map((m) => ({
        type: "kpi",
        id: `k_${m}`,
        metric: m,
        ...(["last_sb", "avg_sb", "max_sb", "first_md"].includes(m) ? { sparkline: true } : {}),
        ...(m === "last_sb" ? { target: "tg" } : {}),
      })),
      ...(c.orders === undefined ? [] : [{ type: "kpi", id: "k_ord", metric: "ord" }]),
      {
        type: "line",
        id: "series",
        metrics: PICKS.map((p) => `${p}_sb`),
        grain: c.grain,
        grains: [c.grain, c.grain2],
      },
      { type: "line", id: "series2", metrics: SERIES2, grain: c.grain },
      { type: "line", id: "split", metrics: [c.split], grain: c.grain, split: "region" },
      {
        type: "bar",
        id: "stacked",
        metrics: [c.stackMetric],
        grain: c.grain,
        split: "plan",
        stack: true,
      },
      { type: "line", id: "lt", metrics: ["last_sb"], grain: c.grain, target: "tg" },
      {
        type: "table",
        id: "t2",
        by: ["region", "plan"],
        metrics: TABLE2,
        percentOfTotal: ["last_sb", "avg_sb"],
        ...(c.subtotals ? { subtotals: true } : {}),
        ...(c.limit ? { limit: c.limit, other: true } : {}),
      },
      { type: "table", id: "t1", by: ["region"], metrics: TABLE1 },
      { type: "bar", id: "cats", metrics: PICKS.map((p) => `${p}_sb`), by: "plan" },
      { type: "pie", id: "pie", metric: c.seed % 2 ? "last_sb" : "avg_sb", by: "region" },
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
  if (process.env.HM_SNAP_STATS) console.log(`STATS ${JSON.stringify(stats)}`);
});

async function load(c: Case, root: string) {
  const type = { date: "DATE", naive: "TIMESTAMP", local: "TIMESTAMP", tstz: "TIMESTAMPTZ" }[
    c.kind
  ];
  await oracle.run(
    "CREATE OR REPLACE TABLE bal AS SELECT * FROM read_csv(" +
      lit(`${root}/data/bal.csv`) +
      ", header = true, columns = {'t': '" +
      type +
      "', 'account': 'VARCHAR', 'region': 'VARCHAR', 'plan': 'VARCHAR', 'status': 'VARCHAR', 'balance': 'INTEGER', 'amount': 'DOUBLE'})",
  );
  await oracle.run(
    "CREATE OR REPLACE TABLE paid_keys AS SELECT * FROM read_csv(" +
      lit(`${root}/data/paid.csv`) +
      ", header = true, columns = {'plan': 'VARCHAR'})",
  );
  const tz = lit(c.tz);
  const i = {
    date: `timezone(${tz}, CAST(t AS TIMESTAMP))`,
    naive: "timezone('UTC', t)",
    local: `timezone(${tz}, t)`,
    tstz: "t",
  }[c.kind];
  const d = {
    date: "t",
    naive: `CAST(timezone(${tz}, timezone('UTC', t)) AS DATE)`,
    local: "CAST(t AS DATE)",
    tstz: `CAST(timezone(${tz}, t) AS DATE)`,
  }[c.kind];
  await oracle.run(
    "CREATE OR REPLACE VIEW v AS SELECT *, " +
      i +
      " AS i, " +
      d +
      " AS d FROM bal WHERE t IS NOT NULL",
  );
}

const wall = (c: Case, w: string) =>
  `timezone(${lit(c.tz)}, CAST(${lit(w.replace("T", " "))} AS TIMESTAMP))`;
const instantLit = (z: string) => `CAST(${lit(z)} AS TIMESTAMPTZ)`;

function dash(c: Case): string {
  return [
    "TRUE",
    ...(c.region.length ? [`region IN (${c.region.map(lit).join(", ")})`] : []),
    ...(c.plan.length ? [`plan IN (${c.plan.map(lit).join(", ")})`] : []),
    ...(c.segmentOn ? [SEGMENTS[c.segment]?.where as string] : []),
  ].join(" AND ");
}

const cache = new Map<string, Map<string, number | null>>();
async function evaluate(
  c: Case,
  name: string,
  win: string,
  dims: string[] = [],
  domain = "TRUE",
  restrict = "TRUE",
) {
  const key = JSON.stringify([name, win, dims, domain, restrict]);
  const hit = cache.get(key);
  if (hit) return hit;
  const m = METRICS[name] as M;
  const a = AGGS[m.agg] as { aggregate: string; column?: string };
  const col = a.column ?? "*";
  const inner =
    a.aggregate === "sum"
      ? `coalesce(sum(${col}), 0)`
      : a.aggregate === "count"
        ? `count(${col})`
        : a.aggregate === "count_distinct"
          ? `count(DISTINCT ${col})`
          : `${a.aggregate}(${col})`;
  const own = [
    ...(m.act ? ["status = 'active'"] : []),
    ...(m.seg ? [SEGMENTS.paid?.where as string] : []),
  ];
  const chosen =
    m.pick === "last"
      ? "i = (SELECT max(i) FROM snaps)"
      : m.pick === "first"
        ? "i = (SELECT min(i) FROM snaps)"
        : "TRUE";
  const outer = m.pick === "avg" ? "avg" : m.pick === "min" ? "min" : "max";
  const g = dims.length ? dims.map((x, j) => `${x} AS g${j}`).join(", ") : "1 AS g0";
  const match = dims.map((x, j) => `x.${x} IS NOT DISTINCT FROM dom.g${j}`);
  const keys = dims.length ? dims.map((_, j) => `g${j}`) : ["g0"];
  const sql =
    "WITH w AS (SELECT * FROM v WHERE " +
    win +
    "), snaps AS (SELECT DISTINCT i FROM w), picked AS (SELECT i FROM snaps WHERE " +
    chosen +
    "), " +
    (dims.length
      ? "dom AS (SELECT DISTINCT " +
        g +
        " FROM v WHERE (" +
        domain +
        ") AND " +
        dash(c) +
        " AND " +
        restrict +
        "), "
      : "dom AS (SELECT 1 AS g0), ") +
    "per AS (SELECT dom.*, (SELECT " +
    inner +
    " FROM w x WHERE x.i = picked.i AND " +
    [dash(c).replaceAll("plan IN", "x.plan IN"), ...own, ...match, restrict].join(" AND ") +
    ") AS val FROM dom, picked) " +
    "SELECT to_json([" +
    keys.join(", ") +
    "]) AS k, " +
    outer +
    "(val) AS value FROM per GROUP BY ALL";
  const rows = await oracle.rows(sql);
  const out = new Map(
    rows.map((row) => [
      dims.length ? String(row.k) : "[1]",
      row.value === null ? null : Number(row.value),
    ]),
  );
  cache.set(key, out);
  return out;
}

const stats = { values: 0, nonNull: 0, other: 0, custom: 0, presets: 0, targets: 0 };
const near = (a: unknown, b: number | null | undefined) => {
  stats.values++;
  if (b !== null && b !== undefined) stats.nonNull++;
  return nearValue(a, b);
};
const nearValue = (a: unknown, b: number | null | undefined) =>
  b === null || b === undefined
    ? a === null || a === undefined
    : typeof a === "number" && Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b));

function spanSql(c: Case, s: { start: string; end: string; startAt?: string; endAt?: string }) {
  return `i >= ${wall(c, s.startAt ?? s.start)} AND i < ${wall(c, s.endAt ?? s.end)}`;
}

async function check(c: Case, data: DashboardData | undefined, where: string): Promise<string[]> {
  const out: string[] = [];
  if (!data) return [`${where}: no data`];
  const blocks = new Map<string, BlockData>(data.blocks.map((b) => [b.id, b]));
  const own = data.horizons?.find((h) => h.source === "bal")?.through;
  const T = data.horizons?.length
    ? data.horizons
        .map((h) => h.through)
        .sort()
        .slice(-1)[0]
    : undefined;
  const asOfT = c.asOf === "latest_data" ? T : undefined;
  const asOfEnd = asOfT ? instantLit(asOfT) : wall(c, addDays(data.asOf, 1));
  const H = own ? `least(${asOfEnd}, ${instantLit(own)})` : asOfEnd;
  const D =
    "timezone(" +
    lit(c.tz) +
    ", CAST(CAST(timezone(" +
    lit(c.tz) +
    ", " +
    H +
    ") AS DATE) AS TIMESTAMP))";
  const one = async (name: string, win: string) =>
    (await evaluate(c, name, win)).get("[1]") ?? null;
  for (const name of Object.keys(METRICS)) {
    const k = blocks.get(`k_${name}`) as KpiData | undefined;
    if (!k) {
      out.push(`${where} k_${name}: missing`);
      continue;
    }
    const win = k.current ? spanSql(c, k.current) : c.range === "all_time" ? `i < ${D}` : "FALSE";
    const want = k.empty ? null : await one(name, win);
    if (!near(k.value, want))
      out.push(
        where +
          " k_" +
          name +
          ": got " +
          k.value +
          ", oracle " +
          want +
          " over " +
          JSON.stringify(k.current ?? "all_time"),
      );
    if (k.previous) {
      const prev = await one(name, spanSql(c, k.previous));
      if (!near(k.previousValue, prev))
        out.push(
          where +
            " k_" +
            name +
            " previous: got " +
            k.previousValue +
            ", oracle " +
            prev +
            " over " +
            JSON.stringify(k.previous),
        );
    }
    if (
      k.sparkline &&
      (c.range === "all_time" ||
        (typeof c.range === "object" &&
          c.range &&
          ("to_date" in c.range || "last_complete" in c.range)))
    ) {
      const lc =
        typeof c.range === "object" && c.range !== null && "last_complete" in c.range
          ? String(c.range.last_complete)
          : undefined;
      const next = addDays(data.asOf, 1);
      const dDate = String(
        (
          await oracle.rows(
            `SELECT CAST(CAST(timezone(${lit(c.tz)}, ${H}) AS DATE) AS VARCHAR) AS d`,
          )
        )[0]?.d,
      );
      const trimmed =
        !!k.current && !!lc && unitBoundary(next, lc, c) && k.current.end === dDate && dDate < next;
      const lastPartial = (k.sparkline.partial ?? []).some(
        (p) => p.index === (k.sparkline?.buckets.length ?? 0) - 1,
      );
      const cut = k.current?.endAt
        ? wall(c, k.current.endAt)
        : k.current &&
            !(typeof c.range === "object" && c.range !== null && "to_date" in c.range) &&
            !trimmed
          ? wall(c, k.current.end)
          : H;
      for (const [j, b] of (lc && lastPartial ? [] : k.sparkline.buckets).entries()) {
        const want2 = await one(
          name,
          "d >= DATE " +
            lit(b) +
            " AND d < DATE " +
            lit(bucketEnd(b, "month")) +
            " AND i < " +
            cut +
            " AND i < " +
            H,
        );
        if (!near(k.sparkline.values[j], want2))
          out.push(
            where +
              " k_" +
              name +
              " sparkline " +
              b +
              ": got " +
              k.sparkline.values[j] +
              ", oracle " +
              want2,
          );
      }
    }
    if (name === "last_sb" && k.target && !k.target.hidden && !k.empty) {
      const endSql = k.current
        ? k.current.endAt
          ? wall(c, k.current.endAt)
          : wall(c, k.current.end)
        : D;
      const tv = await targetAt(c, endSql);
      if (tv !== null && tv !== undefined) stats.targets++;
      if (!near(k.target.value, tv))
        out.push(`${where} k_last_sb target: got ${k.target.value}, oracle ${tv}`);
      if (
        tv !== null &&
        tv !== undefined &&
        want !== null &&
        tv !== 0 &&
        !near(k.target.attainment, want / tv)
      )
        out.push(`${where} k_last_sb attainment: got ${k.target.attainment}, oracle ${want / tv}`);
    }
  }
  const timeBlock = async (
    id: string,
    axis: TimeAxis,
    series: Series[],
    totals?: Value[],
    grain?: string,
  ) => {
    const g = grain ?? axis.grain;
    const cut = axis.window.endAt ? wall(c, axis.window.endAt) : wall(c, axis.window.end);
    const inB = (b: string) =>
      "d >= DATE " +
      lit(b) +
      " AND d < DATE " +
      lit(bucketEnd(b, g)) +
      " AND i < " +
      cut +
      " AND i < " +
      H;
    const buckets: string[] = axis.buckets;
    const whole = buckets.length
      ? "d >= DATE " +
        lit(buckets[0] as string) +
        " AND d < DATE " +
        lit(bucketEnd(buckets[buckets.length - 1] as string, g)) +
        " AND i < " +
        cut +
        " AND i < " +
        H
      : "FALSE";
    for (const s of series) {
      if (!METRICS[s.metric]) continue;
      for (const [j, b] of buckets.entries()) {
        let want: number | null;
        if (s.splitValue !== undefined) {
          const col = id === "stacked" ? "plan" : "region";
          want =
            (await evaluate(c, s.metric, inB(b), [col], whole)).get(
              JSON.stringify([s.splitValue]),
            ) ?? null;
        } else want = await one(s.metric, inB(b));
        if (!near(s.values[j], want))
          out.push(
            where +
              " " +
              id +
              " " +
              s.key +
              " " +
              g +
              " " +
              b +
              ": got " +
              s.values[j] +
              ", oracle " +
              want,
          );
      }
    }
    const splitCol = id === "stacked" ? "plan" : id === "split" ? "region" : undefined;
    if (splitCol && series[0]) {
      const name = series[0].metric;
      const seen = new Set(series.map((s) => JSON.stringify([s.splitValue])));
      for (const [j, b] of buckets.entries()) {
        const groups = await evaluate(c, name, inB(b), [splitCol], whole);
        for (const k of groups.keys())
          if (!seen.has(k)) out.push(`${where} ${id} ${b}: no series for ${k}`);
        if (totals) {
          const want = await one(name, inB(b));
          if (!near(totals[j], want))
            out.push(`${where} ${id} total ${b}: got ${totals[j]}, oracle ${want}`);
        }
      }
    }
  };
  for (const id of ["series", "series2", "split", "stacked", "lt"]) {
    const b = blocks.get(id) as (LineData | BarData) | undefined;
    if (b?.axis.kind !== "time") {
      out.push(`${where} ${id}: missing`);
      continue;
    }
    const axis = b.axis;
    await timeBlock(id, axis, b.series, b.totals);
    for (const opt of b.grains?.options ?? [])
      await timeBlock(`${id}@${opt.key}`, opt.axis, opt.series, opt.totals);
    if (id === "lt" && b.series[0]?.target && own) {
      const g = axis.grain;
      for (const [j, bk] of axis.buckets.entries()) {
        const axisEnd = axis.window.endAt ? wall(c, axis.window.endAt) : wall(c, axis.window.end);
        const bEnd = wall(c, bucketEnd(bk, g));
        const cutByH = `${bEnd} > ${H} AND ${wall(c, bk)} < ${H}`;
        const endSql =
          "CASE WHEN " +
          cutByH +
          " AND " +
          H +
          " <= " +
          axisEnd +
          " THEN " +
          H +
          " WHEN " +
          bEnd +
          " <= " +
          axisEnd +
          " THEN " +
          bEnd +
          " END";
        const tv = await targetAt(c, endSql);
        if (tv === undefined) continue;
        if (!near(b.series[0].target.values[j], tv))
          out.push(`${where} lt target ${bk}: got ${b.series[0].target.values[j]}, oracle ${tv}`);
      }
    }
  }
  const t2 = blocks.get("t2") as TableData | undefined;
  const tableWin = t2?.window
    ? spanSql(c, t2.window)
    : c.range === "all_time"
      ? `i < ${D}`
      : "FALSE";
  for (const [id, by, names] of [
    ["t2", ["region", "plan"], TABLE2],
    ["t1", ["region"], TABLE1],
  ] as const) {
    const t = blocks.get(id) as TableData | undefined;
    if (!t) {
      out.push(`${where} ${id}: missing`);
      continue;
    }
    if (t.empty) continue;
    const win = t.window ? spanSql(c, t.window) : c.range === "all_time" ? `i < ${D}` : "FALSE";
    const plain = t.rows.filter((row) => row.kind === undefined);
    const groupsAll = await evaluate(c, names[0] as string, win, [...by], win);
    if (t.rowCount !== groupsAll.size)
      out.push(`${where} ${id}: rowCount ${t.rowCount}, oracle ${groupsAll.size}`);
    if (!c.limit || id === "t1")
      if (plain.length !== groupsAll.size)
        out.push(`${where} ${id}: ${plain.length} rows, oracle ${groupsAll.size}`);
    for (const name of names) {
      const groups = await evaluate(c, name, win, [...by], win);
      const total = await one(name, win);
      for (const row of t.rows) {
        if (row.kind === "other") continue;
        let want: number | null;
        if (row.kind === "subtotal")
          want =
            (await evaluate(c, name, win, [by[0]], win)).get(JSON.stringify([row.keys[0]])) ?? null;
        else want = groups.get(JSON.stringify(row.keys)) ?? null;
        if (!near(row.values[name], want))
          out.push(
            where +
              " " +
              id +
              " " +
              JSON.stringify(row.keys) +
              (row.kind ?? "") +
              " " +
              name +
              ": got " +
              row.values[name] +
              ", oracle " +
              want,
          );
        if (row.share && name in row.share && !row.kind) {
          const sh = want === null || total === null || total === 0 ? null : want / total;
          if (!near(row.share[name], sh))
            out.push(
              where +
                " " +
                id +
                " share " +
                JSON.stringify(row.keys) +
                " " +
                name +
                ": got " +
                row.share[name] +
                ", oracle " +
                sh,
            );
        }
      }
      if (!near(t.total?.values?.[name], total))
        out.push(
          where +
            " " +
            id +
            " total " +
            name +
            ": got " +
            t.total?.values?.[name] +
            ", oracle " +
            total,
        );
      for (const row of t.rows.filter((x) => x.kind === "other" && ++stats.other)) {
        const parent = c.subtotals && id === "t2" ? row.keys[0] : undefined;
        const shown = plain
          .filter((p) => parent === undefined || p.keys[0] === parent)
          .map((p) => JSON.stringify(p.keys));
        const folded = [...groupsAll.keys()].filter(
          (k) => !shown.includes(k) && (parent === undefined || JSON.parse(k)[0] === parent),
        );
        const restrict = folded.length
          ? "(" +
            folded
              .map(
                (k) =>
                  "(" +
                  (JSON.parse(k) as unknown[])
                    .map(
                      (v, j) =>
                        `${by[j]} IS NOT DISTINCT FROM ${v === null ? "NULL" : lit(String(v))}`,
                    )
                    .join(" AND ") +
                  ")",
              )
              .join(" OR ") +
            ")"
          : "FALSE";
        const want = (await evaluate(c, name, win, [], win, restrict)).get("[1]") ?? null;
        const got = row.values[name];
        if (got !== null && !near(got, want))
          out.push(
            where +
              " " +
              id +
              " other " +
              JSON.stringify(row.keys) +
              " " +
              name +
              ": got " +
              got +
              ", oracle " +
              want,
          );
        const m = METRICS[name] as M;
        const foldable =
          ((m.pick === "last" || m.pick === "first") && !["cd", "md"].includes(m.agg)) ||
          (m.pick === "avg" && ["sb", "sa", "n", "nb"].includes(m.agg));
        if (foldable && got === null && want !== null)
          out.push(`${where} ${id} other ${name}: null, oracle ${want}`);
      }
    }
  }
  const cats = blocks.get("cats") as BarData | undefined;
  const categories = cats?.axis.kind === "category" ? cats.axis.categories : [];
  for (const s of cats?.series ?? []) {
    const groups = await evaluate(c, s.metric, tableWin, ["plan"], tableWin);
    categories.forEach((cat, j) => {
      const want = groups.get(JSON.stringify([cat])) ?? null;
      if (!near(s.values[j], want))
        out.push(
          where +
            " cats " +
            s.metric +
            " " +
            String(cat) +
            ": got " +
            s.values[j] +
            ", oracle " +
            want,
        );
    });
  }
  const pie = blocks.get("pie") as PieData | undefined;
  if (pie && !pie.empty) {
    const win = pie.window ? spanSql(c, pie.window) : c.range === "all_time" ? `i < ${D}` : "FALSE";
    const groups = await evaluate(c, pie.metric, win, ["region"], win);
    for (const s of pie.slices) {
      const want = groups.get(JSON.stringify([s.key])) ?? null;
      if (!near(s.value, want))
        out.push(`${where} pie ${String(s.key)}: got ${s.value}, oracle ${want}`);
    }
    const total = await one(pie.metric, win);
    if (!near(pie.total, total)) out.push(`${where} pie total: got ${pie.total}, oracle ${total}`);
  }
  return out;
}

function unitBoundary(date: string, unit: string, c: Case): boolean {
  const day = new Date(ms(date));
  if (unit === "week") return WEEKDAYS[(day.getUTCDay() + 6) % 7] === c.anchors.week;
  if (day.getUTCDate() !== 1) return false;
  if (unit === "month") return true;
  const anchorMonth = Number(c.anchors.year.slice(0, 2)) - 1;
  const diff = (day.getUTCMonth() - anchorMonth + 12) % 12;
  return unit === "quarter" ? diff % 3 === 0 : diff === 0;
}

async function targetAt(c: Case, atSql: string): Promise<number | null | undefined> {
  const pts = Object.entries(c.target).sort(([a], [b]) => (a < b ? -1 : 1));
  const rows = await oracle.rows(
    "SELECT epoch_us(timezone(" +
      lit(c.tz) +
      ", " +
      atSql +
      ")) AS at, " +
      pts
        .map(([k], j) => `epoch_us(CAST(${lit(bucketEnd(k, "month"))} AS TIMESTAMP)) AS p${j}`)
        .join(", "),
  );
  const row = rows[0] as Record<string, number>;
  if (row.at === null) return undefined;
  const at = Number(row.at);
  const ps = pts.map(([, v], j) => ({ at: Number(row[`p${j}`]), v }));
  for (let j = 0; j < ps.length; j++) {
    const p = ps[j] as { at: number; v: number };
    if (at === p.at) return p.v;
    const q = ps[j + 1];
    if (q && at > p.at && at < q.at) {
      const f = (at - p.at) / (q.at - p.at);
      if (c.path === "linear") return p.v + (q.v - p.v) * f;
      return p.v * (q.v / p.v) ** f;
    }
  }
  return null;
}

function numbers(b: BlockData | undefined, skip: Set<string>): unknown[] {
  if (!b) return [];
  if (b.type === "kpi")
    return skip.has(b.metric)
      ? []
      : [
          b.value,
          b.previousValue ?? null,
          ...(b.sparkline?.buckets ?? []),
          ...(b.sparkline?.values ?? []),
          b.target?.value ?? null,
          b.target?.attainment ?? null,
        ];
  if (b.type === "table")
    return [
      ...b.rows.flatMap((r) => [
        JSON.stringify(r.keys),
        ...Object.entries(r.values)
          .filter(([k]) => !skip.has(k))
          .map(([, v]) => v),
        ...Object.values(r.share ?? {}),
      ]),
      ...Object.entries(b.total?.values ?? {})
        .filter(([k]) => !skip.has(k))
        .map(([, v]) => v),
    ];
  if (b.type === "pie")
    return skip.has(b.metric) ? [] : [...b.slices.flatMap((s) => [s.key, s.value]), b.total];
  if (b.type !== "line" && b.type !== "bar") return [];
  const series = (xs: Series[]) =>
    xs
      .filter((s) => !skip.has(s.metric))
      .flatMap((s) => [s.key, ...s.values, ...(s.target?.values ?? [])]);
  return [
    ...series(b.series ?? []),
    ...(b.series?.some((s) => skip.has(s.metric)) ? [] : (b.totals ?? [])),
    ...(b.grains?.options ?? []).flatMap((o) => [
      o.key,
      ...o.axis.buckets,
      ...series(o.series),
      ...(o.totals ?? []),
    ]),
  ];
}
function same(
  a: DashboardData | undefined,
  b: DashboardData | undefined,
  where: string,
  skip = new Set<string>(),
): string[] {
  const out: string[] = [];
  for (const block of a?.blocks ?? []) {
    const other = b?.blocks.find((x) => x.id === block.id);
    const x = numbers(block, skip);
    const y = numbers(other, skip);
    if (
      x.length !== y.length ||
      x.some((v, i) => (typeof v === "number" ? !near(v, y[i] as number) : v !== y[i]))
    )
      out.push(
        where +
          " " +
          block.id +
          ": " +
          JSON.stringify(x).slice(0, 300) +
          " vs executor " +
          JSON.stringify(y).slice(0, 300),
      );
  }
  return out;
}

function presetOnlyByRfc(): string[] {
  return Object.entries(METRICS)
    .filter(
      ([, m]) =>
        m.agg === "cd" ||
        m.agg === "md" ||
        (m.agg === "av" && ["avg", "min", "max"].includes(m.pick)),
    )
    .map(([n]) => n)
    .sort();
}

describe("snapshot over_time, independent oracle", () => {
  const seeds = ONLY.length ? ONLY : Array.from({ length: CASES }, (_, i) => FIRST + i);
  for (const seed of seeds) {
    it(`seed ${seed}`, async () => {
      cache.clear();
      const c = generate(seed);
      const { root, project: loaded, diagnostics } = await writeProject(project(c));
      expect(diagnostics.filter((d) => d.severity === "error").map((d) => d.message)).toEqual([]);
      await load(c, root);
      const executor = await createDuckDbExecutor({ root, config: loaded.config.spec as never });
      const failures: string[] = [];
      try {
        const base = await runDashboard(loaded, "d", executor);
        const bad = base.diagnostics.filter((d) => d.severity === "error" || d.code === "HM4023");
        expect(bad.map((d) => `${d.code} ${d.message}`)).toEqual([]);
        failures.push(...(await check(c, base.data, "default")));
        const periods = await runPeriodData(loaded, "d", executor, base.data as never);
        const selected = base.data?.periodFilter?.selected;
        for (const option of [c.range, c.other]) {
          const key = rangeKey(option as never);
          if (key === selected) continue;
          const preset = periods.data?.presets[key];
          if (!preset) {
            failures.push(`preset ${key}: missing`);
            continue;
          }
          stats.presets++;
          const bound = await runDashboard(loaded, "d", executor, undefined, { period: option });
          failures.push(...same(preset, bound.data, `preset ${key}`));
          failures.push(
            ...(await check(
              { ...c, range: option, compare: option === "all_time" ? "none" : c.compare },
              preset,
              `preset ${key}`,
            )),
          );
        }
        const custom = periods.data?.custom;
        if (custom) {
          const want = presetOnlyByRfc();
          const got = [...custom.presetOnly].filter((m) => METRICS[m]);
          if (JSON.stringify(got) !== JSON.stringify(want))
            failures.push(`presetOnly: got ${JSON.stringify(got)}, rfc ${JSON.stringify(want)}`);
          const r = rng(seed * 31 + 7);
          const total = Math.round((ms(custom.span.end) - ms(custom.span.start)) / DAY);
          const ranges: { start: string; end: string }[] = [];
          if (total >= 2) {
            const s = Math.floor(r() * (total - 1));
            ranges.push({
              start: addDays(custom.span.start, s),
              end: addDays(
                custom.span.start,
                s + 1 + Math.floor(r() * Math.min(120, total - s - 1)),
              ),
            });
            ranges.push({
              start: addDays(custom.span.end, -1 - Math.floor(r() * Math.min(40, total - 1))),
              end: custom.span.end,
            });
            ranges.push({ start: addDays(custom.span.end, -1), end: custom.span.end });
          }
          for (const range of ranges) {
            stats.custom++;
            const fromCube = customRangeDashboard(custom, "period", range);
            const bound = await runDashboard(loaded, "d", executor, undefined, { period: range });
            failures.push(
              ...same(
                fromCube,
                bound.data,
                `custom ${JSON.stringify(range)}`,
                new Set(custom.presetOnly),
              ),
            );
            failures.push(
              ...(await check({ ...c, range }, bound.data, `bound ${JSON.stringify(range)}`)),
            );
          }
        }
      } finally {
        await executor.close();
      }
      expect(
        failures.slice(0, 25),
        JSON.stringify({
          seed,
          tz: c.tz,
          kind: c.kind,
          cadence: c.cadence,
          asOf: c.asOf,
          range: c.range,
          other: c.other,
          grain: c.grain,
          region: c.region,
          plan: c.plan,
          seg: c.segmentOn ? c.segment : "off",
          orders: !!c.orders,
          limit: c.limit,
          subtotals: c.subtotals,
        }),
      ).toEqual([]);
    }, 120_000);
  }
});
