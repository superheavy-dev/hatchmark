import type {
  Anchors,
  Comparison,
  PeriodRange,
  RangeSpec,
  ResolvedGrain,
  TimeGrain,
} from "../spec/index.js";
import { PERIOD_RANGES, TIME_GRAINS, WEEKDAYS } from "../spec/units.js";
import {
  DAY_US,
  formatInstant,
  formatWall,
  fromLocal,
  isRepeated,
  parseInstant,
  toLocal,
} from "./instants.js";
import type { ExecutionContext, PlannedParam, PlannedQuery } from "./plan.js";

/**
 * A window in the project time zone: start inclusive, end exclusive. Each bound is a local date
 * (YYYY-MM-DD, its midnight), or a UTC instant YYYY-MM-DDTHH:MM:SS.ffffffZ where a measure's
 * horizon cuts a day (RFC 0001 section 6.4). An unbounded window (all_time) may still end at the
 * horizon. The executor compares a row's local date with a date and its instant with an instant.
 */
export type WindowBounds =
  | { kind: "bounded"; start: string; end: string }
  | { kind: "unbounded"; end?: string };

interface Ymd {
  y: number;
  m: number;
  d: number;
}

function parse(date: string): Ymd {
  const [y = 0, m = 1, d = 1] = date.split("-").map(Number);
  return { y, m, d };
}

function format({ y, m, d }: Ymd): string {
  return `${y < 0 ? "-" : ""}${String(Math.abs(y)).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** A UTC instant for a date; unlike Date.UTC, years 0 to 99 stay themselves instead of 1900 to 1999. */
function utc(y: number, monthIndex: number, d: number): Date {
  const t = new Date(0);
  t.setUTCFullYear(y, monthIndex, d);
  return t;
}

function daysInMonth(y: number, m: number): number {
  return utc(y, m, 0).getUTCDate();
}

function addDays(date: Ymd, days: number): Ymd {
  const t = utc(date.y, date.m - 1, date.d + days);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

/** Moves by whole months, clamping the day to the target month (Mar 31 minus a month is Feb 28/29). */
function addMonths(date: Ymd, months: number): Ymd {
  const index = date.y * 12 + (date.m - 1) + months;
  const y = Math.floor(index / 12);
  const m = index - y * 12 + 1;
  return { y, m, d: Math.min(date.d, daysInMonth(y, m)) };
}

const key = ({ y, m, d }: Ymd) => y * 10000 + m * 100 + d;
const before = (a: Ymd, b: Ymd) => key(a) < key(b);

/** Moves a date by whole grain units: days and weeks by days, the others by clamped months. */
function addUnits(date: Ymd, unit: TimeGrain, n: number): Ymd {
  switch (unit) {
    case "day":
      return addDays(date, n);
    case "week":
      return addDays(date, 7 * n);
    case "month":
      return addMonths(date, n);
    case "quarter":
      return addMonths(date, 3 * n);
    case "year":
      return addMonths(date, 12 * n);
  }
}

/** The start of the bucket holding a date: weeks from their anchor weekday, quarters and years from their MM-DD. */
function startOf(date: Ymd, grain: ResolvedGrain): Ymd {
  switch (grain.unit) {
    case "day":
      return date;
    case "month":
      return { y: date.y, m: date.m, d: 1 };
    case "week": {
      const weekday = (utc(date.y, date.m - 1, date.d).getUTCDay() + 6) % 7;
      return addDays(date, -((weekday - WEEKDAYS.indexOf(grain.anchor) + 7) % 7));
    }
    default: {
      const anchor = parse(`2000-${grain.anchor}`);
      const step = grain.unit === "quarter" ? 3 : 12;
      let start: Ymd = { y: date.y, m: anchor.m, d: anchor.d };
      while (before(date, start)) start = addMonths(start, -12);
      while (!before(date, addMonths(start, step))) start = addMonths(start, step);
      return start;
    }
  }
}

/**
 * The dates a window may cover. Every bucket holding one of them starts and ends in years 0000 to
 * 9999, so its YYYY-MM-DD key sorts and formats the same in the core and in executors.
 */
export const SUPPORTED_DATES = { first: "0001-01-01", last: "9998-12-31" } as const;
const FIRST_DAY: Ymd = { y: 1, m: 1, d: 1 };
const PAST_LAST_DAY: Ymd = { y: 9999, m: 1, d: 1 };

export const NAMED: Record<Exclude<PeriodRange, "all_time">, Exclude<RangeSpec, PeriodRange>> = {
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

/** A grain at the project anchors, for ranges and comparisons written with a bare unit. */
function anchored(unit: TimeGrain, anchors: Anchors): ResolvedGrain {
  if (unit === "day" || unit === "month") return { unit };
  if (unit === "week") return { unit, anchor: anchors.week };
  return { unit, anchor: anchors[unit] };
}

/**
 * The dates a range covers as of a date, and the dates its comparison covers: the one definition of
 * every range, which executors and assembly call rather than deriving their own. Named ranges are
 * aliases of the shorthands (last_30_days is {"last": 30, "unit": "day"}). Quarters and years start
 * at the project anchors.
 *
 * - {start, end} is those dates. previous_period is the same number of days just before.
 * - {last: N, unit: "day"} is the N days ending with asOf. previous_period is the N days before it.
 * - {last: N, unit} for coarser units is the N buckets ending with asOf's, cut after asOf.
 *   previous_period moves it back N units, ending at the same elapsed point (asOf moved back).
 * - {to_date: unit} runs from the start of asOf's bucket through asOf. previous_period is the
 *   previous bucket through the same elapsed day, clamped to its length.
 * - {last_complete: unit} is the last bucket that has ended by the end of asOf. previous_period is
 *   the bucket before it.
 * - {shift: {unit, by}} moves the range by whole units, and previous_year is {unit: "year", by: -1}.
 *   A window of whole months (start and end on the 1st) shifted by months, quarters or years moves
 *   both ends and stays whole months. Any other window moves its first and last day, each keeping
 *   its day of the month clamped to the target month (Mar 31 minus a month is Feb 28/29), so it is
 *   never empty; day and week shifts keep its day count exactly, and a to-date range covers the
 *   same elapsed days of its bucket.
 * - all_time is unbounded and has no comparison: undefined for any shift but "none".
 * - Throws a RangeError for a window that reaches outside SUPPORTED_DATES, current or shifted.
 */
export function resolveRange(
  range: RangeSpec,
  shift: Comparison,
  asOf: string,
  anchors: Anchors,
): WindowBounds | undefined {
  if (range === "all_time") return shift === "none" ? { kind: "unbounded" } : undefined;
  const spec = typeof range === "string" ? NAMED[range] : range;
  const day = parse(asOf);
  const result = (start: Ymd, end: Ymd): WindowBounds => {
    if (!(key(start) >= key(FIRST_DAY) && key(end) <= key(PAST_LAST_DAY))) {
      throw new RangeError(
        `the window ${format(start)} to ${format(end)} (exclusive) reaches outside the supported dates ${SUPPORTED_DATES.first} to ${SUPPORTED_DATES.last}`,
      );
    }
    return { kind: "bounded", start: format(start), end: format(end) };
  };
  const moved = (unit: TimeGrain, n: number) => ({ unit, n });
  const by =
    shift === "none"
      ? undefined
      : shift === "previous_year"
        ? moved("year", -1)
        : typeof shift === "object"
          ? moved(shift.shift.unit, shift.shift.by)
          : undefined;
  const move = (start: Ymd, end: Ymd, s: { unit: TimeGrain; n: number }) =>
    s.unit !== "day" && s.unit !== "week" && start.d === 1 && end.d === 1
      ? result(addUnits(start, s.unit, s.n), addUnits(end, s.unit, s.n))
      : result(addUnits(start, s.unit, s.n), addDays(addUnits(addDays(end, -1), s.unit, s.n), 1));

  if ("start" in spec) {
    const start = parse(spec.start);
    const end = parse(spec.end);
    if (shift === "none") return result(start, end);
    if (by === undefined) {
      const days = Math.round(
        (utc(end.y, end.m - 1, end.d).getTime() - utc(start.y, start.m - 1, start.d).getTime()) /
          86400000,
      );
      return result(addDays(start, -days), start);
    }
    return move(start, end, by);
  }

  if ("last_complete" in spec) {
    const grain = anchored(spec.last_complete, anchors);
    const unit = spec.last_complete;
    const next = addDays(day, 1);
    const own = startOf(day, grain);
    const current = format(addUnits(own, unit, 1)) === format(next) ? own : addUnits(own, unit, -1);
    if (shift === "none") return result(current, addUnits(current, unit, 1));
    if (by === undefined) return result(addUnits(current, unit, -1), current);
    return move(current, addUnits(current, unit, 1), by);
  }

  if ("last" in spec && spec.unit === "day") {
    const end = addDays(day, 1);
    const start = addDays(end, -spec.last);
    if (shift === "none") return result(start, end);
    if (by === undefined) return result(addDays(start, -spec.last), start);
    return move(start, end, by);
  }

  const unit = "last" in spec ? spec.unit : spec.to_date;
  const count = "last" in spec ? spec.last : 1;
  const start = addUnits(startOf(day, anchored(unit, anchors)), unit, -(count - 1));
  if (shift === "none") return result(start, addDays(day, 1));
  return move(start, addDays(day, 1), by ?? moved(unit, -count));
}

type BoundsContext = Pick<ExecutionContext, "asOf" | "bindings" | "anchors"> &
  Partial<Pick<ExecutionContext, "timezone" | "asOfInstant" | "horizons">>;

/**
 * The window one execution of a planned query reads: its window's range, or the range a period
 * filter binds (its default when nothing is bound) when that filter windows the query's time
 * column, shifted by the window's comparison, and ended at the measure's horizon (measureHorizon).
 * Undefined when the shift has no window (all_time compared); unbounded for all_time and for
 * queries without a time column. Executors and assembly both call this, so the numbers and the
 * spans shown next to them always agree.
 */
export function queryBounds(query: PlannedQuery, context: BoundsContext): WindowBounds | undefined {
  return windowAt(query, context, measureHorizon(query, context));
}

/**
 * A measure's horizon as UTC microseconds (instants.ts): the earliest of the as-of instant T and
 * the horizons of the time columns its window lists. Undefined when the context carries no
 * horizons (a context built without measuring them).
 */
export function measureHorizon(query: PlannedQuery, context: BoundsContext): bigint | undefined {
  const { asOfInstant, horizons, timezone } = context;
  if (asOfInstant === undefined || horizons === undefined || timezone === undefined)
    return undefined;
  let horizon = parseInstant(asOfInstant);
  for (const { source, column } of query.window.horizons ?? []) {
    const h =
      horizons.find((x) => x.source === source && x.column === column) ??
      horizons.find((x) => x.source === source);
    const through = h === undefined ? undefined : parseInstant(h.through);
    if (through !== undefined && through < horizon) horizon = through;
  }
  return horizon;
}

/** A bound as UTC microseconds: a local date is its local midnight, a "...Z" bound its instant. */
export function boundInstant(value: string, timezone: string): bigint {
  return value.endsWith("Z") ? parseInstant(value) : fromLocal(parseInstant(value), timezone);
}

/** Whole local days from one date to another. */
function daysBetween(from: string, to: string): number {
  return Math.round(Number(parseInstant(to) - parseInstant(from)) / Number(DAY_US));
}

/**
 * A query's window ended at a horizon (UTC microseconds; none keeps the window as written), when
 * the horizon is before the end of the range as written (RFC 0001 section 6.4).
 *
 * KPIs and tables read whole local days ending at the last complete day: the window ends at the
 * local midnight at or before the horizon (day D).
 * - {last: N, unit} slides back by whole days to end at D, keeping the day count of the window
 *   resolveRange gives it, and compares like an explicit {start, end} range of those dates:
 *   previous_period is the same number of days just before, a shift moves its first and last day;
 * - a to-date range is the range as of the day before D, with its comparison;
 * - a complete unit or explicit range ends at D, and its comparison covers the same number of
 *   days from its own start, never past its own end;
 * - all_time ends at D.
 *
 * A time series keeps the dashboard's axis and reads through the horizon itself, so its partial
 * bucket is marked (section 6.5): its window ends at the horizon instant, and its comparison is
 * cut to the same elapsed local time. Such a bound is a UTC instant "YYYY-MM-DDTHH:MM:SS.ffffffZ",
 * so a cutoff inside a repeated hour stays exact; every other bound is a local date.
 *
 * A time series' window then starts at the start of the bucket its start falls in (section 6.5,
 * leading edge), so its first bucket is whole, unless the window clips (window.edges "clip") or is
 * empty. The snapped start is taken before the horizon ends the window, so a source that ends
 * before the range starts still reads the snapped bucket up to its horizon.
 */
export function windowAt(
  query: PlannedQuery,
  context: BoundsContext,
  horizon: bigint | undefined,
): WindowBounds | undefined {
  const bounds = endedWindow(query, context, horizon);
  const time = query.dimensions.find((d) => d.kind === "time");
  const snapped =
    time?.kind !== "time" ||
    query.window.edges === "clip" ||
    bounds?.kind !== "bounded" ||
    bounds.start === bounds.end ||
    bounds.start.endsWith("Z")
      ? bounds
      : { ...bounds, start: bucketStart(bounds.start, time.grain) };
  return settled(snapped, context.timezone, horizon);
}

/**
 * A window bound as the instant it stands for: a date at a midnight that a fall-back repeats is
 * its later occurrence (RFC 0001 section 6.2); any other bound is returned unchanged, so an
 * instant is never moved.
 */
export function exactBound(bound: string, timezone: string): string {
  if (bound.endsWith("Z") || !isRepeated(parseInstant(bound), timezone)) return bound;
  return formatInstant(fromLocal(parseInstant(bound), timezone));
}

function settled(
  bounds: WindowBounds | undefined,
  timezone: string | undefined,
  horizon: bigint | undefined,
): WindowBounds | undefined {
  if (bounds === undefined || timezone === undefined) return bounds;
  const instant = (bound: string) => boundInstant(bound, timezone);
  const end = (bound: string) =>
    horizon !== undefined && instant(bound) > horizon
      ? formatInstant(horizon)
      : exactBound(bound, timezone);
  if (bounds.kind === "unbounded") {
    return bounds.end === undefined ? bounds : { ...bounds, end: end(bounds.end) };
  }
  const start = exactBound(bounds.start, timezone);
  const stop = end(bounds.end);
  return { kind: "bounded", start, end: instant(start) >= instant(stop) ? start : stop };
}

function endedWindow(
  query: PlannedQuery,
  context: BoundsContext,
  horizon: bigint | undefined,
): WindowBounds | undefined {
  const { window } = query;
  if (window.column === undefined) return { kind: "unbounded" };
  const param = query.params.find(
    (p): p is PlannedParam & { kind: "period" } =>
      p.kind === "period" && p.column === window.column,
  );
  const range = effectiveRange(window.range, param, context.bindings);
  const { anchors } = context;
  const target = resolveRange(range, window.shift, context.asOf, anchors);
  const tz = context.timezone;
  if (horizon === undefined || tz === undefined || target === undefined) return target;
  const hw = toLocal(horizon, tz);
  const day = formatWall(hw).slice(0, 10);
  const timeAxis = query.dimensions.some((d) => d.kind === "time");
  const exact =
    formatWall(hw).endsWith("T00:00:00.000000") && fromLocal(hw, tz) === horizon
      ? day
      : formatInstant(horizon);
  if (range === "all_time") return { kind: "unbounded", end: timeAxis ? exact : day };
  const base = resolveRange(range, "none", context.asOf, anchors);
  if (base?.kind !== "bounded" || target.kind !== "bounded") return target;
  if (hw >= parseInstant(base.end)) return target;
  const empty: WindowBounds = { kind: "bounded", start: base.start, end: base.start };
  const spec = typeof range === "string" ? NAMED[range] : range;

  if (timeAxis && window.shift === "none") {
    const time = query.dimensions.find((d) => d.kind === "time");
    const first =
      time?.kind === "time" && window.edges !== "clip"
        ? bucketStart(base.start, time.grain)
        : base.start;
    return hw <= parseInstant(first) ? empty : { kind: "bounded", start: first, end: exact };
  }
  const toDate = "to_date" in spec;
  if (toDate && window.shift === "none") {
    return hw <= parseInstant(base.start)
      ? empty
      : { kind: "bounded", start: base.start, end: exact };
  }
  if (timeAxis || toDate) {
    const start = parseInstant(base.start);
    if (hw <= start) return { ...target, end: target.start };
    const from = parseInstant(target.start);
    const cut = from + (hw - start);
    if (cut >= parseInstant(target.end)) return target;
    const text = formatWall(cut);
    const end = text.endsWith("T00:00:00.000000")
      ? text.slice(0, 10)
      : formatInstant(fromLocal(cut, tz));
    return { kind: "bounded", start: target.start, end };
  }

  if ("last" in spec) {
    const slid = {
      start: format(addDays(parse(day), -daysBetween(base.start, base.end))),
      end: day,
    };
    return resolveRange(slid, window.shift, context.asOf, anchors);
  }
  if (day <= base.start) return window.shift === "none" ? empty : { ...target, end: target.start };
  if (window.shift === "none") return { kind: "bounded", start: base.start, end: day };
  const end = format(addDays(parse(target.start), daysBetween(base.start, day)));
  return end < target.end ? { kind: "bounded", start: target.start, end } : target;
}

/**
 * The range a period filter makes current: its bound range, else its default, else the base range
 * when there is no period filter. A dashboard has at most one period filter (check, HM3007), so
 * the dashboard's period and every query it windows resolve to the same range. A binding is any
 * range a spec can write: a named range, a shorthand, or {start, end} for a custom range. Throws on
 * a binding that is not one.
 */
export function effectiveRange(
  base: RangeSpec,
  param: { id: string; default: RangeSpec } | undefined,
  bindings: ExecutionContext["bindings"],
): RangeSpec {
  if (param === undefined) return base;
  const bound = bindings[param.id];
  if (bound === undefined) return param.default;
  if (isRange(bound)) return bound;
  throw new TypeError(
    `period filter "${param.id}" is bound to ${JSON.stringify(bound)}, not a period range`,
  );
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Whether a value has the shape of a RangeSpec, checked without the spec schema. */
function isRange(value: unknown): value is RangeSpec {
  if (typeof value === "string") return (PERIOD_RANGES as readonly string[]).includes(value);
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  const unit = (u: unknown) => (TIME_GRAINS as readonly unknown[]).includes(u);
  const day = (d: unknown): d is string => {
    if (typeof d !== "string" || !DAY.test(d)) return false;
    const date = parse(d);
    const normal = addDays(date, 0);
    return normal.m === date.m && normal.d === date.d;
  };
  switch (Object.keys(r).sort().join(",")) {
    case "end,start":
      return day(r.start) && day(r.end) && r.start < r.end;
    case "last,unit":
      return (
        Number.isInteger(r.last) &&
        (r.last as number) >= 1 &&
        (r.last as number) <= 3660 &&
        unit(r.unit)
      );
    case "to_date":
      return unit(r.to_date);
    case "last_complete":
      return unit(r.last_complete);
    default:
      return false;
  }
}

/** The first day of the time bucket a date falls in. */
export function bucketStart(date: string, grain: ResolvedGrain): string {
  return format(startOf(parse(date), grain));
}

/**
 * Every bucket start of a span (start inclusive, end exclusive): a complete spine from the bucket
 * holding start through the bucket holding the last day, so empty buckets are listed too. The
 * first and last buckets may begin before or end after the span. Empty when the span is empty.
 */
export function timeBuckets(start: string, end: string, grain: ResolvedGrain): string[] {
  if (start >= end) return [];
  const last = bucketStart(format(addDays(parse(end), -1)), grain);
  const out: string[] = [];
  for (let bucket = startOf(parse(start), grain); format(bucket) <= last; ) {
    out.push(format(bucket));
    bucket = addUnits(bucket, grain.unit, 1);
  }
  return out;
}

/** The exclusive end of the bucket that starts on a date: the next bucket's start. */
export function bucketEnd(start: string, grain: ResolvedGrain): string {
  return format(addUnits(parse(start), grain.unit, 1));
}

/** The day before a date. */
export function previousDay(date: string): string {
  return format(addDays(parse(date), -1));
}

/** The day after a date: the exclusive end of a span that ends with it. */
export function nextDay(date: string): string {
  return format(addDays(parse(date), 1));
}
