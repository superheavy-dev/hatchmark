# Diagnostics

Every Hatchmark command that checks files reports problems as diagnostics in one format. People
read the human form in a terminal; agents and tools read the JSON form, which is a versioned
contract described here.

## Human form

```
error[HM2003]: unknown metric "net_revenu"
 --> dashboards/sales.yaml:14:13
   |
14 |     metric: net_revenu
   |             ^^^^^^^^^^ no file metrics/net_revenu.yaml
   = help: did you mean "net_revenue"?
   = valid: gross_revenue, net_revenue, orders, refunds
   = fix (unsafe): replace with "net_revenue"   ·   hatchmark explain HM2003

failed: 1 error, 0 warnings
```

The layout may change between releases. Do not parse it; use the JSON form.

### Default notes (HM4040)

Some choices differ between companies, such as where a week starts or whether a time series starts
at the start of the bucket that holds the range start. Each one has a documented default and an
option that changes it. When a project relies on such a default, check reports an HM4040 note per
definition, naming the default and the option. The human form folds them into one line per file:

```
note[HM4040]: dashboards/sales.yaml: 3 default definitions, run hatchmark check --explain-defaults
```

`hatchmark check --explain-defaults` prints every note in full. The JSON form always lists every
note. Notes don't change `ok`, the counts or the exit code, `--strict` included, and check leaves
them out while the project has errors. Setting an option explicitly, even to its default value,
silences its note.

| Default                                               | Reported on                                                                                                          | Option                                                                                                     |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| A time series starts at the start of its first bucket | each `line`, `area` or time `bar` that can show a grain above day, unless every period the page offers is `all_time` | block `edges: clip`                                                                                        |
| Buckets the data doesn't fully cover are marked       | each `line`, `area` or time `bar`                                                                                    | block `incomplete: hide` or `show`                                                                         |
| Charts end at the newest source's horizon             | each dashboard without `period`                                                                                      | `period: {asOf: latest_common_data, range: last_12_months, compare: previous_period}`, or a date as `asOf` |
| Weeks start on Monday                                 | `hatchmark.yaml`, when a week block or a week range such as `{last: 4, unit: week}` relies on it                     | `anchors.week`, or a block's grain anchor                                                                  |
| Quarters start on Jan 1, Apr 1, Jul 1 and Oct 1       | `hatchmark.yaml`, when a quarter block or range relies on it and neither `anchors.quarter` nor `anchors.year` is set | `anchors.quarter`, or a block's grain anchor                                                               |
| Years start on Jan 1                                  | `hatchmark.yaml`, when a year block or a range such as `year_to_date` relies on it                                   | `anchors.year` (a quarter start when `anchors.quarter` is set), or a block's grain anchor                  |
| An interval ending at a bucket end counts in it       | metrics with `active`                                                                                                | `active.ends`                                                                                              |
| A split entity takes its current group                | `per_entity` metrics                                                                                                 | `group_at`                                                                                                 |
| A source is complete through its newest timestamp     | each source a dashboard reads by a metric's time column, on its entry in `hatchmark.yaml`                            | source `freshness`                                                                                         |
| A flow target splits by days at a finer grain         | each target a block shows, on a metric that adds up over time                                                        | target `prorate`                                                                                           |
| A point-in-time target moves linearly                 | each point-in-time target a block shows                                                                              | target `path`                                                                                              |

The edges note names the first bucket's start and the range start when the page's first period is
fixed (a date as `asOf`), using the period filter's and grain filter's defaults when the dashboard
has them. A date outside the as-of year includes its year.

## JSON form, format_version "1"

A report is one line of JSON on stdout:

```json
{"format_version":"1","ok":false,"error_count":1,"warning_count":0,"diagnostics":[...]}
```

| Field                          | Type    | Meaning                                                                                                                                    |
| ------------------------------ | ------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `format_version`               | `"1"`   | Changes only when a field is removed or changes meaning. New optional fields may be added within a version; ignore fields you do not know. |
| `ok`                           | boolean | `false` when there is at least one error. Warnings alone keep it `true`.                                                                   |
| `error_count`, `warning_count` | integer | Counts by severity. Notes are not counted.                                                                                                 |
| `diagnostics`                  | array   | Sorted by file, line, column, severity, code, then the rest of the diagnostic, so the same input always gives the same bytes.              |

Each diagnostic:

| Field      | Required | Meaning                                                                                                                                                                                                                                                                                                                                                  |
| ---------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `code`     | yes      | Stable code such as `HM2003`. A code is never reused for another problem. `hatchmark explain <code>` prints its explanation.                                                                                                                                                                                                                             |
| `severity` | yes      | `"error"`, `"warning"` or `"note"`.                                                                                                                                                                                                                                                                                                                      |
| `message`  | yes      | One line, lowercase, no trailing period.                                                                                                                                                                                                                                                                                                                 |
| `file`     | no       | Project-relative path with forward slashes. Absent for problems not tied to a file.                                                                                                                                                                                                                                                                      |
| `pointer`  | no       | RFC 6901 JSON Pointer into the file's parsed value.                                                                                                                                                                                                                                                                                                      |
| `range`    | no       | `{"start": {"line", "column"}, "end": {"line", "column"}}`, 1-based, end exclusive. Columns count Unicode code points (an emoji is one column). Lines break at `\n`, `\r\n` and `\r`. Always inside the checked text (start ≤ end ≤ end of file) and never empty, except the zero-width span at end of input in an empty file, which renders as a caret. |
| `frame`    | no       | `{"text", "column", "more"}`: the source line at `range.start.line`, captured from the checked text. For long lines it is a window that starts at `column`; `more` is true when the line continues past it.                                                                                                                                              |
| `label`    | no       | Short text shown under the caret.                                                                                                                                                                                                                                                                                                                        |
| `expected` | no       | The valid values here, when there is a closed set.                                                                                                                                                                                                                                                                                                       |
| `help`     | no       | One line of advice.                                                                                                                                                                                                                                                                                                                                      |
| `fix`      | no       | A proposed repair, below.                                                                                                                                                                                                                                                                                                                                |
| `docs`     | yes      | The command that explains the code, such as `hatchmark explain HM2003`.                                                                                                                                                                                                                                                                                  |

Code ranges: HM1xxx files and YAML syntax, HM2xxx references between files and to data, HM3xxx
spec shape, HM4xxx data rules, HM5xxx design rules, HM9xxx internal errors.

## Fixes

A fix is `{"range", "text", "applicability", "description"}`: replace the source `range` with
`text`, verbatim. An empty range inserts `text` at that point. The range follows the same rules as
a diagnostic's range, except that it may be empty.

`applicability` is `"safe"` when applying the fix cannot change what the file means beyond the
repair itself (fixing letter case, quoting a value YAML reads as a number, adding a documented
default). `"unsafe"` fixes are likely but must be read first; for example, replacing a misspelled
metric name with the closest existing one could pick the wrong metric. `hatchmark check --fix`
applies only safe fixes.

## Diagnostics describe the checked text

Every `range`, `frame` and fix range refers to the exact text that was checked, and is never
updated afterwards. After applying one fix, the other ranges may no longer match the file: apply
fixes from the end of the file backwards, or run `check` again for fresh diagnostics after
each edit.

## Chart width

Line, area and bar charts need at least 3 of the 12 grid columns for their axis labels, readout
and plot. A smaller `span` is a warning, HM2024: the chart is drawn 3 columns wide anyway, and
the grid row reflows around it. The safe fix sets `span: 3`. `check` and `build` both report it.

A table with `overflow: page` grows with its rows. In a grid row shared with other blocks,
that stretches the other cards to the table's height, so it is a warning, HM2026. Remove `overflow`
(a table in a shared row scrolls inside its card by default), or give the table `span: 12`.

## Card height

`height` takes a preset name: `compact`, `default` or `tall`. A pixel value such as `320` or
`"320px"` is HM3004 with a help line that lists each preset's chart height, and an unsafe fix to
the nearest one. Any other string is HM3004 that lists the presets, with a fix when one is close
(`tal` to `tall`). `text` and `bar_list` blocks are as tall as their content: `height` on them is
HM3002, and the safe fix removes it.

A table with `overflow: page` grows with its rows, so `height` on it has no effect: warning HM2031,
and the safe fix removes `height`.

Cards side by side end level. On wide screens, charts in one grid row are drawn at the tallest
preset among them, and the KPIs of one strip at the tallest among the strip's KPIs. A card set
lower is a warning, HM2028, labelled with the height it is drawn at. Below 1024 px cards stack,
and every card, each KPI included, keeps its own preset. The fix sets the card to the height it is drawn at;
it is unsafe because it also changes how the card looks on phones.

## YAML syntax

Spec files are YAML 1.2, read with the core schema, one document per file, with the `.yaml`
extension. Only the first syntax error in a file is reported (HM1002), at the line and column
where the parser stopped. The core schema has no implicit surprises: `yes`, `no`, `on` and `off`
are strings, and so are dates such as `2026-01-01`. Unquoted `2026`, `1.5`, `true` and `null` are
a number, a boolean and null; where the spec expects a string, HM3003 says so and its safe fix
quotes the value as written (`"0012"`, not `"12"`).

A few YAML features are errors so that every tool reads a file the same way: duplicate keys
(HM1003), and anchors, aliases, merge keys (`<<`), tags other than the core ones, a core tag that
does not fit its value, keys that are not strings, a `%YAML` directive other than 1.2 and a second
document after `---` (HM1006). A number must be written as JSON writes it: `0123`, `+1`, `0x10`,
`.5` and `.inf` are HM1006, and the safe fix quotes them as written. SQL must be a literal block
(`sql: |`): a folded or multi-line plain value joins its lines with spaces, so a `--` comment
would hide the lines after it. A `.json` or `.yml` file where a spec file belongs is not read;
HM1007 names the `.yaml` file Hatchmark expects.

A `#` after a space or tab starts a comment, so `value: Store #12` reads as `Store`. A filter
value, a select default or a one-line `sql` followed by a comment on the same line is a warning
(HM1008); quote the value to keep the `#`, or write SQL as a literal block.
