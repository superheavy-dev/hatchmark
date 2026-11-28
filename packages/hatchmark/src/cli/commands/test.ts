import {
  forRowCounts,
  runMetricTest,
  runSourceTest,
  type TestResult,
  testData,
  withTestData,
} from "../../compiler/index.js";
import {
  createReport,
  type Diagnostic,
  docsCommand,
  renderHuman,
} from "../../diagnostics/index.js";
import { createDuckDbExecutor, nodeProjectHost } from "../../node/index.js";
import {
  CONFIG_FILE,
  checkReferences,
  fileColumns,
  loadProject,
  type Project,
  parseDiagnostics,
  testsOfSource,
} from "../../spec/index.js";
import type { CommandHelp } from "../help.js";
import { type CommandContext, type CommandResult, EXIT } from "../io.js";
import { usageError } from "../usage.js";
import { exitCodeFor } from "./check.js";

export const testHelp: CommandHelp = {
  name: "test",
  summary:
    "Run the tests pinned in metric files and the row-count tests of sources against the data, for CI.",
  usage: "hatchmark test [metric|source ...]",
  options: [
    {
      flag: "[metric|source ...]",
      description: "Run only the tests of these metrics and sources. Default: every test.",
    },
  ],
  example: {
    command: "hatchmark test --json",
    description:
      "Exits 1 when a test fails (HM4030); each result has expected, actual and difference.",
  },
};

interface Planned {
  kind: "metric" | "source";
  target: string;
  index: number;
  data: Record<string, string>;
  rows?: boolean;
}

function envelope(report: ReturnType<typeof createReport>, results: TestResult[]) {
  const count = (status: TestResult["status"]) => results.filter((r) => r.status === status).length;
  const summary = { passed: count("pass"), failed: count("fail"), errors: count("error") };
  return {
    ...report,
    ok: report.ok && summary.failed === 0 && summary.errors === 0,
    ...summary,
    results: results.map(({ diagnostics: _, ...r }) => r),
  };
}

async function withFixtureColumns(
  host: ReturnType<typeof nodeProjectHost>,
  project: Project,
  data: Readonly<Record<string, string>>,
): Promise<Project> {
  const swapped = withTestData(project, data);
  for (const name of Object.keys(data)) {
    const source = swapped.config.spec?.sources[name];
    if (source === undefined || source.type === "lookup") continue;
    const columns = await fileColumns(host, source);
    if (columns !== undefined) swapped.columns.set(name, columns);
  }
  return swapped;
}

export async function test(ctx: CommandContext, positionals: string[]): Promise<CommandResult> {
  const host = nodeProjectHost(ctx.root);
  const { project, diagnostics: loaded } = await loadProject(host);
  const config = project?.config.spec;
  const errors = [
    ...loaded,
    ...(project === undefined ? [] : [...parseDiagnostics(project), ...checkReferences(project)]),
  ].filter((d) => d.severity === "error");
  if (project === undefined || config === undefined || errors.length > 0) {
    const report = createReport(errors);
    return {
      exitCode: project === undefined ? EXIT.usage : exitCodeFor(errors, false),
      json: envelope(report, []),
      human: renderHuman(report, { color: ctx.color }),
    };
  }
  const planned: Planned[] = [];
  for (const name of [...project.metrics.keys()].sort()) {
    (project.metrics.get(name)?.spec?.tests ?? []).forEach((_, index) => {
      planned.push({ kind: "metric", target: name, index, data: testData(project, name, index) });
    });
  }
  for (const name of Object.keys(config.sources).sort()) {
    testsOfSource(config.sources[name]).forEach((_, index) => {
      planned.push({ kind: "source", target: name, index, data: {}, rows: true });
    });
  }
  const known = [...new Set([...project.metrics.keys(), ...Object.keys(config.sources)])].sort();
  const unknown = positionals.find((p) => !known.includes(p));
  if (unknown !== undefined) {
    return usageError("HM0002", `no metric or source "${unknown}"`, {
      expected: known,
      input: unknown,
    });
  }
  const selected = planned.filter(
    (p) => positionals.length === 0 || positionals.includes(p.target),
  );

  const groups = new Map<string, Planned[]>();
  for (const p of selected) {
    const key = p.rows ? "rows" : JSON.stringify(Object.entries(p.data).sort());
    groups.set(key, [...(groups.get(key) ?? []), p]);
  }
  const results: TestResult[] = [];
  const now = new Date();
  for (const group of groups.values()) {
    const data = group[0]?.data ?? {};
    const missing: string[] = [];
    for (const file of Object.values(data)) if (!(await host.isFile(file))) missing.push(file);
    if (missing.length > 0) {
      for (const p of group) {
        const file = project.metrics.get(p.target)?.file ?? `metrics/${p.target}.yaml`;
        const pointer = `/tests/${p.index}/data`;
        results.push({
          kind: p.kind,
          target: p.target,
          index: p.index,
          file,
          pointer,
          status: "error",
          diagnostics: missing.map((m) => ({
            code: "HM1001",
            severity: "error",
            message: `test data file "${m}" not found`,
            file,
            pointer,
            ...(project.metrics.get(p.target)?.document.locationOf(pointer) ?? {}),
            docs: docsCommand("HM1001"),
          })),
        });
      }
      continue;
    }
    const swapped = group[0]?.rows
      ? forRowCounts(project)
      : await withFixtureColumns(host, project, data);
    const executor = await createDuckDbExecutor({
      root: ctx.root,
      config: swapped.config.spec ?? config,
    });
    try {
      for (const p of group) {
        results.push(
          p.kind === "metric"
            ? await runMetricTest(swapped, p.target, p.index, executor, now)
            : await runSourceTest(swapped, p.target, p.index, executor, now),
        );
      }
    } finally {
      await executor.close();
    }
  }
  const order = (r: TestResult) =>
    selected.findIndex((p) => p.kind === r.kind && p.target === r.target && p.index === r.index);
  results.sort((a, b) => order(a) - order(b));
  const diagnostics = results.flatMap((r) => r.diagnostics);
  const report = createReport(diagnostics);
  const json = envelope(report, results);
  const summary = { passed: json.passed, failed: json.failed, errors: json.errors };
  const ok = json.ok;
  const fallback = exitCodeFor(diagnostics, false);
  const exitCode = ok
    ? EXIT.ok
    : summary.failed > 0 || fallback === EXIT.ok
      ? EXIT.check
      : fallback;
  const label = (r: TestResult) =>
    `${r.status.padEnd(5)}  ${r.kind === "metric" ? r.target : `${CONFIG_FILE} sources.${r.target}`} tests[${r.index}]${r.name ? ` ${r.name}` : ""}`;
  const lines = results.map(label);
  const tally = `${summary.passed} passed, ${summary.failed} failed, ${summary.errors} could not run`;
  return {
    exitCode,
    json,
    human:
      results.length === 0
        ? "no tests: add tests to a metric file or a source in hatchmark.yaml"
        : [
            lines.join("\n"),
            diagnostics.length > 0 ? renderHuman(report, { color: ctx.color }) : "",
            tally,
          ]
            .filter((s) => s !== "")
            .join("\n\n"),
  };
}
