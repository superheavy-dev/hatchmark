import { dashboardDependencies, type Metric, type Project } from "../spec/index.js";
import type { PlannedParam, PlanParam } from "./plan.js";

/**
 * Resolves a dashboard's filters into self-contained plan parameters. A select filter binds to
 * every source the dashboard reads whose columns include it, or whose columns are unknown (check
 * reports multi-source blocks it cannot confirm, HM2013). A period filter windows every time
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
    if (metric === undefined || metric.type === "ratio" || metric.time === undefined) continue;
    const list = timeColumns[metric.table] ?? [];
    if (!list.includes(metric.time)) list.push(metric.time);
    timeColumns[metric.table] = list.sort();
  }
  return (spec.filters ?? []).map((filter): PlanParam => {
    if (filter.type === "period") {
      return {
        id: filter.id,
        kind: "period",
        options: filter.options,
        default: filter.default,
        columns: timeColumns,
      };
    }
    const fallback = filter.default;
    return {
      id: filter.id,
      kind: "select",
      column: filter.column,
      operator: "in",
      multiple: filter.multiple === true,
      default: fallback === undefined ? [] : Array.isArray(fallback) ? fallback : [fallback],
      sources: sources.filter((s) => project.columns.get(s)?.includes(filter.column) !== false),
    };
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
    if (timeColumn === undefined || param.columns[source]?.includes(timeColumn) !== true) return [];
    return [{ id: param.id, kind: "period", source, column: timeColumn, default: param.default }];
  });
}
