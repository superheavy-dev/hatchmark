import {
  type Anchors,
  type Comparison,
  PERIOD_RANGES,
  type PeriodRange,
  type RangeSpec,
  type ResolvedGrain,
  type TimeGrain,
  WEEKDAYS,
} from "../spec/index.js";
import type { ExecutionContext, PlannedParam, PlannedQuery } from "./plan.js";

/**
 * A window as calendar dates in the project time zone: start inclusive, end exclusive, both
 * YYYY-MM-DD. The executor turns them into timestamps in hatchmark.json's timezone.
 */
export type WindowBounds = { kind: "bounded"; start: string; end: string } | { kind: "unbounded" };

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

const NAMED: Record<Exclude<PeriodRange, "all_time">, Exclude<RangeSpec, PeriodRange>> = {
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

/**
 * The dates one execution of a planned query reads: its window's range, or the range a period
 * filter binds (its default when nothing is bound) when that filter windows the query's time
 * column, shifted by the window's comparison. Undefined when the shift has no window (all_time
 * compared); unbounded for all_time and for queries without a time column. Executors and assembly
 * both call this, so the numbers and the spans shown next to them always agree.
 */
export function queryBounds(
  query: PlannedQuery,
  context: Pick<ExecutionContext, "asOf" | "bindings" | "anchors">,
): WindowBounds | undefined {
  const { window } = query;
  if (window.column === undefined) return { kind: "unbounded" };
  const param = query.params.find(
    (p): p is PlannedParam & { kind: "period" } =>
      p.kind === "period" && p.column === window.column,
  );
  return resolveRange(
    effectiveRange(window.range, param, context.bindings),
    window.shift,
    context.asOf,
    context.anchors,
  );
}

/**
 * The range a period filter makes current: its bound range, else its default, else the base range
 * when there is no period filter. A dashboard has at most one period filter (check, HM3007), so
 * the dashboard's period and every query it windows resolve to the same range. Throws on a binding
 * that is not a period range.
 */
export function effectiveRange(
  base: RangeSpec,
  param: { id: string; default: PeriodRange } | undefined,
  bindings: ExecutionContext["bindings"],
): RangeSpec {
  if (param === undefined) return base;
  const bound = bindings[param.id];
  if (bound === undefined) return param.default;
  if (typeof bound === "string" && (PERIOD_RANGES as readonly string[]).includes(bound)) {
    return bound as PeriodRange;
  }
  throw new TypeError(
    `period filter "${param.id}" is bound to ${JSON.stringify(bound)}, not a period range`,
  );
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

/** The day before a date. */
export function previousDay(date: string): string {
  return format(addDays(parse(date), -1));
}

/** The day after a date: the exclusive end of a span that ends with it. */
export function nextDay(date: string): string {
  return format(addDays(parse(date), 1));
}
