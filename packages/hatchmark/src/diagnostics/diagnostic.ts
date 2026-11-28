import type { DiagnosticCode } from "./codes.js";

export type Severity = "error" | "warning" | "note";

/** 1-based line and column. Columns count Unicode code points. */
export interface Position {
  line: number;
  column: number;
}

/**
 * A source range; end is exclusive. Always within the source (start <= end <= end of file). A
 * diagnostic's range is empty only at end of input in an empty file, where it renders as a caret;
 * a fix's range is empty when it inserts.
 */
export interface Range {
  start: Position;
  end: Position;
}

export type Applicability = "safe" | "unsafe";

/**
 * A fix replaces the source range with text, verbatim. Only "safe" fixes may be applied without a
 * person or agent reading them first. After applying fixes, run check again for fresh diagnostics:
 * every range and frame describes the text that was checked, not the edited file.
 */
export interface Fix {
  range: Range;
  text: string;
  applicability: Applicability;
  description: string;
}

/**
 * The source line a diagnostic points at, captured from the checked text when the diagnostic was
 * made, so a later edit to the file can never redraw it against other text. Long lines are cut to
 * a window: text starts at column, and more is true when the line continues past it.
 */
export interface Frame {
  text: string;
  column: number;
  more: boolean;
}

export interface Diagnostic {
  code: DiagnosticCode;
  severity: Severity;
  message: string;
  /** Project-relative path with forward slashes. */
  file?: string;
  /** JSON Pointer into the file's value. */
  pointer?: string;
  range?: Range;
  /** The source line at range.start.line, as checked. */
  frame?: Frame;
  /** Short text shown under the caret in human output. */
  label?: string;
  /** The values that would have been valid here, when there is a closed set. */
  expected?: string[];
  help?: string;
  fix?: Fix;
  /** Command that prints the long explanation of the code. */
  docs: string;
}

export const DIAGNOSTICS_FORMAT_VERSION = "1";

export interface DiagnosticReport {
  format_version: typeof DIAGNOSTICS_FORMAT_VERSION;
  ok: boolean;
  error_count: number;
  warning_count: number;
  diagnostics: Diagnostic[];
}

const severityOrder: Record<Severity, number> = { error: 0, warning: 1, note: 2 };

/** Orders diagnostics by file, position, severity and code, so output is stable across runs. */
export function compareDiagnostics(a: Diagnostic, b: Diagnostic): number {
  const fileA = a.file ?? "";
  const fileB = b.file ?? "";
  if (fileA !== fileB) return fileA < fileB ? -1 : 1;
  const lineDiff = (a.range?.start.line ?? 0) - (b.range?.start.line ?? 0);
  if (lineDiff !== 0) return lineDiff;
  const colDiff = (a.range?.start.column ?? 0) - (b.range?.start.column ?? 0);
  if (colDiff !== 0) return colDiff;
  const sevDiff = severityOrder[a.severity] - severityOrder[b.severity];
  if (sevDiff !== 0) return sevDiff;
  if (a.code !== b.code) return a.code < b.code ? -1 : 1;
  const keyA = JSON.stringify(a);
  const keyB = JSON.stringify(b);
  return keyA < keyB ? -1 : keyA > keyB ? 1 : 0;
}

const URL_PASSWORD = /(\w+:\/\/[^:/@\s]*:)[^\s"']*@/g;
const KEYWORD_PASSWORD = /\b((?:password|passwd|pwd)\s*=\s*)('(?:[^'\\]|\\.)*'|[^\s"]+)/gi;

/**
 * Replaces passwords in connection strings (scheme://user:password@host, password=...) with ***,
 * so a report never repeats a credential from a file or an error.
 */
export function maskPasswords(text: string): string {
  return text.replace(URL_PASSWORD, "$1***@").replace(KEYWORD_PASSWORD, "$1***");
}

function masked<T>(value: T): T {
  if (typeof value === "string") return maskPasswords(value) as T;
  if (Array.isArray(value)) return value.map(masked) as T;
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, masked(v)])) as T;
  }
  return value;
}

/** Builds the versioned report; ok is false only when there is at least one error. */
export function createReport(diagnostics: readonly Diagnostic[]): DiagnosticReport {
  const sorted = [...diagnostics].sort(compareDiagnostics).map(masked);
  const errorCount = sorted.filter((d) => d.severity === "error").length;
  return {
    format_version: DIAGNOSTICS_FORMAT_VERSION,
    ok: errorCount === 0,
    error_count: errorCount,
    warning_count: sorted.filter((d) => d.severity === "warning").length,
    diagnostics: sorted,
  };
}

/** Serializes a report as one line of JSON for stdout. */
export function renderJson(report: DiagnosticReport): string {
  return JSON.stringify(report);
}
