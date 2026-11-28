# Dashboards

Full reference: `hatchmark docs dashboards`. Schema: `hatchmark schema dashboard`.

- One file per page, `dashboards/<name>.yaml`. The file name is the page's name and URL.
- A dashboard has a `title`, an optional `description`, `period`, `filters`, and `blocks` in
  reading order.
- `period` sets one window for every block: `asOf`, `range` (such as `last_12_months`) and
  `compare` (`previous_period`, `previous_year` or `none`).
- Blocks lay out on a 12-column grid with `span`. Block types include `kpi`, `line`, `area`,
  `bar`, `table`, `scatter` and `map`; each has its own page, such as `hatchmark docs kpi` or
  `hatchmark docs table`.
- Blocks name metrics by file name; `by` and `split` name source columns.
- A block `title` states the finding; Hatchmark adds a subtitle that says what is measured.

```yaml
title: Sales overview
period:
  asOf: latest_data
  range: last_12_months
  compare: previous_period
blocks:
  - type: kpi
    metric: revenue
  - type: line
    title: Revenue by week
    metrics: [revenue]
    grain: week
  - type: table
    title: Revenue by region
    by: [region]
    metrics: [revenue, orders]
```

`hatchmark explain --dashboard <name> --block <id>` prints the SQL of one block, and
`hatchmark check --sql --json` the SQL of every block. `hatchmark dev` shows the page while you
edit.

Sections worth reading: `hatchmark docs dashboards#blocks`, `hatchmark docs dashboards#filters`,
`hatchmark docs dashboards#period`.
