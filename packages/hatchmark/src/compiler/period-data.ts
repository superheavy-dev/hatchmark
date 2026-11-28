import type { Dashboard, Format, Project } from "../spec/index.js";
import { assembleWith } from "./assemble.js";
import type { DashboardData, DateSpan, Value } from "./dashboard-data.js";
import { formatWall, fromLocal, parseInstant, toLocal } from "./instants.js";
import type {
  ExecutionContext,
  MeasureComponent,
  PlannedQuery,
  QueryPlan,
  QueryResult,
  SnapshotEvaluation,
} from "./plan.js";
import { bucketStart, queryBounds } from "./windows.js";

/**
 * What a static page embeds so its period filter works without a server.
 *
 * - Presets: the dashboard run once per preset, exactly as build runs it, so every metric (count
 *   distinct and median included) is computed by the executor. The browser only redraws.
 * - Custom ranges: day-grain aggregates of every query the period filter windows ("day cubes"),
 *   and the plan. The browser answers each planned query from its cube (cubeResult) and assembles
 *   DashboardData with the same assemble() build uses. Components that cannot be re-aggregated
 *   (count_distinct, median, non-additive SQL) are null for a custom range: the page shows "—"
 *   and says to pick a preset. Live arbitrary ranges come with serve (phase 2).
 *
 * Plain JSON, deterministic for identical input.
 */
export const PERIOD_DATA_VERSION = 1;

export type Key = string | number | boolean | null;

/**
 * Day-grain aggregates of one query shape, column by column: one entry per day and group that has
 * rows. Days are counted from CustomRangeData.span.start.
 */
export interface DayCube {
  /** The query's column and region dimensions, in order; the day comes first and is not listed. */
  columns: string[];
  days: number[];
  /**
   * For a match-report row count whose operands window different date columns: each operand's day
   * per entry (null when the rows fail its filters), aligned with days. An entry counts in a range
   * when any of its days falls inside; days holds the earliest.
   */
  sets?: (number | null)[][];
  /** One array per column dimension, aligned with days. */
  keys: Key[][];
  /**
   * For a snapshot query (SnapshotEvaluation): each entry's snapshot, aligned with days. An entry
   * then holds one group's aggregate at one snapshot.
   */
  instants?: string[];
  /** For a snapshot query: every snapshot of the source in the span, whether or not rows pass. */
  snapshots?: { days: number[]; instants: string[] };
  /** One array per measure component, by component id, aligned with days. */
  values: Record<string, Value[]>;
}

/** The part of a metric assembly reads: its label, format and direction. */
export interface PortableMetric {
  type: string;
  label: string;
  description?: string;
  format: Format;
  better: "up" | "down" | "neutral";
  additive?: boolean;
  /** A ratio's operands. */
  numerator?: string;
  denominator?: string;
  nature?: "point";
}

export interface CustomRangeData {
  /** The days a custom range may cover: the first day with data through the as-of date. */
  span: DateSpan;
  dashboard: Dashboard;
  metrics: Record<string, PortableMetric>;
  project: { name: string; locale: string; currency: string };
  /** The dashboard's plan, without SQL text and metric filters (the cubes already applied them). */
  plan: QueryPlan;
  context: ExecutionContext;
  /** Each planned query's day cube, or its result when the period filter does not window it. */
  queries: Record<string, { cube: string } | { result: QueryResult }>;
  cubes: Record<string, DayCube>;
  /** Metrics a custom range cannot compute from day aggregates, sorted. */
  presetOnly: string[];
  /**
   * Every text value in the cubes and results, in the order the build sorts them in the project
   * locale, so a browser orders keys like the build whatever collation data it has.
   */
  textOrder: string[];
}

export interface PeriodData {
  version: typeof PERIOD_DATA_VERSION;
  /** The period filter's id: its query parameter in the page URL. */
  filter: string;
  /** Every preset's data, by rangeKey. */
  presets: Record<string, DashboardData>;
  custom?: CustomRangeData;
}

/** Days from 0001-01-01, for day offsets; years below 100 stay themselves. */
export function dayNumber(date: string): number {
  const [y = 1, m = 1, d = 1] = date.split("-").map(Number);
  const t = new Date(0);
  t.setUTCFullYear(y, m - 1, d);
  return Math.round(t.getTime() / 86_400_000);
}

export function dayText(day: number): string {
  const t = new Date(day * 86_400_000);
  const y = t.getUTCFullYear();
  return `${String(y).padStart(4, "0")}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(t.getUTCDate()).padStart(2, "0")}`;
}

/**
 * A planned query's result for a custom range, from its day cube: the cube's rows inside the
 * query's window, bucketed at the query's grains and grouped by its grouping sets, each component
 * re-aggregated (sum and count add up, min and max take the extreme). Matches the executor: an
 * empty grand total still has a row, sums and counts of no rows are 0, and components that cannot
 * be re-aggregated are null. Undefined when the query has no window (all_time compared).
 */
export function cubeResult(
  query: PlannedQuery,
  cube: DayCube,
  spanStart: string,
  context: ExecutionContext,
): QueryResult | undefined {
  const bounds = queryBounds(query, context);
  if (bounds === undefined) return undefined;
  const origin = dayNumber(spanStart);
  const dayOf = (bound: string, up: boolean): number => {
    if (!bound.endsWith("Z")) return dayNumber(bound) - origin;
    const wall = formatWall(toLocal(parseInstant(bound), context.timezone));
    const cut = up && !wall.endsWith("T00:00:00.000000") ? 1 : 0;
    return dayNumber(wall.slice(0, 10)) - origin + cut;
  };
  const lo = bounds.kind === "bounded" ? dayOf(bounds.start, false) : -Infinity;
  const hi = bounds.end === undefined ? Infinity : dayOf(bounds.end, true);
  if (query.evaluation !== undefined) {
    const exact = (bound: string | undefined) =>
      bound?.endsWith("Z") === true ? parseInstant(bound) : undefined;
    const window = {
      lo,
      hi,
      from: bounds.kind === "bounded" ? exact(bounds.start) : undefined,
      to: exact(bounds.end),
      timezone: context.timezone,
    };
    return snapshotCubeResult(query, query.evaluation, cube, origin, window);
  }
  const components = query.measures.flatMap((m) => m.components);
  const dims = query.dimensions;
  const texts = new Map<number, string>();
  const buckets = new Map<string, string>();
  let columns = 0;
  const columnAt = dims.map((d) => (d.kind !== "time" ? columns++ : -1));
  const groups = query.groupingSets.map(() => new Map<string, { keys: Key[]; rows: number[] }>());
  for (let i = 0; i < cube.days.length; i++) {
    const day = cube.sets
      ? (cube.sets.map((s) => s[i] ?? null).find((d) => d !== null && d >= lo && d < hi) ??
        -Infinity)
      : (cube.days[i] ?? 0);
    if (day < lo || day >= hi) continue;
    let text = texts.get(day);
    if (text === undefined) {
      text = dayText(origin + day);
      texts.set(day, text);
    }
    const values = dims.map((d, k): Key => {
      if (d.kind !== "time") return cube.keys[columnAt[k] ?? -1]?.[i] ?? null;
      const memo = `${JSON.stringify(d.grain)}|${text}`;
      let start = buckets.get(memo);
      if (start === undefined) {
        start = bucketStart(text as string, d.grain);
        buckets.set(memo, start);
      }
      return start;
    });
    query.groupingSets.forEach((set, s) => {
      const keys = values.map((v, k) => (set.includes(k) ? v : null));
      const id = JSON.stringify(keys);
      const group = groups[s]?.get(id) ?? { keys, rows: [] };
      group.rows.push(i);
      groups[s]?.set(id, group);
    });
  }
  const aggregate = (c: MeasureComponent, rows: number[]): Value => {
    const values = cube.values[c.id] ?? [];
    if (c.reaggregate === "none") return null;
    let acc: number | null = null;
    for (const i of rows) {
      const v = values[i] ?? null;
      if (v === null) continue;
      acc =
        acc === null
          ? v
          : c.reaggregate === "sum"
            ? acc + v
            : c.reaggregate === "min"
              ? Math.min(acc, v)
              : Math.max(acc, v);
    }
    return acc === null && (c.aggregate === "sum" || c.aggregate === "count") ? 0 : acc;
  };
  const rows: unknown[][] = [];
  const groupingSet: number[] = [];
  query.groupingSets.forEach((set, s) => {
    const found = [...(groups[s]?.values() ?? [])];
    if (set.length === 0 && found.length === 0)
      found.push({ keys: dims.map(() => null), rows: [] });
    found.sort((a, b) => compareRow(a.keys, b.keys));
    for (const group of found) {
      rows.push([...group.keys, ...components.map((c) => aggregate(c, group.rows))]);
      groupingSet.push(s);
    }
  });
  return {
    columns: [
      ...dims.map((d) => ({
        name: d.column,
        type: d.kind === "time" ? ("date" as const) : ("string" as const),
      })),
      ...components.map((c) => ({ name: c.id, type: "number" as const })),
    ],
    rows,
    ...(query.groupingSets.length > 1 ? { groupingSet } : {}),
  };
}

function innerCombine(c: MeasureComponent): "sum" | "min" | "max" | undefined {
  if (c.aggregate === "sum" || c.aggregate === "count") return "sum";
  return c.aggregate === "min" || c.aggregate === "max" ? c.aggregate : undefined;
}

/**
 * True when a snapshot query's component can be answered from its day cube: its aggregate combines
 * across groups at one snapshot (sum and count add up, min and max take the extreme).
 */
export function snapshotCubeable(c: MeasureComponent): boolean {
  return innerCombine(c) !== undefined;
}

function snapshotCubeResult(
  query: PlannedQuery,
  evaluation: SnapshotEvaluation,
  cube: DayCube,
  origin: number,
  window: {
    lo: number;
    hi: number;
    from: bigint | undefined;
    to: bigint | undefined;
    timezone: string;
  },
): QueryResult {
  const components = query.measures.flatMap((m) => m.components);
  const dims = query.dimensions;
  let columns = 0;
  const columnAt = dims.map((d) => (d.kind !== "time" ? columns++ : -1));
  const at = (instant: string) =>
    instant.length === 10
      ? fromLocal(parseInstant(instant), window.timezone)
      : parseInstant(instant.slice(0, 26));
  const inside = (day: number | undefined, instant: string) =>
    day !== undefined &&
    (window.from === undefined ? day >= window.lo : at(instant) >= window.from) &&
    (window.to === undefined ? day < window.hi : at(instant) < window.to);
  const markers = (cube.snapshots?.days ?? []).flatMap((day, i) => {
    const instant = cube.snapshots?.instants[i] ?? "";
    return inside(day, instant) ? [{ day, instant }] : [];
  });
  const entries = cube.days.flatMap((day, i) => (inside(day, cube.instants?.[i] ?? "") ? [i] : []));
  const rows: unknown[][] = [];
  const groupingSet: number[] = [];
  query.groupingSets.forEach((set, s) => {
    const times = set.filter((d) => dims[d]?.kind === "time");
    const others = set.filter((d) => dims[d]?.kind !== "time");
    const bucketOf = (day: number): Key[] =>
      times.map((d) => {
        const dim = dims[d];
        return dim?.kind === "time" ? bucketStart(dayText(origin + day), dim.grain) : null;
      });
    const groupOf = (i: number): Key[] =>
      others.map((d) => cube.keys[columnAt[d] ?? -1]?.[i] ?? null);
    const buckets = new Map<string, { keys: Key[]; instants: Set<string> }>();
    for (const { day, instant } of markers) {
      const keys = bucketOf(day);
      const id = JSON.stringify(keys);
      const bucket = buckets.get(id) ?? { keys, instants: new Set<string>() };
      bucket.instants.add(instant);
      buckets.set(id, bucket);
    }
    const chosen = new Map<string, { keys: Key[]; instants: string[] }>();
    for (const [id, { keys, instants }] of buckets) {
      const sorted = [...instants].sort();
      const picked =
        evaluation.pick === "last"
          ? sorted.slice(-1)
          : evaluation.pick === "first"
            ? sorted.slice(0, 1)
            : sorted;
      chosen.set(id, { keys, instants: picked });
    }
    const domain = new Map<string, Key[]>();
    if (others.length === 0) domain.set("[]", []);
    for (const i of entries) {
      const keys = groupOf(i);
      domain.set(JSON.stringify(keys), keys);
    }
    const acc = new Map<string, (number | null)[]>();
    for (const i of entries) {
      const instant = cube.instants?.[i] ?? "";
      const bucket = JSON.stringify(bucketOf(cube.days[i] ?? 0));
      if (!chosen.get(bucket)?.instants.includes(instant)) continue;
      const id = JSON.stringify([bucket, instant, JSON.stringify(groupOf(i))]);
      const sums = acc.get(id) ?? components.map(() => null);
      components.forEach((c, j) => {
        const v = cube.values[c.id]?.[i] ?? null;
        const combine = innerCombine(c);
        const prior = sums[j] ?? null;
        if (v === null || combine === undefined) return;
        sums[j] =
          prior === null
            ? v
            : combine === "sum"
              ? prior + v
              : combine === "min"
                ? Math.min(prior, v)
                : Math.max(prior, v);
      });
      acc.set(id, sums);
    }
    const found: Key[][] = [];
    const values: Value[][] = [];
    for (const [bucketId, bucket] of chosen) {
      for (const [groupId, group] of domain) {
        found.push(
          dims.map((_, d) => {
            const t = times.indexOf(d);
            if (t >= 0) return bucket.keys[t] ?? null;
            const o = others.indexOf(d);
            return o >= 0 ? (group[o] ?? null) : null;
          }),
        );
        values.push(
          components.map((c, j) => {
            if (innerCombine(c) === undefined) return null;
            const empty = c.aggregate === "sum" || c.aggregate === "count" ? 0 : null;
            const at = bucket.instants
              .map((instant) => acc.get(JSON.stringify([bucketId, instant, groupId]))?.[j] ?? empty)
              .filter((v): v is number => v !== null);
            if (at.length === 0) return null;
            if (evaluation.pick === "avg") return at.reduce((a, v) => a + v, 0) / at.length;
            if (evaluation.pick === "min") return Math.min(...at);
            if (evaluation.pick === "max") return Math.max(...at);
            return at[0] ?? null;
          }),
        );
      }
    }
    const order = found.map((_, i) => i).sort((a, b) => compareRow(found[a] ?? [], found[b] ?? []));
    for (const i of order) {
      rows.push([...(found[i] ?? []), ...(values[i] ?? [])]);
      groupingSet.push(s);
    }
  });
  if (dims.length === 0 && rows.length === 0) rows.push(components.map(() => null));
  return {
    columns: [
      ...dims.map((d) => ({
        name: d.column,
        type: d.kind === "time" ? ("date" as const) : ("string" as const),
      })),
      ...components.map((c) => ({ name: c.id, type: "number" as const })),
    ],
    rows,
    ...(query.groupingSets.length > 1 ? { groupingSet } : {}),
  };
}

function compareRow(a: Key[], b: Key[]): number {
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? null;
    const y = b[i] ?? null;
    if (x === y) continue;
    if (x === null) return 1;
    if (y === null) return -1;
    return String(x) < String(y) ? -1 : 1;
  }
  return 0;
}

/**
 * DashboardData for a custom range in the browser: every planned query answered from its day cube
 * (or its stored result), assembled by the same assemble() build uses, with the filter bound to
 * the range. Throws when the range reaches outside the custom span.
 */
export function customRangeDashboard(
  custom: CustomRangeData,
  filter: string,
  range: { start: string; end: string },
): DashboardData {
  if (range.start < custom.span.start || range.end > custom.span.end || range.start >= range.end) {
    throw new RangeError(
      `a custom range must lie within ${custom.span.start} and ${custom.span.end} (exclusive)`,
    );
  }
  const context: ExecutionContext = {
    ...custom.context,
    bindings: { ...custom.context.bindings, [filter]: range },
  };
  const results = new Map<string, QueryResult>();
  for (const query of custom.plan.queries) {
    const source = custom.queries[query.id];
    if (source === undefined) continue;
    if ("result" in source) {
      results.set(query.id, source.result);
      continue;
    }
    const cube = custom.cubes[source.cube];
    const result = cube && cubeResult(query, cube, custom.span.start, context);
    if (result) results.set(query.id, result);
  }
  const none = { locationOf: () => ({}) };
  const project = {
    config: { spec: custom.project },
    dashboards: new Map([
      [custom.plan.dashboard, { file: "", document: none, spec: custom.dashboard }],
    ]),
    metrics: new Map(
      Object.entries(custom.metrics).map(([name, spec]) => [
        name,
        { file: "", document: none, spec },
      ]),
    ),
  } as unknown as Project;
  const points = new Set(
    Object.entries(custom.metrics)
      .filter(([, m]) => m.nature === "point")
      .map(([name]) => name),
  );
  const { data } = assembleWith(project, custom.plan, results, context, points, custom.textOrder);
  if (data === undefined) throw new Error("custom range assembly produced no data");
  const presetOnly = new Set(custom.presetOnly);
  const blocks = data.blocks.map((b) =>
    b.type === "kpi" && dependsOn(custom, b.metric, presetOnly)
      ? { ...b, presetOnly: true as const }
      : b,
  );
  return {
    ...data,
    blocks,
    ...(data.periodFilter ? { periodFilter: { ...data.periodFilter, custom: custom.span } } : {}),
  };
}

function dependsOn(
  custom: CustomRangeData,
  name: string,
  presetOnly: ReadonlySet<string>,
): boolean {
  if (presetOnly.has(name)) return true;
  const metric = custom.metrics[name];
  if (metric?.numerator === undefined || metric.denominator === undefined) return false;
  return (
    dependsOn(custom, metric.numerator, presetOnly) ||
    dependsOn(custom, metric.denominator, presetOnly)
  );
}
