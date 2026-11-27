# Table

Metrics by one to three columns, with a total row. Readers sort by any column and download the
rows as CSV.

```json
{
  "type": "table",
  "title": "The top 8 countries bring in 79% of revenue",
  "by": ["country"],
  "metrics": ["revenue", "orders", "avg_order_value"],
  "percentOfTotal": ["revenue"],
  "bars": ["orders"],
  "sort": { "by": "revenue", "order": "desc" },
  "limit": 8,
  "other": true
}
```

| Field            | Meaning                                                                                                   |
| ---------------- | --------------------------------------------------------------------------------------------------------- |
| `by`             | One to three grouping columns, outermost first.                                                           |
| `metrics`        | One to twelve metrics, one column each.                                                                   |
| `percentOfTotal` | Metrics that also get a "% of total" column with a share bar. Additive metrics only (HM4001).             |
| `totals`         | The total row; default `true`.                                                                            |
| `sort`           | The order rows arrive in: a metric or a `by` column. Default: the first metric, descending.               |
| `limit`          | Rows shown. With `subtotals`, rows shown in each innermost group.                                         |
| `other`          | With `limit`: fold the rows past the limit into one "Other" row.                                          |
| `subtotals`      | A subtotal row for every group of each outer `by` column. Needs two or more `by` columns.                 |
| `bars`           | Metrics that draw a bar in their cells, scaled across the rows shown. Must also be in `metrics` (HM2006). |
| `overflow`       | How a table past 15 rows fits: `"page"` or `"scroll"`. Default from the layout; see Long tables.          |

What it draws:

- A real HTML `<table>`: grouping columns on the left, numbers right-aligned in tabular figures and
  in each metric's format (`$3,562,884`, or `$104K` when the metric sets `compact`).
- The total row is recomputed from all rows in the window, including rows `limit` removed, and
  ratios divide the totals (an average order value total is revenue ÷ orders, never an average of
  averages). When rows were cut the table says "Showing 15 of 21 rows. The total covers all 21."
- Long names wrap to at most two lines and keep the full text in a tooltip. On narrow screens the
  table scrolls sideways with its key column pinned, and bars are hidden (see Narrow screens).
- Undefined values show `—`; a null group shows "(empty)".
- The subtitle gives the table's main window, the one most of its metrics read ("Nov 1 – Nov 3,
  2026"; "through Nov 3, 2026" for an `all_time` period; "all time" when no metric has a time
  column), and the table refers to it as its description. Each metric's window ends at its own last
  complete day (see numbers.md), so a column whose metric reads another window gets a small marker
  in its header. Hovering, focusing or tapping it shows that window, which is also the column's
  accessible description: "Data through Oct 29, 2026 · 2 days behind", "All time" for a metric
  without a time column, or "No data in this period" / "No complete day yet". CSV headers keep the
  plain labels.

## Sorting

Every column header is a button: click it, or Tab to it and press Enter or Space. A metric sorts
descending first, a grouping column ascending first; a second press reverses. Empty values stay
last in both directions, the Other row stays last, subtotal rows move with their groups, and the
total stays in the footer. Sorting reorders the rows the page has; it never changes which rows
`limit` kept or what Other holds. Screen readers hear the new order through `aria-sort` and a
short announcement.

## Top N and Other

`limit` keeps the first N rows in `sort` order; ties at the boundary are broken by the grouping
values, ascending, so a build always keeps the same rows. With `"other": true` the rest become one
row, "Other (16)", recomputed from those rows' parts rather than looked up:

- sums and counts add up, min and max take the extreme;
- an average divides the summed sum by the summed count, and a ratio divides its two folded sides,
  so Other's average order value is Other's revenue ÷ Other's orders;
- distinct counts, medians, SQL metrics declared `"additive": false` and sums read with
  `over_time` min or max cannot be folded (two rows can share a customer), so Other shows `—` for
  them and check warns with HM4063.

A real group named "Other" or a null group stays its own row; the data marks the folded row with
`kind: "other"`, never by its label. Shares of Other are of the grand total, and the shown rows plus
Other add up to the total for additive metrics.

## Subtotals

With two or three `by` columns, `"subtotals": true` adds a subtotal row before each group of every
outer column. Subtotals come from the query (SQL `ROLLUP`), never from adding the rows below, so a
distinct count or an average is right at every level. Groups are ordered among themselves by their
subtotal in `sort` order, rows within each group likewise. `limit` and `other` then apply inside
each innermost group: "the top 3 countries of every region, the rest of each region as Other".

A group with a single row would repeat that row's numbers in its subtotal, so the subtotal row is
left out and the row shows its group name instead. The CSV still lists the subtotal.

## Narrow screens

On a phone-sized card (under 600 px), a table with two or three `by` columns keeps one key column
pinned at the left edge, and how it names the groups depends on the spec, never on the current
sort, so the layout stays put when someone sorts by a column:

- With `"subtotals": true`, rows always stay in their groups. Each subtotal row becomes the group's
  header row, its name in bold in the pinned column, and only the innermost key column is shown
  (with three columns, the middle level is indented under the outer one).
- Without subtotals, a sort by a metric interleaves the groups. Each row shows its innermost value
  with the outer values below it in muted text ("United States" over "North America"), and the
  header reads the same way.

Screen readers still hear every key cell of each row, in order, so the group is announced with each
row.

## In-cell bars

`bars` draws a bar behind each value of the listed metrics, scaled to the largest value among the
group and Other rows shown (subtotals and the total get none). When a column has both negative and
positive values, bars grow left and right from a zero line. A metric in `percentOfTotal` already has
a share bar; `bars` is for metrics that are not shares, such as orders or a margin.

## Long tables

A table with more than 15 rows keeps its header row and total row in view, in one of two ways:

- **Page** (the default for a table alone in its grid row): the card grows as tall as its rows and
  the page scrolls. While the table is on screen, its header row stays at the top of the window
  and its total row at the bottom.
- **Scroll** (the default for a table that shares its row with other blocks): the card keeps the
  height of about 16 rows and the rows scroll inside it under a pinned header and total, with a
  thin scrollbar in the theme's colours. The row's cards stay the same height.

`"overflow": "page"` or `"scroll"` overrides the default. `"page"` in a shared row makes the
other cards in the row stretch to the table's height, so check warns with HM2026. "Alone in its row"
follows the 12-column grid as the spec lays it out: a run of KPIs counts as one card, a chart is
counted at its drawn width (at least 3 columns), and a block that does not fit in what is left of
a row starts the next one. Below 1024 px every block takes the full width, but the mode stays the
one the spec's layout gives. When card height presets arrive (GUN-1822), the scroll height will
follow the preset instead of the fixed 16 rows.

Printing shows every row.

Tables do not paginate. A dashboard is read at a glance, and rows on a later page are easy to miss
and break the "these N rows plus the rest" reading. Use `limit` with `other`, or subtotals; check
says so when a spec asks for `pagination`, `pageSize` or similar (HM3002).

## CSV download

The "Download CSV" button in the card header saves the table as shown: the header, the rows in
their current order (Other and subtotal rows included, subtotals labelled "Subtotal"), then the
total row. Values are the full-precision numbers, not the formatted text, and a share is a fraction
(0.392 for 39.2%). The file is UTF-8 with a byte order mark so spreadsheets read accents, and a key
that starts with `=`, `+`, `-` or `@` is prefixed with `'` so it opens as text, never as a formula.
