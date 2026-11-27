# Bar

A metric by category or by time bucket, as vertical or horizontal bars.

```json
{
  "type": "bar",
  "title": "Organic search brings in the most revenue",
  "metrics": ["revenue"],
  "by": "channel",
  "orientation": "horizontal",
  "sort": { "by": "revenue", "order": "desc" },
  "limit": 10,
  "span": 4
}
```

| Field           | Meaning                                                                                        |
| --------------- | ---------------------------------------------------------------------------------------------- |
| `metrics`       | One to eight metrics. Several metrics are drawn side by side (grouped) unless `stack` is true. |
| `by` or `grain` | A category column, or time buckets. Use one of the two.                                        |
| `split`         | A column that splits one metric into a bar segment per value.                                  |
| `stack`         | `true` stacks the series; otherwise they are grouped side by side.                             |
| `orientation`   | `vertical` (default) or `horizontal`. Horizontal suits long category names and rankings.       |
| `sort`, `limit` | Order and keep the top N categories. The subtitle then says "top 10 of 51".                    |

What it draws:

- Bars with a 1 px radius, values printed on the bars when they fit (compact, `$58.5K`), so most bar
  charts need no value axis. Stacked bars print the total.
- Vertical bars get 3 to 6 y ticks; long category labels are shortened in the middle
  ("Technical sh…outerwear"), or thinned when even that does not fit.
- Horizontal charts get one row per category, 28 to 36 px tall.
- Several series get a key above the plot.
- Hover, tap or the arrow keys highlight a category and show a tooltip with every series and, for
  stacked bars, the total.
- A null category is a real group and shows as "(empty)".
