import { z } from "zod";

/** Metric, source, block and filter names: lowercase snake_case, so they are safe in SQL and URLs. */
export const IDENTIFIER_PATTERN = /^[a-z][a-z0-9_]*$/;

export const identifier = z
  .string()
  .regex(IDENTIFIER_PATTERN, { error: "must be lowercase snake_case, such as net_revenue" });

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
export const comparison = z.enum(COMPARISONS);
export type Comparison = z.infer<typeof comparison>;

/** Records a Hatchmark diagnostic code on a custom Zod issue, read back by the issue mapper. */
export function customIssue(
  code: "HM3001" | "HM3007",
  path: (string | number)[],
  message: string,
): { code: "custom"; path: (string | number)[]; message: string; params: { hatchmark: string } } {
  return { code: "custom", path, message, params: { hatchmark: code } };
}
