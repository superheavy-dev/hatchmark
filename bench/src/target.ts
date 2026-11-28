import type { BrowserContext, Page } from "playwright";
import type { Visual } from "./probe.ts";

export interface BenchContext {
  root: string;
  work: string;
  dataFile: string;
  rows: number;
  log(line: string): void;
}

export interface Session {
  url: string;
  authenticate?(context: BrowserContext): Promise<void>;
  serverQueries?(): Promise<number>;
  close(): Promise<void>;
}

export interface Target {
  name: string;
  version(ctx: BenchContext): string;
  visuals: Visual[];
  setup(ctx: BenchContext): Promise<void>;
  build?(ctx: BenchContext): Promise<number>;
  start(ctx: BenchContext): Promise<Session>;
  prepareInteraction(page: Page): Promise<void>;
  commitInteraction(page: Page): Promise<void>;
  teardown?(ctx: BenchContext): Promise<void>;
}
