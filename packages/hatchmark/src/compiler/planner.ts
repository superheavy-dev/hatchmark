import { type Diagnostic, docsCommand } from "../diagnostics/index.js";
import {
  type Anchors,
  type Block,
  blockId,
  type Comparison,
  type Dashboard,
  DEFAULT_PERIOD,
  type FileSource,
  type Filter,
  type Grain,
  grainKey,
  type Metric,
  type Project,
  plainAggregate,
  projectAnchors,
  type ResolvedGrain,
  resolveGrain,
  type Source,
  type SpecFile,
  sameColumn,
} from "../spec/index.js";
import { canonicalJson, sha256Hex } from "./hash.js";
import { planHorizons, type TimeColumn } from "./horizons.js";
import { paramsForQuery, resolveParams } from "./params.js";
import {
  type BlockPlan,
  type Compiler,
  type MeasureComponent,
  type MeasureExpression,
  PLAN_VERSION,
  type PlannedDimension,
  type PlannedMeasure,
  type PlannedQuery,
  type PlanParam,
  type PlanResult,
  type QueryPlan,
} from "./plan.js";

/** Block types the planner builds in phase 1; the others get an HM4002 warning and no plan. */
export const PLANNED_BLOCK_TYPES = [
  "kpi",
  "line",
  "area",
  "bar",
  "pie",
  "donut",
  "table",
  "scatter",
  "map",
] as const;

type AxisDimension =
  | { kind: "column"; column: string }
  | { kind: "time"; grain: ResolvedGrain }
  | Extract<PlannedDimension, { kind: "region" }>;

export const ROWS_MEASURE: PlannedMeasure = {
  metric: "__rows",
  components: [{ id: "__rows__count", aggregate: "count", filters: [], reaggregate: "sum" }],
  combine: { op: "identity", component: "__rows__count" },
};

interface Context {
  file: SpecFile<"dashboard">;
  spec: Dashboard;
  metrics: Map<string, Metric>;
  sources: Record<string, Source>;
  params: PlanParam[];
  range: QueryPlan["period"]["range"];
  compare: Comparison;
  anchors: Anchors;
  columnTypes: Project["columnTypes"];
}

interface Reading {
  queries: PlannedQuery[];
  measures: Record<string, MeasureExpression>;
  rows?: string[];
}

function component(
  id: string,
  aggregate: MeasureComponent["aggregate"],
  metric: Metric & { type: "aggregate" | "sql" },
  extra: { column?: string; sql?: string },
  reaggregate: MeasureComponent["reaggregate"],
): MeasureComponent {
  return { id, aggregate, ...extra, filters: metric.filters ?? [], reaggregate };
}

const NUMERIC_TYPE =
  /^(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT|UHUGEINT|FLOAT|DOUBLE|DECIMAL\(\d+,\s*\d+\))$/;

function countsRows(sql: string, types: readonly { name: string; type: string }[] | undefined) {
  const plain = plainAggregate(sql);
  if (plain?.fn === "count") return true;
  const type = types?.find((c) => plain?.column !== undefined && sameColumn(c.name, plain.column));
  return type !== undefined && NUMERIC_TYPE.test(type.type);
}

/** An aggregate or SQL metric as components plus how to combine them (see PlannedMeasure). */
export function plannedMeasure(
  name: string,
  metric: Metric,
  types?: readonly { name: string; type: string }[],
): PlannedMeasure | undefined {
  if (metric.type !== "aggregate" && metric.type !== "sql") return undefined;
  if (metric.type === "sql") {
    const id = `${name}__sql`;
    const combine = { op: "identity", component: id } as const;
    if (!metric.additive) {
      const c = component(id, "sql", metric, { sql: metric.sql }, "none");
      return { metric: name, components: [c], combine };
    }
    const c = component(id, "sql", metric, { sql: metric.sql }, "sum");
    if (!countsRows(metric.sql, types)) return { metric: name, components: [c], combine };
    const rows = component(`${name}__rows`, "count", metric, {}, "sum");
    return { metric: name, components: [c, rows], combine, rows: rows.id };
  }
  const column = metric.column === undefined ? {} : { column: metric.column };
  if (metric.aggregate === "avg") {
    const sum = component(`${name}__sum`, "sum", metric, column, "sum");
    const count = component(`${name}__count`, "count", metric, column, "sum");
    return {
      metric: name,
      components: [sum, count],
      combine: { op: "divide", numerator: sum.id, denominator: count.id },
    };
  }
  const reaggregate: MeasureComponent["reaggregate"] =
    metric.aggregate === "sum" || metric.aggregate === "count"
      ? "sum"
      : metric.aggregate === "min" || metric.aggregate === "max"
        ? metric.aggregate
        : "none";
  const id = `${name}__${metric.aggregate}`;
  const c = component(id, metric.aggregate, metric, column, reaggregate);
  return { metric: name, components: [c], combine: { op: "identity", component: id } };
}

/**
 * The first metric-layer primitive of RFC 0001 that a metric uses, directly or through a ratio,
 * and the planner does not evaluate yet; undefined when the planner builds the metric. A block that
 * shows such a metric is left out with an HM4023 warning, never planned as a plain sum.
 */
export function notBuiltYet(
  name: string,
  metrics: ReadonlyMap<string, Metric>,
  sources: Readonly<Record<string, Source>>,
  seen: ReadonlySet<string> = new Set(),
): string | undefined {
  const metric = metrics.get(name);
  if (metric === undefined || seen.has(name)) return undefined;
  if (metric.type === "formula" || metric.type === "per_entity") return `${metric.type} metrics`;
  if (metric.type === "ratio") {
    const next = new Set(seen).add(name);
    return (
      notBuiltYet(metric.numerator, metrics, sources, next) ??
      notBuiltYet(metric.denominator, metrics, sources, next)
    );
  }
  const source = sources[metric.table];
  if (source?.type === "lookup") return "lookup sources";
  if (source?.snapshot !== undefined) return 'the source option "snapshot"';
  const tables = (metric.filters ?? []).flatMap((f) =>
    f.op === "in_table" || f.op === "not_in_table" ? [f.table] : [],
  );
  if (tables.some((t) => sources[t]?.type === "lookup")) return "in_table on a lookup source";
  if (metric.type === "sql") return undefined;
  if (metric.over_time !== undefined && metric.over_time !== "sum")
    return `over_time: ${metric.over_time}`;
  for (const key of ["value", "entity", "active", "trailing", "scale"] as const) {
    if (metric[key] !== undefined) return `"${key}"`;
  }
  return undefined;
}

function filterTables(
  sources: Record<string, Source>,
  measures: PlannedMeasure[],
): Record<string, FileSource> | undefined {
  const names = measures
    .flatMap((m) => m.components)
    .flatMap((c) => [...c.filters, ...(c.anyOf ?? []).flatMap((s) => s.filters)])
    .flatMap((f) => (f.op === "in_table" || f.op === "not_in_table" ? [f.table] : []))
    .sort();
  const tables: Record<string, FileSource> = {};
  for (const name of names) {
    const source = sources[name];
    if (source !== undefined && source.type !== "lookup") tables[name] = source;
  }
  return Object.keys(tables).length > 0 ? tables : undefined;
}

function leaves(name: string, metrics: Map<string, Metric>, seen = new Set<string>()): string[] {
  const metric = metrics.get(name);
  if (metric === undefined || seen.has(name)) return [];
  if (metric.type === "aggregate" || metric.type === "sql") return [name];
  if (metric.type !== "ratio") return [];
  seen.add(name);
  return [
    ...leaves(metric.numerator, metrics, new Set(seen)),
    ...leaves(metric.denominator, metrics, new Set(seen)),
  ];
}

/** A content hash of everything in the query but its id, so equal shapes share one id. */
export function queryId(query: Omit<PlannedQuery, "id">): string {
  return `q_${sha256Hex(canonicalJson(query)).slice(0, 16)}`;
}

function planReading(
  ctx: Context,
  names: string[],
  axes: AxisDimension[],
  groupingSets: number[][],
  shift: Comparison,
  oneWindow = false,
  edges?: "clip",
  allPeriods = false,
  rows = false,
): Reading {
  const groups = new Map<
    string,
    { source: string; time?: string; horizons: TimeColumn[]; metrics: string[] }
  >();
  const queryOf = new Map<string, string>();
  const horizonsOf = (name: string): TimeColumn[] => {
    const columns = new Map<string, TimeColumn>();
    for (const leaf of oneWindow
      ? names.flatMap((n) => leaves(n, ctx.metrics))
      : leaves(name, ctx.metrics)) {
      const metric = ctx.metrics.get(leaf);
      if (metric === undefined || (metric.type !== "aggregate" && metric.type !== "sql")) continue;
      if (metric.time === undefined) continue;
      const column = { source: metric.table, column: metric.time };
      columns.set(canonicalJson(column), column);
    }
    return [...columns.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([, c]) => c);
  };
  const uses = names.flatMap((n) => {
    const horizons = horizonsOf(n);
    return leaves(n, ctx.metrics).map((leaf) => ({ leaf, horizons }));
  });
  for (const { leaf, horizons } of uses.sort((a, b) =>
    a.leaf < b.leaf ? -1 : a.leaf > b.leaf ? 1 : 0,
  )) {
    const metric = ctx.metrics.get(leaf);
    if (metric === undefined || (metric.type !== "aggregate" && metric.type !== "sql")) continue;
    const isolated = metric.type === "sql" && (metric.filters ?? []).length > 0;
    const key = canonicalJson([
      metric.table,
      metric.time ?? null,
      isolated ? leaf : null,
      horizons,
    ]);
    const group = groups.get(key) ?? {
      source: metric.table,
      ...(metric.time === undefined ? {} : { time: metric.time }),
      horizons,
      metrics: [],
    };
    if (!group.metrics.includes(leaf)) group.metrics.push(leaf);
    groups.set(key, group);
    queryOf.set(canonicalJson([leaf, horizons]), key);
  }

  const ids = new Map<string, string>();
  const queries: PlannedQuery[] = [];
  for (const [key, group] of groups) {
    const input = ctx.sources[group.source];
    if (input === undefined || input.type === "lookup") continue;
    const grainAxis = axes.some((axis) => axis.kind === "time");
    const dimensions: PlannedDimension[] = axes.map((axis) =>
      axis.kind === "time" ? { kind: "time", column: group.time ?? "", grain: axis.grain } : axis,
    );
    const measures = group.metrics.flatMap((m) => {
      const metric = ctx.metrics.get(m);
      const measure =
        metric &&
        plannedMeasure(
          m,
          metric,
          metric.type === "sql" ? ctx.columnTypes.get(metric.table) : undefined,
        );
      return measure ? [measure] : [];
    });
    const tables = filterTables(ctx.sources, measures);
    const shape: Omit<PlannedQuery, "id"> = {
      source: group.source,
      input,
      ...(tables === undefined ? {} : { tables }),
      measures,
      dimensions,
      groupingSets,
      window:
        group.time === undefined
          ? { range: "all_time", shift: "none" }
          : {
              range: allPeriods ? "all_time" : ctx.range,
              ...(allPeriods ? { through: "horizon" as const } : {}),
              shift,
              column: group.time,
              horizons: group.horizons,
              ...(edges !== undefined && grainAxis ? { edges } : {}),
            },
      params: paramsForQuery(ctx.params, group.source, group.time).filter(
        (p) => !allPeriods || p.kind !== "period",
      ),
    };
    const id = queryId(shape);
    ids.set(key, id);
    queries.push({ id, ...shape });
  }

  const rowQueries: string[] = [];
  if (rows) {
    const bySource = new Map<
      string,
      {
        group: { time?: string; horizons: TimeColumn[] };
        byTime: Map<string, { time?: string; filters: Map<string, Filter[]> }>;
      }
    >();
    for (const group of groups.values()) {
      const input = ctx.sources[group.source];
      if (input === undefined || input.type === "lookup") continue;
      const entry = bySource.get(group.source) ?? { group, byTime: new Map() };
      const timeKey = group.time ?? "";
      const at = entry.byTime.get(timeKey) ?? {
        ...(group.time === undefined ? {} : { time: group.time }),
        filters: new Map<string, Filter[]>(),
      };
      for (const m of group.metrics) {
        const metric = ctx.metrics.get(m);
        const filters = (metric && plannedMeasure(m, metric))?.components[0]?.filters ?? [];
        at.filters.set(canonicalJson(filters), filters);
      }
      entry.byTime.set(timeKey, at);
      bySource.set(group.source, entry);
    }
    for (const [source, { group, byTime }] of bySource) {
      const sets = [...byTime.values()].flatMap(({ time, filters }) => {
        const all = [...filters.values()];
        const kept = all.some((f) => f.length === 0) ? [[]] : all;
        return kept.map((f) => ({ ...(time === undefined ? {} : { time }), filters: f }));
      });
      const only = sets.length === 1 ? sets[0] : undefined;
      const counted: MeasureComponent = {
        ...(ROWS_MEASURE.components[0] as MeasureComponent),
        ...(only === undefined ? { anyOf: sets } : { filters: only.filters }),
      };
      const measure: PlannedMeasure = { ...ROWS_MEASURE, components: [counted] };
      const tables = filterTables(ctx.sources, [measure]);
      const shape: Omit<PlannedQuery, "id"> = {
        source,
        input: ctx.sources[source] as PlannedQuery["input"],
        ...(tables === undefined ? {} : { tables }),
        measures: [measure],
        dimensions: axes as PlannedDimension[],
        groupingSets,
        window:
          group.time === undefined
            ? { range: "all_time", shift: "none" }
            : { range: ctx.range, shift, column: group.time, horizons: group.horizons },
        params: paramsForQuery(ctx.params, source, group.time),
      };
      const id = queryId(shape);
      rowQueries.push(id);
      queries.push({ id, ...shape });
    }
  }

  const expression = (name: string, horizons: TimeColumn[]): MeasureExpression => {
    const metric = ctx.metrics.get(name);
    if (metric?.type === "ratio") {
      return {
        op: "divide",
        numerator: expression(metric.numerator, horizons),
        denominator: expression(metric.denominator, horizons),
      };
    }
    const key = queryOf.get(canonicalJson([name, horizons])) ?? "";
    return { op: "ref", queryId: ids.get(key) ?? "", metric: name };
  };
  const measures: Record<string, MeasureExpression> = {};
  for (const name of names) measures[name] = expression(name, horizonsOf(name));
  return rows ? { queries, measures, rows: rowQueries } : { queries, measures };
}

function seriesReading(
  ctx: Context,
  block: Block & { type: "line" | "area" | "bar" },
  grain: ResolvedGrain | undefined,
): Reading {
  const axes: AxisDimension[] =
    grain !== undefined
      ? [{ kind: "time", grain }]
      : [{ kind: "column", column: block.type === "bar" ? (block.by ?? "") : "" }];
  if (block.split !== undefined) axes.push({ kind: "column", column: block.split });
  const perPosition = block.type === "bar" || (block.type === "area" && Boolean(block.stack));
  const sets = block.split === undefined ? [[0]] : perPosition ? [[0, 1], [0], [1]] : [[0, 1], [1]];
  return planReading(
    ctx,
    block.metrics,
    axes,
    sets,
    "none",
    false,
    grain !== undefined && block.edges === "clip" ? "clip" : undefined,
  );
}

/**
 * The grain a time-series block shows first: the dashboard grain filter's default when the block's
 * grains list it, else the block's grain.
 */
export function shownGrain(
  ctx: { spec: Dashboard; anchors: Anchors },
  grain: Grain,
  grains: Grain[] | undefined,
): ResolvedGrain {
  const own = resolveGrain(grain, ctx.anchors);
  const filter = ctx.spec.filters?.find((f) => f.type === "grain");
  if (filter === undefined || grains === undefined) return own;
  const chosen = resolveGrain(filter.default, ctx.anchors);
  const listed = grains.some((g) => grainKey(resolveGrain(g, ctx.anchors)) === grainKey(chosen));
  return listed ? chosen : own;
}

function planBlockAt(
  ctx: Context,
  block: Block,
  index: number,
): { block?: BlockPlan; queries: PlannedQuery[]; diagnostics: Diagnostic[] } {
  const pointer = `/blocks/${index}`;
  const id = blockId(block, index);
  if (!(PLANNED_BLOCK_TYPES as readonly string[]).includes(block.type)) {
    return {
      queries: [],
      diagnostics: [
        {
          code: "HM4002",
          severity: "warning",
          message: `${block.type} blocks are not built yet; block "${id}" is left out`,
          file: ctx.file.file,
          pointer,
          ...ctx.file.document.locationOf(pointer),
          help: `use a ${block.type === "bar_list" ? "bar block with by and a limit" : "kpi block"} for now, or keep it and build without it`,
          docs: docsCommand("HM4002"),
        },
      ],
    };
  }

  const shown = shownMetrics(block);
  const toggled = ctx.params.some(
    (p) =>
      p.kind === "segment" &&
      p.segments.some((s) => s.filters.some((f) => f.op === "in_table" || f.op === "not_in_table")),
  );
  for (const name of shown) {
    const feature = toggled
      ? "a segment filter with in_table filters"
      : notBuiltYet(name, ctx.metrics, ctx.sources);
    if (feature === undefined) continue;
    return {
      queries: [],
      diagnostics: [
        {
          code: "HM4023",
          severity: "warning",
          message: `metric "${name}" uses ${feature}, which the planner does not evaluate yet; block "${id}" is left out`,
          file: ctx.file.file,
          pointer,
          ...ctx.file.document.locationOf(pointer),
          help: "check validates the metric; the block appears once the planner evaluates it",
          docs: docsCommand("HM4023"),
        },
      ],
    };
  }

  const readings: {
    measures: Reading;
    previous?: Reading;
    sparkline?: Reading;
    domain?: Reading;
    report?: Reading;
    grain?: ResolvedGrain;
    grains?: { grain: ResolvedGrain; reading: Reading }[];
  } = (() => {
    switch (block.type) {
      case "kpi": {
        const names = [block.metric];
        const compare = block.compare ?? ctx.compare;
        const timed = hasTime(ctx, block.metric);
        return {
          measures: planReading(ctx, names, [], [[]], "none"),
          ...(compare !== "none" && timed
            ? { previous: planReading(ctx, names, [], [[]], compare) }
            : {}),
          ...(block.sparkline === true && timed
            ? {
                sparkline: planReading(
                  ctx,
                  names,
                  [{ kind: "time", grain: { unit: "month" } }],
                  [[0]],
                  "none",
                ),
              }
            : {}),
        };
      }
      case "line":
      case "area":
      case "bar": {
        const domain =
          block.split === undefined || block.groups === undefined
            ? {}
            : {
                domain: planReading(
                  ctx,
                  block.metrics,
                  [{ kind: "column", column: block.split }],
                  [[0]],
                  "none",
                  false,
                  undefined,
                  true,
                ),
              };
        if (block.grain === undefined) {
          return { measures: seriesReading(ctx, block, undefined), ...domain };
        }
        const grain = shownGrain(ctx, block.grain, block.grains);
        return {
          measures: seriesReading(ctx, block, grain),
          ...domain,
          ...(block.grains === undefined ? {} : { grain }),
          ...(block.grains === undefined
            ? {}
            : {
                grains: block.grains.map((g) => {
                  const resolved = resolveGrain(g, ctx.anchors);
                  return { grain: resolved, reading: seriesReading(ctx, block, resolved) };
                }),
              }),
        };
      }
      case "pie":
      case "donut":
        return {
          measures: planReading(
            ctx,
            [block.metric],
            [{ kind: "column", column: block.by }],
            [[0], []],
            "none",
          ),
        };
      case "table": {
        const axes: AxisDimension[] = block.by.map((column) => ({ kind: "column", column }));
        return {
          measures: planReading(ctx, block.metrics, axes, tableGroupingSets(block), "none"),
        };
      }
      case "map": {
        const region = { kind: "region", column: block.region, geo: block.geo } as const;
        return {
          measures: planReading(ctx, [block.value], [region], [[0], []], "none"),
          report: planReading(
            ctx,
            [block.value],
            [
              { kind: "column", column: block.region },
              { ...region, unmatched: "keep" },
            ],
            [[0, 1]],
            "none",
            false,
            undefined,
            false,
            true,
          ),
        };
      }
      case "scatter":
        return {
          measures: planReading(
            ctx,
            shownMetrics(block),
            [{ kind: "column", column: block.by }],
            [[0]],
            "none",
            true,
          ),
        };
      default:
        return { measures: { queries: [], measures: {} } };
    }
  })();

  const all = [
    readings.measures,
    readings.previous,
    readings.sparkline,
    readings.domain,
    readings.report,
    ...(readings.grains ?? []).map((g) => g.reading),
  ].flatMap((r) => (r ? r.queries : []));
  const queries = [...new Map(all.map((q) => [q.id, q])).values()];
  return {
    block: {
      blockId: id,
      pointer,
      queryIds: queries.map((q) => q.id),
      measures: readings.measures.measures,
      ...(readings.previous ? { previous: readings.previous.measures } : {}),
      ...(readings.sparkline ? { sparkline: readings.sparkline.measures } : {}),
      ...(readings.domain ? { domain: readings.domain.measures } : {}),
      ...(readings.report
        ? {
            report: {
              queryIds: readings.report.queries.map((q) => q.id),
              measures: readings.report.measures,
              rows: readings.report.rows ?? [],
            },
          }
        : {}),
      ...(readings.grain ? { grain: readings.grain } : {}),
      ...(readings.grains
        ? {
            grains: readings.grains.map(({ grain, reading }) => ({
              grain,
              queryIds: reading.queries.map((q) => q.id),
              measures: reading.measures,
            })),
          }
        : {}),
    },
    queries,
    diagnostics: [],
  };
}

/**
 * A table's grouping sets: its rows, then with subtotals each prefix of by from the longest (ROLLUP
 * order), then the grand total when the table shows totals or shares. Assembly finds each set by
 * its contents, so the order is the plan's only.
 */
export function tableGroupingSets(block: Block & { type: "table" }): number[][] {
  const leaf = block.by.map((_, i) => i);
  const prefixes =
    block.subtotals === true ? leaf.slice(1).map((_, i) => leaf.slice(0, leaf.length - 1 - i)) : [];
  const total = block.totals !== false || (block.percentOfTotal ?? []).length > 0;
  return [leaf, ...prefixes, ...(total ? [[]] : [])];
}

function shownMetrics(block: Block): string[] {
  if (block.type === "scatter") {
    return [...new Set([block.x, block.y, ...(block.size === undefined ? [] : [block.size])])];
  }
  if (block.type === "map") return [block.value];
  return "metric" in block ? [block.metric] : "metrics" in block ? block.metrics : [];
}

function hasTime(ctx: Context, name: string): boolean {
  const found = leaves(name, ctx.metrics);
  return (
    found.length > 0 &&
    found.every((leaf) => {
      const metric = ctx.metrics.get(leaf);
      return (metric?.type === "aggregate" || metric?.type === "sql") && metric.time !== undefined;
    })
  );
}

function context(
  project: Project,
  dashboard: string,
): { ctx?: Context; diagnostics: Diagnostic[] } {
  const file = project.dashboards.get(dashboard);
  const spec = file?.spec;
  if (file === undefined || spec === undefined) {
    return {
      diagnostics: [
        {
          code: "HM1001",
          severity: "error",
          message:
            file === undefined
              ? `no dashboard "${dashboard}" in this project`
              : `dashboard "${dashboard}" has errors; run hatchmark check`,
          ...(file === undefined ? {} : { file: file.file }),
          docs: docsCommand("HM1001"),
        },
      ],
    };
  }
  const metrics = new Map<string, Metric>();
  for (const [name, metric] of project.metrics) {
    if (metric.spec) metrics.set(name, withSegmentFilters(metric.spec, project));
  }
  const period = spec.period ?? DEFAULT_PERIOD;
  return {
    ctx: {
      file,
      spec,
      metrics,
      sources: project.config.spec?.sources ?? {},
      params: resolveParams(project, dashboard),
      range: period.range,
      compare: period.compare,
      anchors: projectAnchors(project.config.spec),
      columnTypes: project.columnTypes,
    },
    diagnostics: [],
  };
}

/**
 * A metric with the filters of its segments appended to its own, so a segment filters the rows
 * exactly like the metric's filters do (RFC 0001 section 8).
 */
function withSegmentFilters(metric: Metric, project: Project): Metric {
  if ((metric.type !== "aggregate" && metric.type !== "sql") || metric.segments === undefined) {
    return metric;
  }
  const { segments, ...rest } = metric;
  const filters = [
    ...(metric.filters ?? []),
    ...segments.flatMap((s) => project.segments.get(s)?.spec?.filters ?? []),
  ];
  return { ...rest, ...(filters.length > 0 ? { filters } : {}) };
}

/**
 * Plans every block of a dashboard. Pure and deterministic: the same project gives the same plan,
 * byte for byte. Blocks of types not built yet are left out with an HM4002 warning.
 */
export function planDashboard(project: Project, dashboard: string): PlanResult<QueryPlan> {
  const { ctx, diagnostics } = context(project, dashboard);
  if (ctx === undefined) return { diagnostics };
  const period = ctx.spec.period ?? DEFAULT_PERIOD;
  const config = project.config.spec;
  const blocks: BlockPlan[] = [];
  const queries = new Map<string, PlannedQuery>();
  ctx.spec.blocks.forEach((block, index) => {
    const planned = planBlockAt(ctx, block, index);
    diagnostics.push(...planned.diagnostics);
    if (planned.block) blocks.push(planned.block);
    for (const query of planned.queries) if (!queries.has(query.id)) queries.set(query.id, query);
  });
  return {
    plan: {
      version: PLAN_VERSION,
      dashboard,
      period: { asOf: period.asOf, range: period.range, compare: period.compare },
      timezone: config?.timezone ?? "UTC",
      anchors: ctx.anchors,
      params: ctx.params,
      horizons: planHorizons([...queries.values()], config?.sources ?? {}),
      blocks,
      queries: [...queries.values()],
      materialization: {},
    },
    diagnostics,
  };
}

/** Plans one block; its queries carry the same ids as in planDashboard's plan. */
export function planBlock(
  project: Project,
  dashboard: string,
  id: string,
): PlanResult<{ block: BlockPlan; queries: PlannedQuery[] }> {
  const { ctx, diagnostics } = context(project, dashboard);
  if (ctx === undefined) return { diagnostics };
  const index = ctx.spec.blocks.findIndex((block, i) => blockId(block, i) === id);
  const block = ctx.spec.blocks[index];
  if (block === undefined) {
    return {
      diagnostics: [
        {
          code: "HM1001",
          severity: "error",
          message: `no block "${id}" in dashboard "${dashboard}"`,
          file: ctx.file.file,
          docs: docsCommand("HM1001"),
        },
      ],
    };
  }
  const planned = planBlockAt(ctx, block, index);
  return {
    ...(planned.block ? { plan: { block: planned.block, queries: planned.queries } } : {}),
    diagnostics: planned.diagnostics,
  };
}

/** The pure planner, as the Compiler interface. */
export const planner: Compiler = { planDashboard, planBlock };
