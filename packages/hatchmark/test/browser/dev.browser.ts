/// <reference lib="dom" />
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, chromium, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type DevServer, startDevServer } from "../../src/dev/server.js";

/**
 * hatchmark dev in a real browser: a card swapped in over HMR is interactive again, and the error
 * overlay renders over the page. HATCHMARK_DEV_SCREENSHOTS=<dir> saves the overlay in light and dark.
 */
const EXAMPLE = fileURLToPath(new URL("../../examples/global-sales/", import.meta.url));
let browser: Browser;
let dir: string;
let server: DevServer;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "hatchmark-dev-browser-"));
  await cp(EXAMPLE, dir, {
    recursive: true,
    filter: (src) => !src.split(path.sep).includes("dist"),
  });
  const started = await startDevServer({ root: dir, port: 0, log: () => {} });
  if ("report" in started) throw new Error(JSON.stringify(started.report));
  server = started.server;
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
  await server?.close();
  await rm(dir, { recursive: true, force: true });
});

const edit = async (file: string, change: (text: string) => string) => {
  const at = path.join(dir, file);
  await writeFile(at, change(await readFile(at, "utf8")));
};

/** Opens the sales dashboard and waits until the Vite client is connected for HMR. */
async function open(page: Page): Promise<void> {
  const connected = page.waitForEvent("console", (m) => m.text().includes("[vite] connected"));
  await page.goto(new URL("/sales/", server.url).href);
  await connected;
}

describe("hatchmark dev in the browser", () => {
  it("swaps a changed card in place and its tooltip works after the swap", async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await open(page);
    await page.evaluate(() => {
      (window as unknown as { hmMarker: boolean }).hmMarker = true;
    });
    await edit("dashboards/sales.json", (t) =>
      t.replace('"Revenue by channel"', '"Revenue by sales channel"'),
    );
    const title = page.locator(".hm-bar h2");
    await expect
      .poll(() => title.textContent(), { timeout: 15_000 })
      .toBe("Revenue by sales channel");
    expect(await page.evaluate(() => (window as unknown as { hmMarker?: boolean }).hmMarker)).toBe(
      true,
    );
    const svg = page.locator(".hm-bar svg").filter({ visible: true });
    const box = (await svg.boundingBox()) as {
      x: number;
      y: number;
      width: number;
      height: number;
    };
    await page.mouse.move(box.x + box.width * 0.5, box.y + 30);
    const tip = page.locator(".hm-bar .hm-tip");
    await expect.poll(() => tip.isVisible()).toBe(true);
    expect(await tip.textContent()).toMatch(/\$/);
    await page.close();
  });

  it("lays the error overlay over the page and clears it on the next good build", async () => {
    const shots = process.env.HATCHMARK_DEV_SCREENSHOTS;
    const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
    await open(page);
    const good = await readFile(path.join(dir, "dashboards/sales.json"), "utf8");
    await edit("dashboards/sales.json", (t) =>
      t.replace('"metric": "orders"', '"metric": "orderz"'),
    );
    const overlay = page.locator("#hm-dev-overlay");
    await expect.poll(() => overlay.isVisible(), { timeout: 15_000 }).toBe(true);
    expect(await overlay.locator("pre").textContent()).toContain("error[HM2003]");
    const color = await overlay
      .locator(".hm-dx-error")
      .first()
      .evaluate((node) => getComputedStyle(node).color);
    const bad = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue("--hm-bad").trim(),
    );
    expect(color).toBe(hexToRgb(bad));
    if (shots) {
      await mkdir(shots, { recursive: true });
      await page.screenshot({ path: path.join(shots, "overlay-light.png") });
      await page.evaluate(() => {
        document.documentElement.dataset.theme = "dark";
      });
      await page.screenshot({ path: path.join(shots, "overlay-dark.png") });
    }
    await writeFile(path.join(dir, "dashboards/sales.json"), good);
    await expect.poll(() => overlay.count(), { timeout: 15_000 }).toBe(0);
    await page.close();
  });
});

function hexToRgb(hex: string): string {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}
