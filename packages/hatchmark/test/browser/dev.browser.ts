/// <reference lib="dom" />
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
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
  const started = await startDevServer({ root: dir, port: 0, host: "127.0.0.1", log: () => {} });
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
async function open(page: Page, dashboard = "sales"): Promise<void> {
  const connected = page.waitForEvent("console", (m) => m.text().includes("[vite] connected"));
  await page.goto(new URL(`/${dashboard}/`, server.url).href);
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

  it("keeps the reader's grain on a swapped card", async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await open(page, "trends");
    await page.locator("[data-hm-grain-filter] button[data-hm-grain='quarter:01-01']").click();
    const orders = page.locator(".hm-bar");
    await orders.locator(".hm-seg button[data-hm-grain=month]").click();
    await edit("dashboards/trends.json", (t) =>
      t.replace('"Revenue by region"', '"Regional revenue"').replace('"Orders"', '"Paid orders"'),
    );
    const line = page.locator(".hm-line").first();
    await expect
      .poll(() => line.locator("h2 span:not([hidden])").textContent(), { timeout: 15_000 })
      .toContain("Regional revenue");
    await expect
      .poll(() => orders.locator("h2 span:not([hidden])").textContent())
      .toContain("Paid orders");
    const selected = (card: typeof line) =>
      card.locator(".hm-seg button[aria-checked=true]").getAttribute("data-hm-grain");
    expect(await selected(line)).toBe("quarter:01-01");
    expect(await selected(orders)).toBe("month");
    expect(await line.locator(".hm-grain-panel:not([hidden])").getAttribute("data-hm-grain")).toBe(
      "quarter:01-01",
    );
    expect(await selected(page.locator(".hm-area"))).toBe("month");
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

/** A dev server of its own on a fresh copy of the example; change edits the copy before it starts. */
async function ownServer(change?: (dir: string) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), "hatchmark-dev-routes-"));
  await cp(EXAMPLE, root, {
    recursive: true,
    filter: (src) => !src.split(path.sep).includes("dist"),
  });
  await change?.(root);
  const started = await startDevServer({ root, port: 0, host: "127.0.0.1", log: () => {} });
  if ("report" in started) throw new Error(JSON.stringify(started.report));
  return {
    root,
    server: started.server,
    close: async () => {
      await started.server.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

const connected = (page: Page) =>
  page.waitForEvent("console", {
    predicate: (m) => m.text().includes("[vite] connected"),
    timeout: 15_000,
  });

/** The tab comes back by itself to the live dashboard, and a later edit swaps in over HMR. */
async function expectLiveAgain(page: Page, root: string, restore: () => Promise<void>) {
  const reconnected = connected(page);
  await restore();
  await expect
    .poll(() => page.locator("h1").textContent(), { timeout: 15_000 })
    .toBe("Global sales");
  await reconnected;
  await page.evaluate(() => {
    (window as unknown as { hmMarker: boolean }).hmMarker = true;
  });
  const file = path.join(root, "dashboards/sales.json");
  await writeFile(
    file,
    (await readFile(file, "utf8")).replace('"Revenue by channel"', '"Channel revenue"'),
  );
  await expect
    .poll(() => page.locator(".hm-bar h2").textContent(), { timeout: 15_000 })
    .toBe("Channel revenue");
  expect(await page.evaluate(() => (window as unknown as { hmMarker?: boolean }).hmMarker)).toBe(
    true,
  );
}

describe("an open dev tab whose dashboard comes and goes", () => {
  it("shows a tab whose first build failed that its file was removed, then the live page", async () => {
    const own = await ownServer(async (root) => {
      const file = path.join(root, "dashboards/sales.json");
      await writeFile(
        file,
        (await readFile(file, "utf8")).replace('"metric": "orders"', '"metric": "orderz"'),
      );
    });
    const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
    try {
      const ready = connected(page);
      await page.goto(new URL("/sales/", own.server.url).href);
      await ready;
      expect(await page.locator("h1").textContent()).toBe("Waiting for a good build");
      expect(await page.locator("#hm-dev-overlay").isVisible()).toBe(true);
      const good = await readFile(path.join(EXAMPLE, "dashboards/sales.json"), "utf8");
      const removed = connected(page);
      await rm(path.join(own.root, "dashboards/sales.json"));
      await expect
        .poll(() => page.locator("h1").textContent(), { timeout: 15_000 })
        .toBe("Dashboard removed");
      await removed;
      expect(await page.locator("#hm-dev-overlay").count()).toBe(0);
      await expectLiveAgain(page, own.root, () =>
        writeFile(path.join(own.root, "dashboards/sales.json"), good),
      );
    } finally {
      await page.close();
      await own.close();
    }
  });

  it("shows a live tab that its file was moved away, then reloads it when the file is back", async () => {
    const own = await ownServer();
    const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
    try {
      const ready = connected(page);
      await page.goto(new URL("/sales/", own.server.url).href);
      await ready;
      expect(await page.locator("h1").textContent()).toBe("Global sales");
      const file = path.join(own.root, "dashboards/sales.json");
      const hold = path.join(own.root, "sales.hold");
      const removed = connected(page);
      await rename(file, hold);
      await expect
        .poll(() => page.locator("h1").textContent(), { timeout: 15_000 })
        .toBe("Dashboard removed");
      await removed;
      await expectLiveAgain(page, own.root, () => rename(hold, file));
    } finally {
      await page.close();
      await own.close();
    }
  });
});
