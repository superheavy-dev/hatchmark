# KPI

A headline number with its change against the previous period.

```yaml
type: kpi
metric: revenue
sparkline: true
```

| Field       | Meaning                                                                                   |
| ----------- | ----------------------------------------------------------------------------------------- |
| `metric`    | The metric to show. Its `label` is the KPI label unless `title` is set.                   |
| `compare`   | `previous_period`, `previous_year` or `none`. Defaults to the dashboard period's compare. |
| `sparkline` | `true` adds a small line of the metric by month over the current window.                  |
| `span`      | Width in the 12-column grid. Default 3, so four KPIs fill a row.                          |
| `height`    | `compact`, `default` or `tall`: the size of the figure and the sparkline.                 |

What it draws:

- Consecutive KPI blocks share one card, split by hairlines (the KPI strip). On screens 1024 px
  and wider the strip draws every KPI at the tallest `height` among them, so figures in one strip
  match, and a KPI set lower gets warning HM2028. Below 1024 px the strip wraps and each KPI keeps
  its own `height`.
- `height` scales the figure and its sparkline together, in the Default theme (figure size / line
  height / sparkline height in px): `compact` 22/28/21, `default` 28/32/24, `tall` 36/44/33 on
  desktop; `compact` 18/24/20, `default` 20/28/24, `tall` 24/32/28 on phones.
- The figure is regular weight with tabular numbers. Currency switches to compact notation
  (`$6.14M`) at 100,000 and plain numbers at 1,000,000, unless the metric's format sets `compact`.
- The change carries an arrow and a sign: `▲ +10.0%`. Percent metrics change in percentage points:
  `▲ +0.27 pp`. The colour judges the change by the metric's `better`: `up` and `down` colour a
  rise good or bad, `neutral` leaves it grey. Metrics with `better: "down"` say "lower is better".
- The note names the comparison: "vs $5.58M in Sep".
- The sparkline sits 12 px below the note. Hover, tap or focus it and use the arrow keys to see
  each month's value in the same tooltip as the line chart.
- An undefined value shows `—` with "No data in this period"; a real zero shows `$0`. With no
  previous value the note says "No Sep data to compare" and there is no change.

## Targets

`target: plan` names one of the metric's [targets](../metrics.md#targets). Three rows under the
note show it, the same three in every state so cards in a row line up and a card keeps its height
when a filter changes:

- The attainment ("103% of pace", or "of target" without a pace) and, for a metric whose `better`
  is `up` or `down`, "Ahead", "On track" or "Behind" in the good or bad colour. Attainment is the
  value over the pace while the period is in progress, else over the target. Ahead or behind compares
  the value with the pace or target directly, so a loss of $50 beats a loss ceiling of $100, and a
  value equal to its target is on track whichever way is better. On a narrow card "of pace" drops and
  the note keeps the reference.
- A progress bar filled to the attainment. Past 100% the bar stays full and a dot after its end
  marks the overflow.
- The pace and the target: "Pace $1.14M · FY plan $1.86M". A note too long for the card is cut at
  the end, with the full text on hover.

With no attainment the first row says why, keeping "Ahead" or "Behind" when there is a value to
judge: "Target is zero or below", "No value to compare with the target", "No FY plan for this period", or "FY plan hidden" with the reason on the note ("A segment is
on that the target can't follow"). Screen readers hear one sentence: "Revenue is at 103% of pace,
ahead; Pace $1.14M · FY plan $1.86M".
