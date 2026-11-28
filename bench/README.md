# Performance benchmark

This directory builds the same sales dashboard in Hatchmark, [Evidence](https://evidence.dev),
[Metabase](https://www.metabase.com) and [Apache Superset](https://superset.apache.org) from the
same generated dataset, then measures what a reader on a mid-range phone gets: JavaScript shipped,
time to the first chart, time until the region filter has updated every chart, and how long each
tool takes to turn raw data into a dashboard.

Every number comes from the scripts in this directory. Nothing is measured by hand.

## The dashboard

One page with seven visuals over orders from Nov 1, 2025 up to (not including) Nov 1, 2026, in UTC:

| Visual                      | Definition                                                                         |
| --------------------------- | ---------------------------------------------------------------------------------- |
| Revenue                     | sum of `amount` where `status = 'paid'`                                            |
| Orders                      | count of paid orders                                                               |
| Average order value         | revenue / orders                                                                   |
| Refund rate                 | refunded orders / all orders                                                       |
| Revenue by month, by region | line chart, one series per region                                                  |
| Revenue by channel          | horizontal bars, largest first                                                     |
| Top countries by revenue    | the 15 largest countries: revenue, orders, average order value, distinct customers |

The page has one control, a region filter. The interaction measured is "show EMEA only".

| Tool      | Definition                                                                                                                        | Filter control                                                           |
| --------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Hatchmark | [`dashboards/hatchmark/`](dashboards/hatchmark/): metrics in YAML and one dashboard spec                                          | segment toggle `EMEA` (this version does not draw `select` controls yet) |
| Evidence  | [`dashboards/evidence/pages/index.md`](dashboards/evidence/pages/index.md): SQL blocks and components                             | `Dropdown` bound to a query input                                        |
| Metabase  | [`src/targets/metabase.ts`](src/targets/metabase.ts) creates seven native SQL questions and a dashboard through the REST API      | dashboard filter wired to a `{{region}}` variable                        |
| Superset  | [`src/targets/superset.ts`](src/targets/superset.ts) creates a virtual dataset, seven charts and a dashboard through the REST API | native Select filter on `region`                                         |

The KPI expressions Metabase and Superset share are in [`src/sql.ts`](src/sql.ts).

## Versions

| Tool      | Version                                                                                                                      | How it runs                                                                                      |
| --------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Hatchmark | this checkout                                                                                                                | `hatchmark build`; the static output is served by [`src/static-server.ts`](src/static-server.ts) |
| Evidence  | `@evidence-dev/evidence` 40.1.8, from the official template at commit `ec9e0f5`, installed from its lockfile                 | `evidence sources` and `evidence build`; the static output is served by the same server          |
| Metabase  | `metabase/metabase:v0.65.7.4`, heap `-Xmx2g`, H2 application database                                                        | Docker, reading Postgres 17                                                                      |
| Superset  | `apache/superset:6.1.0` plus `psycopg2-binary` ([`docker/superset/`](docker/superset/)), SQLite metadata, 2 Gunicorn workers | Docker, reading Postgres 17                                                                      |

Evidence's newer CLI (Evidence Core) has no static export and reads local CSV files only through its
hosted service, so the benchmark uses the last open-source release that builds a static site.

Every tool keeps its default settings apart from the ones in the table. Metabase and Superset cache
no query results by default, so every page view runs its queries. The Postgres table has a primary
key on `order_id` and no other index.

## Dataset

[`src/dataset.ts`](src/dataset.ts) writes `orders.csv` from a fixed seed: 500,000 orders by
default (`--rows`), Nov 1, 2024 to Oct 31, 2026, 21 countries in three regions, six channels, five
categories, with seasonality and growth. The same file feeds every tool: Hatchmark and Evidence read
the CSV, and Postgres loads it with `COPY`. The results record the file's SHA-256.

## Device profile

[`src/profiles.ts`](src/profiles.ts) defines `phone`, the default:

- Chromium from Playwright, headless, with a fresh browser context per run (cold HTTP cache, no
  service workers).
- A viewport 412 CSS px wide at 1.75x, with a mobile user agent and touch. The viewport is 2,400 px
  tall so the whole dashboard is on screen; a tool that renders only visible charts would otherwise
  never finish "all visuals". Every tool's first chart sits near the top, so this does not change
  "first chart".
- CPU slowed 4x with `Emulation.setCPUThrottlingRate`. The slowdown is relative to the machine
  running the benchmark, so results compare only within one machine.
- Network shaped with `Network.emulateNetworkConditions`: 150 ms latency, 1,638.4 Kbps down and
  750 Kbps up (the reference throughput of Lighthouse's mobile profile).

`desktop` turns both throttles off at 1,440 px wide.

## Metrics

Each run loads the dashboard, waits until every visual has drawn, waits for the network to be quiet
for 2 s, applies the filter, and waits until every visual has changed and then stayed unchanged for
500 ms. [`src/probe.ts`](src/probe.ts) runs in the page before the page's own scripts and checks
every visual on every animation frame:

- a KPI is drawn when its element shows a digit;
- an SVG chart is drawn when it has a minimum number of marks (`path` or `rect`);
- a canvas chart is drawn when a 16×16 downsample of its pixels has ink;
- a table is drawn when it has a minimum number of rows.

The selectors and minimums for each tool are in its file under [`src/targets/`](src/targets/).

| Metric                  | Definition                                                                                                                                                                                                 |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| JS gzip, load           | every JavaScript response plus inline `<script>` text received until the dashboard is drawn and the network is quiet, each recompressed with gzip level 9 so that server compression settings don't matter |
| JS gzip, after filter   | the same, also counting scripts the filter loads                                                                                                                                                           |
| JS raw                  | the same bytes, uncompressed                                                                                                                                                                               |
| WASM                    | WebAssembly bytes, uncompressed, counted apart from JS                                                                                                                                                     |
| Transfer, load          | bytes on the wire for every response until the dashboard is drawn, as served (the static server gzips text)                                                                                                |
| First chart             | navigation start to the frame in which the line or the bar chart is first drawn                                                                                                                            |
| All visuals             | navigation start to the frame in which the last of the seven visuals is drawn                                                                                                                              |
| Filter to settled       | the commit event (the click on the toggle, the option or the Apply button) to the last frame in which any visual changed, once all seven have changed                                                      |
| Longest event           | the longest Event Timing entry from the commit on                                                                                                                                                          |
| Build from raw data     | Hatchmark: `hatchmark build --no-cache` from the CSV. Evidence: `evidence sources` and `evidence build` from a clean output. Wall time under `nice -n 10`                                                  |
| Server queries per view | Metabase and Superset: the dashboard's seven queries sent in parallel to the server's API, from the first request to the last response. This work repeats on every view                                    |

Opening the filter's dropdown happens before the timer starts; only the click that applies the
filter is timed. Charts drawn with ECharts (Evidence, Superset, and Metabase's line chart) animate
their updates, and the animation counts toward "filter to settled" because the reader waits for it
too.

## Load control

Timings mean something only on a quiet machine. Before each run the harness reads the 1-minute load
average; above the threshold (a quarter of the logical cores by default, `--threshold`) it waits, for
at most `--max-wait` seconds. Every run records the load averages before and after it and is flagged
`underLoad` when either was above the threshold. The report counts the flagged runs per tool.

## Running it

Requirements: Node 22.18 or later, pnpm, Docker with at least 4 CPUs and 6 GB of memory for
Metabase and Superset, and about 2 GB of disk for the Evidence install and the images.

```sh
pnpm install && pnpm build
pnpm --filter hatchmark-bench exec playwright install chromium
cd bench
node src/cli.ts dataset                      # bench/.work/data/orders.csv
node src/cli.ts setup hatchmark evidence metabase superset
node src/cli.ts build-time hatchmark evidence --runs 5
node src/cli.ts measure hatchmark evidence metabase superset --runs 7 --warmup 1
node src/cli.ts report                       # Markdown summary of bench/.work/results.json
node src/cli.ts teardown metabase superset
```

Set `DOCKER_CONTEXT` to run the servers on another Docker context. The harness creates and removes
only containers named `hatchmark-bench-*` and the `hatchmark-bench` network. While one server is
measured, the other is paused.

`results.json` keeps every run with its load samples, per-visual timings and byte counts, so the
summary can be recomputed or audited.

## Known asymmetries

- Hatchmark and Evidence compute at build time and serve static files; Metabase and Superset query
  the database on every view. That difference is part of what is measured, and "server queries per
  view" shows its server side. Server timings depend on the Docker VM's CPUs, which are not
  throttled.
- Evidence runs filter-dependent queries in the browser with DuckDB-WASM in a Web Worker. The CPU
  throttle is applied to the page; whether Chromium also slows dedicated workers is not verified
  here, so Evidence's filter time may be favoured.
- Hatchmark's filter is a segment toggle and the others use a dropdown; the rows kept are the same.
- Each tool keeps its own number formatting and chart styling.
- Superset's dashboard grid does not adapt to a phone: at 412 px it lays out the desktop grid and
  scrolls sideways.
- Evidence ships the source table that filter-dependent queries read (about 6 MB of Parquet at the
  default 500,000 rows) and DuckDB-WASM, so its load numbers grow with the dataset.
