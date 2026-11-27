# Scatter

Two metrics per category as points: one on the horizontal axis, one on the vertical, and
optionally a third as the point's area (a bubble chart).

```json
{
  "type": "scatter",
  "title": "Bigger markets do not mean bigger baskets",
  "x": "orders",
  "y": "avg_order_value",
  "by": "country",
  "size": "revenue",
  "limit": 50
}
```

| Field   | Meaning                                                                                                                              |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `x`     | The metric on the horizontal axis.                                                                                                   |
| `y`     | The metric on the vertical axis. Use a different metric from `x` (HM5020).                                                           |
| `by`    | The category column: one point per value. A null value is a real point, shown as "(empty)".                                          |
| `size`  | Optional. A metric drawn as each point's area. Use a third metric that is zero or more (HM5021, HM4071). Omit it for dots.           |
| `limit` | Optional, 1 to 500. Points kept, largest first: by `size`, else by `y`, ties by name. Without it every category is drawn, up to 500. |

Every metric is computed per category from that category's rows, as in a table: a ratio such as
average order value divides the category's revenue by its orders, never averages the orders'
values. The dashboard period and select filters apply to all three metrics, over one window: x, y
and size all end at the earliest horizon among their sources, so a point never pairs days one
metric has with days another lacks. The subtitle states that window, and names a metric without a
time column as read "over all time" (just "All time" when none has one). A scatter needs no time
column.

What it draws:

- One circle per category in the first series colour, 70% opaque with a thin card-coloured edge, so
  overlapping points stay visible. Without `size` every dot has a 4 px radius; with it the area is
  proportional to the value (3 to 14 px radius, 10 on narrow cards), and "Bubble size: Revenue"
  names the metric above the plot.
- Linear axes around the data. An axis starts at zero only when zero is close to the data (the
  smallest value is under a third of the largest); otherwise it spans the data with nice ticks, so
  average order values from $40 to $120 fill the plot. A vertical zero line marks an x axis that
  crosses zero; the y axis has gridlines and a zero baseline as in bar and line charts.
- The y metric's name above the plot on the left, the x metric's under the axis on the right.
- The names of up to five points (three on narrow cards) next to them: the largest by size, or the
  highest and lowest on each axis without size. A name is drawn only where it overlaps no other
  point or name, and is never shortened; every point's name is in its tooltip.
- Hover or tap picks the bubble under the pointer (the one drawn on top where bubbles overlap),
  else the nearest point within 24 px, and rings it; the tooltip names the category
  and lists x, y and size in full. The arrow keys step through the points from left to right, and a
  screen reader hears each one ("Germany, Orders 1,482, Average order value $88.90, Revenue
  $131,800"). Screen readers also get a summary and every point in a hidden table.
- The subtitle says "top 50 of 212" when `limit` cut points, and how many categories have no value
  to place them at.
- An empty period keeps the axes' titles and says "No data in this period" (HM4013), or "No complete
  day yet" when a metric's source has no complete day in the period (HM4024).

## Checks

| Code     | When                                                                                                              | Fix                                                                        |
| -------- | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `HM5020` | Warning. `x` and `y` are the same metric, so every point sits on one diagonal.                                    | Put a different metric on one axis, or use a bar block.                    |
| `HM5021` | Warning. `size` repeats the `x` or `y` metric.                                                                    | Size by a third metric, or remove `size`.                                  |
| `HM4070` | Build warning. Some categories have no `x` or `y` value (a ratio divided by zero, no rows), so they are left out. | Use metrics defined for every category, or narrow `by`.                    |
| `HM4071` | Build warning. `size` has negative values; those points are drawn at the smallest size.                           | Size by a metric that is zero or more, and show the signed one on an axis. |
| `HM5022` | Build warning. More than 500 categories and no `limit`: the 500 largest are drawn.                                | Set `limit`, filter the dashboard, or plot a coarser column.               |
| `HM2024` | Warning. `span` under 3; the chart is drawn 3 columns wide.                                                       | Set `span` to 3 or more.                                                   |
