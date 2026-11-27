# RFC 0001: Metric and time semantics

- Status: accepted for phase 1 (2026-11-27); draft 4 adds the two entity primitives and the SQL printer
- Author: The Hatchmark Authors
- Date: 2026-11-27
- Base: superheavy-dev/hatchmark main at 1a5224b (metric schema in packages/hatchmark/src/spec/metric.ts, QueryPlan in src/compiler/plan.ts, windows in src/compiler/windows.ts)
- Scope: phase 1. General grammar primitives for time semantics (flow, point-in-time, static), entity state, active intervals, trailing windows, scale, row expressions, lookups (including as-of lookups for currency), formulas, pinned tests, freshness and incomplete periods, time as two primitives (date ranges and anchored grains), targets, segments and granularity switching. ARR, MRR and other SaaS metrics are the expressiveness test, not features.

## 1. Summary

Hatchmark metrics today are one aggregate over one table, placed in time by one column, plus ratios and a raw SQL escape hatch. That covers flows such as revenue and orders. It doesn't cover values that are a _state at an instant_ (balances, headcount, inventory, active users, recurring revenue), values over a rolling window, or values combined from several metrics.

This RFC doesn't add metric types for particular business metrics. It adds general grammar primitives, and uses ARR and its relatives (MRR, run rate, contracted ARR, multi-currency) as the **expressiveness test**: if every common way companies compute ARR fits in a few lines of the grammar without raw SQL, the grammar is expressive enough. ARR, MRR, Stripe and SaaS terms appear only in examples and tests; no schema keyword is specific to them.

The primitives:

1. **Time nature.** Every metric is a _flow_ (summed over a bucket), _point-in-time_ (read at an instant, the semi-additive case) or _static_. Point-in-time values come from snapshots (`over_time`), per-entity state (`over_time` + `entity`), active intervals (`active`) or trailing windows (`trailing`). The engine never sums a point-in-time metric over time.
2. **Row expressions** in `value`, `active.from` and `active.to`, and **lookup sources** (many-to-one and as-of), so normalised exports and rate tables read like one table.
3. **`scale`**, a constant multiplier after aggregation.
4. **`formula`** metrics: strict arithmetic over metric names, with source positions for diagnostics and the same scope checks ratios have today.
5. **Freshness and incomplete periods**, derived from a per-source horizon and marked on every chart, KPI and table.
6. **Time as two primitives**: a date range (half-open, in the project timezone; relative names are shorthands) and a grain with an anchor (where buckets begin). Fiscal years, week starts and comparisons are expressed through them, not named (section 6.2).
7. **Targets, segments, granularity switching and pinned metric tests**, each defined once in the metric layer.
8. **Business definitions are options** with documented defaults that check explains (section 3.11).
9. **Per-entity values at two instants** (`per_entity`, section 3.12): a reference-instant entity filter (`where prior > 0`) and a per-entity cross-instant expression (`least(current, prior)`), summed over entities. This is what retention ratios need, with no retention vocabulary.
10. **The generated SQL is printable** per metric (section 12.1), so an agent can check what a definition means in SQL, which it already knows.

Classifying each entity's change into user-named buckets (a reconciling bridge) is not in phase 1. Section 5 is a phase 2 note on it; phase 1 has the two building blocks it needs (section 3.12).

Everything compiles to one QueryPlan (version 2), which the DuckDB executor turns into SQL. The core stays pure: horizons, bucket bounds, bucket status and target interpolation are computed in the core from results; only SQL runs in the adapter.

Section 3.11 lists every business definition with its default and option; section 14 records the decisions; section 15 lists what is deferred.

## 2. Sample data

Examples and tests use one synthetic US SaaS company, because recurring revenue is the hardest common case for time semantics. The grammar itself has no SaaS concepts. The company is **Larkspur** (project-management software, mostly US customers, some in Canada, the UK and the EU). The files are shaped like a Stripe export. Amounts are in minor units (cents) as Stripe stores them. Nothing here is real company data.

`hatchmark.json` (excerpt):

```json
{
  "currency": "USD",
  "timezone": "America/New_York",
  "anchors": { "week": "sunday", "quarter": "02-01", "year": "02-01" },
  "sources": {
    "customers": { "type": "csv", "path": "data/customers.csv" },
    "subscriptions": { "type": "csv", "path": "data/subscriptions.csv" },
    "subscription_items": { "type": "csv", "path": "data/subscription_items.csv" },
    "items": {
      "type": "lookup",
      "from": "subscription_items",
      "lookups": [
        { "table": "subscriptions", "key": { "subscription": "id" } },
        { "table": "currencies", "key": { "currency": "code" } },
        {
          "table": "fx_rates",
          "key": { "currency": "currency" },
          "asof": { "column": "date", "at": "$evaluation" }
        }
      ]
    },
    "invoice_lines_raw": { "type": "csv", "path": "data/invoice_line_items.csv" },
    "invoice_lines": {
      "type": "lookup",
      "from": "invoice_lines_raw",
      "lookups": [
        { "table": "currencies", "key": { "currency": "code" } },
        {
          "table": "fx_rates",
          "key": { "currency": "currency" },
          "asof": { "column": "date", "at": "paid_at" }
        }
      ]
    },
    "subscription_events": { "type": "csv", "path": "data/subscription_events.csv" },
    "mrr_snapshots": {
      "type": "csv",
      "path": "data/mrr_snapshots.csv",
      "snapshot": "snapshot_date"
    },
    "credit_purchases": { "type": "csv", "path": "data/credit_purchases.csv" },
    "usage": {
      "type": "csv",
      "path": "data/usage_daily.csv",
      "freshness": { "lag": { "days": 1 } }
    },
    "contracts": { "type": "csv", "path": "data/contracts.csv" },
    "fx_rates": { "type": "csv", "path": "data/fx_rates.csv" },
    "currencies": { "type": "csv", "path": "data/currencies.csv" },
    "internal_accounts": { "type": "csv", "path": "data/internal_accounts.csv" },
    "arr_plan": { "type": "csv", "path": "data/arr_plan.csv" }
  }
}
```

The tables:

| Source              | Columns                                                                                                                                                                                                    | Notes                                                                                                                 |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| customers           | id, email, created, country, segment (smb, mid_market, enterprise)                                                                                                                                         | id like `cus_0041`                                                                                                    |
| subscriptions       | id, customer, status (trialing, active, past_due, canceled, unpaid), created, start_date, trial_end, cancel_at_period_end, cancel_at, canceled_at, ended_at, currency, coupon_percent_off, coupon_duration | one row per Stripe subscription                                                                                       |
| subscription_items  | id, subscription, price, product, plan (starter, team, business), unit_amount, currency, interval (day, week, month, year), interval_count, quantity, valid_from, valid_to                                 | **one row per span with constant price and quantity**; a plan change or seat change closes one span and opens another |
| invoice_line_items  | id, invoice, customer, subscription, type (subscription, invoiceitem), amount, currency, period_start, period_end, paid_at                                                                                 |                                                                                                                       |
| subscription_events | id, subscription, customer, occurred_at, type, plan, mrr_after, currency                                                                                                                                   | from `customer.subscription.*` webhooks; `mrr_after` is the subscription's MRR after the event                        |
| mrr_snapshots       | snapshot_date, subscription, customer, plan, segment, mrr_usd                                                                                                                                              | full daily snapshot written by a nightly job                                                                          |
| credit_purchases    | id, customer, created, amount, currency, credits                                                                                                                                                           | prepaid AI credits                                                                                                    |
| usage_daily         | date, customer, units, amount_usd                                                                                                                                                                          | metered usage, lands one day late                                                                                     |
| contracts           | id, customer, signed_at, start_date, end_date, acv_usd                                                                                                                                                     | sales-led annual contracts                                                                                            |
| fx_rates            | date, currency, rate                                                                                                                                                                                       | USD per one unit of `currency`, daily                                                                                 |
| currencies          | code, minor                                                                                                                                                                                                | minor units per major unit (USD 100, JPY 1)                                                                           |
| internal_accounts   | customer                                                                                                                                                                                                   | staff and test accounts                                                                                               |
| arr_plan            | month, segment, arr_target                                                                                                                                                                                 | the board's ARR plan                                                                                                  |

Larkspur's fiscal year starts on February 1, so its quarter and year anchors are `02-01`; its weeks start on Sunday.

Stripe's own subscription export holds only the current state of each item. Spans (`valid_from`/`valid_to`) come from a sync job or from `subscription_schedule` history; when a team has neither, invoice line items are the span source (section 4.2, method B2). The RFC never assumes Hatchmark talks to Stripe; it reads files.

## 3. Building blocks

### 3.1 Time behaviour: flow, point-in-time, static

Every metric has one time behaviour, derived from its fields. It decides how the metric is bucketed, totalled, compared and marked incomplete.

| Behaviour     | Fields                                                            | Value of a bucket [S, E)                     | Total over a window                              | Example                                                                           |
| ------------- | ----------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------- |
| flow          | `time`                                                            | aggregate of rows with time in [S, E)        | aggregate over the window (recomputed from rows) | revenue, signups                                                                  |
| point-in-time | `time` + `over_time` other than `sum`; or `active`; or `trailing` | the value at the bucket's evaluation instant | the value at the window's end                    | account balance, inventory, seats, active customers, ARR, trailing 30-day revenue |
| static        | none                                                              | not bucketed                                 | aggregate over all rows                          | plan catalogue size                                                               |

The **evaluation instant** of a bucket is the last instant inside it: a span or event that ends at exactly E is still counted (section 3.3). For the bucket that contains the horizon (section 6), the instant is the horizon itself, so the current month shows its value "as of now".

Point-in-time metrics built on additive aggregates are additive across groups (balances by region sum to the total balance at the same instant) and never additive over time. That is the semi-additive rule, and the compiler enforces it structurally: for a point-in-time metric the time dimension is in every grouping set, so no SQL ever sums across buckets.

The existing `isAdditive(metric)` becomes `additivity(metric): { groups: boolean; time: "sum" | "point" | "none" }`. HM4001 (percent of total) reads `groups`, so "share of the balance by region" is allowed.

### 3.2 `over_time`: snapshots and event state

```json
{
  "type": "aggregate",
  "label": "ARR",
  "format": { "type": "currency", "compact": true },
  "better": "up",
  "table": "mrr_snapshots",
  "aggregate": "sum",
  "column": "mrr_usd",
  "scale": 12,
  "time": "snapshot_date",
  "over_time": "last"
}
```

`over_time` is one of `sum` (default, a flow), `last`, `first`, `avg`, `min`, `max`. It needs `time`.

**Without `entity`** (a full snapshot table), a bucket's value is the aggregate over the rows at the bucket's _point_: the source's last snapshot date in the bucket (first for `first`). `avg`, `min` and `max` aggregate per snapshot date first, then take the average, minimum or maximum of those per-date values over the dates present in the bucket. Settled rules:

- **The point is a property of the source, chosen before any filter.** With `region = West` selected, the October point is still the source's last October snapshot date, not West's last row. So group values at one point sum to the total, a filtered view never mixes dates, and the browser can re-aggregate filters (materialization stays `grouped`).
- An entity missing at the point counts as absent (0). That is what a full snapshot means.
- A bucket with no snapshot at all is **null**, not 0: a gap, drawn as a break in the line, and HM4015 warns.
- `avg` averages over snapshot dates present, not calendar days. Forward-filling missing days is deferred (section 15).

**With `entity`** (an event log), the value at instant t is the aggregate over entities of each entity's _latest row at or before t_, carried forward until a later row replaces it:

```json
{
  "type": "aggregate",
  "label": "ARR (from events)",
  "format": { "type": "currency", "compact": true },
  "better": "up",
  "table": "subscription_events",
  "aggregate": "sum",
  "column": "mrr_after",
  "scale": 0.12,
  "time": "occurred_at",
  "over_time": "last",
  "entity": "subscription"
}
```

(`scale: 0.12` is cents to dollars, times 12.) Settled rules:

- `entity` must be the key whose state each row describes. Here it is the subscription, not the customer: a customer with two subscriptions has two states. Using `customer` would keep only the latest subscription's MRR. In the validation run (section 13), the customer key undercounted October ARR by 18% on exactly this.
- Dimensions come from the same row as the value: a subscription whose latest event says `plan: business` is in business at t, even if it started on team.
- State reads history before the window start. A dashboard period limits which instants are sampled, not which rows are read.
- An entity's state ends only with a row that says so (value 0). Otherwise the last state carries forward forever. In the example, Stripe's `customer.subscription.deleted` maps to `mrr_after: 0`. Check can't know this; the bundled docs say it, and a metric test (section 3.10) is the guard.

### 3.3 `active`: intervals

A row that holds a value over an interval (a subscription span, a contract, an employment, a reservation, a loan) contributes it at every instant inside the interval. Example:

```json
{
  "type": "aggregate",
  "label": "MRR",
  "format": { "type": "currency", "compact": true },
  "better": "up",
  "table": "items",
  "aggregate": "sum",
  "value": "unit_amount * quantity / currencies.minor * fx_rates.rate * match(interval, 'day', 365.0 / 12, 'week', 365.0 / 7 / 12, 'month', 1, 'year', 1.0 / 12) / interval_count * (1 - coalesce(subscriptions.coupon_percent_off, 0) / 100)",
  "active": {
    "from": "greatest(valid_from, coalesce(subscriptions.trial_end, valid_from))",
    "to": "coalesce(valid_to, subscriptions.ended_at)"
  }
}
```

A row is active at instant t when `from <= t < to` (a null `to` is open-ended). Sampled at the last instant before a bucket end E, that is `from < E and (to is null or to >= E)`. So in the example a subscription that ends at midnight on November 1 counts in October's ending MRR and is gone in November, which is how ChartMogul, Baremetrics and Stripe's own MRR report count it. That is the default, `"ends": "inclusive"`; `"active": { ..., "ends": "exclusive" }` samples at E itself (`from <= E and (to is null or to > E)`), so the subscription is already gone from October's ending value.

`active` replaces `time`; a metric has one or the other. Count metrics work too: `"aggregate": "count_distinct", "column": "customer"` with the same `active` gives paying customers at each month end (not additive across groups, like any distinct count). The ${B}items${B} source here is a lookup source joining subscriptions, currencies and an as-of FX rate (section 3.6).

Edge cases settled:

- `from` null: the row is never active, and check reports the count (HM4018, as unmatched data).
- `to <= from`: never active (zero-length spans from same-second plan changes).
- Intervals that start and end inside one bucket never show in that bucket's ending value.
- A future `to` (a scheduled cancellation) counts until it arrives. A future `from` (a contract that starts next quarter) doesn't count until it starts.

### 3.4 `trailing`: rolling windows

```json
{
  "type": "aggregate",
  "label": "Credit purchase run rate",
  "format": { "type": "currency", "compact": true },
  "better": "up",
  "table": "credit_purchases",
  "aggregate": "sum",
  "column": "amount",
  "time": "created",
  "trailing": { "days": 90 },
  "scale": 0.0405556
}
```

(0.01 for cents × 365/90 to annualise.) `trailing` is `{ "days": n }` or `{ "months": n }`. The value at instant t aggregates rows with time in [t − length, t), measured in the project timezone's wall clock (so a 90-day window across a DST change is 90 local days, not 2,160 hours). A trailing metric is point-in-time: a bar chart of it shows the run rate at each month end, and no total sums it.

Why trailing and not "this bucket × 12": annualising a bucket's flow depends on the grain. Credits this month × 12 is a run rate at month grain, and nonsense when the reader switches to weeks. A trailing window has a fixed length, so the number is the same at any grain. HM4009 enforces this: a formula can't add a flow to a point-in-time metric (section 3.7).

### 3.5 `scale`

`scale` is a constant multiplier applied after aggregation: a unit change (cents to dollars, 0.01; bytes to GB) or an annualisation (12). Scaling keeps additivity. It exists so the conversion lives in the metric file, not in every formula that uses it.

### 3.6 Row expressions and lookups

`value` (instead of `column`), `active.from` and `active.to` take a **row expression**: the formula grammar of section 3.7, where identifiers are columns instead of metrics.

- Columns: `unit_amount`, `subscriptions.trial_end` (a lookup column), or a backquoted name for anything else: `` `Plan Name` ``.
- Literals: numbers, single-quoted strings (`'year'`), `null`.
- Operators: `+ - * /` (division by zero is null), comparisons `= != < <= > >=`, `and`, `or`, `not`.
- Functions: `coalesce`, `greatest`, `least`, `abs`, `if(cond, then, else)`, `is_null(x)`, `date_diff(unit, a, b)` (units `day` and `month`), and `match(x, k1, v1, k2, v2, ..., default?)`.

`match` maps values to results, like SQL's simple `case`: the first `k` equal to `x` gives its `v`; with no match it gives the optional last argument, else null. Check counts rows that hit null this way (HM4018), so an unexpected category doesn't vanish quietly. The section 3.3 example uses it to normalise prices billed per day, week, month or year to a month; nothing in the grammar knows what a billing interval is.

A **lookup source** joins other tables onto a base table, many-to-one, so a normalised export reads like one table:

```json
"items": {
  "type": "lookup",
  "from": "subscription_items",
  "lookups": [
    { "table": "subscriptions", "key": { "subscription": "id" } },
    { "table": "currencies", "key": { "currency": "code" } },
    { "table": "fx_rates", "key": { "currency": "currency" }, "asof": { "column": "date", "at": "$evaluation" } }
  ]
}
```

The lookup's columns appear as `<table>.<column>`. Settled:

- It is a left join, so no base row is lost. Check verifies the key is unique in the looked-up table (HM4017, error, because a duplicate key would multiply rows and every sum) and counts base rows with no match (HM4018, warning).
- **As-of lookups** pick, among rows with an equal key, the latest whose `column` is on or before an instant: a base time column (`"at": "paid_at"`, each row at its own date), or `"$evaluation"`, the instant the metric is evaluated at (only for point-in-time metrics: every row at the bucket end's rate; a flow or static metric on such a source is HM4019, because it has no single instant to join at). The latest row on or before the instant is used (weekends reuse Friday's rate). A base row with no lookup row on or before its instant fails the build (HM4006), listing the key and the first instant, because a silently missing rate is a wrong total. As-of lookups are generic: tax rates, price lists and exchange rates are all the same shape.
- Lookups chain one level in phase 1: every lookup joins on base columns, not on another lookup's columns.

### 3.6.1 Currency and units

There is no currency keyword in the metric grammar. Conversion is an as-of lookup plus a row expression (`amount / currencies.minor * fx_rates.rate`); fixed budget rates are a lookup on a rates table without dates. What stays is the **unit check**: a metric's unit is its `format` (a currency code, a percent, or a plain number), and a formula that adds or subtracts metrics with different currency codes is HM4005. That catches the classic mistake (adding a EUR metric to a USD metric) without the grammar knowing anything about money.

### 3.7 `formula`

```json
{
  "type": "formula",
  "label": "Total ARR",
  "format": { "type": "currency", "compact": true },
  "better": "up",
  "expr": "subscription_arr + credit_run_rate * 0.6"
}
```

Grammar (whitespace between tokens is free):

```
expr    := term (("+" | "-") term)*
term    := unary (("*" | "/") unary)*
unary   := "-" unary | primary
primary := number | ref | call | "(" expr ")"
ref     := name                     ; a metric
call    := ("coalesce" | "min" | "max" | "abs") "(" expr ("," expr)* ")"
name    := [a-z][a-z0-9_]*
number  := [0-9]+ ("." [0-9]+)?
```

Semantics, settled:

- Operands are evaluated in the same block scope (same window, filters, segments, grain), then combined row by row on equal dimension values. Totals combine operand totals; a formula's total is never the sum of its rows unless the formula is linear (below).
- `a / 0` is null. Arithmetic with null is null; `coalesce(x, 0)` opts in to zero.
- **Additivity is derived.** A formula is additive across groups when it is a linear combination of group-additive metrics with constant coefficients and no constant term (`a + b`, `a - 2 * b`, `(a - b) * 12 / 4`). `a + 1000` is not: every group gets the 1,000, the total gets it once. Anything with `/` by a metric, `min`, `max`, `abs` or a product of two metrics is not. A sum or count read with `over_time` `min` or `max` is not group-additive either, because each group can peak on a different date; `last`, `first` and `avg` are, since the snapshot dates are the source's (section 3.2). `ratio` stays as sugar for `a / b`.
- **Time behaviour is derived.** All metric operands must share one behaviour: flow with flow, point-in-time with point-in-time (HM4009), timed with timed (HM2012, as for ratios). Constants mix with anything.
- **Same scope.** Every dashboard filter and segment must bind to every source an operand reads, or the block is rejected (HM2013, as for ratios). Operands that are added or subtracted must have the same currency unit (HM4005).
- Cycles through formulas and ratios are HM2004.
- A formula can't set `filters`; filter the operands. This keeps "same filter on every side" true by construction.

**Positions.** The tokenizer records each token's offset in the decoded string. The JSON parser from #4 gives the string's source range; the diagnostic maps a decoded offset back to the raw source by re-scanning the raw string's escapes, so `"expr": "arr + \u0063redits"` still points at the right column. HM3010 (syntax) and HM2020 (unknown name, with a did-you-mean fix) carry `line`, `column` and a `length` for the offending token:

```
error[HM2020]: unknown metric "credit_runrate" in formula
  --> metrics/total_arr.json:4:33
   |
 4 |   "expr": "subscription_arr + credit_runrate * 0.6"
   |                               ^^^^^^^^^^^^^^ did you mean "credit_run_rate"?
```

### 3.9 Filters: two new operators

`in_table` and `not_in_table` keep rows whose column value appears (or doesn't) in another source's key column:

```json
{ "column": "customer", "op": "not_in_table", "table": "internal_accounts", "key": "customer" }
```

They compile to `exists` / `not exists`, never `not in (subquery)`, so a null in the key list can't empty the result. Settled: a null column value passes `not_in_table` (it isn't a known internal account) and fails `in_table`.

### 3.10 Metric tests

```json
"tests": [
  { "at": "2026-10-31", "expect": 1392474 },
  { "at": "2026-10-31", "where": [{ "column": "plan", "op": "eq", "value": "team" }], "expect": 227106 },
  { "window": ["2026-10-01", "2026-10-31"], "metric": "revenue", "expect": 118240.5 }
]
```

- `at` (point-in-time metrics) reads the value at the end of that local date. `window` (flows) is an inclusive pair of local dates. A test sits in the file of the metric it pins; the `metric` field above is only there to show a flow test in the same list. `where` adds row filters. `by` with an object `expect` (`{ "team": 227106, "business": 803112 }`) checks a breakdown.
- `data` optionally swaps a source for a small fixture: `"data": { "subscription_items": "tests/data/items_small.csv" }`. Fixture tests pin the _definition_; tests on real data pin the _number_ the owner signed off on.
- `tolerance` is absolute, in display units; the default compares after rounding both sides to 6 decimal places.
- `hatchmark check` runs every test of every metric a dashboard uses; `hatchmark test` runs them all. A failure is HM4030 with expected, actual and difference. The fix that rewrites `expect` is marked **unsafe**, so an agent has to say it changed a pinned number.
- A test that reads past the source's horizon (section 6) gets HM4031: the number can still change.

Check also runs **built-in invariants** that need no test: every table total equals SQL `ROLLUP` over the same rows; for every point-in-time metric, group values at a point sum to the total when it is group-additive. A failed invariant is HM9002 (an internal error, because it means Hatchmark is wrong, not the spec).

### 3.11 Business definitions are options

Hatchmark separates two kinds of rule. **Correctness rules** are fixed: never sum a point-in-time metric over time, a snapshot's point is chosen before filters, both sides of a formula get the same filters and window, a missing as-of lookup row fails, a lookup never multiplies rows. **Business definitions** differ between companies, so each is an option with a documented default. Nothing in this RFC hard-codes a business definition.

| Definition                                                                              | Default                                                                                                                                                            | Option                                                                                    |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| Where week, quarter and year buckets begin                                              | week `monday`, quarter and year `01-01`                                                                                                                            | `anchors` in hatchmark.json, or a block's grain anchor (section 6.2)                      |
| How a year or quarter bucket is labelled                                                | by its start ("Feb 2026 – Jan 2027")                                                                                                                               | grain `label: "end"` ("2027")                                                             |
| Whether an interval ending exactly at a bucket end counts in that bucket                | yes (matches how billing tools count a subscription ending at midnight)                                                                                            | `active.ends`: `"inclusive"` (default) or `"exclusive"` (a span ending at E is gone at E) |
| Anything domain-specific (in the example: trials, past due, coupons, billing intervals) | nothing built in                                                                                                                                                   | row expressions and filters (section 4.2 shows each choice)                               |
| Snapshot `avg`                                                                          | over the snapshot dates present                                                                                                                                    | calendar-day forward fill (deferred)                                                      |
| A date column's newest date                                                             | complete                                                                                                                                                           | source `freshness` (section 6.1)                                                          |
| Naive timestamps                                                                        | UTC                                                                                                                                                                | source `timezone`                                                                         |
| `latest_data`                                                                           | the newest source                                                                                                                                                  | `"asOf": "latest_common_data"` (section 6.3)                                              |
| Rolling window when its source lags                                                     | slides back to stay full length                                                                                                                                    | `period.rollingLag: "trim"` (section 6.4)                                                 |
| Partial buckets                                                                         | marked                                                                                                                                                             | block `incomplete`: `"hide"`, `"show"` (section 6.5)                                      |
| First bucket of a time series                                                           | snapped to a whole bucket                                                                                                                                          | block `edges: "clip"` (section 6.5)                                                       |
| As-of lookup instant                                                                    | none: the lookup names it                                                                                                                                          | `asof.at`: a base column or `$evaluation`                                                 |
| Flow targets at a finer grain                                                           | prorated by days when the metric adds up over time (sums, counts, linear formulas of them); not shown otherwise, and `prorate: "days"` on another metric is HM3007 | target `prorate: "none"` hides them (section 7)                                           |
| Point-in-time target path                                                               | linear                                                                                                                                                             | target `path: "compound"`                                                                 |

**Check explains the defaults it applies.** For each metric and block that relies on a default from this table, check emits HM4040 (note), once per definition, naming the default and the option that changes it, for example: `note[HM4040]: dashboards/finance.json uses edges "snap": the first week starts on Sun Oct 26, before the range starts on Oct 29; set "edges": "clip" to start exactly at the range`. Human output folds these into one line per file ("3 default definitions, run hatchmark check --explain-defaults"), and JSON output lists them all, so an agent can surface them without flooding a person. Setting an option explicitly, even to its default value, silences that note.

### 3.12 `per_entity`: one entity at two instants

Two primitives, one metric type. Both evaluate a point-in-time metric **per entity** at the evaluation instant (`current`) and at a reference instant a fixed offset earlier (`prior`), then aggregate over entities.

```json
{
  "type": "per_entity",
  "label": "Retained ARR, gross",
  "format": { "type": "currency", "compact": true },
  "better": "up",
  "of": "arr",
  "key": "subscriptions.customer",
  "prior": { "months": 12 },
  "where": "prior > 0",
  "expr": "least(current, prior)"
}
```

| Field       | Meaning                                                                                                                                                                                                                                                                                                                        |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `of`        | A point-in-time metric built on `sum` or `count` (HM4008 otherwise), evaluated per entity.                                                                                                                                                                                                                                     |
| `key`       | The entity column in `of`'s source (lookup columns allowed).                                                                                                                                                                                                                                                                   |
| `prior`     | The reference instant: `{ "days": n }` or `{ "months": n }` before the evaluation instant, in local wall-clock time, with the month-end clamp of section 6.2.                                                                                                                                                                  |
| `where`     | **Reference-instant entity filter** (primitive 16): a condition over `current` and `prior` that fixes the set of entities, such as `prior > 0` (entities that had value 12 months ago). Default: every entity.                                                                                                                 |
| `expr`      | **Per-entity cross-instant expression** (primitive 17): combines one entity's two values before aggregation, such as `least(current, prior)`. Default `current`. Grammar: section 3.7 numbers and operators, the names `current` and `prior`, comparisons, `and`/`or`/`not`, and `least`, `greatest`, `coalesce`, `abs`, `if`. |
| `aggregate` | `sum` (default) of `expr`, or `count` of entities passing `where`.                                                                                                                                                                                                                                                             |
| `group_at`  | When a block splits by a column, which instant's row gives an entity its group: `current` (default; falls back to `prior` when the entity has no current value) or `prior` (a cohort view). A business definition, so HM4040 explains the default.                                                                             |

Settled rules:

- **An entity missing at an instant counts as 0**, so a customer who left has `current = 0` and one who joined has `prior = 0`. That's what makes `where prior > 0` a cohort and `least(current, prior)` a gross-retention numerator.
- Both values are computed with the same filters and segments as the block, and `of`'s own definition (snapshot point, carried-forward state, interval sampling) applies at both instants.
- `per_entity` is itself point-in-time: it is read at bucket ends, never summed over time. It's group-additive when `aggregate` is `sum` or `count`, so `percentOfTotal` works.
- Incomplete periods: at the partial bucket, `current` is read at the horizon and `prior` at the horizon minus the offset.
- `current` and `prior` are the only names an expression can use (HM2020 otherwise, with positions as in section 3.7).

## 4. Expressiveness test: ARR and MRR

This section is examples only. It checks that the common ways companies compute ARR fit the primitives above without new keywords. Each method is one or two short files. ARR is always MRR × 12 unless stated; we write it with `scale`.

### 4.1 Snapshot table (subscription MRR × 12)

Section 3.2's first example. Declaring `"snapshot": "snapshot_date"` on the source requires every aggregate on it, directly or through a lookup whose base it is, to read one snapshot date at a time: `time` must be the snapshot column and `over_time` one of `last`, `first`, `avg`, `min`, `max`. Leaving `over_time` at `sum`, no `time`, another time column, `trailing`, `active` or `entity` (a full snapshot holds every entity at each date, so carrying a missing key forward would count it after it's gone) is an error (HM4007); a `sql` metric on it is a warning, since it cannot set `over_time` yet. A snapshot lookup table (rates, say) doesn't make the base rows repeat, so it is not checked. This catches the exact bug in Plotly's guide (an ARR summed over 30 daily snapshots is 30× too large; in the validation run, October's naive sum was 42.3M against a true 1.39M).

### 4.2 Subscription spans (Stripe shape)

**B1, from subscription items.** Section 3.3's example covers price × quantity per interval, coupons, trials, past due and currency. How each Stripe concept maps:

| Stripe concept                           | Expression                                                                                                  | Default and alternatives                                                                                                                                 |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Plan change, seat change                 | a new item span                                                                                             | span history is required; without it, use B2                                                                                                             |
| Quantity                                 | `unit_amount * quantity`                                                                                    | tiered prices: export the computed amount per span instead                                                                                               |
| Interval, interval_count                 | `match(interval, 'day', 365.0 / 12, 'week', 365.0 / 7 / 12, 'month', 1, 'year', 1.0 / 12) / interval_count` | the factors are the user's: 4.33 weeks per month works the same way                                                                                      |
| Percent coupon, `forever` or `repeating` | `* (1 - coalesce(subscriptions.coupon_percent_off, 0) / 100)`                                               | `once` coupons are excluded from MRR (they discount one invoice, not the recurring rate); filter or `if(subscriptions.coupon_duration = 'once', 0, ...)` |
| Amount-off coupon                        | `- coalesce(amount_off_monthly, 0)`                                                                         | a coupon that expires mid-span needs its own span; see deferred `@at`, section 15                                                                        |
| Trial                                    | `from: greatest(valid_from, coalesce(subscriptions.trial_end, valid_from))`                                 | count trials: `from: valid_from`                                                                                                                         |
| past_due, unpaid                         | counts until `ended_at`                                                                                     | Stripe ends the subscription when dunning gives up; to drop past_due earlier you need status history, so use B3                                          |
| cancel_at_period_end                     | counts until `ended_at`, which Stripe sets at the period end                                                | "ARR excluding scheduled cancellations": `to: coalesce(valid_to, subscriptions.ended_at, subscriptions.cancel_at)`                                       |
| Multi-currency                           | `/ currencies.minor * fx_rates.rate` via the lookup                                                         | section 3.6.1                                                                                                                                            |

**B2, from invoice line items** (when there is no span history). Paid subscription line items are spans by nature:

```json
{
  "type": "aggregate",
  "label": "MRR (invoiced)",
  "format": { "type": "currency" },
  "better": "up",
  "table": "invoice_lines",
  "aggregate": "sum",
  "value": "amount / currencies.minor * fx_rates.rate * 30.436875 / greatest(date_diff('day', period_start, period_end), 1)",
  "filters": [{ "column": "type", "op": "eq", "value": "subscription" }],
  "active": { "from": "period_start", "to": "period_end" }
}
```

(30.436875 is the mean month length, 365.2425/12.) Invoice-based MRR includes prorations and one-off discounts as billed; that's the point of the method, and its label should say so.

**Counting subscribers.** `"aggregate": "count_distinct", "column": "subscriptions.customer"` with the same `active` block.

### 4.3 Subscription events (event-sourced state)

Section 3.2's second example. Settled for this shape: the event table must hold the state after each event (`mrr_after`), not a delta. Deltas would need a running sum per entity, which is a cumulative metric; deferred (section 15). Most billing webhooks carry the full new state anyway.

### 4.4 Run rate from revenue

Last month × 12, and trailing N days annualised:

```json
{
  "type": "aggregate",
  "label": "Revenue run rate (30d)",
  "format": { "type": "currency", "compact": true },
  "better": "up",
  "table": "invoice_lines",
  "aggregate": "sum",
  "time": "paid_at",
  "value": "amount / currencies.minor * fx_rates.rate",
  "trailing": { "days": 30 },
  "scale": 12.1667
}
```

(`scale` = 365/30; cents and FX are in the row expression.) "Last calendar month × 12" is `trailing: { "months": 1 }, "scale": 12` read at a month-end instant: a KPI with `range: last_complete_month`, or a monthly chart, where every complete bucket's instant is its month end. In the current partial month it shows the last 30-odd days, a full-length window, so the run rate never dips just because the month isn't over.

### 4.5 Usage and credit annualisation

Two definitions teams actually use, both trailing:

- **Consumption run rate**: `usage` source, `sum(amount_usd)`, `trailing: { days: 30 }`, `scale: 12.1667`. The `usage` source lags a day, so its horizon is a day behind; the KPI says "through Nov 25" (section 6).
- **Purchase run rate**: section 3.4's `credit_run_rate` over 90 days, which smooths lumpy prepaid purchases.

Combined with subscriptions, section 3.7's `total_arr` formula. The factor (0.6, say, the share of credit purchases the company treats as recurring) is a number in the formula, visible in review.

### 4.6 Contracted vs recognised ARR

- **Recognised (live) ARR** is any method above: only what is billing today.
- **Contracted ARR (CARR)** counts signed contracts from signature until they end, including those not yet started:

```json
{
  "type": "aggregate",
  "label": "Contracted ARR",
  "format": { "type": "currency", "compact": true },
  "better": "up",
  "table": "contracts",
  "aggregate": "sum",
  "column": "acv_usd",
  "active": { "from": "signed_at", "to": "end_date" }
}
```

- "Committed ARR" = live ARR + signed but not started: a formula over a live metric and a contracts metric with `active: { from: "signed_at", to: "start_date" }`.
- Recognised _revenue_ (spreading invoice amounts over service days) is a flow with day-level spreading; deferred (section 15).

### 4.7 Multi-currency

Period rates, each payment at its own date:

```json
"invoice_lines": {
  "type": "lookup", "from": "invoice_lines_raw",
  "lookups": [
    { "table": "currencies", "key": { "currency": "code" } },
    { "table": "fx_rates", "key": { "currency": "currency" }, "asof": { "column": "date", "at": "paid_at" } }
  ]
}
```

Fixed budget rates, typical for board reporting: a `budget_rates` table (currency, rate) without dates and a plain lookup on `currency`. A point-in-time metric that should move with FX uses `"at": "$evaluation"` (section 3.6). The grammar sees three ordinary lookups in all three cases.

### 4.8 Combinations

Any formula over the metrics above, subject to section 3.7's checks. Examples: `subscription_arr + credit_run_rate * 0.6`; `live_arr + signed_not_started_arr`; `arr / paying_customers` (ARPA, non-additive).

### 4.9 Net and gross revenue retention

Both are formulas over `per_entity` metrics with a 12-month reference instant:

```json
{
  "type": "per_entity",
  "label": "ARR a year ago, retained cohort",
  "format": { "type": "currency" },
  "better": "up",
  "of": "arr",
  "key": "subscriptions.customer",
  "prior": { "months": 12 },
  "where": "prior > 0",
  "expr": "prior"
}
```
```json
{
  "type": "per_entity",
  "label": "Cohort ARR now",
  "format": { "type": "currency" },
  "better": "up",
  "of": "arr",
  "key": "subscriptions.customer",
  "prior": { "months": 12 },
  "where": "prior > 0"
}
```
```json
{
  "type": "formula",
  "label": "Net revenue retention",
  "format": { "type": "percent", "decimals": 1 },
  "better": "up",
  "expr": "cohort_arr_now / cohort_arr_prior"
}
```

GRR is the same formula with section 3.12's `least(current, prior)` metric as the numerator. The cohort is fixed at the reference instant, new customers can't enter the numerator, and a churned customer counts as 0, which is the standard definition. "Logo retention" is the same pair with `"aggregate": "count"` and `where: "prior > 0 and current > 0"` over `where: "prior > 0"`. One-month NRR is the same pair with `"prior": { "months": 1 }`: a single month's ratio, labelled as monthly. Compounding twelve monthly ratios, each over its own cohort, is a different number and needs a product across buckets, which phase 1 doesn't have (section 15).

The ARR bridge (new, expansion, contraction, churn) needs user-named buckets that partition entities; that is the phase 2 note in section 5.

## 5. Phase 2 note: comparing an entity at two instants

Not in phase 1, and no schema in phase 1 names any kind of change. This note records how retention and change analysis would fit later, so phase 1 doesn't block it.

The primitive would be generic: evaluate a point-in-time metric per entity at two instants (a bucket's start and end, or an end and a fixed offset such as 12 months earlier), then sum each entity's before/after values into **buckets the user defines as conditions on `before` and `after`**. The user names the buckets; Hatchmark knows none of the names. Sketch, with SaaS names supplied by the user:

```json
{
  "type": "compare",
  "of": "arr",
  "entity": "subscriptions.customer",
  "buckets": {
    "new": { "when": "before <= 0 and after > 0", "value": "after - before" },
    "expansion": { "when": "before > 0 and after > before", "value": "after - before" },
    "contraction": { "when": "after > 0 and after < before", "value": "before - after" },
    "churn": { "when": "before > 0 and after <= 0", "value": "before - after" }
  }
}
```

Rules it would need, all generic: buckets must partition the entities (check proves conditions are exhaustive and disjoint, or the remainder becomes an unnamed residual shown as such), so the user's bridge reconciles; a "was ever active before" input for definitions like reactivation; per-(entity, group) versus per-entity evaluation when split by a dimension (an option, with a default); FX at the two instants. NRR and GRR would be formulas over the buckets.

Evidence that the mechanism is sound: in the validation run (section 13), comparing each customer's state at consecutive month ends and partitioning the differences reconciled to ending ARR with zero residual over 18 months.

## 6. Incomplete periods

No peer product marks incomplete periods from the data, so every rule below is explicit. The goal: a reader never mistakes "the month isn't over" or "this source hasn't landed yet" for a drop.

### 6.1 Definitions

- **As-of instant T.** From the dashboard's `period.asOf`: a fixed date means the end of that local date; `latest_data` resolves once per plan (section 6.3).
- **Source horizon H(source).** The instant a source is complete through. Default: the maximum of the time column the metric uses, over **all rows, ignoring filters and segments**. A timestamp gives that instant; a date column means the whole date is complete (H = end of that local date). A selected region with no recent sales must not make the period look unfinished.
- **Measure horizon** = min(T, H of every source the measure reads). A formula is as complete as its laggiest operand.
- **Bucket status**, for a bucket [S, E) in the project timezone: `complete` when horizon ≥ E; `partial` when S < horizon < E, with `elapsed` = (horizon − S) / (E − S) in local wall-clock time; buckets at or after the horizon are not produced.

Source `freshness` overrides the default:

```json
"usage": { "type": "csv", "path": "data/usage_daily.csv", "freshness": { "lag": { "days": 1 } } }
```

| `freshness`                                    | Horizon                                                                       |
| ---------------------------------------------- | ----------------------------------------------------------------------------- |
| (absent)                                       | max(time column) as above                                                     |
| `{ "column": "exported_at" }`                  | max of another column, such as an export timestamp                            |
| `{ "lag": { "days": 1 } }` or `{ "hours": 6 }` | default horizon minus the lag (the newest day is still filling)               |
| `{ "through": "as_of" }`                       | T itself: the source is complete whenever the build runs (sparse logs, spans) |
| `{ "through": "2026-11-26" }`                  | end of that date                                                              |

### 6.2 Time: date ranges and anchored grains

Time in Hatchmark is two primitives. Everything else (fiscal years, week starts, "last complete month", "same period last year") is expressed through them.

**1. Date range.** A start and an end, half-open: `[start, end)`, in the project `timezone`. Dates mean local midnight.

```json
"range": { "start": "2026-02-01", "end": "2026-11-01" }
```

Relative ranges are shorthands that the core resolves to a concrete start and end once the as-of instant T is known (section 6.3), before any query runs; the plan and every diagnostic show the resolved dates. The shorthands are generic in the grain:

| Shorthand                                              | Resolves to                                                               |
| ------------------------------------------------------ | ------------------------------------------------------------------------- |
| `{ "last": 30, "unit": "day" }` (`last_30_days`)       | [T's day − 29 days, T's day + 1 day)                                      |
| `{ "to_date": "quarter" }` (`quarter_to_date`)         | [start of the quarter bucket containing T, T's day + 1 day)               |
| `{ "last_complete": "month" }` (`last_complete_month`) | the last month bucket whose end ≤ T's day + 1 day                         |
| `{ "last": 12, "unit": "month" }` (`last_12_months`)   | 12 month buckets ending with the one containing T, cut at T's day + 1 day |
| `all_time`                                             | unbounded                                                                 |

The existing names (`last_7_days`, `month_to_date`, `last_complete_year`, …) stay as aliases, so current specs keep working. "Quarter" and "year" in a shorthand use the project's quarter and year anchors, so `year_to_date` for Larkspur starts on February 1.

**2. Grain with an anchor.** A unit (day, week, month, quarter, year) and an anchor that says where buckets begin: a weekday for weeks, a month-day for quarters and years (`"02-01"`: quarters start Feb 1, May 1, Aug 1, Nov 1). Months and days have no anchor.

```json
"anchors": { "week": "sunday", "quarter": "02-01", "year": "02-01" }
```

Project defaults live in hatchmark.json (`anchors`, replacing `weekStart`; the default is week `monday`, quarter and year `01-01`). A block can override one: `"grain": { "unit": "year", "anchor": "07-01" }`; a bare `"grain": "month"` uses the defaults. A "fiscal year" is year grain with an anchor; a week start is the week anchor. A quarter anchor must start a 3-month cycle consistent with the year anchor when both are set, or check says so (HM3007). Anchors `MM-29` to `MM-31` are rejected (HM3005), since they don't exist every month.

**Comparisons are range shifts by grain units.** `{ "shift": { "unit": "year", "by": -1 } }` moves both ends of the resolved range back one year (same period last year); `previous_period` is a shift by the range's own length in its own unit (a to-date or complete range of one quarter shifts by −1 quarter; `last 30 days` by −30 days). A window of whole months (start and exclusive end on the 1st of a month) shifted by months, quarters or years moves both ends and stays whole months: February 2020 one year back from March 2021 is all of February 2020, Feb 29 included. Any other window moves its first and last day, each keeping its day of the month clamped to the target month's length (Mar 31 − 1 month = Feb 28/29), so it is never empty. Day and week shifts keep the day count exactly; month, quarter and year shifts can change it with the lengths of the months spanned (Jan 20–Feb 10 is 22 days, Feb 20–Mar 10 is 19), and to-date ranges cover the same elapsed days of their bucket (section 6.4). `previous_year` is exactly `{ "shift": { "unit": "year", "by": -1 } }` for every range kind. This fixes the pre-RFC rule, which moved the exclusive end of rolling day ranges: `last_7_days` as of 2025-02-28 compared 8 days (Feb 22 to Feb 29, 2024) with 7. `resolveRange()` is the definition.

Labels: a year or quarter bucket is labelled by its span ("Feb 2026 – Jan 2027", "Feb – Apr 2026") unless the anchor is `01-01`, where it's "2026" and "Q1 2026". `"label": "end"` on the grain names a year by the calendar year it ends in ("2027"); that is the business convention for fiscal years and stays an option (section 3.11).

Timezone rules:

- Timestamps with an offset are instants. Naive timestamps are UTC unless the source sets `"timezone": "America/Chicago"`; HM4016 (note) asks the question when a non-UTC project reads naive timestamps. Date columns are local dates and never shift.
- Day buckets are 23 or 25 local hours on DST days. `elapsed` uses local wall-clock time, so 2 p.m. is 14/24 of the day on any day.
- A week belongs to the bucket of its first day and is labelled by it ("Week of Nov 22"). There is no week numbering, so no ISO week 53 question.

### 6.3 Resolving `latest_data`

`latest_data` resolves to the **newest** horizon among the dashboard's flow and snapshot sources, then every measure is marked against its own horizon. A lagging source shows its own partial buckets; fresher sources aren't held back by it. This is the default. `"asOf": "latest_common_data"` resolves to the **oldest** voting horizon instead, so every chart ends on the same day, at the cost of hiding the freshest sources' newest data.

Settled edge cases:

- Sources with `freshness.through: "as_of"` and sources read only by `active` metrics don't vote, since their max dates are sparse or in the future (a contract ending in 2028). A dashboard with only such sources and `latest_data` fails with HM4011: set `asOf` or a freshness rule.
- Future-dated rows (a typo dated 2099, scheduled invoices) would push T into the future. Check compares horizons with the build machine's clock and warns (HM4012) when a horizon is more than a day ahead. The clock is used only for the warning, never for output, so builds stay byte-identical.
- A fixed `asOf` earlier than the data: rows after T are ignored, and buckets up to T are complete.
- A fixed `asOf` later than a source's horizon: that source's measures are partial or empty after its horizon, and HM4010 warns.

### 6.4 Windows and comparisons

`resolveRange()` stays the definition of each range in whole local dates. The horizon trims it:

| Range kind         | When the measure horizon is before the window end                                               | Comparison                                                                                                                         |
| ------------------ | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| to-date            | value through the horizon                                                                       | the previous unit through the same elapsed local time (Oct 1 to Oct 26 2:03 p.m. vs Nov 1 to Nov 26 2:03 p.m.); day clamp as today |
| last N units       | the window **slides back** to end at the horizon, keeping its length ("30 days through Nov 25") | the same length before it, from the slid window                                                                                    |
| last complete unit | value marked partial, "through Oct 28"                                                          | the comparison unit trimmed to the same elapsed span                                                                               |
| all_time           | through the horizon                                                                             | none                                                                                                                               |

For point-in-time metrics "through the horizon" means "at the horizon": ARR now vs ARR at the same elapsed point of the previous unit.

Sliding a rolling window is the default. `period.rollingLag: "trim"` keeps the window's dates and trims both it and its comparison to the same elapsed span instead, marking the value partial.

### 6.5 Time series

- **Flows**: the partial bucket is drawn and marked. Complete buckets with no rows are 0 (zero-filled on a date spine); buckets after the horizon don't exist.
- **Point-in-time**: the partial bucket's value is the state at the horizon. It isn't biased low, so it isn't dashed; it gets the "as of" label instead.
- **Snapshots**: buckets with no snapshot are null (gaps), never 0.
- **Leading edge.** For a time-series block, the window start snaps back to the start of its bucket by default, so the first week of "last 30 days at weekly grain" is a full week instead of a misleading short bar. KPIs keep the exact window. Block option `"edges": "clip"` keeps the exact window and marks the clipped first bucket partial, like the last one.
- Block option `"incomplete": "mark" | "hide" | "show"`, default `mark`. `hide` drops partial buckets; `show` draws them plainly, and check warns (HM4014) for a flow with a partial last bucket.

### 6.6 How each component shows it

The look comes from the Default theme in Paper first (new tokens for the partial treatment); this RFC fixes the behaviour, not the pixels.

| Component            | Flow metric, partial bucket                                                                                              | Point-in-time metric, partial bucket                                      |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| Line, area           | last segment dashed, hollow end point; area fill lighter                                                                 | solid line, hollow end point                                              |
| Bar (incl. stacked)  | the whole bar (all stack parts) in the partial treatment                                                                 | normal bar, hollow outline marker                                         |
| Tooltip (all charts) | "Nov 1–26 · in progress (26 of 30 days)"                                                                                 | "As of Nov 26, 2:03 PM"                                                   |
| KPI                  | value labelled "Nov 1–26" or "through Oct 28" when trimmed; delta vs the same elapsed span, with the span in its tooltip | "as of Nov 26"; delta vs the same point last period                       |
| KPI sparkline        | last point hollow                                                                                                        | same                                                                      |
| Table with time rows | partial row muted with "(in progress)"; total row labelled "through Nov 26"                                              | partial row labelled "as of"; total = last row's value, labelled "Ending" |
| Text block           | `{{metric.through}}` inserts the horizon date                                                                            | same                                                                      |
| Dashboard header     | "Data through Nov 26, 2026, 2:03 PM ET"; when sources differ by a day or more, "Usage through Nov 25" beneath            |                                                                           |

Accessibility: the dash or hollow point is never the only signal; the tooltip, the table and the SVG's accessible description say "in progress" or "as of".

### 6.7 What check says

| Code   | Severity | When                                                                                                                         |
| ------ | -------- | ---------------------------------------------------------------------------------------------------------------------------- |
| HM4010 | warning  | a source's horizon is more than one day behind the dashboard's as-of; names the source, both dates and the fix (`freshness`) |
| HM4011 | error    | `latest_data` has no source to resolve from                                                                                  |
| HM4012 | warning  | a horizon is more than a day after the build machine's clock (future-dated rows); lists the first rows                       |
| HM4013 | warning  | a block's window has no data before its horizon (a KPI that would be empty)                                                  |
| HM4014 | warning  | `incomplete: "show"` on a flow whose last bucket is partial                                                                  |
| HM4015 | warning  | a snapshot source has a bucket with no snapshot, or its last snapshot in a complete bucket isn't on the bucket's last day    |
| HM4016 | note     | naive timestamps in a project whose timezone isn't UTC                                                                       |

## 7. Goals and targets

Targets live in the metric file, so every block that shows the metric can show them.

```json
"targets": [
  { "id": "plan", "label": "FY2027 plan", "table": "arr_plan", "grain": "month", "date": "month", "value": "arr_target" },
  { "id": "goal_12m", "label": "$12M ARR", "grain": "month", "values": { "2026-12-01": 7400000, "2027-12-01": 12000000 }, "path": "compound" }
]
```

- A target is a set of bucket values at one grain: from a table (`grain`, a date column holding each bucket's start, a `value` column, optional extra columns as dimensions) or inline `values` keyed by bucket start date (`"2027-02-01": 9000000` for a year anchored `02-01`).
- **Flow targets** are amounts per period. At a coarser grain they sum (a quarter shows only when all three months exist); at a finer grain they prorate by days in the overlap by default, and check notes it (HM4022, note); `"prorate": "none"` hides the target at grains finer than its own. In a partial bucket the pace target is target × elapsed, so "on pace" means something on November 26.
- **Point-in-time targets** are values at a period's end. Between points they follow `path` (`linear` or `compound`, default `linear`); before the first point there's no target. In a partial bucket the target is read at the horizon.
- Blocks: `"target": "plan"` on kpi (attainment percent, progress bar, good/bad from `better`), line and area (target line), bar (target tick per bar).
- **Segments and filters.** A target table's extra columns act as dimensions: with `split: "segment"` each series gets its own target. When a dashboard filter or segment toggle is active and the target table lacks that column, the target hides and the block says why; check warns ahead of time (HM4021). A target may declare the segments it was set for (`"segments": ["external"]`); otherwise toggling a segment hides it.
- Checks: HM2022 unknown target id; HM4020 the target covers none or only part of the window (warning); currency is the metric's.

## 8. Segments

A segment is a named row filter defined once, `segments/<name>.json` (the directory is `segmentsDir` in hatchmark.json, optional, default `segments`):

```json
{
  "label": "External customers",
  "filters": [
    { "column": "customer", "op": "not_in_table", "table": "internal_accounts", "key": "customer" }
  ]
}
```

- **In a metric**, `"segments": ["external"]` always applies; it's part of the definition (ARR excludes staff accounts).
- **On a dashboard**, a toggle:

```json
{ "type": "segment", "id": "audience", "segments": ["external", "paid"], "default": ["external"] }
```

Selected segments combine with AND.

- A segment applies to every source that has its columns, the same rule as select filters, and HM2013 rejects a block where it binds to only some of the sources (a formula would divide filtered by unfiltered). HM2021 is an unknown segment.
- Composition: segments filter rows before anything else, so point-in-time state, targets (section 7) and tests (`"segments"` on a test) all see the segmented rows. Snapshot points stay filter-independent (section 3.2).
- Materialization: a segment becomes a boolean grouping column when every component re-aggregates, else one result per combination, exactly like select filters.

## 9. Granularity switching

```json
{ "type": "line", "metrics": ["arr"], "grain": "month", "grains": ["week", "month", "quarter"] }
```

- `grains` adds a switch on the card; `grain` is the default and must be in `grains` (HM3007). A dashboard-level `{ "type": "grain", "id": "grain", "options": ["week", "month"], "default": "month" }` filter drives every block that lists the chosen grain.
- Build mode precomputes one query per grain. Each grain has its own bucket status and target values, all computed at build time, so switching is instant and never re-derives numbers in the browser.
- Point-in-time metrics re-sample at the new bucket ends; flows re-bucket; trailing metrics keep their length. Grain options can carry anchors like any grain.
- Tables gain `grain` (time rows), so ARR by month can be a table.
- HM5001 warns when a grain produces more than 1,000 points per series (day grain over all time).

## 10. Composition

|               | Point-in-time (snapshot, entity, active) | Trailing                  | Formula                    | Incomplete                    | Targets                     | Segments                              | Grain switch              |
| ------------- | ---------------------------------------- | ------------------------- | -------------------------- | ----------------------------- | --------------------------- | ------------------------------------- | ------------------------- |
| Point-in-time |                                          | mixes in formulas         | allowed, same nature       | value at horizon, "as of"     | read at bucket end via path | rows filtered first; points unchanged | re-sampled at bucket ends |
| Trailing      |                                          |                           | allowed with point-in-time | full-length window at horizon | as point-in-time            | yes                                   | length fixed              |
| Formula       |                                          |                           | nested, no cycles          | min horizon of operands       | allowed                     | must bind to every operand source     | per grain                 |
| Flow          | not with point-in-time (HM4009)          | use trailing to annualise | allowed with flows         | dashed, elapsed               | sum / prorate, pace         | yes                                   | re-bucketed               |

Every row also composes with the two time primitives: ranges decide which instants are sampled or summed, anchored grains decide where buckets begin, and shifts decide the comparison.

## 11. QueryPlan changes (version 2)

`PLAN_VERSION` becomes 2; the plan hash changes with it. Planner and executor contracts below are additive to plan.ts.

```ts
type RowExpr =
  // compiled row expression
  | { op: "col"; column: string; lookup?: string }
  | { op: "lit"; value: number | string | null }
  | {
      op: "call";
      fn: "coalesce" | "greatest" | "least" | "abs" | "if" | "is_null" | "match" | "date_diff";
      args: RowExpr[];
    }
  | {
      op: "+" | "-" | "*" | "/" | "=" | "!=" | "<" | "<=" | ">" | ">=" | "and" | "or";
      args: [RowExpr, RowExpr];
    }
  | { op: "not"; args: [RowExpr] };

interface MeasureComponent {
  // existing: id, aggregate, column, sql, filters, reaggregate
  value?: RowExpr; // instead of column
  scale?: number;
}

/** How a query places rows in time. Part of the query id: measures with different evaluation never share a query. */
type Evaluation =
  | { kind: "flow"; column: string }
  | { kind: "snapshot"; column: string; pick: "last" | "first" | "avg" | "min" | "max" }
  | { kind: "entity_state"; column: string; entity: string; pick: "last" | "first" }
  | { kind: "active"; from: RowExpr; to: RowExpr; ends: "inclusive" | "exclusive" }
  | { kind: "trailing"; column: string; length: { days: number } | { months: number } }
  | { kind: "static" };

interface PlannedQuery {
  // existing fields, plus:
  evaluation: Evaluation;
  lookups: {
    table: string;
    key: Record<string, string>;
    asof?: { column: string; at: string | "$evaluation" };
  }[];
  /** Grouping sets never omit the time dimension when evaluation is not flow. */
}

/** A grain: unit plus anchor. Month and day have no anchor. */
type Grain =
  | { unit: "day" | "month" }
  | { unit: "week"; anchor: Weekday }
  | { unit: "quarter" | "year"; anchor: string /* "MM-DD" */ };

/** A range as written: concrete dates, or a shorthand resolved once T is known. */
type RangeSpec =
  | { start: string; end: string }
  | { last: number; unit: Grain["unit"] }
  | { to_date: Grain["unit"] }
  | { last_complete: Grain["unit"] }
  | "all_time";

interface PlannedWindow {
  // replaces range/shift: the spec, and the shift applied for a comparison
  range: RangeSpec;
  shift?: { unit: Grain["unit"]; by: number } | "previous_period";
  column?: string;
  /** Time-series blocks snap the start back to the start of its bucket. */
  snap: "bucket" | "none";
}
/** resolveRange(spec, shift, asOf, anchors) in windows.ts returns { start, end } local dates; it replaces windowBounds(). */

type MeasureExpression =
  // replaces ref | divide
  | { op: "ref"; queryId: string; metric: string }
  | { op: "const"; value: number }
  | { op: "+" | "-" | "*" | "/"; args: [MeasureExpression, MeasureExpression] }
  | { op: "neg" | "abs"; args: [MeasureExpression] }
  | { op: "coalesce" | "min" | "max"; args: MeasureExpression[] };

interface BlockPlan {
  // existing: blockId, pointer, queryIds, measures
  grains?: { grain: Grain; queryIds: string[] }[];
  incomplete: "mark" | "hide" | "show";
  targets?: Record<string, PlannedTarget>;
}

interface PlannedTarget {
  id: string;
  kind: "flow" | "point";
  path: "linear" | "compound";
  grain: Grain;
  values:
    | { source: string; date: string; column: string; dimensions: string[] }
    | { inline: Record<string, number> };
}

interface QueryPlan {
  // existing fields, plus:
  /** Replaces weekStart: where week, quarter and year buckets begin by default. */
  anchors: { week: Weekday; quarter: string; year: string };
  /** "latest_data" resolves to the newest voting horizon, "latest_common_data" to the oldest. */
  asOfRule: "latest_data" | "latest_common_data" | "fixed";
  /** What the executor must measure per source to resolve horizons and latest_data. */
  horizons: Record<
    string,
    {
      column?: string;
      rule: "max" | { lagMs: number } | { lagDays: number } | { through: "as_of" | string };
      votes: boolean;
      columnType?: "date" | "timestamp";
    }
  >;
  segments: { id: string; filters: Filter[]; sources: string[] }[];
  tests: {
    metric: string;
    index: number;
    plan: PlannedQuery;
    at?: string;
    window?: [string, string];
    expect: number | Record<string, number>;
  }[];
}

interface ExecutionContext {
  // existing, plus:
  /** Resolved once per plan, before any query: instants in UTC ISO 8601. */
  asOfInstant: string;
  horizons: Record<string, string>;
  /** Bucket bounds computed by the core (bucketBounds in windows.ts) as local dates; the executor converts them with the plan timezone. */
  buckets?: { start: string; end: string; instant: string }[];
}
```

New pure core functions: `resolveRange(spec, shift, asOf, anchors)`, `bucketBounds(range, grain)`, `bucketStatus(bucket, horizon, timezone)`, `trimWindow(bounds, horizon, rangeKind)`, `targetValue(target, bucket, grain)`, `parseFormula(text)` and `parseRowExpr(text)` with positions. The executor gains one method, `horizon(source, column): Promise<string | undefined>`, which runs `select max(<column>)` with no filters.

## 12. SQL the executor generates

DuckDB, session `TimeZone = 'UTC'`. `timezone('America/New_York', ts)` turns a local timestamp into an instant and an instant into a local timestamp. Bucket instants are computed by the core and passed in as a `values` list. In November 2026 New York switches from EDT to EST on Nov 1, so the local midnights below are 04:00Z until Nov 1 and 05:00Z after.

**Flow by month (revenue)**

```sql
select date_trunc('month', timezone('America/New_York', paid_at)) as t,
       sum(amount / 100.0 * r.rate) as revenue
from invoice_line_items l
asof left join fx_rates r on r.currency = l.currency and r.date <= timezone('America/New_York', l.paid_at)::date
where l.type = 'subscription'
  and paid_at >= timezone('America/New_York', timestamp '2025-12-01')
  and paid_at <  timezone('America/New_York', timestamp '2026-11-27')
group by grouping sets ((t), ())
```

(In practice `/ 100.0` is `/ c.minor` from the `currencies` lookup. Rows with no rate raise HM4006 in a pre-flight query before this runs. Buckets with anchors don't use `date_trunc`: the core emits the bucket starts as a `values` list and the executor joins rows to them with a range join, so a Sunday week or a February year is the same SQL as a month.)

**Snapshot, `over_time: last`**

```sql
with r as (
  select snapshot_date as d, plan, region, mrr_usd from mrr_snapshots
  where snapshot_date >= date '2025-12-01' and snapshot_date < date '2026-11-27'
),
points as (                                   -- the source's last date per bucket, before filters
  select date_trunc('month', d)::date as t, max(d) as d from r group by 1
)
select p.t, r.plan, sum(r.mrr_usd) * 12 as arr
from r join points p using (d)
where r.region in ('West')                    -- dashboard filter after points
group by grouping sets ((p.t, r.plan), (p.t)) -- time in every set
```

**Spans, `active`, with a lookup**

```sql
with b(t, e) as (values
  (date '2026-09-01', timestamptz '2026-10-01 04:00:00+00'),
  (date '2026-10-01', timestamptz '2026-11-01 04:00:00+00'),
  (date '2026-11-01', timestamptz '2026-11-26 19:03:00+00')),   -- partial: the horizon
rows as (
  select i.*, s.customer, s.trial_end, s.ended_at, s.coupon_percent_off
  from subscription_items i left join subscriptions s on i.subscription = s.id
)
select b.t, rows.plan,
  sum(rows.unit_amount * rows.quantity / 100.0
      * case rows.interval when 'day' then 365.0/12 when 'week' then 365.0/7/12
                           when 'month' then 1 when 'year' then 1.0/12 end
      / rows.interval_count
      * (1 - coalesce(rows.coupon_percent_off, 0) / 100.0)) * 12 as arr
from b join rows
  on greatest(rows.valid_from, coalesce(rows.trial_end, rows.valid_from)) < b.e
 and (coalesce(rows.valid_to, rows.ended_at) is null or coalesce(rows.valid_to, rows.ended_at) >= b.e)
group by grouping sets ((b.t, rows.plan), (b.t))
```

DuckDB plans the inequality join as an IEJoin. Point-rate FX adds an `asof` join to `fx_rates` on `b.e`'s local date.

**Event state, `over_time: last` + `entity`**

```sql
with b(t, e) as (values ...),
ent as (select distinct subscription from subscription_events),
grid as (select b.t, b.e, ent.subscription from b cross join ent),
st as (
  select g.t, ev.plan, ev.mrr_after
  from grid g asof left join subscription_events ev
    on g.subscription = ev.subscription and g.e > ev.occurred_at
)
select t, plan, sum(mrr_after) * 0.12 as arr from st group by grouping sets ((t, plan), (t))
```

**Trailing 90 days (wall-clock local)**

```sql
select b.t, sum(c.amount) * 0.0405556 as credit_run_rate
from b join credit_purchases c
  on c.created >= timezone('America/New_York', timezone('America/New_York', b.e) - interval 90 day)
 and c.created <  b.e
group by b.t
```

**`per_entity` (gross retained ARR, 12 months)**

```sql
with cur as (<of's rows evaluated at b.e, grouped by customer>),
pri as (<of's rows evaluated at timezone(tz, timezone(tz, b.e) - interval 12 month), grouped by customer>),
j as (
  select coalesce(c.customer, p.customer) as customer,
         coalesce(c.v, 0) as current, coalesce(p.v, 0) as prior
  from cur c full join pri p on c.customer = p.customer
)
select sum(least(current, prior)) as retained_arr from j where prior > 0
```

**Horizon**

```sql
select max(paid_at) from invoice_line_items      -- no filters, no window
```

Formulas, targets and bucket status are computed in the core from these results; no SQL.

### 12.1 Printing the SQL

`hatchmark explain <metric>` (today `explain` takes only HM codes) prints the SQL the executor runs for that metric, for one canonical query: no dashboard filters, the metric's own filters and segments, at month grain over `last_12_months` as of `latest_data`. `--dashboard <name> --block <id>` prints the exact queries of one block instead. `--json` returns `{ metric, queries: [{ id, sql, params }] }`; `hatchmark check --json --sql` adds the same per block. The SQL is printed by the same function that builds the SQL the DuckDB adapter executes, with parameters inlined only in the printed copy, so the printed text can't drift from what runs. That builder is pure string generation and lives in the portable core; only running it needs the adapter.

## 13. Validation run

Before writing this, I ran the main SQL shapes in DuckDB on synthetic Larkspur data (400 customers, 18 months, plan changes, annual and monthly prices, gaps that cause reactivations, America/New_York months with the Nov 1 DST change and a partial November at 2026-11-26 19:03Z). Results:

| Check                                                                                                                                              | Result                    |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| ARR from spans (`active`), October 2026                                                                                                            | 1,392,474                 |
| ARR from daily snapshots (`over_time: last`)                                                                                                       | 1,392,474                 |
| ARR from events (`entity: subscription`)                                                                                                           | 1,392,474                 |
| ARR from events with `entity: customer` (wrong key)                                                                                                | 1,146,966 (18% low)       |
| Naive sum over October's daily snapshots                                                                                                           | 42,275,038 (30× high)     |
| Phase 2 check (section 5): per-customer before/after differences at consecutive month ends, partitioned by conditions, summed to the change in ARR | residual 0 over 18 months |

The script is scratch, not committed; the implementation PRs turn it into tests.

## 14. Decisions (2026-11-27)

1. `latest_data` uses the newest source and marks lagging ones: approved. `latest_common_data` is the option.
2. A partial point-in-time value is a solid line with an "as of" label; partial flows are dashed: approved.
3. Partial buckets are marked by default: approved.
4. Time series snap to whole buckets by default: approved. `edges: "clip"` is the option.
5. Grammar, not business metrics: the RFC adds generic primitives only; ARR and friends are the expressiveness test (section 4). Any business definition is an option with a default that check explains (section 3.11).
6. Time is two primitives, a date range and an anchored grain; a fiscal year is a year grain with an anchor, a week start is the week anchor, comparisons are shifts (section 6.2).
7. No change-classification names (new, churn, expansion, …) in the schema. A generic two-instant comparison with user-named buckets is phase 2 at the earliest (section 5).

## 15. Out of scope and deferred

Deferred, with where it would go:

- Revenue recognition: spreading invoice amounts over service days (a flow with spreading; phase 2).
- Forward-filling snapshots and `avg` over calendar days (phase 2).
- Cumulative metrics and delta-event logs (a running sum per entity; phase 2, with cohorts).
- Evaluation-instant references in row expressions (`@at`), for coupons that expire inside a span (phase 2).
- Two-instant entity comparison with user-defined buckets (section 5), and a waterfall block to show it (phase 2 at the earliest).
- Conversion, funnel and cohort retention metrics (phase 2 per roadmap). The entity-state machinery in this RFC is the base they need.
- Projection to period end (phase 2; needs the horizon from this RFC).
- Hourly grain, and 4-4-5 retail calendars (which an anchor can't express) (later, on demand).
- Splitting a series by segment (show external vs internal side by side) (phase 2).

Out of scope:

- Connecting to Stripe or any billing API: Hatchmark reads exported files.
- Joins other than many-to-one lookups, window functions and user-defined functions in expressions. The `sql` metric type stays the escape hatch; letting it set `over_time` like an aggregate is deferred too, so in phase 1 a `sql` metric is a flow or static, and on a snapshot source it gets the HM4007 warning. A product of a metric across buckets (compounded monthly rates) is deferred as well.
- Forecasting and LTV/CAC calculators as built-ins (they're formulas).

## 16. Diagnostic codes

New or changed codes, all in `src/diagnostics/codes.ts`:

| Code          | Severity        | Meaning                                                                                                                                                                                                                                                                                      |
| ------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HM1004        | error           | a metric file named after an expression keyword (`and`, `or`, `not`, `null`), besides invalid names                                                                                                                                                                                          |
| HM2004        | error           | circular reference, now through formulas and `per_entity` too                                                                                                                                                                                                                                |
| HM2012        | error           | operands of a ratio or formula placed in time differently (timed vs static)                                                                                                                                                                                                                  |
| HM2013        | error           | a filter or segment binds to only some sources of a block, now for formulas and segments                                                                                                                                                                                                     |
| HM2018        | error           | a column named in `entity`, `active`, `value`, or a lookup key is not in the source (when columns are known)                                                                                                                                                                                 |
| HM2019        | error           | a lookup source's `from` or lookup table is itself a lookup source (one level only)                                                                                                                                                                                                          |
| HM2020        | error           | unknown name in a formula or a `per_entity` expression (did-you-mean fix)                                                                                                                                                                                                                    |
| HM2021        | error           | unknown segment                                                                                                                                                                                                                                                                              |
| HM2022        | error           | unknown target id                                                                                                                                                                                                                                                                            |
| HM2023        | error           | a test's `data` swaps a source the metric doesn't read                                                                                                                                                                                                                                       |
| HM3005        | error           | value malformed, now including an anchor that isn't a weekday or a valid `MM-DD` from 01 to 28                                                                                                                                                                                               |
| HM3007        | error           | conflicting properties, now including `active` with `time`, `trailing` with `over_time`, `entity` without `last`/`first`, `over_time` without `time`, `grain` not in `grains`, a quarter anchor inconsistent with the year anchor, `prorate: "days"` on a flow that doesn't add up over time |
| HM3010        | error           | formula or row expression syntax error, with line, column and length                                                                                                                                                                                                                         |
| HM4001        | error           | percent of total on a metric that isn't additive across groups (now allows group-additive point-in-time metrics); a constant term (`a + 1`) or `over_time` `min`/`max` makes a metric non-additive                                                                                           |
| HM4005        | error           | a formula adds, subtracts or chooses between (`coalesce`, `min`, `max`) metrics in different currencies, through scalar factors and `abs`, or shows a currency its operands aren't in                                                                                                        |
| HM4006        | error           | an as-of lookup has no row on or before a base row's instant                                                                                                                                                                                                                                 |
| HM4007        | error / warning | a snapshot table not read one snapshot date at a time (section 3.2): error, a warning for `sql`; later also a warning when check's probe finds the sum over a bucket near (distinct dates × the last date's value)                                                                           |
| HM4008        | error           | `per_entity.of` is not a point-in-time `sum` or `count` aggregate; `over_time` `avg`, `min` and `max` have no value per entity at an instant                                                                                                                                                 |
| HM4009        | error           | a formula mixes flow and point-in-time metrics                                                                                                                                                                                                                                               |
| HM4010–HM4016 |                 | incomplete periods, section 6.7                                                                                                                                                                                                                                                              |
| HM4017        | error           | lookup key not unique (would multiply rows)                                                                                                                                                                                                                                                  |
| HM4018        | warning         | rows dropped or unmatched: lookup misses, null `active.from`, `match` with no matching key                                                                                                                                                                                                   |
| HM4019        | error           | an as-of lookup at `$evaluation` read by a flow or static metric                                                                                                                                                                                                                             |
| HM4020        | warning         | target covers none or part of the window                                                                                                                                                                                                                                                     |
| HM4021        | warning         | target hidden under a filter or segment it has no column for                                                                                                                                                                                                                                 |
| HM4022        | note            | flow target prorated to a finer grain                                                                                                                                                                                                                                                        |
| HM4023        | warning         | a block left out because its metric uses a primitive the planner doesn't evaluate yet                                                                                                                                                                                                        |
| HM4030        | error           | metric test failed (fix to update `expect` is unsafe)                                                                                                                                                                                                                                        |
| HM4031        | warning         | metric test reads past the source horizon                                                                                                                                                                                                                                                    |
| HM4040        | note            | a business definition uses its default (section 3.11); names the option                                                                                                                                                                                                                      |
| HM5001        | warning         | more than 1,000 points per series at a grain                                                                                                                                                                                                                                                 |
| HM9002        | error           | built-in invariant failed (ROLLUP, group sums at a point): a Hatchmark bug                                                                                                                                                                                                                   |

## 17. Implementation plan

Each PR carries the RFC sections it implements (as `docs/rfcs/0001-metric-and-time-semantics.md`), and each numbers-path PR gets the self-review attacks from CREW.md. Order:

1. **Metric layer spec and checks** (no executor needed; the dashboard-side time surface moves to PR 2, where the planner consumes it): metric schema (`over_time`, `entity`, `active`, `trailing`, `value`, `scale`, `formula`, `per_entity`, `segments`, `targets`, `tests`), source options (`snapshot`, `freshness`, `timezone`) and lookup sources (with as-of), segment files, `in_table` filters; formula, row and entity expression parsers with positions; static checks HM2004/2012/2013 generalised, HM1004, HM2018–HM2021, HM2023, HM3007/3010, HM4001/4005/4007/4008/4009/4019, HM4023, HM4040; JSON Schema regeneration, with the shape rules (`column` or `value`, `time` or `active`, `at` or `window`, and so on) encoded in the export so editors reject what check rejects; project and semantic rules (references, columns, time nature, units) stay in check. The planner leaves out a block whose metric uses a primitive it doesn't evaluate yet (HM4023, warning) instead of planning it as a plain sum. Metric files may not be named after an expression keyword (`and`, `or`, `not`, `null`; HM1004).
2. **Time primitives and plan v2**: ranges and anchored grains in dashboards and hatchmark.json (`resolveRange` replaces `windowBounds`, old range names as aliases, `anchors` replaces `weekStart`), grain options, `incomplete`, `edges`, block targets, segment and grain filters; planner support on top of the first planner; the SQL printer of section 12.1.
3. **Executor: time evaluation and per_entity**: flow with tz and anchored buckets, snapshot, entity state, active, trailing, lookups (with as-of); horizons and `latest_data`; data checks HM4007/4006/4010–4018; ROLLUP invariants.
4. **Incomplete periods in components** (rendering; component PR with preview).
5. **Targets** (planner + rendering; component PR with preview).
6. **Metric tests** in `check` and `hatchmark test`.

PRs 2 and 3 build on the first DuckDB executor.
