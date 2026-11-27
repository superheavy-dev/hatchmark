import { z } from "zod";
import { PERIOD_RANGES, TIME_GRAINS, WEEKDAYS } from "./units.js";

export {
  grainKey,
  grainUnit,
  PERIOD_RANGES,
  resolveGrain,
  TIME_GRAINS,
  WEEKDAYS,
} from "./units.js";

/** Metric, source, block and filter names: lowercase snake_case, so they are safe in SQL and URLs. */
export const IDENTIFIER_PATTERN = /^[a-z][a-z0-9_]*$/;

export const identifier = z
  .string()
  .regex(IDENTIFIER_PATTERN, { error: "must be lowercase snake_case, such as net_revenue" });

/** Folds ASCII letters to lowercase, as DuckDB does when it matches identifiers. */
export function foldColumn(name: string): string {
  return name.replace(/[A-Z]/g, (ch) => ch.toLowerCase());
}

/**
 * Whether two column names refer to the same column. DuckDB resolves identifiers, quoted or not,
 * case-insensitively for ASCII letters only (Region = region, but É is not é), and so does every
 * column comparison in Hatchmark.
 */
export function sameColumn(a: string, b: string): boolean {
  return foldColumn(a) === foldColumn(b);
}

/** Whether known columns include a column (see sameColumn); undefined when they are unknown. */
export function hasColumn(
  columns: readonly string[] | undefined,
  name: string,
): boolean | undefined {
  return columns?.some((column) => sameColumn(column, name));
}

export const columnName = z
  .string()
  .min(1)
  .meta({ description: "A column name in the source data." });

export const schemaRef = z
  .string()
  .meta({ description: "Path or URL of the JSON Schema for this file, for editor completion." });

export const scalar = z.union([z.string(), z.number(), z.boolean()]);

export const timeGrain = z.enum(TIME_GRAINS).meta({ id: "TimeGrain" });
export type TimeGrain = z.infer<typeof timeGrain>;

export const periodRange = z.enum(PERIOD_RANGES).meta({ id: "PeriodRange" });
export type PeriodRange = z.infer<typeof periodRange>;

export const weekday = z.enum(WEEKDAYS).meta({ id: "Weekday" });
export type Weekday = z.infer<typeof weekday>;

/** A month and day that starts a quarter or year bucket; 29 to 31 don't exist every month. */
export const monthDay = z
  .string()
  .regex(/^(0[1-9]|1[0-2])-(0[1-9]|1[0-9]|2[0-8])$/, {
    error: "must be MM-DD with a day from 01 to 28, such as 02-01",
  })
  .meta({ description: 'Where a quarter or year bucket begins, such as "02-01".' });

/** Where week, quarter and year buckets begin. */
export interface Anchors {
  week: Weekday;
  quarter: string;
  year: string;
}
export const DEFAULT_ANCHORS: Anchors = { week: "monday", quarter: "01-01", year: "01-01" };

/** A grain with its anchor resolved: weeks by a weekday, quarters and years by a month-day. */
export type ResolvedGrain =
  | { unit: "day" | "month" }
  | { unit: "week"; anchor: Weekday }
  | { unit: "quarter" | "year"; anchor: string };

export const grainSchema = z
  .union([
    timeGrain,
    z
      .strictObject({
        unit: timeGrain,
        anchor: z.union([weekday, monthDay]).optional().meta({
          description:
            'Overrides the project anchor: a weekday for weeks, MM-DD for quarters and years, such as "07-01" for a year from July 1.',
        }),
      })
      .superRefine((g, ctx) => {
        if (g.anchor === undefined) return;
        const isWeekday = (WEEKDAYS as readonly string[]).includes(g.anchor);
        const fits =
          g.unit === "week"
            ? isWeekday
            : g.unit === "quarter" || g.unit === "year"
              ? !isWeekday
              : false;
        if (!fits) {
          ctx.addIssue(
            customIssue(
              "HM3007",
              ["anchor"],
              g.unit === "day" || g.unit === "month"
                ? `${g.unit} buckets have no anchor; remove "anchor"`
                : `a ${g.unit} anchor is ${g.unit === "week" ? "a weekday, such as sunday" : "MM-DD, such as 02-01"}`,
            ),
          );
        }
      }),
  ])
  .meta({
    id: "Grain",
    description:
      'A bucket unit, such as "month", or {unit: year, anchor: 02-01} to override the project anchors.',
  });
export type Grain = z.infer<typeof grainSchema>;

/**
 * Grains a card or a grain filter switches between: two to six. check resolves them at the project
 * anchors and rejects two that make the same buckets (HM3007).
 */
export const grainOptions = z.array(grainSchema).min(2).max(6);

const isoDay = z.iso.date();

export const rangeSchema = z
  .union([
    periodRange,
    z
      .strictObject({
        start: isoDay.meta({ description: "First local date, inclusive." }),
        end: isoDay.meta({ description: "Local date after the last, exclusive." }),
      })
      .superRefine((r, ctx) => {
        if (r.start >= r.end) {
          ctx.addIssue(customIssue("HM3005", ["end"], "the range ends before it starts"));
        }
      }),
    z.strictObject({
      last: z.number().int().min(1).max(3660),
      unit: timeGrain,
    }),
    z.strictObject({ to_date: timeGrain }),
    z.strictObject({ last_complete: timeGrain }),
  ])
  .meta({
    id: "Range",
    description:
      'A date range [start, end) in the project time zone: {start: 2026-02-01, end: 2026-11-01}, or a shorthand resolved at the as-of date: {last: 30, unit: day}, {to_date: quarter}, {last_complete: month}, or a named range such as "last_12_months".',
  });
export type RangeSpec = z.infer<typeof rangeSchema>;

export const COMPARISONS = ["previous_period", "previous_year", "none"] as const;
export const comparison = z
  .union([
    z.enum(COMPARISONS),
    z.strictObject({
      shift: z.strictObject({
        unit: timeGrain,
        by: z
          .number()
          .int()
          .refine((n) => n !== 0, { error: "must not be 0" })
          .meta({
            description:
              "Units to move the first and last day by; negative is earlier. The moved window must stay within 0001-01-01 to 9998-12-31.",
            not: { const: 0 },
          }),
      }),
    }),
  ])
  .meta({
    id: "Comparison",
    description:
      "previous_period: the previous calendar unit for calendar ranges (October vs September; to-date ranges compare the same elapsed span), or the same length just before for rolling ranges (last N days, last 12 months). previous_year: the same span one year earlier. {shift: {unit: week, by: -1}}: the range moved by whole units. none: no comparison.",
  });
export type Comparison = z.infer<typeof comparison>;

const CURRENCIES = new Set(Intl.supportedValuesOf("currency"));

/** An ISO 4217 code that Intl.NumberFormat can format, such as USD. */
export const currencyCode = z
  .string()
  .refine((c) => CURRENCIES.has(c), { error: "must be an ISO 4217 currency code, such as USD" });

/**
 * A project-relative path with forward slashes and without "." segments, empty segments or a
 * leading "./", so equivalent spellings compare equal. ".." is kept; the config rejects it.
 */
export function normalizePath(file: string): string {
  const parts: string[] = [];
  for (const part of file.replaceAll("\\", "/").split("/")) {
    if (part === "" || part === ".") continue;
    parts.push(part);
  }
  return parts.join("/");
}

/** Records a Hatchmark diagnostic code on a custom Zod issue, read back by the issue mapper. */
export function customIssue(
  code: "HM3001" | "HM3005" | "HM3007",
  path: (string | number)[],
  message: string,
): { code: "custom"; path: (string | number)[]; message: string; params: { hatchmark: string } } {
  return { code: "custom", path, message, params: { hatchmark: code } };
}

/** Characters DuckDB expands as a glob in a file path (HM2016). */
export const GLOB_CHARACTERS = /[*?[]/;
