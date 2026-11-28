/// <reference lib="dom" />
import { fileURLToPath } from "node:url";
import { type Browser, chromium, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GALLERY } from "../../gallery/variants.js";
import type { DashboardData, MapData } from "../../src/compiler/dashboard-data.js";
import { usedGeographies } from "../../src/geo/index.js";
import { DEFAULT_THEME, pageStyles, renderFragment } from "../../src/render/index.js";

const RUNTIME = fileURLToPath(new URL("../../assets/runtime/hatchmark.js", import.meta.url));

function variant(name: string) {
  const v = GALLERY.find((g) => g.variant === name);
  if (v === undefined) throw new Error(`gallery variant ${name} missing`);
  return v.data;
}

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser.close();
});

async function open(
  name: string,
  width: number,
  touch = false,
  edit: (block: MapData) => MapData = (block) => block,
): Promise<Page> {
  const original = variant(name);
  const data: DashboardData = {
    ...original,
    blocks: original.blocks.map((b) => (b.type === "map" ? edit(b) : b)),
  };
  const page = await browser.newPage({
    viewport: { width, height: 1000 },
    hasTouch: touch,
    isMobile: touch,
  });
  const styles = pageStyles({ runtime: "", fonts: {} }, DEFAULT_THEME, { maps: true, tiles: true });
  await page.setContent(
    `<!doctype html><html><head><style>${styles}</style></head><body>${renderFragment(data, DEFAULT_THEME, usedGeographies(data.blocks))}</body></html>`,
  );
  await page.addScriptTag({ path: RUNTIME });
  return page;
}

const box = async (page: Page, selector: string) => {
  const b = await page.locator(selector).boundingBox();
  if (b === null) throw new Error(`${selector} has no box`);
  return b;
};

describe("map in a browser", () => {
  it("links hovering a region to its tooltip, outline and bar list row", async () => {
    const page = await open("map-us-rate", 1440);
    const tx = await box(page, 'svg[data-hm-kind=map] [data-hm-r="TX"]');
    await page.mouse.move(tx.x + tx.width / 2, tx.y + tx.height / 2);
    expect(await page.locator(".hm-tip-h").textContent()).toBe("Texas");
    expect(await page.locator(".hm-map-list li.hm-on").getAttribute("data-hm-r")).toBe("TX");
    expect(await page.locator(".hm-hover path").count()).toBe(2);
    await page.close();
  });

  it("links a bar list row and a leader label back to the map", async () => {
    const page = await open("map-us-rate", 1440);
    const ma = await box(page, '.hm-map-labels [data-hm-r="MA"] text >> visible=true');
    await page.mouse.move(ma.x + ma.width / 2, ma.y + ma.height / 2);
    expect(await page.locator(".hm-map-list li.hm-on").getAttribute("data-hm-r")).toBe("MA");
    const row = page.locator('.hm-map-list li[data-hm-r="CA"]');
    await row.scrollIntoViewIfNeeded();
    const b = await box(page, '.hm-map-list li[data-hm-r="CA"]');
    await page.mouse.move(b.x + 30, b.y + b.height / 2);
    expect(await page.locator(".hm-hover path").first().getAttribute("d")).toBe(
      await page.locator('svg[data-hm-kind=map] [data-hm-r="CA"]').getAttribute("d"),
    );
    await page.close();
  });

  it("steps through regions in rank order from the keyboard", async () => {
    const page = await open("map-us-rate", 1440);
    const first = await page.locator(".hm-map-list li").first().getAttribute("data-hm-r");
    await page.locator("svg[data-hm-kind=map]").focus();
    await page.keyboard.press("ArrowDown");
    expect(await page.locator(".hm-map-list li.hm-on").getAttribute("data-hm-r")).toBe(first);
    expect(await page.locator(".hm-map .hm-sr[aria-live]").textContent()).toContain("#1 of");
    await page.close();
  });

  it("opens the tooltip on a tap at 390 px", async () => {
    const page = await open("map-us-rate", 390, true);
    const tx = await box(page, 'svg[data-hm-kind=map] [data-hm-r="TX"]');
    await page.touchscreen.tap(tx.x + tx.width / 2, tx.y + tx.height / 2);
    expect(await page.locator(".hm-tip-h").textContent()).toBe("Texas");
    expect(await page.locator(".hm-hover path").count()).toBe(2);
    await page.close();
  });

  it("opens the tooltip and highlights the region on a bar list tap at 390 px", async () => {
    const page = await open("map-us-rate", 390, true);
    const row = page.locator('.hm-map-list li[data-hm-r="TX"]');
    await row.scrollIntoViewIfNeeded();
    const b = await box(page, '.hm-map-list li[data-hm-r="TX"]');
    await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2);
    expect(await page.locator(".hm-tip-h").textContent()).toBe("Texas");
    expect(await page.locator(".hm-map-list li.hm-on").getAttribute("data-hm-r")).toBe("TX");
    expect(await page.locator(".hm-hover path").count()).toBe(2);
    await page.close();
  });

  it("steps through regions from the keyboard without a bar list", async () => {
    const page = await open("map-us-linear-alone", 1440);
    expect(await page.locator(".hm-map-list").count()).toBe(0);
    await page.locator("svg[data-hm-kind=map]").focus();
    await page.keyboard.press("ArrowDown");
    expect(await page.locator(".hm-tip-h").textContent()).toBeTruthy();
    expect(await page.locator(".hm-map .hm-sr[aria-live]").textContent()).toContain("#1 of");
    await page.close();
  });

  it.each([
    ["map-us-rate", 1440],
    ["map-world-rate", 1440],
    ["map-us-rate", 390],
    ["map-world-rate", 390],
  ] as const)(
    "%s at %i px: every bar starts at the same x and longer bars mean larger values",
    async (name, width) => {
      const page = await open(name, width);
      const rows = await page.$$eval(".hm-map-list li", (items) =>
        items.map((li) => {
          const part = (c: string) => li.querySelector(c)?.getBoundingClientRect();
          const label = li.querySelector(".hm-ml-n") as HTMLElement;
          return {
            bar: part(".hm-ml-bar")?.left,
            track: part(".hm-ml-bar")?.width,
            fill: part(".hm-ml-bar i")?.width ?? 0,
            value: part(".hm-ml-v")?.right,
            rank: Number(li.querySelector(".hm-ml-k")?.textContent),
            truncated: label.scrollWidth > label.clientWidth,
            title: label.title === label.textContent,
          };
        }),
      );
      expect(rows.length).toBeGreaterThan(5);
      for (const key of ["bar", "track", "value"] as const)
        expect(new Set(rows.map((r) => Math.round((r[key] as number) * 10))).size, key).toBe(1);
      for (let i = 1; i < rows.length; i++) {
        const [a, b] = [rows[i - 1], rows[i]] as [(typeof rows)[number], (typeof rows)[number]];
        expect(b.fill).toBeLessThanOrEqual(a.fill + 0.5);
        expect(b.rank).toBeGreaterThanOrEqual(a.rank);
      }
      expect(rows.every((r) => r.title)).toBe(true);
      await page.close();
    },
  );

  it.each([
    ["map-us-tiles-square", 1440, false],
    ["map-us-tiles-hex", 1440, false],
    ["map-us-tiles-narrow", 390, true],
  ] as const)(
    "%s at %i px: labelled tiles that link to the tooltip and the bar list",
    async (name, width, touch) => {
      const page = await open(name, width, touch);
      expect(await page.locator("svg[data-hm-kind=map] .hm-regions [data-hm-r]").count()).toBe(52);
      const labels = await page.locator(".hm-map-tiles text >> visible=true").allTextContents();
      expect(labels).toHaveLength(52);
      expect(labels).toContain("TX");
      const tx = await box(page, 'svg[data-hm-kind=map] [data-hm-r="TX"]');
      if (touch) await page.touchscreen.tap(tx.x + tx.width / 2, tx.y + tx.height / 2);
      else await page.mouse.move(tx.x + tx.width / 2, tx.y + tx.height / 2);
      expect(await page.locator(".hm-tip-h").textContent()).toBe("Texas");
      expect(await page.locator(".hm-map-list li.hm-on").getAttribute("data-hm-r")).toBe("TX");
      await page.close();
    },
  );

  it.each(["map-us-tiles-square", "map-us-tiles-hex"])(
    "%s on the narrowest card, span 3 at 1024 px, keeps every state code",
    async (name) => {
      const page = await open(name, 1024, false, (b) => ({ ...b, span: 3 }));
      expect(await page.locator(".hm-map-tiles text >> visible=true").count()).toBe(52);
      await page.close();
    },
  );

  it.each(["light", "dark"] as const)(
    "tile codes have no halo and reach WCAG AA on their own tile in the %s theme",
    async (scheme) => {
      for (const name of ["map-us-tiles-square", "map-us-tiles-hex", "map-us-tiles-narrow"]) {
        const page = await open(name, 1440);
        await page.emulateMedia({ colorScheme: scheme });
        const result = await page.evaluate(() => {
          const rgb = (c: string) => (c.match(/\d+(\.\d+)?/g) ?? []).slice(0, 3).map(Number);
          const lum = (c: string) => {
            const [r, g, b] = rgb(c).map((v) => {
              const x = v / 255;
              return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
            }) as [number, number, number];
            return 0.2126 * r + 0.7152 * g + 0.0722 * b;
          };
          const ratio = (a: string, b: string) => {
            const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
            return (hi + 0.05) / (lo + 0.05);
          };
          return [...document.querySelectorAll(".hm-map-tiles text")]
            .filter((t) => t.checkVisibility())
            .map((t) => {
              const tile = document.querySelector(
                `svg[data-hm-kind=map] [data-hm-r="${t.textContent}"]`,
              );
              const fill = tile ? getComputedStyle(tile).fill : "none";
              const text = getComputedStyle(t);
              return {
                id: t.textContent,
                stroke: text.stroke,
                ratio: fill.startsWith("rgb") ? ratio(text.fill, fill) : undefined,
              };
            });
        });
        expect(result).toHaveLength(52);
        expect(result.filter((l) => l.stroke !== "none")).toEqual([]);
        const filled = result.filter((l) => l.ratio !== undefined);
        expect(filled.length).toBeGreaterThan(40);
        expect(filled.filter((l) => (l.ratio as number) < 4.5)).toEqual([]);
        await page.close();
      }
    },
  );

  it("puts a tile map's empty-period message above the grid, not over it", async () => {
    const page = await open("map-us-tiles-narrow", 390, true, (b) => ({ ...b, regions: [] }));
    const message = await box(page, ".hm-map-empty");
    const grid = await box(page, "svg[data-hm-kind=map]");
    expect(message.y + message.height).toBeLessThanOrEqual(grid.y);
    await page.close();
  });

  it("keeps the note under the bar list beside the map", async () => {
    const page = await open("map-world-rate", 1440);
    const list = await box(page, ".hm-map-list");
    const note = await box(page, ".hm-map-note");
    expect(note.y).toBeGreaterThanOrEqual(list.y + list.height);
    await page.close();
  });

  it.each(["map-us-rate", "map-world-rate", "map-us-narrow", "map-us-tiles-narrow"])(
    "%s at 390 px: list under the map, no leader labels, nothing wider than the page",
    async (name) => {
      const page = await open(name, 390);
      const map = await box(page, "svg[data-hm-kind=map]");
      const list = await box(page, ".hm-map-list");
      expect(list.y).toBeGreaterThanOrEqual(map.y + map.height);
      expect(await page.locator(".hm-map-labels >> visible=true").count()).toBe(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        390,
      );
      await page.close();
    },
  );
});
