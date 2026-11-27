# Project file (hatchmark.yaml)

`hatchmark.yaml` sits at the project root and holds the settings and the data sources. Every field
except `$schema` is required, so a reader sees what will happen without knowing defaults;
`hatchmark check` reports a missing field with a fix that adds the default. Print the full JSON
Schema with `hatchmark schema project`.

```yaml
# yaml-language-server: $schema=./node_modules/hatchmark/schema/project.schema.json
version: 1
name: Global Sales
dataDir: data
metricsDir: metrics
dashboardsDir: dashboards
outDir: dist
locale: en-US
currency: USD
timezone: America/New_York
anchors:
  week: sunday
theme: default
telemetry: false
sources:
  orders:
    type: csv
    path: data/orders.csv
```

| Field           | Meaning                                                                              |
| --------------- | ------------------------------------------------------------------------------------ |
| `version`       | Spec format version. Always `1`.                                                     |
| `name`          | Project name, shown at the top of every page.                                        |
| `dataDir`       | Where data files live by convention (`data`). Source paths still name the full path. |
| `metricsDir`    | Directory of `<name>.yaml` metric files. See [metrics.md](metrics.md).               |
| `dashboardsDir` | Directory of `<name>.yaml` dashboard files. See [dashboards.md](dashboards.md).      |
| `outDir`        | Where `hatchmark build` writes the site. See [build.md](build.md).                   |
| `locale`        | BCP 47 tag for numbers and dates, such as `en-US` or `de-DE`. See [Locale](#locale). |
| `currency`      | ISO 4217 code used by currency metrics that do not set their own, such as `USD`.     |
| `timezone`      | IANA time zone that dates are bucketed in, such as `UTC` or `America/New_York`.      |
| `anchors`       | Optional. `week`: `monday` (default) or `sunday`; `quarter`, `year`: `MM-DD` starts. |
| `theme`         | `default`.                                                                           |
| `telemetry`     | `false`. Hatchmark sends nothing unless this is `true`.                              |
| `sources`       | Tables by name. Metrics refer to these names in their `table` field.                 |

## Locale

`locale` sets how numbers, dates and times look on every page of the project. It is fixed per
project: every viewer sees the same formatting, whatever their browser's language, so a dashboard
for a German team reads `1.234,5` for everyone, and a screenshot or a link looks the same to
everyone who opens it.

What the locale formats:

- Numbers: decimal and thousands separators, percent spacing (`12,5 %` in de-DE and fr-FR), the
  minus sign, and compact units such as K, Mio., k, mil, 万 or 천. A compact value is rounded only
  when it shows a unit; see [metrics.md](metrics.md).
- Currency: the symbol's position and spacing (`92,51 $` in de-DE, `US$92.51` in en-GB). The
  currency itself comes from `currency` or the metric's format, and amounts are never converted.
- Dates and times: month names, date ranges (`25.–31. Okt. 2026` in de-DE), axis labels, tooltips,
  "Data through" and partial-period labels, and 12- or 24-hour times.
- The date range picker: its calendar's month and weekday names and the numeric dates in its
  custom-range fields.
- The order of text in a table sorted by a column, both when the page is built and when a viewer
  clicks a header.

What it doesn't change:

- The interface text stays English: labels such as Total, Other, "Showing 9 of 21 rows", the
  partial-period notes and the picker's presets.
- The first day of the week comes from `anchors.week`, not from the locale. `hatchmark init` writes
  the one that fits the locale it writes (`sunday` for en-US); change it to suit your team.
  `weekStart` is the older spelling of `anchors.week`.
- Dates are bucketed in `timezone`, and amounts are in `currency` or the metric's own currency.
- A table's CSV download is the same in every locale: comma-separated, with `.` as the decimal point
  and full-precision values, so other tools read it as numbers. A spreadsheet app set to a locale
  that uses `;` as its list separator, such as German Excel, may put each row in one column when
  you double-click the file; open it through the app's text or CSV import and choose comma as the
  delimiter.

## Sources

A source is one file read as a table. Its name (the key under `sources`) is lowercase snake_case,
such as `orders` or `web_sessions`.

**`path` is relative to `hatchmark.yaml`**, not to `dataDir`: a file at `data/orders.csv` is
`path: data/orders.csv`. Paths stay inside the project: no absolute paths and no `..`.

| `type`    | Options                                                                                                     |
| --------- | ----------------------------------------------------------------------------------------------------------- |
| `csv`     | `delimiter`: one character, default `,`. `header`: whether the first row names the columns, default `true`. |
| `parquet` | None; Parquet carries its own column types.                                                                 |
| `json`    | `format`: `array` (one array of objects, the default) or `ndjson` (one object per line).                    |

```yaml
sources:
  orders:
    type: csv
    path: data/orders.csv
  events:
    type: parquet
    path: data/events.parquet
  refunds:
    type: json
    path: data/refunds.ndjson
    format: ndjson
  stores:
    type: csv
    path: data/stores.tsv
    delimiter: "\t"
```

Every file source also takes these options:

| Option      | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `timezone`  | IANA time zone that the file's timestamps without an offset were written in, such as `America/Chicago`. Without it they are read as UTC; a project whose `timezone` isn't UTC gets note `HM4016` when a source has them. Timestamps with an offset and dates never shift.                                                                                                                                                               |
| `freshness` | How complete the source is (its horizon). By default it is complete through the latest value of the time column a metric uses, over all rows. `{ column: exported_at }` measures another column, `{ lag: { days: 1 } }` or `{ lag: { hours: 6 } }` takes the still-filling end off, `{ through: 2026-11-26 }` fixes the last complete date, and `{ through: as_of }` says the source is complete whenever the build runs (sparse logs). |

```yaml
usage:
  type: csv
  path: data/usage_daily.csv
  freshness:
    lag:
      days: 1
```

[numbers.md](numbers.md#time) says how horizons decide `latest_data`.

Column types are inferred from every row of the file (see [numbers.md](numbers.md#reading-files)).
A metric or block that names a column the file does not have fails `hatchmark build` with `HM2015`,
which names the source and the column; `hatchmark check` does not catch every such case.

## Starting from `init --template minimal`

`hatchmark init --template minimal` writes `hatchmark.yaml` with `sources: {}` and empty
`data/`, `metrics/` and `dashboards/` directories. To get to a first page:

1. Put the data file under `data/`, for example `data/orders.csv`.
2. Add it to `sources` in `hatchmark.yaml`: `orders: { type: csv, path: data/orders.csv }`.
3. Write one metric per file under `metrics/`, such as `metrics/revenue.yaml`. See
   [metrics.md](metrics.md).
4. Write a dashboard under `dashboards/`, such as `dashboards/sales.yaml`. See
   [dashboards.md](dashboards.md).
5. Run `hatchmark check --json` and fix every error, then `hatchmark build`.

`hatchmark init` without `--template minimal` writes a complete sample project (US orders data,
metrics and a dashboard) to copy from instead.
