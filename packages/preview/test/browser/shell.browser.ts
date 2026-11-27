/// <reference lib="dom" />
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { type Browser, chromium, type Frame, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { renderSite } from "../../src/page.js";

const tall = (component: string) => ({
  component,
  variant: "plain",
  title: "Plain",
  html: `<div style="height: 1600px">${component}</div>`,
});
let browser: Browser;
let dir: string;
let server: Server;
let origin: string;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "hatchmark-preview-shell-"));
  const site = renderSite({
    entries: [tall("alpha"), tall("pie"), tall("omega")],
    head: "",
    build: { pr: 12, sha: "1a5224b64c0ffee0000000000000000000000000" },
  });
  for (const [file, html] of site) {
    await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
    await writeFile(path.join(dir, file), html);
  }
  server = createServer(async (req, res) => {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    try {
      const body = await readFile(
        path.join(dir, pathname.endsWith("/") ? `${pathname}index.html` : pathname),
      );
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
  await new Promise((resolve) => server?.close(resolve));
  await rm(dir, { recursive: true, force: true });
});

const hash = (page: Page) =>
  Object.fromEntries(new URLSearchParams(new URL(page.url()).hash.slice(1)));
const gallery = (page: Page) => page.frameLocator("#frame");
const shownPath = (page: Page) =>
  page
    .locator("#frame")
    .evaluate((frame: HTMLIFrameElement) => frame.contentWindow?.location.pathname);

async function sectionTop(page: Page, id: string): Promise<number> {
  const frame = page.frame({ url: /\/components\// }) as Frame;
  return frame.evaluate((target) => {
    const el = document.getElementById(target);
    return el ? Math.round(el.getBoundingClientRect().top) : Number.NaN;
  }, id);
}

function countNavigations(page: Page): () => number {
  let count = 0;
  page.on("request", (request) => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) count++;
  });
  return () => count;
}

describe("preview shell deep links", () => {
  it("frames the section from its hash and keeps it when the toolbar changes", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(`${origin}/#section=pie&theme=dark&width=mobile`);
    await expect.poll(() => page.locator("#frame").getAttribute("src")).toBe("components/#pie");
    await expect.poll(() => sectionTop(page, "pie")).toBeLessThan(2);
    expect(await sectionTop(page, "pie")).toBeGreaterThan(-2);
    expect(await page.locator("body").getAttribute("data-width")).toBe("mobile");
    expect(await gallery(page).locator("html").getAttribute("data-theme")).toBe("dark");

    await page.getByRole("button", { name: "Light" }).click();
    await page.getByRole("button", { name: "Desktop" }).click();
    expect(hash(page)).toEqual({
      view: "components",
      theme: "light",
      width: "desktop",
      section: "pie",
    });
    expect(await gallery(page).locator("html").getAttribute("data-theme")).toBe("light");
    expect(await sectionTop(page, "pie")).toBeLessThan(2);

    await gallery(page).getByRole("link", { name: "omega" }).click();
    await expect.poll(() => hash(page).section).toBe("omega");
    await page.getByRole("button", { name: "Dark" }).click();
    expect(hash(page)).toMatchObject({ theme: "dark", section: "omega" });
    await expect.poll(() => sectionTop(page, "omega")).toBeLessThan(2);
    await page.close();
  });

  it("switches the example dashboard's locale and leaves en-US out of the hash", async () => {
    const page = await browser.newPage();
    await page.goto(`${origin}/#view=dashboard&locale=de-DE`);
    await expect
      .poll(() => page.locator("#frame").getAttribute("src"))
      .toBe("dashboard-de-DE/sales/");
    await page.getByRole("button", { name: "ja-JP" }).click();
    expect(await page.locator("#frame").getAttribute("src")).toBe("dashboard-ja-JP/sales/");
    await page.getByRole("button", { name: "Date range picker" }).click();
    expect(await page.locator("#frame").getAttribute("src")).toBe("dashboard-ja-JP/explorer/");
    await page.getByRole("button", { name: "Picker variants" }).click();
    expect(await page.locator("#frame").getAttribute("src")).toBe("periods/");
    await page.getByRole("button", { name: "en-US" }).click();
    await page.getByRole("button", { name: "Example dashboard" }).click();
    expect(await page.locator("#frame").getAttribute("src")).toBe("dashboard/sales/");
    expect(hash(page)).not.toHaveProperty("locale");
    await page.close();
  });

  it("keeps the toolbar on the page the frame shows after Back", async () => {
    const page = await browser.newPage();
    await page.goto(`${origin}/#view=dashboard&locale=de-DE`);
    await expect.poll(() => shownPath(page)).toBe("/dashboard-de-DE/sales/");
    await page.getByRole("button", { name: "ja-JP" }).click();
    await expect.poll(() => shownPath(page)).toBe("/dashboard-ja-JP/sales/");
    await page.getByRole("button", { name: "Date range picker" }).click();
    await expect.poll(() => shownPath(page)).toBe("/dashboard-ja-JP/explorer/");
    await page.evaluate(() => history.back());
    await expect.poll(() => shownPath(page)).toBe("/dashboard-ja-JP/sales/");
    await expect.poll(() => hash(page)).toMatchObject({ view: "dashboard", locale: "ja-JP" });
    await page.evaluate(() => history.back());
    await expect.poll(() => shownPath(page)).toBe("/dashboard-de-DE/sales/");
    await expect.poll(() => hash(page)).toMatchObject({ view: "dashboard", locale: "de-DE" });
    expect(await page.getByRole("button", { name: "de-DE" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(
      await page.getByRole("button", { name: "Example dashboard" }).getAttribute("aria-pressed"),
    ).toBe("true");
    await page.close();
  });

  it("reads the locale from every hash change and ignores locales it did not build", async () => {
    const page = await browser.newPage();
    await page.goto(`${origin}/#view=dashboard&locale=de-DE`);
    await expect
      .poll(() => page.locator("#frame").getAttribute("src"))
      .toBe("dashboard-de-DE/sales/");
    await page.evaluate(() => {
      location.hash = "#view=dashboard";
    });
    await expect.poll(() => page.locator("#frame").getAttribute("src")).toBe("dashboard/sales/");
    expect(hash(page)).not.toHaveProperty("locale");
    expect(await page.getByRole("button", { name: "en-US" }).getAttribute("aria-pressed")).toBe(
      "true",
    );

    await page.goto(`${origin}/#view=dashboard&locale=fr-FR`);
    await expect.poll(() => "locale" in hash(page)).toBe(false);
    expect(await page.locator("#frame").getAttribute("src")).toBe("dashboard/sales/");
    expect(await page.getByRole("button", { name: "en-US" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    await page.close();
  });

  it("leaves the section out of the hash when there is none", async () => {
    const page = await browser.newPage();
    await page.goto(`${origin}/#theme=light`);
    await expect
      .poll(() => hash(page))
      .toEqual({ view: "components", theme: "light", width: "desktop" });
    expect(await page.locator("#frame").getAttribute("src")).toBe("components/");
    await page.close();
  });

  it("sends a gallery opened on its own to the shell with the same section", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const navigations = countNavigations(page);
    await page.goto(`${origin}/components/#pie`);
    await page.waitForURL(`${origin}/#*`);
    expect(hash(page)).toMatchObject({ view: "components", section: "pie" });
    await expect.poll(() => page.locator("#frame").getAttribute("src")).toBe("components/#pie");
    await expect.poll(() => sectionTop(page, "pie")).toBeLessThan(2);
    await page.waitForTimeout(500);
    expect(navigations()).toBe(2);
    expect(new URL(page.url()).pathname).toBe("/");
    await page.close();
  });

  it("carries the gallery's query string through the redirect into the frame", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(`${origin}/components/?scroll=thin#pie`);
    await page.waitForURL(`${origin}/?scroll=thin#*`);
    expect(hash(page)).toMatchObject({ section: "pie" });
    await expect
      .poll(() => page.locator("#frame").getAttribute("src"))
      .toBe("components/?scroll=thin#pie");
    const frame = page.frame({ url: /\/components\// }) as Frame;
    expect(await frame.evaluate(() => location.search)).toBe("?scroll=thin");
    await page.getByRole("button", { name: "Dark" }).click();
    expect(new URL(page.url()).search).toBe("?scroll=thin");
    expect(await page.locator("#frame").getAttribute("src")).toBe("components/?scroll=thin#pie");
    await page.getByRole("button", { name: "Example dashboard" }).click();
    expect(await page.locator("#frame").getAttribute("src")).toBe("dashboard/sales/?scroll=thin");
    await page.close();
  });

  it("sends the bare gallery to the shell without a section", async () => {
    const page = await browser.newPage();
    const navigations = countNavigations(page);
    await page.goto(`${origin}/components/`);
    await page.waitForURL(`${origin}/#*`);
    expect(hash(page).section).toBeUndefined();
    expect(await page.locator("#frame").getAttribute("src")).toBe("components/");
    await page.waitForTimeout(500);
    expect(navigations()).toBe(2);
    await page.close();
  });
});
