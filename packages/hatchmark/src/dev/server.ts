import { realpath, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin, ViteDevServer } from "vite";
import {
  type BuildDeps,
  bundledAssets,
  type Page,
  periodPage,
  sourceNames,
} from "../cli/commands/build.js";
import {
  type DashboardData,
  type DashboardExecutor,
  planDashboard,
  runDashboard,
} from "../compiler/index.js";
import {
  createReport,
  type Diagnostic,
  type DiagnosticReport,
  docsCommand,
  renderHuman,
} from "../diagnostics/index.js";
import { createDuckDbExecutor, nodeProjectHost } from "../node/index.js";
import {
  cssPaint,
  DEFAULT_THEME,
  type GridItem,
  gridItems,
  type PageAssets,
  pageHead,
  renderDashboardPage,
  renderIndexPage,
  scriptJson,
} from "../render/index.js";
import { esc } from "../render/svg.js";
import {
  CONFIG_FILE,
  checkReferences,
  loadProject,
  type Project,
  type ProjectConfig,
  parseDiagnostics,
  UNREAD_CONFIG_FILES,
} from "../spec/index.js";
import { overlayHtml } from "./overlay.js";

/** The dev client, served through Vite (which compiles it and gives it import.meta.hot). */
const CLIENT_FILE = fileURLToPath(new URL("../../runtime/dev-client.ts", import.meta.url));
const CLIENT_ID = "virtual:hatchmark-dev-client";
/** How long to wait for more file events before rebuilding, so one save rebuilds once. */
const DEBOUNCE_MS = 20;
/**
 * The file watcher Vite bundles (chokidar) reports a file change and then ignores that file for
 * 50 ms, so a second save inside that window (a formatter rewriting the file, or a quick undo) gets
 * no event. Every file a rebuild read on an event is checked again this long after the rebuild,
 * and rebuilt once more when it changed meanwhile.
 */
const RECHECK_MS = 100;
const INDEX = "/";

/** One card or KPI the dev client replaces: its position in the grid, and its new HTML. */
export interface CardUpdate {
  index: number;
  kpi?: number;
  html: string;
}

/** A custom event sent to every open page over Vite's HMR connection. */
export type DevEvent =
  | {
      event: "hatchmark:update";
      /** periods: the period filter's new data (the JSON inside data-hm-periods), when it changed. */
      data: { dashboard: string; cards: CardUpdate[]; periods?: string };
    }
  | { event: "hatchmark:reload"; data: { dashboard?: string } }
  | { event: "hatchmark:error"; data: { overlay: string; diagnostics: Diagnostic[] } }
  | { event: "hatchmark:ok"; data: Record<string, never> };

type PageEvent = Extract<DevEvent, { event: "hatchmark:update" | "hatchmark:reload" }>;

export interface DevOptions {
  /** Absolute project directory. */
  root: string;
  port?: number;
  host?: string;
  open?: boolean;
  /** Progress and diagnostics for the terminal (stderr). */
  log(text: string): void;
  color?: boolean;
  deps?: BuildDeps;
  /** Called with every event sent to the pages, for tests and timing. */
  onEvent?(event: DevEvent): void;
}

export interface DevServer {
  /** The URL to open: the index, or the only dashboard. */
  url: string;
  /** Every URL the server listens on. */
  urls: string[];
  /** The HMR websocket token Vite requires on connect (?token=). */
  token: string;
  /** Waits until every file change seen so far is rebuilt. */
  idle(): Promise<void>;
  close(): Promise<void>;
}

interface Rendered {
  data: DashboardData;
  /**
   * The page with the grid's contents and the period filter's data cut out: any difference is a
   * structural change.
   */
  shell: string;
  /** The JSON inside data-hm-periods, which an update replaces in place. */
  periods: string;
  items: GridItem[];
  html: string;
}

const dedupe = (diagnostics: Diagnostic[]) => [
  ...new Map(diagnostics.map((d) => [JSON.stringify(d), d])).values(),
];

const internal = (error: unknown): Diagnostic => ({
  code: "HM9001",
  severity: "error",
  message: `internal error: ${error instanceof Error ? error.message : String(error)}`,
  docs: docsCommand("HM9001"),
});

/**
 * The changes between two renders of a page as the dev client applies them: the cards (or single
 * KPIs of a strip) whose HTML changed, or undefined when the page must reload because its
 * structure changed: anything outside the grid (header, filters, footer, styles), the blocks or
 * their order, or a card's own element (its type or span, which is layout).
 */
export function diffPages(before: Rendered, after: Rendered): CardUpdate[] | undefined {
  if (before.shell !== after.shell || before.items.length !== after.items.length) return undefined;
  const open = (html: string) => html.slice(0, html.indexOf(">") + 1);
  const cards: CardUpdate[] = [];
  for (const [index, a] of before.items.entries()) {
    const b = after.items[index];
    if (b === undefined || a.blocks.join("\0") !== b.blocks.join("\0")) return undefined;
    if (a.html === b.html) continue;
    if (open(a.html) !== open(b.html)) return undefined;
    if (a.kpis === undefined || b.kpis === undefined) {
      cards.push({ index, html: b.html });
      continue;
    }
    for (const [kpi, html] of b.kpis.entries()) {
      const was = a.kpis[kpi] ?? "";
      if (html === was) continue;
      if (open(html) !== open(was)) return undefined;
      cards.push({ index, kpi, html });
    }
  }
  return cards;
}

/**
 * Starts the dev server: Vite with the Hatchmark plugin, serving every dashboard at the URLs build
 * writes (/<dashboard>/, and / as the index when there is more than one) with the same renderer,
 * runtime and fonts. It watches hatchmark.yaml, metrics, segments, dashboards and every data file.
 * On a change it reloads the project, re-runs only the dashboards the change can affect, renders
 * them and compares each card with the page the browser has: changed cards are pushed over HMR,
 * structural changes reload the page. Errors from check or run go to the terminal and over the
 * page, and clear on the next good build. Without a hatchmark.yaml it returns the report instead
 * and starts nothing.
 */
export async function startDevServer(
  options: DevOptions,
): Promise<{ server: DevServer } | { report: DiagnosticReport }> {
  const root = await realpath(options.root).catch(() => options.root);
  const deps = options.deps ?? { createExecutor: createDuckDbExecutor, runDashboard };
  const host = nodeProjectHost(root);
  const first = await loadProject(host);
  if (first.project === undefined) return { report: createReport(first.diagnostics) };

  const assets = await bundledAssets(true);
  let project: Project | undefined;
  let config: ProjectConfig | undefined;
  let executor: (DashboardExecutor & { close(): Promise<void> }) | undefined;
  const pages = new Map<string, Rendered>();
  const plans = new Map<string, string | undefined>();
  const runDiagnostics = new Map<string, Diagnostic[]>();
  let projectDiagnostics: Diagnostic[] = [];
  let errors: DiagnosticReport | undefined;
  let logged = "";
  let indexKey = "";
  const watched = new Set<string>();
  let vite: ViteDevServer | undefined;
  let booted = false;

  const send = (message: DevEvent) => {
    options.onEvent?.(message);
    vite?.ws.send({ type: "custom", event: message.event, data: message.data });
  };

  /** Every data file the config names, with every source that reads it. */
  const sourcePaths = (spec: ProjectConfig | undefined) => {
    const files = new Map<string, string[]>();
    for (const [name, s] of Object.entries(spec?.sources ?? {})) {
      if (s.type === "lookup") continue;
      const file = path.resolve(root, s.path);
      files.set(file, [...(files.get(file) ?? []), name]);
    }
    return files;
  };

  const render = ({ data, periods }: Page): Rendered => {
    const html = renderDashboardPage(data, {
      assets: assets.assetsFrom("../"),
      sources: config ? sourceNames(config) : [],
      ...(periods ? { periods } : {}),
    });
    const items = gridItems(data.blocks, { data, theme: DEFAULT_THEME, paint: cssPaint });
    const grid = `<main class="hm-grid">${items.map((i) => i.html).join("")}</main>`;
    const at = html.indexOf(grid);
    const cut = at < 0 ? html : `${html.slice(0, at)}${html.slice(at + grid.length)}`;
    const open = '<script type="application/json" data-hm-periods>';
    const from = cut.indexOf(open) + open.length;
    const to = cut.indexOf("</script>", from);
    if (from < open.length) return { data, shell: cut, periods: "", items, html };
    const shell = `${cut.slice(0, from)}${cut.slice(to)}`;
    return { data, shell, periods: cut.slice(from, to), items, html };
  };

  const rebuild = async (changed: ReadonlySet<string> | "all"): Promise<void> => {
    const started = performance.now();
    for (const file of changed === "all" ? [] : changed) stamps.set(file, await stamp(file));
    const loaded = await loadProject(host);
    const next = loaded.project;
    const spec = next?.config.spec;
    projectDiagnostics = next
      ? dedupe([...loaded.diagnostics, ...parseDiagnostics(next), ...checkReferences(next)])
      : loaded.diagnostics;
    const updates: PageEvent[] = [];
    if (next !== undefined && spec !== undefined) {
      const configChanged =
        changed === "all" || next.config.document.text !== project?.config.document.text;
      const paths = sourcePaths(spec);
      const dataChanged = new Set(
        changed === "all" ? [] : [...changed].flatMap((f) => paths.get(f) ?? []),
      );
      for (const file of paths.keys()) {
        if (watched.has(file)) continue;
        watched.add(file);
        vite?.watcher.add(file);
      }
      const textOf = (
        files: Map<string, { document: { text: string } }> | undefined,
        name: string,
      ) => files?.get(name)?.document.text;
      const changedMetrics = new Set(
        [...new Set([...(project?.metrics.keys() ?? []), ...next.metrics.keys()])].filter(
          (name) => textOf(project?.metrics, name) !== textOf(next.metrics, name),
        ),
      );
      const segmentsChanged = [
        ...new Set([...(project?.segments.keys() ?? []), ...next.segments.keys()]),
      ].some((name) => textOf(project?.segments, name) !== textOf(next.segments, name));
      if (configChanged || dataChanged.size > 0 || executor === undefined) {
        await executor?.close();
        executor = undefined;
        executor = await deps.createExecutor({ root, config: spec });
      }
      const previous = project;
      project = next;
      config = spec;
      for (const name of new Set([
        ...(previous?.dashboards.keys() ?? []),
        ...pages.keys(),
        ...runDiagnostics.keys(),
      ])) {
        if (next.dashboards.has(name)) continue;
        updates.push({ event: "hatchmark:reload", data: { dashboard: name } });
        pages.delete(name);
        plans.delete(name);
        runDiagnostics.delete(name);
      }
      for (const name of [...next.dashboards.keys()].sort()) {
        let plan: ReturnType<typeof planDashboard>["plan"];
        try {
          plan = planDashboard(next, name).plan;
        } catch {
          plan = undefined;
        }
        const planKey = plan === undefined ? undefined : JSON.stringify(plan);
        const reads = new Set([
          ...(plan?.queries.map((q) => q.source) ?? []),
          ...(plan?.horizons.map((h) => h.source) ?? []),
        ]);
        const page = pages.get(name);
        if (previous !== undefined && !previous.dashboards.has(name)) {
          updates.push({ event: "hatchmark:reload", data: { dashboard: name } });
        }
        const affected =
          configChanged ||
          segmentsChanged ||
          page === undefined ||
          (runDiagnostics.get(name) ?? []).some((d) => d.severity === "error") ||
          textOf(previous?.dashboards, name) !== textOf(next.dashboards, name) ||
          planKey === undefined ||
          planKey !== plans.get(name) ||
          [...reads].some((s) => dataChanged.has(s)) ||
          Object.keys(page.data.metrics).some((m) => changedMetrics.has(m));
        plans.set(name, planKey);
        if (!affected) continue;
        const now = new Date();
        const result = await deps.runDashboard(next, name, executor, now);
        if (result.data === undefined) {
          runDiagnostics.set(name, result.diagnostics);
          continue;
        }
        const period = await periodPage(next, name, executor, result.data, now);
        runDiagnostics.set(name, [...result.diagnostics, ...period.diagnostics]);
        const rendered = render(period.page);
        pages.set(name, rendered);
        const cards = page === undefined ? undefined : diffPages(page, rendered);
        if (cards === undefined) {
          updates.push({ event: "hatchmark:reload", data: { dashboard: name } });
        } else if (cards.length > 0 || page?.periods !== rendered.periods) {
          const periods = page?.periods === rendered.periods ? {} : { periods: rendered.periods };
          updates.push({ event: "hatchmark:update", data: { dashboard: name, cards, ...periods } });
        }
      }
      const key = JSON.stringify([
        spec.name,
        [...next.dashboards.keys()].sort(),
        [...pages.values()].map((p) => [p.data.name, p.data.title, p.data.description]),
      ]);
      if (key !== indexKey && indexKey !== "") {
        updates.push({ event: "hatchmark:reload", data: { dashboard: INDEX } });
      }
      indexKey = key;
    }
    report(
      dedupe([...projectDiagnostics, ...[...runDiagnostics.values()].flat()]),
      updates,
      performance.now() - started,
    );
  };

  const report = (diagnostics: Diagnostic[], updates: PageEvent[], ms: number) => {
    const result = createReport(diagnostics);
    const text = renderHuman(result, { color: false });
    if (text !== logged && (result.error_count > 0 || result.warning_count > 0 || errors)) {
      options.log(`${renderHuman(result, { color: options.color ?? false })}\n`);
    }
    logged = text;
    if (result.error_count > 0) {
      const overlay = overlayHtml(result);
      if (errors === undefined || renderHuman(errors) !== text) {
        send({ event: "hatchmark:error", data: { overlay, diagnostics: result.diagnostics } });
      }
      errors = result;
    } else if (errors !== undefined) {
      errors = undefined;
      send({ event: "hatchmark:ok", data: {} });
    }
    if (!booted || updates.length === 0) return;
    const sent = new Set<string>();
    for (const update of updates) {
      const key = JSON.stringify(update);
      if (!sent.has(key)) send(update);
      sent.add(key);
    }
    const what = updates.map((u) =>
      u.event === "hatchmark:update"
        ? `${u.data.dashboard}: ${u.data.cards.length} card${u.data.cards.length === 1 ? "" : "s"} updated`
        : `${u.data.dashboard === INDEX ? "index" : u.data.dashboard}: reloaded`,
    );
    options.log(`${what.join(", ")} (${Math.round(ms)} ms)\n`);
  };

  const stamps = new Map<string, string>();
  const stamp = (file: string) =>
    stat(file).then(
      (s) => `${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`,
      () => "missing",
    );
  const rechecks = new Set<ReturnType<typeof setTimeout>>();
  const recheck = (changed: ReadonlySet<string>) => {
    const timeout = setTimeout(() => {
      rechecks.delete(timeout);
      for (const file of changed) {
        void stamp(file).then((now) => {
          if (now !== stamps.get(file)) onFile(file);
        });
      }
    }, RECHECK_MS);
    rechecks.add(timeout);
  };
  let closed = false;
  let pending = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let chain: Promise<void> = Promise.resolve();
  const enqueue = (changed: ReadonlySet<string> | "all") => {
    chain = chain.then(() =>
      rebuild(changed).catch((error: unknown) => {
        options.log(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
        report([...projectDiagnostics, internal(error)], [], 0);
      }),
    );
    return chain;
  };
  const relevant = (file: string): boolean => {
    const rel = path.relative(root, file);
    if (rel === CONFIG_FILE || UNREAD_CONFIG_FILES.includes(rel)) return true;
    if (sourcePaths(config).has(file)) return true;
    if (rel.startsWith("..") || path.isAbsolute(rel)) return false;
    const dirs = [
      config?.metricsDir ?? "metrics",
      config?.dashboardsDir ?? "dashboards",
      config?.segmentsDir ?? "segments",
      config?.dataDir ?? "data",
    ];
    return dirs.some((dir) => rel.startsWith(`${path.normalize(dir)}${path.sep}`));
  };
  const onFile = (file: string) => {
    if (closed || !relevant(file)) return;
    pending.add(file);
    clearTimeout(timer);
    timer = setTimeout(() => {
      const changed = pending;
      pending = new Set();
      timer = undefined;
      void enqueue(changed).then(() => recheck(changed));
    }, DEBOUNCE_MS);
  };

  await enqueue("all");
  booted = true;

  const page = (name: string | undefined, removed = false): string => {
    const state = `<script type="application/json" id="hm-dev">${scriptJson({ dashboard: name ?? INDEX })}</script>`;
    const client = `${state}<script type="module" src="/@vite/client"></script><script type="module" src="/@id/${CLIENT_ID}"></script>`;
    let html: string;
    const rendered = name === undefined ? undefined : pages.get(name);
    if (rendered) html = rendered.html;
    else if (name === undefined && pages.size > 1 && config) {
      html = renderIndexPage(
        config.name,
        [...pages.values()].map(({ data: p }) => ({
          name: p.name,
          title: p.title,
          ...(p.description === undefined ? {} : { description: p.description }),
        })),
        { assets: assets.assetsFrom("") },
      );
    } else {
      html = statePage(
        name === undefined ? assets.assetsFrom("") : assets.assetsFrom("../"),
        removed ? "Dashboard removed" : "Waiting for a good build",
        removed
          ? `${config?.dashboardsDir ?? "dashboards"}/${name}.yaml does not exist. This page reloads when it comes back.`
          : "This page reloads when the dashboard builds.",
      );
    }
    const overlay = errors ? overlayHtml(errors) : "";
    return html.replace("</head>", `${client}</head>`).replace("</body>", `${overlay}</body>`);
  };

  const statePage = (urls: PageAssets, heading: string, caption: string) =>
    `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>Hatchmark dev</title>\n${pageHead(urls)}\n</head>\n<body>\n<div class="hm-root"><div class="hm-page"><header class="hm-header"><div class="hm-titles"><div class="hm-brand"><span class="hm-logo" aria-hidden="true"></span>${esc(config?.name ?? "Hatchmark")}</div><div class="hm-title"><h1>${esc(heading)}</h1><p class="hm-caption">${esc(caption)}</p></div></div></header></div></div>\n</body>\n</html>\n`;

  const plugin: Plugin = {
    name: "hatchmark",
    resolveId: (id) => (id === CLIENT_ID ? CLIENT_FILE : undefined),
    configureServer(server) {
      server.watcher.on("all", (_event, file) => onFile(path.resolve(file)));
      server.middlewares.use((req, res, next) => {
        const handle = async () => {
          const url = new URL(req.url ?? "/", "http://localhost");
          const pathname = decodeURIComponent(url.pathname);
          const asset = assets.files.get(pathname.slice(1));
          if (asset) {
            const type = pathname.endsWith(".js")
              ? "text/javascript"
              : pathname.endsWith(".woff2")
                ? "font/woff2"
                : "text/plain; charset=utf-8";
            res.writeHead(200, { "content-type": type, "cache-control": "no-cache" });
            res.end(asset);
            return;
          }
          await chain;
          const html = (body: string) => {
            res.writeHead(200, {
              "content-type": "text/html; charset=utf-8",
              "cache-control": "no-store",
            });
            res.end(body);
          };
          const redirect = (to: string) => {
            res.writeHead(302, { location: to });
            res.end();
          };
          if (pathname === "/" || pathname === "/index.html") {
            const only = pages.size === 1 ? [...pages.keys()][0] : undefined;
            if (only !== undefined) return redirect(`/${encodeURIComponent(only)}/`);
            return html(page(undefined));
          }
          const match = /^\/([^/]+)(\/(?:index\.html)?)?$/.exec(pathname);
          const name = match?.[1];
          if (name !== undefined && (pages.has(name) || project?.dashboards.has(name))) {
            if (match?.[2] === undefined) return redirect(`/${encodeURIComponent(name)}/`);
            return html(page(name));
          }
          if (name !== undefined && match?.[2] !== undefined && /^[\w.-]+$/.test(name)) {
            res.writeHead(404, {
              "content-type": "text/html; charset=utf-8",
              "cache-control": "no-store",
            });
            res.end(page(name, true));
            return;
          }
          next();
        };
        handle().catch(next);
      });
    },
  };

  const outDir = path.resolve(root, config?.outDir ?? "dist");
  const { createServer } = await import("vite");
  vite = await createServer({
    root,
    configFile: false,
    envFile: false,
    publicDir: false,
    appType: "custom",
    logLevel: "silent",
    clearScreen: false,
    cacheDir: path.join(tmpdir(), "hatchmark-vite"),
    optimizeDeps: { noDiscovery: true, include: [] },
    server: {
      ...(options.port === undefined ? {} : { port: options.port, strictPort: true }),
      ...(options.host === undefined ? {} : { host: options.host }),
      fs: { strict: true, allow: [path.dirname(CLIENT_FILE)] },
      watch: { ignored: [`${outDir}/**`] },
    },
    plugins: [plugin],
  });
  for (const file of watched) vite.watcher.add(file);
  try {
    await vite.listen();
  } catch (error) {
    await vite.close();
    await executor?.close();
    if (error instanceof Error && /^Port \d+ is already in use/.test(error.message)) {
      throw Object.assign(error, { code: "EADDRINUSE" });
    }
    throw error;
  }
  const urls = [...(vite.resolvedUrls?.local ?? []), ...(vite.resolvedUrls?.network ?? [])];
  const base = urls[0] ?? `http://localhost:${options.port ?? 5173}/`;
  const only = pages.size === 1 ? [...pages.keys()][0] : undefined;
  const url = only === undefined ? base : new URL(`${encodeURIComponent(only)}/`, base).href;
  if (options.open) vite.openBrowser();
  const server = vite;
  return {
    server: {
      url,
      urls,
      token: server.config.webSocketToken,
      idle: async () => {
        while (timer !== undefined || pending.size > 0) {
          await new Promise((resolve) => setTimeout(resolve, DEBOUNCE_MS));
        }
        await chain;
      },
      close: async () => {
        closed = true;
        clearTimeout(timer);
        for (const timeout of rechecks) clearTimeout(timeout);
        await chain;
        await server.close();
        await executor?.close();
      },
    },
  };
}
