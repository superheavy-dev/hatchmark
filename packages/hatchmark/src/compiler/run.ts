import { type Diagnostic, docsCommand } from "../diagnostics/index.js";
import {
  blockId,
  checkReferences,
  type Metric,
  type Project,
  parseDiagnostics,
  resolveGrain,
  timeNature,
} from "../spec/index.js";
import { assembleWith } from "./assemble.js";
import type { DashboardData } from "./dashboard-data.js";
import { canonicalJson } from "./hash.js";
import {
  type PlannedHorizon,
  planTimeColumns,
  type SourceHorizon,
  type TimeColumn,
} from "./horizons.js";
import {
  DAY_US,
  describeInstant,
  formatInstant,
  formatWall,
  fromLocal,
  parseInstant,
  toLocal,
} from "./instants.js";
import { selectValues } from "./params.js";
import {
  type ExecutionContext,
  type MeasureExpression,
  type ParamBindings,
  type PlannedQuery,
  type QueryExecutor,
  type QueryPlan,
  type QueryResult,
  readsRawSql,
} from "./plan.js";
import { planDashboard } from "./planner.js";
import {
  bucketEnd,
  bucketStart,
  measureHorizon,
  nextDay,
  queryBounds,
  resolveRange,
  SUPPORTED_DATES,
  windowAt,
} from "./windows.js";

/**
 * A QueryExecutor that can also measure source horizons (RFC 0001 section 6.1). horizon returns the
 * latest value of a column over all rows, ignoring filters: "YYYY-MM-DD" for a DATE column, else the
 * UTC instant "YYYY-MM-DDTHH:MM:SS.ffffff" (timestamps without an offset read in the source's
 * timezone, else UTC); latest is undefined when the column is empty, and naive is true for a
 * timestamp column without an offset.
 */
export interface DashboardExecutor extends QueryExecutor {
  horizon(column: TimeColumn): Promise<{ latest?: string; date: boolean; naive: boolean }>;
}

function failure(message: string): Diagnostic {
  return { code: "HM2015", severity: "error", message, docs: docsCommand("HM2015") };
}

/** Errors in the project that keep this dashboard from running: all but other dashboards'. */
export function blockingErrors(project: Project, dashboard: string): Diagnostic[] {
  const others = new Set(
    [...project.dashboards.values()].filter((d) => d.name !== dashboard).map((d) => d.file),
  );
  return [...parseDiagnostics(project), ...checkReferences(project)].filter(
    (d) => d.severity === "error" && !(d.file !== undefined && others.has(d.file)),
  );
}

/** The instant a local date starts in the time zone. */
const startOf = (date: string, timezone: string) => fromLocal(parseInstant(date), timezone);

/**
 * The ExecutionContext of a plan with nothing bound, and the data diagnostics of its horizons
 * (RFC 0001 sections 6.1 and 6.3). Each time column the plan reads is measured once. A horizon is
 * the exclusive instant a source is complete through: just after its latest timestamp, or the end of
 * its latest date, moved back by the freshness lag. The as-of instant T is the newest voting horizon
 * for "latest_data", the oldest for "latest_common_data", and the end of the date for a fixed asOf;
 * the as-of date is the last local date before T. Every window is then checked against the supported
 * dates.
 *
 * Errors: HM4011 when "latest_data" has no voting horizon to resolve from; HM2015 when a horizon
 * cannot be measured or a date is out of range. Warnings: HM4010 for a source more than a day
 * behind T, HM4012 for a column whose newest value is more than a day after the build machine's clock
 * (now; it never stops the build or changes the output), and HM4013 for a block whose every window
 * starts at or after its horizon. Notes: HM4016 for timestamps without an offset that a source with
 * no timezone has, in a project whose time zone isn't UTC, and HM4024 for a block whose window is
 * empty because no day of it is complete yet (its data has begun after the window's start).
 */
export async function executionContext(
  project: Project,
  plan: QueryPlan,
  executor: DashboardExecutor,
  now?: Date,
): Promise<{ context?: ExecutionContext; diagnostics: Diagnostic[] }> {
  const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
  const config = project.config;
  const tz = plan.timezone;
  const atSource = (source: string) => {
    const pointer = `/sources/${source}`;
    return { file: config.file, pointer, ...config.document.locationOf(pointer) };
  };
  const notes: Diagnostic[] = [];
  const latest = new Map<string, Awaited<ReturnType<DashboardExecutor["horizon"]>>>();
  const measure = async (column: TimeColumn) => {
    const key = JSON.stringify([column.source, column.column]);
    let result = latest.get(key);
    if (result === undefined) {
      result = await executor.horizon(column);
      latest.set(key, result);
    }
    return result;
  };
  const measured = new Map<PlannedHorizon, bigint | undefined>();
  const newest = new Map<PlannedHorizon, bigint>();
  const naive = new Set<string>();
  try {
    for (const column of planTimeColumns(plan)) {
      const declared = config.spec?.sources[column.source];
      const zoned = declared !== undefined && declared.type !== "lookup" && declared.timezone;
      if ((await measure(column)).naive && !zoned && tz !== "UTC") naive.add(column.source);
    }
    for (const h of plan.horizons) {
      if (typeof h.rule === "object" && "through" in h.rule) {
        if (h.rule.through !== "as_of") measured.set(h, startOf(nextDay(h.rule.through), tz));
        continue;
      }
      if (h.column === undefined) continue;
      const result = await measure({ source: h.source, column: h.column });
      if (result.latest === undefined) {
        measured.set(h, undefined);
        continue;
      }
      newest.set(h, result.date ? startOf(result.latest, tz) : parseInstant(result.latest));
      const lag = typeof h.rule === "object" ? h.rule.lag : undefined;
      const days = lag !== undefined && "days" in lag ? BigInt(lag.days) * DAY_US : 0n;
      let through = result.date
        ? fromLocal(parseInstant(nextDay(result.latest)) - days, tz)
        : parseInstant(result.latest) + 1n;
      if (!result.date && days > 0n) through = fromLocal(toLocal(through, tz) - days, tz);
      if (lag !== undefined && "hours" in lag) through -= BigInt(lag.hours) * 3_600_000_000n;
      measured.set(h, through);
    }
  } catch (error) {
    return { diagnostics: [failure(`cannot measure source horizons: ${message(error)}`)] };
  }
  for (const source of naive) {
    notes.push({
      code: "HM4016",
      severity: "note",
      message: `source "${source}" has timestamps without an offset, read as UTC, in a project whose time zone is ${tz}`,
      ...atSource(source),
      help: `set "timezone" on the source when its timestamps are local times, such as "${tz}"`,
      docs: docsCommand("HM4016"),
    });
  }

  let instant: bigint;
  const asOfRule = plan.period.asOf;
  if (asOfRule === "latest_data" || asOfRule === "latest_common_data") {
    const voting = plan.horizons
      .filter((h) => h.votes)
      .map((h) => measured.get(h))
      .filter((v): v is bigint => v !== undefined)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const picked = asOfRule === "latest_data" ? voting[voting.length - 1] : voting[0];
    if (picked === undefined) {
      const empty = plan.horizons.filter((h) => h.votes && h.column !== undefined);
      return {
        diagnostics: [
          {
            code: "HM4011",
            severity: "error",
            message:
              empty.length > 0
                ? `${asOfRule} found no dates in ${empty.map((h) => `${h.source}.${h.column}`).join(", ")}`
                : `${asOfRule} needs a source to resolve from, but no metric on this dashboard has a time column that votes`,
            ...(empty.length > 0 && empty[0] ? atSource(empty[0].source) : {}),
            help: 'set period.asOf to a date, or give a source a "freshness" rule',
            docs: docsCommand("HM4011"),
          },
        ],
      };
    }
    instant = picked;
  } else {
    if (!(asOfRule >= SUPPORTED_DATES.first && asOfRule <= SUPPORTED_DATES.last)) {
      return {
        diagnostics: [
          failure(
            `the as-of date ${asOfRule} is outside the supported dates ${SUPPORTED_DATES.first} to ${SUPPORTED_DATES.last}`,
          ),
        ],
      };
    }
    instant = startOf(nextDay(asOfRule), tz);
  }
  const lastDay = toLocal(instant - 1n, tz);
  if (
    lastDay < parseInstant(SUPPORTED_DATES.first) ||
    lastDay >= parseInstant(nextDay(SUPPORTED_DATES.last))
  ) {
    return {
      diagnostics: [
        failure(
          `the as-of instant ${formatInstant(instant)} is outside the supported dates ${SUPPORTED_DATES.first} to ${SUPPORTED_DATES.last}`,
        ),
      ],
    };
  }
  const asOf = formatWall(lastDay).slice(0, 10);

  const horizonOf = (h: PlannedHorizon) => measured.get(h) ?? (h.votes ? undefined : instant);
  const horizons = plan.horizons.flatMap((h): SourceHorizon[] => {
    const through = horizonOf(h);
    if (through === undefined) return [];
    return [
      {
        source: h.source,
        ...(h.column !== undefined ? { column: h.column } : {}),
        through: formatInstant(through),
      },
    ];
  });
  const context: ExecutionContext = {
    asOf,
    timezone: tz,
    anchors: plan.anchors,
    bindings: {},
    asOfInstant: formatInstant(instant),
    horizons,
  };
  try {
    const day = parseInstant(asOf);
    if (day < parseInstant(SUPPORTED_DATES.first) || day > parseInstant(SUPPORTED_DATES.last)) {
      throw new RangeError(
        `the as-of date ${asOf} is outside the supported dates ${SUPPORTED_DATES.first} to ${SUPPORTED_DATES.last}`,
      );
    }
    for (const query of plan.queries) queryBounds(query, context);
    for (const shift of ["none", plan.period.compare] as const) {
      resolveRange(plan.period.range, shift, asOf, plan.anchors);
    }
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    return { diagnostics: [failure(error.message)] };
  }

  const behind = new Set<string>();
  for (const [h, through] of measured) {
    if (through === undefined || behind.has(h.source) || through >= instant - DAY_US) continue;
    behind.add(h.source);
    notes.push({
      code: "HM4010",
      severity: "warning",
      message: `source "${h.source}" is complete through ${describeInstant(through, tz)}, more than a day before the as-of ${describeInstant(instant, tz)}`,
      ...atSource(h.source),
      help: 'check that the data is current, or set "freshness" on the source to say how complete it is',
      docs: docsCommand("HM4010"),
    });
  }
  if (now !== undefined) {
    const limit = BigInt(now.getTime()) * 1000n + DAY_US;
    const ahead = new Set<string>();
    for (const [h, latest] of newest) {
      if (h.column === undefined || ahead.has(h.source) || latest <= limit) continue;
      ahead.add(h.source);
      notes.push({
        code: "HM4012",
        severity: "warning",
        message: `source "${h.source}" has data in "${h.column}" through ${describeInstant(latest, tz)}, more than a day after this machine's clock (${describeInstant(limit - DAY_US, tz)})`,
        ...atSource(h.source),
        help: "look for future-dated rows, such as a typo in a year or scheduled entries, or set period.asOf",
        docs: docsCommand("HM4012"),
      });
    }
  }

  const file = project.dashboards.get(plan.dashboard);
  const queries = new Map(plan.queries.map((q) => [q.id, q]));
  for (const block of plan.blocks) {
    const current = block.queryIds
      .map((id) => queries.get(id))
      .filter((q) => q !== undefined && q.window.shift === "none");
    const empty =
      current.length > 0 &&
      current.every((query) => {
        const bounds = query && queryBounds(query, context);
        return bounds?.kind === "bounded" && parseInstant(bounds.start) >= parseInstant(bounds.end);
      });
    if (!empty) continue;
    const location = file
      ? { file: file.file, pointer: block.pointer, ...file.document.locationOf(block.pointer) }
      : {};
    const first = current[0] && queryBounds(current[0], context);
    const start =
      first?.kind === "bounded" && !first.start.endsWith("Z")
        ? fromLocal(parseInstant(first.start), tz)
        : undefined;
    const horizon = current
      .map((query) => query && measureHorizon(query, context))
      .reduce<bigint | undefined>(
        (a, h) => (h === undefined || (a !== undefined && a <= h) ? a : h),
        undefined,
      );
    if (start !== undefined && horizon !== undefined && horizon > start) {
      notes.push({
        code: "HM4024",
        severity: "note",
        message: `block "${block.blockId}" has no complete day yet: its window starts ${describeInstant(start, tz)} and the data it reads runs through ${describeInstant(horizon, tz)}, so it shows no value`,
        ...location,
        help: "the block fills in once a day of its window is complete; set period.asOf to show an earlier, complete day",
        docs: docsCommand("HM4024"),
      });
      continue;
    }
    notes.push({
      code: "HM4013",
      severity: "warning",
      message: `block "${block.blockId}" has no data in its window: the data it reads ends before the window starts`,
      ...location,
      help: "pick a range that ends after the data does, or set period.asOf",
      docs: docsCommand("HM4013"),
    });
  }
  const specs = new Map<string, Metric>();
  for (const [name, metricFile] of project.metrics) {
    if (metricFile.spec) specs.set(name, metricFile.spec);
  }
  const ids = (e: MeasureExpression): string[] =>
    e.op === "ref" ? [e.queryId] : [...ids(e.numerator), ...ids(e.denominator)];
  const local = (text: string) =>
    text.endsWith("Z") ? toLocal(parseInstant(text), tz) : parseInstant(text);
  for (const block of plan.blocks) {
    const spec = file?.spec?.blocks.find((b, i) => blockId(b, i) === block.blockId);
    if (spec === undefined || !("incomplete" in spec) || spec.incomplete !== "show") continue;
    const grain = block.grain ?? (spec.grain && resolveGrain(spec.grain, plan.anchors));
    const readings = block.grains ?? (grain ? [{ grain, measures: block.measures }] : []);
    const partial = readings.flatMap(({ grain, measures }) =>
      Object.entries(measures)
        .filter(
          ([name, expression]) =>
            timeNature(name, specs) === "flow" &&
            ids(expression).some((id) => {
              const query = queries.get(id);
              const horizon = query && measureHorizon(query, context);
              const bounds =
                query && windowAt(query, context, parseInstant(context.asOfInstant ?? ""));
              if (horizon === undefined || bounds === undefined) return false;
              const at = toLocal(horizon, tz);
              const start = bounds.kind === "bounded" ? local(bounds.start) : undefined;
              if (start !== undefined && at <= start) return false;
              const end = bounds.end === undefined ? at : local(bounds.end);
              const last = formatWall((end < at ? end : at) - 1n).slice(0, 10);
              const bucket = bucketStart(last, grain);
              return (
                (start !== undefined && start > parseInstant(bucket)) ||
                at < parseInstant(bucketEnd(bucket, grain))
              );
            }),
        )
        .map(([name]) => ({ name, unit: grain.unit })),
    );
    const [first] = partial;
    if (first === undefined) continue;
    const pointer = `${block.pointer}/incomplete`;
    notes.push({
      code: "HM4014",
      severity: "warning",
      message: `block "${block.blockId}" shows its last ${first.unit} as complete, but the data for "${first.name}" covers only part of it, so it reads low`,
      ...(file ? { file: file.file, pointer, ...file.document.locationOf(pointer) } : {}),
      help: 'use "mark" (the default) to show it as in progress, or "hide" to leave it out',
      docs: docsCommand("HM4014"),
    });
  }
  return { context, diagnostics: notes };
}

/**
 * Plans a dashboard, runs its queries and assembles DashboardData, with the filter defaults bound.
 * The project is checked first: any error in hatchmark.yaml, a metric, or this dashboard is
 * returned without running anything. The as-of date resolves once, before any query runs, from the
 * source horizons (executionContext), so every window ends on the same day. now is the build
 * machine's clock, used only for the HM4012 warning. bindings sets filter values (a period filter's
 * preset or custom range); unbound filters read their defaults. Queries run
 * one after another in plan order, except comparisons that have no window (a period filter set to
 * all_time), which are skipped so their KPIs show no comparison. A failing query or an empty
 * latest_data is an HM2015 error.
 */
export async function runDashboard(
  project: Project,
  dashboard: string,
  executor: DashboardExecutor,
  now?: Date,
  bindings: ParamBindings = {},
): Promise<{ data?: DashboardData; diagnostics: Diagnostic[] }> {
  const [run] = await runDashboardBindings(project, dashboard, executor, [bindings], now);
  return run ?? { diagnostics: [] };
}

/**
 * runDashboard for several sets of bindings, such as a period filter's presets: one result per
 * set, in order, each equal to runDashboard's for that set. The checks, the plan and the as-of date
 * are worked out once; each query runs once for every set through the executor's executeMany when
 * it has one, and sets that give a query the same window and select values share its run.
 */
export async function runDashboardBindings(
  project: Project,
  dashboard: string,
  executor: DashboardExecutor,
  bindingsList: ParamBindings[],
  now?: Date,
): Promise<{ data?: DashboardData; diagnostics: Diagnostic[] }[]> {
  const errors = blockingErrors(project, dashboard);
  if (errors.length > 0) return bindingsList.map(() => ({ diagnostics: errors }));
  const { plan, diagnostics } = planDashboard(project, dashboard);
  if (plan === undefined) return bindingsList.map(() => ({ diagnostics }));

  const resolved = await executionContext(project, plan, executor, now);
  diagnostics.push(...resolved.diagnostics);
  const base = resolved.context;
  if (base === undefined) return bindingsList.map(() => ({ diagnostics }));
  const contexts: ExecutionContext[] = bindingsList.map((bindings) => ({ ...base, bindings }));
  const outcomes: (QueryOutcome | undefined)[][] = [];
  const failed = new Set<number>();
  for (const query of plan.queries) {
    const live = contexts.map((context, at) => (failed.has(at) ? undefined : context));
    const outcome = await runQuery(executor, query, live);
    outcome.forEach((o, at) => {
      if (o !== undefined && "error" in o) failed.add(at);
    });
    outcomes.push(outcome);
  }
  const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
  return contexts.map((context, at) => {
    const results = new Map<string, QueryResult>();
    const imprecise = new Map<string, Diagnostic>();
    for (const [q, query] of plan.queries.entries()) {
      const outcome = outcomes[q]?.[at];
      if (outcome === undefined) continue;
      if ("error" in outcome) {
        return {
          diagnostics: [
            ...diagnostics,
            failure(`query on source "${query.source}" failed: ${message(outcome.error)}`),
          ],
        };
      }
      const { result } = outcome;
      results.set(query.id, result);
      for (const { column, maxAbs } of result.imprecise ?? []) {
        imprecise.set(JSON.stringify([query.source, column]), {
          code: "HM4004",
          severity: "warning",
          message: `column "${column}" of source "${query.source}" holds values up to ${maxAbs.toExponential(2)}; sums of floating-point values are accurate only within ±1e15`,
          help: "store the values in a smaller unit or as DECIMAL (Parquet), or split very large and very small values into separate columns",
          docs: docsCommand("HM4004"),
        });
      }
    }
    const assembled = assemble(project, plan, results, context);
    return {
      ...(assembled.data ? { data: assembled.data } : {}),
      diagnostics: [
        ...diagnostics,
        ...imprecise.values(),
        ...largeResults(project, dashboard, plan, results),
        ...assembled.diagnostics,
      ],
    };
  });
}

type QueryOutcome = { result: QueryResult } | { error: unknown };

async function runQuery(
  executor: DashboardExecutor,
  query: PlannedQuery,
  contexts: (ExecutionContext | undefined)[],
): Promise<(QueryOutcome | undefined)[]> {
  const raw = readsRawSql(query);
  const keys = contexts.map((context, at) => {
    if (context === undefined) return undefined;
    const bounds = queryBounds(query, context);
    if (bounds === undefined) return undefined;
    if (raw) return `context ${at}`;
    try {
      const selects = query.params.flatMap((p) =>
        p.kind === "select" ? [Array.from(selectValues(p, context.bindings))] : [],
      );
      return canonicalJson([bounds, selects]);
    } catch {
      return `context ${at}`;
    }
  });
  const distinct = [...new Set(keys.filter((key) => key !== undefined))];
  const runs = distinct.map((key) => contexts[keys.indexOf(key)] as ExecutionContext);
  const settle = (result: QueryResult): QueryOutcome => {
    try {
      return { result: checkedDates(query, result) };
    } catch (error) {
      return { error };
    }
  };
  const oneByOne = async () => {
    const out: QueryOutcome[] = [];
    for (const context of runs) {
      try {
        out.push(settle(await executor.execute(query, context)));
      } catch (error) {
        out.push({ error });
      }
    }
    return out;
  };
  let settled: QueryOutcome[];
  if (runs.length > 1 && !raw && executor.executeMany !== undefined) {
    try {
      settled = (await executor.executeMany(query, runs)).map(settle);
    } catch {
      settled = await oneByOne();
    }
  } else {
    settled = await oneByOne();
  }
  return keys.map((key) => (key === undefined ? undefined : settled[distinct.indexOf(key)]));
}

function checkedDates(query: PlannedQuery, result: QueryResult): QueryResult {
  query.dimensions.forEach((dimension, i) => {
    if (dimension.kind !== "time") return;
    const bad = result.rows.find(
      (row) =>
        row[i] !== null &&
        !(/^\d{4}-\d{2}-\d{2}$/.test(String(row[i])) && String(row[i]) <= SUPPORTED_DATES.last),
    );
    if (bad !== undefined) {
      throw new RangeError(
        `column "${dimension.column}" has dates in a bucket (${String(bad[i])}) outside the supported dates ${SUPPORTED_DATES.first} to ${SUPPORTED_DATES.last}`,
      );
    }
  });
  return result;
}

/** HM4004 for each metric a block shows whose float sum or avg reaches ±1e13 (QueryResult.large). */
function largeResults(
  project: Project,
  dashboard: string,
  plan: QueryPlan,
  results: Map<string, QueryResult>,
): Diagnostic[] {
  const file = project.dashboards.get(dashboard);
  const out: Diagnostic[] = [];
  for (const block of plan.blocks) {
    const found = new Map<string, number>();
    const visit = (expression: MeasureExpression) => {
      if (expression.op === "divide") {
        visit(expression.numerator);
        visit(expression.denominator);
        return;
      }
      for (const { metric, maxAbs } of results.get(expression.queryId)?.large ?? []) {
        if (metric !== expression.metric) continue;
        found.set(metric, Math.max(found.get(metric) ?? 0, maxAbs));
      }
    };
    for (const readings of [block.measures, block.previous, block.sparkline]) {
      for (const expression of Object.values(readings ?? {})) visit(expression);
    }
    for (const [metric, maxAbs] of found) {
      out.push({
        code: "HM4004",
        severity: "warning",
        message: `metric "${metric}" in block "${block.blockId}" reaches ${maxAbs.toExponential(2)}; floating-point results keep 15 significant digits, so from ±1e13 on the cents are lost`,
        ...(file
          ? { file: file.file, pointer: block.pointer, ...file.document.locationOf(block.pointer) }
          : {}),
        help: "store the values in a larger unit (thousands), or as DECIMAL (Parquet) to keep them exact",
        docs: docsCommand("HM4004"),
      });
    }
  }
  return out;
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
  return assembleWith(project, plan, results, context, pointMetrics(project));
}

/** The metrics whose time nature is point-in-time, which assembly labels "as of". */
export function pointMetrics(project: Project): Set<string> {
  const specs = new Map<string, Metric>();
  for (const [name, file] of project.metrics) if (file.spec) specs.set(name, file.spec);
  return new Set([...specs.keys()].filter((name) => timeNature(name, specs) === "point"));
}
