import type { Comparison, PeriodRange } from "../spec/index.js";

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
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function addDays(date: Ymd, days: number): Ymd {
  const t = new Date(Date.UTC(date.y, date.m - 1, date.d + days));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

/** Moves by whole months, clamping the day to the target month (Mar 31 minus a month is Feb 28/29). */
function addMonths(date: Ymd, months: number): Ymd {
  const index = date.y * 12 + (date.m - 1) + months;
  const y = Math.floor(index / 12);
  const m = (index % 12) + 1;
  return { y, m, d: Math.min(date.d, daysInMonth(y, m)) };
}

const UNIT_MONTHS = { month: 1, quarter: 3, year: 12 } as const;
type Unit = keyof typeof UNIT_MONTHS;

function unitStart(date: Ymd, unit: Unit): Ymd {
  const months = UNIT_MONTHS[unit];
  const m = Math.floor((date.m - 1) / months) * months + 1;
  return { y: date.y, m, d: 1 };
}

function isUnitEnd(date: Ymd, unit: Unit): boolean {
  const next = addDays(date, 1);
  return next.d === 1 && (next.m - 1) % UNIT_MONTHS[unit] === 0;
}

const ROLLING_DAYS: Partial<Record<PeriodRange, number>> = {
  last_7_days: 7,
  last_30_days: 30,
  last_90_days: 90,
};
const TO_DATE: Partial<Record<PeriodRange, Unit>> = {
  month_to_date: "month",
  quarter_to_date: "quarter",
  year_to_date: "year",
};
const COMPLETE: Partial<Record<PeriodRange, Unit>> = {
  last_complete_month: "month",
  last_complete_quarter: "quarter",
  last_complete_year: "year",
};

/**
 * The dates a range covers as of a date, and the dates its comparison covers. This is the one
 * definition of every range; executors call it rather than deriving their own.
 *
 * - Rolling day ranges (last_7_days, last_30_days, last_90_days) end with asOf. previous_period is
 *   the same number of days just before; previous_year is the same dates one year earlier.
 * - last_12_months is the 12 calendar months ending with asOf's month, up to asOf. As a rolling
 *   range, previous_period shifts back by its own length (12 months), which here equals
 *   previous_year.
 * - To-date ranges (month, quarter, year) run from the start of asOf's unit through asOf.
 *   previous_period is the previous unit up to the same elapsed day (clamped to its length);
 *   previous_year is the same span one year earlier.
 * - last_complete_* is the last unit that has fully ended by asOf: asOf's own unit when asOf is
 *   its last day, else the one before. previous_period is the unit before that; previous_year
 *   the same unit one year earlier.
 * - all_time is unbounded and has no comparison: undefined for any shift but "none".
 */
export function windowBounds(
  range: PeriodRange,
  shift: Comparison,
  asOf: string,
): WindowBounds | undefined {
  const day = parse(asOf);
  const result = (start: Ymd, endExclusive: Ymd): WindowBounds => ({
    kind: "bounded",
    start: format(start),
    end: format(endExclusive),
  });

  if (range === "all_time") return shift === "none" ? { kind: "unbounded" } : undefined;

  const days = ROLLING_DAYS[range];
  if (days !== undefined) {
    const end = addDays(day, 1);
    const start = addDays(end, -days);
    if (shift === "none") return result(start, end);
    if (shift === "previous_period") return result(addDays(start, -days), start);
    return result(addMonths(start, -12), addMonths(end, -12));
  }

  if (range === "last_12_months") {
    const end = addDays(day, 1);
    const start = addMonths(unitStart(day, "month"), -11);
    if (shift === "none") return result(start, end);
    return result(addMonths(start, -12), addDays(addMonths(day, -12), 1));
  }

  const toDate = TO_DATE[range];
  if (toDate !== undefined) {
    const start = unitStart(day, toDate);
    if (shift === "none") return result(start, addDays(day, 1));
    const previousStart = addMonths(
      start,
      shift === "previous_period" ? -UNIT_MONTHS[toDate] : -12,
    );
    const sameMonth = addMonths(previousStart, day.m - start.m);
    const lastDay = { ...sameMonth, d: Math.min(day.d, daysInMonth(sameMonth.y, sameMonth.m)) };
    return result(previousStart, addDays(lastDay, 1));
  }

  const unit = COMPLETE[range];
  if (unit === undefined) return undefined;
  const months = UNIT_MONTHS[unit];
  const current = isUnitEnd(day, unit)
    ? unitStart(day, unit)
    : addMonths(unitStart(day, unit), -months);
  const start =
    shift === "none" ? current : addMonths(current, shift === "previous_period" ? -months : -12);
  return result(start, addMonths(start, months));
}
