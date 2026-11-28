import type { Diagnostic } from "../diagnostics/index.js";
import type { Project } from "../spec/index.js";
import type { DashboardData } from "./dashboard-data.js";
import type { PeriodData } from "./period-data.js";
import { type DashboardExecutor, runDashboardBindings } from "./run.js";

/**
 * What a static page embeds so its segment filter works without a server: the dashboard run once
 * per combination of segments, exactly as build runs it, so every number is the executor's. Each
 * state carries its own period data when the dashboard also has a period filter. Plain JSON,
 * deterministic for identical input.
 */
export const SEGMENT_DATA_VERSION = 1;

export interface SegmentState {
  /** The segments on, in the filter's order. */
  selected: string[];
  data: DashboardData;
  periods?: PeriodData;
}

export interface SegmentData {
  version: typeof SEGMENT_DATA_VERSION;
  /** The segment filter's id: its query parameter in the page URL. */
  filter: string;
  /** Every combination of segments, by segmentKey. */
  states: Record<string, SegmentState>;
}

/** A combination's key: the segments on, in the filter's order, joined by commas; "" for none. */
export function segmentKey(selected: readonly string[], order: readonly string[]): string {
  return order.filter((name) => selected.includes(name)).join(",");
}

/**
 * Runs the dashboard for every combination of the segment filter's segments. base is the page's
 * own data, reused for the default combination. Undefined data when the dashboard has no segment
 * filter. Errors of any combination are returned; warnings of non-default combinations are left
 * out, since the page shows the default first.
 */
export async function runSegmentData(
  project: Project,
  dashboard: string,
  executor: DashboardExecutor,
  base: DashboardData,
  now?: Date,
): Promise<{ data?: SegmentData; diagnostics: Diagnostic[] }> {
  const filter = project.dashboards
    .get(dashboard)
    ?.spec?.filters?.find((f) => f.type === "segment");
  if (filter === undefined || base.segmentFilter === undefined) return { diagnostics: [] };
  const order = filter.segments;
  const combinations = Array.from({ length: 2 ** order.length }, (_, mask) =>
    order.filter((_, i) => (mask & (1 << i)) !== 0),
  );
  const shown = segmentKey(base.segmentFilter.selected, order);
  const pending = combinations.filter((c) => segmentKey(c, order) !== shown);
  const runs = await runDashboardBindings(
    project,
    dashboard,
    executor,
    pending.map((selected) => ({ [filter.id]: selected })),
    now,
  );
  const diagnostics: Diagnostic[] = [];
  const states: Record<string, SegmentState> = {
    [shown]: { selected: base.segmentFilter.selected, data: base },
  };
  pending.forEach((selected, i) => {
    const run = runs[i];
    diagnostics.push(...(run?.diagnostics ?? []).filter((d) => d.severity === "error"));
    if (run?.data) states[segmentKey(selected, order)] = { selected, data: run.data };
  });
  if (diagnostics.length > 0) return { diagnostics };
  const sorted = Object.fromEntries(
    Object.entries(states).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
  return {
    data: { version: SEGMENT_DATA_VERSION, filter: filter.id, states: sorted },
    diagnostics,
  };
}
