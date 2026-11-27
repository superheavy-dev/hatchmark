import type { RangeSpec, TimeGrain } from "../spec/index.js";
import { nextDay } from "./windows.js";

export { rangeKey } from "../spec/units.js";

/**
 * A period filter's presets and custom ranges for the control and the page URL. Each is addressed
 * by its rangeKey (spec/units.ts): "last_30_days", "month_to_date", or "<first>..<last>".
 */

const DAYS = /^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/;

/**
 * The custom range a "<first>..<last>" key names, as a range with an exclusive end; undefined when
 * the text is not two dates in order.
 */
export function parseDaysKey(key: string): { start: string; end: string } | undefined {
  const match = DAYS.exec(key);
  if (!match) return undefined;
  const [, first = "", last = ""] = match;
  if (!validDay(first) || !validDay(last) || last < first) return undefined;
  return { start: first, end: nextDay(last) };
}

function validDay(day: string): boolean {
  const [y = 0, m = 0, d = 0] = day.split("-").map(Number);
  if (m < 1 || m > 12 || d < 1) return false;
  const t = new Date(0);
  t.setUTCFullYear(y, m, 0);
  return d <= t.getUTCDate();
}

const UNIT: Record<TimeGrain, string> = {
  day: "day",
  week: "week",
  month: "month",
  quarter: "quarter",
  year: "year",
};

const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * The control text of a preset: "Last 7 days", "Month to date", "Last month" (the last complete
 * one), "All time". A range of dates has no name; the control shows its dates instead.
 */
export function rangeName(range: RangeSpec): string | undefined {
  const named: Record<string, RangeSpec> = {
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
  if (range === "all_time") return "All time";
  const spec = typeof range === "string" ? named[range] : range;
  if (spec === undefined || typeof spec === "string" || "start" in spec) return undefined;
  if ("last" in spec) {
    if (spec.last === 1) return rangeName({ to_date: spec.unit });
    return `Last ${spec.last} ${UNIT[spec.unit]}s`;
  }
  if ("to_date" in spec) {
    return spec.to_date === "day" ? "Latest day" : `${capital(UNIT[spec.to_date])} to date`;
  }
  return spec.last_complete === "day" ? "Last complete day" : `Last ${UNIT[spec.last_complete]}`;
}
