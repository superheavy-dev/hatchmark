import type { Anchors, Comparison, Format, RangeSpec, TimeGrain } from "../spec/index.js";
import type { SourceHorizon } from "./horizons.js";

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
export const DASHBOARD_DATA_VERSION = 2;

export type Value = number | null;

/**
 * A calendar span in the project time zone: start inclusive, end exclusive, YYYY-MM-DD, covering
 * every day the window touches. startAt and endAt give the exact local date-time
 * (YYYY-MM-DDTHH:MM:SS.ffffff) of a bound that a horizon puts inside a day (RFC 0001 section 6.4).
 */
export interface DateSpan {
  start: string;
  end: string;
  startAt?: string;
  endAt?: string;
}

/**
 * A bucket the horizon cuts: its index on the axis and the share of it elapsed in local wall-clock
 * time, to six decimals rounded down.
 */
/**
 * Why a KPI or table shows no value although its range has dates: its window, ended at the
 * measure's horizon, is empty (RFC 0001 section 6.4). no_complete_day: the data has begun in the
 * window but no day of it is complete yet (month-to-date on the 1st); no_data: the data ends before
 * the window starts. An empty window is a gap, never 0.
 */
export type EmptyWindow = "no_complete_day" | "no_data";

export interface PartialBucket {
  index: number;
  elapsed: number;
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
  /** Set when the current window is empty: value, change and changePct are then null. */
  empty?: EmptyWindow;
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
  sparkline?: { grain: TimeGrain; buckets: string[]; values: Value[]; partial?: PartialBucket[] };
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
  /**
   * One value per x position (bucket or category), same order and length as the axis. On a time
   * axis, buckets at or after the series' horizon have no value (null).
   */
  values: Value[];
  /** On a time axis, the bucket the series' horizon falls inside, when one does. */
  partial?: PartialBucket[];
  /**
   * Stacked blocks only: each value's share of its position's total (StackTotals.totals), as a
   * fraction; null where the value or the total is null or the total is 0.
   */
  share?: Value[];
}

/**
 * What a stacked block adds (stack true or "percent"). totals holds one value per position: for a
 * split, the metric over every split value at that position, recomputed from rows (the query's
 * grouping set without the split column), never the sum of the segments, so a distinct count or a
 * ratio shows its real total; for several metrics, the sum of their values.
 */
export interface StackTotals {
  totals?: Value[];
  /** true when the block stacks to 100% (stack "percent"); series then carry share. */
  percent?: true;
}

export interface TimeAxis {
  kind: "time";
  grain: TimeGrain;
  /**
   * Bucket start dates (YYYY-MM-DD, project time zone, from the anchors), a complete
   * spine over the window: every bucket appears, empty ones included. The window ends at the as-of
   * instant; each series marks the bucket its own horizon cuts (Series.partial). The first bucket
   * may begin before the window, which clips it.
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

/** One grain a block or the dashboard's grain filter switches to. */
export interface GrainOption {
  /** grainKey of the resolved grain, such as "month" or "week:sunday". */
  key: string;
  /** Control text: the unit ("Week"), with its anchor when two options share a unit. */
  label: string;
}

/**
 * A time-series block's grain switch: every option's axis and series, built ahead so switching
 * never re-derives numbers in the browser. The block's own axis and series are the selected one's.
 */
export interface GrainSwitch {
  selected: string;
  options: (GrainOption & { axis: TimeAxis; series: Series[]; totals?: Value[] })[];
}

export interface LineData extends BlockCommon, StackTotals {
  type: "line" | "area";
  stack?: boolean;
  axis: TimeAxis;
  /** Ordered: metric order in the spec, or split values by total descending, then by value. */
  series: Series[];
  grains?: GrainSwitch;
}

export interface BarData extends BlockCommon, StackTotals {
  type: "bar";
  orientation: "vertical" | "horizontal";
  stack: boolean;
  axis: TimeAxis | CategoryAxis;
  series: Series[];
  /** Categories removed by limit, so the renderer can say "Top 10 of 51". */
  omittedCategories?: number;
  /** Only with a time axis. */
  grains?: GrainSwitch;
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
  /**
   * Set when every metric's window is empty: no rows, and every total is null. A metric whose own
   * window is empty is null in every row and in the total, while the others fill the rows.
   */
  empty?: EmptyWindow;
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
  /** What each source read is complete through (RFC 0001 section 6.1), sorted by source and column. */
  horizons: SourceHorizon[];
  period: { range: RangeSpec; compare: Comparison; current?: DateSpan; previous?: DateSpan };
  locale: string;
  currency: string;
  timezone: string;
  /** Where week, quarter and year buckets begin (hatchmark.json anchors). */
  anchors: Anchors;
  /** The dashboard's grain filter: one control that switches every block whose grains list the choice. */
  grainFilter?: { id: string; label: string; options: GrainOption[]; selected: string };
  /** Every metric any block shows, by name. */
  metrics: Record<string, MetricInfo>;
  /** Blocks in spec order. Block types the engine cannot produce yet are omitted with a warning. */
  blocks: BlockData[];
}
