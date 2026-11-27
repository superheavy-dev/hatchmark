import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SALES } from "../../gallery/fixtures.js";
import { type BuildDeps, build } from "../../src/cli/commands/build.js";
import type { CommandContext } from "../../src/cli/io.js";
import { run } from "../../src/cli/main.js";
import { runDashboard } from "../../src/compiler/index.js";
import { copyProject, EXAMPLE } from "../node/fixture.js";
import { fromYaml, toYaml } from "../yaml.js";

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
    horizon: async () => ({ latest: "2026-10-31", date: true, naive: false }),
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
    const spec = await readFile(path.join(root, "dashboards/sales.yaml"), "utf8");
    await writeFile(path.join(root, "dashboards/marketing.yaml"), spec);
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

  it("never deletes a file it did not write: only files in its manifest are replaced", async () => {
    const root = await project();
    const dist = path.join(root, "dist");
    expect((await build(ctx(root), {}, deps)).exitCode).toBe(0);
    const manifestPath = path.join(dist, "_hatchmark/manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { files: string[] };
    expect(manifest.files).toContain("sales/index.html");
    expect(manifest.files).not.toContain("_hatchmark/manifest.json");
    await writeFile(path.join(dist, "keep.txt"), "mine");
    await writeFile(path.join(dist, "_hatchmark/notes.txt"), "mine too");
    await mkdir(path.join(dist, "old"));
    await writeFile(path.join(dist, "old/index.html"), "stale page from an earlier build");
    manifest.files.push("old/index.html");
    await writeFile(manifestPath, JSON.stringify(manifest));
    expect((await build(ctx(root), {}, deps)).exitCode).toBe(0);
    expect(await readFile(path.join(dist, "keep.txt"), "utf8")).toBe("mine");
    expect(await readFile(path.join(dist, "_hatchmark/notes.txt"), "utf8")).toBe("mine too");
    expect(Object.keys(await tree(dist))).not.toContain("old/index.html");
  });

  it("refuses a non-empty directory without a manifest, even with an empty _hatchmark/", async () => {
    const root = await project();
    const out = await mkdtemp(path.join(tmpdir(), "hatchmark-out-"));
    dirs.push(out);
    await mkdir(path.join(out, "_hatchmark"));
    await writeFile(path.join(out, "keep"), "");
    const result = await build(ctx(root), { out }, deps);
    expect(result.exitCode).toBe(2);
    expect(result.json).toMatchObject({ diagnostics: [{ code: "HM0004" }] });
    expect(await readdir(out)).toEqual(["_hatchmark", "keep"]);
  });

  it("refuses to overwrite a file it would write but did not write before", async () => {
    const root = await project();
    const dist = path.join(root, "dist");
    expect((await build(ctx(root), {}, deps)).exitCode).toBe(0);
    const manifestPath = path.join(dist, "_hatchmark/manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { files: string[] };
    await writeFile(
      manifestPath,
      JSON.stringify({
        ...manifest,
        files: manifest.files.filter((f) => f !== "sales/index.html"),
      }),
    );
    await writeFile(path.join(dist, "sales/index.html"), "hand-written");
    const result = await build(ctx(root), {}, deps);
    expect(result.exitCode).toBe(2);
    expect(await readFile(path.join(dist, "sales/index.html"), "utf8")).toBe("hand-written");
  });

  describe("never follows a symbolic link", () => {
    /** A built project and a directory outside it with a hand-written index.html. */
    async function linked(): Promise<{ root: string; dist: string; other: string }> {
      const root = await project();
      const other = await mkdtemp(path.join(tmpdir(), "hatchmark-other-"));
      dirs.push(other);
      await writeFile(path.join(other, "index.html"), "hand-authored\n");
      expect((await build(ctx(root), {}, deps)).exitCode).toBe(0);
      return { root, dist: path.join(root, "dist"), other };
    }

    async function expectRefused(root: string, other: string): Promise<void> {
      const result = await build(ctx(root), {}, deps);
      expect(result.exitCode).toBe(2);
      expect(result.json).toMatchObject({ diagnostics: [{ code: "HM0004" }] });
      expect(await readdir(other)).toEqual(["index.html"]);
      expect(await readFile(path.join(other, "index.html"), "utf8")).toBe("hand-authored\n");
    }

    it("to remove a stale page through a symlinked dashboard directory", async () => {
      const { root, dist, other } = await linked();
      await rename(path.join(dist, "sales"), path.join(root, "previous"));
      await symlink(other, path.join(dist, "sales"));
      await rename(
        path.join(root, "dashboards/sales.yaml"),
        path.join(root, "dashboards/renamed.yaml"),
      );
      await expectRefused(root, other);
    });

    it("to overwrite a page through a symlinked directory with the dashboard's name", async () => {
      const { root, dist, other } = await linked();
      await rm(path.join(dist, "sales"), { recursive: true });
      await symlink(other, path.join(dist, "sales"));
      await expectRefused(root, other);
    });

    it("to overwrite or remove a page that is itself a symlinked file", async () => {
      const { root, dist, other } = await linked();
      const page = path.join(dist, "sales/index.html");
      await rm(page);
      await symlink(path.join(other, "index.html"), page);
      await expectRefused(root, other);
      await rename(
        path.join(root, "dashboards/sales.yaml"),
        path.join(root, "dashboards/renamed.yaml"),
      );
      await expectRefused(root, other);
    });

    it("to write into an output directory that is a symlink, even to an earlier build", async () => {
      const root = await project();
      const other = await mkdtemp(path.join(tmpdir(), "hatchmark-other-"));
      dirs.push(other);
      expect((await build(ctx(root), { out: other }, deps)).exitCode).toBe(0);
      const before = await tree(other);
      await rename(
        path.join(root, "dashboards/sales.yaml"),
        path.join(root, "dashboards/renamed.yaml"),
      );
      await symlink(other, path.join(root, "dist"));
      const direct = await build(ctx(root), {}, deps);
      expect(direct.exitCode).toBe(2);
      expect(direct.json).toMatchObject({ diagnostics: [{ code: "HM0004" }] });
      await mkdir(path.join(root, "site"));
      await symlink(other, path.join(root, "site/out"));
      expect((await build(ctx(root), { out: "site/out" }, deps)).exitCode).toBe(2);
      expect(await tree(other)).toEqual(before);
    });
  });

  it("never touches a file at a name it might use for a temporary file", async () => {
    const root = await project();
    const dist = path.join(root, "dist");
    expect((await build(ctx(root), {}, deps)).exitCode).toBe(0);
    const taken = "00000000-0000-4000-8000-000000000000";
    const strays = [`index.html.${process.pid}.tmp`, `index.html.${taken}.tmp`];
    for (const stray of strays) await writeFile(path.join(dist, "sales", stray), "keep\n");
    const uuid = vi.spyOn(crypto, "randomUUID");
    try {
      uuid.mockReturnValueOnce(taken);
      expect((await build(ctx(root), {}, deps)).exitCode).toBe(0);
      expect((await readdir(path.join(dist, "sales"))).sort()).toEqual(
        ["index.html", ...strays].sort(),
      );
      uuid.mockReturnValue(taken);
      const exhausted = await build(ctx(root), {}, deps);
      expect(exhausted.exitCode).toBe(2);
      expect(exhausted.json).toMatchObject({ diagnostics: [{ code: "HM0004" }] });
    } finally {
      uuid.mockRestore();
    }
    for (const stray of strays) {
      expect(await readFile(path.join(dist, "sales", stray), "utf8")).toBe("keep\n");
    }
  });

  it("reports HM2024 for a chart narrower than 3 columns and still builds it", async () => {
    const root = await project();
    const file = path.join(root, "dashboards/sales.yaml");
    const spec = fromYaml(await readFile(file, "utf8"));
    const chart = spec.blocks.findIndex(
      (b: { type: string }) => b.type === "line" || b.type === "bar",
    );
    spec.blocks[chart].span = 1;
    await writeFile(file, toYaml(spec));
    const result = await build(ctx(root), {}, { ...deps, runDashboard });
    expect(result.exitCode).toBe(0);
    expect(result.json).toMatchObject({ ok: true });
    expect(
      (result.json as { diagnostics: { code: string; severity: string; pointer: string }[] })
        .diagnostics,
    ).toContainEqual(
      expect.objectContaining({
        code: "HM2024",
        severity: "warning",
        pointer: `/blocks/${chart}/span`,
      }),
    );
  });

  it("refuses to build a project with check errors", async () => {
    const root = await project();
    await writeFile(
      path.join(root, "dashboards/sales.yaml"),
      '{"title": "Sales", "blocks": [{"type": "kpi", "metric": "revenu"}]}',
    );
    const result = await build(ctx(root), {}, { ...deps, runDashboard });
    expect(result.exitCode).toBe(1);
    expect(result.json).toMatchObject({ ok: false, diagnostics: [{ code: "HM2003" }] });
  });

  it("refuses to build a project with a leftover JSON spec file", async () => {
    const root = await project();
    await rename(
      path.join(root, "dashboards/sales.yaml"),
      path.join(root, "dashboards/sales.json"),
    );
    const result = await build(ctx(root), {}, { ...deps, runDashboard });
    expect(result.exitCode).toBe(1);
    expect(result.json).toMatchObject({
      ok: false,
      diagnostics: [{ code: "HM1007", file: "dashboards/sales.json" }],
    });
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
    const example = await copyProject(EXAMPLE, "hatchmark-example-");
    dirs.push(example);
    const out = await mkdtemp(path.join(tmpdir(), "hatchmark-example-"));
    dirs.push(out);
    const target = path.join(out, "site");
    const first = await build(ctx(example), { out: target });
    expect(first.exitCode, JSON.stringify(first.json)).toBe(0);
    const html = await readFile(path.join(target, "sales/index.html"), "utf8");
    expect(html).toContain("<h1>Global sales</h1>");
    expect(html).toContain("Data through Oct 31, 2026");
    expect(html).toContain('<table aria-describedby="hm-');
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
      usage: "hatchmark build [--out <dir>] [--no-cache]",
    });
  });
});
