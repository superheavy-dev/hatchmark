# Metrics (metrics/<name>.json)

A metric is one number Hatchmark can compute for any period and any group: revenue, orders, refund
rate. Each lives in its own file under `metrics/`, and **the file name is the metric's name**:
`metrics/refund_rate.json` is `refund_rate`. Names are lowercase snake_case. Dashboards refer to
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

## aggregate

Aggregates one column of a source, after optional filters.

```json
{
  "label": "Revenue",
  "description": "Paid order amounts in USD, before refunds.",
  "type": "aggregate",
  "table": "orders",
  "aggregate": "sum",
  "column": "amount",
  "filters": [{ "column": "status", "op": "eq", "value": "paid" }],
  "time": "ordered_at",
  "format": { "type": "currency", "compact": true },
  "better": "up"
}
```

| Field       | Meaning                                                                                                                                 |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `table`     | A source name from `hatchmark.json`.                                                                                                    |
| `aggregate` | `sum`, `count`, `count_distinct`, `avg`, `min`, `max` or `median`.                                                                      |
| `column`    | The column to aggregate. Required for everything but `count`; `count` without a column counts rows, with one it counts non-null values. |
| `filters`   | Optional. Rows to keep; see [Filters](#filters).                                                                                        |
| `time`      | The date or timestamp column that places a row in time. Needed for time series and period comparison, so set it on almost every metric. |

Only `sum` and `count` add up across groups, so only they can show a percent of total in a table
(`HM4001` otherwise).

## ratio

**A ratio divides two other metrics**: `numerator / denominator`, both metric names. It has no
`table`, `filters` or `time` of its own; it reads its period and groups through the two metrics,
which may come from different sources. Both sides need a `time` column, or neither. Totals divide
the two totals (never an average of the rows' ratios), and a division by zero or by an empty value
is empty, shown as `—`.

Refund rate, the most common shape, takes three files. The two counts:

`metrics/refunded_orders.json`

```json
{
  "label": "Refunded orders",
  "type": "aggregate",
  "table": "orders",
  "aggregate": "count",
  "filters": [{ "column": "status", "op": "eq", "value": "refunded" }],
  "time": "ordered_at",
  "format": { "type": "number" },
  "better": "down"
}
```

`metrics/placed_orders.json`

```json
{
  "label": "Placed orders",
  "description": "Every order, paid or refunded.",
  "type": "aggregate",
  "table": "orders",
  "aggregate": "count",
  "time": "ordered_at",
  "format": { "type": "number" },
  "better": "up"
}
```

and the ratio, `metrics/refund_rate.json`:

```json
{
  "label": "Refund rate",
  "description": "Refunded orders as a share of placed orders.",
  "type": "ratio",
  "numerator": "refunded_orders",
  "denominator": "placed_orders",
  "format": { "type": "percent", "decimals": 1 },
  "better": "down"
}
```

A percent metric holds a fraction (0.059 shows as 5.9%), so its KPI change is in percentage points
(`▼ −0.99 pp`), and `better: "down"` colours a fall as good. Average order value is the same shape:
`"numerator": "revenue"`, `"denominator": "orders"`, currency format, `better: "up"`.

## sql

The escape hatch, for a number no aggregate expresses: one SQL aggregate expression over one source.

```json
{
  "label": "Net revenue",
  "type": "sql",
  "table": "orders",
  "sql": "sum(amount) - sum(refund_amount)",
  "additive": true,
  "time": "ordered_at",
  "format": { "type": "currency" },
  "better": "up"
}
```

`additive` is `true` only if summing the metric over groups gives the metric over all rows (a sum
or a count). Distinct counts, averages and ratios are `false`. Build warns with `HM4003` when a
table's rows do not add up to its total. `filters` and `time` work as for an aggregate.
`$hm_p` is reserved for the parameters Hatchmark binds, in any case and anywhere in `sql`, inside
strings too. check rejects it with `HM3005`.

## Filters

A filter keeps the rows whose column matches. All filters of a metric must match.

| `op`                                  | Other fields                  | Example                                                                                 |
| ------------------------------------- | ----------------------------- | --------------------------------------------------------------------------------------- |
| `eq`, `neq`, `gt`, `gte`, `lt`, `lte` | `value`                       | `{ "column": "status", "op": "eq", "value": "paid" }`                                   |
| `in`, `not_in`                        | `values` (one or more)        | `{ "column": "channel", "op": "in", "values": ["Email", "Social"] }`                    |
| `between`                             | `from`, `to` (both inclusive) | `{ "column": "ordered_at", "op": "between", "from": "2026-01-01", "to": "2026-03-31" }` |
| `is_null`, `not_null`                 | none                          | `{ "column": "coupon", "op": "not_null" }`                                              |

`neq` and `not_in` keep rows whose column is empty; the other operators never match an empty value.
Dates are `YYYY-MM-DD` and match the whole local day. [numbers.md](numbers.md#filters) has the exact
rules.

## Format

| `type`     | Options                                                     | Shows                          |
| ---------- | ----------------------------------------------------------- | ------------------------------ |
| `number`   | `decimals` (0–6), `compact`                                 | `2,784`, or `2.78K` compact    |
| `currency` | `decimals`, `compact`, `currency` (overrides the project's) | `$92.49`, or `$257K` compact   |
| `percent`  | `decimals`                                                  | `5.9%` from the fraction 0.059 |

KPIs switch large currency values to compact notation at 100,000 and plain numbers at 1,000,000 on
their own. Tables show the full value unless `compact` is `true`. A compact value is rounded only
when it shows a unit such as K, Mio. or 万; where the locale has no unit for that size (de-DE
below a million, ja-JP below ten thousand, every locale below a thousand), the full value is shown
instead.
