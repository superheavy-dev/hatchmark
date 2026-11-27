import type { Diagnostic, DiagnosticReport, Severity } from "./diagnostic.js";

export interface HumanRenderOptions {
  /** Source text by project-relative file path, used to print the offending line. */
  sources?: ReadonlyMap<string, string>;
  color?: boolean;
  /** Longest expected list printed before it is cut short. Defaults to 12. */
  maxExpected?: number;
}

const ANSI = { red: 31, yellow: 33, cyan: 36, blue: 34, bold: 1 } as const;

function paint(on: boolean, style: keyof typeof ANSI, text: string): string {
  return on ? `\u001b[${ANSI[style]}m${text}\u001b[0m` : text;
}

const severityStyle: Record<Severity, keyof typeof ANSI> = {
  error: "red",
  warning: "yellow",
  note: "cyan",
};

function lineOf(source: string, line: number): string | undefined {
  const lines = source.split("\n");
  const text = lines[line - 1];
  return text?.replace(/\r$/, "");
}

function describeFix(diagnostic: Diagnostic): string | undefined {
  const fix = diagnostic.fix;
  if (fix === undefined) return undefined;
  return `fix (${fix.applicability}): ${fix.description}`;
}

/** Renders one diagnostic in the rustc style: header, location, source line with carets, notes. */
export function renderDiagnostic(diagnostic: Diagnostic, options: HumanRenderOptions = {}): string {
  const color = options.color ?? false;
  const maxExpected = options.maxExpected ?? 12;
  const style = severityStyle[diagnostic.severity];
  const out: string[] = [];
  out.push(
    `${paint(color, style, `${diagnostic.severity}[${diagnostic.code}]`)}${paint(color, "bold", `: ${diagnostic.message}`)}`,
  );

  const range = diagnostic.range;
  const source = diagnostic.file === undefined ? undefined : options.sources?.get(diagnostic.file);
  const text = range && source !== undefined ? lineOf(source, range.start.line) : undefined;
  const gutterWidth = range ? String(range.start.line).length : 1;
  const pad = " ".repeat(gutterWidth);
  const bar = paint(color, "blue", "|");

  if (diagnostic.file !== undefined) {
    const where = range ? `:${range.start.line}:${range.start.column}` : "";
    out.push(`${pad}${paint(color, "blue", "-->")} ${diagnostic.file}${where}`);
  }
  if (range && text !== undefined) {
    const chars = [...text];
    const expand = (cs: string[]): string => cs.map((c) => (c === "\t" ? "    " : c)).join("");
    const startCol = Math.min(range.start.column - 1, chars.length);
    const endCol =
      range.end.line === range.start.line
        ? Math.min(
            Math.max(range.end.column - 1, startCol + 1),
            Math.max(chars.length, startCol + 1),
          )
        : Math.max(chars.length, startCol + 1);
    const lead = expand(chars.slice(0, startCol)).length;
    const width = Math.max(1, expand(chars.slice(startCol, endCol)).length);
    const carets = paint(color, style, "^".repeat(width));
    const label = diagnostic.label ? ` ${paint(color, style, diagnostic.label)}` : "";
    out.push(`${pad} ${bar}`);
    out.push(`${paint(color, "blue", String(range.start.line))} ${bar} ${expand(chars)}`);
    out.push(`${pad} ${bar} ${" ".repeat(lead)}${carets}${label}`);
  } else if (diagnostic.label) {
    out.push(`${pad} ${paint(color, "blue", "=")} ${diagnostic.label}`);
  }

  const notes: string[] = [];
  if (diagnostic.help) notes.push(`help: ${diagnostic.help}`);
  if (diagnostic.expected && diagnostic.expected.length > 0) {
    const shown = diagnostic.expected.slice(0, maxExpected);
    const rest = diagnostic.expected.length - shown.length;
    notes.push(`valid: ${shown.join(", ")}${rest > 0 ? `, and ${rest} more` : ""}`);
  }
  const fix = describeFix(diagnostic);
  notes.push(fix ? `${fix}   ·   ${diagnostic.docs}` : `see: ${diagnostic.docs}`);
  for (const note of notes) out.push(`${pad} ${paint(color, "blue", "=")} ${note}`);
  return out.join("\n");
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/** Renders a whole report: every diagnostic, then one summary line. */
export function renderHuman(report: DiagnosticReport, options: HumanRenderOptions = {}): string {
  const blocks = report.diagnostics.map((d) => renderDiagnostic(d, options));
  const counts = `${plural(report.error_count, "error")}, ${plural(report.warning_count, "warning")}`;
  const summary = report.ok
    ? paint(options.color ?? false, "bold", `ok: ${counts}`)
    : `${paint(options.color ?? false, "red", "failed")}: ${counts}`;
  return [...blocks, summary].join("\n\n");
}
