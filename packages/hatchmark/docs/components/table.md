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

What it draws:

- A real HTML `<table>`: grouping columns on the left, numbers right-aligned in tabular figures and
  in each metric's format (`$3,562,884`, or `$104K` when the metric sets `compact`).
- The total row is recomputed from all rows in the window, including rows `limit` removed, and
  ratios divide the totals (an average order value total is revenue ÷ orders, never an average of
  averages). When rows were cut the table says "Showing 15 of 21 rows. The total covers all 21."
- Long names wrap to at most two lines and keep the full text in a tooltip. On narrow screens the
  table scrolls sideways with the first column pinned, and bars are hidden.
- Undefined values show `—`; a null group shows "(empty)".

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

## In-cell bars

`bars` draws a bar behind each value of the listed metrics, scaled to the largest value among the
group and Other rows shown (subtotals and the total get none). When a column has both negative and
positive values, bars grow left and right from a zero line. A metric in `percentOfTotal` already has
a share bar; `bars` is for metrics that are not shares, such as orders or a margin.

## Long tables

A table with more than 15 rows scrolls inside its card, with the header row and the total row kept
in view. Printing shows every row.

Tables do not paginate. A dashboard is read at a glance, and rows on a later page are easy to miss
and break the "these N rows plus the rest" reading. Use `limit` with `other`, or subtotals; check
says so when a spec asks for `pagination`, `pageSize` or similar (HM3002).

## CSV download

The "Download CSV" button in the card header saves the table as shown: the header, the rows in
their current order (Other and subtotal rows included, subtotals labelled "Subtotal"), then the
total row. Values are the full-precision numbers, not the formatted text, and a share is a fraction
(0.392 for 39.2%). The file is UTF-8 with a byte order mark so spreadsheets read accents, and a key
that starts with `=`, `+`, `-` or `@` is prefixed with `'` so it opens as text, never as a formula.
