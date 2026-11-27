import { type Diagnostic, docsCommand } from "../diagnostics/index.js";
import {
  type Block,
  blockId,
  type DashboardFilter,
  grainKey,
  type Metric,
  PIE_DEFAULT_LIMIT,
  type Project,
  type RangeSpec,
  type ResolvedGrain,
  resolveGrain,
  timeNature,
} from "../spec/index.js";
import {
  type BarData,
  type BlockData,
  type CategoryAxis,
  DASHBOARD_DATA_VERSION,
  type DashboardData,
  type DateSpan,
  type EmptyWindow,
  type GrainOption,
  type KpiData,
  type LineData,
  type MetricInfo,
  type PartialBucket,
  type PieData,
  type PieSlice,
  type ScatterData,
  type ScatterPoint,
  type Series,
  type StackTotals,
  type TableData,
  type TableRow,
  type TimeAxis,
  type Value,
} from "./dashboard-data.js";
import { formatWall, fromLocal, parseInstant, toLocal } from "./instants.js";
import type {
  BlockPlan,
  ExecutionContext,
  MeasureExpression,
  PlannedQuery,
  QueryPlan,
  QueryResult,
} from "./plan.js";
import { tableGroupingSets } from "./planner.js";
import {
  bucketEnd,
  effectiveRange,
  measureHorizon,
  nextDay,
  queryBounds,
  resolveRange,
  timeBuckets,
  type WindowBounds,
  windowAt,
} from "./windows.js";

type Key = string | number | boolean | null;

interface IndexedQuery {
  query: PlannedQuery;
  /** Rows by grouping set and dimension values: rowKey(). */
  rows: Map<string, unknown[]>;
  /** Distinct dimension values by grouping set, in result order. */
  keys: Map<number, Key[][]>;
  components: Map<string, number>;
}

/** Null-safe row identity: the grouping set plus every dimension value, null included. */
function rowKey(set: number, keys: readonly Key[]): string {
  return JSON.stringify([set, keys]);
}

function toKey(value: unknown): Key {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? value
    : null;
}

function index(query: PlannedQuery, result: QueryResult): IndexedQuery {
  const dims = query.dimensions.length;
  const rows = new Map<string, unknown[]>();
  const keys = new Map<number, Key[][]>();
  result.rows.forEach((row, i) => {
    const set = result.groupingSet?.[i] ?? 0;
    const values = row.slice(0, dims).map(toKey);
    rows.set(rowKey(set, values), row);
    keys.set(set, [...(keys.get(set) ?? []), values]);
  });
  const components = new Map(result.columns.map((c, i) => [c.name, i]));
  return { query, rows, keys, components };
}

function divide(a: Value, b: Value): Value {
  return a === null || b === null || b === 0 ? null : a / b;
}

const TYPE_RANK = { boolean: 0, number: 1, string: 2 } as const;

/** Orders keys: booleans, numbers, strings, then null last; strings by UTF-16 code unit. */
function compareKey(a: Key, b: Key): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  const ta = TYPE_RANK[typeof a as keyof typeof TYPE_RANK];
  const tb = TYPE_RANK[typeof b as keyof typeof TYPE_RANK];
  if (ta !== tb) return ta - tb;
  return a < b ? -1 : 1;
}

function compareKeys(a: readonly Key[], b: readonly Key[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const c = compareKey(a[i] ?? null, b[i] ?? null);
    if (c !== 0) return c;
  }
  return 0;
}

/** Orders keys in either direction, null last in both. */
function compareKeyOrdered(a: Key, b: Key, order: "asc" | "desc"): number {
  if (a === null || b === null) return compareKey(a, b);
  return order === "asc" ? compareKey(a, b) : compareKey(b, a);
}

/** Orders values, null last in both directions. */
function compareValues(a: Value, b: Value, order: "asc" | "desc"): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return order === "asc" ? a - b : b - a;
}

/** A bound's local wall-clock time, for a UTC instant bound (windows.ts). */
const wallAt = (bound: string, timezone: string) =>
  formatWall(toLocal(parseInstant(bound), timezone));

function span(bounds: WindowBounds | undefined, timezone: string): DateSpan | undefined {
  if (bounds?.kind !== "bounded") return undefined;
  const { start, end } = bounds;
  const startAt = start.endsWith("Z") ? wallAt(start, timezone) : undefined;
  const endAt = end.endsWith("Z") ? wallAt(end, timezone) : undefined;
  return {
    start: startAt === undefined ? start : startAt.slice(0, 10),
    end: endAt === undefined ? end : nextDay(endAt.slice(0, 10)),
    ...(startAt !== undefined ? { startAt } : {}),
    ...(endAt !== undefined ? { endAt } : {}),
  };
}

function refs(expression: MeasureExpression): string[] {
  return expression.op === "ref"
    ? [expression.queryId]
    : [...refs(expression.numerator), ...refs(expression.denominator)];
}

class Assembler {
  readonly diagnostics: Diagnostic[] = [];
  private readonly queries = new Map<string, IndexedQuery>();

  constructor(
    private readonly project: Project,
    private readonly plan: QueryPlan,
    results: ReadonlyMap<string, QueryResult>,
    private readonly context: ExecutionContext,
  ) {
    for (const query of plan.queries) {
      const result = results.get(query.id);
      if (result) this.queries.set(query.id, index(query, result));
    }
  }

  metric(name: string): Metric | undefined {
    return this.project.metrics.get(name)?.spec;
  }

  /**
   * A measure's value in one row. A row a query does not have reads as no rows: 0 for additive
   * components (sum, count, additive SQL), null for the others, so empty groups and empty time
   * buckets are zero-filled exactly where the metric adds up. A null in a row the query has is an
   * undefined value (a SQL metric's NULL or non-finite result) and stays null.
   */
  private measure(queryId: string, metric: string, key: string): Value {
    return this.measureOver(queryId, metric, [key], false);
  }

  /**
   * A measure over rows of one grouping set. With fold, each component is combined across the rows
   * first the way it re-aggregates (sum adds, min and max take the extreme, ignoring nulls), and a
   * component that does not re-aggregate gives null, as does a component null in every row.
   */
  private measureOver(queryId: string, metric: string, keys: string[], fold: boolean): Value {
    const indexed = this.queries.get(queryId);
    const measure = indexed?.query.measures.find((m) => m.metric === metric);
    if (indexed === undefined || measure === undefined) return null;
    const component = (id: string): Value => {
      const at = indexed.components.get(id);
      const reaggregate = measure.components.find((c) => c.id === id)?.reaggregate ?? "none";
      const values = keys.map((key) => {
        const row = indexed.rows.get(key);
        const raw = row === undefined || at === undefined ? null : row[at];
        const value = typeof raw === "number" ? raw : null;
        return value === null && reaggregate === "sum" && row === undefined ? 0 : value;
      });
      if (!fold) return values[0] ?? null;
      const present = values.filter((v): v is number => v !== null);
      if (reaggregate === "none" || present.length === 0) return null;
      if (reaggregate === "min") return present.reduce((m, v) => Math.min(m, v));
      if (reaggregate === "max") return present.reduce((m, v) => Math.max(m, v));
      return present.reduce((sum, v) => sum + v, 0);
    };
    const { combine } = measure;
    return combine.op === "identity"
      ? component(combine.component)
      : divide(component(combine.numerator), component(combine.denominator));
  }

  /** An expression over several rows of a grouping set folded into one (a table's Other row). */
  fold(expression: MeasureExpression | undefined, set: number, rows: readonly Key[][]): Value {
    if (expression === undefined) return null;
    if (expression.op === "ref") {
      const keys = rows.map((k) => rowKey(set, k));
      return this.measureOver(expression.queryId, expression.metric, keys, true);
    }
    return divide(
      this.fold(expression.numerator, set, rows),
      this.fold(expression.denominator, set, rows),
    );
  }

  evaluate(expression: MeasureExpression | undefined, set: number, keys: readonly Key[]): Value {
    if (expression === undefined) return null;
    if (expression.op === "ref") {
      return this.measure(expression.queryId, expression.metric, rowKey(set, keys));
    }
    return divide(
      this.evaluate(expression.numerator, set, keys),
      this.evaluate(expression.denominator, set, keys),
    );
  }

  /** The window the queries behind an expression read (they all read the same span). */
  bounds(expression: MeasureExpression | undefined): WindowBounds | undefined {
    const query = expression && this.queries.get(refs(expression)[0] ?? "")?.query;
    return query && queryBounds(query, this.context);
  }

  /**
   * Why an expression's window is empty, or undefined when it isn't: no_complete_day when its
   * horizon is after the window's start, else no_data.
   */
  empty(expression: MeasureExpression | undefined): EmptyWindow | undefined {
    const bounds = this.bounds(expression);
    if (bounds?.kind !== "bounded" || bounds.start !== bounds.end) return undefined;
    const horizon = this.horizon(expression);
    const start = fromLocal(parseInstant(bounds.start), this.context.timezone);
    return horizon !== undefined && horizon > start ? "no_complete_day" : "no_data";
  }

  /** A measure's horizon (UTC microseconds): the earliest of its queries'. */
  horizon(expression: MeasureExpression | undefined): bigint | undefined {
    let earliest: bigint | undefined;
    for (const id of expression ? refs(expression) : []) {
      const query = this.queries.get(id)?.query;
      const h = query && measureHorizon(query, this.context);
      if (h !== undefined && (earliest === undefined || h < earliest)) earliest = h;
    }
    return earliest;
  }

  /**
   * A time series cut at its measure's horizon (RFC 0001 section 6.5): buckets at or after it have
   * no value, and the bucket it falls inside is partial, with the share of it elapsed.
   */
  cut<T extends { values: Value[] }>(
    series: T,
    expression: MeasureExpression | undefined,
    buckets: string[],
    grain: ResolvedGrain,
    clipFrom?: string,
  ): T & { partial?: PartialBucket[] } {
    const at = this.horizon(expression);
    const clip = clipFrom === undefined ? undefined : parseInstant(clipFrom);
    if (at === undefined && clip === undefined) return series;
    const horizon = at === undefined ? undefined : toLocal(at, this.context.timezone);
    const partial: PartialBucket[] = [];
    const values = series.values.map((value, index) => {
      const start = parseInstant(buckets[index] ?? "");
      const end = parseInstant(bucketEnd(buckets[index] ?? "", grain));
      if (horizon !== undefined && start >= horizon) return null;
      const from = index === 0 && clip !== undefined && clip > start ? clip : start;
      const to = horizon !== undefined && horizon < end ? horizon : end;
      if (from > start || to < end) {
        partial.push({
          index,
          elapsed: Number(((to - from) * 1_000_000n) / (end - start)) / 1e6,
          ...(from > start ? { edge: "start" as const } : {}),
        });
      }
      return value;
    });
    return { ...series, values, ...(partial.length > 0 ? { partial } : {}) };
  }

  /**
   * A time-series block's incomplete option (RFC 0001 section 6.5): "mark" keeps each series'
   * partial buckets; "show" drops the markers, warning with HM4014 when a flow metric's last bucket
   * is partial; "hide" gives partial buckets no value and drops the leading and trailing buckets
   * that are then empty in every series, ending the axis window where the kept buckets do. hidden
   * lists the kept positions where a value was hidden, so a stack has no total there.
   */
  incomplete<S extends Series>(
    block: Block & { type: "line" | "area" | "bar" },
    plan: BlockPlan,
    axis: TimeAxis,
    series: S[],
  ): { axis: TimeAxis; series: S[]; hidden: number[] } {
    const mode = block.incomplete ?? "mark";
    if (mode === "mark") return { axis, series, hidden: [] };
    const plain = series.map(({ partial: _, ...rest }) => rest as S);
    if (mode === "show") {
      const flows = series.filter((s) => {
        const last = s.values.findLastIndex((v) => v !== null);
        const nature = timeNature(s.metric, this.metricSpecs());
        return nature === "flow" && (s.partial ?? []).some((p) => p.index === last);
      });
      const at = `${plan.pointer}/incomplete`;
      if (
        flows.length > 0 &&
        !this.diagnostics.some((d) => d.code === "HM4014" && d.pointer === at)
      ) {
        const file = this.project.dashboards.get(this.plan.dashboard);
        this.diagnostics.push({
          code: "HM4014",
          severity: "warning",
          message: `block "${plan.blockId}" shows its last ${axis.grain} as complete, but the data for "${flows[0]?.metric}" covers only part of it, so it reads low`,
          ...(file ? { file: file.file, pointer: at, ...file.document.locationOf(at) } : {}),
          help: 'use "mark" (the default) to show it as in progress, or "hide" to leave it out',
          docs: docsCommand("HM4014"),
        });
      }
      return { axis, series: plain, hidden: [] };
    }
    const hidden = series.map((s, k) => {
      const cut = new Set((s.partial ?? []).map((p) => p.index));
      return { ...plain[k], values: s.values.map((v, i) => (cut.has(i) ? null : v)) } as S;
    });
    const partialAt = new Set(series.flatMap((s) => (s.partial ?? []).map((p) => p.index)));
    const dropped = (i: number) => partialAt.has(i) && hidden.every((s) => s.values[i] === null);
    let first = 0;
    while (first < axis.buckets.length && dropped(first)) first++;
    let last = axis.buckets.length;
    while (last > first && dropped(last - 1)) last--;
    const { startAt, endAt, ...window } = axis.window;
    const start = first > 0 ? axis.buckets[first] : undefined;
    const end = last < axis.buckets.length ? axis.buckets[last] : undefined;
    return {
      axis: {
        ...axis,
        buckets: axis.buckets.slice(first, last),
        window: {
          ...window,
          ...(start !== undefined ? { start } : startAt !== undefined ? { startAt } : {}),
          ...(end !== undefined ? { end } : endAt !== undefined ? { endAt } : {}),
        },
      },
      series: hidden.map((s) => ({ ...s, values: s.values.slice(first, last) })),
      hidden: [...partialAt].filter((i) => i >= first && i < last).map((i) => i - first),
    };
  }

  private metricSpecs(): Map<string, Metric> {
    const specs = new Map<string, Metric>();
    for (const [name, file] of this.project.metrics) if (file.spec) specs.set(name, file.spec);
    return specs;
  }

  /** Distinct dimension values of a grouping set across queries, sorted by key. */
  keys(expressions: (MeasureExpression | undefined)[], set: number): Key[][] {
    const seen = new Map<string, Key[]>();
    for (const id of new Set(expressions.flatMap((e) => (e ? refs(e) : [])))) {
      for (const keys of this.queries.get(id)?.keys.get(set) ?? []) {
        seen.set(JSON.stringify(keys), keys);
      }
    }
    return [...seen.values()].sort(compareKeys);
  }

  timeAxis(expressions: (MeasureExpression | undefined)[], grain: ResolvedGrain): TimeAxis {
    const query = expressions[0] && this.queries.get(refs(expressions[0])[0] ?? "")?.query;
    const { asOfInstant, timezone } = this.context;
    const bounds =
      query &&
      windowAt(
        query,
        this.context,
        asOfInstant === undefined ? undefined : parseInstant(asOfInstant),
      );
    const window = span(bounds, timezone);
    if (window !== undefined) {
      return {
        kind: "time",
        grain: grain.unit,
        buckets: timeBuckets(window.start, window.end, grain),
        window,
      };
    }
    const observed = this.keys(expressions, 0)
      .map((keys) => keys[0])
      .filter((k): k is string => typeof k === "string");
    const last = [this.context.asOf, ...observed].sort().at(-1) ?? this.context.asOf;
    const endAt = bounds?.end?.endsWith("Z") ? wallAt(bounds.end, timezone) : undefined;
    const end = nextDay(endAt?.slice(0, 10) ?? last);
    const start = observed[0] ?? end;
    const buckets = timeBuckets(start, end, grain);
    return {
      kind: "time",
      grain: grain.unit,
      buckets,
      window: { start: buckets[0] ?? start, end, ...(endAt !== undefined ? { endAt } : {}) },
    };
  }

  splitSeries(
    metric: string,
    expression: MeasureExpression | undefined,
    positions: Key[],
    totalsSet: number,
    dims: number,
  ): Series[] {
    const splitAt = dims - 1;
    const values = this.keys([expression], 0).map((keys) => keys[splitAt] ?? null);
    const unique = [...new Map(values.map((v) => [JSON.stringify(v), v])).values()];
    const total = (v: Key): Value => {
      const keys: Key[] = Array.from({ length: dims }, () => null);
      keys[splitAt] = v;
      return this.evaluate(expression, totalsSet, keys);
    };
    const ordered = unique
      .map((value) => ({ value, total: total(value) }))
      .sort((a, b) => compareValues(a.total, b.total, "desc") || compareKey(a.value, b.value));
    const used = new Set<string>();
    return ordered.map(({ value }) => {
      const label = value === null ? "(empty)" : String(value);
      let key = `${metric}:${label}`;
      for (let n = 2; used.has(key); n++) key = `${metric}:${label}~${n}`;
      used.add(key);
      return {
        key,
        metric,
        label,
        splitValue: value,
        values: positions.map((p) =>
          this.evaluate(expression, 0, dims === 2 ? [p, value] : [value]),
        ),
      };
    });
  }

  metricSeries(
    names: string[],
    measures: Record<string, MeasureExpression>,
    positions: Key[],
  ): Series[] {
    return names.map((name) => ({
      key: name,
      metric: name,
      label: this.metric(name)?.label ?? name,
      values: positions.map((p) => this.evaluate(measures[name], 0, [p])),
    }));
  }

  /**
   * A stacked block's totals and shares (StackTotals). total(i) reads a split's per-position total
   * from rows; without it, the total is the sum of the series (several metrics). A 100% stack with a
   * negative value gets HM4061, since its shares no longer add up to 100%.
   */
  stacked(
    stack: boolean | "percent" | undefined,
    series: Series[],
    total: ((i: number) => Value) | undefined,
    plan: BlockPlan,
  ): { series: Series[]; extra: StackTotals } {
    if (!stack) return { series, extra: {} };
    const n = series[0]?.values.length ?? 0;
    const totals = Array.from({ length: n }, (_, i): Value => {
      if (total) return total(i);
      const values = series.map((s) => s.values[i] ?? null).filter((v) => v !== null);
      return values.length === 0 ? null : values.reduce((a, b) => a + b, 0);
    });
    if (stack === "percent") {
      const negative = series.find((s) => s.values.some((v) => v !== null && v < 0));
      if (negative) this.negativeShare(plan, `${plan.pointer}/stack`, negative.label);
    }
    return {
      series: series.map((s) => ({
        ...s,
        share: s.values.map((v, i) => divide(v, totals[i] ?? null)),
      })),
      extra: { totals, ...(stack === "percent" ? { percent: true as const } : {}) },
    };
  }

  /**
   * A stack's totals cut at the horizon of every stacked metric, like its series: a bucket past any
   * of them has no total and no shares, since a part of the whole is missing there. So has a
   * position in hidden, where incomplete "hide" left a value out.
   */
  cutTotals(
    stacked: { series: Series[]; extra: StackTotals },
    expressions: (MeasureExpression | undefined)[],
    buckets: string[],
    grain: ResolvedGrain,
    hidden: number[] = [],
  ): { series: Series[]; extra: StackTotals } {
    const { totals } = stacked.extra;
    if (totals === undefined) return stacked;
    const gone = new Set(hidden);
    const cut = expressions.reduce(
      (values, expression) => this.cut({ values }, expression, buckets, grain).values,
      totals.map((v, i) => (gone.has(i) ? null : v)),
    );
    return {
      series: stacked.series.map((s) =>
        s.share ? { ...s, share: s.share.map((v, i) => (cut[i] === null ? null : v)) } : s,
      ),
      extra: { ...stacked.extra, totals: cut },
    };
  }

  /** HM4061: a part-of-whole chart (100% stack) with a negative value. */
  negativeShare(plan: BlockPlan, pointer: string, label: string): void {
    const message = `block "${plan.blockId}" shows shares of a total, but "${label}" has negative values, so the shares do not add up to 100%`;
    if (this.diagnostics.some((d) => d.code === "HM4061" && d.message === message)) return;
    const file = this.project.dashboards.get(this.plan.dashboard);
    this.diagnostics.push({
      code: "HM4061",
      severity: "warning",
      message,
      ...(file ? { file: file.file, pointer, ...file.document.locationOf(pointer) } : {}),
      help: 'show the parts as "stack": true or grouped bars, or filter the metric to values that cannot be negative',
      docs: docsCommand("HM4061"),
    });
  }

  kpi(block: Block & { type: "kpi" }, plan: BlockPlan, common: Common): KpiData {
    const name = block.metric;
    const compare = block.compare ?? this.plan.period.compare;
    const empty = this.empty(plan.measures[name]);
    const current = empty ? null : this.evaluate(plan.measures[name], 0, []);
    const data: KpiData = {
      ...common,
      type: "kpi",
      metric: name,
      value: current,
      ...(empty ? { empty } : {}),
      compare,
    };
    const currentSpan = span(this.bounds(plan.measures[name]), this.context.timezone);
    if (currentSpan) data.current = currentSpan;
    const previousExpression = plan.previous?.[name];
    if (previousExpression && this.bounds(previousExpression) !== undefined) {
      const previousSpan = span(this.bounds(previousExpression), this.context.timezone);
      if (previousSpan) data.previous = previousSpan;
      const previous = this.empty(previousExpression)
        ? null
        : this.evaluate(previousExpression, 0, []);
      const change = current === null || previous === null ? null : current - previous;
      const points = this.metric(name)?.format.type === "percent";
      data.previousValue = previous;
      data.change = change;
      data.changePct = points
        ? change
        : change === null || previous === null || previous === 0
          ? null
          : change / Math.abs(previous);
      data.changeKind = points ? "points" : "relative";
    }
    const sparkline = plan.sparkline?.[name];
    if (sparkline) {
      const axis = this.timeAxis([sparkline], { unit: "month" });
      data.sparkline = this.cut(
        {
          grain: "month",
          buckets: axis.buckets,
          values: axis.buckets.map((b) => this.evaluate(sparkline, 0, [b])),
        },
        sparkline,
        axis.buckets,
        { unit: "month" },
      );
    }
    return data;
  }

  line(block: Block & { type: "line" | "area" }, plan: BlockPlan, common: Common): LineData {
    const clip = (axis: TimeAxis) => (block.edges === "clip" ? axis.window.start : undefined);
    const expressions = block.metrics.map((m) => plan.measures[m]);
    const axis = this.timeAxis(
      expressions,
      plan.grain ?? resolveGrain(block.grain, this.plan.anchors),
    );
    const [first = ""] = block.metrics;
    const stack = block.type === "area" ? block.stack : undefined;
    const grain = plan.grain ?? resolveGrain(block.grain, this.plan.anchors);
    const series = (
      block.split === undefined
        ? this.metricSeries(block.metrics, plan.measures, axis.buckets)
        : this.splitSeries(first, plan.measures[first], axis.buckets, stack ? 2 : 1, 2)
    ).map((one) => this.cut(one, plan.measures[one.metric], axis.buckets, grain, clip(axis)));
    const shown = this.incomplete(block, plan, axis, series);
    const stacked = this.cutTotals(
      this.stacked(
        stack,
        shown.series,
        block.split === undefined
          ? undefined
          : (i) => this.evaluate(plan.measures[first], 1, [shown.axis.buckets[i] ?? null, null]),
        plan,
      ),
      expressions,
      shown.axis.buckets,
      grain,
      shown.hidden,
    );
    return {
      ...common,
      type: block.type,
      ...(block.type === "area" ? { stack: Boolean(stack) } : {}),
      axis: shown.axis,
      series: stacked.series,
      ...stacked.extra,
    };
  }

  bar(block: Block & { type: "bar" }, plan: BlockPlan, common: Common): BarData {
    const clip = (axis: TimeAxis) => (block.edges === "clip" ? axis.window.start : undefined);
    const expressions = block.metrics.map((m) => plan.measures[m]);
    const [first = ""] = block.metrics;
    const split = block.split !== undefined;
    const base = {
      ...common,
      type: "bar" as const,
      orientation: block.orientation ?? "vertical",
      stack: Boolean(block.stack),
    };
    const stacked = (series: Series[], positions: Key[]) =>
      this.stacked(
        block.stack,
        series,
        split
          ? (i) => this.evaluate(plan.measures[first], 1, [positions[i] ?? null, null])
          : undefined,
        plan,
      );
    if (block.grain !== undefined) {
      const axis = this.timeAxis(
        expressions,
        plan.grain ?? resolveGrain(block.grain, this.plan.anchors),
      );
      const grain = plan.grain ?? resolveGrain(block.grain, this.plan.anchors);
      const shown = this.incomplete(
        block,
        plan,
        axis,
        (split
          ? this.splitSeries(first, plan.measures[first], axis.buckets, 2, 2)
          : this.metricSeries(block.metrics, plan.measures, axis.buckets)
        ).map((one) => this.cut(one, plan.measures[one.metric], axis.buckets, grain, clip(axis))),
      );
      const { series, extra } = this.cutTotals(
        stacked(shown.series, shown.axis.buckets),
        expressions,
        shown.axis.buckets,
        grain,
        shown.hidden,
      );
      return { ...base, axis: shown.axis, series, ...extra };
    }
    const column = block.by ?? "";
    const all = this.keys(expressions, 0).map((keys) => keys[0] ?? null);
    const categories = [...new Map(all.map((v) => [JSON.stringify(v), v])).values()];
    const sort = block.sort ?? { by: first, order: "desc" as const };
    const value = (c: Key): Value =>
      split
        ? this.evaluate(plan.measures[sort.by], 1, [c, null])
        : this.evaluate(plan.measures[sort.by], 0, [c]);
    const sorted =
      sort.by === column || plan.measures[sort.by] === undefined
        ? categories.sort((a, b) => compareKeyOrdered(a, b, sort.order))
        : categories
            .map((c) => ({ c, v: value(c) }))
            .sort((a, b) => compareValues(a.v, b.v, sort.order) || compareKey(a.c, b.c))
            .map(({ c }) => c);
    const shown = block.limit === undefined ? sorted : sorted.slice(0, block.limit);
    const axis: CategoryAxis = { kind: "category", column, categories: shown };
    const { series, extra } = stacked(
      split
        ? this.splitSeries(first, plan.measures[first], shown, 2, 2)
        : this.metricSeries(block.metrics, plan.measures, shown),
      shown,
    );
    const omitted = sorted.length - shown.length;
    return {
      ...base,
      axis,
      series,
      ...extra,
      ...(omitted > 0 ? { omittedCategories: omitted } : {}),
    };
  }

  /**
   * A time-series block with its grain switch: each grain's axis and series from that grain's
   * reading, and HM5001 for any grain past MAX_POINTS buckets.
   */
  series<T extends LineData | BarData>(
    block: Block & { type: "line" | "area" | "bar" },
    plan: BlockPlan,
    build: (block: Block & { type: "line" | "area" | "bar" }, plan: BlockPlan) => T,
  ): T {
    const data = build(block, plan);
    const variants = (plan.grains ?? []).map((g) => {
      const { axis, series, totals } = build(
        { ...block, grain: g.grain },
        { ...plan, grain: g.grain, measures: g.measures },
      );
      return { grain: g.grain, axis: axis as TimeAxis, series, totals };
    });
    const axes =
      variants.length > 0
        ? variants.map((v) => v.axis)
        : data.axis.kind === "time"
          ? [data.axis]
          : [];
    for (const axis of axes) {
      if (axis.buckets.length <= MAX_POINTS) continue;
      const file = this.project.dashboards.get(this.plan.dashboard);
      const pointer = `${plan.pointer}/${plan.grains === undefined ? "grain" : "grains"}`;
      this.diagnostics.push({
        code: "HM5001",
        severity: "warning",
        message: `block "${plan.blockId}" draws ${axis.buckets.length} ${axis.grain} points per series, more than ${MAX_POINTS}`,
        ...(file ? { file: file.file, pointer, ...file.document.locationOf(pointer) } : {}),
        help: "use a coarser grain or a shorter range",
        docs: docsCommand("HM5001"),
      });
    }
    if (plan.grains === undefined || plan.grain === undefined) return data;
    const labels = grainLabels(variants.map((v) => v.grain));
    const selected = grainKey(plan.grain);
    return {
      ...data,
      grains: {
        selected,
        options: variants.map((v, i) => ({
          key: grainKey(v.grain),
          label: labels[i] ?? v.grain.unit,
          axis: v.axis,
          series: v.series,
          ...(v.totals === undefined ? {} : { totals: v.totals }),
        })),
      },
    };
  }

  /**
   * A pie or donut: categories by value, the largest positive ones as slices and the rest of the
   * positive ones as Other; zero, negative and undefined categories are left out, with HM4061 for
   * negatives and HM5011 when Other outweighs every slice shown.
   */
  pie(block: Block & { type: "pie" | "donut" }, plan: BlockPlan, common: Common): PieData {
    const expression = plan.measures[block.metric];
    const limit = block.limit ?? PIE_DEFAULT_LIMIT;
    const emptyWindow = this.empty(expression);
    const rows = (emptyWindow ? [] : this.keys([expression], 0)).map((keys) => {
      const key = keys[0] ?? null;
      return {
        key,
        label: key === null ? "(empty)" : String(key),
        value: this.evaluate(expression, 0, [key]),
      };
    });
    const positive = rows
      .filter((r): r is typeof r & { value: number } => r.value !== null && r.value > 0)
      .sort((a, b) => b.value - a.value || compareKey(a.key, b.key));
    const negative = rows
      .filter((r): r is typeof r & { value: number } => r.value !== null && r.value < 0)
      .sort((a, b) => a.value - b.value || compareKey(a.key, b.key));
    const empty = rows.length - positive.length - negative.length;
    const whole = positive.reduce((sum, r) => sum + r.value, 0);
    const share = (v: number) => (whole === 0 ? 0 : v / whole);
    const slices: PieSlice[] = positive
      .slice(0, limit)
      .map((r) => ({ key: r.key, label: r.label, value: r.value, share: share(r.value) }));
    const rest = positive.slice(limit);
    const otherValue = rest.reduce((sum, r) => sum + r.value, 0);
    if (negative.length > 0) {
      const file = this.project.dashboards.get(this.plan.dashboard);
      const pointer = `${plan.pointer}/metric`;
      const names = negative.map((r) => `"${r.label}"`).join(", ");
      this.diagnostics.push({
        code: "HM4061",
        severity: "warning",
        message: `block "${plan.blockId}" leaves out ${negative.length === 1 ? "a negative category" : `${negative.length} negative categories`} (${names}): a ${block.type} shows parts of a whole, so its shares divide the positive categories only and the stated total still includes them`,
        ...(file ? { file: file.file, pointer, ...file.document.locationOf(pointer) } : {}),
        help: "show the categories as a bar chart, which draws negative values, or use a metric that cannot be negative",
        docs: docsCommand("HM4061"),
      });
    }
    if (rest.length > 0 && slices.every((s) => s.value < otherValue)) {
      const file = this.project.dashboards.get(this.plan.dashboard);
      const pointer = `${plan.pointer}/${block.limit === undefined ? "by" : "limit"}`;
      this.diagnostics.push({
        code: "HM5011",
        severity: "warning",
        message: `block "${plan.blockId}" groups ${rest.length} categories into "Other", which is larger than every slice shown (${Math.round(share(otherValue) * 100)}% of the whole)`,
        ...(file ? { file: file.file, pointer, ...file.document.locationOf(pointer) } : {}),
        help: 'show the categories as a horizontal bar chart with "limit", or group them into fewer categories',
        docs: docsCommand("HM5011"),
      });
    }
    const window = span(this.bounds(expression), this.context.timezone);
    return {
      ...common,
      type: block.type,
      metric: block.metric,
      column: block.by,
      slices,
      ...(rest.length > 0
        ? { other: { count: rest.length, value: otherValue, share: share(otherValue) } }
        : {}),
      total: emptyWindow ? null : this.evaluate(expression, 1, [null]),
      whole,
      ...(negative.length > 0 || empty > 0
        ? {
            excluded: {
              negative: negative.map((r) => ({ key: r.key, label: r.label, value: r.value })),
              empty,
            },
          }
        : {}),
      ...(window && !emptyWindow ? { window } : {}),
      ...(emptyWindow ? { empty: emptyWindow } : {}),
    };
  }

  table(block: Block & { type: "table" }, plan: BlockPlan, common: Common): TableData {
    const expressions = block.metrics.map((m) => plan.measures[m]);
    const percent = block.percentOfTotal ?? [];
    const width = block.by.length;
    const sets = tableGroupingSets(block);
    const setOf = (length: number) => sets.findIndex((s) => s.length === length);
    const pad = (keys: readonly Key[]): Key[] => [
      ...keys,
      ...Array.from({ length: width - keys.length }, () => null),
    ];
    const emptyOf = new Map(block.metrics.map((m) => [m, this.empty(plan.measures[m])]));
    const filled = block.metrics.filter((m) => emptyOf.get(m) === undefined);
    const empty = filled.length === 0 ? emptyOf.get(block.metrics[0] ?? "") : undefined;
    const value = (m: string, set: number, keys: Key[]) =>
      emptyOf.get(m) === undefined ? this.evaluate(plan.measures[m], set, keys) : null;
    const totalSet = setOf(0);
    const totals: Record<string, Value> = {};
    if (totalSet >= 0) for (const m of block.metrics) totals[m] = value(m, totalSet, pad([]));
    const shares = (values: Record<string, Value>): Record<string, Value> =>
      Object.fromEntries(percent.map((m) => [m, divide(values[m] ?? null, totals[m] ?? null)]));
    const row = (
      keys: Key[],
      get: (m: string) => Value,
      extra: Pick<TableRow, "kind" | "level" | "count"> = {},
    ): TableRow => {
      const values: Record<string, Value> = {};
      for (const m of block.metrics) values[m] = get(m);
      return { keys, ...extra, values, ...(percent.length > 0 ? { share: shares(values) } : {}) };
    };
    const leaves = this.keys(
      filled.map((m) => plan.measures[m]),
      0,
    ).map((keys) => row(keys, (m) => value(m, 0, keys)));
    if (totalSet >= 0) this.checkAdditive(block, common.id, leaves, totals);

    const sort = block.sort ?? { by: block.metrics[0] ?? "", order: "desc" as const };
    const column = block.by.indexOf(sort.by);
    const order = (a: TableRow, b: TableRow): number =>
      (column >= 0
        ? compareKeyOrdered(a.keys[column] ?? null, b.keys[column] ?? null, sort.order)
        : compareValues(a.values[sort.by] ?? null, b.values[sort.by] ?? null, sort.order)) ||
      compareKeys(a.keys, b.keys);
    /** The rows of one innermost group (or of the whole table): sorted, limited, then Other. */
    const cut = (members: TableRow[], parent: readonly Key[]): TableRow[] => {
      const sorted = members.sort(order);
      if (block.limit === undefined || sorted.length <= block.limit) return sorted;
      const rest = sorted.slice(block.limit);
      const folded = rest.map((r) => r.keys);
      return [
        ...sorted.slice(0, block.limit),
        ...(block.other === true
          ? [
              row(
                pad(parent),
                (m) =>
                  emptyOf.get(m) === undefined ? this.fold(plan.measures[m], 0, folded) : null,
                {
                  kind: "other",
                  count: rest.length,
                },
              ),
            ]
          : []),
      ];
    };
    /** A group's subtotal rows and rows, depth first; groups ordered like rows. */
    const nest = (members: TableRow[], parent: Key[]): TableRow[] => {
      const level = parent.length + 1;
      if (level === width) return cut(members, parent);
      const groups = new Map<string, { keys: Key[]; members: TableRow[] }>();
      for (const m of members) {
        const keys = m.keys.slice(0, level);
        const id = JSON.stringify(keys);
        const group = groups.get(id) ?? { keys, members: [] };
        group.members.push(m);
        groups.set(id, group);
      }
      const set = setOf(level);
      return [...groups.values()]
        .map((g) => ({
          ...g,
          subtotal: row(pad(g.keys), (m) => value(m, set, pad(g.keys)), {
            kind: "subtotal",
            level,
          }),
        }))
        .sort((a, b) => order(a.subtotal, b.subtotal))
        .flatMap((g) => [g.subtotal, ...nest(g.members, g.keys)]);
    };
    const subtotals = block.subtotals === true && width > 1;
    const rows = subtotals ? nest(leaves, []) : cut(leaves, []);
    const window = span(this.bounds(expressions[0]), this.context.timezone);
    return {
      ...common,
      type: "table",
      by: block.by.map((c) => ({ column: c, label: columnLabel(c) })),
      metrics: block.metrics,
      percentOfTotal: percent,
      sort,
      ...(block.bars !== undefined && block.bars.length > 0 ? { bars: block.bars } : {}),
      rows,
      rowCount: leaves.length,
      ...(subtotals ? { subtotals: true } : {}),
      ...(block.totals !== false
        ? { total: { values: totals, ...(percent.length > 0 ? { share: shares(totals) } : {}) } }
        : {}),
      ...(window ? { window } : {}),
      ...(empty ? { empty } : {}),
    };
  }

  /**
   * A scatter block: x, y and size per category of the by column, each evaluated from that
   * category's rows. Points without an x or y are counted (HM4070), never drawn at 0; negative sizes
   * get HM4071; past MAX_SCATTER_POINTS without an explicit limit, HM5022.
   */
  scatter(block: Block & { type: "scatter" }, plan: BlockPlan, common: Common): ScatterData {
    const expressions = [block.x, block.y, block.size].flatMap((m) =>
      m === undefined ? [] : [plan.measures[m]],
    );
    const emptyOf = new Map(
      [block.x, block.y, block.size].flatMap((m) =>
        m === undefined ? [] : [[m, this.empty(plan.measures[m])] as const],
      ),
    );
    const value = (metric: string, key: Key) =>
      emptyOf.get(metric) === undefined ? this.evaluate(plan.measures[metric], 0, [key]) : null;
    const empty = emptyOf.get(block.x) ?? emptyOf.get(block.y);
    const all: ScatterPoint[] = this.keys(expressions, 0).map(([key = null]) => ({
      key,
      label: key === null ? "(empty)" : String(key),
      x: value(block.x, key),
      y: value(block.y, key),
      ...(block.size === undefined ? {} : { size: value(block.size, key) }),
    }));
    const placed = all.filter((p) => p.x !== null && p.y !== null);
    const rank = (p: ScatterPoint) => (block.size === undefined ? p.y : (p.size ?? null));
    placed.sort((a, b) => compareValues(rank(a), rank(b), "desc") || compareKey(a.key, b.key));
    const limit = block.limit ?? MAX_SCATTER_POINTS;
    const points = placed.slice(0, limit);
    const omittedPoints = all.length - placed.length;
    const omittedCategories = placed.length - points.length;
    const warn = (
      code: "HM4070" | "HM4071" | "HM5022",
      key: string,
      message: string,
      help: string,
    ) => {
      const file = this.project.dashboards.get(this.plan.dashboard);
      const pointer = `${plan.pointer}${key}`;
      this.diagnostics.push({
        code,
        severity: "warning",
        message,
        ...(file ? { file: file.file, pointer, ...file.document.locationOf(pointer) } : {}),
        help,
        docs: docsCommand(code),
      });
    };
    if (omittedPoints > 0) {
      warn(
        "HM4070",
        "",
        `block "${plan.blockId}" leaves out ${omittedPoints} of ${all.length} ${all.length === 1 ? "category" : "categories"}, whose x or y has no value`,
        "pick metrics defined for every category, or narrow by to categories with data",
      );
    }
    if (
      block.size !== undefined &&
      points.some((p) => p.size !== undefined && p.size !== null && p.size < 0)
    ) {
      warn(
        "HM4071",
        "/size",
        `block "${plan.blockId}" sizes points by "${block.size}", which has negative values; they are drawn at the smallest size`,
        "size by a metric that is zero or more, or show the signed metric on an axis",
      );
    }
    if (block.limit === undefined && omittedCategories > 0) {
      warn(
        "HM5022",
        "/by",
        `block "${plan.blockId}" has ${placed.length} points; the ${MAX_SCATTER_POINTS} largest are drawn and ${omittedCategories} left out`,
        'set "limit" to keep fewer, or plot a coarser column',
      );
    }
    const bounds = [block.x, block.y, block.size].flatMap((m) =>
      m === undefined ? [] : [[m, this.bounds(plan.measures[m])] as const],
    );
    const endOf = (b: WindowBounds | undefined) =>
      b?.kind === "bounded" ? b.end : b?.kind === "unbounded" ? b.end : undefined;
    const window = bounds
      .map(([, b]) => span(b, this.context.timezone))
      .find((s) => s !== undefined);
    const openEnd = window
      ? undefined
      : bounds.map(([, b]) => endOf(b)).find((e) => e !== undefined);
    const before =
      openEnd === undefined
        ? undefined
        : span({ kind: "bounded", start: openEnd, end: openEnd }, this.context.timezone)?.end;
    const through =
      before === undefined
        ? undefined
        : new Date(Date.parse(`${before}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
    const allTime =
      window || through ? bounds.filter(([, b]) => endOf(b) === undefined).map(([m]) => m) : [];
    return {
      ...common,
      type: "scatter",
      x: block.x,
      y: block.y,
      ...(block.size === undefined ? {} : { size: block.size }),
      column: block.by,
      points,
      ...(omittedPoints > 0 ? { omittedPoints } : {}),
      ...(omittedCategories > 0 ? { omittedCategories } : {}),
      ...(window && !empty ? { window } : {}),
      ...(through && !empty ? { through } : {}),
      ...(allTime.length > 0 && !empty ? { allTime } : {}),
      ...(empty ? { empty } : {}),
    };
  }

  /** HM4003: a SQL metric declared additive whose rows do not add up to the recomputed total. */
  private checkAdditive(
    block: Block & { type: "table" },
    id: string,
    rows: TableRow[],
    totals: Record<string, Value>,
  ): void {
    for (const name of block.metrics) {
      const file = this.project.metrics.get(name);
      if (file?.spec?.type !== "sql" || !file.spec.additive) continue;
      const total = totals[name] ?? null;
      const sum = rows.reduce((acc, row) => acc + (row.values[name] ?? 0), 0);
      if (total === null || Math.abs(sum - total) <= 1e-9 * Math.max(1, Math.abs(total))) continue;
      const pointer = "/additive";
      this.diagnostics.push({
        code: "HM4003",
        severity: "warning",
        message: `metric "${name}" is declared additive, but the rows of table "${id}" add up to ${sum}, not the total ${total}`,
        file: file.file,
        pointer,
        ...file.document.locationOf(pointer),
        help: 'set "additive": false unless the SQL is a sum or a count',
        docs: docsCommand("HM4003"),
      });
    }
  }

  dashboardPeriod(): { range: RangeSpec; compare: QueryPlan["period"]["compare"] } {
    const param = this.plan.params.find((p) => p.kind === "period");
    const range = effectiveRange(
      this.plan.period.range,
      param?.kind === "period" ? param : undefined,
      this.context.bindings,
    );
    return { range, compare: this.plan.period.compare };
  }
}

type Common = { id: string; title?: string; span: number };

/** A column's header text: underscores as spaces, first letter capitalized ("ship_country"). */
const MAX_POINTS = 1000;
const MAX_SCATTER_POINTS = 500;

const UNIT_LABELS = { day: "Day", week: "Week", month: "Month", quarter: "Quarter", year: "Year" };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Control text per grain: the unit, with its anchor ("Year from Jul 1") when two share a unit. */
export function grainLabels(grains: ResolvedGrain[]): string[] {
  return grains.map((g) => {
    const unit = UNIT_LABELS[g.unit];
    if (!("anchor" in g) || grains.filter((o) => o.unit === g.unit).length < 2) return unit;
    const anchor =
      g.unit === "week"
        ? `${g.anchor.charAt(0).toUpperCase()}${g.anchor.slice(1, 3)}`
        : `${MONTHS[Number(g.anchor.slice(0, 2)) - 1]} ${Number(g.anchor.slice(3))}`;
    return `${unit} from ${anchor}`;
  });
}

/** DashboardData.grainFilter from the dashboard's grain filter, resolved at the project anchors. */
function grainFilter(
  filters: DashboardFilter[] | undefined,
  plan: QueryPlan,
): { grainFilter: NonNullable<DashboardData["grainFilter"]> } | Record<string, never> {
  const filter = filters?.find((f) => f.type === "grain");
  if (filter === undefined) return {};
  const options = filter.options.map((g) => resolveGrain(g, plan.anchors));
  const labels = grainLabels(options);
  return {
    grainFilter: {
      id: filter.id,
      label: filter.label ?? "Grain",
      options: options.map(
        (g, i): GrainOption => ({ key: grainKey(g), label: labels[i] ?? g.unit }),
      ),
      selected: grainKey(resolveGrain(filter.default, plan.anchors)),
    },
  };
}

function columnLabel(column: string): string {
  const text = column.replaceAll("_", " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Turns a plan and its query results into DashboardData. Pure and deterministic: the same plan,
 * results and context give the same data, byte for byte. Totals come from each query's grand
 * total grouping set, never from summing rows; ratio rows match on grouping set and dimension
 * values with null as a real value; limit cuts leaf rows only.
 */
export function assemble(
  project: Project,
  plan: QueryPlan,
  results: ReadonlyMap<string, QueryResult>,
  context: ExecutionContext,
): { data?: DashboardData; diagnostics: Diagnostic[] } {
  const spec = project.dashboards.get(plan.dashboard)?.spec;
  const config = project.config.spec;
  if (spec === undefined || config === undefined) return { diagnostics: [] };
  const assembler = new Assembler(project, plan, results, context);
  const period = assembler.dashboardPeriod();
  const blocks: BlockData[] = [];
  const shown = new Set<string>();
  for (const blockPlan of plan.blocks) {
    const at = spec.blocks.findIndex((b, i) => blockId(b, i) === blockPlan.blockId);
    const block = spec.blocks[at];
    if (block === undefined) continue;
    const common: Common = {
      id: blockPlan.blockId,
      ...(block.title === undefined ? {} : { title: block.title }),
      span: block.span ?? (block.type === "kpi" ? 3 : 12),
    };
    if (block.type === "kpi") {
      shown.add(block.metric);
      blocks.push(assembler.kpi(block, blockPlan, common));
    } else if (block.type === "line" || block.type === "area") {
      for (const m of block.metrics) shown.add(m);
      blocks.push(
        assembler.series(block, blockPlan, (b, p) => assembler.line(b as typeof block, p, common)),
      );
    } else if (block.type === "bar") {
      for (const m of block.metrics) shown.add(m);
      blocks.push(
        assembler.series(block, blockPlan, (b, p) => assembler.bar(b as typeof block, p, common)),
      );
    } else if (block.type === "pie" || block.type === "donut") {
      shown.add(block.metric);
      blocks.push(assembler.pie(block, blockPlan, common));
    } else if (block.type === "table") {
      for (const m of block.metrics) shown.add(m);
      blocks.push(assembler.table(block, blockPlan, common));
    } else if (block.type === "scatter") {
      shown.add(block.x).add(block.y);
      if (block.size !== undefined) shown.add(block.size);
      blocks.push(assembler.scatter(block, blockPlan, common));
    }
  }

  const metrics: Record<string, MetricInfo> = {};
  for (const name of [...shown].sort()) {
    const metric = assembler.metric(name);
    if (metric === undefined) continue;
    metrics[name] = {
      name,
      label: metric.label,
      ...(metric.description === undefined ? {} : { description: metric.description }),
      format:
        metric.format.type === "currency"
          ? { ...metric.format, currency: metric.format.currency ?? config.currency }
          : metric.format,
      better: metric.better,
    };
  }

  const current = span(
    resolveRange(period.range, "none", context.asOf, plan.anchors),
    context.timezone,
  );
  const previous =
    period.compare === "none"
      ? undefined
      : span(
          resolveRange(period.range, period.compare, context.asOf, plan.anchors),
          context.timezone,
        );
  const data: DashboardData = {
    version: DASHBOARD_DATA_VERSION,
    name: plan.dashboard,
    title: spec.title,
    ...(spec.description === undefined ? {} : { description: spec.description }),
    project: config.name,
    asOf: context.asOf,
    horizons: context.horizons ?? [],
    period: {
      range: period.range,
      compare: period.compare,
      ...(current ? { current } : {}),
      ...(previous ? { previous } : {}),
    },
    locale: config.locale,
    currency: config.currency,
    timezone: plan.timezone,
    anchors: plan.anchors,
    ...grainFilter(spec.filters, plan),
    metrics,
    blocks,
  };
  return { data, diagnostics: assembler.diagnostics };
}
