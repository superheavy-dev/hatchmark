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

| Field    | Meaning                                                                                                                                                                                                                                                         |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`     | Optional stable id, lowercase snake_case. Defaults to `<type>_<index>`.                                                                                                                                                                                         |
| `title`  | Optional card title. State the finding ("Revenue reached a record in October"); the subtitle Hatchmark adds says what is measured.                                                                                                                              |
| `span`   | Width in the 12-column grid, 1–12. Default 3 for `kpi` (four to a row) and 12 for the rest. Line, area, bar and scatter charts take at least 3 columns; a smaller span gets warning HM2024 and is drawn 3 wide. Below 1024 px every block takes the full width. |
| `height` | Optional card height: `compact`, `default` (when unset) or `tall`. Every block type but `text` and `bar_list` takes it. See [Heights](#heights).                                                                                                                |

Metric names in blocks are metric file names (see [metrics.md](metrics.md)); columns in `by` and
`split` are source columns. `line`, `area` and `bar` blocks with several series take `groups` to colour
related series as one hue family ([components/groups.md](components/groups.md)).

### Heights

`height` picks one of three presets. There are no pixel heights: the theme sets each preset
separately for desktop and phone, so axis labels, keys, tooltips and KPI figures stay legible at
every preset.

```yaml
- type: line
  metrics: [revenue]
  grain: month
  height: tall
```

| Block                                     | What `height` sets                                                                                                                                                                          |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `line`, `area`, vertical `bar`, `scatter` | The chart's height. A key above the plot adds to it.                                                                                                                                        |
| `pie`, `donut`                            | The chart's height, and how large the pie may grow. A key longer than the pie adds to it. On phones the card's width caps the pie, so `tall` adds no size there.                            |
| horizontal `bar`                          | The height its rows stretch to fill, within each preset's row limits (22–30, 28–36 or 28–48 px), so the number of bars sets most of the height. See [components/bar.md](components/bar.md). |
| `kpi`                                     | The figure and sparkline size. See [components/kpi.md](components/kpi.md).                                                                                                                  |
| `table`                                   | The rows shown before the table scrolls inside its card. See [components/table.md](components/table.md#long-tables).                                                                        |

In the Default theme a chart is 200, 280 or 400 px tall on desktop (`compact`, `default`, `tall`)
and 180, 230 or 320 px on phones; [theme.md](theme.md#block-heights) lists every value.

Cards side by side end level. On screens 1024 px and wider, the charts in one grid row are drawn at
the tallest preset among them, and a KPI strip at the tallest preset of its KPIs, so a compact
chart is never drawn beside a tall one. A card set lower gets warning HM2028. Below 1024 px cards
stack, and every card, each KPI included, keeps its own preset. Tables keep their own height in any row.

A pixel value or another string is an error that lists the presets. `height` on a `text` or
`bar_list` block is an error with a safe fix that removes it, and on a table with
`overflow: page` it is warning HM2031 (see [diagnostics.md](diagnostics.md#card-height)).

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
