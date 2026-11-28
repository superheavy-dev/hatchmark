# Commands

Every command takes the global options `--json`, `--cwd <dir>`, `--quiet`, `--no-color` and
`--help`. `hatchmark <command> --help --json` prints a command's options and an example.
`hatchmark docs cli` is the full reference.

| Command                                                             | Use it to                                                                                                                                               |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hatchmark init [dir] [--template sample\|minimal] [--name <name>]` | Create a project. Refuses to replace existing starter files without `--force`; merges a Hatchmark block into `AGENTS.md` and entries into `.gitignore`. |
| `hatchmark data describe <source> [--limit <n>]`                    | See a source's columns, types, nulls, distinct counts, ranges and first rows.                                                                           |
| `hatchmark data query "<sql>" [--limit <n>]`                        | Run one read-only SELECT over the sources.                                                                                                              |
| `hatchmark check [paths...] [--strict] [--sql]`                     | Check the project. `--strict` fails on warnings; `--sql` adds every block's SQL.                                                                        |
| `hatchmark explain <code>`                                          | Explain a diagnostic code such as `HM2003`.                                                                                                             |
| `hatchmark explain <metric>`                                        | Print the SQL that build runs for a metric.                                                                                                             |
| `hatchmark explain --dashboard <name> --block <id>`                 | Print the SQL of one block.                                                                                                                             |
| `hatchmark schema [project\|metric\|dashboard]`                     | Print the JSON Schema of a file kind.                                                                                                                   |
| `hatchmark docs [topic[#section]]`                                  | Print the docs of the installed version. `--search "<words>"` finds sections.                                                                           |
| `hatchmark build [--out <dir>] [--no-cache]`                        | Write static HTML pages.                                                                                                                                |
| `hatchmark dev [--port <n>] [--host <h>] [--open]`                  | Serve the pages locally and update them on every save.                                                                                                  |
| `hatchmark doctor`                                                  | Check Node.js, the bundled docs and schemas, that `hatchmark.yaml` exists, and this skill's copies.                                                     |
| `hatchmark skills install`                                          | Install or refresh this skill for coding agents.                                                                                                        |
| `hatchmark version`                                                 | Print the Hatchmark and Node.js versions.                                                                                                               |

## Loop

1. `hatchmark data describe <source> --json` for every source a change touches.
2. Edit one YAML file.
3. `hatchmark check --json`. Exit 0 means no errors; read the warnings anyway.
4. Repeat until check is clean, then `hatchmark build --json`.

## Reading JSON results

Check results and every error use one report: `ok`, `error_count`, `warning_count` and
`diagnostics`, each with `code`, `severity`, `message`, `file` and `range` when it points
into a file, and optional `help`, `expected` and `fix`. `hatchmark docs diagnostics` describes
every field.

## Topics

`hatchmark docs` lists them. The main ones: `project` (hatchmark.yaml and sources), `metrics`,
`dashboards`, `components/<type>` (or just the type, such as `table`), `build`, `numbers` (how
every number is computed), `diagnostics`, `theme`, `geo` and `cli`.
