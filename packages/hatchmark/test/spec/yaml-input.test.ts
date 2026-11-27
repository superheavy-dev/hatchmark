import { describe, expect, it } from "vitest";
import { loadProject, type ProjectHost, parseSpecFile } from "../../src/spec/index.js";
import { applyFix } from "./helpers.js";

function memoryHost(files: Record<string, string>): ProjectHost {
  const has = (file: string) => Object.hasOwn(files, file);
  return {
    label: "/project",
    readText: async (file) => (has(file) ? files[file] : undefined),
    listFiles: async (dir) =>
      Object.keys(files)
        .filter((f) => f.startsWith(`${dir}/`) && !f.slice(dir.length + 1).includes("/"))
        .map((f) => f.slice(dir.length + 1)),
    isFile: async (file) => has(file),
    readHead: async (file) => (has(file) ? { text: files[file] ?? "", complete: true } : undefined),
  };
}

const CONFIG = `version: 1
name: Shop
dataDir: data
metricsDir: metrics
dashboardsDir: dashboards
outDir: dist
locale: en-US
currency: USD
timezone: UTC
weekStart: monday
theme: default
telemetry: false
sources: {}
`;

describe("YAML spec files", () => {
  it("names the .yaml file a leftover .json or .yml spec file should be", async () => {
    const { diagnostics } = await loadProject(
      memoryHost({
        "hatchmark.yaml": CONFIG,
        "hatchmark.json": "{}",
        "metrics/revenue.json": "{}",
        "dashboards/sales.yml": "title: Sales",
        "data/orders.json": "[]",
      }),
    );
    expect(diagnostics.map((d) => [d.code, d.file, d.message])).toEqual([
      [
        "HM1007",
        "hatchmark.json",
        "hatchmark.json is not read: spec files are YAML, in hatchmark.yaml",
      ],
      [
        "HM1007",
        "metrics/revenue.json",
        "metrics/revenue.json is not read: spec files are YAML, in metrics/revenue.yaml",
      ],
      [
        "HM1007",
        "dashboards/sales.yml",
        "dashboards/sales.yml is not read: spec files are YAML, in dashboards/sales.yaml",
      ],
    ]);
  });

  it("reports a project with only hatchmark.json as HM1007, not as a missing project", async () => {
    const { project, diagnostics } = await loadProject(memoryHost({ "hatchmark.json": "{}" }));
    expect(project).toBeUndefined();
    expect(diagnostics.map((d) => d.code)).toEqual(["HM1007"]);
  });

  it("asks to quote a number or boolean where a string is expected, with a safe fix", () => {
    const text =
      "label: 2026\ntype: aggregate\ntable: orders\naggregate: count\nformat:\n  type: number\nbetter: up\n";
    const [d] = parseSpecFile("metric", "metrics/orders.yaml", text).diagnostics;
    expect(d).toMatchObject({
      code: "HM3003",
      pointer: "/label",
      range: { start: { line: 1, column: 8 }, end: { line: 1, column: 12 } },
      help: 'YAML reads 2026 as a number; quote it to keep it a string: "2026"',
    });
    expect(applyFix(text, d?.fix)).toContain('label: "2026"\n');
    expect(
      parseSpecFile("metric", "metrics/orders.yaml", applyFix(text, d?.fix)).diagnostics,
    ).toEqual([]);
  });

  it("keeps 0012 as written when quoting it", () => {
    const text =
      "label: 0012\ntype: aggregate\ntable: orders\naggregate: count\nformat:\n  type: number\nbetter: up\n";
    const [d] = parseSpecFile("metric", "metrics/orders.yaml", text).diagnostics;
    expect(d?.fix?.text).toBe('"0012"');
  });

  it("does not check the schema of a file with an anchor or alias", () => {
    const text = "label: &l Orders\ndescription: *l\n";
    const codes = parseSpecFile("metric", "metrics/orders.yaml", text).diagnostics.map(
      (d) => d.code,
    );
    expect(codes).toEqual(["HM1006", "HM1006"]);
  });

  it("reads multi-line SQL from a block scalar", () => {
    const text =
      "label: Net\ntype: sql\ntable: orders\nsql: |\n  sum(amount)\n    - sum(refund)\nadditive: true\nformat:\n  type: number\nbetter: up\n";
    const file = parseSpecFile("metric", "metrics/net.yaml", text);
    expect(file.diagnostics).toEqual([]);
    expect(file.spec).toMatchObject({ sql: "sum(amount)\n  - sum(refund)\n" });
  });
});
