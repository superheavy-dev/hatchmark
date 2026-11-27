import type { Comparison, Format, PeriodRange, TimeGrain } from "../spec/index.js";

/**
 * DashboardData: everything the renderer needs to draw one dashboard, produced by the engine from a
 * QueryPlan and its query results. It is the contract between the numbers path (planner, executor,
 * assembly) and the renderer: the renderer never reads specs, plans or SQL results, and the engine
 * never decides how anything looks.
 *
 * Plain JSON-serializable data, deterministic for identical input (no timestamps, keys in a fixed
 * order), so it can be embedded in the page, snapshotted in tests, and later shipped to the iOS app.
 *
 * Values: a number, or null when the value is undefined (no rows, division by zero). The renderer
 * shows null as "—" and a real 0 as 0. Empty time buckets of additive metrics (sum, count) are
 * zero-filled by the engine; other metrics leave them null.
 */
export const DASHBOARD_DATA_VERSION = 1;

export type Value = number | null;

/** A calendar span in the project time zone: start inclusive, end exclusive, YYYY-MM-DD. */
export interface DateSpan {
  start: string;
  end: string;
}

export interface MetricInfo {
  name: string;
  label: string;
  description?: string;
  /** The metric's format with the currency resolved (project currency when the metric sets none). */
  format: Format;
  better: "up" | "down" | "neutral";
}

export interface BlockCommon {
  id: string;
  title?: string;
  /** Width in the 12-column grid, resolved (12 when the spec sets none, 3 for a KPI). */
  span: number;
}

export interface KpiData extends BlockCommon {
  type: "kpi";
  metric: string;
  value: Value;
  /** Resolved compare: the block's override or the dashboard period's compare. */
  compare: Comparison;
  /** The windows read; previous is absent when compare is "none" or the range is all_time. */
  current?: DateSpan;
  previous?: DateSpan;
  /** Value over the previous window; absent when there is no comparison. */
  previousValue?: Value;
  /** value - previousValue. */
  change?: Value;
  /**
   * Relative change as a fraction (0.124 = +12.4%), null when previousValue is 0 or null. For
   * percent-formatted metrics the change is in percentage points instead: changeKind says which.
   */
  changePct?: Value;
  changeKind?: "relative" | "points";
  /** Present when the block asks for a sparkline: the metric by month over the current window. */
  sparkline?: { grain: TimeGrain; buckets: string[]; values: Value[] };
}

/** One drawn series: a metric, or one value of the split column for a single metric. */
export interface Series {
  /** Stable key: the metric name, or "<metric>:<split value>". */
  key: string;
  metric: string;
  /** Legend and direct-label text: the metric label, or the split value as text. */
  label: string;
  /** The split column's value when the block splits; absent otherwise. null is a real group. */
  splitValue?: string | number | boolean | null;
  /** One value per x position (bucket or category), same order and length as the axis. */
  values: Value[];
}

export interface TimeAxis {
  kind: "time";
  grain: TimeGrain;
  /**
   * Bucket start dates (YYYY-MM-DD, project time zone, weeks starting on weekStart), a complete
   * spine over the window: every bucket appears, empty ones included. The first and last buckets
   * may be partial (the window clips them); phase 1 does not mark incomplete periods.
   */
  buckets: string[];
  window: DateSpan;
}

export interface CategoryAxis {
  kind: "category";
  column: string;
  /** Category values in display order (after sort and limit). null is a real group. */
  categories: (string | number | boolean | null)[];
}

export interface LineData extends BlockCommon {
  type: "line" | "area";
  stack?: boolean;
  axis: TimeAxis;
  /** Ordered: metric order in the spec, or split values by total descending, then by value. */
  series: Series[];
}

export interface BarData extends BlockCommon {
  type: "bar";
  orientation: "vertical" | "horizontal";
  stack: boolean;
  axis: TimeAxis | CategoryAxis;
  series: Series[];
  /** Categories removed by limit, so the renderer can say "Top 10 of 51". */
  omittedCategories?: number;
}

export interface TableRow {
  /** One value per by column, in order. null is a real group (shown as "(empty)"). */
  keys: (string | number | boolean | null)[];
  /** By metric name. */
  values: Record<string, Value>;
  /** Share of the grand total for metrics in percentOfTotal (a fraction), by metric name. */
  share?: Record<string, Value>;
}

export interface TableData extends BlockCommon {
  type: "table";
  by: { column: string; label: string }[];
  metrics: string[];
  percentOfTotal: string[];
  /** Leaf rows after sort and limit. Limit never counts the total row. */
  rows: TableRow[];
  /** Leaf rows before limit. */
  rowCount: number;
  /**
   * The total row, recomputed from all rows in the window (SQL ROLLUP's grand total; ratios divide
   * the totals, never sum per-row ratios). Covers every row, also those limit removed. Absent when
   * totals is false.
   */
  total?: { values: Record<string, Value>; share?: Record<string, Value> };
  window?: DateSpan;
}

export type BlockData = KpiData | LineData | BarData | TableData;

export interface DashboardData {
  version: typeof DASHBOARD_DATA_VERSION;
  /** Dashboard name: the file name under dashboards/, also its output route. */
  name: string;
  title: string;
  description?: string;
  /** Project name from hatchmark.json. */
  project: string;
  /** The resolved end date of every window (latest_data resolved once per plan). */
  asOf: string;
  period: { range: PeriodRange; compare: Comparison; current?: DateSpan; previous?: DateSpan };
  locale: string;
  currency: string;
  timezone: string;
  weekStart: "monday" | "sunday";
  /** Every metric any block shows, by name. */
  metrics: Record<string, MetricInfo>;
  /** Blocks in spec order. Block types the engine cannot produce yet are omitted with a warning. */
  blocks: BlockData[];
}
