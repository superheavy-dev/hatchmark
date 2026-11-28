import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { chromium } from "playwright";
import { DEFAULT_ROWS, writeOrders } from "./dataset.ts";
import { defaultThreshold, host, sampleLoad, waitForLowLoad } from "./machine.ts";
import { measureOnce, type RunResult } from "./measure.ts";
import { PROFILES } from "./profiles.ts";
import { type Results, renderReport } from "./report.ts";
import type { BenchContext, Target } from "./target.ts";
import { evidence } from "./targets/evidence.ts";
import { hatchmark } from "./targets/hatchmark.ts";
import { metabase } from "./targets/metabase.ts";
import { superset } from "./targets/superset.ts";

const TARGETS: Record<string, Target> = { hatchmark, evidence, metabase, superset };
const USAGE = `Usage: node bench/src/cli.ts <command> [targets...] [options]

Commands:
  dataset                 write the orders dataset (--rows, default ${DEFAULT_ROWS})
  setup <targets>         install, provision and build each target's dashboard
  build-time <targets>    time each target's build from raw data (--runs)
  measure <targets>       load the dashboard and apply the region filter (--runs, --warmup, --profile)
  teardown <targets>      stop the containers a target started
  report                  print the results file as Markdown

Targets: ${Object.keys(TARGETS).join(", ")}

Options:
  --work <dir>         scratch directory (default bench/.work)
  --out <file>         results file (default <work>/results.json)
  --rows <n>           dataset rows
  --runs <n>           measured runs per target (default 7; build-time default 5)
  --warmup <n>         discarded runs before measuring (default 1)
  --profile <name>     ${Object.keys(PROFILES).join(" or ")} (default phone)
  --threshold <load>   1-minute load average above which a run waits, then is flagged
                       (default a quarter of the logical cores: ${defaultThreshold()})
  --max-wait <s>       longest wait for the load to drop before running anyway (default 600)`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    work: { type: "string" },
    out: { type: "string" },
    rows: { type: "string" },
    runs: { type: "string" },
    warmup: { type: "string" },
    profile: { type: "string", default: "phone" },
    threshold: { type: "string" },
    "max-wait": { type: "string", default: "600" },
    help: { type: "boolean", short: "h" },
  },
});

const [command, ...names] = positionals;
if (!command || values.help) {
  console.log(USAGE);
  process.exit(command ? 0 : 2);
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const work = resolve(values.work ?? join(root, "bench/.work"));
const out = resolve(values.out ?? join(work, "results.json"));
const dataFile = join(work, "data/orders.csv");
const threshold = values.threshold ? Number(values.threshold) : defaultThreshold();
const log = (line: string) => console.error(`[${new Date().toISOString()}] ${line}`);
mkdirSync(work, { recursive: true });

const meta = existsSync(join(work, "data/meta.json"))
  ? JSON.parse(readFileSync(join(work, "data/meta.json"), "utf8"))
  : null;
const ctx: BenchContext = { root, work, dataFile, rows: meta?.rows ?? 0, log };

const targets = names.map((name) => {
  const target = TARGETS[name];
  if (!target) {
    console.error(`unknown target "${name}"\n\n${USAGE}`);
    process.exit(2);
  }
  return target;
});

function loadResults(): Results {
  if (existsSync(out)) return JSON.parse(readFileSync(out, "utf8"));
  return { host: host(threshold), dataset: meta, targets: {} };
}

function saveResults(results: Results) {
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(results, null, 2)}\n`);
}

function sha256(path: string): Promise<string> {
  return new Promise((done, fail) => {
    const hash = createHash("sha256");
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => done(hash.digest("hex")))
      .on("error", fail);
  });
}

function requireData() {
  if (!existsSync(dataFile)) {
    console.error("no dataset yet: run the dataset command first");
    process.exit(3);
  }
}

if (command === "dataset") {
  const rows = Number(values.rows ?? DEFAULT_ROWS);
  const written = writeOrders(dataFile, rows);
  const info = { rows: written, file: "orders.csv", sha256: await sha256(dataFile) };
  writeFileSync(join(work, "data/meta.json"), `${JSON.stringify(info, null, 2)}\n`);
  log(`wrote ${written} rows to ${dataFile} (sha256 ${info.sha256})`);
} else if (command === "setup") {
  requireData();
  for (const target of targets) {
    log(`setup ${target.name}`);
    await target.setup(ctx);
    log(`${target.name} ready: ${target.version(ctx)}`);
  }
} else if (command === "build-time") {
  requireData();
  const runs = Number(values.runs ?? 5);
  const results = loadResults();
  for (const target of targets) {
    if (!target.build) {
      log(`${target.name} has no build step; skipping`);
      continue;
    }
    const samples = [];
    for (let i = 0; i <= runs; i++) {
      const before = await waitForLowLoad(threshold, Number(values["max-wait"]) * 1000, log);
      const ms = await target.build(ctx);
      const after = sampleLoad();
      const warmup = i === 0;
      samples.push({
        run: i,
        warmup,
        ms,
        loadBefore: before,
        loadAfter: after,
        underLoad: before.load1 > threshold || after.load1 > threshold,
      });
      log(
        `${target.name} build ${warmup ? "warm-up" : `run ${i}`}: ${Math.round(ms)} ms (load ${before.load1.toFixed(2)})`,
      );
    }
    const entry = results.targets[target.name] ?? { version: target.version(ctx), runs: [] };
    entry.version = target.version(ctx);
    entry.build = samples;
    results.targets[target.name] = entry;
    saveResults(results);
  }
} else if (command === "measure") {
  requireData();
  const profile = PROFILES[values.profile ?? "phone"];
  if (!profile) {
    console.error(`unknown profile "${values.profile}"`);
    process.exit(2);
  }
  const runs = Number(values.runs ?? 7);
  const warmups = Number(values.warmup ?? 1);
  const results = loadResults();
  results.host = host(threshold);
  results.dataset = meta;
  results.profile = profile;
  const browser = await chromium.launch({ args: ["--disable-extensions"] });
  results.browser = `Chromium ${browser.version()} (Playwright, headless)`;
  try {
    for (const target of targets) {
      const session = await target.start(ctx);
      const samples: RunResult[] = [];
      const queries: number[] = [];
      try {
        for (let i = 0; i < warmups + runs; i++) {
          await waitForLowLoad(threshold, Number(values["max-wait"]) * 1000, log);
          const warmup = i < warmups;
          let result: RunResult;
          try {
            result = await measureOnce(browser, target, session, i, warmup, {
              profile,
              threshold,
              timeoutMs: 180_000,
              quietMs: 2000,
            });
          } catch (error) {
            log(`${target.name} run ${i} failed: ${String(error)}`);
            throw error;
          }
          samples.push(result);
          log(
            `${target.name} ${warmup ? "warm-up" : `run ${i - warmups + 1}`}: first chart ${Math.round(result.firstChartMs ?? -1)} ms, all ${Math.round(result.allVisualsMs ?? -1)} ms, filter ${Math.round(result.interactionMs ?? -1)} ms, JS ${result.totalBytes.jsGzip} B gz, load ${result.loadBefore.load1.toFixed(2)}${result.underLoad ? " (UNDER LOAD)" : ""}`,
          );
          if (session.serverQueries && !warmup) queries.push(await session.serverQueries());
        }
      } finally {
        await session.close();
      }
      const entry = results.targets[target.name] ?? { version: target.version(ctx), runs: [] };
      entry.version = target.version(ctx);
      entry.runs = samples;
      if (queries.length > 0) entry.serverQueries = queries;
      results.targets[target.name] = entry;
      saveResults(results);
    }
  } finally {
    await browser.close();
  }
} else if (command === "teardown") {
  for (const target of targets) await target.teardown?.(ctx);
} else if (command === "report") {
  console.log(renderReport(loadResults()));
} else {
  console.error(`unknown command "${command}"\n\n${USAGE}`);
  process.exit(2);
}
