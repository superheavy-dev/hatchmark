# Hatchmark docs

Start with [cli.md](cli.md) for the commands. Then, in the order you write the files:

- [project.md](project.md): `hatchmark.json` and data sources, and what to do after `init --template minimal`.
- [metrics.md](metrics.md): `metrics/<name>.json`: aggregate, ratio and SQL metrics, filters, formats.
- [dashboards.md](dashboards.md): `dashboards/<name>.json`: period, blocks, span, filters.
- [components/](components/): each block type, [kpi](components/kpi.md), [line](components/line.md), [bar](components/bar.md), [stacked](components/stacked.md) and [table](components/table.md).
- [build.md](build.md): `hatchmark build` and the pages it writes.
- [numbers.md](numbers.md): exactly how every number is computed.
- [diagnostics.md](diagnostics.md): the diagnostic format; `hatchmark explain <code>` explains one code.

`hatchmark schema <project|metric|dashboard>` prints the JSON Schema of each file kind.
