/**
 * Every diagnostic code Hatchmark can emit. Codes are stable across releases: a code is never
 * reused for a different problem, and a retired code stays listed with its last meaning.
 *
 * Ranges: HM1xxx files and JSON syntax, HM2xxx references between files and to data,
 * HM3xxx spec shape (schema), HM4xxx data rules, HM5xxx design rules, HM9xxx internal errors.
 */
export const CODES = {
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
      "A dashboard select filter must apply to every source a block reads. If a ratio's numerator comes from a source with the filter column and its denominator from one without, the block would divide filtered rows by unfiltered rows. Hatchmark knows the columns of CSV sources from their header; for other sources it cannot confirm the column yet and reports this too. Keep such metrics in separate blocks, or drop the filter.",
  },
  HM2014: {
    title: "CSV header too long",
    explanation:
      'The first record of a CSV source is longer than 16 MiB, so Hatchmark does not read it as column names rather than guess from part of it. This usually means the delimiter or quoting is wrong. Fix the file, set the source\'s delimiter, or set "header": false.',
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
      "Two properties that cannot be used together are both set, or a combination of values is not supported.",
  },
  HM4001: {
    title: "percent of total on a non-additive metric",
    explanation:
      "A share of the total only makes sense when the parts add up to the total. Averages, distinct counts, medians, ratios and SQL metrics declared additive: false do not. Remove the metric from percentOfTotal, or show the additive metric it is built from.",
  },
} as const satisfies Record<string, { title: string; explanation: string }>;

export type DiagnosticCode = keyof typeof CODES;

export function docsCommand(code: DiagnosticCode): string {
  return `hatchmark explain ${code}`;
}

export function isDiagnosticCode(value: string): value is DiagnosticCode {
  return Object.hasOwn(CODES, value);
}
