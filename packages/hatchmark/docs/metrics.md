# Metrics (metrics/<name>.yaml)

A metric is one number Hatchmark can compute for any period and any group: revenue, orders, refund
rate. Each lives in its own file under `metrics/`, and **the file name is the metric's name**:
`metrics/refund_rate.yaml` is `refund_rate`. Names are lowercase snake_case. Dashboards refer to
metrics by name, so a metric means the same thing on every dashboard. Print the full JSON Schema with
`hatchmark schema metric`.

Every metric has these fields:

| Field         | Meaning                                                                               |
| ------------- | ------------------------------------------------------------------------------------- |
| `type`        | `aggregate`, `ratio` or `sql`.                                                        |
| `label`       | Human name shown on the page, such as `Net revenue`.                                  |
| `description` | Optional. What is counted, for readers and agents.                                    |
| `format`      | How values are shown; see [Format](#format).                                          |
| `better`      | `up`, `down` or `neutral`: which direction of change is good. It colours KPI changes. |
| `targets`     | Optional. Goals for the metric that blocks can show; see [Targets](#targets).         |

## aggregate

Aggregates one column of a source, after optional filters.

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
  compact: true
better: up
```

| Field       | Meaning                                                                                                                                                            |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `table`     | A source name from `hatchmark.yaml`.                                                                                                                               |
| `aggregate` | `sum`, `count`, `count_distinct`, `avg`, `min`, `max` or `median`.                                                                                                 |
| `column`    | The column to aggregate. Required for everything but `count`; `count` without a column counts rows, with one it counts non-null values.                            |
| `filters`   | Optional. Rows to keep; see [Filters](#filters).                                                                                                                   |
| `time`      | The date or timestamp column that places a row in time. Needed for time series and period comparison, so set it on almost every metric.                            |
| `over_time` | Optional. `sum` (default) adds rows over each period. `last`, `first`, `avg`, `min` or `max` read a snapshot table instead: see [Snapshots](numbers.md#snapshots). |

Only `sum` and `count` add up across groups, so only they can show a percent of total in a table
(`HM4001` otherwise).

## ratio

**A ratio divides two other metrics**: `numerator / denominator`, both metric names. It has no
`table`, `filters` or `time` of its own; it reads its period and groups through the two metrics,
which may come from different sources. Both sides need a `time` column, or neither. Totals divide
the two totals (never an average of the rows' ratios), and a division by zero or by an empty value
is empty, shown as `—`.

Refund rate, the most common shape, takes three files. The two counts:

`metrics/refunded_orders.yaml`

```yaml
label: Refunded orders
type: aggregate
table: orders
aggregate: count
filters:
  - column: status
    op: eq
    value: refunded
time: ordered_at
format:
  type: number
better: down
```

`metrics/placed_orders.yaml`

```yaml
label: Placed orders
description: Every order, paid or refunded.
type: aggregate
table: orders
aggregate: count
time: ordered_at
format:
  type: number
better: up
```

and the ratio, `metrics/refund_rate.yaml`:

```yaml
label: Refund rate
description: Refunded orders as a share of placed orders.
type: ratio
numerator: refunded_orders
denominator: placed_orders
format:
  type: percent
  decimals: 1
better: down
```

A percent metric holds a fraction (0.059 shows as 5.9%), so its KPI change is in percentage points
(`▼ −0.99 pp`), and `better: "down"` colours a fall as good. Average order value is the same shape:
`numerator: revenue`, `denominator: orders`, currency format, `better: "up"`.

## sql

The escape hatch, for a number no aggregate expresses: one SQL aggregate expression over one source.

```yaml
label: Net revenue
type: sql
table: orders
sql: |
  sum(amount)
    - sum(refund_amount)
additive: true
time: ordered_at
format:
  type: currency
better: up
```

Write SQL longer than a line as a block scalar: `sql: |` and the expression indented on the lines
below, exactly as it reads.

`additive` is `true` only if summing the metric over groups gives the metric over all rows (a sum
or a count). Distinct counts, averages and ratios are `false`. Build warns with `HM4003` when a
table's rows do not add up to its total. `filters` and `time` work as for an aggregate.
`$hm_p` is reserved for the parameters Hatchmark binds, in any case and anywhere in `sql`, inside
strings too. check rejects it with `HM3005`.

## Filters

A filter keeps the rows whose column matches. All filters of a metric must match.

| `op`                                  | Other fields                  | Example                                                                 |
| ------------------------------------- | ----------------------------- | ----------------------------------------------------------------------- |
| `eq`, `neq`, `gt`, `gte`, `lt`, `lte` | `value`                       | `{ column: status, op: eq, value: paid }`                               |
| `in`, `not_in`                        | `values` (one or more)        | `{ column: channel, op: in, values: [ Email, Social ] }`                |
| `between`                             | `from`, `to` (both inclusive) | `{ column: ordered_at, op: between, from: 2026-01-01, to: 2026-03-31 }` |
| `is_null`, `not_null`                 | none                          | `{ column: coupon, op: not_null }`                                      |

`neq` and `not_in` keep rows whose column is empty; the other operators never match an empty value.
Dates are `YYYY-MM-DD` and match the whole local day. [numbers.md](numbers.md#filters) has the exact
rules.

## Targets

A target is a goal for a metric, set once in the metric file so every block that shows the metric
can show it. A block names one with `target: <id>` (kpi, line, area and bar blocks). Targets don't
draw yet: the block's data carries their values for the component that will.

```yaml
targets:
  - id: plan
    label: FY2027 plan
    grain: month
    table: revenue_plan
    date: month
    value: amount
  - id: goal
    label: $12M ARR
    grain: month
    values:
      "2026-12-01": 7400000
      "2027-12-01": 12000000
    path: compound
```

| Field      | Meaning                                                                                                        |
| ---------- | -------------------------------------------------------------------------------------------------------------- |
| `id`       | What a block's `target` names.                                                                                 |
| `label`    | Optional. Shown next to the target; defaults to the id.                                                        |
| `grain`    | The grain the values are set at. Buckets start at the project `anchors`.                                       |
| `values`   | Inline values by bucket start date. Use either `values` or `table`.                                            |
| `table`    | A source holding the values, with `date` (each bucket's start) and `value` columns. Rows of one bucket add up. |
| `prorate`  | Flow metrics: `days` (default when the metric adds up over time) or `none`.                                    |
| `path`     | Point-in-time metrics: `linear` (default) or `compound`.                                                       |
| `segments` | Optional. The segments the target was set for.                                                                 |

A date inside a bucket counts for that bucket. A bucket whose value rows are all empty has no
value, while an explicit 0 is 0. A `table` must be a file source for now: a lookup source as a
target's table is not evaluated yet, so the block shows no target and build warns with `HM4023`.

**Flow targets** (sums and counts over a period) are amounts per bucket.

- A coarser bucket is the sum of the target buckets inside it, and has a target only when every one
  of them has a value: a quarter needs all three months.
- A finer bucket, or a bucket that crosses target buckets (weeks against months), gets each target
  bucket in proportion to its days inside: a week of January gets 7/31 of January's target. check
  notes this with `HM4022`. `prorate: none` shows the target only where its buckets fit whole and
  hides it at finer grains.
- A KPI or category bar reads the target over its window's period, prorated by days at the edges,
  and only when every target bucket the period touches has a value; otherwise it shows no target
  and build warns with `HM4020`. The period is the whole bucket of a to-date range (all of November
  for month to date), the window itself for `last N` ranges, and the range as written otherwise.
- When the window ends before its period does (a to-date range at the horizon, or a range the
  horizon trims), the target also carries a pace: the target times the share of the period elapsed,
  in local wall-clock time, so a month-to-date KPI on November 26 at 2 p.m. is compared with 25.58
  of 30 days. A time series' partial bucket has a pace the same way, by its own elapsed share.
- A metric that doesn't add up over time (an average, a ratio) has a target only at its own grain,
  never summed or split, and no pace: its attainment is the value over the target. Point-in-time
  targets have no pace either.

**Point-in-time targets** (balances, ARR) are values at the end of each bucket. Between two values
the target moves in a straight line (`linear`) or by a constant growth factor (`compound`, which
needs both values positive). There is no target before the first value's bucket end, nor after the
last one's. A bucket reads the target at its end, the bucket the horizon cuts reads it at the
horizon, and a KPI reads it at its window's end.

**Filters and segments.** A table target follows the dashboard's select filters and segment toggles
when its table has their columns, and splits by a block's `by` or `split` column when its table has
that column: each bar and each split series then has its own target. Otherwise the block shows the
target for the whole metric. When a select filter keeps some values of a column the target's table
lacks (inline values have no columns), or a segment is on that the target cannot follow, the block
hides the target and says why; check warns ahead of time with `HM4021`. A target that lists its
`segments` is shown while only those segments are on, without being filtered again.

## Tests

`tests` pins values of the metric so that `hatchmark test` fails when the data or the definition
changes them. Each test reads the metric the way a dashboard does, through the same queries:

```yaml
tests:
  - name: October revenue
    window: [2026-10-01, 2026-10-31]
    expect: 42420.42
  - window: [2026-10-01, 2026-10-31]
    where:
      - column: region
        op: eq
        value: West
    expect: 9490.92
  - window: [2026-10-01, 2026-10-31]
    by: region
    expect: { South: 16101.04, West: 9490.92 }
```

| Field       | Meaning                                                                                                                                                                                           |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `window`    | Metrics summed over time: an inclusive pair of local dates.                                                                                                                                       |
| `at`        | Point-in-time metrics (`over_time` other than `sum`): the value at the end of that local date, from the latest snapshot on or before it.                                                          |
| `where`     | Optional [filters](#filters) added to the metric's own. A ratio or formula applies them to every metric it reads.                                                                                 |
| `segments`  | Optional segments applied as well.                                                                                                                                                                |
| `by`        | Optional column: `expect` then maps each group to its value. Groups not listed are not checked; an empty group is `(empty)`, which fails if the column also holds the text `(empty)`.             |
| `expect`    | The value, in the metric's units after `scale` (no currency or percent formatting).                                                                                                               |
| `tolerance` | Optional absolute difference allowed: \|actual − expected\| ≤ tolerance. Without it, the difference may be at most 0.0000005.                                                                     |
| `data`      | Optional fixture files that replace sources for this test, by source name, such as `{ orders: tests/orders_small.csv }`. Fixture tests pin the definition; tests on the real data pin the number. |
| `name`      | Optional label shown in the results.                                                                                                                                                              |

A test that fails is `HM4030` with the expected and actual values and the difference. Without `by`,
its fix rewrites `expect` and is unsafe, so say when you change a pinned number. `check` reports a
column in `where` or `by` that a source the metric reads doesn't have (`HM2018`); with `data`, the
columns are checked against the fixture when the test runs. A test whose window reaches past the
newest data of a source it reads gets warning `HM4031`: the number can still change.

## Format

| `type`     | Options                                                     | Shows                          |
| ---------- | ----------------------------------------------------------- | ------------------------------ |
| `number`   | `decimals` (0–6), `compact`                                 | `2,784`, or `2.78K` compact    |
| `currency` | `decimals`, `compact`, `currency` (overrides the project's) | `$92.49`, or `$257K` compact   |
| `percent`  | `decimals`                                                  | `5.9%` from the fraction 0.059 |

KPIs switch large currency values to compact notation at 100,000 and plain numbers at 1,000,000 on
their own. Tables show the full value unless `compact` is `true`. A compact value is rounded only
when the result shows a unit such as K, Mio. or 万; when the locale's compact form has no unit for
it, the full value is shown instead. A value can round up into a unit (999,500 is `1 Mio. $` in
de-DE). Where an exact value is too long for a chart, bar charts leave out their inline values and
a donut states its total in the key; tooltips keep the value.
