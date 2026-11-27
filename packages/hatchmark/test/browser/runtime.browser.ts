/// <reference lib="dom" />
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SALES } from "../../gallery/fixtures.js";
import { GALLERY } from "../../gallery/variants.js";
import { FONT_FILES, renderDashboardPage } from "../../src/render/index.js";

/** The browser runtime on the sample dashboard: tooltip, crosshair, readout and keyboard. */
let browser: Browser;
let dir: string;
let url: string;
let sparkUrl: string;

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

  it("shows the KPI sparkline tooltip above the point on hover and with arrow keys", async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(sparkUrl);
    const kpi = page.locator(".hm-kpi[data-hm-chart]").first();
    const spark = kpi.locator("svg.hm-spark");
    const box = (await spark.boundingBox()) as { x: number; y: number; width: number };
    await page.mouse.move(box.x + box.width * 0.5, box.y + 4);
    const tip = kpi.locator(".hm-tip");
    await expect.poll(() => tip.isVisible()).toBe(true);
    expect(await tip.locator(".hm-tip-h").textContent()).toMatch(/^\w{3} 20\d\d$/);
    expect(await kpi.locator(".hm-hover line").count()).toBe(3);
    const tipBox = (await tip.boundingBox()) as { y: number; height: number };
    const dot = (await kpi.locator(".hm-hover .hm-dot").first().boundingBox()) as { y: number };
    expect(tipBox.y + tipBox.height).toBeLessThanOrEqual(dot.y);
    await page.mouse.move(5, 5);
    await expect.poll(() => tip.isVisible()).toBe(false);
    await spark.focus();
    await page.keyboard.press("End");
    const last = await tip.locator(".hm-tip-h").textContent();
    await page.keyboard.press("ArrowLeft");
    expect(await tip.locator(".hm-tip-h").textContent()).not.toBe(last);
    expect(await tip.locator(".hm-tip-v").textContent()).toMatch(/^\$[\d,]+$/);
  });

  it("switches to dark with data-theme", async () => {
    const page = await browser.newPage();
    await page.goto(`${url}?theme=dark`);
    const background = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(background).toBe("rgb(17, 17, 17)");
  });
});
