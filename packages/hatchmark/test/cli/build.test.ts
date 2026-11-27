import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { SALES } from "../../gallery/fixtures.js";
import { type BuildDeps, build } from "../../src/cli/commands/build.js";
import type { CommandContext } from "../../src/cli/io.js";
import { run } from "../../src/cli/main.js";
import { runDashboard } from "../../src/compiler/index.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const io = {
  stdout: () => {},
  stderr: () => {},
  cwd: "/",
  env: {},
  stdoutIsTTY: false,
  isAgent: async () => false,
};

async function project(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "hatchmark-build-"));
  dirs.push(dir);
  expect(await run(["init", "shop", "--cwd", dir], io)).toBe(0);
  return path.join(dir, "shop");
}

const ctx = (root: string): CommandContext => ({
  io,
  root,
  mode: "json",
  color: false,
  quiet: false,
});

/** Stands in for the DuckDB executor and the planner: every dashboard gets the sample data. */
const deps: BuildDeps = {
  createExecutor: async () => ({
    execute: async () => ({ columns: [], rows: [] }),
    latestDate: async () => "2026-10-31",
    close: async () => {},
  }),
  runDashboard: async (_project, name) => ({
    data: { ...structuredClone(SALES), name },
    diagnostics: [],
  }),
};

async function tree(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(entry.parentPath, entry.name);
    out[path.relative(dir, file)] = createHash("sha256")
      .update(await readFile(file))
      .digest("hex");
  }
  return out;
}

describe("hatchmark build", () => {
  it("writes one page per dashboard plus hashed assets, with relative URLs only", async () => {
    const root = await project();
    const result = await build(ctx(root), {}, deps);
    expect(result.exitCode).toBe(0);
    expect(result.json).toMatchObject({
      format_version: "1",
      ok: true,
      out_dir: "dist",
      pages: [{ dashboard: "sales", path: "dist/sales/index.html" }],
    });
    const files = Object.keys(await tree(path.join(root, "dist"))).sort();
    expect(files.filter((f) => !f.startsWith("_hatchmark"))).toEqual(["sales/index.html"]);
    expect(files).toContain("_hatchmark/OFL.txt");
    expect(files.some((f) => /^_hatchmark\/hatchmark\.[0-9a-f]{10}\.js$/.test(f))).toBe(true);
    const html = await readFile(path.join(root, "dist/sales/index.html"), "utf8");
    const urls = [...html.matchAll(/(?:src|href)="([^"]+)"|url\("([^"]+)"\)/g)].map(
      (m) => m[1] ?? m[2],
    );
    expect(urls.length).toBeGreaterThan(6);
    for (const url of urls) {
      expect(url).toMatch(/^\.\.\/_hatchmark\//);
      expect(files).toContain(url?.slice(3));
    }
  });

  it("is byte-identical across builds", async () => {
    const root = await project();
    await build(ctx(root), {}, deps);
    const first = await tree(path.join(root, "dist"));
    await build(ctx(root), {}, deps);
    expect(await tree(path.join(root, "dist"))).toEqual(first);
  });

  it("writes an index page when there is more than one dashboard", async () => {
    const root = await project();
    const spec = await readFile(path.join(root, "dashboards/sales.json"), "utf8");
    await writeFile(path.join(root, "dashboards/marketing.json"), spec);
    const result = await build(ctx(root), { out: "public/site" }, deps);
    expect(result.exitCode).toBe(0);
    expect(result.json).toMatchObject({ out_dir: "public/site", index: "public/site/index.html" });
    const index = await readFile(path.join(root, "public/site/index.html"), "utf8");
    expect(index).toContain('href="./marketing/"');
    expect(index).toContain('href="./sales/"');
  });

  it("refuses to replace a directory it did not write, or the project itself", async () => {
    const root = await project();
    await mkdir(path.join(root, "dist"));
    await writeFile(path.join(root, "dist/keep.txt"), "mine");
    const foreign = await build(ctx(root), {}, deps);
    expect(foreign.exitCode).toBe(2);
    expect(foreign.json).toMatchObject({ diagnostics: [{ code: "HM0004" }] });
    expect(await readFile(path.join(root, "dist/keep.txt"), "utf8")).toBe("mine");
    const self = await build(ctx(root), { out: "." }, deps);
    expect(self.exitCode).toBe(2);
  });

  it("refuses to build a project with check errors", async () => {
    const root = await project();
    await writeFile(
      path.join(root, "dashboards/sales.json"),
      '{"title": "Sales", "blocks": [{"type": "kpi", "metric": "revenu"}]}',
    );
    const result = await build(ctx(root), {}, { ...deps, runDashboard });
    expect(result.exitCode).toBe(1);
    expect(result.json).toMatchObject({ ok: false, diagnostics: [{ code: "HM2003" }] });
  });

  it("reports engine errors without writing anything", async () => {
    const root = await project();
    const failing: BuildDeps = {
      ...deps,
      runDashboard: async () => ({
        diagnostics: [
          {
            code: "HM2010",
            severity: "error",
            message: "data file not found",
            docs: "hatchmark explain HM2010",
          },
        ],
      }),
    };
    const result = await build(ctx(root), {}, failing);
    expect(result.exitCode).toBe(3);
    await expect(readdir(path.join(root, "dist"))).rejects.toThrow();
  });

  it("builds the global-sales example end to end with DuckDB", async () => {
    const example = fileURLToPath(new URL("../../examples/global-sales/", import.meta.url));
    const out = await mkdtemp(path.join(tmpdir(), "hatchmark-example-"));
    dirs.push(out);
    const target = path.join(out, "site");
    const first = await build(ctx(example), { out: target });
    expect(first.exitCode, JSON.stringify(first.json)).toBe(0);
    const html = await readFile(path.join(target, "sales/index.html"), "utf8");
    expect(html).toContain("<h1>Global sales</h1>");
    expect(html).toContain("Data through Oct 31, 2026");
    expect(html).toContain('<table class="hm-table">');
    const bytes = await tree(target);
    await build(ctx(example), { out: target });
    expect(await tree(target)).toEqual(bytes);
  });

  it("has help with an example", async () => {
    let out = "";
    const code = await run(["build", "--help", "--json"], {
      ...io,
      stdout: (t) => {
        out += t;
      },
    });
    expect(code).toBe(0);
    expect(JSON.parse(out)).toMatchObject({
      command: "build",
      usage: "hatchmark build [--out <dir>]",
    });
  });
});
