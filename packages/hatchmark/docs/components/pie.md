# Pie and donut

A pie or donut shows how one total splits into a few parts: revenue by channel, orders by device.
Each slice is a category's share of the whole. A donut is a pie with a hole that states the total.

```json
{
  "type": "donut",
  "title": "The online store takes 58% of revenue",
  "metric": "revenue",
  "by": "channel"
}
```

| Field    | Meaning                                                                                                    |
| -------- | ---------------------------------------------------------------------------------------------------------- |
| `type`   | `"pie"` or `"donut"`.                                                                                      |
| `metric` | One metric that adds up across categories: a sum or a count (HM4001 otherwise).                            |
| `by`     | The column whose values become slices.                                                                     |
| `limit`  | Slices to show, 1 to 12, default 5. The rest join one "Other" slice. More than 6 is hard to read (HM5010). |

Blocks also take the usual `id`, `title`, `description` and `span`. Pick a bar chart instead when the
categories are many, similar in size, or not parts of one whole.

## What the numbers are

- **Slices are the largest positive categories**, largest first, ties by name. A null value in `by`
  is a real category, shown as "(empty)".
- **Other** sums every positive category past `limit` and says how many it holds ("Other (19 more)").
- **A share is the slice divided by the whole**, the sum of the positive categories, so slices and
  Other always add up to 100%.
- **The total is recomputed from rows** (SQL `ROLLUP`'s grand total), never summed from the slices.
  For a sum or a count with no negative values it equals the whole.
- **Negative, zero and empty categories are left out** of the circle, because they are not parts of
  a whole. Negative ones raise HM4061 when the dashboard builds, and the chart lists what it left out
  under the key ("Leaves out 1 negative value (Wholesale −$12.3K)"). The total still includes them.
- Filters recompute slices, Other and the total with the rest of the dashboard.

## What it draws

- Slices start at 12 o'clock and run clockwise, largest first, in the theme's series colours. Other
  is always last, in the muted context colour.
- The key beside the pie names each slice with its value and share. Long names wrap instead of being
  shortened. On cards narrower than 440 px the key goes under the pie.
- A donut prints the total and the metric's name in the hole.
- Hover, tap or the arrow keys highlight one slice, dim the rest, and show its value and share in a
  tooltip. Screen readers get the same numbers in a hidden table and hear each step through a live
  region.
- No data, or a whole of 0, draws an empty ring with "No <metric> in this period".

## Checks

| Code     | When                                                                                                  | Fix                                                                                           |
| -------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `HM4001` | Error. The metric does not add up across categories: an average, a ratio, a distinct count, a median. | Show it in a bar chart, or use the sum or count it is built from.                             |
| `HM5010` | Warning. `limit` is above 6.                                                                          | Set `"limit": 6` (the fix, marked unsafe), or use a horizontal bar chart with `limit`.        |
| `HM5011` | Build warning. Other is larger than every slice shown.                                                | Use a horizontal bar chart with `limit`, group categories in the data, or raise `limit` to 6. |
| `HM4061` | Build warning. Some categories are negative, so they are left out of the circle.                      | Use a bar chart, which shows negative values, or a metric that cannot be negative.            |
