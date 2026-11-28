import { type Diagnostic, docsCommand } from "../diagnostics/index.js";
import { matchRegion, regionName } from "../geo/aliases.js";
import type { Project } from "../spec/index.js";
import { blockId } from "../spec/units.js";
import type { DashboardData, MapData } from "./dashboard-data.js";

/** One distinct value of a map's region column and what became of its rows. */
export interface MatchReportEntry {
  key: string | number | boolean | null;
  rows: number;
  value: number | null;
  /**
   * matched: on the map, in the bar list and the totals. not_drawn: a real region the map does
   * not draw. ambiguous: could name several regions. unmatched: names no region.
   */
  status: "matched" | "not_drawn" | "ambiguous" | "unmatched";
  region?: string;
  name?: string;
  /** How a matched value was recognised: a code system or a name. */
  by?: string;
  candidates?: { id: string; name: string }[];
  suggestions?: { id: string; name: string }[];
}

/** Which rows of a map block joined which region, and which did not and why. */
export interface MapMatchReport {
  dashboard: string;
  block: string;
  geo: MapData["geo"];
  column: string;
  rows: { total: number; matched: number; notDrawn: number; ambiguous: number; unmatched: number };
  /** Drawn regions with rows. */
  regions: number;
  entries: MatchReportEntry[];
}

const named = (geo: MapData["geo"], id: string) => ({ id, name: regionName(geo, id) ?? id });

/** The match report of a map block, from its assembled match list. */
export function matchReport(dashboard: string, data: MapData): MapMatchReport {
  const entries = data.match.map((m): MatchReportEntry => {
    const base = { key: m.key, rows: m.rows, value: m.value };
    const found = matchRegion(data.geo, m.key);
    if (m.region !== null) {
      return {
        ...base,
        status: "matched",
        ...named(data.geo, m.region),
        region: m.region,
        ...(found.kind === "matched" ? { by: found.by } : {}),
      };
    }
    if (found.kind === "not_drawn") {
      return { ...base, status: "not_drawn", region: found.id, name: found.name };
    }
    if (found.kind === "ambiguous") {
      return {
        ...base,
        status: "ambiguous",
        candidates: found.candidates.map((id) => named(data.geo, id)),
      };
    }
    return {
      ...base,
      status: "unmatched",
      suggestions:
        found.kind === "unmatched" ? found.suggestions.map((id) => named(data.geo, id)) : [],
    };
  });
  const sum = (status: MatchReportEntry["status"]) =>
    entries.filter((e) => e.status === status).reduce((n, e) => n + e.rows, 0);
  const matched = sum("matched");
  const notDrawn = sum("not_drawn");
  const ambiguous = sum("ambiguous");
  const unmatched = sum("unmatched");
  return {
    dashboard,
    block: data.id,
    geo: data.geo,
    column: data.column,
    rows: {
      total: matched + notDrawn + ambiguous + unmatched,
      matched,
      notDrawn,
      ambiguous,
      unmatched,
    },
    regions: data.regions.length,
    entries,
  };
}

/** Every map block's match report in a dashboard. */
export function matchReports(data: DashboardData): MapMatchReport[] {
  return data.blocks.flatMap((b) => (b.type === "map" ? [matchReport(data.name, b)] : []));
}

const quoted = (key: MatchReportEntry["key"]) =>
  key === null ? "(empty)" : JSON.stringify(String(key));
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * HM5041 for values that match no region, HM5042 for ambiguous ones and HM5043 for regions the map
 * does not draw: rows are never left out of a map without a warning that names them.
 */
export function matchDiagnostics(project: Project, data: DashboardData): Diagnostic[] {
  const file = project.dashboards.get(data.name);
  const spec = file?.spec;
  if (file === undefined || spec === undefined) return [];
  const out: Diagnostic[] = [];
  for (const report of matchReports(data)) {
    const index = spec.blocks.findIndex((b, i) => blockId(b, i) === report.block);
    const pointer = `/blocks/${index}/region`;
    const at = { file: file.file, pointer, ...file.document.locationOf(pointer) };
    const listed = (status: MatchReportEntry["status"]) =>
      report.entries.filter((e) => e.status === status).sort((a, b) => b.rows - a.rows);
    const unmatched = listed("unmatched");
    if (unmatched.length > 0) {
      const shown = unmatched.slice(0, 5).map((e) => {
        const hint = e.suggestions?.[0];
        return `${quoted(e.key)} (${plural(e.rows, "row")}${hint ? `; did you mean ${hint.name}?` : ""})`;
      });
      out.push({
        code: "HM5041",
        severity: "warning",
        message: `map "${report.block}" leaves out ${plural(report.rows.unmatched, "row")}: ${plural(unmatched.length, "value")} of "${report.column}" match no region of ${report.geo}: ${shown.join(", ")}${unmatched.length > 5 ? `, and ${unmatched.length - 5} more` : ""}`,
        ...at,
        help: "fix the values in the data, or filter those rows out; build --json and check --json list every value in the match report",
        docs: docsCommand("HM5041"),
      });
    }
    const ambiguous = listed("ambiguous");
    if (ambiguous.length > 0) {
      const shown = ambiguous
        .slice(0, 5)
        .map(
          (e) =>
            `${quoted(e.key)} could be ${(e.candidates ?? []).map((c) => `${c.name} (${c.id})`).join(" or ")}`,
        );
      out.push({
        code: "HM5042",
        severity: "warning",
        message: `map "${report.block}" leaves out ${plural(report.rows.ambiguous, "row")} with ambiguous regions: ${shown.join("; ")}`,
        ...at,
        help: "use a code or the full name in the data",
        docs: docsCommand("HM5042"),
      });
    }
    const regions = new Map<string, { name: string; rows: number }>();
    for (const e of listed("not_drawn")) {
      const id = e.region ?? String(e.key);
      const seen = regions.get(id);
      regions.set(id, { name: e.name ?? id, rows: (seen?.rows ?? 0) + e.rows });
    }
    const hidden = [...regions.values()].sort((a, b) => b.rows - a.rows);
    if (hidden.length > 0) {
      const shown = hidden.slice(0, 5).map((e) => `${e.name} (${plural(e.rows, "row")})`);
      out.push({
        code: "HM5043",
        severity: "warning",
        message: `map "${report.block}" does not draw ${hidden.length === 1 ? "a region" : `${hidden.length} regions`} with rows: ${shown.join(", ")}${hidden.length > 5 ? `, and ${hidden.length - 5} more` : ""}; they are left out of the map, the bar list and the totals`,
        ...at,
        help: "show them in a table beside the map, or filter them out on purpose",
        docs: docsCommand("HM5043"),
      });
    }
  }
  return out;
}
