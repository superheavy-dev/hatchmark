# hatchmark build

`hatchmark build` turns a project into static HTML: one page per dashboard, ready for any static
host. It never asks questions and prints one line of JSON when an agent runs it.

```sh
hatchmark build            # writes outDir from hatchmark.json (dist by default)
hatchmark build --out site # writes site/ instead, relative to --cwd
hatchmark build --json     # one line of JSON on stdout
```

## What it does

1. Loads the project and checks it, like `hatchmark check`. Any error stops the build before a
   query runs (exit 1, the same diagnostics as check).
2. Plans every dashboard, runs its queries in DuckDB against the files in `dataDir`, and resolves
   `asOf: "latest_data"` once per dashboard.
3. Renders each dashboard with the Default theme and writes the output directory.

Blocks the renderer does not draw yet (`bar_list`, `text`) are skipped with warning `HM4002`;
the rest of the dashboard is built.

## Output

```
dist/
  sales/index.html          one page per dashboard, named after dashboards/<name>.json
  index.html                a list of dashboards, only when there is more than one
  _hatchmark/
    hatchmark.<hash>.js     the browser runtime (tooltips, crosshair, keyboard)
    IBMPlexSans-*.<hash>.woff2
    OFL.txt                 the font licence
```

- Every URL in the output is relative, so `dist/` works on any static host, under any sub-path
  (`https://example.com/reports/`), and opened straight from disk.
- Asset names carry a content hash, so they can be cached forever.
- The output is byte-identical for identical input: the page shows the date the data runs
  through ("Data through Oct 31, 2026"), never the build time. Pin `period.asOf` to a date if the
  data itself keeps growing and you want reproducible builds.
- The output directory is deleted and rewritten on every build. Build refuses (`HM0004`, exit 2)
  when the directory is not empty and holds no `_hatchmark/` folder, so it never deletes files
  it did not write, and it refuses an output directory that contains the project.

## The page

- Header with the project name, dashboard title, the period ("Nov 2025 – Oct 2026 compared with
  Nov 2024 – Oct 2025 · USD"), the description, and the data date. Footer with the source files.
- Consecutive `kpi` blocks form one KPI strip. Other blocks are cards in a 12-column grid, as
  wide as their `span`.
- Light and dark follow the reader's system setting. `?theme=dark` or `?theme=light` in the URL,
  or `data-theme="dark"` on the `<html>` element, overrides it.
- Layout: charts are drawn at the exact width of each layout (1392, 1232, 976, 720, 552, 358 and
  328 px of content) and the page shows the one that fits, so chart text is never scaled. Below
  1024 px every block takes the full width; on phones KPIs sit two per row.
- Charts carry a text description and a hidden data table for screen readers, and can be stepped
  through with the arrow keys after focusing them (Tab).

See [components/](components/) for each block type.

## JSON result

```json
{
  "format_version": "1",
  "ok": true,
  "error_count": 0,
  "warning_count": 0,
  "diagnostics": [],
  "out_dir": "dist",
  "pages": [{ "dashboard": "sales", "path": "dist/sales/index.html" }],
  "files": 9
}
```

`index` is added when an index page was written. On errors the result is the diagnostic report
described in [diagnostics.md](diagnostics.md) and nothing is written.

## Exit codes

| Code | Meaning                                                                       |
| ---- | ----------------------------------------------------------------------------- |
| 0    | Built. Warnings are allowed.                                                  |
| 1    | Errors in the project's files; nothing was built.                             |
| 2    | Usage or configuration error, or the output directory was refused (`HM0004`). |
| 3    | Environment problem, such as a data file that does not exist.                 |
| 4    | Internal bug in Hatchmark. Please report it.                                  |

## Try it

```sh
hatchmark init shop && cd shop
hatchmark build
open dist/sales/index.html
```
