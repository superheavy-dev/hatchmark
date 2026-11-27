/**
 * Every diagnostic code Hatchmark can emit. Codes are stable across releases: a code is never
 * reused for a different problem, and a retired code stays listed with its last meaning.
 *
 * Ranges: HM1xxx files and JSON syntax, HM2xxx references between files and to data,
 * HM3xxx spec shape (schema), HM4xxx data rules, HM5xxx design rules, HM9xxx internal errors.
 */
export const CODES = {
  HM1001: {
    title: "file cannot be read",
    explanation:
      "Hatchmark could not read a file it expected. Check that the path exists inside the project and that the process can read it.",
  },
  HM1002: {
    title: "invalid JSON syntax",
    explanation:
      "Spec files are strict JSON (RFC 8259): double-quoted keys and strings, no comments, no trailing commas. The diagnostic points at the first character that cannot be parsed and, when the repair is unambiguous, carries a safe text fix.",
  },
  HM1003: {
    title: "duplicate key",
    explanation:
      "An object has the same key twice. JSON parsers disagree on which one wins, so Hatchmark rejects the file. Keep one of the two and delete the other.",
  },
} as const satisfies Record<string, { title: string; explanation: string }>;

export type DiagnosticCode = keyof typeof CODES;

export function docsCommand(code: DiagnosticCode): string {
  return `hatchmark explain ${code}`;
}

export function isDiagnosticCode(value: string): value is DiagnosticCode {
  return Object.hasOwn(CODES, value);
}
