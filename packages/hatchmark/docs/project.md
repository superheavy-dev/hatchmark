# Project file (hatchmark.json)

`hatchmark.json` sits at the project root and holds the settings and the data sources. Every field
except `$schema` is required, so a reader sees what will happen without knowing defaults;
`hatchmark check` reports a missing field with a fix that adds the default. Print the full JSON
Schema with `hatchmark schema project`.

```json
{
  "$schema": "./node_modules/hatchmark/schema/project.schema.json",
  "version": 1,
  "name": "Global Sales",
  "dataDir": "data",
  "metricsDir": "metrics",
  "dashboardsDir": "dashboards",
  "outDir": "dist",
  "locale": "en-US",
  "currency": "USD",
  "timezone": "America/New_York",
  "weekStart": "sunday",
  "theme": "default",
  "telemetry": false,
  "sources": {
    "orders": { "type": "csv", "path": "data/orders.csv" }
  }
}
```

| Field           | Meaning                                                                              |
| --------------- | ------------------------------------------------------------------------------------ |
| `version`       | Spec format version. Always `1`.                                                     |
| `name`          | Project name, shown at the top of every page.                                        |
| `dataDir`       | Where data files live by convention (`data`). Source paths still name the full path. |
| `metricsDir`    | Directory of `<name>.json` metric files. See [metrics.md](metrics.md).               |
| `dashboardsDir` | Directory of `<name>.json` dashboard files. See [dashboards.md](dashboards.md).      |
| `outDir`        | Where `hatchmark build` writes the site. See [build.md](build.md).                   |
| `locale`        | BCP 47 tag for number and date formatting, such as `en-US` or `de-DE`.               |
| `currency`      | ISO 4217 code used by currency metrics that do not set their own, such as `USD`.     |
| `timezone`      | IANA time zone that dates are bucketed in, such as `UTC` or `America/New_York`.      |
| `weekStart`     | `monday` or `sunday`: the first day of a week bucket.                                |
| `theme`         | `default`.                                                                           |
| `telemetry`     | `false`. Hatchmark sends nothing unless this is `true`.                              |
| `sources`       | Tables by name. Metrics refer to these names in their `table` field.                 |

## Sources

A source is one file read as a table. Its name (the key under `sources`) is lowercase snake_case,
such as `orders` or `web_sessions`.

**`path` is relative to `hatchmark.json`**, not to `dataDir`: a file at `data/orders.csv` is
`"path": "data/orders.csv"`. Paths stay inside the project: no absolute paths and no `..`.

| `type`    | Options                                                                                                     |
| --------- | ----------------------------------------------------------------------------------------------------------- |
| `csv`     | `delimiter`: one character, default `,`. `header`: whether the first row names the columns, default `true`. |
| `parquet` | None; Parquet carries its own column types.                                                                 |
| `json`    | `format`: `array` (one array of objects, the default) or `ndjson` (one object per line).                    |

```json
"sources": {
  "orders": { "type": "csv", "path": "data/orders.csv" },
  "events": { "type": "parquet", "path": "data/events.parquet" },
  "refunds": { "type": "json", "path": "data/refunds.ndjson", "format": "ndjson" },
  "stores": { "type": "csv", "path": "data/stores.tsv", "delimiter": "\t" }
}
```

Column types are inferred from every row of the file (see [numbers.md](numbers.md#reading-files)).
A metric or block that names a column the file does not have fails `hatchmark build` with `HM2015`,
which names the source and the column; `hatchmark check` does not catch every such case.

## Starting from `init --template minimal`

`hatchmark init --template minimal` writes `hatchmark.json` with `"sources": {}` and empty
`data/`, `metrics/` and `dashboards/` directories. To get to a first page:

1. Put the data file under `data/`, for example `data/orders.csv`.
2. Add it to `sources` in `hatchmark.json`: `"orders": { "type": "csv", "path": "data/orders.csv" }`.
3. Write one metric per file under `metrics/`, such as `metrics/revenue.json`. See
   [metrics.md](metrics.md).
4. Write a dashboard under `dashboards/`, such as `dashboards/sales.json`. See
   [dashboards.md](dashboards.md).
5. Run `hatchmark check --json` and fix every error, then `hatchmark build`.

`hatchmark init` without `--template minimal` writes a complete sample project (US orders data,
metrics and a dashboard) to copy from instead.
