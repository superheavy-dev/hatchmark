import { normalizePath } from "./common.js";
import type { Metric } from "./metric.js";
import type { Project } from "./project.js";

export interface DashboardDependencies {
  /** Metrics the dashboard uses, including those reached through ratios. */
  metrics: Set<string>;
  /** Source names those metrics read. */
  sources: Set<string>;
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

/** The sources a metric reads, through ratios; cycle-safe. */
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
  if (metric.type !== "ratio") return out.add(metric.table);
  for (const side of [metric.numerator, metric.denominator]) {
    for (const source of metricSources(project, side, seen)) out.add(source);
  }
  return out;
}

/** What each dashboard depends on, so a dev server knows what to recompile after an edit. */
export function dashboardDependencies(project: Project, dashboard: string): DashboardDependencies {
  const metrics = new Set<string>();
  const sources = new Set<string>();
  const visit = (name: string): void => {
    if (metrics.has(name)) return;
    metrics.add(name);
    const metric: Metric | undefined = project.metrics.get(name)?.spec;
    if (metric === undefined) return;
    if (metric.type === "ratio") {
      visit(metric.numerator);
      visit(metric.denominator);
    } else {
      sources.add(metric.table);
    }
  };
  for (const name of metricRefs(project, dashboard)) visit(name);
  return { metrics, sources };
}

/**
 * Dashboards to recompile after a project-relative file changes: everything for hatchmark.json,
 * the dashboards that use a metric or a data file, or the dashboard itself.
 */
export function dashboardsAffectedBy(project: Project, changed: string): string[] {
  const file = normalizePath(changed);
  const all = [...project.dashboards.keys()].sort();
  if (file === project.config.file) return all;
  for (const [name, spec] of project.dashboards) if (spec.file === file) return [name];
  const metric = [...project.metrics.values()].find((m) => m.file === file)?.name;
  const sources = Object.entries(project.config.spec?.sources ?? {})
    .filter(([, source]) => normalizePath(source.path) === file)
    .map(([name]) => name);
  if (metric === undefined && sources.length === 0) return [];
  return all.filter((name) => {
    const deps = dashboardDependencies(project, name);
    return (
      (metric !== undefined && deps.metrics.has(metric)) || sources.some((s) => deps.sources.has(s))
    );
  });
}
