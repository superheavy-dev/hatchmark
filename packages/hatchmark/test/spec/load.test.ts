import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { nodeProjectHost } from "../../src/node/index.js";
import { checkReferences, loadProject, parseDiagnostics } from "../../src/spec/index.js";
import { fromYaml, toYaml } from "../yaml.js";
import { applyFix, CONFIG, DASHBOARD, METRICS } from "./helpers.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tempProject(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "hatchmark-load-"));
  dirs.push(root);
  for (const [name, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), text);
  }
  return root;
}

describe("loadProject", () => {
  it("reports a missing config", async () => {
    const root = await tempProject({});
    const { project, diagnostics } = await loadProject(nodeProjectHost(root));
    expect(project).toBeUndefined();
    expect(diagnostics).toMatchObject([{ code: "HM1005" }]);
  });

  it("loads metrics and dashboards in name order and checks data files", async () => {
    const root = await tempProject({
      "hatchmark.yaml": toYaml(CONFIG),
      "data/orders.csv": '\ufeffamount,"region, US"\r\n1,West\n',
      "metrics/revenue.yaml": toYaml(METRICS.revenue),
      "metrics/orders.yaml": toYaml(METRICS.orders),
      "metrics/notes.txt": "ignored",
      "dashboards/sales.yaml": toYaml(DASHBOARD),
    });
    const { project, diagnostics } = await loadProject(nodeProjectHost(root));
    expect([...(project?.metrics.keys() ?? [])]).toEqual(["orders", "revenue"]);
    expect(project?.dashboards.get("sales")?.file).toBe("dashboards/sales.yaml");
    expect(project && parseDiagnostics(project)).toEqual([]);
    expect(diagnostics).toMatchObject([
      { code: "HM2010", pointer: "/sources/merchants/path", file: "hatchmark.yaml" },
    ]);
    expect([...(project?.missingData ?? [])]).toEqual(["merchants"]);
    expect(project?.columns.get("orders")).toEqual(["amount", "region, US"]);
  });

  it("reads a header-only CSV with no trailing line break as complete", async () => {
    const root = await tempProject({
      "hatchmark.yaml": toYaml({
        ...CONFIG,
        sources: { orders: { type: "csv", path: "data/orders.csv" } },
      }),
      "data/orders.csv": "a,b",
    });
    const { project } = await loadProject(nodeProjectHost(root));
    expect(project?.columns.get("orders")).toEqual(["a", "b"]);
  });

  it("falls back to the configured directories when the config is invalid", async () => {
    const root = await tempProject({
      "hatchmark.yaml": toYaml({ ...CONFIG, metricsDir: "defs", locale: 1, sources: {} }),
      "defs/orders.yaml": toYaml(METRICS.orders),
    });
    const { project } = await loadProject(nodeProjectHost(root));
    expect(project?.config.spec).toBeUndefined();
    expect([...(project?.metrics.keys() ?? [])]).toEqual(["orders"]);
  });
});

describe("source paths with glob characters", () => {
  it.each([
    ["*", "data/orders*.csv", "data/orders_.csv"],
    ["?", "data/orders?.csv", "data/orders_.csv"],
    ["[", "data/orders[1].csv", "data/orders_1_.csv"],
  ])("rejects %s with HM2016 at the path, even when the file exists", async (_, file, renamed) => {
    const root = await tempProject({
      "hatchmark.yaml": toYaml({
        ...CONFIG,
        sources: { orders: { type: "csv", path: file } },
      }),
      [file]: "amount\n1\n",
      "data/orders1.csv": "amount\n2\n",
    });
    const { project, diagnostics } = await loadProject(nodeProjectHost(root));
    if (project === undefined) throw new Error("no project");
    expect(diagnostics).toEqual([]);
    expect(project.columns.has("orders")).toBe(false);
    const found = checkReferences(project).filter((d) => d.code === "HM2016");
    expect(found).toMatchObject([
      {
        severity: "error",
        file: "hatchmark.yaml",
        pointer: "/sources/orders/path",
        fix: { applicability: "unsafe", text: renamed },
      },
    ]);
    const fixed = fromYaml(applyFix(project.config.document.text, found[0]?.fix));
    expect(fixed.sources.orders.path).toBe(renamed);
  });
});
