/**
 * Every diagnostic code Hatchmark can emit. Codes are stable across releases: a code is never
 * reused for a different problem, and a retired code stays listed with its last meaning.
 *
 * Ranges: HM0xxx command line usage, HM1xxx files and JSON syntax, HM2xxx references between files and to data,
 * HM3xxx spec shape (schema), HM4xxx data rules, HM5xxx design rules, HM9xxx internal errors.
 */
export const CODES = {
  HM0001: {
    title: "unknown command",
    explanation:
      "The first word after hatchmark is not a command. Run hatchmark --help for the list.",
  },
  HM0002: {
    title: "invalid option or argument",
    explanation:
      "An option is unknown, takes a value that is not allowed, or an argument is not expected. Run hatchmark <command> --help for the options and an example.",
  },
  HM0003: {
    title: "missing argument",
    explanation:
      "The command needs an argument that was not given. Run hatchmark <command> --help.",
  },
  HM0004: {
    title: "would overwrite existing files",
    explanation:
      "hatchmark init found files it would write already in the target directory, and wrote nothing. The diagnostic lists them. Pass --force to overwrite them, or choose another directory. AGENTS.md and .gitignore are always merged, never overwritten.",
  },
  HM0005: {
    title: "unbalanced AGENTS.md markers",
    explanation:
      "hatchmark init manages one block in AGENTS.md between a <!-- hatchmark:start --> line and a <!-- hatchmark:end --> line. It found a different number of markers, or the end before the start, and left AGENTS.md alone rather than guess. The diagnostic lists the marker lines. Keep exactly one start line before one end line, or delete every marker line so init appends a fresh block.",
  },
  HM1001: {
    title: "file cannot be read",
    explanation:
      "Hatchmark could not read a file it expected. Check that the path exists inside the project and that the process can read it.",
  },
  HM1002: {
    title: "invalid JSON syntax",
    explanation:
      "Spec files are strict JSON (RFC 8259): double-quoted keys and strings, no comments, no trailing commas. The diagnostic points at the first character that cannot be parsed and, when the repair is unambiguous, carries a safe text fix.",
  },
  HM1003: {
    title: "duplicate key",
    explanation:
      "An object has the same key twice. JSON parsers disagree on which one wins, so Hatchmark rejects the file. Keep one of the two and delete the other.",
  },
  HM1004: {
    title: "invalid file name",
    explanation:
      "Metric and dashboard names come from their file names, so a file name must be lowercase snake_case (metrics/net_revenue.json). Dashboard names may also contain hyphens, since they become URL paths. Rename the file.",
  },
  HM1005: {
    title: "project config not found",
    explanation:
      "No hatchmark.json was found in the working directory. Run the command from the project root, pass --cwd, or create a project with hatchmark init.",
  },
  HM2001: {
    title: "unknown source",
    explanation:
      "A metric names a table that is not a key of sources in hatchmark.json. Add the source, or use one of the listed names.",
  },
  HM2003: {
    title: "unknown metric",
    explanation:
      "A dashboard, ratio metric or text reference names a metric with no file under metrics/. The name is the file name without .json. Create the metric file or use one of the listed names.",
  },
  HM2004: {
    title: "circular metric reference",
    explanation:
      "Ratio metrics refer to other metrics, and the chain of references loops back to where it started. Point one of them at an aggregate metric instead.",
  },
  HM2005: {
    title: "metric has no time column",
    explanation:
      'This block needs to place rows in time (a time series, a time-bucketed bar chart, or a KPI comparison), but the metric has no time field. Add "time": "<date column>" to the metric, or set compare to "none" on a KPI. A ratio metric uses the time columns of its numerator and denominator.',
  },
  HM2006: {
    title: "percent of total names a metric the table does not show",
    explanation: "Every name in percentOfTotal must also be listed in the table's metrics.",
  },
  HM2007: {
    title: "invalid metric reference in text",
    explanation:
      "Text blocks insert metric values with {{metric}}, {{metric.previous}}, {{metric.change}} or {{metric.change_pct}}. The reference is malformed or uses an unknown field.",
  },
  HM2008: {
    title: "duplicate id",
    explanation:
      "Two blocks or two filters in one dashboard have the same id. Ids must be unique within a dashboard.",
  },
  HM2009: {
    title: "sort key not shown",
    explanation: "sort.by must be one of the block's metrics or one of its by columns.",
  },
  HM2010: {
    title: "data file not found",
    explanation:
      "A source in hatchmark.json points at a file that does not exist. Paths are relative to hatchmark.json.",
  },
  HM2011: {
    title: "comparison is turned off",
    explanation:
      'A text reference asks for {{metric.previous}}, {{metric.change}} or {{metric.change_pct}}, but the dashboard\'s period.compare is "none", so there is no comparison period to read. Set period.compare, or insert only {{metric}}.',
  },
  HM2012: {
    title: "ratio sides placed in time differently",
    explanation:
      "One side of a ratio has a time column and the other does not, so a dashboard period would window the numerator and the denominator differently and the ratio would mix periods. Give both sides a time column, or neither.",
  },
  HM2013: {
    title: "filter applies to only some sources of a block",
    explanation:
      "A dashboard select filter must apply to every source a block reads. If a ratio's numerator comes from a source with the filter column and its denominator from one without, the block would divide filtered rows by unfiltered rows. Hatchmark reads column names from CSV headers and, when the host can read the file (the CLI uses DuckDB), from Parquet and JSON files; when it cannot read them it reports this too. Column names match case-insensitively, as DuckDB resolves them. Keep such metrics in separate blocks, or drop the filter.",
  },
  HM2014: {
    title: "CSV header too long",
    explanation:
      'The first record of a CSV source is longer than 16 MiB, so Hatchmark does not read it as column names rather than guess from part of it. This usually means the delimiter or quoting is wrong. Fix the file, set the source\'s delimiter, or set "header": false.',
  },
  HM2015: {
    title: "data cannot be queried",
    explanation:
      "Running a dashboard's queries failed: a data file cannot be read, a column a metric names is not in the data, a time column is not a date or timestamp, a filter is bound to a value it cannot take, or latest_data found no dates because the time columns are empty. The message carries the cause. Fix the data or the metric, or set period.asOf to a fixed date.",
  },
  HM3001: {
    title: "missing required property",
    explanation:
      "A required property is missing. In hatchmark.json every setting is required so the file states what will happen; the fix adds the default value and is safe to apply.",
  },
  HM3002: {
    title: "unknown property",
    explanation:
      "The object has a property the spec does not define. Spec objects are closed so typos fail loudly instead of being ignored. The valid properties are listed.",
  },
  HM3003: {
    title: "wrong type",
    explanation: "The value has the wrong JSON type, such as a number where a string is expected.",
  },
  HM3004: {
    title: "invalid value",
    explanation:
      "The value is not one of the allowed options, which are listed. A fix is offered for a likely typo; it is marked safe only when the difference is letter case.",
  },
  HM3005: {
    title: "value out of range or malformed",
    explanation:
      "The value has the right type but breaks a limit: a length, a range, a pattern or a format.",
  },
  HM3007: {
    title: "conflicting properties",
    explanation:
      "Two properties that cannot be used together are both set, or a combination of values is not supported, such as sort or limit on a time bar, or two period filters on one dashboard.",
  },
  HM3008: {
    title: "list default on a single-value select",
    explanation:
      'A select filter without "multiple": true picks one value, but its default is a list, so the page would open on a state the filter cannot show. Write the one value without brackets, set "multiple": true to allow several values, or remove the default to show everything. A one-item list has a safe fix that unwraps it.',
  },
  HM3009: {
    title: "invalid date or time in a filter",
    explanation:
      'A filter on a metric\'s time column compares with a date or a time, written in strict ISO 8601 so it means the same everywhere. A day is YYYY-MM-DD, zero-padded ("2026-02-01", not "2026-2-1"), and means that whole day in the project time zone. A time is YYYY-MM-DDTHH:MM or YYYY-MM-DDTHH:MM:SS with up to 6 decimals: with Z or an offset such as -05:00 it is that exact moment, without one it is wall-clock time in the project time zone. The fix rewrites a near miss (unpadded parts, a space instead of T) into the strict form; read it before applying.',
  },
  HM4001: {
    title: "percent of total on a non-additive metric",
    explanation:
      "A share of the total only makes sense when the parts add up to the total. Averages, distinct counts, medians, ratios and SQL metrics declared additive: false do not. Remove the metric from percentOfTotal, or show the additive metric it is built from.",
  },
  HM4002: {
    title: "block type not built yet",
    explanation:
      "This version of Hatchmark builds kpi, line, area, bar and table blocks. bar_list and text blocks are valid specs but are not built yet, so the dashboard is built without them and they do not appear on the page. Use a bar block with by and a limit instead of bar_list, or keep the block and it will appear once its type is built.",
  },
  HM4003: {
    title: "additive metric does not add up",
    explanation:
      'A SQL metric declares "additive": true, but in a table the rows add up to a different number than the total, which Hatchmark recomputes from all rows. The total is still right; a percent of total or an in-browser filter that sums rows would not be. Distinct counts, averages and ratios are not additive: set "additive": false, or rewrite the SQL as a sum or count.',
  },
  HM4004: {
    title: "float values beyond the accuracy limit",
    explanation:
      "A metric sums a floating-point column (DOUBLE or FLOAT, such as CSV numbers with a decimal point) that holds a value larger than 1e15 in magnitude. Hatchmark adds floats in a fixed order with compensated summation and shows 15 significant digits, which is exact for values within ±1e15 but can lose small values next to very large ones, so the result may be inaccurate (though still the same on every run). Store the values in a smaller unit, as DECIMAL (Parquet), or keep very large and very small values in separate columns.",
  },
  HM9001: {
    title: "internal error",
    explanation:
      "Hatchmark hit a bug, not a problem in your files. The details are on stderr; please open an issue at https://github.com/superheavy-dev/hatchmark/issues with them.",
  },
} as const satisfies Record<string, { title: string; explanation: string }>;

export type DiagnosticCode = keyof typeof CODES;

export function docsCommand(code: DiagnosticCode): string {
  return `hatchmark explain ${code}`;
}

export function isDiagnosticCode(value: string): value is DiagnosticCode {
  return Object.hasOwn(CODES, value);
}
