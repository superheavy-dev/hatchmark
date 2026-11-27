import { type Diagnostic, docsCommand } from "../diagnostics/index.js";
import { type Project, parseSpecFile, blockId as specBlockId } from "../spec/index.js";
import type { ExecutionContext, PlannedQuery } from "./plan.js";
import { planDashboard } from "./planner.js";
import { blockingErrors, type DashboardExecutor, executionContext } from "./run.js";
import type { BuiltSql, SqlValue } from "./sql.js";
import { queryBounds, SUPPORTED_DATES } from "./windows.js";

/** An executor that can also say what SQL it runs for a query (the DuckDB executor). */
export interface SqlExecutor extends DashboardExecutor {
  /** The SQL that execute runs for this query, with its parameters. */
  sql(query: PlannedQuery, context: ExecutionContext): Promise<BuiltSql>;
}

/** One query as the executor runs it: SQL with $name parameters, and their values. */
export interface ExplainedQuery {
  id: string;
  source: string;
  sql: string;
  params: Record<string, SqlValue>;
}

export interface ExplainedBlock {
  blockId: string;
  queries: ExplainedQuery[];
}

function failure(code: "HM1001" | "HM2015", message: string, file?: string): Diagnostic {
  return {
    code,
    severity: "error",
    message,
    ...(file !== undefined ? { file } : {}),
    docs: docsCommand(code),
  };
}

/**
 * The queries of a dashboard's blocks (every block, or the one named), exactly as build runs them:
 * filter defaults bound and latest_data resolved. Comparisons that have no window are left out,
 * as build skips them. Errors that keep the dashboard from building are returned instead. A block
 * the planner leaves out (HM4002, HM4023) has no queries; its warnings are in diagnostics, and when
 * it is the block asked for, blocks is undefined.
 */
export async function explainDashboard(
  project: Project,
  dashboard: string,
  executor: SqlExecutor,
  blockId?: string,
  now?: Date,
): Promise<{ blocks?: ExplainedBlock[]; asOf?: string; diagnostics: Diagnostic[] }> {
  const errors = blockingErrors(project, dashboard);
  if (errors.length > 0) return { diagnostics: errors };
  const { plan, diagnostics } = planDashboard(project, dashboard);
  if (plan === undefined) return { diagnostics };
  const blocks = plan.blocks.filter((b) => blockId === undefined || b.blockId === blockId);
  const spec = project.dashboards.get(dashboard)?.spec;
  const index = spec?.blocks.findIndex((b, i) => specBlockId(b, i) === blockId) ?? -1;
  if (blockId !== undefined && blocks.length === 0 && index >= 0) {
    const pointer = `/blocks/${index}`;
    return { diagnostics: diagnostics.filter((d) => d.pointer === pointer) };
  }
  if (blockId !== undefined && blocks.length === 0) {
    return {
      diagnostics: [
        failure(
          "HM1001",
          `no block "${blockId}" in dashboard "${dashboard}"; its blocks are ${plan.blocks.map((b) => `"${b.blockId}"`).join(", ")}`,
          project.dashboards.get(dashboard)?.file,
        ),
      ],
    };
  }
  const resolved = await executionContext(project, plan, executor, now);
  diagnostics.push(...resolved.diagnostics);
  const { context } = resolved;
  if (context === undefined) return { diagnostics };
  const queries = new Map(plan.queries.map((q) => [q.id, q]));
  const explained: ExplainedBlock[] = [];
  try {
    for (const block of blocks) {
      const out: ExplainedQuery[] = [];
      for (const id of block.queryIds) {
        const query = queries.get(id);
        if (query === undefined || queryBounds(query, context) === undefined) continue;
        const { text, params } = await executor.sql(query, context);
        out.push({ id, source: query.source, sql: text, params });
      }
      explained.push({ blockId: block.blockId, queries: out });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { diagnostics: [...diagnostics, failure("HM2015", message)] };
  }
  return { blocks: explained, asOf: context.asOf, diagnostics };
}

const CANONICAL = "explain";

/**
 * The queries of one metric's canonical reading: no dashboard filters, the metric's own filters
 * and segments, by month over last_12_months as of latest_data. A metric without a time column is
 * read once over all rows, as a KPI, and has no asOf. The metric must exist in the project.
 */
export async function explainMetric(
  project: Project,
  metric: string,
  executor: SqlExecutor,
  now?: Date,
): Promise<{ queries?: ExplainedQuery[]; asOf?: string; diagnostics: Diagnostic[] }> {
  const file = `dashboards/${CANONICAL}.yaml`;
  const withBlock = (block: Record<string, unknown>, period: Record<string, unknown>): Project => {
    const spec = { title: metric, period, blocks: [{ id: "metric", ...block }] };
    const parsed = parseSpecFile("dashboard", file, JSON.stringify(spec));
    return { ...project, dashboards: new Map([[CANONICAL, parsed]]) };
  };
  let canonical = withBlock(
    { type: "line", metrics: [metric], grain: "month" },
    { asOf: "latest_data", range: "last_12_months", compare: "none" },
  );
  const timeless = blockingErrors(canonical, CANONICAL).some((d) => d.file === file);
  if (timeless) {
    canonical = withBlock(
      { type: "kpi", metric },
      { asOf: SUPPORTED_DATES.last, range: "all_time", compare: "none" },
    );
  }
  const { blocks, asOf, diagnostics } = await explainDashboard(
    canonical,
    CANONICAL,
    executor,
    "metric",
    now,
  );
  const queries = blocks?.[0]?.queries;
  return {
    ...(queries !== undefined ? { queries } : {}),
    ...(asOf !== undefined && !timeless ? { asOf } : {}),
    diagnostics: diagnostics.map((d) => {
      if (d.file !== file) return d;
      const { file: _, pointer, range, frame, fix, ...rest } = d;
      return rest;
    }),
  };
}
