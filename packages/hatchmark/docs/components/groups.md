# Series groups

On a chart with several series, `groups` says which series belong together: actual, target and
forecast of one metric, this year and last year, or a family of related metrics. A group's series
share one hue and step through its lightness in the order you list them, instead of taking
unrelated colours. Series you leave out of every group keep their usual colours.

```yaml
type: line
title: Revenue is tracking 4% above target
metrics: [revenue, revenue_target, revenue_forecast]
grain: month
groups:
  - label: Revenue
    series: [revenue, revenue_target, revenue_forecast]
```

With `split`, name the split values as the chart labels them:

```yaml
type: bar
title: Online channels bring two thirds of revenue in every region
metrics: [revenue]
by: region
split: channel
stack: true
groups:
  - label: Online
    series: [Online store, Marketplace]
  - label: Offline
    series: [Retail partners, Wholesale]
```

| Field             | Meaning                                                                                                                                         |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `groups`          | On `line`, `area` and `bar` blocks, plain, stacked or 100% stacked. A list of up to 3 groups.                                                   |
| `groups[].label`  | The group's name in the key, the tooltip and the data table, such as `Revenue`.                                                                 |
| `groups[].series` | 2 or 3 series, lead first: metric names from `metrics`, or with `split` the split values (a null value is `(empty)`). A series is in one group. |

## How colours are picked

- The first group takes the blue family, the second pink and red, the third green. Step 1 is
  close to the family's usual colour, tuned where needed so that steps 2 and 3 always recede
  behind it; the steps differ in lightness only.
- Ungrouped series take the usual slots in order, skipping the slots of every family a group holds,
  so no ungrouped series shares a hue with a group. A chart without `groups` is drawn exactly as
  before.
- A series keeps its step when other members are missing, such as a split value with no rows in the
  chosen period, so colours never shift between periods.
- Every step is at least 3:1 against the card in light and dark, steps of one family stay apart from
  each other, and every step stays apart from the other families, the ungrouped colours and the
  context grey, under normal vision and three colour-vision simulations ([theme.md](../theme.md)).

## What it draws

- A group's series sit next to each other in the group's order, where its first member would be:
  in the key, in a stack and in grouped bars.
- The key names the group before its members (**Revenue** ● Actual ● Target ● Forecast). Line-end
  labels add the group's name only when two series share a label, such as `2026` in two regions
  (`North America · 2026`).
- The tooltip lists a grouped chart's rows in series order under each group's name, instead of
  sorting them by value, so a group stays together.
- The screen-reader table puts each group's name over its members' columns, and the chart's text
  description reads `Revenue (Actual, Target, Forecast)`.
- Grouping changes colours and order only: values, totals and shares are the same as without
  `groups`.

## Checks

| Code     | When                                                                                                                                            | Fix                                                                     |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `HM2027` | Error. A group names a metric that is not in `metrics`. Build warning: a split value has no rows in the source, whatever the period or filters. | Use a name from `metrics` (a close match is offered), or fix the value. |
| `HM3011` | Error. A series is in two groups, or twice in one.                                                                                              | Remove the repeat (the fix, marked unsafe).                             |
| `HM5030` | Error. A group has more series than a hue family has steps (3).                                                                                 | Split the group, or leave a series ungrouped.                           |
| `HM5031` | Error. `groups` on a chart with one series (one metric and no `split`).                                                                         | Remove `groups`, or add the related metrics.                            |
| `HM5032` | Error. More groups than hue families (3).                                                                                                       | Merge groups, or leave some series ungrouped.                           |
