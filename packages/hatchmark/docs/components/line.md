# Line and area

A metric over time.

```yaml
type: line
title: Revenue reached a record in October
metrics: [revenue]
grain: month
span: 8
```

| Field          | Meaning                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `metrics`      | One to eight metrics, one line each. Lines share one y axis, so pick metrics with the same unit.                                                                                                                                                                                                                                                                                                           |
| `grain`        | `day`, `week`, `month`, `quarter` or `year`, or `{ unit: year, anchor: 07-01 }` to start buckets elsewhere than the project `anchors`.                                                                                                                                                                                                                                                                     |
| `grains`       | Optional. Two to six grains the card switches between, such as `[week, month, quarter]`. `grain` is the one shown first and must be in the list (HM3007).                                                                                                                                                                                                                                                  |
| `edges`        | `snap` (default) starts the window at the start of the bucket it falls in, so the first week of "last 30 days" is a whole week. `clip` keeps the window's own start and marks that first bucket partial.                                                                                                                                                                                                   |
| `incomplete`   | Buckets the data covers only part of. `mark` (default) keeps them, listed in the series' `partial`, and the tooltip, the screen-reader table and the description name them "in progress (3 of 7 days)", or "as of" the horizon for a point-in-time metric; `hide` leaves them out; `show` draws them like the others, and check --sql and build warn (HM4014) when a flow metric's last bucket is partial. |
| `split`        | A column that splits one metric into a line per value, such as `region`. Needs exactly one metric.                                                                                                                                                                                                                                                                                                         |
| `groups`       | Optional. Series that belong together, such as actual, target and forecast, drawn in one hue at different lightness ([series groups](groups.md)).                                                                                                                                                                                                                                                          |
| `type: "area"` | Fills under each line. Add `stack: true` to stack the areas, or `stack: percent` to stack them to 100% ([stacked](stacked.md)).                                                                                                                                                                                                                                                                            |
| `title`        | State the finding ("Asia-Pacific is the fastest-growing region"). The subtitle says what is measured.                                                                                                                                                                                                                                                                                                      |
| `span`         | Width in the 12-column grid. Default 12. At least 3: a smaller span is drawn 3 wide, with HM2024.                                                                                                                                                                                                                                                                                                          |

What it draws:

- Lines at 1.75 px over horizontal gridlines, 3 to 6 y ticks with compact labels (`$1.5M`), and month
  labels with the year on January and on the first label.
- Up to six lines are named by direct labels at their ends (name and latest value), stacked 2 px
  apart with leader lines when they would overlap. When the plot is narrower than 320 px or there
  are more than six lines, a key above the plot names them instead: the period in small subtle
  text on its own line, then "● Name $Value" for every line, flowing across the card and wrapping
  like a sentence, every row starting flush left under the period.
  Values are in the body text colour, names muted, both at the same size and weight. The period
  and values update as the reader hovers, drags or steps with the keys. The plot keeps its height:
  a longer key makes the chart taller. Line names are never shortened; only a name wider than the
  whole card is cut, at the end, with the full name on hover.
- Hover (or tap, or the arrow keys) shows a crosshair, the points, and a tooltip with every line's
  value at that date. With several lines each row starts with a short line in its colour; a single
  line's tooltip has none (an area's rows start with a square).
- With `grains`, a segmented control in the card header ("Week · Month · Quarter") switches the
  chart, its title and subtitle. Every grain is built ahead, so switching re-derives nothing in the
  browser. Two options with the same unit name their anchors ("Year from Jan 1", "Year from Jul 1").
- Missing values leave a gap. A window with no data keeps the axis and says "No revenue in this
  period".

## Targets

`target: plan` names one of the metric's [targets](../metrics.md#targets) and draws it as a
dashed line in the muted text colour, keyed above the plot ("-- FY plan"), so it reads as a target
without relying on colour.

- Each series that has a target gets its own dashed line, drawn over the series so a series exactly
  on plan still shows it. The line breaks where the target has no value, and a target value with no
  neighbour is a short dash.
- In the partial bucket the target is the whole bucket's; a hollow diamond marks the pace, the target
  times the share of the bucket that has elapsed, and the key adds "Pace to date".
- A split line has a target per series when the target table has the split column. The total over
  every split value is drawn only where the chart shows a total: a stacked area, or a chart with one
  series. On separate lines it is in the tooltip. A 100% stack draws no target.
- A target hidden by a filter, a segment or the grain draws nothing, and the key says why: "FY plan
  hidden: a segment is on that the target can't follow".
- The value axis grows to hold the target. The tooltip adds the target, the pace and the attainment
  under the series, and so does the readout pinned above a narrow chart, by touch or keyboard; the
  description and the screen-reader table add the same. Attainment is the metric's own value over the
  target's scope, so the total's is the metric over every split value, not a sum of the lines.
- Grain switches, period presets, custom ranges and segment toggles redraw the target from the
  data the page carries.
