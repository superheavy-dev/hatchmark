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
import { fileURLToPath } from "node:url";
import {
  type DashboardData,
  type DashboardExecutor,
  matchReports,
  type PeriodData,
  pageWeight,
  runDashboard,
  runPeriodData,
  runSegmentData,
  type SegmentData,
} from "../../compiler/index.js";
import { createReport, type Diagnostic, renderHuman } from "../../diagnostics/index.js";
import { GEOGRAPHY_DATA, geographyScript, usedGeographies } from "../../geo/index.js";
import {
  type CacheStats,
  createCachedExecutor,
  createDatabaseStore,
  createDuckDbExecutor,
  type DatabaseStore,
  nodeProjectHost,
} from "../../node/index.js";
import {
  FONT_FILES,
  type PageAssets,
  renderDashboardPage,
  renderIndexPage,
} from "../../render/index.js";
import {
  checkReferences,
  type GeographyId,
  isFileSource,
  loadProject,
  type Project,
  type ProjectConfig,
  parseDiagnostics,
} from "../../spec/index.js";
import type { CommandHelp } from "../help.js";
import { type CommandContext, type CommandResult, EXIT } from "../io.js";
import { packageRoot } from "../package-root.js";
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
        "Write here instead of outDir from hatchmark.yaml, relative to --cwd. Only files an earlier build wrote are replaced.",
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

const ASSET_DIR = "_hatchmark";
const MANIFEST = `${ASSET_DIR}/manifest.json`;

export interface BuildDeps {
  createExecutor(options: {
    root: string;
    config: ProjectConfig;
    databases?: DatabaseStore;
  }): Promise<DashboardExecutor & { close(): Promise<void> }>;
  runDashboard: typeof runDashboard;
}

const defaultDeps: BuildDeps = { createExecutor: createDuckDbExecutor, runDashboard };

export interface Page {
  data: DashboardData;
  periods?: PeriodData;
  segments?: SegmentData;
}

function hashedName(file: string, content: Uint8Array): string {
  const hash = createHash("sha256").update(content).digest("hex").slice(0, 10);
  const ext = path.extname(file);
  return `${file.slice(0, -ext.length)}.${hash}${ext}`;
}

async function readAsset(relative: string): Promise<Uint8Array> {
  try {
    const root = await packageRoot(path.dirname(fileURLToPath(import.meta.url)));
    return await readFile(path.join(root, "assets", relative));
  } catch {
    throw new Error(
      `bundled asset ${relative} is missing from the hatchmark package; reinstall it, or run pnpm build in a source checkout`,
    );
  }
}

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

async function realLocation(p: string): Promise<string> {
  const missing: string[] = [];
  for (let at = p; ; at = path.dirname(at)) {
    const real = await realpath(at).catch(() => undefined);
    if (real !== undefined) return path.join(real, ...missing);
    if (path.dirname(at) === at) return p;
    missing.unshift(path.basename(at));
  }
}

function isOwnPath(file: string): boolean {
  const normal = path.posix.normalize(file);
  return normal === file && !path.posix.isAbsolute(file) && !normal.startsWith("..");
}

export async function build(
  ctx: CommandContext,
  flags: { out?: string; cache?: boolean },
  deps: BuildDeps = defaultDeps,
): Promise<CommandResult> {
  const { project, diagnostics: loadDiagnostics } = await loadProject(
    nodeProjectHost(ctx.root, ctx.io.env),
  );
  if (project === undefined || project.config.spec === undefined) {
    const report = createReport([
      ...loadDiagnostics,
      ...(project === undefined ? [] : parseDiagnostics(project)),
    ]);
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
    loadDiagnostics,
    ctx.io.env,
  );
  if (diagnostics.some((d) => d.severity === "error")) {
    const report = createReport(diagnostics);
    return {
      exitCode: exitCodeFor(report.diagnostics, false),
      json: report,
      human: renderHuman(report, { color: ctx.color }),
    };
  }

  const redrawn = new Set(
    pages.flatMap((p) =>
      p.periods === undefined && p.segments === undefined
        ? []
        : Object.keys(usedGeographies(p.data.blocks)),
    ) as GeographyId[],
  );
  const assets = await bundledAssets(
    pages.some((p) => p.periods !== undefined || p.segments !== undefined),
    [...redrawn],
  );
  const files = new Map<string, Uint8Array | string>(assets.files);
  const { assetsFrom } = assets;
  const sources = sourceNames(config);
  for (const { data, periods, segments } of pages) {
    const html = renderDashboardPage(data, {
      assets: assetsFrom("../"),
      sources,
      geographies: usedGeographies(data.blocks),
      ...(periods ? { periods } : {}),
      ...(segments ? { segments } : {}),
    });
    files.set(`${data.name}/index.html`, html);
    const heavy = pageWeight(project, data.name, html, periods, segments);
    if (heavy) diagnostics.push(heavy);
  }
  if (pages.length > 1) {
    files.set(
      "index.html",
      renderIndexPage(
        config.name,
        pages.map(({ data: p }) => ({
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
  const maps = pages.flatMap(({ data: p }) => matchReports(p));
  const relative = path.relative(ctx.root, outDir);
  const outLabel = relative.startsWith("..") ? outDir : relative.split(path.sep).join("/") || ".";
  const written = pages.map(({ data: p }) => ({
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
    ...(maps.length > 0 ? { maps } : {}),
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

export async function bundledAssets(
  withPeriods = false,
  geographies: GeographyId[] = [],
): Promise<{
  files: Map<string, Uint8Array>;
  assetsFrom(prefix: string): PageAssets;
}> {
  const files = new Map<string, Uint8Array>();
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
  let periodsName: string | undefined;
  if (withPeriods) {
    const engine = await readAsset("runtime/hatchmark-periods.js");
    periodsName = hashedName("hatchmark-periods.js", engine);
    files.set(`${ASSET_DIR}/${periodsName}`, engine);
  }
  const geo: Partial<Record<GeographyId, string>> = {};
  for (const id of [...geographies].sort()) {
    const content = new TextEncoder().encode(geographyScript(GEOGRAPHY_DATA[id]));
    const name = hashedName(`geo-${id}.js`, content);
    files.set(`${ASSET_DIR}/${name}`, content);
    geo[id] = name;
  }
  return {
    files,
    assetsFrom: (prefix) => ({
      runtime: `${prefix}${ASSET_DIR}/${runtimeName}`,
      ...(periodsName ? { periods: `${prefix}${ASSET_DIR}/${periodsName}` } : {}),
      ...(Object.keys(geo).length > 0
        ? {
            geo: Object.fromEntries(
              Object.entries(geo).map(([id, name]) => [id, `${prefix}${ASSET_DIR}/${name}`]),
            ),
          }
        : {}),
      fonts: Object.fromEntries(
        Object.entries(fonts).map(([file, name]) => [file, `${prefix}${ASSET_DIR}/${name}`]),
      ),
    }),
  };
}

export function sourceNames(config: ProjectConfig): string[] {
  return [
    ...new Set(
      Object.entries(config.sources).flatMap(([name, s]) =>
        s.type === "lookup"
          ? []
          : isFileSource(s)
            ? [path.posix.basename(s.path)]
            : [s.table ?? name],
      ),
    ),
  ].sort();
}

export async function periodPage(
  project: Project,
  name: string,
  executor: DashboardExecutor,
  data: DashboardData,
  now: Date,
): Promise<{ page: Page; diagnostics: Diagnostic[] }> {
  const withSpan = (d: DashboardData, p: PeriodData | undefined) => {
    const span = p?.custom?.span;
    return span && d.periodFilter ? { ...d, periodFilter: { ...d.periodFilter, custom: span } } : d;
  };
  const segments = await runSegmentData(project, name, executor, data, now);
  const id = segments.data?.filter ?? "";
  const all = data.periodFilter === undefined ? undefined : segments.data?.states[""];
  const widest =
    all === undefined
      ? undefined
      : await runPeriodData(project, name, executor, all.data, now, { [id]: [] });
  const spanStart = widest?.data?.custom?.span.start;
  const periods =
    widest !== undefined && all?.data === data
      ? widest
      : await runPeriodData(project, name, executor, data, now, {}, spanStart);
  const diagnostics = [...periods.diagnostics, ...segments.diagnostics];
  if (segments.data !== undefined && all !== undefined) {
    for (const state of Object.values(segments.data.states)) {
      const own =
        state.data === data
          ? periods
          : state === all && widest !== undefined
            ? widest
            : await runPeriodData(
                project,
                name,
                executor,
                state.data,
                now,
                { [id]: state.selected },
                spanStart,
              );
      diagnostics.push(...(state.data === data ? [] : own.diagnostics));
      if (own.data) {
        state.periods = own.data;
        state.data = withSpan(state.data, own.data);
      }
    }
  }
  return {
    page: {
      data: withSpan(data, periods.data),
      ...(periods.data ? { periods: periods.data } : {}),
      ...(segments.data ? { segments: segments.data } : {}),
    },
    diagnostics,
  };
}

async function runAll(
  root: string,
  project: Project,
  config: ProjectConfig,
  deps: BuildDeps,
  useCache: boolean,
  loaded: readonly Diagnostic[],
  env: Readonly<Record<string, string | undefined>>,
): Promise<{ pages: Page[]; diagnostics: Diagnostic[]; cache?: CacheStats }> {
  const databases = createDatabaseStore({ root, env });
  const pages: Page[] = [];
  const diagnostics = new Map<string, Diagnostic>();
  for (const d of loaded) diagnostics.set(JSON.stringify(d), d);
  for (const d of [...parseDiagnostics(project), ...checkReferences(project)]) {
    if (d.severity === "warning") diagnostics.set(JSON.stringify(d), d);
  }
  const cached = useCache
    ? await createCachedExecutor({
        root,
        config,
        createInner: (at) => deps.createExecutor({ root: at, config, databases }),
        sweep: true,
        databases,
      })
    : undefined;
  const executor = cached ?? (await deps.createExecutor({ root, config, databases }));
  try {
    for (const name of [...project.dashboards.keys()].sort()) {
      const now = new Date();
      const result = await deps.runDashboard(project, name, executor, now);
      for (const d of result.diagnostics) diagnostics.set(JSON.stringify(d), d);
      if (result.data === undefined) continue;
      const page = await periodPage(project, name, executor, result.data, now);
      for (const d of page.diagnostics) diagnostics.set(JSON.stringify(d), d);
      pages.push(page.page);
    }
  } finally {
    await executor.close();
    await databases.close();
  }
  return {
    pages,
    diagnostics: [...diagnostics.values()],
    ...(cached !== undefined ? { cache: cached.stats() } : {}),
  };
}
