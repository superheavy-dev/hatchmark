import {
  type ExplainedQuery,
  explainDashboard,
  explainMetric,
  printSql,
  type SqlExecutor,
} from "../../compiler/index.js";
import {
  CODES,
  createReport,
  type Diagnostic,
  isDiagnosticCode,
  renderHuman,
} from "../../diagnostics/index.js";
import {
  type CachedExecutor,
  type CacheProbe,
  createCachedExecutor,
  createDuckDbExecutor,
  nodeProjectHost,
} from "../../node/index.js";
import { blockId, loadProject, type Project, type ProjectConfig } from "../../spec/index.js";
import type { CommandHelp } from "../help.js";
import { type CommandContext, type CommandResult, EXIT } from "../io.js";
import { usageError } from "../usage.js";
import { exitCodeFor } from "./check.js";

export const explainHelp: CommandHelp = {
  name: "explain",
  summary:
    "Explain a diagnostic code, or print the SQL a metric or a block runs and whether build would reuse its cached result.",
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

export type CreateSqlExecutor = (options: {
  root: string;
  config: ProjectConfig;
}) => Promise<SqlExecutor & { close(): Promise<void> }>;

export type ExplainedWithCache = ExplainedQuery & { cache?: CacheProbe };

export function renderQueries(queries: ExplainedQuery[]): string {
  return queries
    .map(
      (q) =>
        `-- query ${q.id} on source "${q.source}"\n${printSql({ text: q.sql, params: q.params })};`,
    )
    .join("\n\n");
}

function cacheLine(id: string, cache: CacheProbe): string {
  switch (cache.status) {
    case "hit":
      return `-- ${id}: hit, stored ${cache.stored_at}; build reuses it`;
    case "stale": {
      const what = (cache.changed ?? []).map((c) =>
        c === "data" && cache.changed_files ? `data (${cache.changed_files.join(", ")})` : c,
      );
      return `-- ${id}: stale, ${what.join(", ")} changed since the entry stored ${cache.stored_at}; build recomputes it`;
    }
    case "miss":
      return `-- ${id}: miss; build computes it`;
    case "off":
      return `-- ${id}: cache off${cache.reason ? `, ${cache.reason}` : ""}`;
  }
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
  if (input !== undefined && isDiagnosticCode(input.toUpperCase())) return explainCode(input);

  const { project, diagnostics: loadDiagnostics } = await loadProject(nodeProjectHost(ctx.root));
  if (input !== undefined && /^hm\d+$/i.test(input) && !project?.metrics.has(input)) {
    return explainCode(input);
  }
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
    const blocks = project.dashboards.get(dashboard)?.spec?.blocks.map((b, i) => blockId(b, i));
    if (blocks !== undefined && !blocks.includes(flags.block)) {
      return usageError("HM0002", `unknown block "${flags.block}" in dashboard "${dashboard}"`, {
        expected: blocks,
        input: flags.block,
      });
    }
  }
  const config = project.config.spec;
  const executor = await createCachedExecutor({
    root: ctx.root,
    config,
    createInner: (root) => createExecutor({ root, config }),
    readOnly: true,
  });
  try {
    return input !== undefined
      ? await metricSql(ctx, project, input, executor)
      : await blockSql(ctx, project, dashboard as string, flags.block as string, executor);
  } finally {
    await executor.close();
  }
}

async function queriesResult(
  ctx: CommandContext,
  head: Record<string, unknown>,
  title: string,
  result: { queries?: ExplainedQuery[] | undefined; diagnostics: Diagnostic[] },
  executor: CachedExecutor,
): Promise<CommandResult> {
  const report = createReport(result.diagnostics);
  if (report.error_count > 0) {
    return {
      exitCode: exitCodeFor(report.diagnostics, false),
      json: report,
      human: renderHuman(report, { color: ctx.color }),
    };
  }
  const queries: ExplainedWithCache[] = [];
  for (const query of result.queries ?? []) {
    const cache = await executor.probe(query.id);
    queries.push({ ...query, ...(cache !== undefined ? { cache } : {}) });
  }
  const notes = report.warning_count > 0 ? renderHuman(report, { color: ctx.color }) : "";
  const body = queries.length > 0 ? renderQueries(queries) : "-- no queries";
  const cached = queries.flatMap((q) => (q.cache ? [cacheLine(q.id, q.cache)] : []));
  const cacheSection =
    cached.length > 0 ? `-- build cache (.hatchmark/cache)\n${cached.join("\n")}` : "";
  return {
    exitCode: EXIT.ok,
    json: { format_version: "1", ...head, queries, diagnostics: report.diagnostics },
    human: [`-- ${title}\n\n${body}`, cacheSection, notes].filter((s) => s !== "").join("\n\n"),
  };
}

async function metricSql(
  ctx: CommandContext,
  project: Project,
  metric: string,
  executor: CachedExecutor,
): Promise<CommandResult> {
  const result = await explainMetric(project, metric, executor, new Date());
  const { asOf } = result;
  return queriesResult(
    ctx,
    { metric, ...(asOf !== undefined ? { as_of: asOf } : {}) },
    asOf !== undefined
      ? `${metric} by month over last_12_months as of ${asOf}, with no dashboard filters`
      : `${metric}${result.queries?.length ? " over all rows" : ""}, with no dashboard filters`,
    result,
    executor,
  );
}

async function blockSql(
  ctx: CommandContext,
  project: Project,
  dashboard: string,
  block: string,
  executor: CachedExecutor,
): Promise<CommandResult> {
  const { blocks, asOf, diagnostics } = await explainDashboard(
    project,
    dashboard,
    executor,
    block,
    new Date(),
  );
  return queriesResult(
    ctx,
    { dashboard, block, ...(asOf !== undefined ? { as_of: asOf } : {}) },
    `block "${block}" of dashboard "${dashboard}"${asOf !== undefined ? ` as of ${asOf}` : ""}, with the filter defaults`,
    { queries: blocks?.[0]?.queries, diagnostics },
    executor,
  );
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
