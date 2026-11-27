import path from "node:path";
import { type ExplainedQuery, explainDashboard, explainDefaults } from "../../compiler/index.js";
import {
  createReport,
  type Diagnostic,
  docsCommand,
  renderHuman,
} from "../../diagnostics/index.js";
import { nodeProjectHost } from "../../node/host.js";
import { createDuckDbExecutor } from "../../node/index.js";
import { CONFIG_FILE, checkReferences, loadProject, parseDiagnostics } from "../../spec/index.js";
import type { CommandHelp } from "../help.js";
import { type CommandContext, type CommandResult, EXIT, type ExitCode } from "../io.js";
import { type CreateSqlExecutor, renderQueries } from "./explain.js";

export const checkHelp: CommandHelp = {
  name: "check",
  summary: "Check the project's files: YAML syntax, spec shape, and references between files.",
  usage: "hatchmark check [paths...] [--strict] [--sql] [--explain-defaults]",
  options: [
    {
      flag: "[paths...]",
      description: "Only report diagnostics for these files or directories, relative to --cwd.",
    },
    { flag: "--strict", description: "Exit 1 on warnings too." },
    {
      flag: "--sql",
      description:
        "Also print the SQL every block runs, as build runs it with the filter defaults (JSON: sql).",
    },
    {
      flag: "--explain-defaults",
      description:
        "Print every HM4040 note on the business-definition defaults the project relies on, instead of one line per file (JSON always lists them all).",
    },
  ],
  example: {
    command: "hatchmark check --json",
    description:
      'Prints {"format_version":"1","ok":true,...}; see docs/diagnostics.md for the format.',
  },
};

const ENVIRONMENT_CODES = new Set(["HM1001", "HM2010"]);

export function exitCodeFor(diagnostics: readonly Diagnostic[], strict: boolean): ExitCode {
  const errors = diagnostics.filter((d) => d.severity === "error");
  if (errors.some((d) => d.file === CONFIG_FILE && !ENVIRONMENT_CODES.has(d.code)))
    return EXIT.usage;
  if (errors.length > 0)
    return errors.every((d) => ENVIRONMENT_CODES.has(d.code)) ? EXIT.environment : EXIT.check;
  if (strict && diagnostics.some((d) => d.severity === "warning")) return EXIT.check;
  return EXIT.ok;
}

export async function check(
  ctx: CommandContext,
  positionals: string[],
  flags: { strict?: boolean; sql?: boolean; explainDefaults?: boolean },
  createExecutor: CreateSqlExecutor = createDuckDbExecutor,
): Promise<CommandResult> {
  const { project, diagnostics: loadDiagnostics } = await loadProject(nodeProjectHost(ctx.root));
  if (project === undefined) {
    const report = createReport(loadDiagnostics);
    return { exitCode: EXIT.usage, json: report, human: renderHuman(report, { color: ctx.color }) };
  }
  const prefixes = positionals.map((p) =>
    path.relative(ctx.root, path.resolve(ctx.root, p)).split(path.sep).join("/"),
  );
  const selected = (file: string | undefined) =>
    prefixes.length === 0 ||
    file === undefined ||
    file === CONFIG_FILE ||
    prefixes.some((p) => p === "" || file === p || file.startsWith(`${p}/`));
  let diagnostics = [...parseDiagnostics(project), ...loadDiagnostics, ...checkReferences(project)];
  if (!diagnostics.some((d) => d.severity === "error"))
    diagnostics.push(...explainDefaults(project));
  diagnostics = diagnostics.filter((d) => selected(d.file));

  const sql: { dashboard: string; block: string; queries: ExplainedQuery[] }[] = [];
  const config = project.config.spec;
  if (
    flags.sql === true &&
    config !== undefined &&
    !diagnostics.some((d) => d.severity === "error")
  ) {
    const executor = await createExecutor({ root: ctx.root, config });
    try {
      for (const [name, file] of [...project.dashboards].sort(([a], [b]) => (a < b ? -1 : 1))) {
        if (!selected(file.file)) continue;
        const explained = await explainDashboard(project, name, executor, undefined, new Date());
        const seen = new Set(diagnostics.map((d) => JSON.stringify(d)));
        diagnostics.push(
          ...explained.diagnostics.filter((d) => selected(d.file) && !seen.has(JSON.stringify(d))),
        );
        const outside = explained.diagnostics.filter(
          (d) => d.severity === "error" && !selected(d.file),
        );
        if (explained.blocks === undefined && outside.length > 0) {
          const files = [...new Set(outside.map((d) => d.file ?? "the project"))].join(", ");
          diagnostics.push({
            code: "HM2015",
            severity: "error",
            message: `cannot print the SQL of dashboard "${name}": errors in ${files} keep it from building`,
            file: file.file,
            help: "run hatchmark check without paths to see them",
            docs: docsCommand("HM2015"),
          });
        }
        for (const block of explained.blocks ?? []) {
          sql.push({ dashboard: name, block: block.blockId, queries: block.queries });
        }
      }
    } finally {
      await executor.close();
    }
  }
  const report = createReport(diagnostics);
  const quietOk = ctx.quiet && report.ok && report.warning_count === 0;
  const printed = sql.map(
    (b) => `-- block "${b.block}" of dashboard "${b.dashboard}"\n${renderQueries(b.queries)}`,
  );
  const human = quietOk
    ? ""
    : renderHuman(report, { color: ctx.color, explainDefaults: flags.explainDefaults === true });
  return {
    exitCode: exitCodeFor(report.diagnostics, flags.strict === true),
    json: flags.sql === true ? { ...report, sql } : report,
    human:
      printed.length > 0 ? `${[...printed, human].filter((s) => s !== "").join("\n\n")}` : human,
  };
}
