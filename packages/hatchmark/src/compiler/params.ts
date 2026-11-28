import { dashboardDependencies, hasColumn, type Metric, type Project } from "../spec/index.js";
import type { ParamBindings, PlannedParam, PlanParam } from "./plan.js";

/**
 * Resolves a dashboard's filters into self-contained plan parameters. A select filter binds to
 * every source the dashboard reads whose columns include it, or whose columns are unknown (check
 * reports multi-source blocks it cannot confirm, HM2013). Columns match case-insensitively, as DuckDB
 * resolves identifiers. A period filter windows every time
 * column the dashboard's metrics use. Pure and deterministic: sources and columns are sorted.
 */
export function resolveParams(project: Project, dashboard: string): PlanParam[] {
  const spec = project.dashboards.get(dashboard)?.spec;
  if (spec === undefined) return [];
  const deps = dashboardDependencies(project, dashboard);
  const sources = [...deps.sources]
    .filter((s) => Object.hasOwn(project.config.spec?.sources ?? {}, s))
    .sort();
  const timeColumns: Record<string, string[]> = {};
  for (const name of [...deps.metrics].sort()) {
    const metric: Metric | undefined = project.metrics.get(name)?.spec;
    if (metric === undefined || (metric.type !== "aggregate" && metric.type !== "sql")) continue;
    if (metric.time === undefined) continue;
    const list = timeColumns[metric.table] ?? [];
    if (!list.includes(metric.time)) list.push(metric.time);
    timeColumns[metric.table] = list.sort();
  }
  return (spec.filters ?? []).flatMap((filter): PlanParam[] => {
    if (filter.type === "grain") return [];
    if (filter.type === "period") {
      return [
        {
          id: filter.id,
          kind: "period",
          options: filter.options,
          default: filter.default,
          columns: timeColumns,
        },
      ];
    }
    if (filter.type === "segment") {
      return [
        {
          id: filter.id,
          kind: "segment",
          label: filter.label ?? "Segments",
          segments: filter.segments.map((name) => {
            const segment = project.segments.get(name)?.spec;
            const filters = segment?.filters ?? [];
            const bound = sources.filter((s) =>
              filters.every((f) => hasColumn(project.columns.get(s), f.column) !== false),
            );
            return { name, label: segment?.label ?? name, filters, sources: bound };
          }),
          default: filter.default ?? [],
        },
      ];
    }
    const fallback = filter.default;
    return [
      {
        id: filter.id,
        kind: "select",
        column: filter.column,
        operator: "in",
        multiple: filter.multiple === true,
        default: fallback === undefined ? [] : Array.isArray(fallback) ? fallback : [fallback],
        sources: sources.filter((s) => hasColumn(project.columns.get(s), filter.column) !== false),
      },
    ];
  });
}

/**
 * The dashboard filters one query applies, in dashboard order, each with its column and default:
 * select filters bound to the query's source, and period filters that window its time column.
 */
export function paramsForQuery(
  params: PlanParam[],
  source: string,
  timeColumn: string | undefined,
): PlannedParam[] {
  return params.flatMap((param): PlannedParam[] => {
    if (param.kind === "select") {
      if (!param.sources.includes(source)) return [];
      const { id, kind, column, operator, multiple } = param;
      return [{ id, kind, source, column, operator, multiple, default: param.default }];
    }
    if (param.kind === "segment") {
      const segments = param.segments
        .filter((s) => s.sources.includes(source))
        .map(({ name, filters }) => ({ name, filters }));
      if (segments.length === 0) return [];
      return [{ id: param.id, kind: "segment", source, segments, default: param.default }];
    }
    if (timeColumn === undefined || param.columns[source]?.includes(timeColumn) !== true) return [];
    return [{ id: param.id, kind: "period", source, column: timeColumn, default: param.default }];
  });
}

/**
 * The values a select filter keeps rows for in one execution: the bound value or values, else the
 * default. Empty means no filter (every row), whether bound as [] or defaulted. Throws when the
 * binding is not a scalar or an array of scalars, or binds several values to a single select.
 */
export function selectValues(
  param: PlannedParam & { kind: "select" },
  bindings: ParamBindings,
): (string | number | boolean)[] {
  const bound = bindings[param.id];
  if (bound === undefined) return param.default;
  const values = Array.isArray(bound) ? bound : [bound];
  const scalar = (v: unknown): v is string | number | boolean =>
    typeof v === "string" ||
    typeof v === "boolean" ||
    (typeof v === "number" && Number.isFinite(v));
  if (!values.every(scalar)) {
    throw new TypeError(
      `select filter "${param.id}" is bound to ${JSON.stringify(bound)}, not scalar values`,
    );
  }
  if (!param.multiple && values.length > 1) {
    throw new TypeError(
      `select filter "${param.id}" takes one value, but ${values.length} are bound`,
    );
  }
  return values;
}

/**
 * The segments a segment filter turns on in one execution: the bound names, else the default.
 * Throws when the binding is not an array of the filter's segment names.
 */
export function segmentValues(
  param: { id: string; default: string[]; segments: { name: string }[] },
  bindings: ParamBindings,
): string[] {
  const bound = bindings[param.id];
  if (bound === undefined) return param.default;
  const names = new Set(param.segments.map((s) => s.name));
  if (!Array.isArray(bound) || !bound.every((v) => typeof v === "string" && names.has(v))) {
    throw new TypeError(
      `segment filter "${param.id}" is bound to ${JSON.stringify(bound)}, not a list of its segments`,
    );
  }
  return bound;
}
