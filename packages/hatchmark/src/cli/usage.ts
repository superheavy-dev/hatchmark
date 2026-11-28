import {
  closestMatch,
  createReport,
  type Diagnostic,
  docsCommand,
  renderHuman,
} from "../diagnostics/index.js";
import { type CommandResult, EXIT } from "./io.js";

export function usageError(
  code: "HM0001" | "HM0002" | "HM0003" | "HM0004" | "HM0005" | "HM0006" | "HM0007",
  message: string,
  extra: { help?: string; expected?: string[]; input?: string } = {},
): CommandResult {
  const match =
    extra.input !== undefined && extra.expected
      ? closestMatch(extra.input, extra.expected)
      : undefined;
  const help = extra.help ?? (match ? `did you mean "${match}"?` : undefined);
  const diagnostic: Diagnostic = {
    code,
    severity: "error",
    message,
    ...(extra.expected ? { expected: extra.expected } : {}),
    ...(help ? { help } : {}),
    docs: docsCommand(code),
  };
  const report = createReport([diagnostic]);
  return { exitCode: EXIT.usage, json: report, human: renderHuman(report) };
}
