# Dashboards (dashboards/<name>.yaml)

A dashboard is one page: a title, a period, and blocks in reading order. Each lives in its own file
under `dashboards/`; the file name is the page's name and URL (`dashboards/sales.yaml` builds
`dist/sales/index.html`). Print the full JSON Schema with `hatchmark schema dashboard`.

```yaml
title: Global sales
description: Orders from every market, last 12 months against the 12 before.
period:
  asOf: latest_data
  range: last_12_months
  compare: previous_period
blocks:
  - type: kpi
    metric: revenue
    sparkline: true
  - type: kpi
    metric: orders
  - type: kpi
    metric: avg_order_value
  - type: kpi
    metric: refund_rate
  - type: line
    title: Revenue by month, by region
    metrics: [revenue]
    grain: month
    split: region
    span: 8
  - type: bar
    title: Revenue by channel
    metrics: [revenue]
    by: channel
    orientation: horizontal
    sort:
      by: revenue
      order: desc
    span: 4
  - type: table
    title: Top countries by revenue
    by: [country]
    metrics: [revenue, orders, avg_order_value, customers]
    percentOfTotal: [revenue]
    sort:
      by: revenue
      order: desc
    limit: 15
```

| Field         | Meaning                               |
| ------------- | ------------------------------------- |
| `title`       | The page heading.                     |
| `description` | Optional line under the title.        |
| `period`      | Optional; see [Period](#period).      |
| `filters`     | Optional; see [Filters](#filters).    |
| `blocks`      | One or more blocks, in reading order. |

## Period

Every block reads the same window.

| Field     | Values                                                                                                                                                                                                 |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `asOf`    | `latest_data` (the last date in the data the dashboard reads), `latest_common_data` (the last date every source has) or a fixed `YYYY-MM-DD`, for builds that stay the same as data grows.             |
| `range`   | `last_7_days`, `last_30_days`, `last_90_days`, `last_12_months`, `month_to_date`, `quarter_to_date`, `year_to_date`, `last_complete_month`, `last_complete_quarter`, `last_complete_year`, `all_time`. |
| `compare` | `previous_period` (the previous calendar unit for calendar ranges, the same length just before for rolling ones), `previous_year` (the same span a year earlier) or `none`.                            |

Without `period`, a dashboard uses `{ asOf: latest_data, range: last_12_months, compare: previous_period }`.
Windows are calendar dates in the project time zone; [numbers.md](numbers.md#time) has the rules.

## Blocks

| `type`             | Shows                                                                  | Docs                                           |
| ------------------ | ---------------------------------------------------------------------- | ---------------------------------------------- |
| `kpi`              | One metric with its change. Consecutive KPIs share one strip.          | [components/kpi.md](components/kpi.md)         |
| `line`, `area`     | Metrics over time.                                                     | [components/line.md](components/line.md)       |
| `bar`              | Metrics by category (`by`) or time bucket (`grain`).                   | [components/bar.md](components/bar.md)         |
| `table`            | Metrics by one to three columns, with a total row.                     | [components/table.md](components/table.md)     |
| `scatter`          | Two metrics per category as points, optionally sized by a third.       | [components/scatter.md](components/scatter.md) |
| `bar_list`, `text` | Valid, but not built yet: build leaves them out with warning `HM4002`. |                                                |

Fields every block takes:

| Field   | Meaning                                                                                                                                                                                                                                                         |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`    | Optional stable id, lowercase snake_case. Defaults to `<type>_<index>`.                                                                                                                                                                                         |
| `title` | Optional card title. State the finding ("Revenue reached a record in October"); the subtitle Hatchmark adds says what is measured.                                                                                                                              |
| `span`  | Width in the 12-column grid, 1–12. Default 3 for `kpi` (four to a row) and 12 for the rest. Line, area, bar and scatter charts take at least 3 columns; a smaller span gets warning HM2024 and is drawn 3 wide. Below 1024 px every block takes the full width. |

Metric names in blocks are metric file names (see [metrics.md](metrics.md)); columns in `by` and
`split` are source columns. `line`, `area` and `bar` blocks with several series take `groups` to colour
related series as one hue family ([components/groups.md](components/groups.md)).

## Filters

`filters` declares controls a reader can change: `select` on a column, `period` with a list of
ranges, or `grain` with a list of grains.

```yaml
filters:
  - type: select
    id: region
    label: Region
    column: region
    multiple: true
  - type: period
    id: period
    options: [last_30_days, last_12_months]
    default: last_12_months
  - type: grain
    id: grain
    options: [week, month, quarter]
    default: month
```

A `grain` filter draws one control in the page header. Choosing a grain switches every line, area
and bar block whose `grains` list it; the others keep their grain. Its `default` is shown first in
those blocks. A dashboard has at most one `grain` filter (`HM3007`).

Its accessible name is the filter's label followed by ", all charts", so screen readers tell it
apart from a chart's own grain switch. A grain option that no block lists switches nothing and is a
warning (`HM2025`).

A `period` filter draws a date control in the page header. `options` lists up to 12 presets, using
the same range values as `period.range` (`last_30_days`, `{ to_date: month }`,
`{ last_complete: quarter }`, ...). Each preset is listed once, even under another spelling, and
`default` must be one of them (`HM3007`). The `default` is what the page shows first, and it
replaces `period.range`. Unless `custom: false` is set, the control also offers a calendar where
a reader picks any start and end day within the data.

The built page stays static. Every preset is computed exactly at build time. Custom ranges are
added up in the browser from day-level totals embedded in the page. Metrics that can't be added up
from days (`count_distinct`, `median`, SQL metrics that are not `additive`) show "—" on a custom
range and ask the reader to pick a preset; check notes each one (`HM4041`). The day-level data makes
the page bigger. Above 3 MB, build warns (`HM5002`) and names what weighs the most. Set
`custom: false` to embed only the presets.

The chosen period and grain are kept in the page's URL query under each filter's `id`
(`?period=last_7_days`, `?period=2026-03-01..2026-05-15` with the last day included, `?grain=week`;
a filter at its default is left out), so a reload or a shared link opens the same view.

**This version does not draw `select` controls yet:** the built page shows the data at each
`select` filter's `default`, and does not say so on the page. A `select` filter with a `default`
therefore filters the whole page (only the default's rows); leave `default` out to show all rows. A
dashboard has at most one `period` filter (`HM3007`).
