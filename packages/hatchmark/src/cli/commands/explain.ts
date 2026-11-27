import {
  type ExplainedQuery,
  explainDashboard,
  explainMetric,
  planDashboard,
  printSql,
  type SqlExecutor,
} from "../../compiler/index.js";
import { CODES, createReport, isDiagnosticCode, renderHuman } from "../../diagnostics/index.js";
import { createDuckDbExecutor, nodeProjectHost } from "../../node/index.js";
import { loadProject, type Project, type ProjectConfig } from "../../spec/index.js";
import type { CommandHelp } from "../help.js";
import { type CommandContext, type CommandResult, EXIT } from "../io.js";
import { usageError } from "../usage.js";
import { exitCodeFor } from "./check.js";

export const explainHelp: CommandHelp = {
  name: "explain",
  summary: "Explain a diagnostic code, or print the SQL a metric or a block runs.",
  usage: "hatchmark explain <code> | <metric> | --dashboard <name> --block <id>",
  options: [
    { flag: "<code>", description: "A code such as HM2003, from check output." },
    {
      flag: "<metric>",
      description:
        "A metric name: prints the SQL build runs for it by month over last_12_months as of latest_data, with no dashboard filters.",
    },
    {
      flag: "--dashboard <name>",
      description: "With --block: print the SQL of that block instead, with the filter defaults.",
    },
    { flag: "--block <id>", description: "A block id, such as revenue_trend or line_2." },
  ],
  example: { command: "hatchmark explain HM2003", description: 'Explains "unknown metric".' },
};

/** The executor explain uses; tests replace it. */
export type CreateSqlExecutor = (options: {
  root: string;
  config: ProjectConfig;
}) => Promise<SqlExecutor & { close(): Promise<void> }>;

/** The queries as SQL to read: a comment naming each query, then its SQL with values inlined. */
export function renderQueries(queries: ExplainedQuery[]): string {
  return queries
    .map(
      (q) =>
        `-- query ${q.id} on source "${q.source}"\n${printSql({ text: q.sql, params: q.params })};`,
    )
    .join("\n\n");
}

export async function explain(
  ctx: CommandContext,
  positionals: string[],
  flags: { dashboard?: string; block?: string },
  createExecutor: CreateSqlExecutor = createDuckDbExecutor,
): Promise<CommandResult> {
  const [input, ...rest] = positionals;
  if (rest.length > 0) return usageError("HM0002", `unexpected argument "${rest[0]}"`);
  const target = flags.dashboard !== undefined || flags.block !== undefined;
  if (target && input !== undefined) {
    return usageError("HM0002", `unexpected argument "${input}" with --dashboard and --block`, {
      help: "run hatchmark explain <metric>, or hatchmark explain --dashboard <name> --block <id>",
    });
  }
  if (target && (flags.dashboard === undefined || flags.block === undefined)) {
    return usageError(
      "HM0003",
      `missing option ${flags.dashboard === undefined ? "--dashboard" : "--block"}`,
      {
        help: "a block is named by both: hatchmark explain --dashboard sales --block revenue_trend",
      },
    );
  }
  if (input === undefined && !target) {
    return usageError("HM0003", "missing argument <code> or <metric>", {
      help: "run hatchmark explain HM2003, or hatchmark explain revenue, for example",
    });
  }
  if (input !== undefined && /^hm\d+$/i.test(input)) return explainCode(input);

  const { project, diagnostics: loadDiagnostics } = await loadProject(nodeProjectHost(ctx.root));
  if (project === undefined || project.config.spec === undefined) {
    const report = createReport(loadDiagnostics);
    return { exitCode: EXIT.usage, json: report, human: renderHuman(report, { color: ctx.color }) };
  }
  if (input !== undefined && !project.metrics.has(input)) {
    return usageError("HM0002", `unknown metric "${input}"`, {
      expected: [...project.metrics.keys()].sort(),
      input,
    });
  }
  const dashboard = flags.dashboard;
  if (dashboard !== undefined && !project.dashboards.has(dashboard)) {
    return usageError("HM0002", `unknown dashboard "${dashboard}"`, {
      expected: [...project.dashboards.keys()].sort(),
      input: dashboard,
    });
  }
  if (dashboard !== undefined && flags.block !== undefined) {
    const blocks = planDashboard(project, dashboard).plan?.blocks.map((b) => b.blockId);
    if (blocks !== undefined && !blocks.includes(flags.block)) {
      return usageError("HM0002", `unknown block "${flags.block}" in dashboard "${dashboard}"`, {
        expected: blocks,
        input: flags.block,
      });
    }
  }
  const executor = await createExecutor({ root: ctx.root, config: project.config.spec });
  try {
    return input !== undefined
      ? await metricSql(ctx, project, input, executor)
      : await blockSql(ctx, project, dashboard as string, flags.block as string, executor);
  } finally {
    await executor.close();
  }
}

function failed(
  ctx: CommandContext,
  diagnostics: Parameters<typeof createReport>[0],
): CommandResult {
  const report = createReport(diagnostics);
  return {
    exitCode: exitCodeFor(report.diagnostics, false),
    json: report,
    human: renderHuman(report, { color: ctx.color }),
  };
}

async function metricSql(
  ctx: CommandContext,
  project: Project,
  metric: string,
  executor: SqlExecutor,
): Promise<CommandResult> {
  const { queries, asOf, diagnostics } = await explainMetric(project, metric, executor);
  if (queries === undefined || diagnostics.some((d) => d.severity === "error")) {
    return failed(ctx, diagnostics);
  }
  return {
    exitCode: EXIT.ok,
    json: { format_version: "1", metric, ...(asOf !== undefined ? { as_of: asOf } : {}), queries },
    human: `-- ${metric} ${asOf !== undefined ? `by month over last_12_months as of ${asOf}` : "over all rows (it has no time column)"}, with no dashboard filters\n\n${renderQueries(queries)}`,
  };
}

async function blockSql(
  ctx: CommandContext,
  project: Project,
  dashboard: string,
  block: string,
  executor: SqlExecutor,
): Promise<CommandResult> {
  const { blocks, asOf, diagnostics } = await explainDashboard(project, dashboard, executor, block);
  const queries = blocks?.[0]?.queries;
  if (queries === undefined || diagnostics.some((d) => d.severity === "error")) {
    return failed(ctx, diagnostics);
  }
  return {
    exitCode: EXIT.ok,
    json: { format_version: "1", dashboard, block, as_of: asOf, queries },
    human: `-- block "${block}" of dashboard "${dashboard}" as of ${asOf}, with the filter defaults\n\n${renderQueries(queries)}`,
  };
}

function explainCode(input: string): CommandResult {
  const code = input.toUpperCase();
  if (!isDiagnosticCode(code)) {
    return usageError("HM0002", `unknown diagnostic code "${input}"`, {
      expected: Object.keys(CODES),
      input: code,
    });
  }
  const { title, explanation } = CODES[code];
  return {
    exitCode: EXIT.ok,
    json: { format_version: "1", code, title, explanation },
    human: `${code}: ${title}\n\n${explanation}\n\nThe diagnostic format is described in node_modules/hatchmark/docs/diagnostics.md.`,
  };
}
