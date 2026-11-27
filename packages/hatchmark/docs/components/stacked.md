# Stacked and 100% stacked

Bar and area charts that stack their series, so the stack shows a total and each segment its part
of it. `"stack": true` stacks the values; `"stack": "percent"` stacks them to 100%, so every bar or
bucket shows each part's share of its total.

```json
{
  "type": "bar",
  "title": "Marketplaces matter more outside North America",
  "metrics": ["revenue"],
  "by": "region",
  "split": "channel",
  "stack": "percent"
}
```

| Field     | Meaning                                                                                                                      |
| --------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `stack`   | On `bar` and `area` blocks: `true` stacks the series, `"percent"` stacks them to 100%, `false` (the default) does not stack. |
| `split`   | The usual way to get parts: one metric split by a column, such as `channel`.                                                 |
| `metrics` | Several metrics stack too, when they are parts of one whole in the same unit (gross revenue and refunds, say).               |

Every other field is the [bar](bar.md) or [area](line.md) block's: `by` or `grain`, `grains`,
`orientation`, `sort` and `limit`.

## What the numbers are

- **The total is recomputed from rows.** For a split, each bar's or bucket's total is the metric over
  every split value at that position, from the query's grouping set without the split column
  (SQL `ROLLUP`), never the sum of the segments. For several metrics, the total is their sum.
- **A share is the segment divided by that total**, as a fraction (0.42 is 42%); it is empty when the
  total is 0 or undefined. A 100% stack draws the shares and still prints and lists the values.
- Each series ends at its metric's horizon ([numbers.md](../numbers.md)). A bucket at or past the
  horizon of any stacked metric has no total and no shares, since a part of the whole is missing.
- `limit` keeps the top categories; each one's total still covers every split value.
- Filters and grain switches recompute totals and shares with the rest of the block: every grain in
  `grains` carries its own.

## What it draws

- Stacked bars print each position's total at the end of the bar (`$866K`) when the labels fit. A
  100% stack prints the same totals above bars that all reach 100%, so you see the part and the
  size of the whole together.
- A 100% stack gets a fixed value axis: 0%, 25%, 50%, 75% and 100% (0%, 50% and 100% on plots
  under 160 px tall, or horizontal bars under 240 px wide), so charts of shares read the same
  everywhere.
- Positive values stack upward and negative values downward from zero.
- The key above the plot names the series and wraps instead of shortening names. Stacked areas use
  direct labels at the line ends when they fit (the share in a 100% stack), and otherwise the key
  with the period above it, both updating as you hover.
- Hover, tap or the arrow keys show a tooltip with every series' value and share of the total, and
  the total below them. Screen readers get the same numbers in a hidden table with a Total column.
- The plot keeps its height; a longer key makes the card taller.
- On narrow cards a stacked area's key shows each value with its share in a 100% stack (`$866K 47%`)
  and the period with the total (`Oct 2026 · Total $1.84M`).
- On touch screens a tapped bar or bucket stays selected after the finger lifts; a tap outside
  the chart clears it.

## Checks

| Code     | When                                                                                                                                                     | Fix                                                                                     |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `HM4001` | Error. `"stack": "percent"` on a metric whose parts do not add up to its total: an average, a ratio, a distinct count, a median, a min or max over time. | Stack a sum or a count, or use `"stack": true` (the fix, marked unsafe).                |
| `HM4060` | Warning. `"stack": true` on such a metric with a split or next to other metrics.                                                                         | Remove `stack` to draw the series side by side (the fix), or stack the additive metric. |
| `HM4062` | Error. Stacked metrics in different units or currencies (revenue with order counts, USD with EUR), plain or 100%.                                        | Set `"stack": false` (the fix, marked unsafe), or stack metrics of one unit.            |
| `HM4061` | Build warning. A 100% stack has negative values, so the shares no longer add up to 100%.                                                                 | Use `"stack": true` or grouped bars, or a metric that cannot be negative.               |

Stacking one metric without a split draws one series, so there is nothing to check.
