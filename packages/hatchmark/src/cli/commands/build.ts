import { createHash } from "node:crypto";
import {
  type FileHandle,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
} from "node:fs/promises";
import path from "node:path";
import { type DashboardData, type DashboardExecutor, runDashboard } from "../../compiler/index.js";
import { createReport, type Diagnostic, renderHuman } from "../../diagnostics/index.js";
import {
  type CacheStats,
  createCachedExecutor,
  createDuckDbExecutor,
  nodeProjectHost,
} from "../../node/index.js";
import { FONT_FILES, renderDashboardPage, renderIndexPage } from "../../render/index.js";
import {
  checkReferences,
  loadProject,
  type Project,
  type ProjectConfig,
  parseDiagnostics,
} from "../../spec/index.js";
import type { CommandHelp } from "../help.js";
import { type CommandContext, type CommandResult, EXIT } from "../io.js";
import { usageError } from "../usage.js";
import { exitCodeFor } from "./check.js";

export const buildHelp: CommandHelp = {
  name: "build",
  summary:
    "Build every dashboard into static HTML: check, run the queries, render, write the output directory.",
  usage: "hatchmark build [--out <dir>] [--no-cache]",
  options: [
    {
      flag: "--out <dir>",
      description:
        "Write here instead of outDir from hatchmark.json, relative to --cwd. Only files an earlier build wrote are replaced.",
    },
    {
      flag: "--no-cache",
      description:
        "Run every query instead of reusing results from .hatchmark/cache/, and write no cache entries. The output is the same either way.",
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
const MANIFEST = `${ASSET_DIR}/manifest.json`;

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
 * Build never deletes a file it did not write. Every build records its files in
 * _hatchmark/manifest.json; the next build removes exactly those and nothing else. A non-empty
 * directory without a readable manifest is refused, as is one where a file build would write
 * exists but is not in the manifest, and the project directory itself. Build never follows a
 * symbolic link: the output directory, every directory between it and the project, and every
 * path under it that build reads, removes or writes must be a real directory or file. Returns
 * the previous build's files, or a reason to refuse.
 */
async function checkOutDir(
  root: string,
  outDir: string,
  writing: ReadonlySet<string>,
): Promise<{ previous: string[] } | { refused: string }> {
  const label = path.relative(root, outDir) || outDir;
  const relative = path.relative(await realLocation(outDir), await realLocation(root));
  if (relative === "" || !relative.startsWith("..")) {
    return {
      refused:
        "the output directory must not contain the project; choose a directory inside it, such as dist",
    };
  }
  const inside = path.relative(root, outDir);
  const steps =
    inside.startsWith("..") || path.isAbsolute(inside)
      ? [outDir]
      : inside.split(path.sep).map((_, i, parts) => path.join(root, ...parts.slice(0, i + 1)));
  for (const at of steps) {
    const stat = await lstat(at).catch(() => undefined);
    if (stat === undefined) break;
    if (stat.isSymbolicLink()) {
      return {
        refused: `${path.relative(root, at) || at} is a symbolic link, and build never writes through one; choose a real directory for --out`,
      };
    }
  }
  const entries = await readdir(outDir).catch(() => undefined);
  if (entries === undefined || entries.length === 0) return { previous: [] };
  const linked = await unsafeTarget(outDir, MANIFEST);
  if (linked !== undefined) return { refused: `${label}/${linked}` };
  const manifest = await readFile(path.join(outDir, ...MANIFEST.split("/")), "utf8")
    .then((text) => JSON.parse(text) as { files?: unknown })
    .catch(() => undefined);
  const files = manifest?.files;
  if (!Array.isArray(files) || !files.every((f) => typeof f === "string" && isOwnPath(f))) {
    return {
      refused: `${label} is not empty and has no hatchmark build manifest (${MANIFEST}); empty it or choose another --out`,
    };
  }
  const previous = new Set<string>(files);
  for (const file of new Set([...previous, ...writing])) {
    const unsafe = await unsafeTarget(outDir, file);
    if (unsafe !== undefined) return { refused: `${label}/${unsafe}` };
    if (previous.has(file) || file === MANIFEST) continue;
    const exists = await lstat(path.join(outDir, ...file.split("/"))).then(
      () => true,
      (error: NodeJS.ErrnoException) => error.code !== "ENOENT",
    );
    if (exists) {
      return {
        refused: `${label}/${file} exists but was not written by hatchmark build; move it or choose another --out`,
      };
    }
  }
  return { previous: [...previous] };
}

/**
 * Walks file from outDir one component at a time with lstat, so nothing is followed: each
 * directory on the way must be a real directory and the file itself a regular file, or the walk
 * stops at the first one that does not exist yet. Returns why the path is unsafe, or undefined.
 */
async function unsafeTarget(outDir: string, file: string): Promise<string | undefined> {
  const parts = file.split("/");
  for (let i = 1; i <= parts.length; i++) {
    const shown = parts.slice(0, i).join("/");
    const stat = await lstat(path.join(outDir, ...parts.slice(0, i))).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      },
    );
    if (stat === undefined) return undefined;
    if (stat.isSymbolicLink()) {
      return `${shown} is a symbolic link, and build never follows one; remove the link or choose another --out`;
    }
    if (i < parts.length ? !stat.isDirectory() : !stat.isFile()) {
      return `${shown} is not the ${i < parts.length ? "directory" : "file"} hatchmark build wrote; move it or choose another --out`;
    }
  }
  return undefined;
}

/**
 * Creates a new, empty file next to target under a random name, exclusively (O_CREAT | O_EXCL), so
 * it never opens, follows or replaces anything that already exists. Tries a few names; undefined
 * when every one is taken.
 */
async function openFresh(
  target: string,
): Promise<{ path: string; handle: FileHandle } | undefined> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const fresh = `${target}.${crypto.randomUUID()}.tmp`;
    try {
      return { path: fresh, handle: await open(fresh, "wx") };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  return undefined;
}

/** The real path of p, through its deepest existing ancestor when p does not exist yet. */
async function realLocation(p: string): Promise<string> {
  const missing: string[] = [];
  for (let at = p; ; at = path.dirname(at)) {
    const real = await realpath(at).catch(() => undefined);
    if (real !== undefined) return path.join(real, ...missing);
    if (path.dirname(at) === at) return p;
    missing.unshift(path.basename(at));
  }
}

/** A relative POSIX path that stays inside the output directory. */
function isOwnPath(file: string): boolean {
  const normal = path.posix.normalize(file);
  return normal === file && !path.posix.isAbsolute(file) && !normal.startsWith("..");
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
  flags: { out?: string; cache?: boolean },
  deps: BuildDeps = defaultDeps,
): Promise<CommandResult> {
  const { project, diagnostics: loadDiagnostics } = await loadProject(nodeProjectHost(ctx.root));
  if (project === undefined || project.config.spec === undefined) {
    const report = createReport(loadDiagnostics);
    return { exitCode: EXIT.usage, json: report, human: renderHuman(report, { color: ctx.color }) };
  }
  const config = project.config.spec;
  const outDir = path.resolve(ctx.root, flags.out ?? config.outDir);
  const pending = await checkOutDir(ctx.root, outDir, new Set());
  if ("refused" in pending) return usageError("HM0004", pending.refused);

  const { pages, diagnostics, cache } = await runAll(
    ctx.root,
    project,
    config,
    deps,
    flags.cache !== false,
  );
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
    ...new Set(
      Object.values(config.sources).flatMap((s) =>
        s.type === "lookup" ? [] : [path.posix.basename(s.path)],
      ),
    ),
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

  const owned = [...files.keys()].sort();
  files.set(MANIFEST, `${JSON.stringify({ format_version: "1", files: owned }, null, 2)}\n`);
  const checked = await checkOutDir(ctx.root, outDir, new Set(files.keys()));
  if ("refused" in checked) return usageError("HM0004", checked.refused);
  const refuse = (unsafe: string) =>
    usageError("HM0004", `${path.relative(ctx.root, outDir) || outDir}/${unsafe}`);
  for (const file of checked.previous) {
    if (files.has(file)) continue;
    const unsafe = await unsafeTarget(outDir, file);
    if (unsafe !== undefined) return refuse(unsafe);
    const target = path.join(outDir, ...file.split("/"));
    await rm(target, { force: true });
    for (
      let dir = path.dirname(target);
      dir.startsWith(outDir + path.sep);
      dir = path.dirname(dir)
    ) {
      if (
        !(await rmdir(dir).then(
          () => true,
          () => false,
        ))
      )
        break;
    }
  }
  for (const [file, content] of [...files].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const target = path.join(outDir, ...file.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    const unsafe = await unsafeTarget(outDir, file);
    if (unsafe !== undefined) return refuse(unsafe);
    const fresh = await openFresh(target);
    if (fresh === undefined) {
      return refuse(
        `${file}: every temporary name tried next to it already exists; remove the stray *.tmp files or choose another --out`,
      );
    }
    try {
      await fresh.handle.writeFile(content);
      await fresh.handle.close();
      await rename(fresh.path, target);
    } catch (error) {
      await fresh.handle.close().catch(() => {});
      await rm(fresh.path, { force: true });
      throw error;
    }
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
    ...(cache !== undefined ? { cache } : {}),
  };
  const warnings = report.warning_count > 0 ? `${renderHuman(report, { color: ctx.color })}\n` : "";
  const human =
    ctx.quiet && report.warning_count === 0
      ? ""
      : `${warnings}Built ${pages.length} dashboard${pages.length === 1 ? "" : "s"} into ${outLabel}/\n${written.map((p) => `  ${p.path}`).join("\n")}${cache === undefined ? "" : `\n${cacheLine(cache)}`}`;
  return { exitCode: EXIT.ok, json, human };
}

function cacheLine(cache: CacheStats): string {
  if (!cache.enabled)
    return `warning: the build cache is off: ${cache.reason}; the build ran without it`;
  const total = cache.hits + cache.misses;
  return `Reused ${cache.hits} of ${total} quer${total === 1 ? "y" : "ies"} from ${cache.dir}/`;
}

async function runAll(
  root: string,
  project: Project,
  config: ProjectConfig,
  deps: BuildDeps,
  useCache: boolean,
): Promise<{ pages: DashboardData[]; diagnostics: Diagnostic[]; cache?: CacheStats }> {
  const pages: DashboardData[] = [];
  const diagnostics = new Map<string, Diagnostic>();
  for (const d of [...parseDiagnostics(project), ...checkReferences(project)]) {
    if (d.severity === "warning") diagnostics.set(JSON.stringify(d), d);
  }
  const cached = useCache
    ? await createCachedExecutor({
        root,
        config,
        createInner: (at) => deps.createExecutor({ root: at, config }),
        sweep: true,
      })
    : undefined;
  const executor = cached ?? (await deps.createExecutor({ root, config }));
  try {
    for (const name of [...project.dashboards.keys()].sort()) {
      const result = await deps.runDashboard(project, name, executor, new Date());
      for (const d of result.diagnostics) diagnostics.set(JSON.stringify(d), d);
      if (result.data) pages.push(result.data);
    }
  } finally {
    await executor.close();
  }
  return {
    pages,
    diagnostics: [...diagnostics.values()],
    ...(cached !== undefined ? { cache: cached.stats() } : {}),
  };
}
