# Command line

`hatchmark <command> [options]`. Every command runs without prompts, so scripts and AI agents can
run it the same way a person does. `hatchmark <command> --help` shows a command's options and one
example. [README.md](README.md) lists every docs page; the files a project holds are described in
[project.md](project.md), [metrics.md](metrics.md) and [dashboards.md](dashboards.md).

| Command                                   | What it does                                                                                                                                                                                                                                                                                             |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `init [dir]`                              | Creates a project: `hatchmark.yaml` with every setting written out, sample US orders data, four metrics, a dashboard, and a Hatchmark block in `AGENTS.md`.                                                                                                                                              |
| `check [paths...]`                        | Checks YAML syntax, spec shape, and references between files and to data columns. Paths are relative to `--cwd`. `hatchmark.yaml` is always checked first, whatever the paths. `--sql` also prints every block's SQL. `--explain-defaults` prints each HM4040 default note instead of one line per file. |
| `data describe <source>`                  | Prints a source's columns with their type, null and distinct counts, the min and max of time and number columns, the row count and the first rows. See [data](#data).                                                                                                                                    |
| `data query "<sql>"`                      | Runs one read-only SELECT over the project's file sources and prints at most `--limit` rows (default 100). See [data](#data).                                                                                                                                                                            |
| `build [--out <dir>] [--no-cache]`        | Checks the project, runs every dashboard's queries (reusing unchanged results from `.hatchmark/cache/`) and writes static HTML pages to `outDir`. See [build.md](build.md).                                                                                                                              |
| `dev [--port <n>] [--host <h>] [--open]`  | Serves every dashboard locally at the URLs `build` writes and updates the page on every save: changed cards swap in place, structural changes reload, errors show over the page. See [dev](#dev).                                                                                                        |
| `docs [topic[#section]]`                  | Prints the docs bundled with the installed version: the topic list, one page, or one section. `--search "<words>"` finds sections. See [docs](#docs).                                                                                                                                                    |
| `schema [project\|metric\|dashboard]`     | Prints the JSON Schema for a file kind, or all three keyed by kind.                                                                                                                                                                                                                                      |
| `explain <code>`                          | Explains a diagnostic code such as `HM2003` and how to fix it.                                                                                                                                                                                                                                           |
| `explain <metric>`                        | Prints the SQL that build runs for a metric. See [Printing the SQL](#printing-the-sql).                                                                                                                                                                                                                  |
| `explain --dashboard <name> --block <id>` | Prints the SQL of one block. See [Printing the SQL](#printing-the-sql).                                                                                                                                                                                                                                  |
| `test [metric                             | source ...]`                                                                                                                                                                                                                                                                                             | Runs the tests pinned in metric files and the row-count tests of sources against the data. Exits 1 when one fails. See [test](#test). |
| `version`                                 | Prints the Hatchmark and Node.js versions.                                                                                                                                                                                                                                                               |
| `doctor`                                  | Checks that this machine can run Hatchmark: Node.js, bundled docs and schemas, project config.                                                                                                                                                                                                           |

## Output

A command prints human text when stdout is a terminal. It prints one line of JSON on stdout when
stdout is not a terminal, when an AI coding agent runs it (detected with `@vercel/detect-agent`),
or when you pass `--json`. `--format human|json` picks the format explicitly and wins over both. Any other `--format` value is a usage error (exit 2), even with `--json`.
Logs go to stderr, so stdout always holds exactly one result.

The mode applies to every result, help and command-line errors included: `--help` in JSON mode
prints the command's usage, options and example as JSON. Every JSON result has `format_version: "1"`. Check results and every error, usage errors
included, use the diagnostic report described in [diagnostics.md](diagnostics.md).

Colour is on in a terminal unless you pass `--no-color` or set `NO_COLOR`.

## Printing the SQL

`hatchmark explain <metric>` prints the SQL that build runs for one metric. It reads the metric by month
over `last_12_months` as of `latest_data`. The metric's own filters and segments apply, and no
dashboard filters do. A metric without a time column is read once over all rows.

`hatchmark explain --dashboard <name> --block <id>` prints the queries of one block instead.
`hatchmark check --sql` prints the queries of every block. In both cases each filter is at its
default. A grain switch prints one query per grain. A comparison window that doesn't exist, such as
`all_time`, is left out, the same way build skips it.

`explain` also says whether the next build would reuse each query's result from the
[build cache](build.md#build-cache): human output ends with one `-- build cache` line per query
(`hit`, `stale` and what changed, `miss`, or `off` for raw SQL metrics), and JSON gives each query a `cache` object with
`status`, `stored_at`, `changed`, `changed_files` and the `data` files with their SHA-256. Explain
only reads the cache, never writes it.

The printed SQL is the text the DuckDB executor runs. The same core function builds it with the
same values. Human output inlines each value as a SQL literal of the type it is bound as.
Strings are VARCHAR and booleans are BOOLEAN. Whole numbers are INTEGER or BIGINT. Other numbers are
DOUBLE, such as `CAST(0.1 AS DOUBLE)`, so a comparison with a FLOAT column gives the same rows.
Quoted identifiers, string literals and comments are left as they are. JSON output keeps the
`$hm_pN` parameters and gives their values:

```json
{
  "format_version": "1",
  "metric": "revenue",
  "as_of": "2026-10-31",
  "queries": [
    {
      "id": "q_…",
      "source": "orders",
      "sql": "SELECT …",
      "params": { "hm_p1": "…" }
    }
  ],
  "diagnostics": []
}
```

`--dashboard` and `--block` output has `dashboard` and `block` in place of `metric`. `check --json --sql`
adds `sql: [{ dashboard, block, queries }]` to the diagnostic report. Nothing runs when check finds
an error. With paths, an error in a file outside them that keeps a dashboard from building is one
HM2015 error on that dashboard. A block the planner leaves out, such as a metric with segments
(HM4023), has no queries, and its warning is in `diagnostics`. `"__hm_source_<name>"` is a temporary table that holds the source's rows, in file order.
`"__hm_ord"` numbers those rows, so floating-point sums always add the values in the same order.

## Global options

| Option                   | Meaning                                               |
| ------------------------ | ----------------------------------------------------- |
| `--json`                 | Print one line of JSON.                               |
| `--format <human\|json>` | Choose the output format.                             |
| `--cwd <dir>`            | Run as if started in `<dir>`.                         |
| `--quiet`                | Print nothing on success in human mode.               |
| `--no-color`             | Disable colour.                                       |
| `--yes`, `-y`            | Accepted for scripts. Hatchmark never asks questions. |
| `--help`, `-h`           | Show help for the command.                            |

## Exit codes

| Code | Meaning                                                                                                                                                     |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | Success. Warnings are allowed unless you pass `check --strict`.                                                                                             |
| 1    | Errors in your files (`check` or `build` found at least one error).                                                                                         |
| 2    | Usage or configuration error: unknown command or option, missing argument, no `hatchmark.yaml` or errors in it, or `init` or `build` would overwrite files. |
| 3    | Environment problem, such as a data file that does not exist or a failed `doctor` check.                                                                    |
| 4    | Internal bug in Hatchmark. Please report it.                                                                                                                |

## Usage diagnostics

| Code     | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HM0001` | Unknown command. The diagnostic suggests the closest one.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `HM0002` | Unknown option, a value that is not allowed, or an unexpected argument.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `HM0003` | Missing argument.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `HM0004` | `build` found an output directory it did not write (not empty, no `_hatchmark/manifest.json`), a file it would overwrite that an earlier build did not write, a directory that contains the project, or a symbolic link as the output directory or anywhere under it, and wrote nothing. `init` would overwrite existing files, or found a directory or a symlink where it writes a file, and wrote nothing. The diagnostic lists the paths. `--force` overwrites regular files only, and init never writes through a symlink. `AGENTS.md` and `.gitignore` are always merged, never overwritten. |
| `HM0005` | `AGENTS.md` markers are not exactly one start line before one end line. Init wrote nothing. Fix the markers, or delete every marker line.                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `HM0006` | `dev` could not listen on `--port` or `--host`: the port is in use or the host is not an address of this machine. Exits 3. Without `--port`, dev takes the next free port on its own.                                                                                                                                                                                                                                                                                                                                                                                                             |
| `HM0007` | `dev` could not finish watching the project within 15 seconds, usually because a directory cannot be read; the diagnostic names the file system error. Exits 3.                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `HM0008` | `data query` got something other than exactly one SELECT, or the query reads or writes a file that is not a source. Nothing ran. Exits 2.                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `HM0009` | `data query` failed in DuckDB; the message is DuckDB's. An unknown table lists the source names. Exits 2.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

## data

`hatchmark data` lets you (or an agent) look at the data before writing metrics and dashboards. Both
subcommands read each source with the same reader options `build` uses, so the types they print are
the types metrics see. The session time zone is UTC: timestamps with an offset print in UTC.

`hatchmark data describe <source>` prints, for each column, its DuckDB type, a `kind` (`time`,
`number`, `boolean`, `text` or `other`), the number of nulls and of distinct non-null values, and
the min and max of `time` and `number` columns. It also prints the row count and the first rows in
file order (`--limit <n>`, default 5, `0` for none). A lookup source is not a file; describe the
sources it joins.

`hatchmark data query "<sql>"` runs one SELECT statement. Each file source is a table named after the
source, and `sources` lists them; a CTE of the same name hides the source. A missing or unreadable
source gives `HM2010` or `HM2015` only when the query reads it. The query cannot read files other than the sources or write anything: any other statement,
more than one statement, or a file access gives `HM0008`, and nothing runs. A DuckDB error gives
`HM0009` with DuckDB's message. At most `--limit` rows print (default 100, at most 10000), and
`truncated` says whether the query had more. Values are DuckDB's, before the rounding `build` applies
to displayed numbers.

```json
{
  "format_version": "1",
  "sql": "SELECT region, count(*) AS n FROM orders GROUP BY 1",
  "sources": ["orders"],
  "limit": 100,
  "columns": [{ "name": "region", "type": "VARCHAR" }, { "name": "n", "type": "BIGINT" }],
  "rows": [["South", 562], ["West", 366]],
  "truncated": false
}
```

Rows are arrays in column order. Integers beyond ±2^53, and DECIMAL values a JSON number cannot
hold exactly, are strings, so no digit is lost; dates are `YYYY-MM-DD` text and timestamps are DuckDB's text.

## init

`hatchmark init` writes the same bytes every time for the same name and template. It never runs
git or installs packages. With `--force`, it overwrites only the files it writes and reports them as
`created`, `updated` or `unchanged`. It resolves the directory it initialises once with realpath, so symlinks above it (such as
macOS `/tmp` and `/var`) are fine. Inside that directory it never writes through a symlink: a
symlinked file or subdirectory where it writes gives `HM0004`. It never
writes to an existing `CLAUDE.md`. When that file does not include `@AGENTS.md`, it adds a note to the result.
In `AGENTS.md` it replaces the block between exactly one `<!-- hatchmark:start -->` line and one
later `<!-- hatchmark:end -->` line, each alone on its line (surrounding spaces are fine), or appends a block when there are no marker lines. With any
other combination, including marker text that shares a line with anything else, it changes nothing and reports `HM0005` with the marker lines.

## docs

`hatchmark docs` reads the docs that ship inside the installed package (`node_modules/hatchmark/docs/`),
so what it prints always matches the version that runs your project, offline.

- `hatchmark docs` lists the topics: each page's path without `.md` (`index` for the README), such as
  `metrics` or `components/table`. A component page also answers to its short name, `table`.
- `hatchmark docs <topic>` prints a page as it is.
- `hatchmark docs <topic>#<section>` prints one section, from its heading to the next heading of the
  same or a higher level. The section is the heading's anchor as GitHub writes it: lower case,
  punctuation dropped, spaces as `-`, and `-1`, `-2` for repeated headings.
- `hatchmark docs --search "<words>"` lists the sections whose own text (without their subsections)
  holds every word, case-insensitive, best first, at most `--limit` (default 10). Each result has the
  `section` to print it, its `title`, the `line` in the page and a `snippet`.

JSON results carry `version`. A page or section result has `topic`, `path`, `title` and `content`.

## test

`hatchmark test` runs every test in the project, or those of the metrics and sources it names, and
exits 1 when one fails, so it fits a CI step. Metric tests are described in
[metrics.md](metrics.md#tests) and row-count tests in [project.md](project.md#row-count-tests). Each
test reads the data through the same queries as `build`, so a pinned number is the number a
dashboard shows.

JSON gives `passed`, `failed`, `errors` (tests that could not run, such as a missing fixture file),
one entry per test in `results` (`kind`, `target`, `index`, `name`, `file`, `pointer`, `status`,
`expected`, `actual`, `difference`), and the diagnostics: `HM4030` for each failure, `HM4031` for a
test that reads past the data. A test with `by` gives `actual` and `difference` per group. Exit
codes: 0 every test passed, 1 a test failed or could not run, 2 an error in `hatchmark.yaml` or a
name that is no metric or source, 3 a missing data or fixture file.

## dev

`hatchmark dev` serves the project at `http://localhost:5173/` (or the next free port) with the same
renderer, runtime and fonts as `hatchmark build`, at the same URLs: `/<dashboard>/` for each
dashboard, and `/` as the index when there is more than one (with one dashboard, `/` redirects to
it). It writes nothing into the project.

It watches `hatchmark.yaml`, the metrics, segments and dashboards directories and every data file
a source names. On a save it reloads the project and re-runs only the dashboards the change can
affect: the edited dashboard, the dashboards that show an edited metric or whose queries change,
and the dashboards whose queries read an edited data file. Everything re-runs when
`hatchmark.yaml` or a segment changes. It then compares each card with the page in the browser:

- Changed cards, or single KPIs in the KPI strip, are pushed over Vite's HMR connection and swapped
  in place, and the browser runtime is attached to them again, so tooltips and grain switches work.
  A swapped card keeps the grain the reader picked on it, or else the header grain filter's. The
  rest of the page, scroll position included, is left alone.
- A structural change reloads the page: a block added, removed or moved, a changed span or block
  type, or anything outside the grid (title, description, filters, period, footer, theme).
- An open page of a dashboard that was removed or renamed reloads into a "Dashboard removed" page
  (status 404), which reloads into the live dashboard when its file comes back. This holds for a
  page whose dashboard never built, too. The index reloads when a dashboard is added, removed or
  retitled, or the project name changes.

A data file that several sources read re-runs every dashboard that reads any of them. The file
watcher ignores a second change to a file within 50 ms of the first, so dev checks each file again
100 ms after rebuilding it and rebuilds once more if it changed in between.

When check or a dashboard's queries report errors, dev prints them in the terminal and lays them
over the page in the same format as `hatchmark check`, in the Default theme's colours, light or
dark. The page under it shows the last good build. The overlay clears on the next good build.

`--port <n>` fails with `HM0006` when the port is taken instead of choosing another one.
`--host 0.0.0.0` serves the local network; dev serves only the pages and their assets, never the
project's files. `--open` opens the page in the default browser.

Output: in human mode dev prints the URL on stdout, then rebuild notes and diagnostics on stderr.
In JSON mode it prints one line on stdout once the server is ready and nothing more there:

```json
{
  "format_version": "1",
  "ok": true,
  "url": "http://localhost:5173/sales/",
  "urls": ["http://localhost:5173/"]
}
```

Diagnostics go to stderr in both modes. Dev runs until it is stopped with Ctrl-C (SIGINT) or SIGTERM,
then exits 0. Without a `hatchmark.yaml` it exits 2 before starting. Dev never changes what
`build` writes: the build output holds no Vite or HMR code.
