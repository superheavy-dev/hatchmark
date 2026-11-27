/// <reference lib="dom" />
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, expect, it } from "vitest";
import { GALLERY } from "../../gallery/variants.js";
import { renderDashboardPage } from "../../src/render/index.js";
import tokens from "../../src/render/themes/default.json" with { type: "json" };

let browser: Browser;
let dir: string;
beforeAll(async () => {
  browser = await chromium.launch();
  dir = await mkdtemp(path.join(tmpdir(), "hatchmark-swatch-"));
  await cp(
    new URL("../../assets/runtime/hatchmark.js", import.meta.url),
    path.join(dir, "hatchmark.js"),
  );
});
afterAll(async () => {
  await browser.close();
  await rm(dir, { recursive: true, force: true });
});

const rgb = (hex: string) =>
  `rgb(${[1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)).join(", ")})`;

async function swatches(
  variant: string,
): Promise<{ rows: number; sizes: string[]; colors: string[] }> {
  const data = GALLERY.find((v) => v.variant === variant)?.data;
  if (data === undefined) throw new Error(`gallery variant ${variant} missing`);
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    const file = path.join(dir, `${variant}.html`);
    await writeFile(
      file,
      renderDashboardPage(data, { assets: { runtime: "hatchmark.js", fonts: {} } }),
    );
    await page.goto(`file://${file}`);
    await page.locator("svg[data-hm-kind]").filter({ visible: true }).first().focus();
    await page.keyboard.press("ArrowRight");
    const tip = page.locator(".hm-tip").filter({ visible: true });
    return {
      rows: await tip.locator(".hm-tip-n").count(),
      sizes: await tip.locator(".hm-tip-n i").evaluateAll((nodes) =>
        nodes.map((n) => {
          const s = getComputedStyle(n);
          return `${s.width}x${s.height}`;
        }),
      ),
      colors: await tip
        .locator(".hm-tip-n i")
        .evaluateAll((nodes) => nodes.map((n) => getComputedStyle(n).backgroundColor)),
    };
  } finally {
    await page.close();
  }
}

it.each(["line-single", "area", "bar-vertical", "pie-countries", "donut-channels"])(
  "shows no swatch in a one-row tooltip (%s)",
  async (variant) => {
    const { rows, sizes } = await swatches(variant);
    expect(rows).toBe(1);
    expect(sizes).toEqual([]);
  },
);

it.each([
  ["line-split", "10px", "2px", "categorical"],
  ["area-stacked", "8px", "8px", "categoricalFill"],
  ["bar-grouped", "8px", "8px", "categoricalFill"],
  ["bar-stacked", "8px", "8px", "categoricalFill"],
] as const)(
  "matches each swatch to the mark in a several-row tooltip (%s)",
  async (variant, w, h, set) => {
    const { rows, sizes, colors } = await swatches(variant);
    expect(rows).toBeGreaterThan(1);
    expect(sizes).toEqual(Array.from({ length: rows }, () => `${w}x${h}`));
    const palette = tokens.data.light[set].map(rgb);
    for (const color of colors) expect(palette).toContain(color);
  },
);
