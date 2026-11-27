import { normalizePath } from "./common.js";
import type { Source } from "./config.js";
import type { Filter, Metric } from "./metric.js";
import type { Project } from "./project.js";
import { metricDeps } from "./semantics.js";

export interface DashboardDependencies {
  /** Metrics the dashboard uses, including those reached through ratios, formulas and per_entity. */
  metrics: Set<string>;
  /** Source names those metrics read, lookup sources included as themselves. */
  sources: Set<string>;
  /** Segments those metrics apply. */
  segments: Set<string>;
}

function metricRefs(project: Project, name: string): string[] {
  const spec = project.dashboards.get(name)?.spec;
  if (spec === undefined) return [];
  const out: string[] = [];
  for (const block of spec.blocks) {
    if (block.type === "kpi" || block.type === "bar_list") out.push(block.metric);
    else if (block.type === "text") {
      for (const m of block.markdown.matchAll(/\{\{\s*([a-z][a-z0-9_]*)/g))
        if (m[1]) out.push(m[1]);
    } else out.push(...block.metrics);
  }
  return out;
}

/** The sources a metric reads, through ratios, formulas and per_entity; cycle-safe. */
export function metricSources(
  project: Project,
  name: string,
  seen = new Set<string>(),
): Set<string> {
  const out = new Set<string>();
  if (seen.has(name)) return out;
  seen.add(name);
  const metric = project.metrics.get(name)?.spec;
  if (metric === undefined) return out;
  if (metric.type === "aggregate" || metric.type === "sql") return out.add(metric.table);
  for (const dep of metricDeps(metric)) {
    for (const source of metricSources(project, dep, seen)) out.add(source);
  }
  return out;
}

/**
 * Every source a metric reads rows from, through ratios, formulas and per_entity: each table
 * metric's source with its lookup parts, and the tables of its in_table filters and segments.
 */
export function readSources(project: Project, name: string): Set<string> {
  const configured = project.config.spec?.sources ?? {};
  const out = new Set<string>();
  const seen = new Set<string>();
  const visit = (metricName: string): void => {
    if (seen.has(metricName)) return;
    seen.add(metricName);
    const metric = project.metrics.get(metricName)?.spec;
    if (metric === undefined) return;
    if (metric.type === "aggregate" || metric.type === "sql") {
      for (const s of sourceTables(configured, metric.table)) out.add(s);
      const segmentFilters = (metric.segments ?? []).flatMap(
        (s) => project.segments.get(s)?.spec?.filters ?? [],
      );
      for (const table of filterTables([...(metric.filters ?? []), ...segmentFilters])) {
        for (const s of sourceTables(configured, table)) out.add(s);
      }
    }
    for (const dep of metricDeps(metric)) visit(dep);
  };
  visit(name);
  return out;
}

/** Sources a source reads rows from: itself, and a lookup's base and lookup tables. */
export function sourceTables(sources: Record<string, Source>, name: string): string[] {
  const source = sources[name];
  if (source?.type !== "lookup") return [name];
  return [name, source.from, ...source.lookups.map((l) => l.table)];
}

/** Sources a filter list reads besides the one it filters: in_table and not_in_table tables. */
export function filterTables(filters: readonly Filter[]): string[] {
  return filters.flatMap((f) => (f.op === "in_table" || f.op === "not_in_table" ? [f.table] : []));
}

/** What each dashboard depends on, so a dev server knows what to recompile after an edit. */
export function dashboardDependencies(project: Project, dashboard: string): DashboardDependencies {
  const metrics = new Set<string>();
  const sources = new Set<string>();
  const segments = new Set<string>();
  const visit = (name: string): void => {
    if (metrics.has(name)) return;
    metrics.add(name);
    const metric: Metric | undefined = project.metrics.get(name)?.spec;
    if (metric === undefined) return;
    if (metric.type === "aggregate" || metric.type === "sql") {
      sources.add(metric.table);
      for (const s of metric.segments ?? []) segments.add(s);
    }
    for (const dep of metricDeps(metric)) visit(dep);
  };
  for (const name of metricRefs(project, dashboard)) visit(name);
  return { metrics, sources, segments };
}

/**
 * Dashboards to recompile after a project-relative file changes: everything for hatchmark.json,
 * the dashboards that use a metric, a segment or a data file, or the dashboard itself.
 */
export function dashboardsAffectedBy(project: Project, changed: string): string[] {
  const file = normalizePath(changed);
  const all = [...project.dashboards.keys()].sort();
  if (file === project.config.file) return all;
  for (const [name, spec] of project.dashboards) if (spec.file === file) return [name];
  const metric = [...project.metrics.values()].find((m) => m.file === file)?.name;
  const segment = [...project.segments.values()].find((s) => s.file === file)?.name;
  const configured = project.config.spec?.sources ?? {};
  const changedSources = Object.entries(configured)
    .filter(([, source]) => source.type !== "lookup" && normalizePath(source.path) === file)
    .map(([name]) => name);
  if (metric === undefined && segment === undefined && changedSources.length === 0) return [];
  return all.filter((name) => {
    const deps = dashboardDependencies(project, name);
    if (metric !== undefined && deps.metrics.has(metric)) return true;
    if (segment !== undefined && deps.segments.has(segment)) return true;
    const read = new Set<string>();
    for (const source of deps.sources)
      for (const t of sourceTables(configured, source)) read.add(t);
    for (const m of deps.metrics) {
      const spec = project.metrics.get(m)?.spec;
      if (spec?.type === "aggregate" || spec?.type === "sql") {
        for (const t of filterTables(spec.filters ?? [])) read.add(t);
      }
    }
    for (const s of deps.segments) {
      for (const t of filterTables(project.segments.get(s)?.spec?.filters ?? [])) read.add(t);
    }
    return changedSources.some((s) => read.has(s));
  });
}
