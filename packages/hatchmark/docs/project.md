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
| `anchors`       | Optional. `week`: any weekday (default `monday`); `quarter`, `year`: `MM-DD` starts. |
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
- Dates use the Gregorian calendar, even for a locale whose default calendar is another one: a
  `th-TH` project shows 2026, not 2569.
- A table's CSV download uses the same syntax in every locale: comma-separated, with `.` as the
  decimal point and full-precision values, so other tools read it as numbers. Its rows follow the
  order the table shows. A spreadsheet app set to a locale that uses `;` as its list separator, such
  as German Excel, may put each row in one column when you double-click the file; open it through
  the app's text or CSV import and choose comma as the delimiter.

## Sources

A source is one file, or one database table or query (see [Database sources](#database-sources)), read as a table. Its name (the key under `sources`) is lowercase snake_case,
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

## Database sources

A `postgres` or `mysql` source reads a table, a view or a query from PostgreSQL, or from MySQL or
MariaDB. Metrics use it exactly like a file source.

```yaml
sources:
  orders:
    type: postgres
    env: SHOP_DATABASE_URL
    table: public.orders
  refunds:
    type: mysql
    env: BILLING_DATABASE_URL
    query: SELECT id, order_id, amount, refunded_at FROM refunds WHERE refunded_at >= '2024-01-01'
    max_age:
      hours: 1
```

| Option    | Meaning                                                                                                                                                                                          |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `env`     | Required. The name of the environment variable that holds the connection string. The connection string never goes in `hatchmark.yaml`; `env` takes only a variable name.                         |
| `table`   | A table or view, as `name` or `schema.name`, matched exactly as written. Without a schema: `public` (or the connection's search path) in PostgreSQL, the connection's database in MySQL.         |
| `query`   | Instead of `table`: a `SELECT` that the database runs, in its own SQL dialect. Use it to cast columns, filter rows or join tables before Hatchmark reads them.                                   |
| `max_age` | `{ minutes: n }`, `{ hours: n }` or `{ days: n }`: reuse the local copy of the rows while it is younger than this. Without it, `build` fetches the rows on every run and `dev` once per session. |

`timezone`, `freshness` and `snapshot` work as for file sources.

### Credentials

The variable holds the connection string in the form DuckDB's extensions take:

- PostgreSQL: a URL or a libpq string, such as `postgresql://reader:secret@db.example.com:5432/shop?sslmode=require`.
- MySQL: `host=db.example.com port=3306 user=reader password=secret database=shop`.

Set it in the shell, or as a secret in CI. Hatchmark never writes it to disk: diagnostics, `--json`
output and logs replace the connection string and every password in it with `***`, and the local
copy is keyed by the host, port, database and user, never by the password. Hatchmark only reads:
the database is attached read-only and only `SELECT` statements run. Give it a user that may only
read the tables it needs.

### How queries run

`build`, `dev`, `explain` and `check --sql` load DuckDB's `postgres` or `mysql` extension
(downloaded once from extensions.duckdb.org; `HM2044` when that fails), attach the database
read-only, and copy the table or query into `.hatchmark/cache/v1/s/<source>.<key>.parquet`. Every
query of the command then reads that copy as it reads a Parquet file: the same SQL, the same
[numbers rules](numbers.md), and one set of rows in one order, so a build never mixes rows fetched
at different moments and float sums come out the same on every run over the same copy. The
database reads each source once per command; filtering, grouping and totals happen in DuckDB.

The query cache keys entries by the query plan and the copy's SHA-256, as for files, so queries
reuse their results exactly when the copy is reused (`max_age`). `hatchmark explain` shows when
each copy was fetched. A copy holds the source's rows on the build machine: `.hatchmark/` is in the
`.gitignore` that `hatchmark init` writes. Deleting `.hatchmark/` is always safe; the next command
fetches again.

### Types

| Database type                                                             | Read as                        | Numbers rule                                                                                                          |
| ------------------------------------------------------------------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `smallint`, `integer`, `bigint`, MySQL unsigned integers                  | DuckDB integers                | Summed exactly (as `HUGEINT`), like integers in files.                                                                |
| `numeric(p,s)`, `decimal(p,s)` with p ≤ 38                                | `DECIMAL(p,s)`                 | Exact.                                                                                                                |
| PostgreSQL `numeric` without a precision; `numeric`/`decimal` with p > 38 | `DOUBLE` (the driver's choice) | Float rules (`HM4004`); a metric that aggregates it gets warning `HM4080`. Declare a precision or cast it in `query`. |
| `real`, `double precision`, `float`, `double`                             | `DOUBLE`                       | Float rules.                                                                                                          |
| PostgreSQL `timestamptz`, MySQL `TIMESTAMP`                               | `TIMESTAMP WITH TIME ZONE`     | An instant; MySQL is read with session time zone UTC, so the server's zone never shifts it.                           |
| PostgreSQL `timestamp`, MySQL `DATETIME`                                  | `TIMESTAMP`                    | Wall-clock time in the source's `timezone` (default UTC; note `HM4016`).                                              |
| `date`                                                                    | `DATE`                         | A calendar date.                                                                                                      |
| `text`, `varchar`, `char`, `uuid`, `json`, `jsonb`, `time`, enums         | `VARCHAR`                      | Text.                                                                                                                 |
| `boolean`, MySQL `TINYINT(1)` and `BIT(1)`                                | `BOOLEAN`                      |                                                                                                                       |
| `interval`, `bytea`/`BLOB`, arrays, composite types                       | kept as DuckDB reads them      | A metric that uses one fails `check` with `HM2043`.                                                                   |

Both databases deliver microseconds; nanosecond timestamps (`TIMESTAMP_NS`) only come from Parquet
files. Integer sums that pass 64 bits stay exact in `HUGEINT`, as for files.

### Checking without a connection

`hatchmark check` reads a database source's column names and types, never its rows:

1. When the variable is set, from the database itself. `HM2041` when it cannot connect, `HM2042` when
   the table is missing, `HM2018` for a column the table does not have, `HM2043` for a type a
   metric cannot use.
2. When it is not set, from the newest local copy of the same table or query in `.hatchmark/cache`,
   with note `HM2040` naming when that copy was fetched.
3. With neither, the source's columns are not checked: warning `HM2040` (exit 0 unless `--strict`).
   Everything else in the project is still checked.

`build` and `dev` need the rows, so a missing variable is an error there. In CI, set the variable
as a secret where `build` runs; a `check` job without database access still checks every file and
reference and only warns about the database columns.

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
