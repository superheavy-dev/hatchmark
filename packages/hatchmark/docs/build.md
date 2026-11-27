# hatchmark build

`hatchmark build` turns a project into static HTML: one page per dashboard, ready for any static
host. It never asks questions and prints one line of JSON when an agent runs it.

```sh
hatchmark build            # writes outDir from hatchmark.json (dist by default)
hatchmark build --out site # writes site/ instead, relative to --cwd
hatchmark build --json     # one line of JSON on stdout
hatchmark build --no-cache # run every query instead of reusing .hatchmark/cache/
```

## What it does

1. Loads the project and checks it, like `hatchmark check`. Any error stops the build before a
   query runs (exit 1, the same diagnostics as check).
2. Plans every dashboard, runs its queries in DuckDB against the files in `dataDir`, and resolves
   `asOf: "latest_data"` or `"latest_common_data"` once per dashboard from the source horizons.
   The build machine's clock is read only to warn about future-dated rows (`HM4012`).
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
    manifest.json           every file this build wrote
```

- Every URL in the output is relative, so `dist/` works on any static host, under any sub-path
  (`https://example.com/reports/`), and opened straight from disk.
- Asset names carry a content hash, so they can be cached forever.
- The output is byte-identical for identical input: the page shows the date the data runs
  through ("Data through Oct 31, 2026"), never the build time. Pin `period.asOf` to a date if the
  data itself keeps growing and you want reproducible builds.
- Build never deletes a file it did not write. Each build lists its files in
  `_hatchmark/manifest.json`, and the next build removes exactly those before writing; anything
  else in the directory stays. Build refuses (`HM0004`, exit 2) a directory that is not empty
  and has no manifest, a file it would write that the manifest does not list, and an output
  directory that contains the project. Build never follows a symbolic link: it also refuses an
  output directory that is a link (or sits under one inside the project), and any link where it
  would read, remove or write under the output directory. Each file is written fresh and renamed
  into place.

## The page

- Header with the project name, dashboard title, the period ("Nov 2025 – Oct 2026 compared with
  Nov 2024 – Oct 2025 · USD"), the description, and the data date. Footer with the source files.
- Consecutive `kpi` blocks form one KPI strip. Other blocks are cards in a 12-column grid, as
  wide as their `span`. Line, area and bar charts are at least 3 columns wide (HM2024 warns when
  `span` is smaller); a card that no longer fits beside the cards before it starts the next row.
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
  "files": 9,
  "cache": { "enabled": true, "dir": ".hatchmark/cache", "hits": 24, "misses": 0, "written": 0 }
}
```

`index` is added when an index page was written. `cache` counts the queries reused from the build
cache (`hits`), the ones that ran (`misses`) and the entries written; it is absent with
`--no-cache`. On errors the result is the diagnostic report
described in [diagnostics.md](diagnostics.md) and nothing is written.

## Build cache

Build keeps every query result, and the latest date of every time column it measured, in
`.hatchmark/cache/` as Parquet files, so the next build runs only the queries whose inputs
changed. `hatchmark init` adds `.hatchmark/` to `.gitignore`.

- A result is reused only when everything that decides it is unchanged: the query (its metric,
  filters, grouping, window and the source's reader options in `hatchmark.json`), the as-of date,
  time zone, week and year anchors and filter defaults, the contents of the data files it reads,
  and the engine (the Hatchmark version, its query and executor code, and the DuckDB version).
- Data files are compared by the SHA-256 of their contents, never by size or modification time,
  so any changed byte runs the query again. Build first copies each data file it reads into
  `.hatchmark/tmp/` (a copy-on-write clone where the file system supports it), hashes the copy and
  runs the queries on the copy, so a file edited while a build runs can never be stored under the
  wrong fingerprint. The copy is removed when the build ends.
- Queries of raw SQL metrics (`"type": "sql"`) always run and are never cached: their SQL can
  read the clock or other files, which no cache key can see.
- A cached build writes the same bytes as `hatchmark build --no-cache`. A damaged or unreadable
  entry is ignored and rewritten.
- Each build removes the entries it did not use, so the cache holds the last build's results.
  Deleting `.hatchmark/cache/` is always safe.
- The cache turns itself off (and says why in `cache.reason`) when `.hatchmark` or any
  directory under it that the cache uses is a symbolic link. When an entry cannot be written or removed (a read-only directory,
  a full disk), build still succeeds and simply keeps fewer entries.

`hatchmark explain --dashboard <name> --block <id>` lists each query's cache status after its SQL:
`hit` with the time the entry was stored, `stale` with what changed since (`data` with the file,
`context` such as the as-of date, or `engine`), `miss`, or `off` for raw SQL metrics. Editing a
query itself (a metric's filters, a block's grain) gives it a new id, so it shows as a `miss`.

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
