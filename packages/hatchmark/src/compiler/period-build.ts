import type { Diagnostic } from "../diagnostics/index.js";
import type { Project, RangeSpec } from "../spec/index.js";
import { textComparer } from "./assemble.js";
import type { DashboardData } from "./dashboard-data.js";
import {
  type CustomRangeData,
  type DayCube,
  dayNumber,
  dayText,
  type Key,
  PERIOD_DATA_VERSION,
  type PeriodData,
  type PortableMetric,
  snapshotCubeable,
} from "./period-data.js";
import { rangeKey } from "./periods.js";
import type {
  MeasureComponent,
  MeasureExpression,
  ParamBindings,
  PlannedDimension,
  PlannedQuery,
  QueryPlan,
  QueryResult,
  SnapshotEvaluation,
} from "./plan.js";
import { planDashboard, queryId } from "./planner.js";
import {
  type DashboardExecutor,
  dataFailure,
  executionContext,
  pointMetrics,
  runDashboardBindings,
} from "./run.js";
import { nextDay, queryBounds } from "./windows.js";

/**
 * The day-grain query a custom range reads instead of a planned query: the same source, measures,
 * select filters, column and region dimensions, with every time dimension replaced by one day dimension on
 * the window column and the window opened to all time. Undefined when no period filter windows the
 * query.
 */
export function dayCubeQuery(query: PlannedQuery): PlannedQuery | undefined {
  const column = query.window.column;
  if (column === undefined || !query.params.some((p) => p.kind === "period")) return undefined;
  if (query.evaluation !== undefined) return snapshotCubeQuery(query, query.evaluation);
  const sets = query.measures.flatMap((m) => m.components.flatMap((c) => c.anyOf ?? []));
  const split = new Set(sets.map((s) => s.time)).size > 1;
  if (split && sets.some((s) => s.time === undefined)) return undefined;
  const days: PlannedDimension[] = !split
    ? [{ kind: "time", column, grain: { unit: "day" } }]
    : sets.map((s) => ({
        kind: "time",
        column: s.time as string,
        grain: { unit: "day" },
        filters: s.filters,
      }));
  const columns = query.dimensions.filter((d) => d.kind !== "time");
  const shape: Omit<PlannedQuery, "id"> = {
    source: query.source,
    input: query.input,
    ...(query.tables === undefined ? {} : { tables: query.tables }),
    measures: query.measures,
    dimensions: [...days, ...columns],
    groupingSets: [[...days.keys(), ...columns.map((_, i) => i + days.length)]],
    window: {
      range: "all_time",
      shift: "none",
      column,
      ...(query.window.horizons ? { horizons: query.window.horizons } : {}),
    },
    params: query.params.filter((p) => p.kind !== "period"),
  };
  return { id: queryId(shape), ...shape };
}

function snapshotCubeQuery(query: PlannedQuery, evaluation: SnapshotEvaluation): PlannedQuery {
  const { column } = evaluation;
  const columns = query.dimensions.filter((d) => d.kind !== "time");
  const lead: PlannedDimension[] = [
    { kind: "time", column, grain: { unit: "day" } },
    { kind: "snapshot", column },
  ];
  const all = [...lead, ...columns].map((_, i) => i);
  const shape: Omit<PlannedQuery, "id"> = {
    source: query.source,
    input: query.input,
    ...(query.tables === undefined ? {} : { tables: query.tables }),
    measures: query.measures,
    dimensions: [...lead, ...columns],
    groupingSets: columns.length > 0 ? [all, [0, 1]] : [all],
    window: {
      range: "all_time",
      shift: "none",
      column,
      ...(query.window.horizons ? { horizons: query.window.horizons } : {}),
    },
    params: query.params.filter((p) => p.kind !== "period"),
    evaluation: { ...evaluation, pick: "last" },
  };
  return { id: queryId(shape), ...shape };
}

function snapshotCubeFrom(
  query: PlannedQuery,
  result: QueryResult,
  start: number,
  last: number,
): DayCube {
  const components = query.measures.flatMap((m) => m.components.map((c) => c.id));
  const at = new Map(result.columns.map((c, i) => [c.name, i]));
  const width = query.dimensions.length;
  const cube: DayCube = {
    columns: query.dimensions.slice(2).map((d) => d.column),
    days: [],
    instants: [],
    keys: query.dimensions.slice(2).map(() => []),
    values: Object.fromEntries(components.map((id) => [id, []])),
    snapshots: { days: [], instants: [] },
  };
  const markers = query.groupingSets.length - 1;
  result.rows.forEach((row, r) => {
    if (typeof row[0] !== "string" || dayNumber(row[0]) > last) return;
    const day = dayNumber(row[0]) - start;
    const instant = String(row[1]);
    const set = result.groupingSet?.[r] ?? 0;
    if (set === markers) {
      cube.snapshots?.days.push(day);
      cube.snapshots?.instants.push(instant);
    }
    if (set !== 0) return;
    cube.days.push(day);
    cube.instants?.push(instant);
    for (let i = 2; i < width; i++) cube.keys[i - 2]?.push(toKey(row[i]));
    for (const id of components) {
      const raw = row[at.get(id) ?? -1];
      cube.values[id]?.push(typeof raw === "number" ? raw : null);
    }
  });
  return cube;
}

function cubeFrom(query: PlannedQuery, result: QueryResult, start: number, last: number): DayCube {
  if (query.evaluation !== undefined) return snapshotCubeFrom(query, result, start, last);
  const components = query.measures.flatMap((m) => m.components.map((c) => c.id));
  const at = new Map(result.columns.map((c, i) => [c.name, i]));
  const width = query.dimensions.length;
  const lead = query.dimensions.filter((d) => d.kind === "time").length;
  const cube: DayCube = {
    columns: query.dimensions.slice(lead).map((d) => d.column),
    days: [],
    ...(lead > 1 ? { sets: Array.from({ length: lead }, () => []) } : {}),
    keys: query.dimensions.slice(lead).map(() => []),
    values: Object.fromEntries(components.map((id) => [id, []])),
  };
  for (const row of result.rows) {
    const days = row
      .slice(0, lead)
      .map((v) => (typeof v === "string" && dayNumber(v) <= last ? dayNumber(v) - start : null));
    const present = days.filter((d): d is number => d !== null);
    if (present.length === 0) continue;
    cube.days.push(Math.min(...present));
    for (const [s, d] of days.entries()) cube.sets?.[s]?.push(d);
    for (let i = lead; i < width; i++) cube.keys[i - lead]?.push(toKey(row[i]));
    for (const id of components) {
      const raw = row[at.get(id) ?? -1];
      cube.values[id]?.push(typeof raw === "number" ? raw : null);
    }
  }
  return cube;
}

function expressionQueries(e: MeasureExpression): string[] {
  return e.op === "ref"
    ? [e.queryId]
    : [...expressionQueries(e.numerator), ...expressionQueries(e.denominator)];
}

function keysOnly(query: PlannedQuery, result: QueryResult): QueryResult {
  const dims = query.dimensions.length;
  return {
    columns: result.columns,
    rows: result.rows.map((row) => row.map((value, i) => (i < dims ? value : null))),
    ...(result.groupingSet ? { groupingSet: result.groupingSet } : {}),
  };
}

function toKey(value: unknown): Key {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? value
    : null;
}

function presetOnlyMetrics(plan: QueryPlan): string[] {
  const names = new Set<string>();
  for (const query of plan.queries) {
    if (dayCubeQuery(query) === undefined) continue;
    for (const measure of query.measures) {
      const cubeable = (c: MeasureComponent) =>
        query.evaluation === undefined ? c.reaggregate !== "none" : snapshotCubeable(c);
      if (!measure.components.every(cubeable)) names.add(measure.metric);
    }
  }
  return [...names].sort();
}

function portablePlan(plan: QueryPlan): QueryPlan {
  return {
    ...plan,
    queries: plan.queries.map((q) => ({
      ...q,
      measures: q.measures.map((m) => ({
        ...m,
        components: m.components.map(
          ({ sql: _, anyOf: __, ...c }): MeasureComponent => ({ ...c, filters: [] }),
        ),
      })),
    })),
  };
}

/**
 * Runs everything a page's period filter needs (see PeriodData): each preset, and the day cubes
 * when the filter offers custom ranges. base is the page's own data, reused for the default preset.
 * Undefined data when the dashboard has no period filter. Errors are HM2015, as in runDashboard;
 * warnings of non-default presets are left out, since the page shows the default first. bindings
 * are the other filters' values (a segment filter's), applied to every preset and to the day cubes;
 * base must have been run with them. spanStart fixes the first day of the custom-range span instead
 * of the first day with rows, so every segment combination offers the same span.
 */
export async function runPeriodData(
  project: Project,
  dashboard: string,
  executor: DashboardExecutor,
  base: DashboardData,
  now?: Date,
  bindings: ParamBindings = {},
  spanStart?: string,
): Promise<{ data?: PeriodData; diagnostics: Diagnostic[] }> {
  const spec = project.dashboards.get(dashboard)?.spec;
  const filter = spec?.filters?.find((f) => f.type === "period");
  const config = project.config.spec;
  if (spec === undefined || filter === undefined || config === undefined)
    return { diagnostics: [] };
  const diagnostics: Diagnostic[] = [];
  const pending = new Map<string, RangeSpec>();
  for (const option of filter.options) {
    const key = rangeKey(option);
    if (key !== base.periodFilter?.selected && !pending.has(key)) pending.set(key, option);
  }
  const presetRuns =
    pending.size === 0
      ? []
      : await runDashboardBindings(
          project,
          dashboard,
          executor,
          [...pending.values()].map((option) => ({ ...bindings, [filter.id]: option })),
          now,
        );
  const ran = new Map([...pending.keys()].map((key, i) => [key, presetRuns[i]]));
  const presets: Record<string, DashboardData> = {};
  for (const option of filter.options) {
    const key = rangeKey(option);
    if (key in presets) continue;
    if (key === base.periodFilter?.selected) {
      presets[key] = base;
      continue;
    }
    const run = ran.get(key);
    if (run === undefined) continue;
    diagnostics.push(...run.diagnostics.filter((d) => d.severity === "error"));
    if (run.data) presets[key] = run.data;
  }
  if (diagnostics.length > 0) return { diagnostics };
  const data: PeriodData = { version: PERIOD_DATA_VERSION, filter: filter.id, presets };
  if (filter.custom === false) return { data, diagnostics };

  const { plan } = planDashboard(project, dashboard);
  if (plan === undefined) return { data, diagnostics };
  const resolved = await executionContext(project, plan, executor, now);
  const context = resolved.context && { ...resolved.context, bindings };
  if (context === undefined) return { data, diagnostics };
  const last = dayNumber(context.asOf);
  const queries: CustomRangeData["queries"] = {};
  const runs = new Map<string, { query: PlannedQuery; result: QueryResult }>();
  const shown = new Set(
    plan.blocks.flatMap((b) =>
      [b.measures, b.previous, b.sparkline, ...(b.grains ?? []).map((g) => g.measures)].flatMap(
        (m) => Object.values(m ?? {}).flatMap(expressionQueries),
      ),
    ),
  );
  const domains = new Set(
    plan.blocks
      .flatMap((b) => Object.values(b.domain ?? {}).flatMap(expressionQueries))
      .filter((id) => !shown.has(id)),
  );
  try {
    for (const query of plan.queries) {
      const cubeQuery = dayCubeQuery(query);
      if (cubeQuery === undefined) {
        if (queryBounds(query, context) !== undefined) {
          const result = await executor.execute(query, context);
          queries[query.id] = { result: domains.has(query.id) ? keysOnly(query, result) : result };
        }
        continue;
      }
      queries[query.id] = { cube: cubeQuery.id };
      if (!runs.has(cubeQuery.id)) {
        runs.set(cubeQuery.id, {
          query: cubeQuery,
          result: await executor.execute(cubeQuery, context),
        });
      }
    }
  } catch (error) {
    return { diagnostics: [dataFailure("day-grain query for custom ranges failed: ", error)] };
  }
  let first = spanStart === undefined ? last + 1 : dayNumber(spanStart);
  for (const { result } of spanStart === undefined ? runs.values() : []) {
    for (const row of result.rows) {
      if (typeof row[0] === "string") first = Math.min(first, dayNumber(row[0]));
    }
  }
  const cubes: Record<string, DayCube> = {};
  for (const [id, { query, result }] of [...runs].sort(([a], [b]) => (a < b ? -1 : 1))) {
    cubes[id] = cubeFrom(query, result, first, last);
  }
  if (first > last) return { data, diagnostics };
  const metrics: Record<string, PortableMetric> = {};
  const points = pointMetrics(project);
  for (const [name, file] of [...project.metrics].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const m = file.spec;
    if (m === undefined || !(name in base.metrics || referenced(plan, name))) continue;
    metrics[name] = {
      type: m.type,
      label: m.label,
      ...(m.description === undefined ? {} : { description: m.description }),
      format: m.format,
      better: m.better,
      ...(m.type === "sql" ? { additive: m.additive === true } : {}),
      ...(m.type === "ratio" ? { numerator: m.numerator, denominator: m.denominator } : {}),
      ...(points.has(name) ? { nature: "point" as const } : {}),
    };
  }
  data.custom = {
    span: { start: dayText(first), end: nextDay(context.asOf) },
    dashboard: spec,
    metrics,
    project: { name: config.name, locale: config.locale, currency: config.currency },
    plan: portablePlan(plan),
    context,
    queries,
    cubes,
    presetOnly: presetOnlyMetrics(plan),
    textOrder: textOrder(config.locale, cubes, queries),
  };
  return { data, diagnostics };
}

function textOrder(
  locale: string,
  cubes: Record<string, DayCube>,
  queries: CustomRangeData["queries"],
): string[] {
  const texts = new Set<string>();
  const add = (values: readonly unknown[]) => {
    for (const v of values) if (typeof v === "string") texts.add(v);
  };
  for (const cube of Object.values(cubes)) for (const keys of cube.keys) add(keys);
  for (const source of Object.values(queries)) {
    if ("result" in source) for (const row of source.result.rows) add(row);
  }
  const compare = textComparer(locale);
  return [...texts].sort((a, b) => compare(a, b) || (a < b ? -1 : 1));
}

function referenced(plan: QueryPlan, name: string): boolean {
  return plan.queries.some((q) => q.measures.some((m) => m.metric === name));
}
