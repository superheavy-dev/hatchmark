# Table

Metrics by one to three columns, with a total row.

```json
{
  "type": "table",
  "title": "Top countries by revenue",
  "by": ["country"],
  "metrics": ["revenue", "orders", "avg_order_value"],
  "percentOfTotal": ["revenue"],
  "sort": { "by": "revenue", "order": "desc" },
  "limit": 15
}
```

| Field            | Meaning                                                                              |
| ---------------- | ------------------------------------------------------------------------------------ |
| `by`             | One to three grouping columns, outermost first.                                      |
| `metrics`        | One to twelve metrics, one column each.                                              |
| `percentOfTotal` | Metrics that also get a "% of total" column with a share bar. Additive metrics only. |
| `totals`         | The total row; default `true`.                                                       |
| `sort`, `limit`  | Order and keep the first N rows.                                                     |

What it draws:

- A real HTML `<table>`: grouping columns on the left, numbers right-aligned in tabular figures and
  in each metric's format (`$3,562,884`, or `$104K` when the metric sets `compact`).
- The total row is recomputed from all rows in the window, including rows `limit` removed, and
  ratios divide the totals (an average order value total is revenue ÷ orders, never an average of
  averages). When rows were cut the table says "Showing 15 of 21 rows. The total covers all 21."
- Long names wrap to at most two lines and keep the full text in a tooltip. On narrow screens the
  table scrolls sideways with the first column pinned.
- Undefined values show `—`; a null group shows "(empty)".
