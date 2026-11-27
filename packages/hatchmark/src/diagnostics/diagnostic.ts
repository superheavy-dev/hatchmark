import type { DiagnosticCode } from "./codes.js";

export type Severity = "error" | "warning" | "note";

/** 1-based line and column. Columns count Unicode code points. */
export interface Position {
  line: number;
  column: number;
}

/** A source range; end is exclusive. */
export interface Range {
  start: Position;
  end: Position;
}

export type Applicability = "safe" | "unsafe";

/**
 * A fix for one diagnostic. Value fixes are RFC 6902 style operations on the parsed file at a JSON
 * Pointer; text fixes replace a source range and are used where the file does not parse. Only
 * "safe" fixes may be applied without a person or agent reading them first.
 */
export type Fix =
  | {
      op: "replace" | "add";
      pointer: string;
      value: unknown;
      applicability: Applicability;
      description: string;
    }
  | { op: "remove"; pointer: string; applicability: Applicability; description: string }
  | { op: "text"; range: Range; text: string; applicability: Applicability; description: string };

export interface Diagnostic {
  code: DiagnosticCode;
  severity: Severity;
  message: string;
  /** Project-relative path with forward slashes. */
  file?: string;
  /** JSON Pointer into the file's value. */
  pointer?: string;
  range?: Range;
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
  return a.message < b.message ? -1 : a.message > b.message ? 1 : 0;
}

/** Builds the versioned report; ok is false only when there is at least one error. */
export function createReport(diagnostics: readonly Diagnostic[]): DiagnosticReport {
  const sorted = [...diagnostics].sort(compareDiagnostics);
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
