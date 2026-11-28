import path from "node:path";
import type {
  BarData,
  DashboardData,
  KpiData,
  LineData,
  Series,
  TableData,
  TimeAxis,
} from "../../src/compiler/dashboard-data.js";
import { Oracle } from "./fixture.js";

export type Key = string | number | boolean | null;
export type Row = {
  t: number | null;
  d: string | null;
  region: string | null;
  channel: string | null;
  country: string | null;
  category: string | null;
  status: string | null;
  c: string | null;
  a: number | null;
};
export type Anchors = { week: string; quarter: string; year: string };
export type Grain = { unit: string; anchor?: string };
export type GrainSpec = string | Grain;
export type Window = [string, string];
export type SpecBlock = {
  type: string;
  id: string;
  metric?: string;
  metrics?: string[];
  sparkline?: boolean;
  grain?: GrainSpec;
  grains?: GrainSpec[];
  split?: string;
  by?: string | string[];
  sort?: { by: string; order: "asc" | "desc" };
  limit?: number;
  percentOfTotal?: string[];
};

export async function readRows(root: string, timeZone = "America/New_York"): Promise<Row[]> {
  const oracle = await Oracle.open();
  try {
    const file = path.join(root, "data/orders.csv").replaceAll("'", "''");
    const raw = await oracle.rows(
      `SELECT ordered_at AS t, region, channel, country, category, status, customer_id AS c, amount AS a FROM read_csv('${file}', all_varchar = true)`,
    );
    const local = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    return raw.map((r) => ({
      t: r.t === null ? null : Date.parse(r.t as string),
      d: r.t === null ? null : local.format(new Date(r.t as string)),
      region: r.region as string | null,
      channel: r.channel as string | null,
      country: r.country as string | null,
      category: r.category as string | null,
      status: r.status as string | null,
      c: r.c as string | null,
      a: r.a === null ? null : Number(r.a),
    }));
  } finally {
    oracle.close();
  }
}

const DAY = 86_400_000;
const ms = (d: string) => Date.parse(`${d}T00:00:00Z`);
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
const pad = (n: number) => String(n).padStart(2, "0");
export const addDays = (d: string, n: number) => iso(ms(d) + n * DAY);
export const daysBetween = (a: string, b: string) => Math.round((ms(b) - ms(a)) / DAY);
export function addMonths(d: string, n: number): string {
  const [y = 0, m = 1, dd = 1] = d.split("-").map(Number);
  const index = y * 12 + (m - 1) + n;
  const ty = Math.floor(index / 12);
  const tm = index - ty * 12;
  const last = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
  return `${ty}-${pad(tm + 1)}-${pad(Math.min(dd, last))}`;
}
export function addUnits(d: string, unit: string, n: number): string {
  if (unit === "day") return addDays(d, n);
  if (unit === "week") return addDays(d, 7 * n);
  return addMonths(d, n * (unit === "quarter" ? 3 : unit === "year" ? 12 : 1));
}

const SUNDAY_FIRST = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
export function resolveGrain(g: GrainSpec | undefined, anchors: Anchors): Grain {
  const unit = typeof g === "string" ? g : (g?.unit ?? "month");
  const own = typeof g === "string" ? undefined : g?.anchor;
  if (unit === "day" || unit === "month") return { unit };
  return { unit, anchor: own ?? anchors[unit as keyof Anchors] };
}
export const grainKey = (g: Grain) => (g.anchor ? `${g.unit}:${g.anchor}` : g.unit);

export function bucket(d: string, g: Grain): string {
  if (g.unit === "day") return d;
  if (g.unit === "month") return `${d.slice(0, 8)}01`;
  if (g.unit === "week") {
    const back = (new Date(ms(d)).getUTCDay() - SUNDAY_FIRST.indexOf(g.anchor as string) + 7) % 7;
    return addDays(d, -back);
  }
  const step = g.unit === "quarter" ? 3 : 12;
  const y = Number(d.slice(0, 4));
  let best = "";
  for (let yy = y - 1; yy <= y; yy++) {
    for (let k = 0; k < 12; k += step) {
      const s = addMonths(`${yy}-${g.anchor}`, k);
      if (s <= d && s > best) best = s;
    }
  }
  return best;
}
export function spine(w: Window, g: Grain): string[] {
  const out: string[] = [];
  for (let d = w[0]; d < w[1]; d = addDays(d, 1)) {
    const b = bucket(d, g);
    if (out.at(-1) !== b) out.push(b);
  }
  return out;
}

export type Range =
  | string
  | { start: string; end: string }
  | { last: number; unit: string }
  | { to_date: string }
  | { last_complete: string };
const NAMED: Record<string, Range> = {
  last_7_days: { last: 7, unit: "day" },
  last_30_days: { last: 30, unit: "day" },
  last_90_days: { last: 90, unit: "day" },
  last_12_months: { last: 12, unit: "month" },
  month_to_date: { to_date: "month" },
  quarter_to_date: { to_date: "quarter" },
  year_to_date: { to_date: "year" },
  last_complete_month: { last_complete: "month" },
  last_complete_quarter: { last_complete: "quarter" },
  last_complete_year: { last_complete: "year" },
};

function shift(w: Window, unit: string, n: number): Window {
  const whole = unit !== "day" && unit !== "week" && w[0].endsWith("-01") && w[1].endsWith("-01");
  return whole
    ? [addUnits(w[0], unit, n), addUnits(w[1], unit, n)]
    : [addUnits(w[0], unit, n), addDays(addUnits(addDays(w[1], -1), unit, n), 1)];
}

export function windows(
  range: Range,
  asOf: string,
  anchors: Anchors,
  compare: "previous_period" | "previous_year" = "previous_period",
): { current: Window; previous: Window } {
  if (compare === "previous_year") {
    const { current } = windows(range, asOf, anchors);
    return { current, previous: shift(current, "year", -1) };
  }
  const spec = typeof range === "string" ? (NAMED[range] as Range) : range;
  if (typeof spec === "string") throw new Error(`unknown range ${spec}`);
  if ("start" in spec) {
    const n = daysBetween(spec.start, spec.end);
    return { current: [spec.start, spec.end], previous: [addDays(spec.start, -n), spec.start] };
  }
  const next = addDays(asOf, 1);
  if ("last_complete" in spec) {
    const unit = spec.last_complete;
    const own = bucket(asOf, resolveGrain(unit, anchors));
    const s = addUnits(own, unit, 1) === next ? own : addUnits(own, unit, -1);
    return { current: [s, addUnits(s, unit, 1)], previous: [addUnits(s, unit, -1), s] };
  }
  if ("last" in spec && spec.unit === "day") {
    const s = addDays(next, -spec.last);
    return { current: [s, next], previous: [addDays(s, -spec.last), s] };
  }
  const unit = "last" in spec ? spec.unit : spec.to_date;
  const count = "last" in spec ? spec.last : 1;
  const s = addUnits(bucket(asOf, resolveGrain(unit, anchors)), unit, -(count - 1));
  return { current: [s, next], previous: shift([s, next], unit, -count) };
}

export type Horizon = { asOf: string; us: bigint; cut: string; at: bigint; timeZone: string };
export function horizonOf(rows: Row[], asOf: string, timeZone = "America/New_York"): Horizon {
  const newest = rows.reduce((m, r) => (r.t !== null && r.t > m ? r.t : m), -Infinity);
  const source = BigInt(newest) * 1000n + 1n;
  const day = iso(Number(wallOf(source, timeZone) / 1000n));
  const date = asOf === "latest_data" ? day : asOf;
  const end = fromWall(naive(addDays(date, 1)), timeZone);
  const at = source < end ? source : end;
  const us = wallOf(at, timeZone);
  return { asOf: date, us, cut: iso(Number(us / 1000n)), at, timeZone };
}
function wallOf(at: bigint, timeZone: string): bigint {
  const t = Number(at / 1000n);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date(t))
      .map((p) => [p.type, Number(p.value)]),
  ) as Record<string, number>;
  const localMs = Date.UTC(
    parts.year ?? 0,
    (parts.month ?? 1) - 1,
    parts.day ?? 1,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return BigInt(localMs) * 1000n + (at % 1_000_000n);
}

// Matches DuckDB: a wall time repeated by a fall-back is its later occurrence, and one skipped by
// a spring-forward takes the offset before the change.
function fromWall(wall: bigint, timeZone: string): bigint {
  const offset = (at: bigint) => wallOf(at, timeZone) - at;
  const before = wall - offset(wall - DAY_US);
  const after = wall - offset(wall + DAY_US);
  const fits = [before, after].filter((at) => wallOf(at, timeZone) === wall);
  return fits.at(-1) ?? before;
}
const instantText = (at: bigint) =>
  `${new Date(Number(at / 1000n)).toISOString().slice(0, 19)}.${String(at % 1_000_000n).padStart(6, "0")}Z`;
const instantOf = (text: string) =>
  BigInt(Date.parse(`${text.slice(0, 19)}Z`)) * 1000n + BigInt(text.slice(20, 26));
const naive = (d: string) => BigInt(ms(d)) * 1000n;
function wallText(us: bigint): string {
  const t = new Date(Number(us / 1000n)).toISOString();
  return `${t.slice(0, 19)}.${String(us % 1_000_000n).padStart(6, "0")}`;
}

export function ended(
  range: Range,
  h: Horizon,
  anchors: Anchors,
  compare: "previous_period" | "previous_year" = "previous_period",
): { current: Window; previous: Window } {
  const full = windows(range, h.asOf, anchors, compare);
  const [s, e] = full.current;
  if (h.cut >= e) return full;
  const spec = typeof range === "string" ? (NAMED[range] as Exclude<Range, string>) : range;
  if (typeof spec !== "string" && "last" in spec) {
    const n = daysBetween(s, e);
    const current: Window = [addDays(h.cut, -n), h.cut];
    return {
      current,
      previous:
        compare === "previous_year"
          ? shift(current, "year", -1)
          : [addDays(current[0], -n), current[0]],
    };
  }
  const [ps, pe] = full.previous;
  if (typeof spec !== "string" && "to_date" in spec) {
    if (h.us <= naive(s)) return { current: [s, s], previous: [ps, ps] };
    const midnight = (wall: bigint) => wall % DAY_US === 0n;
    const cut = naive(ps) + (h.us - naive(s));
    return {
      current: [s, midnight(h.us) ? h.cut : instantText(h.at)],
      previous:
        cut >= naive(pe)
          ? full.previous
          : [ps, midnight(cut) ? iso(Number(cut / 1000n)) : instantText(fromWall(cut, h.timeZone))],
    };
  }
  const current: Window = [s, [s, h.cut].sort()[1] as string];
  const pend = addDays(ps, daysBetween(current[0], current[1]));
  return { current, previous: [ps, [pend, pe].sort()[0] as string] };
}

const paid = (rs: Row[]) => rs.filter((r) => r.status === "paid");
const sum = (rs: Row[]) => rs.reduce((s, r) => s + (r.a ?? 0), 0);
const amounts = (rs: Row[]) => paid(rs).flatMap((r) => (r.a === null ? [] : [r.a]));
const divide = (a: number | null, b: number | null) => (a === null || !b ? null : a / b);
function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}
export const METRICS: Record<string, (rs: Row[]) => number | null> = {
  revenue: (rs) => sum(paid(rs)),
  orders: (rs) => paid(rs).length,
  placed_orders: (rs) => rs.length,
  refunded_orders: (rs) => rs.filter((r) => r.status === "refunded").length,
  customers: (rs) => new Set(paid(rs).flatMap((r) => (r.c === null ? [] : [r.c]))).size,
  avg_order_value: (rs) => (paid(rs).length ? sum(paid(rs)) / paid(rs).length : null),
  refund_rate: (rs) =>
    rs.length ? rs.filter((r) => r.status === "refunded").length / rs.length : null,
  avg_amount: (rs) =>
    divide(
      amounts(rs).reduce((s, a) => s + a, 0),
      amounts(rs).length,
    ),
  min_amount: (rs) => (amounts(rs).length ? Math.min(...amounts(rs)) : null),
  max_amount: (rs) => (amounts(rs).length ? Math.max(...amounts(rs)) : null),
  median_amount: (rs) => median(amounts(rs)),
  net_sql: (rs) => (rs.length ? amounts(rs).reduce((s, a) => s + a, 0) : null),
  spread_sql: (rs) =>
    amounts(rs).length ? Math.max(...amounts(rs)) - Math.min(...amounts(rs)) : null,
  rev_per_customer: (rs) => divide(metricOf("revenue", rs), metricOf("customers", rs)),
  orders_per_rpc: (rs) => divide(metricOf("orders", rs), metricOf("rev_per_customer", rs)),
  spread_per_order: (rs) => divide(metricOf("spread_sql", rs), metricOf("orders", rs)),
};
export const PERCENT = new Set(["refund_rate"]);
export const metricOf = (name: string, rs: Row[]) =>
  (METRICS[name] as (rs: Row[]) => number | null)(rs);
export const inWindow = (rows: Row[], w: Window) => {
  const end = w[1].endsWith("Z") ? instantOf(w[1]) : undefined;
  return rows.filter(
    (r) =>
      r.d !== null &&
      r.d >= w[0] &&
      (end === undefined ? r.d < w[1] : BigInt(r.t as number) * 1000n < end),
  );
};
const col = (r: Row, c: string) => (r as unknown as Record<string, Key>)[c] ?? null;

export class Diff {
  cells = 0;
  problems: string[] = [];
  num(where: string, got: unknown, want: number | null): void {
    this.cells++;
    if (want === null) {
      if (got !== null) this.problems.push(`${where}: got ${got} want null`);
      return;
    }
    if (typeof got !== "number" || Math.abs(got - want) > 1e-9 * Math.max(1, Math.abs(want)))
      this.problems.push(`${where}: got ${got} want ${want}`);
  }
  same(where: string, got: unknown, want: unknown): void {
    this.cells++;
    if (JSON.stringify(got) !== JSON.stringify(want))
      this.problems.push(`${where}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
  }
}

export type Context = {
  rows: Row[];
  range: Range;
  horizon: Horizon;
  compare?: "previous_period" | "previous_year";
  anchors: Anchors;
  grainDefault?: GrainSpec;
  presetOnly?: Set<string>;
};
type Resolved = Context & {
  current: Window;
  previous: Window;
  kpi: { current: Window; previous: Window };
  empty?: "no_complete_day" | "no_data";
};
const span = (w: Window, timeZone: string) => {
  if (!w[1].endsWith("Z")) return { start: w[0], end: w[1] };
  const wall = wallOf(instantOf(w[1]), timeZone);
  return { start: w[0], end: addDays(iso(Number(wall / 1000n)), 1), endAt: wallText(wall) };
};
const snapped = (w: Window, g: Grain): Window => (w[0] < w[1] ? [bucket(w[0], g), w[1]] : w);
const blind = (ctx: Resolved, m: string) => ctx.presetOnly?.has(m) === true;

export function checkDashboard(
  data: DashboardData,
  blocks: SpecBlock[],
  context: Context,
  diff = new Diff(),
): Diff {
  const full = windows(context.range, context.horizon.asOf, context.anchors, context.compare);
  const kpi = ended(context.range, context.horizon, context.anchors, context.compare);
  const [ks, ke] = kpi.current;
  const ctx: Resolved = {
    ...context,
    ...full,
    kpi,
    ...(ks < ke ? {} : { empty: context.horizon.us > naive(ks) ? "no_complete_day" : "no_data" }),
  };
  diff.same("asOf", data.asOf, ctx.horizon.asOf);
  diff.same("period.current", data.period.current, span(ctx.current, ctx.horizon.timeZone));
  diff.same("period.previous", data.period.previous, span(ctx.previous, ctx.horizon.timeZone));
  const cur = inWindow(ctx.rows, ctx.kpi.current);
  for (const sb of blocks) {
    const b = data.blocks.find((x) => x.id === sb.id);
    if (b === undefined) {
      diff.problems.push(`${sb.id}: missing`);
      continue;
    }
    if (sb.type === "kpi") checkKpi(b as KpiData, sb, ctx, cur, diff);
    else if (sb.type === "table") checkTable(b as TableData, sb, ctx, cur, diff);
    else if (sb.type === "bar" && sb.by !== undefined) checkBar(b as BarData, sb, ctx, cur, diff);
    else checkTime(b as LineData, sb, ctx, diff);
  }
  return diff;
}

function checkKpi(b: KpiData, sb: SpecBlock, ctx: Resolved, cur: Row[], diff: Diff): void {
  const m = sb.metric as string;
  const at = `${sb.id}`;
  diff.same(`${at}.current`, b.current, span(ctx.kpi.current, ctx.horizon.timeZone));
  diff.same(`${at}.previous`, b.previous, span(ctx.kpi.previous, ctx.horizon.timeZone));
  diff.same(`${at}.empty`, b.empty, ctx.empty);
  if (blind(ctx, m) || ctx.empty) {
    if (ctx.empty) diff.num(`${at}.changePct`, b.changePct, null);
    diff.same(`${at}.presetOnly`, b.presetOnly, blind(ctx, m) ? true : undefined);
    diff.num(`${at}.value`, b.value, null);
    diff.num(`${at}.previousValue`, b.previousValue, null);
    diff.num(`${at}.change`, b.change, null);
  } else {
    diff.same(`${at}.presetOnly`, b.presetOnly, undefined);
    const v = metricOf(m, cur);
    const p = metricOf(m, inWindow(ctx.rows, ctx.kpi.previous));
    const change = v === null || p === null ? null : v - p;
    diff.num(`${at}.value`, b.value, v);
    diff.num(`${at}.previousValue`, b.previousValue, p);
    diff.num(`${at}.change`, b.change, change);
    const points = PERCENT.has(m);
    diff.same(`${at}.changeKind`, b.changeKind, points ? "points" : "relative");
    diff.num(
      `${at}.changePct`,
      b.changePct,
      points ? change : change === null || !p ? null : change / Math.abs(p),
    );
  }
  if (sb.sparkline) {
    const g = { unit: "month" };
    const win = snapped(ctx.current, g);
    const buckets = spine(win, g);
    const series = inWindow(ctx.rows, win);
    diff.same(`${at}.sparkline.buckets`, b.sparkline?.buckets, buckets);
    diff.same(`${at}.sparkline.partial`, b.sparkline?.partial, partialOf(buckets, g, ctx.horizon));
    buckets.forEach((x, i) => {
      diff.num(
        `${at}.sparkline ${x}`,
        b.sparkline?.values[i],
        blind(ctx, m) || naive(x) >= ctx.horizon.us
          ? null
          : metricOf(
              m,
              series.filter((r) => bucket(r.d as string, g) === x),
            ),
      );
    });
  }
}

const desc = (a: number | null, b: number | null) =>
  a === null || b === null ? true : a >= b - 1e-9 * Math.max(1, Math.abs(b));

function checkTop(
  at: string,
  shown: Key[][],
  all: Key[][],
  score: (k: Key[]) => number | null,
  order: "asc" | "desc",
  limit: number | undefined,
  diff: Diff,
): void {
  diff.same(`${at}.count`, shown.length, Math.min(all.length, limit ?? Infinity));
  const sign = order === "desc" ? 1 : -1;
  const s = (k: Key[]) => {
    const v = score(k);
    return v === null ? null : sign * v;
  };
  for (let i = 1; i < shown.length; i++) {
    if (!desc(s(shown[i - 1] as Key[]), s(shown[i] as Key[])))
      diff.problems.push(
        `${at}: ${JSON.stringify(shown[i - 1])} sorted before ${JSON.stringify(shown[i])}`,
      );
  }
  const ids = new Set(all.map((k) => JSON.stringify(k)));
  const shownIds = new Set(shown.map((k) => JSON.stringify(k)));
  for (const k of shown)
    if (!ids.has(JSON.stringify(k))) diff.problems.push(`${at}: bogus group ${JSON.stringify(k)}`);
  const lowest = shown.at(-1);
  for (const k of all) {
    if (shownIds.has(JSON.stringify(k)) || lowest === undefined) continue;
    if (!desc(s(lowest), s(k)))
      diff.problems.push(
        `${at}: omitted ${JSON.stringify(k)} beats shown ${JSON.stringify(lowest)}`,
      );
  }
}

function groups(rows: Row[], by: string[]): Map<string, { keys: Key[]; rows: Row[] }> {
  const out = new Map<string, { keys: Key[]; rows: Row[] }>();
  for (const r of rows) {
    const keys = by.map((c) => col(r, c));
    const id = JSON.stringify(keys);
    const g = out.get(id) ?? { keys, rows: [] };
    g.rows.push(r);
    out.set(id, g);
  }
  return out;
}

function checkBar(b: BarData, sb: SpecBlock, ctx: Resolved, cur: Row[], diff: Diff): void {
  const by = sb.by as string;
  const all = groups(cur, [by]);
  const cats = b.axis.kind === "category" ? b.axis.categories : [];
  const sort = sb.sort ?? { by: (sb.metrics as string[])[0] as string, order: "desc" as const };
  checkTop(
    sb.id,
    cats.map((c) => [c]),
    [...all.values()].map((g) => g.keys),
    (k) => metricOf(sort.by, all.get(JSON.stringify(k))?.rows ?? []),
    sort.order,
    sb.limit,
    diff,
  );
  diff.same(
    `${sb.id}.omittedCategories`,
    b.omittedCategories ?? 0,
    Math.max(0, all.size - cats.length),
  );
  for (const s of b.series) {
    cats.forEach((c, i) => {
      const rs = all.get(JSON.stringify([c]))?.rows ?? [];
      diff.num(
        `${sb.id} ${s.metric} ${c}`,
        s.values[i],
        blind(ctx, s.metric) ? null : metricOf(s.metric, rs),
      );
    });
  }
}

function checkTable(b: TableData, sb: SpecBlock, ctx: Resolved, cur: Row[], diff: Diff): void {
  const by = sb.by as string[];
  const metrics = sb.metrics as string[];
  const all = groups(cur, by);
  const sort = sb.sort ?? { by: metrics[0] as string, order: "desc" as const };
  checkTop(
    sb.id,
    b.rows.map((r) => r.keys),
    [...all.values()].map((g) => g.keys),
    (k) => metricOf(sort.by, all.get(JSON.stringify(k))?.rows ?? []),
    sort.order,
    sb.limit,
    diff,
  );
  diff.same(`${sb.id}.rowCount`, b.rowCount, all.size);
  diff.same(
    `${sb.id}.window`,
    b.window,
    ctx.empty ? undefined : span(ctx.kpi.current, ctx.horizon.timeZone),
  );
  diff.same(`${sb.id}.empty`, b.empty, ctx.empty);
  const totals = Object.fromEntries(
    metrics.map((m) => [m, blind(ctx, m) || ctx.empty ? null : metricOf(m, cur)]),
  );
  for (const m of metrics) diff.num(`${sb.id} total ${m}`, b.total?.values[m], totals[m] ?? null);
  const share = (v: number | null, t: number | null) => (v === null || !t ? null : v / t);
  for (const m of sb.percentOfTotal ?? []) {
    if (b.total?.share !== undefined)
      diff.num(
        `${sb.id} total share ${m}`,
        b.total.share[m],
        share(totals[m] ?? null, totals[m] ?? null),
      );
  }
  for (const row of b.rows) {
    const rs = all.get(JSON.stringify(row.keys))?.rows ?? [];
    for (const m of metrics) {
      const want = blind(ctx, m) ? null : metricOf(m, rs);
      diff.num(`${sb.id} ${JSON.stringify(row.keys)} ${m}`, row.values[m], want);
      if (sb.percentOfTotal?.includes(m))
        diff.num(
          `${sb.id} ${JSON.stringify(row.keys)} share ${m}`,
          row.share?.[m],
          share(want, totals[m] ?? null),
        );
    }
  }
}

function checkTime(b: LineData, sb: SpecBlock, ctx: Resolved, diff: Diff): void {
  const own = resolveGrain(sb.grain, ctx.anchors);
  if (sb.grains === undefined) {
    checkSeries(`${sb.id} ${grainKey(own)}`, b.axis, b.series, own, sb, ctx, diff);
    return;
  }
  const options = sb.grains.map((g) => resolveGrain(g, ctx.anchors));
  diff.same(
    `${sb.id}.grains keys`,
    b.grains?.options.map((o) => o.key),
    options.map(grainKey),
  );
  const fd =
    ctx.grainDefault === undefined
      ? undefined
      : grainKey(resolveGrain(ctx.grainDefault, ctx.anchors));
  const selected = fd !== undefined && options.some((o) => grainKey(o) === fd) ? fd : grainKey(own);
  diff.same(`${sb.id}.grains.selected`, b.grains?.selected, selected);
  const shown = b.grains?.options.find((o) => o.key === selected);
  diff.same(
    `${sb.id} top-level equals selected`,
    JSON.stringify([b.axis, b.series]),
    JSON.stringify([shown?.axis, shown?.series]),
  );
  options.forEach((g, i) => {
    const o = b.grains?.options[i];
    if (o) checkSeries(`${sb.id} ${o.key}`, o.axis, o.series, g, sb, ctx, diff);
  });
}

function checkSeries(
  at: string,
  axis: TimeAxis | BarData["axis"],
  series: Series[],
  g: Grain,
  sb: SpecBlock,
  ctx: Resolved,
  diff: Diff,
): void {
  const win = snapped(ctx.current, g);
  const cur = inWindow(ctx.rows, win);
  const buckets = spine(win, g);
  const h = ctx.horizon.us;
  const cut = h > naive(win[0]) && h < naive(win[1]);
  diff.same(`${at}.axis`, axis, {
    kind: "time",
    grain: g.unit,
    buckets,
    window: { ...span(win, ctx.horizon.timeZone), ...(cut ? { endAt: wallText(h) } : {}) },
  });
  const partial = partialOf(buckets, g, ctx.horizon);
  const metrics = sb.metrics as string[];
  const byBucket = new Map<string, Row[]>();
  for (const r of cur) {
    const k = bucket(r.d as string, g);
    byBucket.set(k, [...(byBucket.get(k) ?? []), r]);
  }
  type Want = { key: string; metric: string; split?: Key; rows: (bucketRows: Row[]) => Row[] };
  let want: Want[];
  if (sb.split !== undefined) {
    const split = sb.split;
    const m = metrics[0] as string;
    const values = [...groups(cur, [split]).values()];
    const total = (v: Key) =>
      metricOf(
        m,
        cur.filter((r) => col(r, split) === v),
      );
    values.sort(
      (a, b) => (total(b.keys[0] ?? null) ?? -Infinity) - (total(a.keys[0] ?? null) ?? -Infinity),
    );
    want = values.map(({ keys: [v = null] }) => ({
      key: `${m}:${v === null ? "(empty)" : String(v)}`,
      metric: m,
      split: v,
      rows: (rs) => rs.filter((r) => col(r, split) === v),
    }));
    for (let i = 1; i < series.length; i++) {
      const a = total(series[i - 1]?.splitValue ?? null);
      const c = total(series[i]?.splitValue ?? null);
      if (!desc(a, c))
        diff.problems.push(`${at}: series ${series[i - 1]?.key} before ${series[i]?.key}`);
    }
  } else {
    want = metrics.map((m) => ({ key: m, metric: m, rows: (rs) => rs }));
  }
  diff.same(`${at} series keys`, series.map((s) => s.key).sort(), want.map((w) => w.key).sort());
  for (const w of want) {
    const s = series.find((x) => x.key === w.key);
    if (s === undefined) continue;
    if (w.split !== undefined) diff.same(`${at} ${w.key} splitValue`, s.splitValue, w.split);
    diff.same(`${at} ${w.key} partial`, s.partial, blind(ctx, w.metric) ? s.partial : partial);
    buckets.forEach((x, i) => {
      diff.num(
        `${at} ${w.key} ${x}`,
        s.values[i],
        blind(ctx, w.metric) || naive(x) >= h
          ? null
          : metricOf(w.metric, w.rows(byBucket.get(x) ?? [])),
      );
    });
  }
}

const DAY_US = 86_400_000_000n;
function partialOf(buckets: string[], g: Grain, h: Horizon) {
  for (const [index, b] of buckets.entries()) {
    const start = naive(b);
    const end = naive(addUnits(b, g.unit, 1));
    if (start < h.us && h.us < end)
      return [
        {
          index,
          elapsed: Number(((h.us - start) * 1_000_000n) / (end - start)) / 1e6,
          days: Number((h.us - start + DAY_US - 1n) / DAY_US),
          through: new Date(Number(h.us / 1000n)).toISOString().slice(0, 19),
        },
      ];
  }
  return undefined;
}

export function periodsOf(html: string): unknown {
  const m = /<script type="application\/json" data-hm-periods>(.*?)<\/script>/s.exec(html);
  if (!m) throw new Error("no data-hm-periods script");
  return JSON.parse(m[1] as string);
}

export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randomRanges(
  n: number,
  span: { start: string; end: string },
  seed: number,
): Window[] {
  const rnd = seeded(seed);
  const days = daysBetween(span.start, span.end);
  const out: Window[] = [];
  for (let i = 0; i < n; i++) {
    const start = addDays(span.start, Math.floor(rnd() * days));
    const pick = rnd();
    const len = 1 + Math.floor(rnd() * (pick < 0.5 ? 14 : pick < 0.8 ? 120 : days));
    const end = addDays(start, Math.min(len, daysBetween(start, span.end)));
    out.push([start, end]);
  }
  return out;
}

export function compareData(
  a: unknown,
  b: unknown,
  skip: Set<string>,
  skipBlocks: Set<string>,
  diff: Diff,
  at = "",
): void {
  if (typeof a === "number" && typeof b === "number") {
    diff.num(at, a, b);
    return;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      diff.problems.push(`${at}: length ${a.length} != ${b.length}`);
      return;
    }
    a.forEach((x, i) => {
      const id = (x as { id?: unknown } | null)?.id;
      if (typeof id === "string" && skipBlocks.has(id)) return;
      compareData(x, b[i], skip, skipBlocks, diff, `${at}[${typeof id === "string" ? id : i}]`);
    });
    return;
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
      if (skip.has(k)) continue;
      compareData(
        (a as Record<string, unknown>)[k],
        (b as Record<string, unknown>)[k],
        skip,
        skipBlocks,
        diff,
        `${at}.${k}`,
      );
    }
    return;
  }
  diff.same(at, a, b);
}
