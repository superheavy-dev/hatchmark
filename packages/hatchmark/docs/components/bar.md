# Bar

A metric by category or by time bucket, as vertical or horizontal bars.

```yaml
type: bar
title: Organic search brings in the most revenue
metrics: [revenue]
by: channel
orientation: horizontal
sort:
  by: revenue
  order: desc
limit: 10
span: 4
```

| Field                 | Meaning                                                                                                                        |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `metrics`             | One to eight metrics. Several metrics are drawn side by side (grouped) unless `stack` is true.                                 |
| `by` or `grain`       | A category column, or time buckets. Use one of the two.                                                                        |
| `grains`              | With `grain` only: grains the card switches between, as for [line](line.md).                                                   |
| `edges`, `incomplete` | With `grain` only: the first bucket and partial buckets, as for [line](line.md) (HM3007 with `by`).                            |
| `split`               | A column that splits one metric into a bar segment per value.                                                                  |
| `groups`              | Optional. Series that belong together, drawn in one hue ([series groups](groups.md)).                                          |
| `stack`               | `true` stacks the series, `"percent"` stacks them to 100%; otherwise they are grouped side by side. See [stacked](stacked.md). |
| `orientation`         | `vertical` (default) or `horizontal`. Horizontal suits long category names and rankings.                                       |
| `sort`, `limit`       | Order and keep the top N categories. The subtitle then says "top 10 of 51".                                                    |

What it draws:

- Bars with a 1 px radius, values printed on the bars when they fit (compact, `$58.5K`), so most bar
  charts need no value axis. Stacked bars print the total.
- Vertical bars get 3 to 6 y ticks; a long category label is cut at the end with the full name
  on hover ("Technical shells…"), or the labels are thinned when even that does not fit.
- Horizontal bars give the category names a column as wide as they need, up to 40% of the chart,
  and wrap longer names to two lines. Only a name that does not fit in two lines is cut, at the
  end, with the full name on hover.
- Horizontal charts get one row per category. Rows stretch to fill the chart's `height` within
  limits: 22 to 30 px at `compact`, 28 to 36 px at `default` and 28 to 48 px at `tall` in the
  Default theme. A chart with more rows than fit grows instead of scrolling or dropping bars; to
  show fewer, set `limit` (and `other`), which says "top 10 of 51" in the subtitle.
- Several series get a key above the plot. The key wraps instead of shortening names; only a name
  wider than the whole card is cut, at the end, with the full name on hover.
- Hover, tap or the arrow keys highlight a category and show a tooltip with every series and, for
  stacked bars, each series' share and the total, recomputed from rows. With several series each
  row starts with a square in its colour; a single series' tooltip has none.
- A null category is a real group and shows as "(empty)".

## Targets

`target: plan` names one of the metric's [targets](../metrics.md#targets).

- A bar whose category or month has a target gets a tick across it in the text colour, with a halo
  in the card colour so it stays visible over the bar. Grouped bars get a tick each; a stacked bar
  gets one for the total. A hollow diamond marks the pace in a partial bucket.
- A target without a `by` column is a target for the whole window, not for each bar: a dashed rule
  across the plot, keyed "FY plan for the period", with its pace as a diamond at the end. Its
  attainment is the metric over the whole window, including categories a `limit` leaves out. A 100%
  stack draws no rule, since its axis is a share; the tooltip and screen-reader table still give it.
- Value labels move past a tick or diamond they would cross.
- The tooltip, the description and the screen-reader table add the target, the pace and the
  attainment. A hidden target draws nothing and the key says why.
