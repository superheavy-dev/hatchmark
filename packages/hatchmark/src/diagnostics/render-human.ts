import type { Diagnostic, DiagnosticReport, Severity } from "./diagnostic.js";

export interface HumanRenderOptions {
  color?: boolean;
  /** Longest expected list printed before it is cut short. Defaults to 12. */
  maxExpected?: number;
  /** Print each HM4040 default note instead of one line per file. Defaults to false. */
  explainDefaults?: boolean;
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

const WIDE =
  /[\u1100-\u115f\u2e80-\u303e\u3041-\u33ff\u3400-\u4dbf\u4e00-\u9fff\ua000-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]|[\u{1f300}-\u{1f64f}\u{1f900}-\u{1faff}\u{20000}-\u{3fffd}]/u;
const ZERO_WIDTH = /^(?:\p{M}|[\u200b-\u200f\u2060])$/u;

function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    if (ch === "\t") width += 4;
    else if (ZERO_WIDTH.test(ch)) width += 0;
    else width += WIDE.test(ch) ? 2 : 1;
  }
  return width;
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
  const frame = diagnostic.frame;
  const gutterWidth = range ? String(range.start.line).length : 1;
  const pad = " ".repeat(gutterWidth);
  const bar = paint(color, "blue", "|");

  if (diagnostic.file !== undefined) {
    const where = range ? `:${range.start.line}:${range.start.column}` : "";
    out.push(`${pad}${paint(color, "blue", "-->")} ${diagnostic.file}${where}`);
  }
  if (range && frame) {
    const chars = [...frame.text];
    const startCol = Math.min(Math.max(range.start.column - frame.column, 0), chars.length);
    const endCol =
      range.end.line === range.start.line
        ? Math.min(
            Math.max(range.end.column - frame.column, startCol + 1),
            Math.max(chars.length, startCol + 1),
          )
        : Math.max(chars.length, startCol + 1);
    const before = frame.column > 1 ? "…" : "";
    const lead = displayWidth(before) + displayWidth(chars.slice(0, startCol).join(""));
    const width = Math.max(1, displayWidth(chars.slice(startCol, endCol).join("")));
    const carets = paint(color, style, "^".repeat(width));
    const label = diagnostic.label ? ` ${paint(color, style, diagnostic.label)}` : "";
    const shown = `${before}${frame.text}${frame.more ? "…" : ""}`.replaceAll("\t", "    ");
    out.push(`${pad} ${bar}`);
    out.push(`${paint(color, "blue", String(range.start.line))} ${bar} ${shown}`);
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
  const folded = (d: Diagnostic) => d.code === "HM4040" && options.explainDefaults !== true;
  const blocks = report.diagnostics
    .filter((d) => !folded(d))
    .map((d) => renderDiagnostic(d, options));
  const perFile = new Map<string, number>();
  for (const d of report.diagnostics.filter(folded)) {
    perFile.set(d.file ?? "the project", (perFile.get(d.file ?? "the project") ?? 0) + 1);
  }
  for (const [file, count] of perFile) {
    blocks.push(
      `${paint(options.color ?? false, "cyan", "note[HM4040]")}: ${file}: ${plural(count, "default definition")}, run hatchmark check --explain-defaults`,
    );
  }
  const counts = `${plural(report.error_count, "error")}, ${plural(report.warning_count, "warning")}`;
  const summary = report.ok
    ? paint(options.color ?? false, "bold", `ok: ${counts}`)
    : `${paint(options.color ?? false, "red", "failed")}: ${counts}`;
  return [...blocks, summary].join("\n\n");
}
