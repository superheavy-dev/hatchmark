import {
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
import { CONFIG_FILE, checkReferences, loadProject, parseDiagnostics } from "../../spec/index.js";
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
      exitCode: exitCodeFor(errors, false),
      json: report,
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
    (config.sources[name]?.tests ?? []).forEach((_, index) => {
      planned.push({ kind: "source", target: name, index, data: {} });
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
    const key = JSON.stringify(Object.entries(p.data).sort());
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
    const swapped = withTestData(project, data);
    const executor = await createDuckDbExecutor({
      root: ctx.root,
      config: swapped.config.spec ?? config,
    });
    try {
      for (const p of group) {
        results.push(
          p.kind === "metric"
            ? await runMetricTest(project, p.target, p.index, executor, now)
            : await runSourceTest(project, p.target, p.index, executor, now),
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
  const count = (status: TestResult["status"]) => results.filter((r) => r.status === status).length;
  const summary = { passed: count("pass"), failed: count("fail"), errors: count("error") };
  const report = createReport(diagnostics);
  const ok = summary.failed === 0 && summary.errors === 0;
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
    json: {
      format_version: "1",
      ok,
      ...summary,
      results: results.map(({ diagnostics: _, ...r }) => r),
      diagnostics: report.diagnostics,
    },
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
