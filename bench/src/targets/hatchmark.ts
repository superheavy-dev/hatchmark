import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { serveStatic } from "../static-server.ts";
import type { BenchContext, Target } from "../target.ts";
import { run, timed } from "../util.ts";

const dir = (ctx: BenchContext) => join(ctx.work, "hatchmark");
const cli = (ctx: BenchContext) => join(ctx.root, "packages/hatchmark/dist/cli/bin.js");

export const hatchmark: Target = {
  name: "hatchmark",
  version(ctx) {
    const pkg = JSON.parse(readFileSync(join(ctx.root, "packages/hatchmark/package.json"), "utf8"));
    const commit = run("git", ["rev-parse", "--short=10", "HEAD"], { cwd: ctx.root }).trim();
    return `${pkg.version} (${commit})`;
  },
  visuals: [
    {
      name: "kpi_revenue",
      kind: "text",
      selector: ".hm-strip > .hm-kpi:nth-child(1) .hm-kpi-value",
    },
    {
      name: "kpi_orders",
      kind: "text",
      selector: ".hm-strip > .hm-kpi:nth-child(2) .hm-kpi-value",
    },
    { name: "kpi_aov", kind: "text", selector: ".hm-strip > .hm-kpi:nth-child(3) .hm-kpi-value" },
    {
      name: "kpi_refund_rate",
      kind: "text",
      selector: ".hm-strip > .hm-kpi:nth-child(4) .hm-kpi-value",
    },
    {
      name: "line_revenue_by_region",
      kind: "svg",
      chart: true,
      selector: 'figure[data-hm-chart="revenue_by_region"] svg',
      marks: "path",
      minMarks: 3,
    },
    {
      name: "bar_revenue_by_channel",
      kind: "svg",
      chart: true,
      selector: 'figure[data-hm-chart="revenue_by_channel"] svg',
      marks: "rect",
      minMarks: 6,
    },
    {
      name: "table_by_country",
      kind: "table",
      selector: "table.hm-table",
      marks: "tbody tr",
      minMarks: 10,
    },
  ],
  async setup(ctx) {
    if (!existsSync(cli(ctx))) {
      throw new Error("packages/hatchmark/dist is missing; run pnpm build first");
    }
    rmSync(dir(ctx), { recursive: true, force: true });
    cpSync(join(ctx.root, "bench/dashboards/hatchmark"), dir(ctx), { recursive: true });
    mkdirSync(join(dir(ctx), "data"), { recursive: true });
    cpSync(ctx.dataFile, join(dir(ctx), "data/orders.csv"));
    run("node", [cli(ctx), "build", "--json"], { cwd: dir(ctx) });
  },
  async build(ctx) {
    rmSync(join(dir(ctx), "dist"), { recursive: true, force: true });
    rmSync(join(dir(ctx), ".hatchmark"), { recursive: true, force: true });
    return timed("node", [cli(ctx), "build", "--no-cache", "--json"], { cwd: dir(ctx) });
  },
  async start(ctx) {
    const server = await serveStatic(join(dir(ctx), "dist"));
    return { url: `${server.url}/bench/`, close: server.close };
  },
  async prepareInteraction() {},
  async commitInteraction(page) {
    await page.locator('button[data-hm-segment="emea"]').click();
  },
};
