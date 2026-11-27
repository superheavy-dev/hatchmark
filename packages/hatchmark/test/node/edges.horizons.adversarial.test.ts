// Adopted from the HAT-67 adversarial review of hatchmark#29 (RFC 0001 section 6.5: edges,
// incomplete, HM4014). CI runs one project and periods P0, P4, P7 and P9; HM_SWEEP=full runs all.
// Hostile data in America/New_York (DST days, local-midnight rows, a lagging date source, a horizon
// exactly on a Monday midnight, a horizon inside the repeated fall-back hour) runs through the real
// engine and renderer. The oracle never calls windows.ts, the planner or the executor: rows come from
// plain SQL on the CSVs (DuckDB converts the instants to local wall-clock time), windows and buckets
// are computed here from the RFC's wording, and partial shares are wall-clock arithmetic.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DashboardData, Value } from "../../src/compiler/dashboard-data.js";
import { renderFragment } from "../../src/render/page.js";
import { PROJECT_DEFAULTS } from "../../src/spec/index.js";
import { Oracle, removeProjects, run, writeProject } from "./fixture.js";

const TZ = "America/New_York";
const DAY = 86_400_000;

type Unit = "day" | "week" | "month" | "quarter" | "year";
type Grain = { unit: Unit; anchor?: string };
type Row = { t: number; local: string; date: string; region: string | null; a: number };
type Src = { rows: Row[]; horizon: number; kind: "ts" | "date" };
type Partial = { index: number; elapsed: number; edge?: "start" };
type S = {
  key: string;
  metric: string;
  splitValue?: unknown;
  values: Value[];
  share?: Value[];
  partial?: Partial[];
};
type Axis = {
  buckets: string[];
  window: { start: string; end: string; startAt?: string; endAt?: string };
};
type Option = { key: string; axis: Axis; series: S[]; totals?: Value[] };
type Blk = {
  id: string;
  type: string;
  axis: Axis;
  series: S[];
  totals?: Value[];
  grains?: { options: Option[] };
  value?: Value;
};

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

// ---------- local time, written without the core's instants.ts ----------
const fmt = new Intl.DateTimeFormat("en-US", {
  timeZone: TZ,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});
function localOf(ms: number): string {
  const p = Object.fromEntries(fmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
}
function midnight(date: string): number {
  for (const h of [4, 5, 3, 6]) {
    const ms = Date.parse(`${date}T0${h}:00:00Z`);
    if (localOf(ms) === `${date}T00:00:00`) return ms;
  }
  throw new Error(`no midnight for ${date}`);
}
const wall = (local: string) => Date.parse(`${local.length === 10 ? `${local}T00:00:00` : local}Z`);
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const addDays = (d: string, n: number) => iso(Date.parse(`${d}T00:00:00Z`) + n * DAY);
function addMonths(d: string, n: number): string {
  const [y, m, dd] = d.split("-").map(Number) as [number, number, number];
  return iso(Date.UTC(y, m - 1 + n, dd));
}
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
function resolve(g: string | Grain): Grain {
  const grain = typeof g === "string" ? { unit: g as Unit } : g;
  if (grain.anchor !== undefined || grain.unit === "day" || grain.unit === "month") return grain;
  return { ...grain, anchor: grain.unit === "week" ? "monday" : "01-01" };
}
function bucketOf(d: string, g: Grain): string {
  if (g.unit === "day") return d;
  if (g.unit === "week") {
    const dow = new Date(`${d}T00:00:00Z`).getUTCDay();
    return addDays(d, -((dow - WEEKDAYS.indexOf(g.anchor ?? "monday") + 7) % 7));
  }
  if (g.unit === "month") return `${d.slice(0, 8)}01`;
  const step = g.unit === "quarter" ? 3 : 12;
  const y = Number(d.slice(0, 4));
  let best = "";
  for (let yy = y - 2; yy <= y; yy++) {
    for (let k = 0; k < 12; k += step) {
      const s = addMonths(`${yy}-${g.anchor}`, k);
      if (s <= d && s > best) best = s;
    }
  }
  return best;
}
function nextOf(b: string, g: Grain): string {
  if (g.unit === "day") return addDays(b, 1);
  if (g.unit === "week") return addDays(b, 7);
  return addMonths(b, g.unit === "month" ? 1 : g.unit === "quarter" ? 3 : 12);
}

// ---------- data ----------
const REGIONS = ["North America", "Europe", "Asia-Pacific", "Latin America", ""];
function ordersCsv(end: string): string {
  const rand = rng(67);
  const from = Date.parse("2025-06-01T00:00:00Z");
  const to = Date.parse(end);
  const out = ["at,region,amount"];
  for (let i = 0; i < 4000; i++) {
    const t = from + Math.floor(rand() * (to - from));
    out.push(
      new Date(t).toISOString().slice(0, 19) +
        "Z," +
        REGIONS[Math.floor(rand() * 5)] +
        "," +
        (5 + rand() * 300).toFixed(2),
    );
  }
  // local-midnight and DST edges: spring forward 2026-03-08 07:00Z, fall back 2026-11-01 06:00Z
  for (const at of [
    "2026-01-01T04:59:59Z",
    "2026-01-01T05:00:00Z",
    "2026-03-08T06:59:59Z",
    "2026-03-08T07:00:00Z",
    "2026-03-09T03:59:59Z",
    "2026-03-09T04:00:00Z",
    "2026-07-01T03:59:59Z",
    "2026-07-01T04:00:00Z",
    "2026-10-01T03:59:59Z",
    "2026-10-01T04:00:00Z",
    "2026-11-01T03:59:59Z",
    "2026-11-01T04:00:00Z",
    "2026-11-01T05:30:00Z",
    "2026-11-01T06:10:00Z",
    "2026-11-02T04:59:59Z",
    "2026-11-02T05:00:00Z",
  ]) {
    if (Date.parse(at) < to) out.push(`${at},Europe,1000.00`);
  }
  out.push(`${end.slice(0, 19)}Z,North America,77.00`);
  return `${out.join("\n")}\n`;
}
function refundsCsv(lastDay: string): string {
  const rand = rng(1067);
  const out = ["day,region,amount"];
  for (let d = "2025-06-01"; d <= lastDay; d = addDays(d, 1)) {
    if (rand() < 0.2 && d !== lastDay) continue;
    out.push(`${d},${REGIONS[Math.floor(rand() * 5)]},${(1 + rand() * 40).toFixed(2)}`);
  }
  return `${out.join("\n")}\n`;
}

// At most six grains a block: even dashboards use calendar quarters and years, odd ones shifted
// anchors (quarters from Feb 1, years from Jul 1).
const grainsFor = (pi: number): (string | Grain)[] => [
  "day",
  { unit: "week", anchor: "sunday" },
  { unit: "week", anchor: "monday" },
  "month",
  pi % 2 === 0 ? "quarter" : { unit: "quarter", anchor: "02-01" },
  pi % 2 === 0 ? "year" : { unit: "year", anchor: "07-01" },
];

type Opt = { edges?: "snap" | "clip"; incomplete?: "mark" | "hide" | "show" };
type Def = Opt & {
  id: string;
  type: "line" | "area" | "bar";
  metrics: string[];
  split?: string;
  stack?: boolean | "percent";
};
const DEFS: Def[] = [
  ...(["snap", "clip"] as const).flatMap((edges) =>
    (["mark", "hide", "show"] as const).map(
      (incomplete): Def => ({
        id: `l_${edges}_${incomplete}`,
        type: "line",
        metrics: ["revenue", "refunds"],
        edges,
        incomplete,
      }),
    ),
  ),
  { id: "l_default", type: "line", metrics: ["revenue", "refunds"] },
  {
    id: "b_stack_hide",
    type: "bar",
    metrics: ["revenue", "refunds"],
    stack: true,
    incomplete: "hide",
  },
  {
    id: "b_pct_clip_hide",
    type: "bar",
    metrics: ["revenue", "refunds"],
    stack: "percent",
    edges: "clip",
    incomplete: "hide",
  },
  { id: "b_pct_mark", type: "bar", metrics: ["revenue", "refunds"], stack: "percent" },
  {
    id: "a_split_pct_hide",
    type: "area",
    metrics: ["revenue"],
    split: "region",
    stack: "percent",
    incomplete: "hide",
  },
  {
    id: "b_split_clip_hide",
    type: "bar",
    metrics: ["refunds"],
    split: "region",
    stack: true,
    edges: "clip",
    incomplete: "hide",
  },
  { id: "l_split_hide", type: "line", metrics: ["revenue"], split: "region", incomplete: "hide" },
  { id: "b_rev_show", type: "bar", metrics: ["revenue"], incomplete: "show" },
  { id: "b_ref_clip_show", type: "bar", metrics: ["refunds"], edges: "clip", incomplete: "show" },
];

type Period = { asOf: string; range: unknown };
const PERIODS: Period[] = [
  { asOf: "latest_data", range: "last_30_days" },
  { asOf: "latest_common_data", range: "last_30_days" },
  { asOf: "latest_data", range: "quarter_to_date" },
  { asOf: "latest_common_data", range: "year_to_date" },
  { asOf: "2026-11-04", range: { start: "2026-03-05", end: "2026-11-05" } },
  { asOf: "2026-03-08", range: "last_30_days" },
  { asOf: "2026-11-01", range: { last: 90, unit: "day" } },
  { asOf: "2026-12-02", range: "month_to_date" },
  { asOf: "latest_data", range: "last_complete_month" },
  { asOf: "2026-11-25", range: "last_30_days" },
];

// Three projects: orders end mid-Wednesday, exactly at a Monday local midnight, and inside the
// repeated fall-back hour (01:30 EST, second pass).
const ALL_PROJECTS = [
  { name: "wed", ordersEnd: "2026-11-18T15:30:00Z", refundsEnd: "2026-11-12" },
  { name: "monday-midnight", ordersEnd: "2026-11-16T05:00:00Z", refundsEnd: "2026-11-10" },
  { name: "fall-back", ordersEnd: "2026-11-01T06:30:00Z", refundsEnd: "2026-10-28" },
];
const SWEEP = process.env.HM_SWEEP === "full";
const PROJECTS = SWEEP ? ALL_PROJECTS : ALL_PROJECTS.slice(0, 1);
const CI_PERIODS = [0, 4, 7, 9];

function blockSpec(d: Def, pi: number) {
  return {
    type: d.type,
    id: d.id,
    metrics: d.metrics,
    grain: { unit: "week", anchor: "sunday" },
    grains: grainsFor(pi),
    ...(d.split ? { split: d.split } : {}),
    ...(d.stack !== undefined ? { stack: d.stack } : {}),
    ...(d.edges ? { edges: d.edges } : {}),
    ...(d.incomplete ? { incomplete: d.incomplete } : {}),
  };
}

type World = {
  root: string;
  project: Awaited<ReturnType<typeof writeProject>>["project"];
  src: Record<string, Src>;
};
const worlds: Record<string, World> = {};

beforeAll(async () => {
  const oracle = await Oracle.open();
  try {
    for (const p of PROJECTS) {
      const fixture = await writeProject({
        "hatchmark.json": {
          ...PROJECT_DEFAULTS,
          name: `HAT-67 ${p.name}`,
          timezone: TZ,
          sources: {
            orders: { type: "csv", path: "orders.csv" },
            refunds: { type: "csv", path: "refunds.csv" },
          },
        },
        "orders.csv": ordersCsv(p.ordersEnd),
        "refunds.csv": refundsCsv(p.refundsEnd),
        "metrics/revenue.json": {
          label: "Revenue",
          format: { type: "number" },
          better: "up",
          type: "aggregate",
          table: "orders",
          aggregate: "sum",
          column: "amount",
          time: "at",
        },
        "metrics/refunds.json": {
          label: "Refunds",
          format: { type: "number" },
          better: "down",
          type: "aggregate",
          table: "refunds",
          aggregate: "sum",
          column: "amount",
          time: "day",
        },
        ...Object.fromEntries(
          PERIODS.map((period, pi) => [
            `dashboards/p${pi}.json`,
            {
              title: `P${pi}`,
              period: { ...period, compare: "none" },
              blocks: [
                ...DEFS.map((d) => blockSpec(d, pi)),
                { type: "kpi", id: "k_revenue", metric: "revenue" },
                { type: "kpi", id: "k_refunds", metric: "refunds" },
              ],
            },
          ]),
        ),
      });
      const o = `${fixture.root}/orders.csv`.replaceAll("'", "''");
      const r = `${fixture.root}/refunds.csv`.replaceAll("'", "''");
      const ordersRows = (await oracle.rows(
        'SELECT epoch_ms(CAST("at" AS TIMESTAMPTZ)) AS t, strftime(timezone(\'' +
          TZ +
          "', CAST(\"at\" AS TIMESTAMPTZ)), '%Y-%m-%dT%H:%M:%S') AS local, region, CAST(amount AS DOUBLE) AS a FROM read_csv('" +
          o +
          "', types={'at': 'VARCHAR', 'region': 'VARCHAR'})",
      )) as { t: number; local: string; region: string | null; a: number }[];
      const refundRows = (await oracle.rows(
        "SELECT strftime(CAST(day AS DATE), '%Y-%m-%d') AS date, region, CAST(amount AS DOUBLE) AS a FROM read_csv('" +
          r +
          "', types={'day': 'VARCHAR', 'region': 'VARCHAR'})",
      )) as { date: string; region: string | null; a: number }[];
      for (const row of ordersRows) {
        if (localOf(row.t) !== row.local)
          throw new Error(`oracle time zone mismatch ${row.t} ${row.local}`);
      }
      const lastRefund = refundRows
        .map((x) => x.date)
        .sort()
        .at(-1) as string;
      worlds[p.name] = {
        root: fixture.root,
        project: fixture.project,
        src: {
          revenue: {
            kind: "ts",
            rows: ordersRows.map((x) => ({ ...x, date: x.local.slice(0, 10) })),
            horizon: Math.max(...ordersRows.map((x) => x.t)),
          },
          refunds: {
            kind: "date",
            rows: refundRows.map((x) => ({
              ...x,
              t: midnight(x.date),
              local: `${x.date}T00:00:00`,
            })),
            horizon: midnight(addDays(lastRefund, 1)),
          },
        },
      };
    }
  } finally {
    oracle.close();
  }
}, 120_000);
afterAll(removeProjects);

// ---------- oracle ----------
type Ctx = { T: number; start: string; end: string; src: Record<string, Src> };

function context(world: World, period: Period): Ctx {
  const hs = Object.values(world.src).map((s) => s.horizon);
  const orders = world.src.revenue as Src;
  let T: number;
  if (period.asOf === "latest_data") T = Math.max(...hs);
  else if (period.asOf === "latest_common_data") T = Math.min(...hs);
  else T = midnight(addDays(period.asOf, 1));
  // T's day: the local date T falls in; an end-of-day bound (a local midnight that is not a row's
  // own instant) belongs to the day before.
  const local = localOf(T);
  const rowAtT = T === orders.horizon;
  const tDay =
    local.endsWith("T00:00:00") && !rowAtT ? addDays(local.slice(0, 10), -1) : local.slice(0, 10);
  const next = addDays(tDay, 1);
  const r = period.range;
  let start: string;
  let end = next;
  if (r === "last_30_days") start = addDays(tDay, -29);
  else if (typeof r === "object" && r !== null && "last" in r)
    start = addDays(tDay, -((r as { last: number }).last - 1));
  else if (r === "quarter_to_date") start = bucketOf(tDay, { unit: "quarter", anchor: "01-01" });
  else if (r === "year_to_date") start = `${tDay.slice(0, 4)}-01-01`;
  else if (r === "month_to_date") start = `${tDay.slice(0, 8)}01`;
  else if (r === "last_complete_month") {
    end = `${next.slice(0, 8)}01`;
    start = addMonths(end, -1);
  } else {
    const e = r as { start: string; end: string };
    start = e.start;
    end = e.end < next ? e.end : next;
  }
  return { T, start, end, src: world.src };
}

/** Measure horizon of one metric: the earliest of T and its source's horizon. */
const horizonOf = (ctx: Ctx, metric: string) => Math.min(ctx.T, (ctx.src[metric] as Src).horizon);
function included(ctx: Ctx, metric: string, row: Row): boolean {
  const src = ctx.src[metric] as Src;
  const h = horizonOf(ctx, metric);
  return h === src.horizon ? row.t <= h : row.t < h;
}

type Want = {
  buckets: string[];
  window: { start: string; end?: string };
  series: {
    key: string;
    splitValue?: unknown;
    metric: string;
    values: Value[];
    partial: Partial[];
  }[];
  totals?: Value[];
  trailingDropped: boolean;
  markPartialLast: boolean[];
};

function expected(ctx: Ctx, def: Def, g: Grain): Want {
  const clip = def.edges === "clip";
  const empty = ctx.start >= ctx.end;
  const start = clip || empty ? ctx.start : bucketOf(ctx.start, g);
  const buckets: string[] = [];
  if (!empty) for (let b = bucketOf(start, g); b < ctx.end; b = nextOf(b, g)) buckets.push(b);
  type Part = { key: string; metric: string; splitValue?: unknown; match: (r: Row) => boolean };
  const first = def.metrics[0] as string;
  const parts: Part[] = def.split
    ? [...new Set((ctx.src[first] as Src).rows.map((r) => r.region))].map((v) => ({
        key: `${first}:${v}`,
        metric: first,
        splitValue: v,
        match: (r: Row) => r.region === v,
      }))
    : def.metrics.map((m) => ({ key: m, metric: m, match: () => true }));
  const sum = (metric: string, match: (r: Row) => boolean, s: string, e: string) => {
    const from = s > start ? s : start;
    const to = e < ctx.end ? e : ctx.end;
    let total = 0;
    for (const row of (ctx.src[metric] as Src).rows) {
      if (row.date >= from && row.date < to && match(row) && included(ctx, metric, row))
        total += row.a;
    }
    return total;
  };
  const cell = (metric: string, i: number): { value: boolean; partial?: Partial } => {
    const s = buckets[i] as string;
    const e = nextOf(s, g);
    const h = horizonOf(ctx, metric);
    // a row exactly at a timestamp source's horizon still counts, so its bucket opens at elapsed 0
    const src = ctx.src[metric] as Src;
    if (midnight(s) > h || (midnight(s) === h && !(src.kind === "ts" && h === src.horizon)))
      return { value: false };
    const from = clip && i === 0 && ctx.start > s ? ctx.start : s;
    // a clipped first bucket whose part inside the window starts at or after the horizon has no value
    if (from !== s && midnight(from) >= h) return { value: false };
    const to = midnight(e) > h ? localOf(h) : e;
    if (from === s && to === e) return { value: true };
    const elapsed = Math.floor(((wall(to) - wall(from)) * 1e6) / (wall(e) - wall(s))) / 1e6;
    return {
      value: true,
      partial: { index: i, elapsed, ...(from !== s ? { edge: "start" as const } : {}) },
    };
  };
  const alive = buckets.map((_, i) => parts.some((p) => cell(p.metric, i).value));
  let series = parts.map((p) => {
    const cells = buckets.map((_, i) => cell(p.metric, i));
    return {
      key: p.key,
      metric: p.metric,
      ...(def.split ? { splitValue: p.splitValue } : {}),
      values: buckets.map(
        (s, i): Value => (cells[i]?.value ? sum(p.metric, p.match, s, nextOf(s, g)) : null),
      ),
      partial: cells.flatMap((c) => (c.partial ? [c.partial] : [])),
    };
  });
  const markPartialLast = series.map((s) => {
    const last = s.values.findLastIndex((v) => v !== null);
    return s.partial.some((p) => p.index === last);
  });
  let totals: Value[] | undefined;
  if (def.stack) {
    totals = buckets.map((s, i) => {
      if (def.split) return cell(first, i).value ? sum(first, () => true, s, nextOf(s, g)) : null;
      const vs = series.map((x) => x.values[i] ?? null);
      return vs.some((v) => v === null) ? null : (vs as number[]).reduce((a, b) => a + b, 0);
    });
  }
  let kept = buckets;
  let window: { start: string; end?: string } = { start };
  let trailingDropped = false;
  if (def.incomplete === "hide") {
    const hiddenAt = new Set(series.flatMap((s) => s.partial.map((p) => p.index)));
    series = series.map((s) => {
      const cut = new Set(s.partial.map((p) => p.index));
      return { ...s, values: s.values.map((v, i) => (cut.has(i) ? null : v)), partial: [] };
    });
    if (totals) totals = totals.map((v, i) => (hiddenAt.has(i) ? null : v));
    // leading buckets go when partial and then empty; trailing ones when empty and partial or past
    // every series' horizon, so the axis ends on the kept buckets
    const empty = (i: number) => series.every((s) => s.values[i] === null);
    let lo = 0;
    while (lo < buckets.length && hiddenAt.has(lo) && empty(lo)) lo++;
    let hi = buckets.length;
    while (hi > lo && (hiddenAt.has(hi - 1) || !alive[hi - 1]) && empty(hi - 1)) hi--;
    trailingDropped = hi < buckets.length;
    kept = buckets.slice(lo, hi);
    const first = lo > 0 && lo < hi ? (buckets[lo] as string) : start;
    window = {
      start: first,
      ...(lo === hi ? { end: first } : trailingDropped ? { end: buckets[hi] as string } : {}),
    };
    series = series.map((s) => ({ ...s, values: s.values.slice(lo, hi) }));
    if (totals) totals = totals.slice(lo, hi);
  } else if (def.incomplete === "show") {
    series = series.map((s) => ({ ...s, partial: [] }));
  }
  return {
    buckets: kept,
    window,
    series,
    ...(totals ? { totals } : {}),
    trailingDropped,
    markPartialLast,
  };
}

const close = (a: Value | undefined, b: Value | undefined) =>
  a === b ||
  (typeof a === "number" &&
    typeof b === "number" &&
    Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(b)));

function compare(where: string, got: Option, want: Want, def: Def): string[] {
  const bad: string[] = [];
  if (JSON.stringify(got.axis.buckets) !== JSON.stringify(want.buckets)) {
    bad.push(
      where +
        " buckets " +
        got.axis.buckets[0] +
        ".." +
        got.axis.buckets.at(-1) +
        " (" +
        got.axis.buckets.length +
        ") != " +
        want.buckets[0] +
        ".." +
        want.buckets.at(-1) +
        " (" +
        want.buckets.length +
        ")",
    );
    return bad;
  }
  if (got.axis.window.start !== want.window.start)
    bad.push(`${where} window.start ${got.axis.window.start} != ${want.window.start}`);
  if (
    want.window.end !== undefined &&
    (got.axis.window.end !== want.window.end || got.axis.window.endAt !== undefined)
  )
    bad.push(`${where} window ${JSON.stringify(got.axis.window)} != end ${want.window.end}`);
  for (const w of want.series) {
    const s = got.series.find((x) =>
      def.split ? x.splitValue === w.splitValue : x.metric === w.metric,
    );
    if (s === undefined) {
      if (w.values.some((v) => v !== null && v !== 0)) bad.push(`${where} ${w.key} missing`);
      continue;
    }
    w.values.forEach((v, i) => {
      const g = s.values[i];
      if (!(close(g, v) || (def.split && v === 0 && g === null)))
        bad.push(`${where} ${w.key}[${want.buckets[i]}] ${g} != ${v}`);
    });
    const round = (ps: Partial[]) =>
      JSON.stringify(ps.map((p) => ({ ...p, elapsed: Math.round(p.elapsed * 1e5) })));
    if (round(s.partial ?? []) !== round(w.partial))
      bad.push(
        where +
          " " +
          w.key +
          " partial " +
          JSON.stringify(s.partial ?? []) +
          " != " +
          JSON.stringify(w.partial),
      );
    if (want.totals && def.stack === "percent") {
      s.values.forEach((v, i) => {
        const total = want.totals?.[i] ?? null;
        const share = v === null || total === null || total === 0 ? null : v / total;
        const gs = s.share?.[i] ?? null;
        if (!close(gs, share) && !(def.split && share === 0 && gs === null))
          bad.push(`${where} ${w.key} share[${want.buckets[i]}] ${gs} != ${share}`);
      });
    }
  }
  if (want.totals) {
    want.totals.forEach((v, i) => {
      if (!close(got.totals?.[i] ?? null, v))
        bad.push(`${where} total[${want.buckets[i]}] ${got.totals?.[i]} != ${v}`);
    });
  }
  return bad;
}

/** KPI windows are whole local days ending at the last complete day and are never snapped. */
function kpiExpected(ctx: Ctx, metric: string): Value {
  const h = horizonOf(ctx, metric);
  let lastEnd = localOf(h).slice(0, 10);
  if (midnight(lastEnd) > h) lastEnd = addDays(lastEnd, -1);
  const end = lastEnd < ctx.end ? lastEnd : ctx.end;
  if (ctx.start >= end) return null;
  let total = 0;
  for (const row of (ctx.src[metric] as Src).rows) {
    if (row.date >= ctx.start && row.date < end && included(ctx, metric, row)) total += row.a;
  }
  return total;
}

export const observations: string[] = [];

for (const p of PROJECTS) {
  describe(`edges and incomplete against the oracle, orders end ${p.name}`, () => {
    PERIODS.forEach((period, pi) => {
      if (!SWEEP && !CI_PERIODS.includes(pi)) return;
      it(`P${pi} ${period.asOf} ${JSON.stringify(period.range)}`, async () => {
        const world = worlds[p.name] as World;
        const result = await run(world.root, world.project, `p${pi}`);
        expect(
          result.diagnostics
            .filter((d) => d.severity === "error")
            .map((d) => `${d.code} ${d.message}`),
        ).toEqual([]);
        const data = result.data as DashboardData;
        const ctx = context(world, period);
        const bad: string[] = [];
        const blocks = data.blocks as unknown as Blk[];
        for (const [di, def] of DEFS.entries()) {
          const b = blocks.find((x) => x.id === def.id);
          if (b === undefined) {
            bad.push(`${def.id} missing`);
            continue;
          }
          const options = b.grains?.options ?? [];
          const sweep = grainsFor(pi).map(resolve);
          if (options.length !== sweep.length)
            bad.push(`${def.id} has ${options.length} grain options`);
          let warn = false;
          sweep.forEach((g, gi) => {
            const o = options[gi];
            if (o === undefined) return;
            const want = expected(ctx, def, g);
            bad.push(...compare(`${def.id}/${o.key}`, o, want, def));
            if (
              def.incomplete === "show" &&
              expected(ctx, { ...def, incomplete: "mark" }, g).markPartialLast.some(Boolean)
            )
              warn = true;
            if (
              def.incomplete === "hide" &&
              !want.trailingDropped &&
              want.series.length > 0 &&
              want.series.every((s) => s.values.at(-1) === null)
            )
              observations.push(
                p.name +
                  " P" +
                  pi +
                  " " +
                  def.id +
                  "/" +
                  o.key +
                  ": hide keeps trailing empty buckets, axis ends " +
                  o.axis.window.end,
              );
          });
          const selected = options[1];
          if (selected && JSON.stringify(selected.axis) !== JSON.stringify(b.axis))
            bad.push(`${def.id} top-level axis differs from its selected grain`);
          const has = result.diagnostics.some(
            (d) => d.code === "HM4014" && d.pointer === `/blocks/${di}/incomplete`,
          );
          if (has !== warn) bad.push(`${def.id} HM4014 ${has} != ${warn}`);
        }
        const r = period.range;
        if (!(r === "last_30_days" || (typeof r === "object" && r !== null && "last" in r))) {
          for (const metric of ["revenue", "refunds"]) {
            const k = blocks.find((x) => x.id === `k_${metric}`);
            const want = kpiExpected(ctx, metric);
            if (!close(k?.value ?? null, want)) bad.push(`k_${metric} ${k?.value} != ${want}`);
          }
        }
        expect(() => renderFragment(data)).not.toThrow();
        expect(bad.slice(0, 30)).toEqual([]);
      }, 60_000);
    });
  });
}

// The blocker repro: a realistic latest_data dashboard where one source lags past the window start.
// Orders run through Dec 2, 2026 and refunds through Nov 25, so month_to_date is Dec 1 to Dec 2 and
// refunds' own horizon (end of Nov 25) is before the window starts.
describe("a source whose horizon is before the window start (HAT-67 blockers)", () => {
  const days = (from: string, to: string) => {
    const out: string[] = [];
    for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
    return out;
  };
  async function lagging(
    block: Record<string, unknown>,
    period: Record<string, unknown> = { asOf: "latest_data", range: "month_to_date" },
  ) {
    const f = await writeProject({
      "hatchmark.json": {
        ...PROJECT_DEFAULTS,
        name: "Lagging",
        timezone: "UTC",
        sources: {
          orders: { type: "csv", path: "orders.csv" },
          refunds: { type: "csv", path: "refunds.csv" },
        },
      },
      "orders.csv":
        "day,v\n" +
        days("2026-09-01", "2026-12-02")
          .map((d) => `${d},1`)
          .join("\n") +
        "\n",
      "refunds.csv":
        "day,v\n" +
        days("2026-09-01", "2026-11-25")
          .map((d) => `${d},1`)
          .join("\n") +
        "\n",
      "metrics/orders.json": {
        label: "Orders",
        format: { type: "number" },
        better: "up",
        type: "aggregate",
        table: "orders",
        aggregate: "sum",
        column: "v",
        time: "day",
      },
      "metrics/refunds.json": {
        label: "Refunds",
        format: { type: "number" },
        better: "down",
        type: "aggregate",
        table: "refunds",
        aggregate: "sum",
        column: "v",
        time: "day",
      },
      "dashboards/d.json": {
        title: "D",
        period: { ...period, compare: "none" },
        blocks: [
          { type: "line", id: "l", metrics: ["orders", "refunds"], grain: "quarter", ...block },
        ],
      },
    });
    const { data, diagnostics } = await run(f.root, f.project, "d");
    const l = data?.blocks[0] as unknown as Blk;
    return {
      l,
      refunds: l.series.find((s) => s.metric === "refunds") as S,
      codes: diagnostics.map((d) => d.code),
    };
  }

  it("snap: the snapped quarter shows refunds' Oct 1 to Nov 25 rows, not 0", async () => {
    const { l, refunds } = await lagging({});
    expect(l.axis.buckets).toEqual(["2026-10-01"]);
    expect(l.axis.window.start).toBe("2026-10-01");
    expect(l.series.find((s) => s.metric === "orders")?.values).toEqual([63]);
    expect(refunds.values).toEqual([56]);
  });

  it("clip: refunds have no value in a window that starts after their horizon, and no negative elapsed", async () => {
    const { refunds } = await lagging({ edges: "clip" });
    expect(refunds.values).toEqual([null]);
    expect((refunds.partial ?? []).every((p) => p.elapsed >= 0 && p.elapsed <= 1)).toBe(true);
  });

  it("clip with hide: a window with no value in any series keeps no bucket", async () => {
    const { l } = await lagging({ edges: "clip", incomplete: "hide", metrics: ["refunds"] });
    expect(l.axis.buckets).toEqual([]);
  });

  it("clip with show: no HM4014 for a series with no value (as of a day after refunds end)", async () => {
    const { codes, refunds } = await lagging(
      { edges: "clip", incomplete: "show", metrics: ["refunds"] },
      { asOf: "2026-12-02", range: "month_to_date" },
    );
    expect(refunds.values).toEqual([null]);
    expect(codes).not.toContain("HM4014");
  });

  it("clip with show and latest_data from refunds alone: the partial quarter warns", async () => {
    const { codes, refunds } = await lagging({
      edges: "clip",
      incomplete: "show",
      metrics: ["refunds"],
    });
    expect(refunds.values).toEqual([25]);
    expect(codes).toContain("HM4014");
  });

  it("show with a window ending mid-bucket before the horizon: the last bucket is whole, no HM4014", async () => {
    const { codes, l } = await lagging(
      { incomplete: "show", grain: { unit: "week", anchor: "sunday" } },
      { asOf: "2026-11-20", range: { start: "2026-10-01", end: "2026-10-14" } },
    );
    expect(l.axis.buckets.at(-1)).toBe("2026-10-11");
    expect(l.series.every((s) => (s.partial ?? []).length === 0)).toBe(true);
    expect(codes).not.toContain("HM4014");
  });
});

describe("observations", () => {
  it("lists hide axes that end on empty buckets (printed with HM_EDGES_PRINT=1)", () => {
    if (process.env.HM_EDGES_PRINT) console.log(observations.join("\n"));
    expect(observations.length).toBeGreaterThanOrEqual(0);
  });
});
