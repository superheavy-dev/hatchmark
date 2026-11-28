import { type Diagnostic, docsCommand } from "../diagnostics/index.js";
import { proratedTargetNote } from "../spec/graph.js";
import type {
  Block,
  DashboardFilter,
  Metric,
  Project,
  RangeSpec,
  ResolvedGrain,
} from "../spec/index.js";
import type { HeightPreset } from "../spec/layout.js";
import { blockId, grainKey, PIE_DEFAULT_LIMIT, resolveGrain } from "../spec/units.js";
import {
  type BarData,
  type BlockData,
  type BlockTarget,
  type CategoryAxis,
  DASHBOARD_DATA_VERSION,
  type DashboardData,
  type DateSpan,
  type EmptyWindow,
  type GrainOption,
  type KpiData,
  type KpiTarget,
  type LineData,
  type MapData,
  type MapMatch,
  type MapRegion,
  type MetricInfo,
  type PartialBucket,
  type PeriodFilter,
  type PeriodOption,
  type PieData,
  type PieSlice,
  type ScatterData,
  type ScatterPoint,
  type Series,
  type SeriesGroup,
  type SeriesTarget,
  type StackTotals,
  type TableData,
  type TableRow,
  type TargetHidden,
  type TimeAxis,
  type Value,
} from "./dashboard-data.js";
import { formatWall, lastWallBefore, parseInstant, toLocal } from "./instants.js";
import { classOf, mapScale } from "./map-scale.js";
import { segmentValues, selectValues } from "./params.js";
import { rangeKey, rangeName } from "./periods.js";
import type {
  BlockPlan,
  ExecutionContext,
  MeasureExpression,
  PlannedParam,
  PlannedQuery,
  PlannedTarget,
  QueryPlan,
  QueryResult,
} from "./plan.js";
import { tableGroupingSets } from "./planner.js";
import { elapsedShare, flowTarget, pointTarget, targetBuckets } from "./targets.js";
import {
  boundInstant,
  bucketEnd,
  effectiveRange,
  measureHorizon,
  NAMED,
  nextDay,
  queryBounds,
  resolveRange,
  timeBuckets,
  type WindowBounds,
  windowAt,
} from "./windows.js";

const DAY_NS = 86_400_000_000_000n;

type Key = string | number | boolean | null;

interface IndexedQuery {
  query: PlannedQuery;
  rows: Map<string, unknown[]>;
  keys: Map<number, Key[][]>;
  components: Map<string, number>;
  empty: Record<string, number | null>;
}

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
  return { query, rows, keys, components, empty: result.empty ?? {} };
}

function divide(a: Value, b: Value): Value {
  return a === null || b === null || b === 0 ? null : a / b;
}

const TYPE_RANK = { boolean: 0, number: 1, string: 2 } as const;

type CompareText = (a: string, b: string) => number;

/**
 * How text keys compare: by a given order of every text (a page's embedded build order), or by
 * the project locale's collation, in en-US when this runtime cannot collate in that locale.
 */
export function textComparer(locale: string, order?: readonly string[]): CompareText {
  if (order !== undefined) {
    const rank = new Map(order.map((text, i) => [text, i]));
    return (a, b) => (rank.get(a) ?? order.length) - (rank.get(b) ?? order.length);
  }
  const supported = Intl.Collator.supportedLocalesOf(locale).length > 0;
  return new Intl.Collator(supported ? locale : "en-US", { numeric: true }).compare;
}

function compareKey(a: Key, b: Key, compareText: CompareText): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  const ta = TYPE_RANK[typeof a as keyof typeof TYPE_RANK];
  const tb = TYPE_RANK[typeof b as keyof typeof TYPE_RANK];
  if (ta !== tb) return ta - tb;
  if (typeof a === "string" && typeof b === "string") {
    return compareText(a, b) || (a < b ? -1 : 1);
  }
  return a < b ? -1 : 1;
}

function compareKeys(a: readonly Key[], b: readonly Key[], compareText: CompareText): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const c = compareKey(a[i] ?? null, b[i] ?? null, compareText);
    if (c !== 0) return c;
  }
  return 0;
}

function compareKeyOrdered(
  a: Key,
  b: Key,
  order: "asc" | "desc",
  compareText: CompareText,
): number {
  if (a === null || b === null) return compareKey(a, b, compareText);
  return order === "asc" ? compareKey(a, b, compareText) : compareKey(b, a, compareText);
}

function compareValues(a: Value, b: Value, order: "asc" | "desc"): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return order === "asc" ? a - b : b - a;
}

const wallAt = (bound: string, timezone: string) =>
  formatWall(toLocal(parseInstant(bound), timezone));

const atMidnight = (wall: string) => wall.endsWith("T00:00:00.000000");

const dayEnding = (wall: string) =>
  atMidnight(wall) ? wall.slice(0, 10) : nextDay(wall.slice(0, 10));

function span(bounds: WindowBounds | undefined, timezone: string): DateSpan | undefined {
  if (bounds?.kind !== "bounded") return undefined;
  const { start, end } = bounds;
  const startWall = start.endsWith("Z") ? wallAt(start, timezone) : undefined;
  const endWall = end.endsWith("Z") ? wallAt(end, timezone) : undefined;
  const startAt = startWall !== undefined && !atMidnight(startWall) ? startWall : undefined;
  const endAt = endWall !== undefined && !atMidnight(endWall) ? endWall : undefined;
  return {
    start: startWall === undefined ? start : startWall.slice(0, 10),
    end: endWall === undefined ? end : dayEnding(endWall),
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
    private readonly compareText: CompareText,
  ) {
    for (const query of plan.queries) {
      const result = results.get(query.id);
      if (result) this.queries.set(query.id, index(query, result));
    }
  }

  metric(name: string): Metric | undefined {
    return this.project.metrics.get(name)?.spec;
  }

  private measure(queryId: string, metric: string, key: string): Value {
    return this.measureOver(queryId, metric, [key], false);
  }

  private measureOver(queryId: string, metric: string, keys: string[], fold: boolean): Value {
    const indexed = this.queries.get(queryId);
    const measure = indexed?.query.measures.find((m) => m.metric === metric);
    if (indexed === undefined || measure === undefined) return null;
    const { combine } = measure;
    const rowsAt = measure.rows === undefined ? undefined : indexed.components.get(measure.rows);
    const gapless = indexed.query.evaluation === undefined;
    const component = (id: string): Value => {
      const at = indexed.components.get(id);
      const reaggregate = measure.components.find((c) => c.id === id)?.reaggregate ?? "none";
      const empty = id in indexed.empty ? indexed.empty[id] : 0;
      const values = keys.map((key) => {
        const row = indexed.rows.get(key);
        if (row !== undefined && rowsAt !== undefined && row[rowsAt] === 0) return 0;
        const raw = row === undefined || at === undefined ? null : row[at];
        const value = typeof raw === "number" ? raw : null;
        return value === null && reaggregate === "sum" && row === undefined && gapless
          ? (empty ?? null)
          : value;
      });
      if (!fold) return values[0] ?? null;
      const present = values.filter((v): v is number => v !== null);
      if (reaggregate === "none" || present.length === 0 || empty !== 0) return null;
      if (reaggregate === "min") return present.reduce((m, v) => Math.min(m, v));
      if (reaggregate === "max") return present.reduce((m, v) => Math.max(m, v));
      return present.reduce((sum, v) => sum + v, 0);
    };
    return combine.op === "identity"
      ? component(combine.component)
      : divide(component(combine.numerator), component(combine.denominator));
  }

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

  bounds(expression: MeasureExpression | undefined): WindowBounds | undefined {
    const query = expression && this.queries.get(refs(expression)[0] ?? "")?.query;
    return query && queryBounds(query, this.context);
  }

  empty(expression: MeasureExpression | undefined): EmptyWindow | undefined {
    const bounds = this.bounds(expression);
    if (bounds?.kind !== "bounded" || bounds.start !== bounds.end) return undefined;
    const horizon = this.horizon(expression);
    const start = boundInstant(bounds.start, this.context.timezone);
    return horizon !== undefined && horizon > start ? "no_complete_day" : "no_data";
  }

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
    const spans = this.spans(expression, buckets, grain, clipFrom);
    if (spans === undefined) return series;
    const partial: PartialBucket[] = [];
    const values = series.values.map((value, index) => {
      const span = spans[index];
      if (span === undefined || span === null) return null;
      const { start, end, from, to } = span;
      if (from > start || to < end) {
        partial.push({
          index,
          elapsed: Number(((to - from) * 1_000_000n) / (end - start)) / 1e6,
          ...(from > start ? { edge: "start" as const } : {}),
          days: Number((to - 1n) / DAY_NS - from / DAY_NS) + 1,
          ...(to < end ? { through: formatWall(to).slice(0, 19) } : {}),
        });
      }
      return value;
    });
    return { ...series, values, ...(partial.length > 0 ? { partial } : {}) };
  }

  /**
   * What a time series reads of each bucket [start, end), in local wall-clock nanoseconds: from a
   * clipped window start or the bucket start, to the measure's horizon or the bucket end; null for
   * a bucket at or after the horizon. Undefined when there is neither a horizon nor a clip.
   */
  private spans(
    expression: MeasureExpression | undefined,
    buckets: string[],
    grain: ResolvedGrain,
    clipFrom?: string,
  ): ({ start: bigint; end: bigint; from: bigint; to: bigint } | null)[] | undefined {
    const at = this.horizon(expression);
    const clip = clipFrom === undefined ? undefined : parseInstant(clipFrom);
    if (at === undefined && clip === undefined) return undefined;
    const horizon = at === undefined ? undefined : toLocal(at, this.context.timezone);
    const lastRead = at === undefined ? undefined : lastWallBefore(at, this.context.timezone);
    return buckets.map((bucket, index) => {
      const start = parseInstant(bucket);
      const end = parseInstant(bucketEnd(bucket, grain));
      const from = index === 0 && clip !== undefined && clip > start ? clip : start;
      if (
        horizon !== undefined &&
        from >= horizon &&
        !(lastRead !== undefined && lastRead >= from)
      ) {
        return null;
      }
      const cut = horizon !== undefined && horizon < end ? horizon : end;
      const to = cut <= from && lastRead !== undefined ? lastRead + 1n : cut;
      return { start, end, from, to };
    });
  }

  /**
   * A time-series block's incomplete option (RFC 0001 section 6.5): "mark" keeps each series'
   * partial buckets; "show" drops the markers (executionContext warns with HM4014 when a flow
   * metric's last bucket is partial); "hide" gives partial buckets no value and drops the leading
   * buckets that are then empty in every series and the trailing ones that are also partial or past
   * every series' horizon, ending the axis window where the kept buckets do. hidden
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
    if (mode === "show") return { axis, series: plain, hidden: [] };
    const hidden = series.map((s, k) => {
      const cut = new Set((s.partial ?? []).map((p) => p.index));
      return { ...plain[k], values: s.values.map((v, i) => (cut.has(i) ? null : v)) } as S;
    });
    const partialAt = new Set(series.flatMap((s) => (s.partial ?? []).map((p) => p.index)));
    const horizons = series.map((s) => this.horizon(plan.measures[s.metric]));
    const past = (i: number) => {
      const bucket = axis.buckets[i] ?? "";
      const from = i === 0 && axis.window.start > bucket ? axis.window.start : bucket;
      return horizons.every(
        (h) => h !== undefined && parseInstant(from) >= toLocal(h, this.context.timezone),
      );
    };
    const empty = (i: number) => hidden.every((s) => s.values[i] === null);
    let first = 0;
    while (first < axis.buckets.length && (partialAt.has(first) || past(first)) && empty(first)) {
      first++;
    }
    let last = axis.buckets.length;
    while (last > first && (partialAt.has(last - 1) || past(last - 1)) && empty(last - 1)) last--;
    const { startAt, endAt, ...window } = axis.window;
    const start = first > 0 && first < last ? axis.buckets[first] : undefined;
    const end =
      first === last
        ? (start ?? window.start)
        : last < axis.buckets.length
          ? axis.buckets[last]
          : undefined;
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

  keys(expressions: (MeasureExpression | undefined)[], set: number): Key[][] {
    const seen = new Map<string, Key[]>();
    for (const id of new Set(expressions.flatMap((e) => (e ? refs(e) : [])))) {
      for (const keys of this.queries.get(id)?.keys.get(set) ?? []) {
        seen.set(JSON.stringify(keys), keys);
      }
    }
    return [...seen.values()].sort((a, b) => compareKeys(a, b, this.compareText));
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
    const endWall = bounds?.end?.endsWith("Z") ? wallAt(bounds.end, timezone) : undefined;
    const end = endWall === undefined ? nextDay(last) : dayEnding(endWall);
    const start = observed[0] ?? end;
    const buckets = timeBuckets(start, end, grain);
    return {
      kind: "time",
      grain: grain.unit,
      buckets,
      window: {
        start: buckets[0] ?? start,
        end,
        ...(endWall !== undefined && !atMidnight(endWall) ? { endAt: endWall } : {}),
      },
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
      .sort(
        (a, b) =>
          compareValues(a.total, b.total, "desc") || compareKey(a.value, b.value, this.compareText),
      );
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

  tagGroups(
    block: Block & { type: "line" | "area" | "bar" },
    plan: BlockPlan,
    series: Series[],
  ): Series[] {
    const groups = block.groups;
    if (groups === undefined) return series;
    const nameOf = (s: Series) => (block.split === undefined ? s.metric : s.label);
    const labelOf = (v: Key) => (v === null ? "(empty)" : String(v));
    const domain =
      plan.domain === undefined
        ? undefined
        : this.keys(Object.values(plan.domain), 0).map((keys) => keys[0] ?? null);
    const claimed: Key[] = [];
    const owner = new Map<Series, { index: number; step: number }>();
    groups.forEach((g, index) => {
      g.series.forEach((member, step) => {
        const name = String(member);
        const candidates = series.filter((s) => nameOf(s) === name && !owner.has(s));
        const values = domain?.filter((v) => labelOf(v) === name && !claimed.includes(v));
        const value = values?.includes(null) ? null : values?.[0];
        if (value !== undefined) claimed.push(value);
        if (value === null && values?.includes(name)) {
          this.groupWarning(
            plan,
            index,
            step,
            `group "${g.label}" names "(empty)", which matches both empty values and the text "(empty)" in "${block.split}"; the group takes the empty values`,
            `rename the text "(empty)" in the data, or list the series it names in no group`,
          );
        }
        const match =
          domain === undefined
            ? (candidates.find((s) => s.splitValue === null) ?? candidates[0])
            : candidates.find((s) => s.splitValue === value);
        if (match !== undefined) {
          owner.set(match, { index, step });
          return;
        }
        if (block.split === undefined || value !== undefined) return;
        this.groupWarning(
          plan,
          index,
          step,
          `group "${g.label}" names "${name}", which "${block.split}" has no rows for`,
          `check the spelling against the values of "${block.split}"; the group keeps this series' colour step`,
        );
      });
    });
    const free = domain?.filter((v) => !claimed.includes(v)) ?? [];
    return series.map((s) => {
      const group = owner.get(s);
      if (group !== undefined) return { ...s, group };
      const rank = s.splitValue === undefined ? -1 : free.indexOf(s.splitValue);
      return rank < 0 ? s : { ...s, colorRank: rank };
    });
  }

  groupWarning(plan: BlockPlan, index: number, step: number, message: string, help: string): void {
    if (this.diagnostics.some((d) => d.code === "HM2027" && d.message === message)) return;
    const file = this.project.dashboards.get(this.plan.dashboard);
    const pointer = `${plan.pointer}/groups/${index}/series/${step}`;
    this.diagnostics.push({
      code: "HM2027",
      severity: "warning",
      message,
      ...(file ? { file: file.file, pointer, ...file.document.locationOf(pointer) } : {}),
      help,
      docs: docsCommand("HM2027"),
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

  negativeShare(plan: BlockPlan, pointer: string, label: string): void {
    const message = `block "${plan.blockId}" shows shares of a total, but "${label}" has negative values, so the shares do not add up to 100%`;
    if (this.diagnostics.some((d) => d.code === "HM4061" && d.message === message)) return;
    const file = this.project.dashboards.get(this.plan.dashboard);
    this.diagnostics.push({
      code: "HM4061",
      severity: "warning",
      message,
      ...(file ? { file: file.file, pointer, ...file.document.locationOf(pointer) } : {}),
      help: "show the parts as stack: true or grouped bars, or filter the metric to values that cannot be negative",
      docs: docsCommand("HM4061"),
    });
  }

  private targetRows(planned: PlannedTarget): { date: string; keys: Key[]; value: number }[] {
    if ("inline" in planned.values) {
      return Object.entries(planned.values.inline).map(([date, value]) => ({
        date,
        keys: [],
        value,
      }));
    }
    const indexed = this.queries.get(planned.values.queryId);
    if (indexed === undefined) return [];
    const [sum, count] = indexed.query.measures[0]?.components ?? [];
    const at = indexed.components.get(sum?.id ?? "");
    const counted = indexed.components.get(count?.id ?? "");
    return (indexed.keys.get(0) ?? []).flatMap((keys) => {
      const row = indexed.rows.get(rowKey(0, keys));
      const value = row === undefined || at === undefined ? null : row[at];
      const present = row === undefined || counted === undefined ? 0 : row[counted];
      const [date, ...rest] = keys;
      return typeof date === "string" &&
        typeof value === "number" &&
        Number.isFinite(value) &&
        typeof present === "number" &&
        present > 0
        ? [{ date: date.slice(0, 10), keys: rest, value }]
        : [];
    });
  }

  /** A target's values by bucket start, over the rows whose dimensions equal select's keys. */
  private targetValues(planned: PlannedTarget, select: Record<string, Key>): Map<string, number> {
    const dims = "inline" in planned.values ? [] : planned.values.dimensions;
    const rows = this.targetRows(planned).filter((row) =>
      Object.entries(select).every(([column, key]) => {
        const i = dims.indexOf(column);
        return i < 0 || row.keys[i] === key;
      }),
    );
    return targetBuckets(rows, planned.grain);
  }

  /**
   * Why a target does not apply under this execution's filters (RFC 0001 section 7): a select
   * filter keeps some values in the metric's rows but not in the target's, or a segment is on in
   * the metric's rows that the target cannot follow.
   */
  private targetHidden(
    planned: PlannedTarget,
    expression: MeasureExpression | undefined,
  ): TargetHidden | undefined {
    const own =
      "queryId" in planned.values ? this.queries.get(planned.values.queryId)?.query : undefined;
    const { bindings } = this.context;
    for (const id of expression ? refs(expression) : []) {
      for (const p of this.queries.get(id)?.query.params ?? []) {
        if (p.kind === "select") {
          if (selectValues(p, bindings).length === 0) continue;
          if (!own?.params.some((t) => t.kind === "select" && t.id === p.id)) return "filter";
        } else if (p.kind === "segment") {
          const on = segmentValues(p, bindings).filter((n) => p.segments.some((s) => s.name === n));
          if (on.length === 0) continue;
          if (planned.segments !== undefined) {
            if (on.some((n) => !planned.segments?.includes(n))) return "segment";
            continue;
          }
          const bound = own?.params.find((t) => t.kind === "segment" && t.id === p.id);
          const follows = (n: string) =>
            bound?.kind === "segment" && bound.segments.some((s) => s.name === n);
          if (!on.every(follows)) return "segment";
        }
      }
    }
    return undefined;
  }

  /**
   * A target over a KPI's or category's window. A point-in-time target is read at the window's
   * end. A flow target covers the window's period: a to-date range's whole bucket, the window
   * itself for last N units, else the range as written. When the window ends before its period
   * does, pace is the target times the share of the period the window covers (elapsedShare), for
   * a metric that adds up over time only.
   */
  private windowTarget(
    planned: PlannedTarget,
    expression: MeasureExpression | undefined,
    select: Record<string, Key>,
  ): { value: Value; pace?: number; prorated: boolean } {
    const none = { value: null, prorated: false };
    const query = expression && this.queries.get(refs(expression)[0] ?? "")?.query;
    const bounds = this.bounds(expression);
    if (query === undefined || bounds === undefined || query.window.column === undefined) {
      return none;
    }
    const values = this.targetValues(planned, select);
    const local = (bound: string) =>
      bound.endsWith("Z")
        ? toLocal(parseInstant(bound), this.context.timezone)
        : parseInstant(bound);
    const localDate = (bound: string) => formatWall(local(bound)).slice(0, 10);
    if (planned.kind === "point") {
      if (bounds.end === undefined) return none;
      return { value: pointTarget(values, planned, local(bounds.end)), prorated: false };
    }
    if (bounds.kind !== "bounded") return none;
    const param = query.params.find(
      (p): p is PlannedParam & { kind: "period" } =>
        p.kind === "period" && p.column === query.window.column,
    );
    const range = effectiveRange(query.window.range, param, this.context.bindings);
    const base =
      range === "all_time"
        ? undefined
        : resolveRange(range, "none", this.context.asOf, this.plan.anchors);
    if (range === "all_time" || base?.kind !== "bounded") return none;
    const spec = typeof range === "string" ? NAMED[range] : range;
    const period =
      "to_date" in spec
        ? {
            start: base.start,
            end: bucketEnd(base.start, resolveGrain(spec.to_date, this.plan.anchors)),
          }
        : "last" in spec
          ? { start: localDate(bounds.start), end: localDate(bounds.end) }
          : base;
    const full = flowTarget(values, planned, period.start, period.end);
    if (full.value === null) return full;
    const start = parseInstant(period.start);
    const stop = parseInstant(period.end);
    const end = "to_date" in spec ? local(bounds.end) : parseInstant(localDate(bounds.end));
    if (end >= stop || planned.additive !== true) return full;
    return { ...full, pace: full.value * elapsedShare(start, end, start, stop) };
  }

  /**
   * A target at each bucket of a time axis. A flow target covers each bucket (flowTarget), with
   * pace in the buckets the measure's horizon or a clipped start makes partial when the metric adds
   * up over time. A point-in-time
   * target is read at each bucket's end, and at the horizon in the bucket it cuts.
   */
  private timeTarget(
    planned: PlannedTarget,
    expression: MeasureExpression | undefined,
    axis: TimeAxis,
    grain: ResolvedGrain,
    clip: string | undefined,
    select: Record<string, Key>,
  ): { target: SeriesTarget; prorated: boolean } {
    const values = this.targetValues(planned, select);
    const { buckets } = axis;
    const spans = this.spans(expression, buckets, grain, clip) ?? [];
    const horizon = this.horizon(expression);
    const at = horizon === undefined ? undefined : toLocal(horizon, this.context.timezone);
    let prorated = false;
    const cells = buckets.map((bucket, i) => {
      const end = bucketEnd(bucket, grain);
      if (planned.kind === "point") {
        const stop = parseInstant(end);
        const read = at !== undefined && at > parseInstant(bucket) && at < stop ? at : stop;
        return { value: pointTarget(values, planned, read), pace: null };
      }
      const flow = flowTarget(values, planned, bucket, end);
      prorated ||= flow.prorated;
      const span = spans[i];
      const partial = span && (span.from > span.start || span.to < span.end);
      return {
        value: flow.value,
        pace:
          !partial || flow.value === null || planned.additive !== true
            ? null
            : flow.value * elapsedShare(span.from, span.to, span.start, span.end),
      };
    });
    const pace = cells.map((c) => c.pace);
    return {
      target: {
        values: cells.map((c) => c.value),
        ...(pace.some((v) => v !== null) ? { pace } : {}),
      },
      prorated,
    };
  }

  /** A target at each category: the target over the window of the category's rows. */
  private categoryTarget(
    planned: PlannedTarget,
    expression: MeasureExpression | undefined,
    column: string,
    categories: Key[],
    select: Record<string, Key>,
  ): { target: SeriesTarget; prorated: boolean } {
    const cells = categories.map((c) =>
      this.windowTarget(planned, expression, { ...select, [column]: c }),
    );
    const pace = cells.map((c) => c.pace ?? null);
    return {
      target: {
        values: cells.map((c) => c.value),
        ...(pace.some((v) => v !== null) ? { pace } : {}),
      },
      prorated: cells.some((c) => c.prorated),
    };
  }

  /**
   * A chart's target (BlockTarget): on the metric's series when the block doesn't split, on each
   * split series when the target's table has the split column, and over every split value on the
   * block when it splits; over the window when a category chart's target has no by column.
   */
  chartTarget(
    block: Block & { type: "line" | "area" | "bar" },
    plan: BlockPlan,
    series: Series[],
    axis: TimeAxis | CategoryAxis,
    grain: ResolvedGrain | undefined,
  ): { series: Series[]; target?: BlockTarget } {
    const [entry] = Object.entries(plan.targets ?? {});
    if (entry === undefined) return { series };
    const [metric, planned] = entry;
    const expression = plan.measures[metric];
    const head: BlockTarget = { id: planned.id, label: planned.label, metric };
    const finer =
      axis.kind === "time" &&
      grain !== undefined &&
      planned.kind === "flow" &&
      planned.prorate === "none" &&
      GRAIN_RANK[grain.unit] < GRAIN_RANK[planned.grain.unit];
    const hidden = this.targetHidden(planned, expression) ?? (finer ? "grain" : undefined);
    if (hidden !== undefined) return { series, target: { ...head, hidden } };
    const dims = "inline" in planned.values ? [] : planned.values.dimensions;
    const by = axis.kind === "category" ? axis.column : undefined;
    const positional = by === undefined || dims.includes(by);
    const clip = axis.kind === "time" && block.edges === "clip" ? axis.window.start : undefined;
    let prorated = false;
    const cells: Value[] = [];
    const at = (select: Record<string, Key>): SeriesTarget => {
      const found =
        axis.kind === "time" && grain !== undefined
          ? this.timeTarget(planned, expression, axis, grain, clip, select)
          : this.categoryTarget(
              planned,
              expression,
              by ?? "",
              axis.kind === "category" ? axis.categories : [],
              select,
            );
      prorated ||= found.prorated;
      cells.push(...found.target.values);
      return found.target;
    };
    const split = block.split;
    const own = split === undefined || dims.includes(split);
    const targeted = series.map((s) => {
      if (!positional || !own || s.metric !== metric) return s;
      return { ...s, target: at(split === undefined ? {} : { [split]: s.splitValue ?? null }) };
    });
    const target: BlockTarget = { ...head };
    if (positional && split !== undefined) {
      const total = at({});
      target.values = total.values;
      if (total.pace) target.pace = total.pace;
    }
    if (!positional) {
      const window = this.windowTarget(planned, expression, {});
      prorated ||= window.prorated;
      cells.push(window.value);
      target.window = {
        value: window.value,
        ...(window.pace === undefined ? {} : { pace: window.pace }),
      };
    }
    this.targetNotes(plan, planned, metric, prorated, cells, axis.kind === "time");
    return { series: targeted, target };
  }

  kpiTarget(plan: BlockPlan, name: string, value: Value): KpiTarget | undefined {
    const planned = plan.targets?.[name];
    if (planned === undefined) return undefined;
    const expression = plan.measures[name];
    const head = { id: planned.id, label: planned.label };
    const hidden = this.targetHidden(planned, expression);
    if (hidden !== undefined) return { ...head, value: null, attainment: null, hidden };
    const found = this.windowTarget(planned, expression, {});
    this.targetNotes(plan, planned, name, found.prorated, [found.value], false);
    return {
      ...head,
      value: found.value,
      ...(found.pace === undefined ? {} : { pace: found.pace }),
      attainment: divide(value, found.pace ?? found.value),
    };
  }

  /** HM4020 when a target misses some of what a block reads, HM4022 when it was split by days. */
  private targetNotes(
    plan: BlockPlan,
    planned: PlannedTarget,
    metric: string,
    prorated: boolean,
    cells: Value[],
    buckets: boolean,
  ): void {
    const file = this.project.dashboards.get(this.plan.dashboard);
    const pointer = `${plan.pointer}/target`;
    const push = (code: "HM4020" | "HM4022", message: string, help: string) => {
      if (this.diagnostics.some((d) => d.code === code && d.message === message)) return;
      this.diagnostics.push({
        code,
        severity: code === "HM4020" ? "warning" : "note",
        message,
        ...(file ? { file: file.file, pointer, ...file.document.locationOf(pointer) } : {}),
        help,
        docs: docsCommand(code),
      });
    };
    const owner = `target "${planned.id}" of "${metric}"`;
    const missing = cells.filter((v) => v === null).length;
    if (missing > 0) {
      const what = buckets ? "buckets" : "window";
      push(
        "HM4020",
        `block "${plan.blockId}" shows ${owner}, which covers ${missing === cells.length ? "none" : "only part"} of its ${what}; it shows no target where the target does not cover`,
        planned.kind === "point"
          ? "a point-in-time target has values only from its first value's period end through its last one's; add values, or pick a range they cover"
          : "add target values for the periods the block reads, or pick a range the target covers",
      );
    }
    if (prorated) {
      const note = proratedTargetNote(plan.blockId, planned.id, metric, planned.grain.unit);
      push("HM4022", note.message, note.help);
    }
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
    const target = this.kpiTarget(plan, name, current);
    if (target) data.target = target;
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
    const series = this.tagGroups(
      block,
      plan,
      block.split === undefined
        ? this.metricSeries(block.metrics, plan.measures, axis.buckets)
        : this.splitSeries(first, plan.measures[first], axis.buckets, stack ? 2 : 1, 2),
    ).map((one) => this.cut(one, plan.measures[one.metric], axis.buckets, grain, clip(axis)));
    const shown = this.incomplete(block, plan, axis, series);
    const targeted = this.chartTarget(block, plan, shown.series, shown.axis, grain);
    const stacked = this.cutTotals(
      this.stacked(
        stack,
        targeted.series,
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
      series: groupOrder(stacked.series),
      ...groupLabels(block),
      ...stacked.extra,
      ...(targeted.target ? { target: targeted.target } : {}),
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
      ...groupLabels(block),
    };
    const stacked = (series: Series[], positions: Key[]) =>
      this.stacked(
        block.stack,
        this.tagGroups(block, plan, series),
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
      const targeted = this.chartTarget(block, plan, shown.series, shown.axis, grain);
      const { series, extra } = this.cutTotals(
        stacked(targeted.series, shown.axis.buckets),
        expressions,
        shown.axis.buckets,
        grain,
        shown.hidden,
      );
      return {
        ...base,
        axis: shown.axis,
        series: groupOrder(series),
        ...extra,
        ...(targeted.target ? { target: targeted.target } : {}),
      };
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
        ? categories.sort((a, b) => compareKeyOrdered(a, b, sort.order, this.compareText))
        : categories
            .map((c) => ({ c, v: value(c) }))
            .sort(
              (a, b) =>
                compareValues(a.v, b.v, sort.order) || compareKey(a.c, b.c, this.compareText),
            )
            .map(({ c }) => c);
    const shown = block.limit === undefined ? sorted : sorted.slice(0, block.limit);
    const axis: CategoryAxis = { kind: "category", column, categories: shown };
    const targeted = this.chartTarget(
      block,
      plan,
      split
        ? this.splitSeries(first, plan.measures[first], shown, 2, 2)
        : this.metricSeries(block.metrics, plan.measures, shown),
      axis,
      undefined,
    );
    const { series, extra } = stacked(targeted.series, shown);
    const omitted = sorted.length - shown.length;
    return {
      ...base,
      axis,
      series: groupOrder(series),
      ...extra,
      ...(omitted > 0 ? { omittedCategories: omitted } : {}),
      ...(targeted.target ? { target: targeted.target } : {}),
    };
  }

  series<T extends LineData | BarData>(
    block: Block & { type: "line" | "area" | "bar" },
    plan: BlockPlan,
    build: (block: Block & { type: "line" | "area" | "bar" }, plan: BlockPlan) => T,
  ): T {
    const data = build(block, plan);
    const variants = (plan.grains ?? []).map((g) => {
      const { axis, series, totals, target } = build(
        { ...block, grain: g.grain },
        { ...plan, grain: g.grain, measures: g.measures },
      );
      return { grain: g.grain, axis: axis as TimeAxis, series, totals, target };
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
          ...(v.target === undefined ? {} : { target: v.target }),
        })),
      },
    };
  }

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
      .sort((a, b) => b.value - a.value || compareKey(a.key, b.key, this.compareText));
    const negative = rows
      .filter((r): r is typeof r & { value: number } => r.value !== null && r.value < 0)
      .sort((a, b) => a.value - b.value || compareKey(a.key, b.key, this.compareText));
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

  private additive(expression: MeasureExpression | undefined): boolean {
    if (expression?.op !== "ref") return false;
    const measure = this.queries
      .get(expression.queryId)
      ?.query.measures.find((m) => m.metric === expression.metric);
    if (measure?.combine.op !== "identity") return false;
    const id = measure.combine.component;
    return measure.components.find((c) => c.id === id)?.reaggregate === "sum";
  }

  map(block: Block & { type: "map" }, plan: BlockPlan, common: Common): MapData {
    const expression = plan.measures[block.value];
    const emptyWindow = this.empty(expression);
    const additive = this.additive(expression);
    const total = emptyWindow ? null : this.evaluate(expression, 1, [null]);
    const found = (emptyWindow ? [] : this.keys([expression], 0)).flatMap((keys) => {
      const id = keys[0];
      return typeof id === "string" ? [{ id, value: this.evaluate(expression, 0, [id]) }] : [];
    });
    found.sort(
      (a, b) =>
        (a.value === null ? 1 : 0) - (b.value === null ? 1 : 0) ||
        (b.value ?? 0) - (a.value ?? 0) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
    const scale = mapScale(
      found.flatMap((r) => (r.value === null ? [] : [r.value])),
      block.scale,
    );
    let rank = 0;
    const regions: MapRegion[] = found.map((r, i) => {
      if (r.value === null) return { id: r.id, value: null };
      if (i === 0 || found[i - 1]?.value !== r.value) rank = i + 1;
      return {
        id: r.id,
        value: r.value,
        rank,
        ...(additive && total !== null && total !== 0 ? { share: r.value / total } : {}),
        class: classOf(r.value, scale.breaks),
      };
    });
    const report = plan.report?.measures[block.value];
    const rowRefs: MeasureExpression[] = (plan.report?.rows ?? []).map((queryId) => ({
      op: "ref",
      queryId,
      metric: "__rows",
    }));
    const drawn = new Set(regions.map((r) => r.id));
    const match: MapMatch[] = (emptyWindow ? [] : this.keys(rowRefs, 0)).flatMap((keys) => {
      const key = keys[0] ?? null;
      const region = keys[1] ?? null;
      const rows = rowRefs.reduce((sum, ref) => sum + (this.evaluate(ref, 0, keys) ?? 0), 0);
      if (rows === 0) return [];
      return [
        {
          key,
          region: typeof region === "string" && drawn.has(region) ? region : null,
          rows,
          value: this.evaluate(report, 0, keys),
        },
      ];
    });
    const window = span(this.bounds(expression), this.context.timezone);
    return {
      ...common,
      type: "map",
      geo: block.geo,
      metric: block.value,
      column: block.region,
      pair: block.pair ?? "bars",
      regions,
      total,
      additive,
      scale,
      match,
      ...(window && !emptyWindow ? { window } : {}),
      ...(emptyWindow ? { empty: emptyWindow } : {}),
    };
  }

  table(block: Block & { type: "table" }, plan: BlockPlan, common: Common): TableData {
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
        ? compareKeyOrdered(
            a.keys[column] ?? null,
            b.keys[column] ?? null,
            sort.order,
            this.compareText,
          )
        : compareValues(a.values[sort.by] ?? null, b.values[sort.by] ?? null, sort.order)) ||
      compareKeys(a.keys, b.keys, this.compareText);
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
            count: g.members.length,
          }),
        }))
        .sort((a, b) => order(a.subtotal, b.subtotal))
        .flatMap((g) => [g.subtotal, ...nest(g.members, g.keys)]);
    };
    const subtotals = block.subtotals === true && width > 1;
    const rows = subtotals ? nest(leaves, []) : cut(leaves, []);
    const scopes = block.metrics.map((m) => {
      const bounds = this.bounds(plan.measures[m]);
      const end =
        bounds?.kind === "bounded" || bounds?.kind === "unbounded" ? bounds.end : undefined;
      const before =
        end === undefined
          ? undefined
          : span({ kind: "bounded", start: end, end }, this.context.timezone)?.end;
      return {
        m,
        window: span(bounds, this.context.timezone),
        through:
          before === undefined
            ? undefined
            : new Date(Date.parse(`${before}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10),
      };
    });
    const read = scopes.filter(({ m }) => emptyOf.get(m) === undefined);
    const mostRead = <T>(values: T[]): T | undefined => {
      const counts = new Map<string, { value: T; count: number }>();
      for (const value of values) {
        const id = JSON.stringify(value);
        counts.set(id, { value, count: (counts.get(id)?.count ?? 0) + 1 });
      }
      let best: { value: T; count: number } | undefined;
      for (const entry of counts.values()) if (!best || entry.count > best.count) best = entry;
      return best?.value;
    };
    const window = mostRead(read.flatMap((s) => (s.window ? [s.window] : [])));
    const through = window
      ? undefined
      : mostRead(read.flatMap((s) => (s.window === undefined && s.through ? [s.through] : [])));
    const windows = Object.fromEntries(
      read.flatMap((s) =>
        window && s.window && JSON.stringify(s.window) !== JSON.stringify(window)
          ? [[s.m, s.window]]
          : [],
      ),
    );
    const throughs = Object.fromEntries(
      read.flatMap((s) =>
        through && s.window === undefined && s.through && s.through !== through
          ? [[s.m, s.through]]
          : [],
      ),
    );
    const allTime =
      window || through
        ? read.filter((s) => s.window === undefined && s.through === undefined).map((s) => s.m)
        : [];
    const emptyMetrics: Record<string, EmptyWindow> = {};
    for (const [m, why] of emptyOf) if (why && !empty) emptyMetrics[m] = why;
    const texts = [
      ...new Set(rows.flatMap((r) => r.keys.filter((k): k is string => typeof k === "string"))),
    ].sort((a, b) => compareKey(a, b, this.compareText));
    return {
      ...common,
      type: "table",
      by: block.by.map((c) => ({ column: c, label: columnLabel(c) })),
      metrics: block.metrics,
      percentOfTotal: percent,
      sort,
      ...(block.bars !== undefined && block.bars.length > 0 ? { bars: block.bars } : {}),
      ...(block.overflow !== undefined ? { overflow: block.overflow } : {}),
      rows,
      ...(texts.length > 0 ? { textOrder: texts } : {}),
      rowCount: leaves.length,
      ...(subtotals ? { subtotals: true } : {}),
      ...(block.totals !== false
        ? { total: { values: totals, ...(percent.length > 0 ? { share: shares(totals) } : {}) } }
        : {}),
      ...(window ? { window } : {}),
      ...(Object.keys(windows).length > 0 ? { windows } : {}),
      ...(through ? { through } : {}),
      ...(Object.keys(throughs).length > 0 ? { throughs } : {}),
      ...(allTime.length > 0 ? { allTime } : {}),
      ...(Object.keys(emptyMetrics).length > 0 ? { emptyMetrics } : {}),
      ...(empty ? { empty } : {}),
    };
  }

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
    placed.sort(
      (a, b) =>
        compareValues(rank(a), rank(b), "desc") || compareKey(a.key, b.key, this.compareText),
    );
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
        help: "set additive: false unless the SQL is a sum or a count",
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

type Common = { id: string; title?: string; span: number; height?: HeightPreset };

const MAX_POINTS = 1000;
const GRAIN_RANK = { day: 0, week: 1, month: 2, quarter: 3, year: 4 } as const;
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

function periodFilter(
  filters: DashboardFilter[] | undefined,
  plan: QueryPlan,
  context: ExecutionContext,
  range: RangeSpec,
): { periodFilter: PeriodFilter } | Record<string, never> {
  const filter = filters?.find((f) => f.type === "period");
  if (filter === undefined) return {};
  const options = filter.options.map((option): PeriodOption => {
    const label = rangeName(option);
    let current: DateSpan | undefined;
    try {
      current = span(resolveRange(option, "none", context.asOf, plan.anchors), context.timezone);
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
    }
    return {
      key: rangeKey(option),
      ...(label === undefined ? {} : { label }),
      ...(current ? { current } : {}),
    };
  });
  return {
    periodFilter: {
      id: filter.id,
      label: filter.label ?? "Period",
      options,
      selected: rangeKey(range),
    },
  };
}

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

function segmentFilter(
  plan: QueryPlan,
  context: ExecutionContext,
): { segmentFilter: NonNullable<DashboardData["segmentFilter"]> } | Record<string, never> {
  const param = plan.params.find((p) => p.kind === "segment");
  if (param?.kind !== "segment") return {};
  const on = segmentValues(
    { ...param, names: param.segments.map((s) => s.name) },
    context.bindings,
  );
  return {
    segmentFilter: {
      id: param.id,
      label: param.label,
      options: param.segments.map(({ name, label }) => ({ name, label })),
      selected: param.segments.map((s) => s.name).filter((name) => on.includes(name)),
    },
  };
}

function columnLabel(column: string): string {
  const text = column.replaceAll("_", " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * assemble with the point-in-time metrics given rather than derived from the metric specs, for
 * callers whose project carries portable metrics instead of full specs.
 */
export function assembleWith(
  project: Project,
  plan: QueryPlan,
  results: ReadonlyMap<string, QueryResult>,
  context: ExecutionContext,
  pointMetrics: ReadonlySet<string>,
  textOrder?: readonly string[],
): { data?: DashboardData; diagnostics: Diagnostic[] } {
  const spec = project.dashboards.get(plan.dashboard)?.spec;
  const config = project.config.spec;
  if (spec === undefined || config === undefined) return { diagnostics: [] };
  const assembler = new Assembler(
    project,
    plan,
    results,
    context,
    textComparer(config.locale, textOrder),
  );
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
      ...("height" in block && block.height !== undefined ? { height: block.height } : {}),
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
    } else if (block.type === "map") {
      shown.add(block.value);
      blocks.push(assembler.map(block, blockPlan, common));
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
      ...(pointMetrics.has(name) ? { nature: "point" as const } : {}),
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
    ...periodFilter(spec.filters, plan, context, period.range),
    ...segmentFilter(plan, context),
    metrics,
    blocks,
  };
  return { data, diagnostics: assembler.diagnostics };
}

function groupLabels(block: Block & { type: "line" | "area" | "bar" }): { groups?: SeriesGroup[] } {
  return block.groups === undefined
    ? {}
    : { groups: block.groups.map((g) => ({ label: g.label })) };
}

function groupOrder(series: Series[]): Series[] {
  if (!series.some((s) => s.group !== undefined)) return series;
  const out: Series[] = [];
  const placed = new Set<number>();
  for (const s of series) {
    if (s.group === undefined) {
      out.push(s);
      continue;
    }
    const index = s.group.index;
    if (placed.has(index)) continue;
    placed.add(index);
    out.push(
      ...series
        .filter((t) => t.group?.index === index)
        .sort((a, b) => (a.group?.step ?? 0) - (b.group?.step ?? 0)),
    );
  }
  return out;
}
