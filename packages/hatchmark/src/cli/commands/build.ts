import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { type DashboardData, type DashboardExecutor, runDashboard } from "../../compiler/index.js";
import { createReport, type Diagnostic, renderHuman } from "../../diagnostics/index.js";
import { createDuckDbExecutor, nodeProjectHost } from "../../node/index.js";
import { FONT_FILES, renderDashboardPage, renderIndexPage } from "../../render/index.js";
import { loadProject, type Project, type ProjectConfig } from "../../spec/index.js";
import type { CommandHelp } from "../help.js";
import { type CommandContext, type CommandResult, EXIT } from "../io.js";
import { usageError } from "../usage.js";
import { exitCodeFor } from "./check.js";

export const buildHelp: CommandHelp = {
  name: "build",
  summary:
    "Build every dashboard into static HTML: check, run the queries, render, write the output directory.",
  usage: "hatchmark build [--out <dir>]",
  options: [
    {
      flag: "--out <dir>",
      description:
        "Write here instead of outDir from hatchmark.json, relative to --cwd. Replaced on every build.",
    },
  ],
  example: {
    command: "hatchmark build --json",
    description:
      'Writes dist/sales/index.html and dist/_hatchmark/, and prints {"format_version":"1","ok":true,"out_dir":"dist","pages":[...]}.',
  },
};

/** Where the package keeps its bundled assets: the same path from src/ and from dist/. */
const ASSETS = new URL("../../../assets/", import.meta.url);
const ASSET_DIR = "_hatchmark";

/** What build needs from the platform; tests inject their own. */
export interface BuildDeps {
  createExecutor(options: {
    root: string;
    config: ProjectConfig;
  }): Promise<DashboardExecutor & { close(): Promise<void> }>;
  runDashboard: typeof runDashboard;
}

const defaultDeps: BuildDeps = { createExecutor: createDuckDbExecutor, runDashboard };

function hashedName(file: string, content: Uint8Array): string {
  const hash = createHash("sha256").update(content).digest("hex").slice(0, 10);
  const ext = path.extname(file);
  return `${file.slice(0, -ext.length)}.${hash}${ext}`;
}

async function readAsset(relative: string): Promise<Uint8Array> {
  try {
    return await readFile(new URL(relative, ASSETS));
  } catch {
    throw new Error(
      `bundled asset ${relative} is missing from the hatchmark package; reinstall it, or run pnpm build in a source checkout`,
    );
  }
}

/**
 * The output directory is deleted and rewritten on every build, so build refuses a directory it
 * did not write (no _hatchmark/ inside) unless it is empty, and never the project itself.
 */
async function checkOutDir(root: string, outDir: string): Promise<string | undefined> {
  const relative = path.relative(outDir, root);
  if (relative === "" || !relative.startsWith("..")) {
    return "the output directory must not contain the project; choose a directory inside it, such as dist";
  }
  const entries = await readdir(outDir).catch(() => undefined);
  if (entries === undefined || entries.length === 0) return undefined;
  const marker = await stat(path.join(outDir, ASSET_DIR)).catch(() => undefined);
  if (marker?.isDirectory()) return undefined;
  return `${path.relative(root, outDir) || outDir} is not empty and was not written by hatchmark build; empty it or choose another --out`;
}

/**
 * Builds every dashboard of the project into static files. runDashboard checks the project first
 * and executes nothing when check finds errors; those errors exit 1 like hatchmark check. Output: <out>/<dashboard>/index.html, an
 * index page when there is more than one dashboard, and <out>/_hatchmark/ with the runtime and
 * fonts under content-hashed names. All URLs are relative, so the output works on any static host
 * and under any sub-path. Identical input gives byte-identical output.
 */
export async function build(
  ctx: CommandContext,
  flags: { out?: string },
  deps: BuildDeps = defaultDeps,
): Promise<CommandResult> {
  const { project, diagnostics: loadDiagnostics } = await loadProject(nodeProjectHost(ctx.root));
  if (project === undefined || project.config.spec === undefined) {
    const report = createReport(loadDiagnostics);
    return { exitCode: EXIT.usage, json: report, human: renderHuman(report, { color: ctx.color }) };
  }
  const config = project.config.spec;
  const outDir = path.resolve(ctx.root, flags.out ?? config.outDir);
  const refused = await checkOutDir(ctx.root, outDir);
  if (refused !== undefined) return usageError("HM0004", refused);

  const { pages, diagnostics } = await runAll(ctx.root, project, config, deps);
  if (diagnostics.some((d) => d.severity === "error")) {
    const report = createReport(diagnostics);
    return {
      exitCode: exitCodeFor(report.diagnostics, false),
      json: report,
      human: renderHuman(report, { color: ctx.color }),
    };
  }

  const files = new Map<string, Uint8Array | string>();
  const fonts: Record<string, string> = {};
  for (const font of FONT_FILES) {
    const content = await readAsset(`fonts/${font.file}`);
    const name = hashedName(font.file, content);
    files.set(`${ASSET_DIR}/${name}`, content);
    fonts[font.file] = name;
  }
  files.set(`${ASSET_DIR}/OFL.txt`, await readAsset("fonts/OFL.txt"));
  const runtime = await readAsset("runtime/hatchmark.js");
  const runtimeName = hashedName("hatchmark.js", runtime);
  files.set(`${ASSET_DIR}/${runtimeName}`, runtime);
  const assetsFrom = (prefix: string) => ({
    runtime: `${prefix}${ASSET_DIR}/${runtimeName}`,
    fonts: Object.fromEntries(
      Object.entries(fonts).map(([file, name]) => [file, `${prefix}${ASSET_DIR}/${name}`]),
    ),
  });
  const sources = [
    ...new Set(Object.values(config.sources).map((s) => path.posix.basename(s.path))),
  ].sort();
  for (const data of pages) {
    files.set(
      `${data.name}/index.html`,
      renderDashboardPage(data, { assets: assetsFrom("../"), sources }),
    );
  }
  if (pages.length > 1) {
    files.set(
      "index.html",
      renderIndexPage(
        config.name,
        pages.map((p) => ({
          name: p.name,
          title: p.title,
          ...(p.description === undefined ? {} : { description: p.description }),
        })),
        { assets: assetsFrom("") },
      ),
    );
  }

  await rm(outDir, { recursive: true, force: true });
  for (const [file, content] of [...files].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const target = path.join(outDir, ...file.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }

  const report = createReport(diagnostics);
  const relative = path.relative(ctx.root, outDir);
  const outLabel = relative.startsWith("..") ? outDir : relative.split(path.sep).join("/") || ".";
  const written = pages.map((p) => ({
    dashboard: p.name,
    path: `${outLabel}/${p.name}/index.html`,
  }));
  const json = {
    ...report,
    out_dir: outLabel,
    pages: written,
    ...(pages.length > 1 ? { index: `${outLabel}/index.html` } : {}),
    files: files.size,
  };
  const warnings = report.warning_count > 0 ? `${renderHuman(report, { color: ctx.color })}\n` : "";
  const human =
    ctx.quiet && report.warning_count === 0
      ? ""
      : `${warnings}Built ${pages.length} dashboard${pages.length === 1 ? "" : "s"} into ${outLabel}/\n${written.map((p) => `  ${p.path}`).join("\n")}`;
  return { exitCode: EXIT.ok, json, human };
}

async function runAll(
  root: string,
  project: Project,
  config: ProjectConfig,
  deps: BuildDeps,
): Promise<{ pages: DashboardData[]; diagnostics: Diagnostic[] }> {
  const pages: DashboardData[] = [];
  const diagnostics = new Map<string, Diagnostic>();
  const executor = await deps.createExecutor({ root, config });
  try {
    for (const name of [...project.dashboards.keys()].sort()) {
      const result = await deps.runDashboard(project, name, executor);
      for (const d of result.diagnostics) diagnostics.set(JSON.stringify(d), d);
      if (result.data) pages.push(result.data);
    }
  } finally {
    await executor.close();
  }
  return { pages, diagnostics: [...diagnostics.values()] };
}
