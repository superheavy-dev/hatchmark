# KPI

A headline number with its change against the previous period.

```json
{ "type": "kpi", "metric": "revenue", "sparkline": true }
```

| Field       | Meaning                                                                                   |
| ----------- | ----------------------------------------------------------------------------------------- |
| `metric`    | The metric to show. Its `label` is the KPI label unless `title` is set.                   |
| `compare`   | `previous_period`, `previous_year` or `none`. Defaults to the dashboard period's compare. |
| `sparkline` | `true` adds a small line of the metric by month over the current window.                  |
| `span`      | Width in the 12-column grid. Default 3, so four KPIs fill a row.                          |

What it draws:

- Consecutive KPI blocks share one card, split by hairlines (the KPI strip).
- The figure is regular weight with tabular numbers. Currency switches to compact notation
  (`$6.14M`) at 100,000 and plain numbers at 1,000,000, unless the metric's format sets `compact`.
- The change carries an arrow and a sign: `▲ +10.0%`. Percent metrics change in percentage points:
  `▲ +0.27 pp`. The colour judges the change by the metric's `better`: `up` and `down` colour a
  rise good or bad, `neutral` leaves it grey. Metrics with `better: "down"` say "lower is better".
- The note names the comparison: "vs $5.58M in Sep".
- An undefined value shows `—` with "No data in this period"; a real zero shows `$0`. With no
  previous value the note says "No Sep data to compare" and there is no change.
