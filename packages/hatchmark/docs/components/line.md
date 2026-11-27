# Line and area

A metric over time.

```json
{
  "type": "line",
  "title": "Revenue reached a record in October",
  "metrics": ["revenue"],
  "grain": "month",
  "span": 8
}
```

| Field          | Meaning                                                                                                                                                         |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `metrics`      | One to eight metrics, one line each. Lines share one y axis, so pick metrics with the same unit.                                                                |
| `grain`        | `day`, `week`, `month`, `quarter` or `year`, or `{ "unit": "year", "anchor": "07-01" }` to start buckets elsewhere than the project `anchors`.                  |
| `grains`       | Optional. Two to six grains the card switches between, such as `["week", "month", "quarter"]`. `grain` is the one shown first and must be in the list (HM3007). |
| `split`        | A column that splits one metric into a line per value, such as `region`. Needs exactly one metric.                                                              |
| `type: "area"` | Fills under each line. Add `"stack": true` to stack the areas, or `"stack": "percent"` to stack them to 100% ([stacked](stacked.md)).                           |
| `title`        | State the finding ("Asia-Pacific is the fastest-growing region"). The subtitle says what is measured.                                                           |
| `span`         | Width in the 12-column grid. Default 12. At least 3: a smaller span is drawn 3 wide, with HM2024.                                                               |

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
  value at that date.
- With `grains`, a segmented control in the card header ("Week · Month · Quarter") switches the
  chart, its title and subtitle. Every grain is built ahead, so switching re-derives nothing in the
  browser. Two options with the same unit name their anchors ("Year from Jan 1", "Year from Jul 1").
- Missing values leave a gap. A window with no data keeps the axis and says "No revenue in this
  period".
