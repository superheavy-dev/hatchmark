/**
 * Every diagnostic code Hatchmark can emit. Codes are stable across releases: a code is never
 * reused for a different problem, and a retired code stays listed with its last meaning.
 *
 * Ranges: HM0xxx command line usage, HM1xxx files and YAML syntax, HM2xxx references between files and to data,
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
      "hatchmark init found files it would write already in the target directory, and wrote nothing. The diagnostic lists them. Pass --force to overwrite them, or choose another directory. AGENTS.md and .gitignore are always merged, never overwritten. hatchmark build replaces its output directory on every run, so it refuses one that is not empty and holds no _hatchmark/ folder (it did not write it), or one that contains the project. Empty the directory or pass another --out.",
  },
  HM0005: {
    title: "unbalanced AGENTS.md markers",
    explanation:
      "hatchmark init manages one block in AGENTS.md between a <!-- hatchmark:start --> line and a <!-- hatchmark:end --> line. It found a different number of markers, or the end before the start, and left AGENTS.md alone rather than guess. The diagnostic lists the marker lines. Keep exactly one start line before one end line, or delete every marker line so init appends a fresh block.",
  },
  HM0006: {
    title: "dev server cannot listen",
    explanation:
      "hatchmark dev could not listen on the port and host it was given: another process uses the port, or the host is not an address of this machine. Stop the other process, or pass another --port or --host. Without --port, dev tries the next free port on its own.",
  },
  HM0007: {
    title: "dev server cannot watch the project",
    explanation:
      "hatchmark dev starts only once it watches every file of the project, so that no edit is missed. The watcher did not finish its first scan within 15 seconds, usually because a directory in the project cannot be read; the diagnostic names the file system error when there is one. Make every directory readable, or move what cannot be read out of the project, and run dev again.",
  },
  HM1001: {
    title: "file cannot be read",
    explanation:
      "Hatchmark could not read a file it expected. Check that the path exists inside the project and that the process can read it.",
  },
  HM1002: {
    title: "invalid YAML syntax",
    explanation:
      'Spec files are YAML 1.2, one document per file, read with the core schema. Indent with spaces, never tabs; items of one mapping or list start at the same column; a value that contains ": " or starts with a character such as {, [, *, & or ! needs quotes. The diagnostic points at the first place that cannot be parsed.',
  },
  HM1003: {
    title: "duplicate key",
    explanation:
      "A mapping has the same key twice. YAML forbids it and parsers disagree on which one wins, so Hatchmark rejects the file. Keep one of the two and delete the other.",
  },
  HM1004: {
    title: "invalid file name",
    explanation:
      "Metric and dashboard names come from their file names, so a file name must be lowercase snake_case (metrics/net_revenue.yaml), and a metric may not be named and, or, not or null, which are operators in formulas. Dashboard names may also contain hyphens, since they become URL paths. Rename the file.",
  },
  HM1005: {
    title: "project config not found",
    explanation:
      "No hatchmark.yaml was found in the working directory. Run the command from the project root, pass --cwd, or create a project with hatchmark init.",
  },
  HM1006: {
    title: "YAML feature not allowed in spec files",
    explanation:
      "Spec files use plain YAML so every value reads the same in every tool: anchors (&name), aliases (*name), merge keys (<<), tags other than the core ones (!!str, !!int, !!float, !!bool, !!null, !!map, !!seq), a core tag that does not fit its value, keys that are not strings, a %YAML directive other than 1.2 and a second document after --- are errors. So is a number not written as JSON writes it (0123, +1, 0x10, .5, .inf): quote it to keep it a string, as the safe fix does. SQL must be a literal block scalar (sql: |), because a folded or multi-line plain value joins lines with spaces and a -- comment would hide the lines after it. Write the value out in full where it is used, and quote a key that YAML would read as a number, boolean or null.",
  },
  HM1007: {
    title: "spec file is not YAML",
    explanation:
      "Spec files are YAML with the .yaml extension: hatchmark.yaml, metrics/<name>.yaml, dashboards/<name>.yaml and segments/<name>.yaml. A .json or .yml file in their place is not read, so the diagnostic names the .yaml file Hatchmark expects. Write the spec as YAML in that file and delete the old one.",
  },
  HM1008: {
    title: "comment after an unquoted value",
    explanation:
      'In YAML, a # after a space or tab starts a comment, so value: Store #12 is read as Store. A filter value, a select default or a one-line sql followed by a comment on the same line gets this warning, because a store or order number, or a SQL expression, can contain #. Quote the value to keep the #, such as value: "Store #12", write SQL as a literal block (sql: |), or move the comment to its own line.',
  },
  HM2001: {
    title: "unknown source",
    explanation:
      "A metric names a table that is not a key of sources in hatchmark.yaml. Add the source, or use one of the listed names.",
  },
  HM2003: {
    title: "unknown metric",
    explanation:
      "A dashboard, ratio metric or text reference names a metric with no file under metrics/. The name is the file name without .yaml. Create the metric file or use one of the listed names.",
  },
  HM2004: {
    title: "circular metric reference",
    explanation:
      "Ratio, formula and per_entity metrics refer to other metrics, and the chain of references loops back to where it started. Point one of them at an aggregate metric instead.",
  },
  HM2005: {
    title: "metric has no time column",
    explanation:
      'This block needs to place rows in time (a time series, a time-bucketed bar chart, or a KPI comparison), but the metric has no time field. Add time: <date column> to the metric, or set compare to "none" on a KPI. A ratio metric uses the time columns of its numerator and denominator.',
  },
  HM2006: {
    title: "table option names a metric the table does not show",
    explanation:
      "Every name in a table's percentOfTotal or bars must also be listed in the table's metrics.",
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
      "A source in hatchmark.yaml points at a file that does not exist. Paths are relative to hatchmark.yaml.",
  },
  HM2011: {
    title: "comparison is turned off",
    explanation:
      'A text reference asks for {{metric.previous}}, {{metric.change}} or {{metric.change_pct}}, but the dashboard\'s period.compare is "none", so there is no comparison period to read. Set period.compare, or insert only {{metric}}.',
  },
  HM2012: {
    title: "ratio or formula operands placed in time differently",
    explanation:
      "One operand of a ratio or formula is placed in time (it has a time column, or is read at an instant) and another is not, so a dashboard period would window them differently and the result would mix periods. Give every operand a time column, or none.",
  },
  HM2013: {
    title: "filter applies to only some sources of a block",
    explanation:
      "A dashboard select filter must apply to every source a block reads, including every source a ratio, formula or lookup reaches. If a ratio's numerator comes from a source with the filter column and its denominator from one without, the block would divide filtered rows by unfiltered rows. Hatchmark reads column names from CSV headers and, when the host can read the file (the CLI uses DuckDB), from Parquet and JSON files; when it cannot read them it reports this too. Column names match case-insensitively, as DuckDB resolves them. Keep such metrics in separate blocks, or drop the filter.",
  },
  HM2014: {
    title: "CSV header too long",
    explanation:
      "The first record of a CSV source is longer than 16 MiB, so Hatchmark does not read it as column names rather than guess from part of it. This usually means the delimiter or quoting is wrong. Fix the file, set the source's delimiter, or set header: false.",
  },
  HM2015: {
    title: "data cannot be queried",
    explanation:
      "Running a dashboard's queries failed: a data file cannot be read, a column a metric names is not in the data, a time column is not a date or timestamp, a filter is bound to a value it cannot take, or latest_data found no dates because the time columns are empty. The message carries the cause. Fix the data or the metric, or set period.asOf to a fixed date.",
  },
  HM2016: {
    title: "glob characters in a source path",
    explanation:
      "A source path in hatchmark.yaml contains *, ? or [. DuckDB reads such a path as a glob pattern, so it could read several files, or other files than the one named, even when a file with exactly that name exists. Hatchmark reads one file per source and does not escape these characters, so rename the file. The fix suggests a name with _ in their place, and it is unsafe because the file itself must be renamed too. Sources that read several files will come later as an explicit field, not as a pattern in path.",
  },
  HM2017: {
    title: "reserved column name",
    explanation:
      "A column of a source's data file has a name starting with __hm_ (in any case). Hatchmark adds columns with that prefix when it loads a source, such as the row's place in the file, which keeps sums of floating-point values in a fixed order, so a source column may not use it. Rename the column in the data file.",
  },
  HM2018: {
    title: "column not in source",
    explanation:
      "A metric, lookup, target or segment names a column the source does not have. Hatchmark knows the columns of a file source when it can read them (see HM2013), and of lookup sources from their parts (lookup columns read as <table>.<column>); names match case-insensitively for ASCII letters, as in DuckDB.",
  },
  HM2019: {
    title: "lookup of a lookup",
    explanation:
      "A lookup source's from or lookup table is itself a lookup source. Lookups join file sources only, one level deep: point from at the base file source and list every table to join in one lookup source.",
  },
  HM2020: {
    title: "unknown name in an expression",
    explanation:
      "A formula refers to a metric that has no file under metrics/, or a per_entity where or expr uses a name other than current and prior. The diagnostic points at the name and suggests the closest one.",
  },
  HM2021: {
    title: "unknown segment",
    explanation:
      "A metric, target or test names a segment with no file under segments/. The name is the file name without .yaml.",
  },
  HM2022: {
    title: "unknown target",
    explanation:
      "A block's target names an id that none of the block's metrics lists under targets. The id is the target's id in metrics/<name>.yaml, not its label. The diagnostic lists the ids the block's metrics define and suggests the closest one.",
  },
  HM2023: {
    title: "test data for a source the metric does not read",
    explanation:
      "A test's data swaps a source for a fixture file, but the metric does not read that source, directly or through a lookup, ratio, formula, per_entity, segment or in_table filter. The swap would have no effect, so the test would not test what it says. Remove the entry, or name the source the metric reads.",
  },
  HM2024: {
    title: "chart narrower than 3 columns",
    explanation:
      'A line, area, bar, pie, donut or scatter block has "span" 1 or 2. At that width the axis labels, the key and the plot cannot all fit, so Hatchmark draws the chart 3 columns wide anyway and the grid row reflows around it. Set "span" to 3 or more to say what the page will show; the fix sets it to 3 and is safe. Use a kpi block (with sparkline: true for a trend) when the space is meant for one number.',
  },
  HM2026: {
    title: "table grows with the page in a shared row",
    explanation:
      'A table with overflow: page grows as tall as its rows, but this one shares its grid row with other blocks, and a grid row is as tall as its tallest card. Its neighbours stretch to the table\'s height with empty space below their content. Remove "overflow" (a table in a shared row scrolls inside its card by default), or give the table its own row with span: 12.',
  },
  HM2031: {
    title: "height on a table that grows with the page",
    explanation:
      'A table with overflow: page grows as tall as its rows, so a "height" preset on it has no effect. Remove "height" (the fix does, and is safe: the page does not change), or remove "overflow" so the table scrolls inside a card of that height.',
  },
  HM2028: {
    title: "cards side by side with different heights",
    explanation:
      'Cards that sit side by side end level. Charts in one grid row are drawn at the tallest "height" preset among them, and KPIs in one strip at the tallest among the strip\'s KPIs, so a shorter preset is drawn taller on wide screens. Below 1024 px cards stack, and every card, each KPI included, keeps its own preset. Set the same height on every card in the row (the fix sets this one to the height it is drawn at, which also changes how it looks on phones), or give the chart its own row with span: 12. Tables keep their own height.',
  },
  HM2030: {
    title: "filter on a column no source has",
    explanation:
      "A select filter's column, or the columns of a segment in a segment filter, are in none of the sources the dashboard's blocks read, so turning the filter or the segment on would change nothing. Name a column one of the dashboard's sources has, or remove the filter or the segment.",
  },
  HM2029: {
    title: "in_table key of another type",
    explanation:
      "An in_table or not_in_table filter compares a column with another source's key column. Hatchmark compares two integer columns of any width exactly and two text columns as text, and nothing else: converting a number to text, or an integer to a floating-point or decimal number, can make different values match or fail on values that fit their own column. So check rejects any other pair of types and names both. Store both columns with the same type, for example write the key list's ids as integers, or cast one side where the data is produced.",
  },
  HM2025: {
    title: "grain no block switches to",
    explanation:
      "A grain filter offers a grain that no line, area or bar block lists in its grains, so choosing it changes nothing on the page. The filter drives only blocks whose grains include the chosen grain, compared at the project anchors. Add the grain to the blocks that should switch, or remove the option.",
  },
  HM2027: {
    title: "group names a series the chart does not draw",
    explanation:
      'Every series in a block\'s groups must be one the chart draws: a name from the block\'s metrics or, when the block splits, a split value as the chart labels it (null is "(empty)"). Metric names are checked against metrics as an error. Split values come from the data, so build warns when a listed value has no rows under the dashboard\'s filters in any period up to the as-of. A value missing from only some periods is not warned about: the group keeps the colour step of every listed series, so colours stay put while it is missing. When the split holds both empty values and the text "(empty)", a group that lists "(empty)" takes the empty values and build warns about the text.',
  },
  HM2032: {
    title: "diverging map scale off centre",
    explanation:
      "A map block's threshold scale sets a midpoint, which makes it diverging: classes below the midpoint take one hue and classes above it the other. That reads only when both sides have as many classes. With an even number of classes, make the midpoint one of the breaks, the middle one; with an odd number, put it inside the middle class, with as many breaks below it as above. For example breaks [-10, -2, 2, 10] with midpoint 0.",
  },
  HM3001: {
    title: "missing required property",
    explanation:
      "A required property is missing. In hatchmark.yaml every setting is required so the file states what will happen; the fix adds the default value and is safe to apply.",
  },
  HM3002: {
    title: "unknown property",
    explanation:
      "The object has a property the spec does not define. Spec objects are closed so typos fail loudly instead of being ignored. The valid properties are listed.",
  },
  HM3003: {
    title: "wrong type",
    explanation:
      "The value has the wrong type, such as a number where a string is expected. YAML reads an unquoted 2026, 1.5 or true as a number or boolean; where the spec expects a string, the fix quotes the value as written.",
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
      "A select filter without multiple: true picks one value, but its default is a list, so the page would open on a state the filter cannot show. Write the one value without brackets, set multiple: true to allow several values, or remove the default to show everything. A one-item list has a safe fix that unwraps it.",
  },
  HM3009: {
    title: "invalid date or time in a filter",
    explanation:
      'A filter on a metric\'s time column compares with a date or a time, written in strict ISO 8601 so it means the same everywhere. A day is YYYY-MM-DD, zero-padded ("2026-02-01", not "2026-2-1"), and means that whole day in the project time zone. A time is YYYY-MM-DDTHH:MM or YYYY-MM-DDTHH:MM:SS with up to 6 decimals: with Z or an offset such as -05:00 it is that exact moment, without one it is wall-clock time in the project time zone. The fix rewrites a near miss (unpadded parts, a space instead of T) into the strict form; read it before applying.',
  },
  HM3010: {
    title: "expression syntax error",
    explanation:
      "A formula, row expression or per_entity expression cannot be parsed, uses something its kind does not allow (strings and comparisons are row and per_entity only), or puts a condition where a value belongs. Formulas: + - * /, parentheses, numbers, metric names, coalesce, min, max, abs. Row expressions add columns, 'strings', null, comparisons, and, or, not, greatest, least, if, is_null, date_diff and match. per_entity expressions use current and prior. The diagnostic points at the offending characters.",
  },
  HM3011: {
    title: "series in more than one group",
    explanation:
      "A series takes its colour from the one group it belongs to, so it can be listed in only one group, once. Remove the repeat, or merge the groups.",
  },
  HM4001: {
    title: "percent of total on a non-additive metric",
    explanation:
      "A share of the total only makes sense when the parts add up to the total. This covers percentOfTotal in a table, bar or area charts stacked to 100% (stack: percent), and pie and donut blocks. Averages, distinct counts, medians, ratios, non-linear formulas and SQL metrics declared additive: false do not; neither does a formula with a constant term (a + 1000 adds 1,000 to every group but once to the total), nor a sum read with over_time min or max (each group can peak on a different date). Point-in-time sums such as balances do, at one instant. Remove the metric from percentOfTotal, stack it with stack: true or not at all, show it in a bar chart instead of a pie or donut, or show the additive metric it is built from.",
  },
  HM4002: {
    title: "block type not built yet",
    explanation:
      "This version of Hatchmark builds kpi, line, area, bar, pie, donut, table, scatter and map blocks. bar_list and text blocks are valid specs but are not built yet, so the dashboard is built without them and they do not appear on the page. Use a bar block with by and a limit instead of bar_list, or keep the block and it will appear once its type is built.",
  },
  HM4003: {
    title: "additive metric does not add up",
    explanation:
      "A SQL metric declares additive: true, but in a table the rows add up to a different number than the total, which Hatchmark recomputes from all rows. The total is still right; a percent of total or an in-browser filter that sums rows would not be. Distinct counts, averages and ratios are not additive: set additive: false, or rewrite the SQL as a sum or count.",
  },
  HM4004: {
    title: "float values beyond the accuracy limit",
    explanation:
      "Floating-point columns (DOUBLE or FLOAT, such as CSV numbers with a decimal point) are added in a fixed order with compensated summation, and every result keeps 15 significant digits. That is accurate within limits, and this warning names where they are crossed; NaN and infinite values are left out of both checks. Input: a metric sums or averages a column that holds a value larger than 1e15 in magnitude, so small values next to very large ones can be lost; the result is still the same on every run. Store the values in a smaller unit, as DECIMAL (Parquet), or keep very large and very small values in separate columns. Result: the value a block shows for a float sum or average (the average itself, not the sum behind it) reaches 1e13 in magnitude in some row, time bucket or total, where 15 significant digits no longer hold cents (10,000,000,000,000.00 needs 16). The warning names the metric and the block. Store the values in a larger unit, such as thousands, or as DECIMAL (Parquet), which stays exact.",
  },
  HM4005: {
    title: "different currencies added",
    explanation:
      "A formula adds, subtracts or chooses between (coalesce, min, max) metrics whose formats name different currencies; multiplying by a number, unary minus and abs keep a metric's currency. A formula whose format names another currency than its operands is reported too, since a format changes the label, not the amounts. Convert one of them first, with an as-of lookup on a rates table and a row expression such as amount * fx_rates.rate, so both are in one currency.",
  },
  HM4007: {
    title: "snapshot summed over time",
    explanation:
      'The source is declared a snapshot table ("snapshot" in hatchmark.yaml): each date holds the full state, so adding rows over a period counts every snapshot again (thirty daily snapshots make a month thirty times too large). Every aggregate on it, or on a lookup source whose base it is, must read one snapshot date at a time: "time" is the snapshot column and "over_time" is "last" (the value at the end of each period), "first", "avg", "min" or "max". No time, another time column, trailing or active would add snapshots too, and entity would carry a key missing from a snapshot forward. A SQL metric gets a warning, since it cannot set over_time yet.',
  },
  HM4008: {
    title: "per_entity needs a point-in-time sum or count",
    explanation:
      "per_entity reads one metric for each entity at two instants. That metric must be an aggregate with sum or count that is read at an instant (over_time last or first, active, or trailing), so each entity has one value at each instant; over_time avg, min and max summarise many dates and have none.",
  },
  HM4009: {
    title: "flow combined with a point-in-time value",
    explanation:
      'A ratio or formula combines a metric summed over each period (a flow, such as revenue) with one read at an instant (such as a balance, an active count or a trailing window). The result would change meaning with the grain: a month of revenue is not comparable with a balance, and a week of it even less. Give the flow a "trailing" window so it is read at an instant too.',
  },
  HM4010: {
    title: "source behind the as-of date",
    explanation:
      "A source is complete only through a moment more than a day before the dashboard's as-of instant, so its metrics end early or look like a drop. A source's horizon is the latest value of the time column its metrics use, over all rows, ignoring filters; a date column is complete through the end of its latest date. Check that the export is current, or set \"freshness\" on the source: {lag: {days: 1}} when the newest day is still filling, {column: exported_at} to measure another column, or {through: as_of} for a sparse source that is complete whenever the build runs.",
  },
  HM4011: {
    title: "nothing to resolve latest_data from",
    explanation:
      'period.asOf is "latest_data" or "latest_common_data", which resolve to the newest or the oldest source horizon, but no source can vote: the dashboard\'s metrics have no time column, their time columns are empty, or every source says {through: as_of}. Set period.asOf to a date, or give a source a freshness rule with a column or a date.',
  },
  HM4012: {
    title: "data after the build machine's clock",
    explanation:
      "A source has rows more than a day after the clock of the machine that ran the build, such as a typo in a year or scheduled entries. With latest_data they move the as-of date into the future. The clock is only used for this warning; it never changes the output, so builds stay reproducible. Fix the rows, or set period.asOf to a date.",
  },
  HM4013: {
    title: "empty window",
    explanation:
      "A block's window starts at or after the horizon of every source it reads, so it has no data to show: a KPI would be empty and a chart would have no points. Pick a range that ends after the data does, or set period.asOf to a date the data covers.",
  },
  HM4024: {
    title: "no complete day yet",
    explanation:
      "Apart from to-date ranges, which read through the horizon itself, a KPI, table or category chart reads whole days ending at the last complete day of its data. Its window has begun, but no day of it is complete yet, such as a last complete unit or an explicit range whose first day isn't complete, so it shows no value rather than 0. It fills in once a day is complete. Set period.asOf to an earlier date to show a complete day instead.",
  },
  HM4014: {
    title: "partial bucket shown as complete",
    explanation:
      'A time series with incomplete: show draws its last bucket like the others, but the data covers only part of it, so a flow metric (a sum or count over the bucket) reads low there. Leave incomplete at "mark" to show it as in progress, or set "hide" to leave the bucket out.',
  },
  HM4016: {
    title: "timestamps without an offset",
    explanation:
      'A source has timestamps without a time zone offset. Hatchmark reads them as UTC, but the project\'s time zone is not UTC, so if they are local times every bucket and window is shifted by the offset. Set "timezone" on the source to the zone the timestamps were written in, or export them with an offset.',
  },
  HM4019: {
    title: "evaluation-time lookup on a metric that is not point-in-time",
    explanation:
      "An as-of lookup with at: $evaluation picks each key's row at the instant a point-in-time metric is read, such as the exchange rate on the last day of a month for a balance. A flow sums rows over a period and a static metric has no instant, so there is no single evaluation instant to pick the row at. Join at each row's own time instead (at: <time column>), or read the metric at an instant (over_time, active or trailing).",
  },
  HM4020: {
    title: "target does not cover the window",
    explanation:
      "A block shows a target, but the target has no value for some of what the block reads: a KPI or category window that starts or ends outside the target's buckets or crosses a bucket the target leaves out, a point-in-time window that ends before the first or after the last target value, or time buckets with no target. Where it does not cover, the block shows no target rather than a partial one. Add the missing target values, or pick a range the target covers.",
  },
  HM4021: {
    title: "target hidden under a filter or segment",
    explanation:
      "A target applies only to the rows it was set for. When a dashboard's select filter keeps some values of a column and the target's table has no such column (inline values have no columns), or a segment toggle is on and the target's table lacks the segment's columns, the block cannot filter the target with its numbers, so it hides the target and says why. A target that lists its segments is shown only while no other segment of the toggle is on. check warns ahead of time. Give the target's table the column, or list the target's segments.",
  },
  HM4022: {
    title: "flow target prorated by days",
    explanation:
      "Informational. A flow target set per month (or another grain) is shown at a finer grain or over a window that starts or ends inside one of its buckets, so the bucket counts in proportion to its days inside: a $31,000 January target is $7,000 for a week of January. Set prorate: none on the target to show it only at its own grain and coarser ones.",
  },
  HM4023: {
    title: "metric primitive not evaluated yet",
    explanation:
      "check validates the metric-layer primitives of RFC 0001 (formula, per_entity, lookup sources, in_table filters on a lookup source, value, entity, active, trailing, scale, a sql metric on a snapshot table, and the freshness and timezone source options), but the planner does not evaluate them yet. A block that shows such a metric is left out of the build with this warning rather than computed as a plain sum, which would show a wrong number. The block appears once the planner evaluates the primitive. A target whose table is a lookup source is not evaluated yet either: the block keeps its numbers and shows no target, with this warning at its target.",
  },
  HM4040: {
    title: "default business definition",
    explanation:
      "Informational. The file relies on a default for a choice that differs between companies: where weeks, quarters and years start, whether a time series starts at the start of its first bucket (edges), how buckets the data does not fully cover are shown (incomplete), which source horizon a dashboard ends at (period asOf), how complete a source is through its newest date (freshness), whether an interval ending exactly at a bucket end still counts in that bucket, which instant gives an entity its group, how a flow target splits at a finer grain (prorate), how a point-in-time target moves between its values (path), or what over_time avg averages (the snapshots present in each period). The note names the default and the option that changes it. Setting the option explicitly, even to its default value, silences the note; over_time avg has no option yet, since calendar-day averaging is not available, so its note stays. Human output folds these notes into one line per file; hatchmark check --explain-defaults prints them all, and the JSON report always lists them.",
  },
  HM4060: {
    title: "stacked metrics do not add up",
    explanation:
      'A stacked bar or area chart draws each series on top of the previous one, so the height of the stack reads as a total. That holds only when the series add up: sums and counts of one unit. A split metric that is an average, a distinct count, a ratio or a min or max over time has segments that do not add up to its total (two regions\' average order values summed are not an average order value). Hatchmark still shows the real total in the tooltip, but the stack height is meaningless. Remove "stack" to draw grouped bars or separate lines, or stack the additive metric the value is built from.',
  },
  HM4062: {
    title: "stacked metrics in different units",
    explanation:
      "A stacked or 100% stacked chart adds its series into one total, so every series must be in the same unit: revenue in dollars and order counts, or revenue in USD and in EUR, cannot be added, and a share of such a total means nothing. Set stack: false to draw the metrics side by side, show them in separate charts, or stack metrics of one unit (convert currencies in the metric first).",
  },
  HM4061: {
    title: "negative values in a part-of-whole chart",
    explanation:
      "A chart stacked to 100%, a pie or a donut shows each value as a share of a whole, which only works when every part is zero or more: a negative part makes the others add up to more than 100%. A 100% stack is still drawn, with negative shares below zero, and the warning names the series. A pie or donut leaves negative and zero categories out, takes shares of the positive values, lists what it left out under the chart and still states the real total. Use stack: true, grouped bars or a bar chart, which show negative values honestly, or filter the metric to values that cannot be negative (such as gross revenue instead of net).",
  },
  HM5010: {
    title: "too many slices",
    explanation:
      'A pie or donut asks for more than 6 slices with "limit". Angles are hard to compare, and thin slices get colours that are hard to tell apart (the palette has 8). Keep "limit" at 6 or fewer, so the smaller categories join one "Other" slice, or show the categories as a horizontal bar chart with "limit", which compares any number of them by length.',
  },
  HM5011: {
    title: "Other is the largest slice",
    explanation:
      'A pie or donut groups the categories past "limit" into "Other", and here Other is larger than every slice shown, so the chart mostly says "other". The data has many small categories; show them as a horizontal bar chart with "limit", group them into fewer categories in the data, or raise "limit" up to 6.',
  },
  HM4063: {
    title: "Other row cannot be computed for a metric",
    explanation:
      'A table with other: true folds the rows past its limit into one Other row, recomputed from the parts of those rows: sums and counts add up, min and max take the extreme, averages divide the summed sum by the summed count, and ratios divide two such metrics. Distinct counts, medians, SQL metrics declared additive: false and sums read with over_time min or max cannot be folded without the rows themselves (two rows can share a customer), so the Other row shows "—" for the metric. The total and subtotals are still recomputed from all rows and stay right. Remove "other" to show the rows past the limit as a count in the note instead, or show a foldable metric in this table.',
  },
  HM4070: {
    title: "scatter points left out for a missing value",
    explanation:
      "A scatter block draws one point per category at its x and y values. A category whose x or y is undefined (no rows in the window for a ratio's denominator, a division by zero, a SQL metric's NULL) has no position, so it is left out of the plot; the warning says how many, and the card subtitle repeats it. The numbers of the other points are unaffected. Pick metrics defined for every category (a sum or count is 0, never undefined), narrow \"by\" to categories that have the data, or accept the gap.",
  },
  HM4071: {
    title: "negative bubble sizes",
    explanation:
      'A scatter block\'s "size" metric sets each point\'s area, which cannot be negative. Points whose size is negative (or undefined) are drawn at the smallest size, so they look like small positive values; the tooltip still shows the real number. Size by a metric that is zero or more, such as gross revenue or orders instead of net revenue or growth, or remove "size" and show the signed metric on an axis.',
  },
  HM4041: {
    title: "metric needs a preset",
    explanation:
      'Informational. A period filter offers custom ranges, which a static page computes in the browser by adding up day-grain aggregates. Distinct counts, medians and SQL metrics not declared additive cannot be added up that way, so for a custom range the page shows them as "—" and says to pick a preset; every preset is computed exactly at build time. Live custom ranges come with hatchmark serve. Set custom: false on the filter to offer presets only.',
  },
  HM5001: {
    title: "too many points per series",
    explanation:
      "A time-series block draws more than 1,000 buckets per series at one of its grains, such as day grain over several years. The chart stays correct, but the points are too dense to read and the page gets heavy. Use a coarser grain, list it in grains, or shorten the range.",
  },
  HM5020: {
    title: "both scatter axes show the same metric",
    explanation:
      'A scatter block with the same metric on "x" and "y" puts every point on one diagonal line, which shows nothing a bar chart would not. A scatter plot compares two different measures per category, such as orders against average order value. Put another metric on one of the axes, or use a bar block for one metric by category.',
  },
  HM5021: {
    title: "bubble size repeats an axis",
    explanation:
      'A scatter block\'s "size" names the same metric as "x" or "y", so the bubble area encodes a number the point\'s position already shows, and the larger points draw the eye to the same thing twice. Size by a third metric (revenue against orders and average order value), or remove "size" to draw plain dots.',
  },
  HM5040: {
    title: "sum or count on a filled map",
    explanation:
      "A map block colours each region by its value. A sum or a count (revenue, orders, customers) is largest where the most people or customers are, so the map mostly repeats a population map: California, Texas and New York, or the United States, China and India, come out darkest whatever the business does. Map a rate instead: a ratio metric such as revenue per customer, orders per store or conversion rate, which compares regions of any size. The paired bar list still shows the totals. Bubble maps, which suit totals, are not available yet.",
  },
  HM5041: {
    title: "rows that match no map region",
    explanation:
      "Some values in the map block's \"region\" column match no region of its geography, so their rows are not on the map, in the bar list or in the totals. Hatchmark matches ISO 3166 alpha-2, alpha-3 and numeric codes, USPS codes, FIPS codes, ISO 3166-2 codes such as US-CA, and common English names, ignoring case, accents, punctuation and spacing. The warning lists each unmatched value with its number of rows and the closest regions. Fix the values in the data (or in the source's SQL), or filter those rows out on purpose. hatchmark build --json and hatchmark check --json carry the full match report: which values joined which region, and which did not and why.",
  },
  HM5042: {
    title: "ambiguous map region",
    explanation:
      'A value in the map block\'s "region" column could name more than one region, such as "Congo" (Republic of the Congo or the Democratic Republic of the Congo) or "Korea" (South or North Korea). Hatchmark never guesses, so those rows are left out like unmatched rows; the warning lists the candidates. Use a code (COG, COD, KOR, PRK) or the full name in the data.',
  },
  HM5043: {
    title: "rows for regions the map does not draw",
    explanation:
      'Some values in the map block\'s "region" column name real regions that the map does not draw: on us-states, Guam, the U.S. Virgin Islands, American Samoa and the Northern Mariana Islands (Puerto Rico is drawn as an inset); on world-countries, Antarctica and countries too small for the boundary scale, such as Singapore, Malta or Bahrain. Their rows are left out of the map, the bar list and the totals, and the match report lists them as not drawn. Show them in a table or a bar chart beside the map, or filter them out on purpose.',
  },
  HM5022: {
    title: "too many scatter points",
    explanation:
      'A scatter block draws at most 500 points: past that the dots merge into a blot and the page gets heavy. The block\'s "by" column has more categories, so Hatchmark kept the 500 largest (by size, else by y) and left the rest out; the warning says how many. Set "limit" to keep fewer on purpose (no warning then), filter the dashboard, or plot a coarser column, such as country instead of city.',
  },
  HM5002: {
    title: "page over the size budget",
    explanation:
      "A built dashboard page weighs more than 3 MB of HTML, counting everything it carries: every chart drawn ahead at each layout and grain, the data of each period preset, and the day-grain data a custom range is computed from. Such a page is slow on a phone. The warning splits the size into those parts. When the day-grain data is the largest, set custom: false on the period filter so readers pick from the presets only; otherwise list fewer grains or presets, split by fewer values, or move blocks to another dashboard.",
  },
  HM5030: {
    title: "group larger than a hue family",
    explanation:
      "A group's series share one hue family and differ by lightness. The theme has only so many lightness steps that stay apart from each other, from other groups and from the context grey, so a group holds at most that many series (the message names the limit). Split the group into two, or leave the least important series ungrouped.",
  },
  HM5031: {
    title: "groups on a single-series chart",
    explanation:
      "groups colour related series of one chart alike, so they need a chart with two or more series: several metrics, or one metric with split. Remove groups, or add the related metrics.",
  },
  HM5032: {
    title: "more groups than hue families",
    explanation:
      "Each group takes its own hue family, and the theme has only so many families that can host a group while staying apart from each other and from the ungrouped series (the message names the limit). Merge groups, leave some series ungrouped, or split the chart.",
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
