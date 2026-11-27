/// <reference lib="dom" />
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SALES } from "../../gallery/fixtures.js";
import { FISCAL_BARS, MONTH, QUARTER_BARS, revenueSwitch } from "../../gallery/grains.js";
import { GALLERY } from "../../gallery/variants.js";
import type {
  DashboardData,
  GrainSwitch,
  LineData,
  ScatterData,
} from "../../src/compiler/dashboard-data.js";
import { FONT_FILES, renderDashboardPage } from "../../src/render/index.js";
import tokens from "../../src/render/themes/default.json" with { type: "json" };

let browser: Browser;
let dir: string;
let url: string;
let sparkUrl: string;
let allUrl: string;
let gapUrl: string;
let dailyUrl: string;
let narrowUrl: string;
let densityUrl: string;
let partialUrl: string;
let partialStackUrl: string;
type Box = { x: number; y: number; width: number; height: number };

beforeAll(async () => {
  browser = await chromium.launch();
  dir = await mkdtemp(path.join(tmpdir(), "hatchmark-runtime-"));
  const assets = new URL("../../assets/", import.meta.url);
  await cp(new URL("runtime/hatchmark.js", assets), path.join(dir, "hatchmark.js"));
  const fonts: Record<string, string> = {};
  for (const font of FONT_FILES) {
    await cp(new URL(`fonts/${font.file}`, assets), path.join(dir, font.file));
    fonts[font.file] = font.file;
  }
  await writeFile(
    path.join(dir, "index.html"),
    renderDashboardPage(SALES, { assets: { runtime: "hatchmark.js", fonts } }),
  );
  url = `file://${path.join(dir, "index.html")}`;
  const spark = GALLERY.find((v) => v.variant === "kpi-sparkline")?.data;
  if (!spark) throw new Error("kpi-sparkline gallery variant is missing");
  await writeFile(
    path.join(dir, "spark.html"),
    renderDashboardPage(spark, { assets: { runtime: "hatchmark.js", fonts } }),
  );
  sparkUrl = `file://${path.join(dir, "spark.html")}`;
  const page = async (name: string, data: DashboardData) => {
    await writeFile(
      path.join(dir, `${name}.html`),
      renderDashboardPage(data, { assets: { runtime: "hatchmark.js", fonts } }),
    );
    return `file://${path.join(dir, `${name}.html`)}`;
  };
  const partialData = GALLERY.find((v) => v.variant === "line-incomplete-mark")?.data;
  if (!partialData) throw new Error("line-incomplete-mark gallery variant is missing");
  partialUrl = await page("partial", partialData);
  const partialStack = GALLERY.find((v) => v.variant === "bar-incomplete-stacked")?.data;
  if (!partialStack) throw new Error("bar-incomplete-stacked gallery variant is missing");
  partialStackUrl = await page("partial-stack", partialStack);
  const longLineData = GALLERY.find((v) => v.variant === "line-long-names")?.data;
  const longLine = longLineData?.blocks[0] as LineData;
  const longLineMetrics = longLineData?.metrics ?? {};
  const eight: LineData = {
    ...longLine,
    id: "eight_long",
    series: Array.from({ length: 8 }, (_, i) => ({
      ...(longLine.series[0] as LineData["series"][number]),
      key: `s${i}`,
      label: `A particularly long series name for every geom ${i}`,
      values: longLine.series[0]?.values.map((v) => (v === null ? null : v + i * 1000)) ?? [],
    })),
  };
  allUrl = await page("all", {
    ...SALES,
    metrics: Object.assign({}, ...GALLERY.map((v) => v.data.metrics)),
    blocks: [...GALLERY.flatMap((v) => v.data.blocks), eight],
  });
  const revenueLine = SALES.blocks.find((b) => b.type === "line") as LineData;
  gapUrl = await page("gap", {
    ...SALES,
    blocks: [
      {
        ...revenueLine,
        id: "gap",
        axis: { ...revenueLine.axis, buckets: ["2026-01-01", "2026-02-01"] },
        series: [
          {
            ...(revenueLine.series[0] as LineData["series"][number]),
            key: "a",
            label: "A",
            values: [10, null],
          },
          {
            ...(revenueLine.series[0] as LineData["series"][number]),
            key: "b",
            label: "B",
            values: [20, 30],
          },
        ],
      },
    ],
  });
  const daily = GALLERY.find((v) => v.variant === "line-daily")?.data;
  if (!daily) throw new Error("line-daily gallery variant is missing");
  dailyUrl = await page("daily", daily);
  const twoSeries = { ...revenueLine, series: eight.series.slice(0, 2) } as LineData;
  narrowUrl = await page("narrow", {
    ...SALES,
    metrics: { ...SALES.metrics, ...longLineMetrics },
    blocks: [
      { ...twoSeries, id: "span_one", span: 1, axis: longLine.axis },
      { ...twoSeries, id: "span_three", span: 3, axis: longLine.axis },
    ],
  });
  densityUrl = await page("density", {
    ...SALES,
    metrics: { ...SALES.metrics, ...longLineMetrics },
    blocks: [
      { ...eight, id: "two_long", span: 6, series: eight.series.slice(0, 2) },
      { ...eight, id: "eight_long", span: 6 },
    ],
  });
});

afterAll(async () => {
  await browser?.close();
  await rm(dir, { recursive: true, force: true });
});

describe("browser runtime", () => {
  it("shows a tooltip and crosshair on hover and hides them on leave", async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(url);
    const svg = page.locator(".hm-line svg").filter({ visible: true });
    const box = (await svg.boundingBox()) as {
      x: number;
      y: number;
      width: number;
      height: number;
    };
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
    const tip = page.locator(".hm-line .hm-tip");
    await expect.poll(() => tip.isVisible()).toBe(true);
    expect(await tip.locator(".hm-tip-h").textContent()).toMatch(/^\w{3} 20\d\d$/);
    expect(await tip.locator(".hm-tip-r").textContent()).toMatch(/^Revenue\$[\d,]+$/);
    expect(await page.locator(".hm-line .hm-hover .hm-dot").count()).toBe(2);
    await page.mouse.move(5, 5);
    await expect.poll(() => tip.isVisible()).toBe(false);
  });

  it("steps through bars with the keyboard", async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(url);
    await page.locator(".hm-bar svg").filter({ visible: true }).focus();
    await page.keyboard.press("ArrowDown");
    const tip = page.locator(".hm-bar .hm-tip");
    expect(await tip.textContent()).toContain("United States");
    await page.keyboard.press("End");
    expect(await tip.textContent()).toContain("Brazil");
    await page.keyboard.press("Escape");
    await expect.poll(() => tip.isVisible()).toBe(false);
  });

  it("puts a partial bucket's status on the tooltip's second line, and in the announcement", async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(partialUrl);
    await page.locator(".hm-line svg").filter({ visible: true }).focus();
    await page.keyboard.press("End");
    const tip = page.locator(".hm-line .hm-tip");
    expect(await tip.locator(".hm-tip-h").textContent()).toBe("Sep 21–23");
    expect(await tip.locator(".hm-tip-s").textContent()).toBe("In progress · 3 of 7 days");
    const fill = tokens.data.light.categoricalFill[0] as string;
    expect(
      await tip
        .locator(".hm-tip-r i.hm-tip-hatch")
        .first()
        .evaluate((i) => getComputedStyle(i).color),
    ).toBe(`rgb(${[1, 3, 5].map((k) => Number.parseInt(fill.slice(k, k + 2), 16)).join(", ")})`);
    await page.keyboard.press("Home");
    expect(await tip.locator(".hm-tip-s").count()).toBe(0);
    await page.keyboard.press("End");
    await expect
      .poll(() => page.locator(".hm-line [aria-live]").first().textContent())
      .toContain("In progress · 3 of 7 days");
  });

  it("gives the pinned readout a status line and hatched swatches on a partial bucket", async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto(partialUrl);
    const svg = page.locator(".hm-line svg").filter({ visible: true });
    const visible = (selector: string) =>
      svg
        .locator(selector)
        .first()
        .evaluate((n) => getComputedStyle(n).visibility);
    expect(await svg.locator(".hm-readout").count()).toBe(1);
    expect(await svg.locator(".hm-rh").textContent()).toBe("Sep 21\u201323");
    expect(await svg.locator(".hm-rs").textContent()).toBe("In progress \u00B7 3 of 7 days");
    expect(await visible(".hm-rsw")).toBe("visible");
    expect(await visible(".hm-rq-0")).toBe("visible");
    expect(await visible(".hm-rd-0")).toBe("hidden");
    await svg.focus();
    await page.keyboard.press("Home");
    expect(await svg.locator(".hm-rs").textContent()).toBe("");
    expect(await visible(".hm-rsw")).toBe("hidden");
    expect(await visible(".hm-rq-0")).toBe("hidden");
    expect(await visible(".hm-rd-0")).toBe("visible");
    await page.keyboard.press("End");
    expect(await svg.locator(".hm-rs").textContent()).toBe("In progress \u00B7 3 of 7 days");
    await page.close();
  });

  it("marks a partial stack's Total row with the hatched swatch and its status, and announces it", async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(partialStackUrl);
    await page.locator(".hm-bar svg").filter({ visible: true }).focus();
    await page.keyboard.press("End");
    const tip = page.locator(".hm-bar .hm-tip");
    const total = tip.locator(".hm-tip-t");
    expect(await total.locator(".hm-tip-n").textContent()).toBe("Total");
    expect(await total.locator("i.hm-tip-hatch").count()).toBe(1);
    const swatch = await total
      .locator("i.hm-tip-hatch")
      .evaluate((i) => [getComputedStyle(i).backgroundImage, i.getBoundingClientRect().height]);
    expect(swatch[0]).toContain("repeating-linear-gradient");
    expect(swatch[1]).toBe(10);
    expect(await tip.locator(".hm-tip-s").first().locator("i.hm-tip-hatch").count()).toBe(1);
    expect(await tip.locator(".hm-tip-r:not(.hm-tip-t) i.hm-tip-hatch").count()).toBe(3);
    expect(await tip.locator(".hm-tip-ts").textContent()).toBe("In progress · 23 of 30 days");
    await expect
      .poll(() => page.locator(".hm-bar [aria-live]").first().textContent())
      .toMatch(/Total \$[\d,]+, In progress · 23 of 30 days$/);
    await page.keyboard.press("Home");
    expect(await total.locator("i.hm-tip-hatch").count()).toBe(0);
    expect(await tip.locator(".hm-tip-ts").count()).toBe(0);
    expect(await tip.locator("i.hm-tip-hatch").count()).toBe(0);
    await page.close();
  });

  it("lists each part's value and share and the total in a 100% stacked bar's tooltip", async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(allUrl);
    const figure = page.locator('[data-hm-chart="percent"]');
    await figure.locator("svg").filter({ visible: true }).focus();
    await page.keyboard.press("ArrowRight");
    const tip = figure.locator(".hm-tip");
    expect(await tip.locator(".hm-tip-h").textContent()).toBe("North America");
    const rows = await tip.locator(".hm-tip-r:not(.hm-tip-t)").allTextContents();
    expect(rows).toEqual([
      expect.stringMatching(/^Online store\$[\d,]+64\.0%$/),
      expect.stringMatching(/^Marketplace\$[\d,]+22\.0%$/),
      expect.stringMatching(/^Retail partners\$[\d,]+14\.0%$/),
    ]);
    expect(await tip.locator(".hm-tip-t").textContent()).toMatch(/^Total\$[\d,]+$/);
    const live = await figure.locator("[aria-live]").textContent();
    expect(live).toMatch(/^North America, Online store \$[\d,]+, 64\.0%, /);
    expect(live).toMatch(/Total \$[\d,]+$/);
  });

  it("keeps a tapped selection after the finger lifts, and clears it on a tap outside", async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 800 }, hasTouch: true });
    await page.goto(allUrl);
    const figure = page.locator('[data-hm-chart="percent"]');
    const svg = figure.locator("svg").filter({ visible: true });
    await svg.scrollIntoViewIfNeeded();
    const box = await svg.boundingBox();
    if (!box) throw new Error("chart has no box");
    await page.touchscreen.tap(box.x + box.width * 0.3, box.y + box.height * 0.6);
    const tip = figure.locator(".hm-tip");
    await page.waitForTimeout(100);
    expect(await tip.isVisible()).toBe(true);
    expect(await tip.locator(".hm-tip-t").textContent()).toMatch(/^Total\$[\d,]+$/);
    await page.touchscreen.tap(5, 5);
    await expect.poll(() => tip.isVisible()).toBe(false);
  });

  it("highlights one slice and shows its value and share in a pie, by keyboard and by hover", async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(allUrl);
    const figure = page.locator('[data-hm-chart="pie_countries"]');
    const svg = figure.locator("svg").filter({ visible: true });
    await svg.focus();
    await page.keyboard.press("ArrowRight");
    const tip = figure.locator(".hm-tip");
    expect(await tip.locator(".hm-tip-h").textContent()).toBe("United States");
    expect(await tip.textContent()).toMatch(/\$[\d,]+39\.2%/);
    expect(await svg.getAttribute("class")).toContain("hm-dim");
    expect(await svg.locator(".hm-slice.hm-on").count()).toBe(1);
    await page.keyboard.press("End");
    expect(await tip.locator(".hm-tip-h").textContent()).toMatch(/^Other \(19 more\)$/);
    expect(await figure.locator("[aria-live]").textContent()).toMatch(
      /^Other \(19 more\), Revenue \$[\d,]+, 32\.3%/,
    );
    await page.keyboard.press("Escape");
    await expect.poll(() => tip.isVisible()).toBe(false);
    expect(await svg.getAttribute("class")).not.toContain("hm-dim");

    const donut = page.locator('[data-hm-chart="donut_channels"]');
    const ring = donut.locator("svg").filter({ visible: true });
    const box = await ring.locator(".hm-slice").first().boundingBox();
    if (!box) throw new Error("donut slice has no box");
    await page.mouse.move(box.x + box.width * 0.85, box.y + box.height * 0.5);
    expect(await donut.locator(".hm-tip .hm-tip-h").textContent()).toBe("Online store");
    await page.mouse.move(5, 5);
    await expect.poll(() => donut.locator(".hm-tip").isVisible()).toBe(false);
  });

  it("steps through scatter points left to right, with a tooltip of x, y and size", async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(allUrl);
    const figure = page.locator('[data-hm-chart="scatter_countries"]');
    const svg = figure.locator("svg").filter({ visible: true });
    await svg.focus();
    await page.keyboard.press("ArrowRight");
    const tip = figure.locator(".hm-tip");
    const block = GALLERY.find((v) => v.variant === "scatter-countries")?.data.blocks[0];
    const fewest = (block as ScatterData).points.reduce((a, b) =>
      (b.x as number) < (a.x as number) ? b : a,
    );
    expect(await tip.locator(".hm-tip-h").textContent()).toBe(fewest.label);
    expect(await tip.locator(".hm-tip-r").allTextContents()).toEqual([
      expect.stringMatching(/^Orders[\d,]+$/),
      expect.stringMatching(/^Average order value\$[\d,]+\.\d\d$/),
      expect.stringMatching(/^Revenue\$[\d,]+$/),
    ]);
    expect(await figure.locator(".hm-hover .hm-ring").count()).toBe(2);
    await page.keyboard.press("End");
    expect(await tip.locator(".hm-tip-h").textContent()).toBe("United States");
    expect(await figure.locator("[aria-live]").textContent()).toMatch(
      /^United States, Orders [\d,]+, Average order value \$[\d,]+\.\d\d, Revenue \$[\d,]+$/,
    );
    await page.keyboard.press("Escape");
    await expect.poll(() => tip.isVisible()).toBe(false);

    const [cx = 0, cy = 0] =
      ((await svg.getAttribute("data-hm-pts")) as string)
        .split(",")
        .at(-1)
        ?.split(" ")
        .map(Number) ?? [];
    const box = (await svg.boundingBox()) as Box;
    await page.mouse.move(box.x + cx + 10, box.y + cy + 6);
    await expect.poll(() => tip.isVisible()).toBe(true);
    expect(await tip.locator(".hm-tip-h").textContent()).toBe("United States");
    await page.mouse.move(box.x + 2, box.y + box.height - 2);
    await expect.poll(() => tip.isVisible()).toBe(false);
  });

  it("updates the pinned readout instead of a tooltip on a phone", async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 800 }, hasTouch: true });
    await page.goto(url);
    const svg = page.locator(".hm-line svg").filter({ visible: true });
    expect(await svg.getAttribute("width")).toBe("324");
    const box = (await svg.boundingBox()) as {
      x: number;
      y: number;
      width: number;
      height: number;
    };
    const before = await svg.locator(".hm-rh").textContent();
    await page.mouse.move(box.x + 60, box.y + box.height - 60);
    await expect.poll(() => svg.locator(".hm-rh").textContent()).not.toBe(before);
    expect(await page.locator(".hm-line .hm-tip").count()).toBe(0);
  });

  for (const width of [320, 390, 1440]) {
    it(`keeps the KPI tooltip inside the viewport and off the figure at ${width} px`, async () => {
      const page = await browser.newPage({ viewport: { width, height: 700 } });
      await page.goto(sparkUrl);
      await page.evaluate(() => {
        document.body.style.padding = "900px 0";
      });
      const kpi = page.locator(".hm-kpi[data-hm-chart]").first();
      const spark = kpi.locator("svg.hm-spark");
      const tip = kpi.locator(".hm-tip");
      for (const gap of [10, 30, 80, 300]) {
        await page.evaluate((g) => {
          const box = document.querySelector("svg.hm-spark")?.getBoundingClientRect();
          if (box) scrollBy(0, box.bottom - (innerHeight - g));
        }, gap);
        const box = (await spark.boundingBox()) as Box;
        for (const at of [0.05, 0.5, 0.95]) {
          await page.mouse.move(box.x + box.width * at, box.y + box.height / 2);
          await expect.poll(() => tip.isVisible()).toBe(true);
          const t = (await tip.boundingBox()) as Box;
          const where = `gap ${gap}, at ${at}`;
          expect(t.x, where).toBeGreaterThanOrEqual(0);
          expect(t.y, where).toBeGreaterThanOrEqual(0);
          expect(t.x + t.width, where).toBeLessThanOrEqual(width);
          expect(t.y + t.height, where).toBeLessThanOrEqual(700);
          for (const selector of [".hm-kpi-value", ".hm-kpi-figure", ".hm-kpi-note"]) {
            const b = (await kpi.locator(selector).boundingBox()) as Box;
            const overlaps =
              t.x < b.x + b.width &&
              b.x < t.x + t.width &&
              t.y < b.y + b.height &&
              b.y < t.y + t.height;
            expect(overlaps, `${selector}, ${where}`).toBe(false);
          }
          expect(await kpi.locator(".hm-hover line").count()).toBe(3);
          await page.mouse.move(1, 1);
        }
      }
    });
  }

  it("announces keyboard steps through a polite live region, for charts and KPI sparklines", async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(url);
    const bar = page.locator(".hm-bar figure.hm-chart").first();
    await bar.locator("svg").filter({ visible: true }).focus();
    await page.keyboard.press("End");
    const live = bar.locator('[aria-live="polite"]');
    await expect.poll(() => live.textContent()).toContain("Brazil");
    expect(await bar.ariaSnapshot()).toContain("Brazil");
    const svgDescription = await bar
      .locator("svg")
      .filter({ visible: true })
      .evaluate(
        (svg) => document.getElementById(svg.getAttribute("aria-describedby") ?? "")?.textContent,
      );
    expect(svgDescription?.length).toBeGreaterThan(20);
    await page.goto(sparkUrl);
    await page.locator("svg.hm-spark").focus();
    await page.keyboard.press("End");
    const kpiLive = page.locator('.hm-kpi [aria-live="polite"]');
    await expect.poll(() => kpiLive.textContent()).toMatch(/^Oct 2026, Revenue \$[\d,]+$/);
    expect(await page.locator(".hm-kpi .hm-sr table tbody tr").count()).toBe(12);
  });

  for (const width of [320, 390]) {
    it(`never scrolls the page sideways at ${width} px, with every gallery block on it`, async () => {
      const page = await browser.newPage({ viewport: { width, height: 800 } });
      await page.goto(allUrl);
      const scroll = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(scroll).toBeLessThanOrEqual(width);
    });
  }

  it("titles the pinned readout and its values with one bucket, before and after hover", async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 800 } });
    await page.goto(gapUrl);
    const svg = page.locator(".hm-line svg").filter({ visible: true });
    const read = async () => [
      await svg.locator(".hm-rh").textContent(),
      await svg.locator(".hm-rv-0").textContent(),
      await svg.locator(".hm-rv-1").textContent(),
    ];
    expect(await read()).toEqual(["Feb 2026", "\u2014", "$30"]);
    const box = (await svg.boundingBox()) as Box;
    await page.mouse.move(box.x + 60, box.y + box.height - 40);
    await expect.poll(read).toEqual(["Jan 2026", "$10", "$20"]);
    await page.mouse.move(1, 1);
    await expect.poll(read).toEqual(["Feb 2026", "\u2014", "$30"]);
  });

  for (const width of [390, 1440]) {
    it(`maps the pointer at every plotted x to that day at ${width} px`, async () => {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      await page.goto(dailyUrl);
      const figure = page.locator("figure.hm-chart").first();
      const svg = figure.locator("svg").filter({ visible: true });
      const headers = JSON.parse((await figure.locator("script").textContent()) as string)
        .headers as string[];
      const d = (await svg.locator("path[stroke-width]").first().getAttribute("d")) as string;
      const xs = [...d.matchAll(/[ML]([\d.]+),/g)].map((m) => Number(m[1]));
      expect(xs).toHaveLength(headers.length);
      const box = (await svg.boundingBox()) as Box;
      const scale =
        box.width / Number(await svg.evaluate((s) => (s as SVGSVGElement).viewBox.baseVal.width));
      const plot = ((await svg.getAttribute("data-hm-plot")) as string).split(",").map(Number);
      const header = width < 600 ? svg.locator(".hm-rh") : figure.locator(".hm-tip-h");
      for (const i of [0, 1, xs.length - 2, xs.length - 1]) {
        await page.mouse.move(
          box.x + (xs[i] as number) * scale,
          box.y + ((plot[1] as number) + 4) * scale,
        );
        await expect.poll(() => header.textContent()).toBe(headers[i]);
      }
    });
  }

  it("draws a span-1 line 3 columns wide at 1024 px, with no text overlapping or leaving the chart", async () => {
    const page = await browser.newPage({ viewport: { width: 1024, height: 900 } });
    await page.goto(narrowUrl);
    const one = page.locator(".hm-card").nth(0);
    const three = page.locator(".hm-card").nth(1);
    const [a, b] = [(await one.boundingBox()) as Box, (await three.boundingBox()) as Box];
    expect(Math.abs(a.width - b.width)).toBeLessThanOrEqual(1);
    const problems = await one
      .locator("svg")
      .filter({ visible: true })
      .evaluate((svg) => {
        const frame = svg.getBoundingClientRect();
        const boxes = [...svg.querySelectorAll("text")]
          .filter((t) => (t.textContent ?? "") !== "")
          .map((t) => ({ text: t.textContent, r: t.getBoundingClientRect() }));
        const out: string[] = [];
        for (const { text, r } of boxes) {
          if (r.left < frame.left - 0.5 || r.right > frame.right + 0.5)
            out.push(`outside: ${text}`);
        }
        boxes.forEach((p, i) => {
          for (const q of boxes.slice(i + 1)) {
            const hit =
              p.r.left < q.r.right - 0.5 &&
              q.r.left < p.r.right - 0.5 &&
              p.r.top < q.r.bottom - 0.5 &&
              q.r.top < p.r.bottom - 0.5;
            if (hit) out.push(`overlap: ${p.text} / ${q.text}`);
          }
        });
        return out;
      });
    expect(problems).toEqual([]);
  });

  for (const width of [390, 1440]) {
    it(`keeps the plot the same height with 2 and with 8 long-named series at ${width} px`, async () => {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      await page.goto(densityUrl);
      const plots = await page
        .locator(".hm-card svg[data-hm-plot]")
        .evaluateAll((svgs: SVGSVGElement[]) =>
          svgs
            .filter((svg) => svg.getBoundingClientRect().width > 0)
            .map((svg) => {
              const [, top = 0, , bottom = 0] = (svg.getAttribute("data-hm-plot") ?? "")
                .split(",")
                .map(Number);
              const scale = svg.getBoundingClientRect().width / svg.viewBox.baseVal.width;
              return {
                plot: (bottom - top) * scale,
                key: svg.querySelectorAll(".hm-rv").length,
                svg: svg.getBoundingClientRect().height,
              };
            }),
        );
      expect(plots).toHaveLength(2);
      const [two, eight] = plots as [(typeof plots)[number], (typeof plots)[number]];
      expect(eight.key).toBe(8);
      expect(Math.abs(two.plot - eight.plot)).toBeLessThanOrEqual(0.5);
      expect(eight.svg).toBeGreaterThan(two.svg);
    });
  }

  for (const width of [390, 1440]) {
    it(`puts the period on its own line above the key, with every key row starting under it at ${width} px`, async () => {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      await page.goto(allUrl);
      const layouts = await page.locator(".hm-card svg[data-hm-readout]").evaluateAll((svgs) =>
        svgs
          .filter((svg) => svg.getBoundingClientRect().width > 0 && svg.querySelector(".hm-rh"))
          .map((svg) => {
            const period = (svg.querySelector(".hm-rh") as SVGTextElement).getBoundingClientRect();
            const rows = new Map<number, number>();
            for (const dot of svg.querySelectorAll(".hm-readout circle")) {
              const box = dot.getBoundingClientRect();
              const key = Math.round(box.top);
              rows.set(key, Math.min(rows.get(key) ?? Number.POSITIVE_INFINITY, box.left));
            }
            const tops = [...rows.keys()].sort((a, b) => a - b);
            return {
              periodLeft: period.left,
              periodBottom: period.bottom,
              firstTop: tops[0] ?? 0,
              rowLefts: tops.map((top) => rows.get(top) as number),
            };
          }),
      );
      expect(layouts.length).toBeGreaterThan(0);
      for (const layout of layouts) {
        expect(layout.firstTop).toBeGreaterThanOrEqual(layout.periodBottom - 0.5);
        for (const left of layout.rowLefts) {
          expect(Math.abs(left - layout.periodLeft)).toBeLessThanOrEqual(0.5);
        }
      }
    });
  }

  it("switches to dark with data-theme", async () => {
    const page = await browser.newPage();
    await page.goto(`${url}?theme=dark`);
    const background = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(background).toBe("rgb(17, 17, 17)");
  });
});

describe("grain switches", () => {
  const visibleGrain = (card: import("playwright").Locator) =>
    card.locator(".hm-grain-panel:not([hidden])").getAttribute("data-hm-grain");

  it("switch one card, or every card that lists the grain from the header filter", async () => {
    const data: DashboardData = {
      ...SALES,
      grainFilter: {
        id: "grain",
        label: "Grain",
        options: [
          { key: "week:monday", label: "Week" },
          { key: "month", label: "Month" },
          { key: "quarter:01-01", label: "Quarter" },
        ],
        selected: "month",
      },
      blocks: [
        revenueSwitch(MONTH),
        { ...QUARTER_BARS, grains: { ...(QUARTER_BARS.grains as GrainSwitch), selected: "month" } },
      ],
    };
    const file = path.join(dir, "grains.html");
    await writeFile(
      file,
      renderDashboardPage(data, { assets: { runtime: "hatchmark.js", fonts: {} } }),
    );
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(`file://${file}`);
    const line = page.locator("section[data-hm-grains]").nth(0);
    const bar = page.locator("section[data-hm-grains]").nth(1);
    expect(await visibleGrain(line)).toBe("month");
    expect(await line.locator("h2 span:not([hidden])").textContent()).toBe(
      "Revenue peaked in the holiday quarter",
    );

    await line.getByRole("radio", { name: "Week" }).click();
    expect(await visibleGrain(line)).toBe("week:monday");
    expect(await line.getByRole("radio", { name: "Week" }).getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(await visibleGrain(bar)).toBe("month");
    await expect
      .poll(() =>
        line.locator(".hm-grain-panel:not([hidden]) svg").filter({ visible: true }).count(),
      )
      .toBe(1);

    await page.keyboard.press("ArrowRight");
    expect(await visibleGrain(line)).toBe("month");
    expect(await page.evaluate(() => document.activeElement?.textContent)).toBe("Month");

    const filter = page.locator("[data-hm-grain-filter]");
    await filter.getByRole("radio", { name: "Quarter" }).click();
    expect(await visibleGrain(line)).toBe("quarter:01-01");
    expect(await visibleGrain(bar)).toBe("quarter:01-01");
    await filter.getByRole("radio", { name: "Week" }).click();
    expect(await visibleGrain(line)).toBe("week:monday");
    expect(await visibleGrain(bar)).toBe("quarter:01-01");
    expect(await filter.getByRole("radio", { name: "Week" }).getAttribute("aria-checked")).toBe(
      "true",
    );

    const svg = line.locator(".hm-grain-panel:not([hidden]) svg").filter({ visible: true });
    const box = (await svg.boundingBox()) as Box;
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
    const tip = line.locator(".hm-grain-panel:not([hidden]) .hm-tip");
    await expect.poll(() => tip.isVisible()).toBe(true);
    expect(await tip.locator(".hm-tip-h").textContent()).toMatch(/^Week of /);
  });

  it("wrap six anchored options inside the card and the page on phones", async () => {
    const labels = [
      "Quarter",
      "Quarter from Feb 1",
      "Quarter from Mar 1",
      "Year",
      "Year from Jul 1",
      "Year from Oct 1",
    ];
    const base = FISCAL_BARS.grains as GrainSwitch;
    const options = labels.map((label, i) => ({
      ...(base.options[i % 2] as GrainSwitch["options"][number]),
      key: `option_${i}`,
      label,
    }));
    const data: DashboardData = {
      ...SALES,
      grainFilter: {
        id: "grain",
        label: "Grain",
        options: options.map(({ key, label }) => ({ key, label })),
        selected: "option_0",
      },
      blocks: [{ ...FISCAL_BARS, span: 12, grains: { selected: "option_0", options } }],
    };
    const file = path.join(dir, "grains-wide.html");
    await writeFile(
      file,
      renderDashboardPage(data, { assets: { runtime: "hatchmark.js", fonts: {} } }),
    );
    for (const width of [320, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 800 } });
      await page.goto(`file://${file}`);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        width,
      );
      const card = (await page.locator("section[data-hm-grains]").boundingBox()) as Box;
      const seg = (await page
        .locator("section[data-hm-grains] [role=radiogroup]")
        .boundingBox()) as Box;
      expect(seg.x).toBeGreaterThanOrEqual(card.x);
      expect(seg.x + seg.width).toBeLessThanOrEqual(card.x + card.width);
      const filter = (await page.locator("[data-hm-grain-filter]").boundingBox()) as Box;
      expect(filter.x + filter.width).toBeLessThanOrEqual(width);
      await page.close();
    }
  });
});
