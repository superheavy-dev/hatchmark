# How Hatchmark computes numbers

Every number on a page comes from one query plan, compiled from the specs and run by an executor
(DuckDB for `hatchmark build`). This page defines what those numbers mean. The tests in
`test/node/` check each rule against plain SQL written independently of the engine.

## Time

- **Time zone.** Rows are placed in time in hatchmark.json's `timezone`. A `TIMESTAMP WITH TIME
ZONE` value is converted to it. A timestamp without an offset (`2026-01-31 18:30:00`) is read in
  the source's `timezone`, or as UTC when the source sets none, and converted; a non-UTC project
  gets note HM4016 for such a source. A `DATE` is a calendar date and is used as it is.
- **Windows.** A range is a span of calendar dates in that time zone, start inclusive and
  end exclusive: `{"start", "end"}` dates, a shorthand (`{"last": 30, "unit": "day"}`,
  `{"to_date": "quarter"}`, `{"last_complete": "month"}`) or a named alias of one
  (`last_30_days`). A comparison is the range shifted by whole units (`previous_period`,
  `previous_year` or `{"shift": {"unit": "week", "by": -1}}`), with days clamped to the target
  month. `resolveRange()` in `src/compiler/windows.ts` is the definition of every range and
  comparison. A row is in the window when its local time is.
- **Horizons.** A source is complete through its horizon: by default the latest value of the time
  column a metric uses, over all rows, ignoring filters. A timestamp gives that instant; a date is
  complete through the end of that day. The source's `freshness` can measure another column, take
  a lag off, or fix the date (project.md). Each build's DashboardData lists the horizons it used.
- **latest_data** resolves once per dashboard, before any query runs, to the newest horizon the
  dashboard reads; the as-of date is its last local date, and every block's window ends on that
  day. `latest_common_data` takes the oldest horizon instead, so no source ends before the others.
  A source with `{"through": "as_of"}` doesn't vote; with no source left to vote, the build fails
  with HM4011. Data checks warn when a source is more than a day behind the as-of (HM4010), when a
  column's newest value is more than a day after the build machine's clock (HM4012; the clock never
  changes the output), and when a block's window starts after every source it reads ends (HM4013). These data
  checks run wherever data is read: `hatchmark build`, `check --sql` and `explain`; a plain
  `hatchmark check` reads no data.
- **Buckets.** Time series bucket by local date; weeks start on the week anchor, and quarters and
  years on their `MM-DD` anchors (hatchmark.json `anchors`, or a block's `{"unit", "anchor"}`
  grain). The axis lists every
  bucket of the window, empty ones included. The first and last buckets may be partial.

## Filters

Metric filters and dashboard select filters compare a column with a value:

- A value compared with a date or timestamp column is strict ISO 8601; anything else is HM3009.
  A day, zero-padded `YYYY-MM-DD`, compares the row's local calendar date: `eq "2026-01-31"`
  matches the whole day, `between "2026-01-01"` and `"2026-01-31"` includes all of January 31,
  and `gt "2026-01-31"` starts on February 1. A date-time (`YYYY-MM-DDTHH:MM`, optional seconds
  and up to 6 decimals) with `Z` or an offset such as `-05:00` is that exact instant; without one
  it is wall-clock time in the project time zone.
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

Integer and DECIMAL columns aggregate exactly in DuckDB and are converted to a JavaScript number
once; integers are exact up to 2^53 (about 9 quadrillion). Floating-point columns (CSV numbers
with a decimal point) sum with compensated (Kahan-Babuska) summation in file order, and an
average is that sum divided by the count. Every floating-point result is rounded to 15
significant digits, and tiny values such as 4e-10 are never rounded away. Because the values are
added in the same order on every run, a total is the same, byte for byte, however many threads
DuckDB uses. File order is fixed when the source is loaded: every source, Parquet included, is read
once into a table that keeps the file's row order, and each row gets its place in that table. It
never comes from a column in the data, and column names starting with `__hm_` are reserved for
Hatchmark (HM2017). A source path with glob characters (`*`, `?`, `[`) is a check error
(HM2016), since DuckDB would read it as several files. Should the executor still be given several
files, it takes their rows file by file, with the paths sorted by their UTF-8 bytes.

Floating-point sums are accurate for values within ±1e15. When a metric sums or averages a
floating-point column that holds a larger value, run warns with HM4004: the result is still the
same on every run, but small values next to very large ones may be lost. Store such values in a
smaller unit, as DECIMAL in Parquet, or in separate columns.

Fifteen significant digits hold cents only below 1e13 (ten trillion). When the value a block
shows for a floating-point sum or average (the average itself, not the sum behind it) reaches
±1e13 in any row, time bucket or total, run also warns with HM4004, naming the metric and the
block. Both checks leave out NaN and infinite values. A table whose rows stay below 1e13 still warns when its total reaches it.
Store such values in a larger unit, such as thousands, or as DECIMAL in Parquet.

SQL metrics run on one thread, since their SQL cannot be rewritten. A SQL result that is not a
number (division by zero) is empty, never 0.

## Plans

A dashboard has at most one period filter (HM3007): the dashboard's period and every block read
the range it selects. Each planned query carries its source's file and reader options, so
changing a path or a delimiter changes the query's id and the plan hash. A time bar shows every
bucket in order, so it takes no sort or limit (HM3007).

## Reading files

The DuckDB executor reads CSV with the source's delimiter and header settings, `"` as quote and
escape, and column types inferred from every row, not a sample. JSON reads the configured format.
Parquet carries its own types. Numbers with leading zeros, such as ZIP codes, stay text.
