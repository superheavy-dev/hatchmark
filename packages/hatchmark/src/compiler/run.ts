import { type Diagnostic, docsCommand } from "../diagnostics/index.js";
import { checkReferences, type Project, parseDiagnostics } from "../spec/index.js";
import { assemble } from "./assemble.js";
import type { DashboardData } from "./dashboard-data.js";
import type {
  ExecutionContext,
  MeasureExpression,
  QueryExecutor,
  QueryPlan,
  QueryResult,
} from "./plan.js";
import { planDashboard } from "./planner.js";
import { queryBounds } from "./windows.js";

/** A time column a plan reads, by source. */
export interface TimeColumn {
  source: string;
  column: string;
}

/**
 * A QueryExecutor that can also resolve "latest_data": the last date, in the time zone, that any
 * of the columns holds (max over all of them), or undefined when they hold no dates at all.
 */
export interface DashboardExecutor extends QueryExecutor {
  latestDate(columns: TimeColumn[], timezone: string): Promise<string | undefined>;
}

/**
 * Every time column a plan reads, for latest_data: the columns that window its queries, place them
 * on time axes, or that a period filter windows. Sorted, so the same plan asks the same question.
 */
export function planTimeColumns(plan: QueryPlan): TimeColumn[] {
  const seen = new Map<string, TimeColumn>();
  const add = (source: string, column: string | undefined) => {
    if (column !== undefined) seen.set(JSON.stringify([source, column]), { source, column });
  };
  for (const query of plan.queries) {
    add(query.source, query.window.column);
    for (const d of query.dimensions) if (d.kind === "time") add(query.source, d.column);
    for (const p of query.params) if (p.kind === "period") add(p.source, p.column);
  }
  return [...seen.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, c]) => c);
}

function failure(message: string): Diagnostic {
  return { code: "HM2015", severity: "error", message, docs: docsCommand("HM2015") };
}

/** Errors in the project that keep this dashboard from running: all but other dashboards'. */
function blockingErrors(project: Project, dashboard: string): Diagnostic[] {
  const others = new Set(
    [...project.dashboards.values()].filter((d) => d.name !== dashboard).map((d) => d.file),
  );
  return [...parseDiagnostics(project), ...checkReferences(project)].filter(
    (d) => d.severity === "error" && !(d.file !== undefined && others.has(d.file)),
  );
}

/**
 * Plans a dashboard, runs its queries and assembles DashboardData, with the filter defaults bound.
 * The project is checked first: any error in hatchmark.json, a metric, or this dashboard is
 * returned without running anything. "latest_data" resolves once, before any query runs, to the
 * last date in every time column the plan reads, so every window ends on the same day. Queries run
 * one after another in plan order, except comparisons that have no window (a period filter set to
 * all_time), which are skipped so their KPIs show no comparison. A failing query or an empty
 * latest_data is an HM2015 error.
 */
export async function runDashboard(
  project: Project,
  dashboard: string,
  executor: DashboardExecutor,
): Promise<{ data?: DashboardData; diagnostics: Diagnostic[] }> {
  const errors = blockingErrors(project, dashboard);
  if (errors.length > 0) return { diagnostics: errors };
  const { plan, diagnostics } = planDashboard(project, dashboard);
  if (plan === undefined) return { diagnostics };

  const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
  let asOf = plan.period.asOf;
  if (asOf === "latest_data") {
    const columns = planTimeColumns(plan);
    let latest: string | undefined;
    try {
      latest = columns.length === 0 ? undefined : await executor.latestDate(columns, plan.timezone);
    } catch (error) {
      return {
        diagnostics: [...diagnostics, failure(`cannot resolve latest_data: ${message(error)}`)],
      };
    }
    if (latest === undefined) {
      return {
        diagnostics: [
          ...diagnostics,
          failure(
            columns.length === 0
              ? "latest_data needs a time column, but no metric on this dashboard has one; set period.asOf to a date"
              : `latest_data found no dates in ${columns.map((c) => `${c.source}.${c.column}`).join(", ")}`,
          ),
        ],
      };
    }
    asOf = latest;
  }

  const context: ExecutionContext = {
    asOf,
    timezone: plan.timezone,
    weekStart: plan.weekStart,
    bindings: {},
  };
  const results = new Map<string, QueryResult>();
  const imprecise = new Map<string, Diagnostic>();
  for (const query of plan.queries) {
    if (queryBounds(query, context) === undefined) continue;
    try {
      const result = await executor.execute(query, context);
      results.set(query.id, result);
      for (const { column, maxAbs } of result.imprecise ?? []) {
        imprecise.set(JSON.stringify([query.source, column]), {
          code: "HM4004",
          severity: "warning",
          message: `column "${column}" of source "${query.source}" holds values up to ${maxAbs.toExponential(2)}; sums of floating-point values are accurate only within ±1e15`,
          help: "store the values in a smaller unit or as DECIMAL (Parquet), or split very large and very small values into separate columns",
          docs: docsCommand("HM4004"),
        });
      }
    } catch (error) {
      return {
        diagnostics: [
          ...diagnostics,
          failure(`query on source "${query.source}" failed: ${message(error)}`),
        ],
      };
    }
  }
  const assembled = assemble(project, plan, results, context);
  return {
    ...(assembled.data ? { data: assembled.data } : {}),
    diagnostics: [
      ...diagnostics,
      ...imprecise.values(),
      ...largeResults(project, dashboard, plan, results),
      ...assembled.diagnostics,
    ],
  };
}

/** HM4004 for each metric a block shows whose float sum or avg reaches ±1e13 (QueryResult.large). */
function largeResults(
  project: Project,
  dashboard: string,
  plan: QueryPlan,
  results: Map<string, QueryResult>,
): Diagnostic[] {
  const file = project.dashboards.get(dashboard);
  const out: Diagnostic[] = [];
  for (const block of plan.blocks) {
    const found = new Map<string, number>();
    const visit = (expression: MeasureExpression) => {
      if (expression.op === "divide") {
        visit(expression.numerator);
        visit(expression.denominator);
        return;
      }
      for (const { metric, maxAbs } of results.get(expression.queryId)?.large ?? []) {
        if (metric !== expression.metric) continue;
        found.set(metric, Math.max(found.get(metric) ?? 0, maxAbs));
      }
    };
    for (const readings of [block.measures, block.previous, block.sparkline]) {
      for (const expression of Object.values(readings ?? {})) visit(expression);
    }
    for (const [metric, maxAbs] of found) {
      out.push({
        code: "HM4004",
        severity: "warning",
        message: `metric "${metric}" in block "${block.blockId}" reaches ${maxAbs.toExponential(2)}; floating-point results keep 15 significant digits, so from ±1e13 on the cents are lost`,
        ...(file
          ? { file: file.file, pointer: block.pointer, ...file.document.locationOf(block.pointer) }
          : {}),
        help: "store the values in a larger unit (thousands), or as DECIMAL (Parquet) to keep them exact",
        docs: docsCommand("HM4004"),
      });
    }
  }
  return out;
}
