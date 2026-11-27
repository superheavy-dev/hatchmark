import type { DateSpan, MetricInfo, Value } from "../compiler/dashboard-data.js";
import type { TimeGrain } from "../spec/index.js";

/** Where a number is shown: each place has its own precision rules (Default theme tokens). */
export type NumberStyle = "full" | "compact" | "axis" | "headline";

const formatters = new Map<string, Intl.NumberFormat>();

function numberFormat(locale: string, options: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = `${locale}|${JSON.stringify(options)}`;
  let format = formatters.get(key);
  if (format === undefined) {
    format = new Intl.NumberFormat(locale, options);
    formatters.set(key, format);
  }
  return format;
}

/** Hyphen-minus to the typographic minus sign the theme asks for. */
const minus = (text: string): string => text.replaceAll("-", "\u2212");

/**
 * Formats a metric value. null is the em dash; 0 is a real zero. Headline (KPI) values switch to
 * compact notation at 100,000 for currency and 1,000,000 for plain numbers unless the metric's
 * format sets compact. Compact text switches to scientific notation from 10^15, past the
 * largest compact unit (T).
 */
export function formatValue(
  value: Value,
  metric: Pick<MetricInfo, "format">,
  locale: string,
  style: NumberStyle,
): string {
  if (value === null || !Number.isFinite(value)) return "\u2014";
  const f = metric.format;
  const decimals = f.decimals;
  if (f.type === "percent") {
    const digits = decimals ?? 1;
    return minus(
      numberFormat(locale, {
        style: "percent",
        minimumFractionDigits: style === "axis" ? 0 : digits,
        maximumFractionDigits: digits,
      }).format(value),
    );
  }
  const currency = f.type === "currency" ? { style: "currency", currency: f.currency } : {};
  const threshold = f.type === "currency" ? 1e5 : 1e6;
  const compact =
    style === "compact" ||
    style === "axis" ||
    (style === "headline" && (f.compact ?? Math.abs(value) >= threshold)) ||
    (style === "full" && f.compact === true);
  if (compact) {
    return minus(
      numberFormat(locale, {
        ...currency,
        notation: Math.abs(value) >= 1e15 ? "scientific" : "compact",
        ...(style === "axis"
          ? { minimumFractionDigits: 0, maximumFractionDigits: decimals ?? 1 }
          : { maximumSignificantDigits: 3 }),
      } as Intl.NumberFormatOptions).format(value),
    );
  }
  const fraction =
    decimals !== undefined
      ? { minimumFractionDigits: decimals, maximumFractionDigits: decimals }
      : f.type === "currency"
        ? { maximumFractionDigits: 0 }
        : { maximumFractionDigits: Number.isInteger(value) ? 0 : 1 };
  return minus(
    numberFormat(locale, { ...currency, ...fraction } as Intl.NumberFormatOptions).format(value),
  );
}

/** Axis tick labels: compact, with the fewest decimals that show every tick exactly. */
export function formatTicks(
  ticks: number[],
  metric: Pick<MetricInfo, "format">,
  locale: string,
): string[] {
  const at = (decimals: number) =>
    ticks.map((t) => formatValue(t, { format: { ...metric.format, decimals } }, locale, "axis"));
  const step = Math.abs((ticks[1] ?? 0) - (ticks[0] ?? 0));
  const most = step > 0 ? Math.min(20, Math.max(3, Math.ceil(-Math.log10(step)) + 1)) : 3;
  for (let decimals = 0; decimals <= most; decimals++) {
    const labels = at(decimals);
    const exact = at(decimals + 1).every((label, i) => label === labels[i]);
    if (exact && new Set(labels).size === labels.length) return labels;
  }
  return ticks.map((t) => formatValue(t, metric, locale, "full"));
}

/**
 * A KPI change: relative changes as a signed percent with one decimal, percentage-point changes
 * with two decimals and " pp". The sign uses the typographic minus. Returns undefined when there
 * is no change to show.
 */
export function formatChange(
  change: Value | undefined,
  kind: "relative" | "points",
  locale: string,
): string | undefined {
  if (change === undefined || change === null || !Number.isFinite(change)) return undefined;
  if (kind === "points") {
    const text = numberFormat(locale, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
      signDisplay: "exceptZero",
    }).format(change * 100);
    return `${minus(text)} pp`;
  }
  return minus(
    numberFormat(locale, {
      style: "percent",
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
      signDisplay: "exceptZero",
    }).format(change),
  );
}

/** A YYYY-MM-DD date as a UTC Date; calendar dates carry no time zone of their own. */
export function parseDate(date: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y as number, (m as number) - 1, d as number));
}

const dateFormats = new Map<string, Intl.DateTimeFormat>();

function dateFormat(locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${locale}|${JSON.stringify(options)}`;
  let format = dateFormats.get(key);
  if (format === undefined) {
    format = new Intl.DateTimeFormat(locale, { ...options, timeZone: "UTC" });
    dateFormats.set(key, format);
  }
  return format;
}

export const formatMonth = (date: Date, locale: string, withYear: boolean): string =>
  dateFormat(locale, withYear ? { month: "short", year: "numeric" } : { month: "short" }).format(
    date,
  );

export const formatDay = (date: Date, locale: string, withYear = true): string =>
  dateFormat(
    locale,
    withYear
      ? { month: "short", day: "numeric", year: "numeric" }
      : { month: "short", day: "numeric" },
  ).format(date);

const quarter = (date: Date): string => `Q${Math.floor(date.getUTCMonth() / 3) + 1}`;

/** A bucket as the tooltip header and data table name it: "Oct 2026", "Week of Oct 5, 2026". */
/** Whether a quarter or year bucket starts on a calendar quarter or year, so Q3 2026 or 2026 names it. */
const calendarStart = (date: Date, grain: "quarter" | "year") =>
  date.getUTCDate() === 1 && date.getUTCMonth() % (grain === "year" ? 12 : 3) === 0;

export function formatBucket(bucket: string, grain: TimeGrain, locale: string): string {
  const date = parseDate(bucket);
  if ((grain === "quarter" || grain === "year") && !calendarStart(date, grain)) {
    return `${grain === "year" ? "Year" : "Quarter"} of ${formatDay(date, locale)}`;
  }
  switch (grain) {
    case "day":
      return formatDay(date, locale);
    case "week":
      return `Week of ${formatDay(date, locale)}`;
    case "month":
      return formatMonth(date, locale, true);
    case "quarter":
      return `${quarter(date)} ${date.getUTCFullYear()}`;
    case "year":
      return String(date.getUTCFullYear());
  }
}

/** An axis label for a bucket; the year is added on January (or Q1) and on the first label. */
export function formatBucketTick(
  bucket: string,
  grain: TimeGrain,
  locale: string,
  first: boolean,
): string {
  const date = parseDate(bucket);
  if ((grain === "quarter" || grain === "year") && !calendarStart(date, grain)) {
    return date.getUTCDate() === 1 ? formatMonth(date, locale, true) : formatDay(date, locale);
  }
  if (grain === "year") return String(date.getUTCFullYear());
  if (grain === "quarter") {
    return first || date.getUTCMonth() < 3
      ? `${quarter(date)} ${date.getUTCFullYear()}`
      : quarter(date);
  }
  return formatMonth(date, locale, first || date.getUTCMonth() === 0);
}

const addDays = (date: Date, days: number): Date => new Date(date.getTime() + days * 86_400_000);

/**
 * A date span in words, end exclusive: "Oct 2026" for one calendar month, "Nov 2025 – Oct 2026"
 * for whole months, "Q3 2026", "2026", else days: "Sep 7 – Nov 1, 2026".
 */
export function formatSpan(span: DateSpan, locale: string): string {
  const start = parseDate(span.start);
  const end = parseDate(span.end);
  const last = addDays(end, -1);
  const months =
    (end.getUTCFullYear() - start.getUTCFullYear()) * 12 + end.getUTCMonth() - start.getUTCMonth();
  if (start.getUTCDate() === 1 && end.getUTCDate() === 1 && months > 0) {
    if (months === 12 && start.getUTCMonth() === 0) return String(start.getUTCFullYear());
    if (months === 3 && start.getUTCMonth() % 3 === 0) {
      return `${quarter(start)} ${start.getUTCFullYear()}`;
    }
    if (months === 1) return formatMonth(start, locale, true);
    const sameYear = start.getUTCFullYear() === last.getUTCFullYear();
    return `${formatMonth(start, locale, !sameYear)} \u2013 ${formatMonth(last, locale, true)}`;
  }
  if (span.start === formatIso(last)) return formatDay(start, locale);
  const sameYear = start.getUTCFullYear() === last.getUTCFullYear();
  return `${formatDay(start, locale, !sameYear)} \u2013 ${formatDay(last, locale)}`;
}

/**
 * The previous window as a KPI note names it: "Sep" when it is one month of the current
 * window's year, else the full span.
 */
export function formatPreviousSpan(
  previous: DateSpan,
  current: DateSpan | undefined,
  locale: string,
): string {
  const start = parseDate(previous.start);
  const end = parseDate(previous.end);
  const oneMonth =
    start.getUTCDate() === 1 &&
    end.getUTCDate() === 1 &&
    (end.getUTCFullYear() - start.getUTCFullYear()) * 12 +
      end.getUTCMonth() -
      start.getUTCMonth() ===
      1;
  const sameYear =
    current !== undefined && parseDate(current.start).getUTCFullYear() === start.getUTCFullYear();
  if (oneMonth && sameYear) return formatMonth(start, locale, false);
  return formatSpan(previous, locale);
}

/** A YYYY-MM-DD date as "Oct 31, 2026". */
export const formatDate = (date: string, locale: string): string =>
  formatDay(parseDate(date), locale);

function formatIso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * A category key as text: null is "(empty)", booleans as written. A number in a grouping column is
 * a label, not a quantity (a year, a seat count, a store id), so it has no thousands separator.
 */
export function formatKey(key: string | number | boolean | null, locale: string): string {
  if (key === null) return "(empty)";
  if (typeof key === "number") {
    return minus(numberFormat(locale, { useGrouping: false }).format(key));
  }
  return String(key);
}
