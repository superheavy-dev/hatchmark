import type { Host, LoadSample } from "./machine.ts";
import type { Bytes, RunResult } from "./measure.ts";
import type { Profile } from "./profiles.ts";
import { type Summary, summarize } from "./stats.ts";

export interface BuildSample {
  run: number;
  warmup: boolean;
  ms: number;
  loadBefore: LoadSample;
  loadAfter: LoadSample;
  underLoad: boolean;
}

export interface TargetResults {
  version: string;
  runs: RunResult[];
  build?: BuildSample[];
  serverQueries?: number[];
}

export interface Results {
  host: Host;
  dataset: { rows: number; sha256: string } | null;
  profile?: Profile;
  browser?: string;
  targets: Record<string, TargetResults>;
}

const kb = (bytes: number | null | undefined) =>
  bytes === null || bytes === undefined
    ? "–"
    : `${(bytes / 1024).toFixed(bytes < 10_240 ? 1 : 0)} KB`;
const ms = (summary: Summary | null) =>
  summary
    ? `${Math.round(summary.median)} ms (${Math.round(summary.p25)}–${Math.round(summary.p75)})`
    : "–";
const medianBytes = (
  runs: RunResult[],
  pick: (b: Bytes) => number,
  phase: "initialBytes" | "totalBytes",
) => summarize(runs.map((r) => pick(r[phase])))?.median ?? null;

export function renderReport(results: Results): string {
  const lines: string[] = [];
  const { host, profile } = results;
  lines.push(
    `Host: ${host.cpuModel}, ${host.logicalCores} logical cores, ${host.memoryGiB} GiB, ${host.platform}, Node ${host.node}.`,
  );
  if (results.browser) lines.push(`Browser: ${results.browser}.`);
  if (profile) {
    lines.push(
      `Profile: ${profile.name}, viewport ${profile.viewport.width}×${profile.viewport.height} at ${profile.deviceScaleFactor}x, CPU ${profile.cpuThrottle}x slowdown, ${
        profile.network
          ? `${profile.network.latencyMs} ms latency, ${profile.network.downloadKbps} Kbps down, ${profile.network.uploadKbps} Kbps up`
          : "no network throttling"
      }.`,
    );
  }
  if (results.dataset)
    lines.push(`Dataset: ${results.dataset.rows} rows, sha256 ${results.dataset.sha256}.`);
  lines.push(`Load threshold: 1-minute load average ${host.loadThreshold}.`, "");

  const entries = Object.entries(results.targets);
  lines.push(
    "| Target | Version | Runs (under load) | JS gzip, load | JS gzip, after filter | JS raw, after filter | WASM | Transfer, load | First chart | All visuals | Filter to settled | Longest event |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  );
  for (const [name, target] of entries) {
    const runs = target.runs.filter((r) => !r.warmup);
    if (runs.length === 0) continue;
    lines.push(
      `| ${name} | ${target.version} | ${runs.length} (${runs.filter((r) => r.underLoad).length}) | ${kb(medianBytes(runs, (b) => b.jsGzip, "initialBytes"))} | ${kb(medianBytes(runs, (b) => b.jsGzip, "totalBytes"))} | ${kb(medianBytes(runs, (b) => b.jsDecoded, "totalBytes"))} | ${kb(medianBytes(runs, (b) => b.wasmDecoded, "totalBytes"))} | ${kb(medianBytes(runs, (b) => b.totalTransfer, "initialBytes"))} | ${ms(summarize(runs.map((r) => r.firstChartMs)))} | ${ms(summarize(runs.map((r) => r.allVisualsMs)))} | ${ms(summarize(runs.map((r) => r.interactionMs)))} | ${ms(summarize(runs.map((r) => r.interactionMaxEventMs)))} |`,
    );
  }
  lines.push(
    "",
    "| Target | Build from raw data | Server queries per view | Build runs (under load) |",
    "| --- | --- | --- | --- |",
  );
  for (const [name, target] of entries) {
    const builds = (target.build ?? []).filter((b) => !b.warmup);
    lines.push(
      `| ${name} | ${ms(summarize(builds.map((b) => b.ms)))} | ${ms(summarize(target.serverQueries ?? []))} | ${builds.length} (${builds.filter((b) => b.underLoad).length}) |`,
    );
  }
  lines.push("", "Medians with the interquartile range in brackets. Warm-up runs are excluded.");
  return lines.join("\n");
}
