import { CODES, isDiagnosticCode } from "../../diagnostics/index.js";
import type { CommandHelp } from "../help.js";
import { type CommandContext, type CommandResult, EXIT } from "../io.js";
import { usageError } from "../usage.js";

export const explainHelp: CommandHelp = {
  name: "explain",
  summary: "Explain a diagnostic code and how to fix it.",
  usage: "hatchmark explain <code>",
  options: [{ flag: "<code>", description: "A code such as HM2003, from check output." }],
  example: { command: "hatchmark explain HM2003", description: 'Explains "unknown metric".' },
};

export function explain(_ctx: CommandContext, positionals: string[]): CommandResult {
  const [input, ...rest] = positionals;
  if (input === undefined) {
    return usageError("HM0003", "missing argument <code>", {
      help: "run hatchmark explain HM2003, for example",
    });
  }
  if (rest.length > 0) return usageError("HM0002", `unexpected argument "${rest[0]}"`);
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
