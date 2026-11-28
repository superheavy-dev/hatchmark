# Metrics

Full reference: `hatchmark docs metrics`. Schema: `hatchmark schema metric`.

- One file per metric, `metrics/<name>.yaml`. The file name is the metric's name; dashboards refer
  to metrics by that name.
- Every metric has `type`, `label` and `format`; `description`, `better` (`up`, `down` or
  `neutral`) and `targets` are optional.
- `type: aggregate` aggregates one `column` of a source (`table`) with `sum`, `count`,
  `count_distinct`, `avg`, `min`, `max` or `median`, after optional `filters`.
- `type: ratio` divides two other metrics: `numerator` and `denominator` are metric names. Totals
  divide the totals; a ratio has no `table` or `filters` of its own.
- `type: sql` is the escape hatch: one SQL aggregate expression over one source, with
  `additive: true` only when summing over groups gives the overall value.
- Set `time` to the date or timestamp column on almost every metric; without it there is no time
  series and no period comparison.

```yaml
label: Revenue
description: Paid order amounts in USD, before refunds.
type: aggregate
table: orders
aggregate: sum
column: amount
filters:
  - column: status
    op: eq
    value: paid
time: ordered_at
format:
  type: currency
better: up
```

Before writing one, run `hatchmark data describe <source> --json` to get the exact column names and
types. After writing one, `hatchmark explain <metric>` prints its SQL; compare the result with a
`hatchmark data query` you write yourself when a number matters.

Sections worth reading: `hatchmark docs metrics#filters`, `hatchmark docs metrics#format`,
`hatchmark docs metrics#targets`, and `hatchmark docs numbers` for how periods, totals, empty
values and rounding work.
