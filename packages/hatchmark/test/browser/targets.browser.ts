/// <reference lib="dom" />
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type Browser, chromium, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GALLERY } from "../../gallery/variants.js";
import { renderDashboardPage } from "../../src/render/index.js";
import { buildProject, removeProjects, writeExample } from "../node/fixture.js";
import { fromYaml, toYaml } from "../yaml.js";

const MONTHS = Array.from({ length: 26 }, (_, i) => {
  const d = new Date(Date.UTC(2024, 10 + i, 1));
  return d.toISOString().slice(0, 10);
});
const PLAN = Object.fromEntries(MONTHS.map((m, i) => [m, 15_000 + 400 * (i % 6)]));

const GOALS = {
  title: "Goals",
  period: { asOf: "latest_data", range: "last_12_months", compare: "previous_period" },
  filters: [
    {
      type: "period",
      id: "period",
      options: [{ last: 30, unit: "day" }, { to_date: "month" }, { last: 12, unit: "month" }],
      default: { last: 12, unit: "month" },
    },
    { type: "segment", id: "segments", segments: ["americas"] },
  ],
  blocks: [
    { type: "kpi", id: "revenue", metric: "revenue", target: "plan" },
    { type: "kpi", id: "orders", metric: "orders" },
    {
      type: "line",
      id: "trend",
      title: "Revenue against plan",
      metrics: ["revenue"],
      grain: "month",
      grains: ["week", "month"],
      target: "plan",
      span: 8,
    },
    {
      type: "bar",
      id: "channels",
      title: "Revenue by channel",
      metrics: ["revenue"],
      by: "channel",
      target: "plan",
      span: 4,
    },
  ],
};

let browser: Browser;
let root: string;
let gallery: string;

beforeAll(async () => {
  root = await writeExample({}, { goals: GOALS });
  const metricFile = path.join(root, "metrics", "revenue.yaml");
  const revenue = fromYaml(await readFile(metricFile, "utf8")) as Record<string, unknown>;
  await writeFile(
    metricFile,
    toYaml({
      ...revenue,
      targets: [{ id: "plan", label: "FY plan", grain: "month", values: PLAN }],
    }),
  );
  await mkdir(path.join(root, "segments"));
  await writeFile(
    path.join(root, "segments", "americas.yaml"),
    toYaml({ label: "Americas", filters: [{ column: "region", op: "eq", value: "Americas" }] }),
  );
  expect((await buildProject(root)).code).toBe(0);
  gallery = await mkdtemp(path.join(tmpdir(), "hatchmark-targets-"));
  await cp(
    new URL("../../assets/runtime/hatchmark.js", import.meta.url),
    path.join(gallery, "hatchmark.js"),
  );
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
  await removeProjects();
  if (gallery) await rm(gallery, { recursive: true, force: true });
});

async function open(query = "", width = 1280): Promise<{ page: Page; errors: string[] }> {
  const page = await browser.newPage({ viewport: { width, height: 1000 } });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`file://${path.join(root, "dist", "goals", "index.html")}${query}`);
  await settled(page);
  return { page, errors };
}

const settled = (page: Page) =>
  page.waitForFunction(() => !document.querySelector("main.hm-grid")?.hasAttribute("aria-busy"));

const card = (page: Page, id: string) =>
  page.locator(`section[aria-labelledby^="hm-${id}"]`).first();

async function state(page: Page) {
  const kpi = page.locator(".hm-kpi", { hasText: "Revenue" }).first();
  const trend = card(page, "trend");
  const panel = trend.locator(".hm-grain-panel:not([hidden])");
  const svg = panel.locator("svg[data-hm-kind]").filter({ visible: true });
  return {
    kpi: await kpi.locator(".hm-kt").getAttribute("data-hm-t"),
    kpiText: (await kpi.locator(".hm-kt").textContent()) ?? "",
    kpiHeight: await kpi.evaluate((e) => e.getBoundingClientRect().height),
    ktHeight: await kpi.locator(".hm-kt").evaluate((e) => e.getBoundingClientRect().height),
    grain: await panel.getAttribute("data-hm-grain"),
    path: await svg
      .locator("path.hm-target")
      .first()
      .getAttribute("d", { timeout: 1000 })
      .catch(() => null),
    key: (await svg.locator(".hm-tkey").textContent()) ?? "",
    ticks: await card(page, "channels")
      .locator("svg[data-hm-kind]")
      .filter({ visible: true })
      .locator(".hm-target")
      .count(),
  };
}

describe("targets follow every runtime update", () => {
  it("draws the target on load, and shows target, pace and attainment in the tooltip", async () => {
    const { page, errors } = await open();
    const s = await state(page);
    expect(s.kpi).toMatch(/^(ahead|behind)$/);
    expect(s.kpiText).toMatch(/\d+% of (target|pace)/);
    expect(s.path).toMatch(/^M/);
    expect(s.key).toContain("FY plan");
    const svg = card(page, "trend")
      .locator(".hm-grain-panel:not([hidden]) svg[data-hm-kind]")
      .filter({ visible: true });
    await svg.focus();
    await page.keyboard.press("End");
    const tip = page.locator(".hm-tip").filter({ visible: true });
    await expect.poll(() => tip.locator(".hm-tip-tg").count()).toBe(1);
    expect(await tip.textContent()).toMatch(/FY plan\s*\$[\d,.]+K?/);
    expect(await tip.textContent()).toMatch(/Attained\s*\d+%/);
    expect(errors).toEqual([]);
    await page.close();
  });

  it("redraws the target on a grain switch", async () => {
    const { page, errors } = await open();
    const before = await state(page);
    await card(page, "trend").locator('.hm-seg button[data-hm-grain^="week"]').click();
    const after = await state(page);
    expect(after.grain).toMatch(/^week/);
    expect(after.path).toMatch(/^M/);
    expect(after.path).not.toBe(before.path);
    expect(errors).toEqual([]);
    await page.close();
  });

  it("redraws the targets on a period preset and keeps the KPI card's height", async () => {
    const { page, errors } = await open();
    const before = await state(page);
    await page.locator(".hm-period-button").click();
    await page.locator("[data-hm-preset=month_to_date]").click();
    await settled(page);
    const after = await state(page);
    expect(after.kpiText).not.toBe(before.kpiText);
    expect(after.kpi).not.toBe("none");
    expect(after.path).not.toBe(before.path);
    expect(after.ktHeight).toBe(before.ktHeight);
    expect(errors).toEqual([]);
    await page.close();
  });

  it("carries the targets into a custom range", async () => {
    const { page, errors } = await open("?period=2026-03-01..2026-08-31");
    const s = await state(page);
    expect(s.kpi).toMatch(/^(ahead|behind)$/);
    expect(s.path).toMatch(/^M/);
    expect(s.ticks).toBeGreaterThan(0);
    expect(errors).toEqual([]);
    await page.close();
  });

  it("hides the target while a segment it can't follow is on, then brings it back", async () => {
    const { page, errors } = await open();
    const before = await state(page);
    await page.locator('[data-hm-segment="americas"]').click();
    await settled(page);
    const on = await state(page);
    expect(on.kpi).toBe("none");
    expect(on.kpiText).toContain("FY plan hidden");
    expect(on.path).toBeNull();
    expect(on.key).toContain("FY plan hidden: a segment is on");
    expect(on.ticks).toBe(0);
    expect(on.ktHeight).toBe(before.ktHeight);
    expect(on.kpiHeight).toBe(before.kpiHeight);
    await page.locator('[data-hm-segment="americas"]').click();
    await settled(page);
    const off = await state(page);
    expect(off.kpi).toBe(before.kpi);
    expect(off.path).toBe(before.path);
    expect(errors).toEqual([]);
    await page.close();
  });
});

const TARGET_VARIANTS = GALLERY.filter((v) => v.variant.startsWith("target-"));

async function galleryPage(
  variant: (typeof TARGET_VARIANTS)[number],
  width: number,
  theme: string,
) {
  const file = path.join(gallery, `${variant.variant}.html`);
  await writeFile(
    file,
    renderDashboardPage(variant.data, { assets: { runtime: "hatchmark.js", fonts: {} } }),
  );
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  await page.goto(`file://${file}`);
  await page.evaluate((t) => {
    document.documentElement.dataset.theme = t;
  }, theme);
  return page;
}

describe("target gallery variants", () => {
  it("lines up every KPI card in a row, whatever its target state", async () => {
    for (const name of ["target-kpi-states", "target-kpi-edges"]) {
      const variant = TARGET_VARIANTS.find((v) => v.variant === name);
      if (!variant) throw new Error(`no ${name}`);
      const page = await galleryPage(variant, 1440, "light");
      const heights = await page
        .locator(".hm-kt")
        .evaluateAll((nodes) => nodes.map((n) => Math.round(n.getBoundingClientRect().height)));
      expect(heights.length).toBeGreaterThan(3);
      expect(new Set(heights).size).toBe(1);
      await page.close();
    }
  });

  for (const theme of ["light", "dark"]) {
    it.each(TARGET_VARIANTS.map((v) => v.variant))(
      `fits a 390 px phone without overflow, ${theme} (%s)`,
      async (name) => {
        const variant = TARGET_VARIANTS.find((v) => v.variant === name);
        if (!variant) throw new Error(`no ${name}`);
        const page = await galleryPage(variant, 390, theme);
        const report = await page.evaluate(() => {
          const doc = document.documentElement;
          const outside: string[] = [];
          for (const card of document.querySelectorAll<HTMLElement>(".hm-card, .hm-kpi")) {
            const box = card.getBoundingClientRect();
            for (const el of card.querySelectorAll<HTMLElement>(
              ".hm-kt, .hm-kt-row, .hm-kt-note, svg",
            )) {
              const r = el.getBoundingClientRect();
              if (r.width > 0 && (r.left < box.left - 0.5 || r.right > box.right + 0.5)) {
                outside.push(el.className.toString() || el.tagName);
              }
            }
          }
          const target = document.querySelector(".hm-target");
          const card = document.querySelector(".hm-card, .hm-kpi");
          return {
            scroll: doc.scrollWidth - doc.clientWidth,
            outside,
            stroke: target ? getComputedStyle(target).stroke : null,
            card: card ? getComputedStyle(card).backgroundColor : null,
          };
        });
        expect(report.scroll).toBe(0);
        expect(report.outside).toEqual([]);
        if (report.stroke !== null) expect(report.stroke).not.toBe(report.card);
        await page.close();
      },
    );
  }
});
