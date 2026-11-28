---

name: hatchmark
description: Build and edit Hatchmark dashboards from YAML specs. Use when a project has a hatchmark.yaml, or when asked to add or change a Hatchmark dashboard, metric, data source or chart, explore the data behind one, fix a hatchmark check diagnostic, or build or preview the pages.
license: Apache-2.0
compatibility: Needs the hatchmark CLI, run as hatchmark or npx hatchmark, on Node.js 22.18 or later.
---

# Hatchmark

Hatchmark turns short YAML files into static dashboard pages. A project has one `hatchmark.yaml`
(settings and data sources), one file per metric under `metrics/` and one file per dashboard under
`dashboards/`. Your training data likely predates the installed version, so trust the docs that
ship with it (`hatchmark docs`) over memory.

## Rules

- Every command runs without prompts and prints one line of JSON with `--json`. Logs go to stderr.
- Exit codes: 0 ok (warnings allowed), 1 errors in your files, 2 usage or config error,
  3 environment problem (such as a missing data file), 4 internal bug.
- YAML is the only format for specs. One file per thing; the file name is the name, lowercase
  snake_case: `metrics/net_revenue.yaml` is the metric `net_revenue`.
- Run `hatchmark check --json` after every edit and fix every error before you finish.
- Never invent a field. `hatchmark schema <project|metric|dashboard>` prints the JSON Schema, and
  `hatchmark docs <topic>` prints the page that explains it.

## Workflow

1. Orient. `hatchmark docs` lists the bundled topics; `hatchmark docs --search "<words>"` finds
   a section and `hatchmark docs <topic>#<section>` prints it. Read the existing YAML files.
   No `hatchmark.yaml` yet? `hatchmark init` creates a sample project, `--template minimal` an
   empty one.
2. Look at the data before writing a metric. `hatchmark data describe <source> --json` lists
   columns, types, null and distinct counts and time ranges. `hatchmark data query "<sql>" --json`
   runs one read-only SELECT; each source is a table named after it.
3. Write the YAML. A data file becomes a source in `hatchmark.yaml`, each number a metric file, each
   page a dashboard file whose blocks name metrics. See
   [references/metrics.md](references/metrics.md) and
   [references/dashboards.md](references/dashboards.md).
4. Check. `hatchmark check --json` and fix every diagnostic: each has a `code`, a `message`, a
   location and often a `help` line or a fix. `hatchmark explain <code>` explains a code. See
   [references/diagnostics.md](references/diagnostics.md).
5. Verify the numbers. `hatchmark explain <metric>` prints the SQL a metric runs, and
   `hatchmark explain --dashboard <name> --block <id>` the SQL of one block. Compare a surprising
   value with `hatchmark data query`.
6. Build or preview. `hatchmark build --json` writes static pages to `outDir` (`dist/` by
   default); `hatchmark dev` serves them with live reload for a person to look at.

[references/workflow.md](references/workflow.md) has the commands and their flags in one place.

## When something is off

- `hatchmark doctor --json` checks Node.js, the bundled docs and schemas, the project config, and
  whether this skill matches the installed CLI.
- A copy of this skill from another version: `hatchmark skills install` refreshes it.
- The CLI disagrees with this skill: the CLI and `hatchmark docs` win.
