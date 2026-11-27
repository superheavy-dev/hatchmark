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

| Field          | Meaning                                                                                               |
| -------------- | ----------------------------------------------------------------------------------------------------- |
| `metrics`      | One to eight metrics, one line each. Lines share one y axis, so pick metrics with the same unit.      |
| `grain`        | `day`, `week`, `month`, `quarter` or `year`.                                                          |
| `split`        | A column that splits one metric into a line per value, such as `region`. Needs exactly one metric.    |
| `type: "area"` | Fills under each line. Add `"stack": true` to stack the areas.                                        |
| `title`        | State the finding ("Asia-Pacific is the fastest-growing region"). The subtitle says what is measured. |
| `span`         | Width in the 12-column grid. Default 12. At least 3: a smaller span is drawn 3 wide, with HM2018.     |

What it draws:

- Lines at 1.75 px over horizontal gridlines, 3 to 6 y ticks with compact labels (`$1.5M`), and month
  labels with the year on January and on the first label.
- Up to six lines are named by direct labels at their ends (name and latest value), stacked 2 px
  apart with leader lines when they would overlap. When the plot is narrower than 320 px or there
  are more than six lines, a key above the plot names them instead: the period in small subtle
  text, then "● Name $Value" for every line, flowing across the card and wrapping like a sentence.
  Values are in the body text colour, names muted, both at the same size and weight. The period
  and values update as the reader hovers, drags or steps with the keys. The plot keeps its height:
  a longer key makes the chart taller. Line names are never shortened; only a name wider than the
  whole card is cut, at the end, with the full name on hover.
- Hover (or tap, or the arrow keys) shows a crosshair, the points, and a tooltip with every line's
  value at that date.
- Missing values leave a gap. A window with no data keeps the axis and says "No revenue in this
  period".
