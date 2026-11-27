import { z } from "zod";

/** Metric, source, block and filter names: lowercase snake_case, so they are safe in SQL and URLs. */
export const IDENTIFIER_PATTERN = /^[a-z][a-z0-9_]*$/;

export const identifier = z
  .string()
  .regex(IDENTIFIER_PATTERN, { error: "must be lowercase snake_case, such as net_revenue" });

/** Folds ASCII letters to lowercase, as DuckDB does when it matches identifiers. */
function foldColumn(name: string): string {
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

export const TIME_GRAINS = ["day", "week", "month", "quarter", "year"] as const;
export const timeGrain = z.enum(TIME_GRAINS);
export type TimeGrain = z.infer<typeof timeGrain>;

export const PERIOD_RANGES = [
  "last_7_days",
  "last_30_days",
  "last_90_days",
  "last_12_months",
  "month_to_date",
  "quarter_to_date",
  "year_to_date",
  "last_complete_month",
  "last_complete_quarter",
  "last_complete_year",
  "all_time",
] as const;
export const periodRange = z.enum(PERIOD_RANGES);
export type PeriodRange = z.infer<typeof periodRange>;

export const COMPARISONS = ["previous_period", "previous_year", "none"] as const;
export const comparison = z.enum(COMPARISONS).meta({
  description:
    "previous_period: the previous calendar unit for calendar ranges (October vs September; to-date ranges compare the same elapsed span), or the same length just before for rolling ranges (last N days, last 12 months). previous_year: the same span one year earlier. none: no comparison.",
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
  code: "HM3001" | "HM3007",
  path: (string | number)[],
  message: string,
): { code: "custom"; path: (string | number)[]; message: string; params: { hatchmark: string } } {
  return { code: "custom", path, message, params: { hatchmark: code } };
}
