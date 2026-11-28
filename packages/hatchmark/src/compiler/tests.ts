import { type Diagnostic, docsCommand } from "../diagnostics/index.js";
import {
  CONFIG_FILE,
  checkMetricTestColumns,
  type Filter,
  type MetricTest,
  metricDeps,
  type Project,
  parseSpecFile,
  type SourceTest,
  testsOfSource,
} from "../spec/index.js";
import type { KpiData, TableData, Value } from "./dashboard-data.js";
import { type DashboardExecutor, runDashboard } from "./run.js";
import { nextDay, previousDay, SUPPORTED_DATES } from "./windows.js";

export type TestStatus = "pass" | "fail" | "error";

export interface TestResult {
  /** "metric" for a test in metrics/<name>.yaml, "source" for a row-count test in hatchmark.yaml. */
  kind: "metric" | "source";
  /** The metric or source name. */
  target: string;
  index: number;
  name?: string;
  file: string;
  pointer: string;
  status: TestStatus;
  expected?: number | Record<string, number> | SourceTest["rows"];
  actual?: Value | Record<string, Value>;
  difference?: number | Record<string, number | null>;
  diagnostics: Diagnostic[];
}

const DASHBOARD = "hm_test";
const BLOCK = "test";
const EMPTY_KEY = "(empty)";

/** The data swaps of a metric test, by source name; empty for a test that reads the project's data. */
export function testData(project: Project, metric: string, index: number): Record<string, string> {
  return project.metrics.get(metric)?.spec?.tests?.[index]?.data ?? {};
}

/**
 * The project a test runs against: its data swaps applied to the sources. The columns of a swapped
 * source become unknown; set them from the fixture to check the test's columns against it.
 */
export function withTestData(project: Project, data: Readonly<Record<string, string>>): Project {
  const spec = project.config.spec;
  if (spec === undefined || Object.keys(data).length === 0) return project;
  const sources = { ...spec.sources };
  const columns = new Map(project.columns);
  for (const [name, file] of Object.entries(data)) {
    const source = sources[name];
    if (source === undefined || source.type === "lookup") continue;
    sources[name] = { ...source, path: file };
    columns.delete(name);
  }
  return { ...project, columns, config: { ...project.config, spec: { ...spec, sources } } };
}

/** The project row-count tests run against: every row of a snapshot source counts. */
export function forRowCounts(project: Project): Project {
  const spec = project.config.spec;
  if (spec === undefined) return project;
  const sources = Object.fromEntries(
    Object.entries(spec.sources).map(([name, source]) => {
      if (source.type === "lookup" || source.snapshot === undefined) return [name, source];
      const { snapshot: _, ...rest } = source;
      return [name, rest];
    }),
  ) as typeof spec.sources;
  return { ...project, config: { ...project.config, spec: { ...spec, sources } } };
}

function reachable(project: Project, metric: string, seen = new Set<string>()): Set<string> {
  if (seen.has(metric)) return seen;
  seen.add(metric);
  const spec = project.metrics.get(metric)?.spec;
  if (spec) for (const dep of metricDeps(spec)) reachable(project, dep, seen);
  return seen;
}

function testProject(
  project: Project,
  metric: string,
  where: readonly Filter[],
  segments: readonly string[],
): Project {
  const read = reachable(project, metric);
  const metrics = new Map([...project.metrics].filter(([name]) => read.has(name)));
  if (where.length === 0 && segments.length === 0) return { ...project, metrics };
  for (const name of read) {
    const file = metrics.get(name);
    const spec = file?.spec;
    if (file === undefined || spec === undefined) continue;
    if (spec.type !== "aggregate" && spec.type !== "sql") continue;
    metrics.set(name, {
      ...file,
      spec: {
        ...spec,
        filters: [...(spec.filters ?? []), ...where],
        segments: [...new Set([...(spec.segments ?? []), ...segments])],
      },
    });
  }
  return { ...project, metrics };
}

function withDashboard(project: Project, spec: Record<string, unknown>): Project {
  const parsed = parseSpecFile("dashboard", `dashboards/${DASHBOARD}.yaml`, JSON.stringify(spec));
  return { ...project, dashboards: new Map([[DASHBOARD, parsed]]) };
}

async function readBlock(
  project: Project,
  executor: DashboardExecutor,
  now: Date | undefined,
): Promise<{ block?: KpiData | TableData; diagnostics: Diagnostic[] }> {
  const { data, diagnostics } = await runDashboard(project, DASHBOARD, executor, now);
  const block = data?.blocks.find((b) => b.id === BLOCK) as KpiData | TableData | undefined;
  return { ...(block ? { block } : {}), diagnostics };
}

function groupKey(key: string | number | boolean | null | undefined): string {
  return key === null || key === undefined ? EMPTY_KEY : String(key);
}

const DEFAULT_TOLERANCE = 5e-7;

function compare(actual: Value, expected: number, tolerance: number | undefined) {
  if (actual === null) return { pass: false, difference: null };
  const difference = actual - expected;
  if (!Number.isFinite(difference)) return { pass: actual === expected, difference };
  const rounding = 4 * Number.EPSILON * Math.max(Math.abs(actual), Math.abs(expected));
  return { pass: Math.abs(difference) <= (tolerance ?? DEFAULT_TOLERANCE) + rounding, difference };
}

function unreadable(
  diagnostics: readonly Diagnostic[],
  file: string,
  pointer: string,
  what: string,
): Diagnostic[] {
  if (diagnostics.length > 0) {
    return diagnostics.map((d) => ({
      ...d,
      severity: "error",
      message: d.message.replace(`; block "${BLOCK}" is left out`, ""),
      file: d.file ?? file,
      pointer: d.pointer ?? pointer,
    }));
  }
  return [
    {
      code: "HM2015",
      severity: "error",
      message: `${what}: the test cannot be read`,
      file,
      pointer,
      docs: docsCommand("HM2015"),
    },
  ];
}

function relocate(
  d: Diagnostic,
  synthesized: readonly string[],
  to: { file: string; pointer?: string },
): Diagnostic {
  if (d.file === undefined || !synthesized.includes(d.file)) return d;
  const { file: _, pointer, range, frame, fix, ...rest } = d;
  return { ...rest, ...to };
}

function failure(
  project: Project,
  file: string,
  pointer: string,
  message: string,
  extra: Partial<Diagnostic> = {},
): Diagnostic {
  const document =
    file === CONFIG_FILE
      ? project.config.document
      : [...project.metrics.values()].find((m) => m.file === file)?.document;
  return {
    code: "HM4030",
    severity: "error",
    message,
    file,
    pointer,
    ...(document?.locationOf(pointer) ?? {}),
    ...extra,
    docs: docsCommand("HM4030"),
  };
}

/**
 * Runs test index of a metric through the same planner and executor as build: a one-block
 * dashboard over the test's window (flow), or ending with the day of at (point-in-time), a kpi block, or a table
 * block by the test's column. where and segments are added to every metric the tested metric
 * reads rows through, so both sides of a ratio or formula see them. The project and the executor
 * must read the test's data as withTestData(project, testData(...)) returns it.
 */
export async function runMetricTest(
  project: Project,
  metric: string,
  index: number,
  executor: DashboardExecutor,
  now?: Date,
): Promise<TestResult> {
  const file = project.metrics.get(metric);
  const test = file?.spec?.tests?.[index] as MetricTest;
  const pointer = `/tests/${index}`;
  const base = {
    kind: "metric" as const,
    target: metric,
    index,
    ...(test.name !== undefined ? { name: test.name } : {}),
    file: file?.file ?? `metrics/${metric}.yaml`,
    pointer,
    expected: test.expect,
  };
  const columnErrors = checkMetricTestColumns(project, metric, index);
  if (columnErrors.length > 0) return { ...base, status: "error", diagnostics: columnErrors };
  const [start, end] = test.window ?? [SUPPORTED_DATES.first, test.at as string];
  const block =
    test.by === undefined
      ? { id: BLOCK, type: "kpi", metric }
      : { id: BLOCK, type: "table", metrics: [metric], by: [test.by], limit: 1000 };
  const filtered = testProject(project, metric, test.where ?? [], test.segments ?? []);
  const run = withDashboard(filtered, {
    title: metric,
    period: { asOf: end, range: { start, end: nextDay(end) }, compare: "none" },
    blocks: [block],
  });
  const read = await readBlock(run, executor, now);
  const diagnostics = read.diagnostics.map((d) =>
    relocate(d, [`dashboards/${DASHBOARD}.yaml`], { file: base.file }),
  );
  const errors = diagnostics.filter((d) => d.severity === "error");
  if (errors.length > 0) return { ...base, status: "error", diagnostics: errors };
  if (read.block === undefined) {
    return {
      ...base,
      status: "error",
      diagnostics: unreadable(diagnostics, base.file, pointer, metric),
    };
  }
  const notes: Diagnostic[] = [];
  const current = read.block.type === "kpi" ? read.block.current : read.block.window;
  if (
    current !== undefined &&
    (current.end < nextDay(end) ||
      current.endAt !== undefined ||
      (read.block.type === "kpi" && read.block.empty))
  ) {
    notes.push({
      code: "HM4031",
      severity: "warning",
      message: `the test reads through ${end}, past the data${current && current.end > start ? `, which ends on ${previousDay(current.end)}` : ""}; the number can still change`,
      file: base.file,
      pointer,
      ...(file?.document.locationOf(pointer) ?? {}),
      help: "move the window or at to a date the data covers",
      docs: docsCommand("HM4031"),
    });
  }
  if (read.block.type === "kpi") {
    const expected = test.expect as number;
    const actual = read.block.value;
    const { pass, difference } = compare(actual, expected, test.tolerance);
    if (pass)
      return { ...base, status: "pass", actual, difference: difference ?? 0, diagnostics: notes };
    const at = `${pointer}/expect`;
    const range = file?.document.locationOf(at)?.range;
    return {
      ...base,
      status: "fail",
      actual,
      ...(difference !== null ? { difference } : {}),
      diagnostics: [
        failure(
          project,
          base.file,
          at,
          `${metric}: expected ${expected}, got ${actual ?? "no value"}${difference !== null ? ` (difference ${difference})` : ""}`,
          {
            ...(range && actual !== null
              ? {
                  fix: {
                    range,
                    text: String(actual),
                    applicability: "unsafe" as const,
                    description: `pin ${actual}`,
                  },
                }
              : {}),
          },
        ),
        ...notes,
      ],
    };
  }
  const values: Record<string, Value> = {};
  let emptyCount = 0;
  for (const row of read.block.rows) {
    if (row.kind !== undefined) continue;
    const key = groupKey(row.keys[0]);
    if (key === EMPTY_KEY) emptyCount++;
    values[key] = row.values[metric] ?? null;
  }
  const expected = test.expect as Record<string, number>;
  const actual: Record<string, Value> = {};
  const difference: Record<string, number | null> = {};
  const failed: string[] = [];
  for (const [key, want] of Object.entries(expected)) {
    if (key === EMPTY_KEY && emptyCount > 1) {
      actual[key] = null;
      difference[key] = null;
      failed.push(
        `${EMPTY_KEY} is ambiguous: "${test.by}" has both empty values and the text "${EMPTY_KEY}"`,
      );
      continue;
    }
    const got = values[key] ?? null;
    actual[key] = got;
    const result = compare(got, want, test.tolerance);
    difference[key] = result.difference;
    if (!result.pass) failed.push(`${key}: expected ${want}, got ${got ?? "no value"}`);
  }
  if (read.block.rowCount > 1000) {
    failed.push(`"${test.by}" has more than 1000 groups; test a column with fewer`);
  }
  if (failed.length === 0)
    return { ...base, status: "pass", actual, difference, diagnostics: notes };
  return {
    ...base,
    status: "fail",
    actual,
    difference,
    diagnostics: [
      failure(
        project,
        base.file,
        `${pointer}/expect`,
        `${metric} by ${test.by}: ${failed.join("; ")}`,
        {
          expected: Object.keys(values),
        },
      ),
      ...notes,
    ],
  };
}

function freeMetricName(project: Project): string {
  for (let i = 0; ; i++) {
    const name = i === 0 ? "hm_test_rows" : `hm_test_rows_${i}`;
    if (!project.metrics.has(name)) return name;
  }
}

/**
 * Runs row-count test index of a source: the rows matching where, against min and max. The project
 * and the executor must read the sources as forRowCounts(project) returns them.
 */
export async function runSourceTest(
  project: Project,
  source: string,
  index: number,
  executor: DashboardExecutor,
  now?: Date,
): Promise<TestResult> {
  const test = testsOfSource(project.config.spec?.sources[source])[index] as SourceTest;
  const pointer = `/sources/${source}/tests/${index}`;
  const base = {
    kind: "source" as const,
    target: source,
    index,
    ...(test.name !== undefined ? { name: test.name } : {}),
    file: CONFIG_FILE,
    pointer,
    expected: test.rows,
  };
  const name = freeMetricName(project);
  const counted = parseSpecFile(
    "metric",
    `metrics/${name}.yaml`,
    JSON.stringify({
      label: "Rows",
      format: { type: "number" },
      better: "neutral",
      type: "aggregate",
      table: source,
      aggregate: "count",
      ...(test.where !== undefined ? { filters: test.where } : {}),
    }),
  );
  const run = withDashboard(
    { ...project, metrics: new Map([...project.metrics, [name, counted]]) },
    {
      title: source,
      period: { asOf: SUPPORTED_DATES.last, range: "all_time", compare: "none" },
      blocks: [{ id: BLOCK, type: "kpi", metric: name }],
    },
  );
  const read = await readBlock(run, executor, now);
  const diagnostics = read.diagnostics.map((d) =>
    relocate(d, [`dashboards/${DASHBOARD}.yaml`, `metrics/${name}.yaml`], {
      file: CONFIG_FILE,
      pointer,
    }),
  );
  const errors = diagnostics.filter((d) => d.severity === "error");
  if (errors.length > 0) return { ...base, status: "error", diagnostics: errors };
  if (read.block?.type !== "kpi") {
    return {
      ...base,
      status: "error",
      diagnostics: unreadable(diagnostics, CONFIG_FILE, pointer, `source "${source}"`),
    };
  }
  const actual = read.block.value ?? 0;
  const { min, max } = test.rows;
  const low = min !== undefined && actual < min;
  const high = max !== undefined && actual > max;
  if (!low && !high) return { ...base, status: "pass", actual, diagnostics: [] };
  return {
    ...base,
    status: "fail",
    actual,
    difference: low ? actual - (min as number) : actual - (max as number),
    diagnostics: [
      failure(
        project,
        CONFIG_FILE,
        `${pointer}/rows/${low ? "min" : "max"}`,
        `source "${source}" has ${actual} ${test.where ? "matching " : ""}rows, ${low ? `fewer than the minimum ${min}` : `more than the maximum ${max}`}`,
      ),
    ],
  };
}
