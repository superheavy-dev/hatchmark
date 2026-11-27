import type { Diagnostic } from "../diagnostics/index.js";
import type {
  Aggregate,
  Comparison,
  Filter,
  PeriodRange,
  Project,
  TimeGrain,
} from "../spec/index.js";

/**
 * The query plan: the one logical description of what a dashboard needs from its data, shared by
 * both ways of running it.
 *
 * - Build (`hatchmark build`, phase 1) runs every query once at build time and embeds the results
 *   in the page. Dashboard filters become extra grouping columns when every measure can be
 *   re-aggregated in the browser, and one result per filter value otherwise (see materialization).
 * - Serve (`hatchmark serve`, phase 2) runs the same queries per request with the filter values
 *   the browser sent bound as parameters. The SQL is compiled from the plan ahead of time; the
 *   browser never sends SQL.
 *
 * A plan is plain JSON-serializable data and is deterministic: the same project gives the same
 * plan, byte for byte, so plans can be cached and diffed.
 */
export const PLAN_VERSION = 1;

/** One aggregate over rows, the unit the executor computes and the browser may re-aggregate. */
export interface MeasureComponent {
  /** Stable within the query, such as "net_revenue__sum". */
  id: string;
  aggregate: Aggregate | "sql";
  column?: string;
  /** Raw SQL aggregate expression, for metrics of type "sql". */
  sql?: string;
  filters: Filter[];
  /**
   * How a browser or a total row may combine this component across groups: "sum" for sum and
   * count, "min"/"max" for those, and "none" when it must be recomputed from rows (count_distinct,
   * median, non-additive SQL).
   */
  reaggregate: "sum" | "min" | "max" | "none";
}

/**
 * An aggregate or SQL metric as one query computes it: components plus how to combine them. avg
 * becomes sum(column) / count(column), both skipping nulls like avg does, so it stays correct after
 * the browser re-aggregates a filter. count with a column is count(column), non-null values only;
 * count without a column is count(*).
 */
export interface PlannedMeasure {
  metric: string;
  components: MeasureComponent[];
  combine:
    | { op: "identity"; component: string }
    | { op: "divide"; numerator: string; denominator: string };
}

/**
 * How a block gets a metric's value from query results. Ratio metrics may divide measures from
 * queries on different sources; rows are matched on equal dimension values, and a total row
 * divides the two totals, never sums the per-row ratios.
 */
export type MeasureExpression =
  | { op: "ref"; queryId: string; metric: string }
  | { op: "divide"; numerator: MeasureExpression; denominator: MeasureExpression };

export type PlannedDimension =
  | { kind: "column"; column: string }
  | { kind: "time"; column: string; grain: TimeGrain };

/**
 * The time window a query reads, explicit enough that the executor needs nothing else from the
 * spec: two queries that read different spans always differ here, and so do their ids.
 */
export interface PlannedWindow {
  /** The span, ending at the plan's asOf: the block's or filter's range, or "all_time". */
  range: PeriodRange;
  /**
   * "none" reads the range itself. "previous_period" reads the span of the same length just
   * before it, and "previous_year" the same span one year earlier; KPI and text comparisons use
   * these, with each block's own compare override.
   */
  shift: Comparison;
  /** The metric's time column that places rows in the window. Absent only for "all_time". */
  column?: string;
}

export interface PlannedQuery {
  /** Content hash of the query shape. Identical queries from different blocks share one id. */
  id: string;
  source: string;
  /** Aggregate and SQL metrics on this source; ratios combine measures in BlockPlan.measures. */
  measures: PlannedMeasure[];
  dimensions: PlannedDimension[];
  /**
   * Grouping sets, as indexes into dimensions. [[0, 1], [0], []] is ROLLUP(0, 1): rows, subtotals
   * and the grand total, each recomputed from rows rather than summed.
   */
  groupingSets: number[][];
  window: PlannedWindow;
  /**
   * Dashboard filter ids that bind into this query. A filter binds to a block only when every
   * source the block reads has its column; check rejects blocks where only some do (HM2013), so a
   * ratio never divides filtered rows by unfiltered ones.
   */
  params: string[];
  orderBy?: { key: string; order: "asc" | "desc" }[];
  limit?: number;
}

/** How build mode stores a query's result for in-browser filtering. */
export type Materialization =
  /** Filter columns added as dimensions; the browser filters rows and re-aggregates components. */
  | { kind: "grouped"; filterColumns: string[] }
  /** Some component cannot be re-aggregated: one result per combination of filter values. */
  | { kind: "per_filter_value" };

export interface PlanParam {
  id: string;
  kind: "select" | "period";
  column?: string;
  multiple: boolean;
  default?: unknown;
  options?: PeriodRange[];
}

export interface BlockPlan {
  /** blockId(block, index) from the spec. */
  blockId: string;
  /** JSON Pointer to the block in the dashboard file, for diagnostics. */
  pointer: string;
  queryIds: string[];
  /** Every metric the block shows, by name, resolved to query results. */
  measures: Record<string, MeasureExpression>;
}

export interface QueryPlan {
  version: typeof PLAN_VERSION;
  dashboard: string;
  period: { asOf: string; range: PeriodRange; compare: Comparison };
  /** IANA time zone that dates are bucketed and windowed in, from hatchmark.json. */
  timezone: string;
  /** First day of a week bucket, from hatchmark.json. */
  weekStart: "monday" | "sunday";
  params: PlanParam[];
  blocks: BlockPlan[];
  queries: PlannedQuery[];
  materialization: Record<string, Materialization>;
}

export interface PlanResult<T> {
  plan?: T;
  diagnostics: Diagnostic[];
}

/**
 * Turns a checked project into plans. Implementations are pure (no I/O) so a dev server can call
 * them on every edit. planBlock exists so the Vite dev plugin can recompile one block and push
 * only its result over HMR; its queries carry the same ids as in the full plan.
 */
export interface Compiler {
  planDashboard(project: Project, dashboard: string): PlanResult<QueryPlan>;
  planBlock(
    project: Project,
    dashboard: string,
    blockId: string,
  ): PlanResult<{ block: BlockPlan; queries: PlannedQuery[] }>;
}

/**
 * What an execution needs besides the query. asOf is resolved once per plan before execution
 * ("latest_data" becomes the last date in the data), so every query of one build or request reads
 * the same end date; timezone and weekStart are copied from the QueryPlan.
 */
export interface ExecutionContext {
  asOf: string;
  timezone: string;
  weekStart: "monday" | "sunday";
  bindings: ParamBindings;
  materialization?: Materialization;
}

/** Filter values bound for one execution: absent means the filter's default. */
export type ParamBindings = Readonly<Record<string, unknown>>;

export interface QueryResult {
  columns: {
    name: string;
    type: "string" | "number" | "boolean" | "date" | "timestamp" | "null";
  }[];
  rows: unknown[][];
  /** Index of the grouping set each row belongs to, when the query has more than one. */
  groupingSet?: number[];
}

/**
 * Runs planned queries. The DuckDB executor (build and serve) and any warehouse executor implement
 * this; the plan is the only input that decides what SQL runs.
 */
export interface QueryExecutor {
  execute(query: PlannedQuery, context: ExecutionContext): Promise<QueryResult>;
}
