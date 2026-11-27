# Command line

`hatchmark <command> [options]`. Every command runs without prompts, so scripts and AI agents can
run it the same way a person does. `hatchmark <command> --help` shows a command's options and one
example. [README.md](README.md) lists every docs page; the files a project holds are described in
[project.md](project.md), [metrics.md](metrics.md) and [dashboards.md](dashboards.md).

| Command                                   | What it does                                                                                                                                                                                                          |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `init [dir]`                              | Creates a project: `hatchmark.json` with every setting written out, sample US orders data, four metrics, a dashboard, and a Hatchmark block in `AGENTS.md`.                                                           |
| `check [paths...]`                        | Checks JSON syntax, spec shape, and references between files and to data columns. Paths are relative to `--cwd`. `hatchmark.json` is always checked first, whatever the paths. `--sql` also prints every block's SQL. |
| `build [--out <dir>]`                     | Checks the project, runs every dashboard's queries and writes static HTML pages to `outDir`. See [build.md](build.md).                                                                                                |
| `schema [project\|metric\|dashboard]`     | Prints the JSON Schema for a file kind, or all three keyed by kind.                                                                                                                                                   |
| `explain <code>`                          | Explains a diagnostic code such as `HM2003` and how to fix it.                                                                                                                                                        |
| `explain <metric>`                        | Prints the SQL that build runs for a metric. See [Printing the SQL](#printing-the-sql).                                                                                                                               |
| `explain --dashboard <name> --block <id>` | Prints the SQL of one block. See [Printing the SQL](#printing-the-sql).                                                                                                                                               |
| `version`                                 | Prints the Hatchmark and Node.js versions.                                                                                                                                                                            |
| `doctor`                                  | Checks that this machine can run Hatchmark: Node.js, bundled docs and schemas, project config.                                                                                                                        |

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
| 2    | Usage or configuration error: unknown command or option, missing argument, no `hatchmark.json` or errors in it, or `init` or `build` would overwrite files. |
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
