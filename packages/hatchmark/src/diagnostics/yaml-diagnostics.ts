import { type DiagnosticCode, docsCommand } from "./codes.js";
import type { Diagnostic } from "./diagnostic.js";
import { SpecDocument, type SpecSyntaxErrorKind } from "./yaml.js";

const CODE: Readonly<Record<SpecSyntaxErrorKind, DiagnosticCode>> = {
  syntax: "HM1002",
  "duplicate-key": "HM1003",
  unsupported: "HM1006",
};

/**
 * Parses a YAML spec file and turns syntax errors, duplicate keys and YAML features spec files do
 * not allow into diagnostics. The document is returned even when it has errors, so callers can
 * still resolve positions for later checks.
 */
export function parseYamlFile(
  file: string,
  text: string,
): { document: SpecDocument; diagnostics: Diagnostic[] } {
  const document = new SpecDocument(file, text);
  const diagnostics = document.errors.map((error): Diagnostic => {
    const code = CODE[error.kind];
    const location = document.location(error.start, error.end);
    return {
      code,
      severity: "error",
      message: error.message,
      file,
      ...location,
      ...(error.related === undefined
        ? {}
        : {
            label: "repeated here",
            help: `the first one is at line ${document.positionAt(error.related).line}; keep one of them`,
          }),
      ...(error.help === undefined ? {} : { help: error.help }),
      ...(error.fix === undefined
        ? {}
        : {
            fix: {
              range: document.rangeAt(error.start, error.end),
              text: error.fix.text,
              applicability: "safe" as const,
              description: error.fix.description,
            },
          }),
      docs: docsCommand(code),
    };
  });
  return { document, diagnostics };
}
