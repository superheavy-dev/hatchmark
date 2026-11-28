import { cpSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { serveStatic } from "../static-server.ts";
import type { BenchContext, Target } from "../target.ts";
import { run, timed } from "../util.ts";

export const EVIDENCE_TEMPLATE = "https://github.com/evidence-dev/template";
export const EVIDENCE_TEMPLATE_COMMIT = "ec9e0f5";

const KPI = "#evidence-main-article > div.inline-block .text-xl";
const CHART = "#evidence-main-article .chart-container canvas";
const dir = (ctx: BenchContext) => join(ctx.work, "evidence");
const env = { SEND_ANONYMOUS_USAGE_STATS: "no", NODE_ENV: "production" };

export const evidence: Target = {
  name: "evidence",
  version(ctx) {
    const pkg = JSON.parse(
      readFileSync(join(dir(ctx), "node_modules/@evidence-dev/evidence/package.json"), "utf8"),
    );
    return `@evidence-dev/evidence ${pkg.version}`;
  },
  visuals: [
    { name: "kpi_revenue", kind: "text", selector: KPI, index: 0 },
    { name: "kpi_orders", kind: "text", selector: KPI, index: 1 },
    { name: "kpi_aov", kind: "text", selector: KPI, index: 2 },
    { name: "kpi_refund_rate", kind: "text", selector: KPI, index: 3 },
    { name: "line_revenue_by_region", kind: "canvas", chart: true, selector: CHART, index: 0 },
    { name: "bar_revenue_by_channel", kind: "canvas", chart: true, selector: CHART, index: 1 },
    {
      name: "table_by_country",
      kind: "table",
      selector: '[data-testid="DataTable-by_country"] table',
      marks: "tr",
      minMarks: 12,
    },
  ],
  async setup(ctx) {
    const target = dir(ctx);
    if (!existsSync(join(target, "node_modules/@evidence-dev/evidence"))) {
      rmSync(target, { recursive: true, force: true });
      run("git", ["clone", "--quiet", EVIDENCE_TEMPLATE, target]);
      run("git", ["checkout", "--quiet", EVIDENCE_TEMPLATE_COMMIT], { cwd: target });
      rmSync(join(target, ".git"), { recursive: true, force: true });
      rmSync(join(target, "sources"), { recursive: true, force: true });
      rmSync(join(target, "pages"), { recursive: true, force: true });
      ctx.log("evidence: npm ci (pinned template lockfile)");
      run("nice", ["-n", "10", "npm", "ci", "--no-audit", "--no-fund"], { cwd: target, env });
    }
    cpSync(join(ctx.root, "bench/dashboards/evidence"), target, { recursive: true });
    cpSync(ctx.dataFile, join(target, "sources/orders/orders.csv"));
    await this.build?.(ctx);
  },
  async build(ctx) {
    const target = dir(ctx);
    for (const path of ["build", ".evidence/template/static/data", ".evidence/meta"]) {
      rmSync(join(target, path), { recursive: true, force: true });
    }
    const sources = await timed("npm", ["run", "sources"], { cwd: target, env });
    const build = await timed("npm", ["run", "build"], { cwd: target, env });
    return sources + build;
  },
  async start(ctx) {
    const server = await serveStatic(join(dir(ctx), "build"));
    return { url: `${server.url}/`, close: server.close };
  },
  async prepareInteraction(page) {
    const option = page.getByRole("option", { name: "EMEA", exact: true });
    if (!(await option.isVisible())) await page.getByRole("combobox", { name: "Region" }).click();
    await option.waitFor();
  },
  async commitInteraction(page) {
    await page.getByRole("option", { name: "EMEA", exact: true }).click();
  },
};
