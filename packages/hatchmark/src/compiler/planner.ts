import { type Diagnostic, docsCommand } from "../diagnostics/index.js";
import {
  type Anchors,
  type Block,
  blockId,
  type Comparison,
  type Dashboard,
  DEFAULT_PERIOD,
  type Metric,
  type Project,
  projectAnchors,
  type ResolvedGrain,
  resolveGrain,
  type Source,
  type SpecFile,
} from "../spec/index.js";
import { canonicalJson, sha256Hex } from "./hash.js";
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
export const PLANNED_BLOCK_TYPES = ["kpi", "line", "area", "bar", "table"] as const;

type AxisDimension = { kind: "column"; column: string } | { kind: "time"; grain: ResolvedGrain };

interface Context {
  file: SpecFile<"dashboard">;
  spec: Dashboard;
  metrics: Map<string, Metric>;
  sources: Record<string, Source>;
  params: PlanParam[];
  range: QueryPlan["period"]["range"];
  compare: Comparison;
  anchors: Anchors;
}

/** One reading of some metrics: the same axes, grouping sets and window shift for all of them. */
interface Reading {
  queries: PlannedQuery[];
  measures: Record<string, MeasureExpression>;
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

/** An aggregate or SQL metric as components plus how to combine them (see PlannedMeasure). */
export function plannedMeasure(name: string, metric: Metric): PlannedMeasure | undefined {
  if (metric.type !== "aggregate" && metric.type !== "sql") return undefined;
  if (metric.type === "sql") {
    const id = `${name}__sql`;
    const c = component(id, "sql", metric, { sql: metric.sql }, metric.additive ? "sum" : "none");
    return { metric: name, components: [c], combine: { op: "identity", component: id } };
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
  for (const option of ["snapshot", "freshness", "timezone"] as const) {
    if (source !== undefined && source[option] !== undefined)
      return `the source option "${option}"`;
  }
  if ((metric.segments ?? []).length > 0) return "segments";
  if ((metric.filters ?? []).some((f) => f.op === "in_table" || f.op === "not_in_table")) {
    return "in_table and not_in_table filters";
  }
  if (metric.type === "sql") return undefined;
  if (metric.over_time !== undefined && metric.over_time !== "sum")
    return `"over_time": "${metric.over_time}"`;
  for (const key of ["value", "entity", "active", "trailing", "scale"] as const) {
    if (metric[key] !== undefined) return `"${key}"`;
  }
  return undefined;
}

/** The aggregate and SQL metrics a metric reads, through ratios. */
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

/**
 * Plans a set of metrics read on the same axes. Leaf metrics group into one query per source and
 * time column (the column that windows them and places them on a time axis). A SQL metric with
 * filters gets a query of its own, since its filters cannot attach to one aggregate call and must
 * filter the query's rows. Ratios become MeasureExpressions over those queries.
 */
function planReading(
  ctx: Context,
  names: string[],
  axes: AxisDimension[],
  groupingSets: number[][],
  shift: Comparison,
): Reading {
  const groups = new Map<string, { source: string; time?: string; metrics: string[] }>();
  const queryOf = new Map<string, string>();
  for (const leaf of [...new Set(names.flatMap((n) => leaves(n, ctx.metrics)))].sort()) {
    const metric = ctx.metrics.get(leaf);
    if (metric === undefined || (metric.type !== "aggregate" && metric.type !== "sql")) continue;
    const isolated = metric.type === "sql" && (metric.filters ?? []).length > 0;
    const key = canonicalJson([metric.table, metric.time ?? null, isolated ? leaf : null]);
    const group = groups.get(key) ?? {
      source: metric.table,
      ...(metric.time === undefined ? {} : { time: metric.time }),
      metrics: [],
    };
    group.metrics.push(leaf);
    groups.set(key, group);
    queryOf.set(leaf, key);
  }

  const ids = new Map<string, string>();
  const queries: PlannedQuery[] = [];
  for (const [key, group] of groups) {
    const input = ctx.sources[group.source];
    if (input === undefined || input.type === "lookup") continue;
    const dimensions: PlannedDimension[] = axes.map((axis) =>
      axis.kind === "column" ? axis : { kind: "time", column: group.time ?? "", grain: axis.grain },
    );
    const shape: Omit<PlannedQuery, "id"> = {
      source: group.source,
      input,
      measures: group.metrics.flatMap((m) => {
        const metric = ctx.metrics.get(m);
        const measure = metric && plannedMeasure(m, metric);
        return measure ? [measure] : [];
      }),
      dimensions,
      groupingSets,
      window:
        group.time === undefined
          ? { range: "all_time", shift: "none" }
          : { range: ctx.range, shift, column: group.time },
      params: paramsForQuery(ctx.params, group.source, group.time),
    };
    const id = queryId(shape);
    ids.set(key, id);
    queries.push({ id, ...shape });
  }

  const expression = (name: string): MeasureExpression => {
    const metric = ctx.metrics.get(name);
    if (metric?.type === "ratio") {
      return {
        op: "divide",
        numerator: expression(metric.numerator),
        denominator: expression(metric.denominator),
      };
    }
    return { op: "ref", queryId: ids.get(queryOf.get(name) ?? "") ?? "", metric: name };
  };
  const measures: Record<string, MeasureExpression> = {};
  for (const name of names) measures[name] = expression(name);
  return { queries, measures };
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

  const shown = "metric" in block ? [block.metric] : "metrics" in block ? block.metrics : [];
  for (const name of shown) {
    const feature = notBuiltYet(name, ctx.metrics, ctx.sources);
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

  const readings: { measures: Reading; previous?: Reading; sparkline?: Reading } = (() => {
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
      case "area": {
        const axes: AxisDimension[] = [
          { kind: "time", grain: resolveGrain(block.grain, ctx.anchors) },
        ];
        if (block.split !== undefined) axes.push({ kind: "column", column: block.split });
        const sets = block.split === undefined ? [[0]] : [[0, 1], [1]];
        return { measures: planReading(ctx, block.metrics, axes, sets, "none") };
      }
      case "bar": {
        const axes: AxisDimension[] =
          block.grain !== undefined
            ? [{ kind: "time", grain: resolveGrain(block.grain, ctx.anchors) }]
            : [{ kind: "column", column: block.by ?? "" }];
        if (block.split !== undefined) axes.push({ kind: "column", column: block.split });
        const sets = block.split === undefined ? [[0]] : [[0, 1], [0], [1]];
        return { measures: planReading(ctx, block.metrics, axes, sets, "none") };
      }
      case "table": {
        const axes: AxisDimension[] = block.by.map((column) => ({ kind: "column", column }));
        const leaf = block.by.map((_, i) => i);
        const total = block.totals !== false || (block.percentOfTotal ?? []).length > 0;
        return {
          measures: planReading(ctx, block.metrics, axes, total ? [leaf, []] : [leaf], "none"),
        };
      }
      default:
        return { measures: { queries: [], measures: {} } };
    }
  })();

  const all = [readings.measures, readings.previous, readings.sparkline].flatMap((r) =>
    r ? r.queries : [],
  );
  const queries = [...new Map(all.map((q) => [q.id, q])).values()];
  return {
    block: {
      blockId: id,
      pointer,
      queryIds: queries.map((q) => q.id),
      measures: readings.measures.measures,
      ...(readings.previous ? { previous: readings.previous.measures } : {}),
      ...(readings.sparkline ? { sparkline: readings.sparkline.measures } : {}),
    },
    queries,
    diagnostics: [],
  };
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
  for (const [name, metric] of project.metrics) if (metric.spec) metrics.set(name, metric.spec);
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
    },
    diagnostics: [],
  };
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
