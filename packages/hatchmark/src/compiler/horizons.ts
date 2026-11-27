import type { Source } from "../spec/index.js";
import type { PlannedQuery, QueryPlan } from "./plan.js";

/** A time column a plan reads, by source. */
export interface TimeColumn {
  source: string;
  column: string;
}

/** What a source's freshness takes off its latest value: local days, or hours of real time. */
export type HorizonLag = { days: number } | { hours: number };

/**
 * How one source's horizon is measured (RFC 0001 section 6.1): the latest value of a column over
 * all rows, ignoring filters, optionally minus a lag; or a fixed "through" from the source's
 * freshness. Horizons that vote decide "latest_data"; "through": "as_of" never votes, since it is
 * complete whenever the build runs.
 */
export interface PlannedHorizon {
  source: string;
  /** The column whose latest value is measured; absent for a "through" rule. */
  column?: string;
  rule: "max" | { lag: HorizonLag } | { through: string };
  votes: boolean;
}

/**
 * A measured horizon: the local wall-clock instant (YYYY-MM-DDTHH:MM:SS.ffffff) a source's column
 * is complete through, exclusive. A source complete through the as-of ("through": "as_of") gets the
 * as-of instant.
 */
export interface SourceHorizon {
  source: string;
  column?: string;
  through: string;
}

/**
 * Every time column a plan reads: the columns that window its queries, place them on time axes,
 * or that a period filter windows. Sorted, so the same plan asks the same question.
 */
export function planTimeColumns(plan: Pick<QueryPlan, "queries">): TimeColumn[] {
  const seen = new Map<string, TimeColumn>();
  const add = (source: string, column: string | undefined) => {
    if (column !== undefined) seen.set(JSON.stringify([source, column]), { source, column });
  };
  for (const query of plan.queries) {
    add(query.source, query.window.column);
    for (const d of query.dimensions) if (d.kind === "time") add(query.source, d.column);
    for (const p of query.params) if (p.kind === "period") add(p.source, p.column);
  }
  return [...seen.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, c]) => c);
}

/** The horizons a plan's queries need, from each source's freshness; sorted by source and column. */
export function planHorizons(
  queries: PlannedQuery[],
  sources: Record<string, Source>,
): PlannedHorizon[] {
  const out = new Map<string, PlannedHorizon>();
  for (const { source, column } of planTimeColumns({ queries })) {
    const declared = sources[source];
    const freshness =
      declared !== undefined && declared.type !== "lookup" ? declared.freshness : undefined;
    const horizon: PlannedHorizon =
      freshness === undefined
        ? { source, column, rule: "max", votes: true }
        : "column" in freshness
          ? { source, column: freshness.column, rule: "max", votes: true }
          : "lag" in freshness
            ? { source, column, rule: { lag: freshness.lag }, votes: true }
            : {
                source,
                rule: { through: freshness.through },
                votes: freshness.through !== "as_of",
              };
    out.set(JSON.stringify([horizon.source, horizon.column ?? ""]), horizon);
  }
  return [...out.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, h]) => h);
}

/** The horizon of a query's time column: the source's rule for that column, else its "through". */
export function horizonFor(
  horizons: readonly PlannedHorizon[],
  source: string,
  column: string,
): PlannedHorizon | undefined {
  return (
    horizons.find((h) => h.source === source && h.column === column) ??
    horizons.find((h) => h.source === source)
  );
}
