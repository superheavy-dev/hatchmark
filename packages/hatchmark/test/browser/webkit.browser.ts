/// <reference lib="dom" />
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type Browser, webkit } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SALES } from "../../gallery/fixtures.js";
import { FONT_FILES, renderDashboardPage } from "../../src/render/index.js";

/** Keyboard reach in WebKit, which skips scroll containers that are not explicit tab stops. */
let browser: Browser;
let dir: string;
let url: string;

beforeAll(async () => {
  browser = await webkit.launch();
  dir = await mkdtemp(path.join(tmpdir(), "hatchmark-webkit-"));
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
});

afterAll(async () => {
  await browser?.close();
  await rm(dir, { recursive: true, force: true });
});

describe("WebKit keyboard", () => {
  it("reaches every column of the clipped table at 390 px with Tab and the arrow keys", async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 800 } });
    await page.goto(url);
    const wrap = page.locator(".hm-table-wrap").first();
    const last = wrap.locator("thead th").last();
    const clipped = await wrap.evaluate((w) => w.scrollWidth > w.clientWidth);
    expect(clipped).toBe(true);
    await page.locator(".hm-bar svg").filter({ visible: true }).focus();
    await page.keyboard.press("Tab");
    expect(await wrap.evaluate((w) => w === document.activeElement)).toBe(true);
    expect(await wrap.getAttribute("role")).toBe("region");
    expect(await wrap.evaluate((w) => w.getAttribute("aria-labelledby"))).toMatch(/-t$/);
    for (let i = 0; i < 40; i++) await page.keyboard.press("ArrowRight");
    const inside = await wrap.evaluate((w) => {
      const th = w.querySelectorAll("thead th");
      const cell = th[th.length - 1]?.getBoundingClientRect();
      const box = w.getBoundingClientRect();
      return cell !== undefined && cell.left >= box.left - 1 && cell.right <= box.right + 1;
    });
    expect(inside).toBe(true);
    expect(await last.textContent()).toBeTruthy();
  });
});
