import { cpus, loadavg, totalmem } from "node:os";
import { sleep } from "./util.ts";

export interface LoadSample {
  at: string;
  load1: number;
  load5: number;
  load15: number;
}

export interface Host {
  cpuModel: string;
  logicalCores: number;
  memoryGiB: number;
  platform: string;
  node: string;
  loadThreshold: number;
}

export function host(threshold?: number): Host {
  const cores = cpus();
  return {
    cpuModel: cores[0]?.model ?? "unknown",
    logicalCores: cores.length,
    memoryGiB: Math.round(totalmem() / 2 ** 30),
    platform: `${process.platform}-${process.arch}`,
    node: process.version,
    loadThreshold: threshold ?? defaultThreshold(),
  };
}

export function defaultThreshold(): number {
  return Math.max(1, Math.round(cpus().length * 0.25 * 10) / 10);
}

export function sampleLoad(): LoadSample {
  const [load1 = 0, load5 = 0, load15 = 0] = loadavg();
  return { at: new Date().toISOString(), load1, load5, load15 };
}

export async function waitForLowLoad(
  threshold: number,
  maxWaitMs: number,
  log: (line: string) => void,
): Promise<LoadSample> {
  const deadline = Date.now() + maxWaitMs;
  let sample = sampleLoad();
  while (sample.load1 > threshold && Date.now() < deadline) {
    log(`load ${sample.load1.toFixed(2)} > ${threshold}; waiting`);
    await sleep(15_000);
    sample = sampleLoad();
  }
  return sample;
}
