# Hatchmark docs

Start with [cli.md](cli.md) for the commands. Then, in the order you write the files:

- [project.md](project.md): `hatchmark.yaml` and data sources, and what to do after `init --template minimal`.
- [metrics.md](metrics.md): `metrics/<name>.yaml`: aggregate, ratio and SQL metrics, filters, formats.
- [dashboards.md](dashboards.md): `dashboards/<name>.yaml`: period, blocks, span, filters.
- [components/](components/): each block type, [kpi](components/kpi.md), [line](components/line.md), [bar](components/bar.md), [stacked](components/stacked.md), [pie and donut](components/pie.md), [scatter](components/scatter.md) and [table](components/table.md).
- [build.md](build.md): `hatchmark build` and the pages it writes.
- [theme.md](theme.md): the Default theme's series colours, light and dark.
- [numbers.md](numbers.md): exactly how every number is computed.
- [diagnostics.md](diagnostics.md): the diagnostic format; `hatchmark explain <code>` explains one code.

Every spec file is YAML with the `.yaml` extension ([diagnostics.md](diagnostics.md#yaml-syntax)
has the rules). `hatchmark schema <project|metric|dashboard>` prints the JSON Schema of each file
kind; the same schemas ship in `node_modules/hatchmark/schema/`, and a first line such as
`# yaml-language-server: $schema=../node_modules/hatchmark/schema/metric.schema.json` gives
completion and checks in editors that run the YAML language server. `hatchmark init` writes that
line in every file.
