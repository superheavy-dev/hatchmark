#!/usr/bin/env node
// Renders the HAT-8 Parcelwise dataset with the Default theme in the regions of the Paper
// "Desktop · Light · 1440" frame (T-0) and pixel-diffs each region against Paper's export, twice:
// unmasked, and in scope only, where what T-0 draws beyond DashboardData (event annotations, the
// pinned tooltip, the bar list, table subtotals and the "vs Sep" column) is masked or cut out.
// Usage: node scripts/paper-parity.ts --dataset dataset.json --paper <dir> --out <dir>
//   <dir> holds Paper's 1x PNG exports: kpi.png (KPI strip), line.png (line chart card),
//   bar.png (bar list card) and table.png (table card).
/// <reference lib="dom" />
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { chromium } from "playwright";
import type {
  BarData,
  DashboardData,
  KpiData,
  LineData,
  MetricInfo,
  TableData,
} from "../src/compiler/index.js";
import type * as render from "../src/render/index.js";

const { FONT_FILES, renderDashboardPage }: typeof render = await import(
  new URL("../dist/render/index.js", import.meta.url).href
);

interface Dataset {
  meta: { description: string };
  kpis: { id: string; unit: string; current: number; previous: number }[];
  weekly: { week: string; growth: number; enterprise: number; starter: number }[];
  plans: { id: string; name: string }[];
  byIndustry: { name: string; revenue: number }[];
  byCountry: { name: string; region: string; merchants: number; revenue: number }[];
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Scope {
  masks: Rect[];
  shift?: { x0: number; x1: number; y0: number; y1: number; dx: number };
  cutColumn?: { x0: number; x1: number; insertAt: number };
  cutRows?: [number, number][];
}

const THRESHOLD = 48;
const { values: args } = parseArgs({
  options: { dataset: { type: "string" }, paper: { type: "string" }, out: { type: "string" } },
});
if (!args.dataset || !args.paper || !args.out) {
  console.error("usage: node scripts/paper-parity.ts --dataset <json> --paper <dir> --out <dir>");
  process.exit(2);
}
const { dataset: datasetPath, paper: paperDir, out: outDir } = args;
const d: Dataset = JSON.parse(await readFile(datasetPath, "utf8"));
const pkg = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const OCT = { start: "2026-10-01", end: "2026-11-01" };
const SEP = { start: "2026-09-01", end: "2026-10-01" };
const usd: MetricInfo["format"] = { type: "currency", currency: "USD" };
const metrics: DashboardData["metrics"] = {
  revenue: { name: "revenue", label: "Revenue", format: usd, better: "up" },
  merchants: {
    name: "merchants",
    label: "Active merchants",
    format: { type: "number" },
    better: "up",
  },
  arpm: { name: "arpm", label: "Revenue per merchant", format: usd, better: "up" },
  churn: {
    name: "churn",
    label: "Net revenue churn",
    format: { type: "percent", decimals: 1 },
    better: "down",
  },
};
const kpis = d.kpis.map((k): KpiData => {
  const points = k.unit === "pct";
  return {
    type: "kpi",
    id: k.id,
    span: 3,
    metric: k.id,
    value: k.current,
    compare: "previous_period",
    current: OCT,
    previous: SEP,
    previousValue: k.previous,
    change: k.current - k.previous,
    changePct: points ? k.current - k.previous : k.current / k.previous - 1,
    changeKind: points ? "points" : "relative",
  };
});
const weeks = d.weekly.map((w) => w.week);
const plans = ["growth", "enterprise", "starter"] as const;
const line: LineData = {
  type: "line",
  id: "weekly_by_plan",
  title: "Enterprise revenue stepped up after the March repricing",
  span: 8,
  axis: {
    kind: "time",
    grain: "week",
    buckets: weeks,
    window: { start: weeks[0] ?? "2025-11-03", end: "2026-11-02" },
  },
  series: plans.map((p) => ({
    key: "revenue:" + p,
    metric: "revenue",
    label: d.plans.find((x) => x.id === p)?.name ?? p,
    splitValue: p,
    values: d.weekly.map((w) => w[p]),
  })),
};
const bar: BarData = {
  type: "bar",
  id: "by_industry",
  title: "Apparel leads with 21.4% of October revenue",
  span: 4,
  orientation: "horizontal",
  stack: false,
  axis: { kind: "category", column: "industry", categories: d.byIndustry.map((i) => i.name) },
  series: [
    {
      key: "revenue",
      metric: "revenue",
      label: "Revenue",
      values: d.byIndustry.map((i) => i.revenue),
    },
  ],
};
const regions = [...new Set(d.byCountry.map((c) => c.region))];
const countries = regions.flatMap((r) =>
  d.byCountry.filter((c) => c.region === r).sort((a, b) => b.revenue - a.revenue),
);
const total = countries.reduce((s, c) => s + c.revenue, 0);
const table: TableData = {
  type: "table",
  id: "by_country",
  title: "North America is two thirds of revenue",
  span: 12,
  by: [{ column: "country", label: "Country" }],
  metrics: ["merchants", "revenue"],
  percentOfTotal: ["revenue"],
  rows: countries.map((c) => ({
    keys: [c.name],
    values: { merchants: c.merchants, revenue: c.revenue },
    share: { revenue: c.revenue / total },
  })),
  rowCount: countries.length,
  total: {
    values: { merchants: countries.reduce((s, c) => s + c.merchants, 0), revenue: total },
    share: { revenue: 1 },
  },
  window: OCT,
};
const data: DashboardData = {
  version: 2,
  name: "parcelwise",
  title: "Revenue overview",
  description: d.meta.description,
  project: "Parcelwise",
  asOf: "2026-10-31",
  horizons: [],
  period: { range: "last_complete_month", compare: "previous_period", current: OCT, previous: SEP },
  locale: "en-US",
  currency: "USD",
  timezone: "America/New_York",
  anchors: { week: "monday", quarter: "01-01", year: "01-01" },
  metrics,
  blocks: [...kpis, line, bar, table],
};

await mkdir(outDir, { recursive: true });
const assets = {
  runtime: pathToFileURL(path.join(pkg, "assets/runtime/hatchmark.js")).href,
  fonts: Object.fromEntries(
    FONT_FILES.map((f) => [f.file, pathToFileURL(path.join(pkg, "assets/fonts", f.file)).href]),
  ),
};
const pagePath = path.join(outDir, "paper-parity-page.html");
await writeFile(pagePath, renderDashboardPage(data, { assets, sources: ["dataset.json"] }));

// Out-of-scope geometry in T-0's 1x exports, read from the Paper frame. The line chart's plot
// sits at (17, 68) in its card; table rows are 30 px under a 26 px header ending at y 90.
const plot = (x: number, y: number, w: number, h: number): Rect => ({
  x: 17 + x,
  y: 68 + y,
  w,
  h,
});
const REGIONS: { name: string; selector: string; scope: Scope; outOfScope: string }[] = [
  { name: "kpi", selector: ".hm-strip", scope: { masks: [] }, outOfScope: "nothing" },
  {
    name: "line",
    selector: ".hm-card.hm-line",
    scope: {
      masks: [
        plot(133.6, 0, 170, 16),
        plot(289.8, 16, 194, 16),
        plot(502.7, 0, 197, 16),
        plot(127.6, 16, 4, 240),
        plot(283.8, 32, 4, 224),
        plot(496.7, 16, 4, 240),
        plot(364, 100, 232, 168),
        plot(592, 44, 12, 212),
      ],
    },
    outOfScope:
      "event annotations (labels and dashed rules), the pinned tooltip, crosshair and points",
  },
  {
    name: "bar",
    selector: ".hm-card.hm-bar",
    scope: { masks: [{ x: 1, y: 64, w: 454, h: 301 }] },
    outOfScope: "the bar list body; only the card frame and header remain in scope",
  },
  {
    name: "table",
    selector: ".hm-card.hm-table",
    scope: {
      masks: [],
      shift: { x0: 33, x1: 865, y0: 91, y1: 661, dx: -16 },
      cutColumn: { x0: 1105, x1: 1205, insertAt: 800 },
      cutRows: [
        [91, 121],
        [211, 241],
        [391, 421],
        [541, 571],
      ],
    },
    outOfScope:
      "the four region subtotal rows and the vs Sep column (cut out, the first column widened by its width) and the 16 px country indent under a region",
  },
];

/** In the page: Paper's export brought to scope, then diffed against ours. Returns PNGs as base64. */
async function compare([a, b, threshold, scope]: [string, string, number, Scope]) {
  const context = (c: OffscreenCanvas) => c.getContext("2d") as OffscreenCanvasRenderingContext2D;
  const load = async (b64: string) => {
    const img = new Image();
    img.src = "data:image/png;base64," + b64;
    await img.decode();
    const c = new OffscreenCanvas(img.width, img.height);
    const g = context(c);
    g.fillStyle = "#fff";
    g.fillRect(0, 0, img.width, img.height);
    g.drawImage(img, 0, 0);
    return c;
  };
  const blank = (w: number, h: number): [OffscreenCanvas, OffscreenCanvasRenderingContext2D] => {
    const c = new OffscreenCanvas(w, h);
    const g = context(c);
    g.fillStyle = "#fff";
    g.fillRect(0, 0, w, h);
    return [c, g];
  };
  const png = async (canvas: OffscreenCanvas) => {
    const bytes = new Uint8Array(
      await (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer(),
    );
    let bin = "";
    for (const byte of bytes) bin += String.fromCharCode(byte);
    return btoa(bin);
  };
  const [paper, ours] = [await load(a), await load(b)];
  let scoped = paper;
  if (scope.shift) {
    const { x0, x1, y0, y1, dx } = scope.shift;
    const [c, g] = blank(scoped.width, scoped.height);
    g.drawImage(scoped, 0, 0);
    g.fillStyle = "#fff";
    g.fillRect(x0 + dx, y0, x1 - x0 - dx, y1 - y0);
    g.drawImage(scoped, x0, y0, x1 - x0, y1 - y0, x0 + dx, y0, x1 - x0, y1 - y0);
    scoped = c;
  }
  if (scope.cutColumn) {
    const { x0, x1, insertAt } = scope.cutColumn;
    const [c, g] = blank(scoped.width, scoped.height);
    const H = scoped.height;
    g.drawImage(scoped, 0, 0, insertAt, H, 0, 0, insertAt, H);
    g.drawImage(scoped, insertAt - 1, 0, 1, H, insertAt, 0, x1 - x0, H);
    g.drawImage(scoped, insertAt, 0, x0 - insertAt, H, insertAt + x1 - x0, 0, x0 - insertAt, H);
    g.drawImage(scoped, x1, 0, scoped.width - x1, H, x1, 0, scoped.width - x1, H);
    scoped = c;
  }
  if (scope.cutRows) {
    const cut = scope.cutRows.reduce((s, [y0, y1]) => s + y1 - y0, 0);
    const [c, g] = blank(scoped.width, scoped.height - cut);
    let from = 0;
    let to = 0;
    const rows: [number, number][] = [...scope.cutRows, [scoped.height, scoped.height]];
    for (const [y0, y1] of rows) {
      g.drawImage(scoped, 0, from, scoped.width, y0 - from, 0, to, scoped.width, y0 - from);
      to += y0 - from;
      from = y1;
    }
    scoped = c;
  }
  const diff = async (left: OffscreenCanvas, right: OffscreenCanvas, masks: Rect[]) => {
    const w = Math.min(left.width, right.width);
    const h = Math.min(left.height, right.height);
    const p = context(left).getImageData(0, 0, w, h).data;
    const o = context(right).getImageData(0, 0, w, h).data;
    const masked = new Uint8Array(w * h);
    for (const m of masks)
      for (let y = Math.max(0, Math.floor(m.y)); y < Math.min(h, Math.ceil(m.y + m.h)); y++)
        for (let x = Math.max(0, Math.floor(m.x)); x < Math.min(w, Math.ceil(m.x + m.w)); x++)
          masked[y * w + x] = 1;
    const [out, g] = blank(w * 3 + 32, Math.max(left.height, right.height));
    g.drawImage(left, 0, 0);
    g.drawImage(right, w + 16, 0);
    const map = g.createImageData(w, h);
    let differing = 0;
    let maskedCount = 0;
    for (let i = 0; i < w * h; i++) {
      const k = i * 4;
      const [pr = 0, pg = 0, pb = 0] = p.subarray(k, k + 3);
      const [or = 0, og = 0, ob = 0] = o.subarray(k, k + 3);
      const grey = 255 - (255 - pr) * 0.25;
      if (masked[i]) {
        maskedCount++;
        map.data.set([grey * 0.8, grey * 0.88, 255, 255], k);
        continue;
      }
      const delta = Math.max(Math.abs(pr - or), Math.abs(pg - og), Math.abs(pb - ob));
      if (delta > threshold) differing++;
      map.data.set(delta > threshold ? [220, 38, 38, 255] : [grey, grey, grey, 255], k);
    }
    g.putImageData(map, 2 * (w + 16), 0);
    return { w, h, differing, compared: w * h - maskedCount, png: await png(out) };
  };
  const overlay = async () => {
    const [out, g] = blank(paper.width + ours.width + 16, Math.max(paper.height, ours.height));
    g.drawImage(paper, 0, 0);
    g.drawImage(ours, paper.width + 16, 0);
    g.fillStyle = "rgba(37, 99, 235, 0.3)";
    g.strokeStyle = "rgb(37, 99, 235)";
    const mark = (x: number, y: number, w: number, h: number) => {
      g.fillRect(x, y, w, h);
      g.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    };
    for (const m of scope.masks) {
      mark(m.x, m.y, m.w, m.h);
      mark(paper.width + 16 + m.x, m.y, m.w, m.h);
    }
    for (const [y0, y1] of scope.cutRows ?? []) mark(0, y0, paper.width, y1 - y0);
    if (scope.cutColumn)
      mark(scope.cutColumn.x0, 0, scope.cutColumn.x1 - scope.cutColumn.x0, paper.height);
    if (scope.shift) {
      const { x0, y0, y1, dx } = scope.shift;
      g.fillStyle = "rgba(234, 179, 8, 0.35)";
      g.fillRect(x0 + dx, y0, -dx, y1 - y0);
    }
    return png(out);
  };
  return {
    paper: [paper.width, paper.height],
    ours: [ours.width, ours.height],
    unmasked: await diff(paper, ours, []),
    masked: await diff(scoped, ours, scope.masks),
    overlay: await overlay(),
  };
}

const pct = (r: { differing: number; compared: number }) =>
  Math.round((r.differing / r.compared) * 10000) / 100;
const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1,
});
await page.goto(pathToFileURL(pagePath).href);
await page.evaluate(() => document.fonts.ready);
const results: unknown[] = [];
for (const region of REGIONS) {
  const ours = await page.locator(region.selector).screenshot();
  const paper = await readFile(path.join(paperDir, region.name + ".png"));
  const diff = await page.evaluate(compare, [
    paper.toString("base64"),
    ours.toString("base64"),
    THRESHOLD,
    region.scope,
  ] as [string, string, number, Scope]);
  const save = (suffix: string, b64: string) =>
    writeFile(
      path.join(outDir, `paper-parity-${region.name}${suffix}.png`),
      Buffer.from(b64, "base64"),
    );
  await save("", diff.unmasked.png);
  await save("-masked", diff.masked.png);
  await save("-mask", diff.overlay);
  results.push({
    region: region.name,
    paper: diff.paper.join("x"),
    ours: diff.ours.join("x"),
    unmasked: {
      compared: `${diff.unmasked.w}x${diff.unmasked.h}`,
      differingPct: pct(diff.unmasked),
    },
    inScope: {
      compared: `${diff.masked.w}x${diff.masked.h}`,
      pixels: diff.masked.compared,
      differingPct: pct(diff.masked),
    },
    outOfScope: region.outOfScope,
  });
}
await page.screenshot({ path: path.join(outDir, "paper-parity-page.png"), fullPage: true });
await browser.close();
await writeFile(
  path.join(outDir, "paper-parity.json"),
  JSON.stringify({ threshold: THRESHOLD, results }, null, 2) + "\n",
);
console.log(JSON.stringify({ threshold: THRESHOLD, results }));
