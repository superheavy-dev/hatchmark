import { brotliCompressSync, gzipSync } from "node:zlib";
import type { Browser, Request, Response } from "playwright";
import { type LoadSample, sampleLoad } from "./machine.ts";
import { installProbe, type ProbeResult } from "./probe.ts";
import type { Profile } from "./profiles.ts";
import type { Session, Target } from "./target.ts";
import { sleep } from "./util.ts";

export interface Bytes {
  requests: number;
  jsFiles: number;
  jsDecoded: number;
  jsGzip: number;
  jsBrotli: number;
  jsTransfer: number;
  inlineJs: number;
  wasmDecoded: number;
  wasmTransfer: number;
  dataTransfer: number;
  totalTransfer: number;
}

export interface RunResult {
  run: number;
  warmup: boolean;
  loadBefore: LoadSample;
  loadAfter: LoadSample;
  underLoad: boolean;
  firstChartMs: number | null;
  allVisualsMs: number | null;
  fcpMs: number | null;
  lcpMs: number | null;
  loadLongTaskMs: number;
  interactionMs: number | null;
  interactionMaxEventMs: number | null;
  interactionLongTaskMs: number;
  visuals: ProbeResult["visuals"];
  initialBytes: Bytes;
  totalBytes: Bytes;
  error?: string;
}

interface Seen {
  request: Request;
  response: Response;
  kind: "js" | "wasm" | "data" | "other";
  decoded: number;
  gzip: number;
  brotli: number;
  transfer: number;
}

function classify(response: Response): Seen["kind"] {
  const type = response.headers()["content-type"] ?? "";
  const url = response.url().split("?")[0] ?? "";
  const resource = response.request().resourceType();
  if (type.includes("wasm") || url.endsWith(".wasm")) return "wasm";
  if (type.includes("javascript") || type.includes("ecmascript") || resource === "script")
    return "js";
  if (resource === "fetch" || resource === "xhr") return "data";
  return "other";
}

async function describe(response: Response): Promise<Seen> {
  const kind = classify(response);
  const request = response.request();
  const sizes = await request.sizes().catch(() => ({ responseBodySize: 0 }));
  let decoded = 0;
  let gzip = 0;
  let brotli = 0;
  if (kind === "js" || kind === "wasm") {
    const body = await response.body().catch(() => Buffer.alloc(0));
    decoded = body.length;
    if (kind === "js" && body.length > 0) {
      gzip = gzipSync(body, { level: 9 }).length;
      brotli = brotliCompressSync(body).length;
    }
  }
  return { request, response, kind, decoded, gzip, brotli, transfer: sizes.responseBodySize };
}

function tally(seen: Seen[], inlineScripts: string): Bytes {
  const sum = (kind: Seen["kind"] | null, pick: (s: Seen) => number) =>
    seen.filter((s) => kind === null || s.kind === kind).reduce((total, s) => total + pick(s), 0);
  const inline = Buffer.from(inlineScripts);
  const inlineJs = inline.length;
  const inlineGzip = inlineJs === 0 ? 0 : gzipSync(inline, { level: 9 }).length;
  const inlineBrotli = inlineJs === 0 ? 0 : brotliCompressSync(inline).length;
  return {
    requests: seen.length,
    jsFiles: seen.filter((s) => s.kind === "js").length,
    jsDecoded: sum("js", (s) => s.decoded) + inlineJs,
    jsGzip: sum("js", (s) => s.gzip) + inlineGzip,
    jsBrotli: sum("js", (s) => s.brotli) + inlineBrotli,
    jsTransfer: sum("js", (s) => s.transfer),
    inlineJs,
    wasmDecoded: sum("wasm", (s) => s.decoded),
    wasmTransfer: sum("wasm", (s) => s.transfer),
    dataTransfer: sum("data", (s) => s.transfer),
    totalTransfer: sum(null, (s) => s.transfer),
  };
}

export interface MeasureOptions {
  profile: Profile;
  threshold: number;
  timeoutMs: number;
  quietMs: number;
}

export async function measureOnce(
  browser: Browser,
  target: Target,
  session: Session,
  run: number,
  warmup: boolean,
  options: MeasureOptions,
): Promise<RunResult> {
  const { profile } = options;
  const loadBefore = sampleLoad();
  const context = await browser.newContext({
    viewport: profile.viewport,
    deviceScaleFactor: profile.deviceScaleFactor,
    isMobile: profile.isMobile,
    hasTouch: profile.hasTouch,
    locale: "en-US",
    timezoneId: "UTC",
    serviceWorkers: "block",
    ...(profile.userAgent ? { userAgent: profile.userAgent } : {}),
  });
  try {
    await session.authenticate?.(context);
    const page = await context.newPage();
    await page.addInitScript(installProbe, target.visuals);
    const cdp = await context.newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: profile.cpuThrottle });
    if (profile.network) {
      await cdp.send("Network.enable");
      await cdp.send("Network.emulateNetworkConditions", {
        offline: false,
        latency: profile.network.latencyMs,
        downloadThroughput: (profile.network.downloadKbps * 1024) / 8,
        uploadThroughput: (profile.network.uploadKbps * 1024) / 8,
      });
    }
    const pending = new Set<Request>();
    const described: Promise<Seen>[] = [];
    let lastActivity = Date.now();
    context.on("request", (request) => {
      pending.add(request);
      lastActivity = Date.now();
    });
    const settle = (request: Request) => {
      pending.delete(request);
      lastActivity = Date.now();
    };
    context.on("requestfinished", settle);
    context.on("requestfailed", settle);
    context.on("response", (response) => {
      described.push(describe(response));
    });
    const quiet = async () => {
      const deadline = Date.now() + 15_000;
      while (
        Date.now() < deadline &&
        (pending.size > 0 || Date.now() - lastActivity < options.quietMs)
      ) {
        await sleep(100);
      }
    };

    await page.goto(session.url, { waitUntil: "commit", timeout: options.timeoutMs });
    await page.waitForFunction(() => window.__bench?.allReady(), undefined, {
      timeout: options.timeoutMs,
      polling: 200,
    });
    await quiet();
    const initialSeen = await Promise.all(described.slice());
    const initialProbe = await page.evaluate(() => window.__bench.result());

    await target.prepareInteraction(page);
    await quiet();
    await page.evaluate(() => window.__bench.arm());
    await target.commitInteraction(page);
    await page.waitForFunction(() => window.__bench.settled(500), undefined, {
      timeout: options.timeoutMs,
      polling: 100,
    });
    await quiet();
    const probe = await page.evaluate(() => window.__bench.result());
    const totalSeen = await Promise.all(described.slice());

    const charts = new Set(target.visuals.filter((v) => v.chart).map((v) => v.name));
    const ready = initialProbe.visuals.map((v) => v.readyAt);
    const chartReady = initialProbe.visuals.filter((v) => charts.has(v.name)).map((v) => v.readyAt);
    const loadAfter = sampleLoad();
    const { startedAt, settledAt } = probe.interaction;
    return {
      run,
      warmup,
      loadBefore,
      loadAfter,
      underLoad: loadBefore.load1 > options.threshold || loadAfter.load1 > options.threshold,
      firstChartMs: chartReady.every((t) => t === null)
        ? null
        : Math.min(...chartReady.filter((t): t is number => t !== null)),
      allVisualsMs: ready.some((t) => t === null) ? null : Math.max(...(ready as number[])),
      fcpMs: initialProbe.fcp,
      lcpMs: initialProbe.lcp,
      loadLongTaskMs: initialProbe.longTaskMs,
      interactionMs: startedAt !== null && settledAt !== null ? settledAt - startedAt : null,
      interactionMaxEventMs: probe.interaction.maxEventDuration,
      interactionLongTaskMs: probe.interaction.longTaskMs,
      visuals: probe.visuals,
      initialBytes: tally(initialSeen, initialProbe.inlineScripts),
      totalBytes: tally(totalSeen, probe.inlineScripts),
    };
  } finally {
    await context.close();
  }
}
