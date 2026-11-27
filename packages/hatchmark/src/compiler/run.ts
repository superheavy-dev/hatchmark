import { type Diagnostic, docsCommand } from "../diagnostics/index.js";
import { checkReferences, type Project, parseDiagnostics } from "../spec/index.js";
import { assemble } from "./assemble.js";
import type { DashboardData } from "./dashboard-data.js";
import {
  type HorizonLag,
  horizonFor,
  type PlannedHorizon,
  type SourceHorizon,
  type TimeColumn,
} from "./horizons.js";
import type {
  ExecutionContext,
  MeasureExpression,
  QueryExecutor,
  QueryPlan,
  QueryResult,
} from "./plan.js";
import { planDashboard } from "./planner.js";
import { nextDay, previousDay, queryBounds, resolveRange, SUPPORTED_DATES } from "./windows.js";

/**
 * A QueryExecutor that can also measure source horizons for "latest_data" (RFC 0001 section 6.1):
 * the latest value of a column over all rows, as a local wall-clock timestamp
 * "YYYY-MM-DDTHH:MM:SS.ffffff" in the time zone (horizonSql), undefined when the column is empty.
 * naive is true for a timestamp column without an offset.
 */
export interface DashboardExecutor extends QueryExecutor {
  horizon(
    column: TimeColumn,
    timezone: string,
    lag?: HorizonLag,
  ): Promise<{ through?: string; naive: boolean }>;
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

/** Local midnight at the start of a date, in the form horizons take. */
const midnight = (date: string) => `${date}T00:00:00.000000`;

/** The last local date before an instant: its date, or the day before when it is midnight. */
function dateBefore(instant: string): string {
  const date = instant.slice(0, 10);
  return instant.slice(11) === "00:00:00.000000" ? previousDay(date) : date;
}

/** The build machine's clock as local wall-clock time in the time zone, for HM4012 only. */
function localNow(now: Date, timezone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}.000000`;
}

/**
 * The ExecutionContext of a plan with nothing bound, and the data diagnostics of its horizons
 * (RFC 0001 sections 6.1 and 6.3). Every source horizon the plan needs is measured once. The as-of
 * instant T is the newest voting horizon for "latest_data", the oldest for "latest_common_data", and
 * the end of the date for a fixed asOf; the as-of date is T's last local date. Every window is then
 * checked against the supported dates.
 *
 * Errors: HM4011 when "latest_data" has no voting horizon to resolve from; HM2015 when a horizon
 * cannot be measured or a date is out of range. Warnings: HM4010 for a source more than a day
 * behind T, HM4012 for a horizon more than a day after the build machine's clock (now; the clock
 * never changes the output), HM4013 for a block whose window starts at or after its horizon. Note:
 * HM4016 for timestamps without an offset in a project whose time zone isn't UTC.
 */
export async function executionContext(
  project: Project,
  plan: QueryPlan,
  executor: DashboardExecutor,
  now?: Date,
): Promise<{ context?: ExecutionContext; diagnostics: Diagnostic[] }> {
  const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
  const config = project.config;
  const atSource = (source: string) => {
    const pointer = `/sources/${source}`;
    return { file: config.file, pointer, ...config.document.locationOf(pointer) };
  };
  const notes: Diagnostic[] = [];
  const measured = new Map<PlannedHorizon, string | undefined>();
  const naive = new Set<string>();
  try {
    for (const h of plan.horizons) {
      if (typeof h.rule === "object" && "through" in h.rule) {
        if (h.rule.through !== "as_of") measured.set(h, midnight(nextDay(h.rule.through)));
        continue;
      }
      if (h.column === undefined) continue;
      const lag = typeof h.rule === "object" ? h.rule.lag : undefined;
      const result = await executor.horizon(
        { source: h.source, column: h.column },
        plan.timezone,
        lag,
      );
      measured.set(h, result.through);
      const declared = config.spec?.sources[h.source];
      const zoned = declared !== undefined && declared.type !== "lookup" && declared.timezone;
      if (result.naive && !zoned && plan.timezone !== "UTC") naive.add(h.source);
    }
  } catch (error) {
    return { diagnostics: [failure(`cannot measure source horizons: ${message(error)}`)] };
  }
  for (const source of naive) {
    notes.push({
      code: "HM4016",
      severity: "note",
      message: `source "${source}" has timestamps without an offset, read as UTC, in a project whose time zone is ${plan.timezone}`,
      ...atSource(source),
      help: `set "timezone" on the source when its timestamps are local times, such as "${plan.timezone}"`,
      docs: docsCommand("HM4016"),
    });
  }

  let instant: string;
  const asOfRule = plan.period.asOf;
  if (asOfRule === "latest_data" || asOfRule === "latest_common_data") {
    const voting = plan.horizons
      .filter((h) => h.votes)
      .map((h) => measured.get(h))
      .filter((v): v is string => v !== undefined)
      .sort();
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
    instant = midnight(nextDay(asOfRule));
  }
  const asOf =
    typeof asOfRule === "string" && /^\d{4}-\d{2}-\d{2}$/.test(asOfRule)
      ? asOfRule
      : dateBefore(instant);

  const horizons = plan.horizons.flatMap((h): SourceHorizon[] => {
    const through = measured.get(h) ?? (h.votes ? undefined : instant);
    if (through === undefined) return [];
    return [{ source: h.source, ...(h.column !== undefined ? { column: h.column } : {}), through }];
  });
  const context: ExecutionContext = {
    asOf,
    timezone: plan.timezone,
    anchors: plan.anchors,
    bindings: {},
    horizons,
  };
  try {
    if (!(asOf >= SUPPORTED_DATES.first && asOf <= SUPPORTED_DATES.last)) {
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

  const behind = `${previousDay(instant.slice(0, 10))}${instant.slice(10)}`;
  const clock = now && localNow(now, plan.timezone);
  const ahead = clock && `${nextDay(clock.slice(0, 10))}${clock.slice(10)}`;
  const reported = new Set<string>();
  for (const [h, through] of measured) {
    if (through === undefined || reported.has(h.source)) continue;
    if (through < behind) {
      reported.add(h.source);
      notes.push({
        code: "HM4010",
        severity: "warning",
        message: `source "${h.source}" is complete through ${through.slice(0, 16).replace("T", " ")}, more than a day before the as-of ${instant.slice(0, 16).replace("T", " ")}`,
        ...atSource(h.source),
        help: 'check that the data is current, or set "freshness" on the source to say how complete it is',
        docs: docsCommand("HM4010"),
      });
    }
    if (ahead !== undefined && through > ahead) {
      reported.add(h.source);
      notes.push({
        code: "HM4012",
        severity: "warning",
        message: `source "${h.source}" has data through ${through.slice(0, 16).replace("T", " ")}, more than a day after this machine's clock (${(clock as string).slice(0, 16).replace("T", " ")})`,
        ...atSource(h.source),
        help: "look for future-dated rows, such as a typo in a year or scheduled entries, or set period.asOf",
        docs: docsCommand("HM4012"),
      });
    }
  }

  const file = project.dashboards.get(plan.dashboard);
  const queries = new Map(plan.queries.map((q) => [q.id, q]));
  for (const block of plan.blocks) {
    const empty = block.queryIds.some((id) => {
      const query = queries.get(id);
      const column = query?.window.column;
      if (query === undefined || column === undefined || query.window.shift !== "none")
        return false;
      const bounds = queryBounds(query, context);
      if (bounds?.kind !== "bounded") return false;
      const h = horizonFor(plan.horizons, query.source, column);
      const through =
        h === undefined ? undefined : (measured.get(h) ?? (h.votes ? undefined : instant));
      const horizon = through === undefined || through > instant ? instant : through;
      return midnight(bounds.start) >= horizon;
    });
    if (!empty) continue;
    notes.push({
      code: "HM4013",
      severity: "warning",
      message: `block "${block.blockId}" has no data in its window: every source it reads ends before the window starts`,
      ...(file
        ? { file: file.file, pointer: block.pointer, ...file.document.locationOf(block.pointer) }
        : {}),
      help: "pick a range that ends after the data does, or set period.asOf",
      docs: docsCommand("HM4013"),
    });
  }
  return { context, diagnostics: notes };
}

/**
 * Plans a dashboard, runs its queries and assembles DashboardData, with the filter defaults bound.
 * The project is checked first: any error in hatchmark.json, a metric, or this dashboard is
 * returned without running anything. The as-of date resolves once, before any query runs, from the
 * source horizons (executionContext), so every window ends on the same day. now is the build
 * machine's clock, used only for the HM4012 warning. Queries run
 * one after another in plan order, except comparisons that have no window (a period filter set to
 * all_time), which are skipped so their KPIs show no comparison. A failing query or an empty
 * latest_data is an HM2015 error.
 */
export async function runDashboard(
  project: Project,
  dashboard: string,
  executor: DashboardExecutor,
  now?: Date,
): Promise<{ data?: DashboardData; diagnostics: Diagnostic[] }> {
  const errors = blockingErrors(project, dashboard);
  if (errors.length > 0) return { diagnostics: errors };
  const { plan, diagnostics } = planDashboard(project, dashboard);
  if (plan === undefined) return { diagnostics };

  const resolved = await executionContext(project, plan, executor, now);
  diagnostics.push(...resolved.diagnostics);
  const { context } = resolved;
  if (context === undefined) return { diagnostics };
  const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
  const results = new Map<string, QueryResult>();
  const imprecise = new Map<string, Diagnostic>();
  for (const query of plan.queries) {
    if (queryBounds(query, context) === undefined) continue;
    try {
      const result = await executor.execute(query, context);
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
    } catch (error) {
      return {
        diagnostics: [
          ...diagnostics,
          failure(`query on source "${query.source}" failed: ${message(error)}`),
        ],
      };
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
