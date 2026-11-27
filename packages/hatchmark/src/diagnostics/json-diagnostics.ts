import { docsCommand } from "./codes.js";
import type { Diagnostic } from "./diagnostic.js";
import { JsonDocument } from "./json.js";

/**
 * Parses a spec file and turns syntax errors and duplicate keys into diagnostics. The document is
 * returned even when it has errors, so callers can still resolve positions for later checks.
 */
export function parseJsonFile(
  file: string,
  text: string,
): { document: JsonDocument; diagnostics: Diagnostic[] } {
  const document = new JsonDocument(file, text);
  const diagnostics = document.errors.map((error): Diagnostic => {
    const code = error.kind === "duplicate-key" ? "HM1003" : "HM1002";
    const repair = error.repair;
    const { range, frame } = document.location(error.start, error.end);
    return {
      code,
      severity: "error",
      message: error.message,
      file,
      range,
      frame,
      ...(error.related === undefined
        ? {}
        : {
            label: "repeated here",
            help: `the first one is at line ${document.positionAt(error.related).line}; keep one of them`,
          }),
      docs: docsCommand(code),
      ...(repair
        ? {
            fix: {
              range: document.rangeAt(repair.start, repair.end),
              text: repair.text,
              applicability: "safe",
              description:
                repair.text === ""
                  ? "delete the highlighted text"
                  : `insert ${JSON.stringify(repair.text)}`,
            },
          }
        : {}),
    };
  });
  return { document, diagnostics };
}
