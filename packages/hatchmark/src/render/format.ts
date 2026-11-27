import type { DateSpan, MetricInfo, Value } from "../compiler/dashboard-data.js";
import type { TimeGrain } from "../spec/index.js";

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

const minus = (text: string): string => text.replaceAll("-", "\u2212");

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
        signDisplay: "negative",
        minimumFractionDigits: style === "axis" ? 0 : digits,
        maximumFractionDigits: digits,
      }).format(value),
    );
  }
  const currency = {
    signDisplay: "negative",
    ...(f.type === "currency" ? { style: "currency", currency: f.currency } : {}),
  };
  const threshold = f.type === "currency" ? 1e5 : 1e6;
  const compact =
    style === "compact" ||
    style === "axis" ||
    (style === "headline" && (f.compact ?? Math.abs(value) >= threshold)) ||
    (style === "full" && f.compact === true);
  if (compact) {
    const axisFraction = { minimumFractionDigits: 0, maximumFractionDigits: decimals ?? 1 };
    const parts = numberFormat(locale, {
      ...currency,
      notation: Math.abs(value) >= 1e15 ? "scientific" : "compact",
      ...(style === "axis" ? axisFraction : { maximumSignificantDigits: 3 }),
    } as Intl.NumberFormatOptions).formatToParts(value);
    if (parts.some((p) => p.type === "compact" || p.type === "exponentInteger")) {
      return minus(parts.map((p) => p.value).join(""));
    }
    if (style === "axis") {
      return minus(
        numberFormat(locale, { ...currency, ...axisFraction } as Intl.NumberFormatOptions).format(
          value,
        ),
      );
    }
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

// ICU puts thin spaces around the range dash and Chromium prints plain spaces there, so the text
// built here and the text the browser redraws for another range use the plain space.
export const formatRange = (
  start: Date,
  last: Date,
  locale: string,
  fields: { day: boolean; year: boolean },
): string =>
  dateFormat(locale, {
    month: "short",
    ...(fields.day ? { day: "numeric" } : {}),
    ...(fields.year ? { year: "numeric" } : {}),
  })
    .formatRange(start, last)
    .replaceAll("\u2009", " ");

const quarter = (date: Date): string => `Q${Math.floor(date.getUTCMonth() / 3) + 1}`;

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

export function formatSpan(span: DateSpan, locale: string): string {
  const start = parseDate(span.start);
  const end = parseDate(span.end);
  const months =
    (end.getUTCFullYear() - start.getUTCFullYear()) * 12 + end.getUTCMonth() - start.getUTCMonth();
  const wholeMonths = start.getUTCDate() === 1 && end.getUTCDate() === 1 && months > 0;
  if (wholeMonths && months === 12 && start.getUTCMonth() === 0) {
    return String(start.getUTCFullYear());
  }
  if (wholeMonths && months === 3 && start.getUTCMonth() % 3 === 0) {
    return `${quarter(start)} ${start.getUTCFullYear()}`;
  }
  return formatRange(start, addDays(end, -1), locale, { day: !wholeMonths, year: true });
}

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

export const formatDate = (date: string, locale: string): string =>
  formatDay(parseDate(date), locale);

export function formatKey(key: string | number | boolean | null, locale: string): string {
  if (key === null) return "(empty)";
  if (typeof key === "number") {
    return minus(numberFormat(locale, { useGrouping: false }).format(key));
  }
  return String(key);
}
