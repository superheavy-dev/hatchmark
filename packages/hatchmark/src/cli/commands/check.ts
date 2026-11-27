import path from "node:path";
import { createReport, type Diagnostic, renderHuman } from "../../diagnostics/index.js";
import { nodeProjectHost } from "../../node/host.js";
import { CONFIG_FILE, checkReferences, loadProject, parseDiagnostics } from "../../spec/index.js";
import type { CommandHelp } from "../help.js";
import { type CommandContext, type CommandResult, EXIT, type ExitCode } from "../io.js";

export const checkHelp: CommandHelp = {
  name: "check",
  summary: "Check the project's files: JSON syntax, spec shape, and references between files.",
  usage: "hatchmark check [paths...] [--strict]",
  options: [
    {
      flag: "[paths...]",
      description: "Only report diagnostics for these files or directories, relative to --cwd.",
    },
    { flag: "--strict", description: "Exit 1 on warnings too." },
  ],
  example: {
    command: "hatchmark check --json",
    description:
      'Prints {"format_version":"1","ok":true,...}; see docs/diagnostics.md for the format.',
  },
};

/**
 * Errors in hatchmark.json are configuration errors (exit 2); errors that only mean the machine is
 * missing something are environment errors (exit 3); any other error is in the user's files (1).
 */
const ENVIRONMENT_CODES = new Set(["HM1001", "HM2010"]);

function exitCodeFor(diagnostics: readonly Diagnostic[], strict: boolean): ExitCode {
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
  flags: { strict?: boolean },
): Promise<CommandResult> {
  const { project, diagnostics: loadDiagnostics } = await loadProject(nodeProjectHost(ctx.root));
  if (project === undefined) {
    const report = createReport(loadDiagnostics);
    return { exitCode: EXIT.usage, json: report, human: renderHuman(report, { color: ctx.color }) };
  }
  let diagnostics = [...parseDiagnostics(project), ...loadDiagnostics, ...checkReferences(project)];
  if (positionals.length > 0) {
    const prefixes = positionals.map((p) =>
      path.relative(ctx.root, path.resolve(ctx.root, p)).split(path.sep).join("/"),
    );
    diagnostics = diagnostics.filter(
      (d) =>
        d.file === undefined ||
        d.file === CONFIG_FILE ||
        prefixes.some((p) => p === "" || d.file === p || d.file?.startsWith(`${p}/`)),
    );
  }
  const report = createReport(diagnostics);
  const quietOk = ctx.quiet && report.ok && report.warning_count === 0;
  return {
    exitCode: exitCodeFor(report.diagnostics, flags.strict === true),
    json: report,
    human: quietOk ? "" : renderHuman(report, { color: ctx.color }),
  };
}
