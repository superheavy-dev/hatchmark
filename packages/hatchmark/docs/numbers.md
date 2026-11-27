# How Hatchmark computes numbers

Every number on a page comes from one query plan, compiled from the specs and run by an executor
(DuckDB for `hatchmark build`). This page defines what those numbers mean. The tests in
`test/node/` check each rule against plain SQL written independently of the engine.

## Time

- **Time zone.** Rows are placed in time in hatchmark.json's `timezone`. A `TIMESTAMP WITH TIME
  ZONE` value is converted to it. A timestamp without an offset (`2026-01-31 18:30:00`) is read as
  UTC and converted. A `DATE` is a calendar date and is used as it is.
- **Windows.** A range such as `last_12_months` is a span of calendar dates in that time zone, start
  inclusive and end exclusive; `windowBounds()` in `src/compiler/windows.ts` is the definition of
  every range and comparison. A row is in the window when its local time is.
- **latest_data** resolves once per dashboard, before any query runs: the last local date in any
  time column the dashboard reads, across all its sources. Every block's window ends on that day.
  If one source's data ends earlier, its short windows are partial.
- **Buckets.** Time series bucket by local date; weeks start on `weekStart`. The axis lists every
  bucket of the window, empty ones included. The first and last buckets may be partial.

## Filters

Metric filters and dashboard select filters compare a column with a value:

- A date (`YYYY-MM-DD`) compared with a timestamp column compares the row's local calendar date:
  `eq "2026-01-31"` matches the whole day, `between "2026-01-01"` and `"2026-01-31"` includes all of
  January 31, and `gt "2026-01-31"` starts on February 1. A value with a time of day compares the
  local wall-clock time.
- `neq` and `not_in` keep rows whose column is null: "not West" includes rows whose region is
  unknown. SQL's `<>` would drop them; Hatchmark uses `IS DISTINCT FROM`. To drop them too, add a
  `not_null` filter.
- `eq`, `in`, `gt`, `gte`, `lt`, `lte` and `between` never match null.
- Column names match case-insensitively for ASCII letters, as DuckDB resolves them.

## Groups, totals and empty values

- **Null is a group.** Rows whose grouping column is null form their own row or series, shown as
  "(empty)". It is never confused with a total row.
- **Totals are recomputed from rows,** never summed: SQL `GROUP BY ROLLUP`'s grand total. A distinct
  count's total counts each customer once; a ratio's total divides the two totals.
- **Ratios** divide two metrics, possibly from different sources. Rows match on equal group values,
  null included. Division by zero or by an empty value is empty (null, shown as "—").
- **avg** is sum over count of non-null values, so it stays right when groups are combined.
- **limit** keeps the first rows after sorting. It never counts the total row, and the total still
  covers every row.
- **Empty groups and buckets.** Sums and counts of no rows are 0; other aggregates (distinct counts,
  averages, ratios, medians, min, max) of no rows are empty.
- **percentOfTotal** is a row's share of the grand total, for additive metrics only (HM4001).
  `"additive": true` on a SQL metric is checked when a table has a total: if the rows do not add up
  to the total, build warns with HM4003.
- **KPI change.** `changePct` is the relative change, `(value - previous) / |previous|`, empty when
  the previous value is 0 or empty. For percent-formatted metrics it is the difference in
  percentage points instead (0.012 = +1.2 pp).

## Precision

DuckDB computes every aggregate at full precision and the result is converted to a JavaScript
number once. Sums of floating-point columns (CSV numbers with a decimal point) are added as exact
decimals with 9 decimal places, so a total of cents is exact and the same on every run. Integers
are exact up to 2^53 (about 9 quadrillion).

## Reading files

The DuckDB executor reads CSV with the source's delimiter and header settings, `"` as quote and
escape, and column types inferred from every row, not a sample. JSON reads the configured format.
Parquet carries its own types. Numbers with leading zeros, such as ZIP codes, stay text.
