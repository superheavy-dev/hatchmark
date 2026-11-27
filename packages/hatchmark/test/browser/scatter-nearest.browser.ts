// Adopted from the HAT-61 review of hatchmark#28 (scatter): nearest.browser.ts.
/// <reference lib="dom" />
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { expect, it } from "vitest";
import { GALLERY } from "../../gallery/variants.js";
import type { ScatterData } from "../../src/compiler/dashboard-data.js";
import { renderFragment } from "../../src/render/index.js";

it("picks the visible foreground bubble when the pointer is on its exact center", async () => {
  const variant = GALLERY.find((v) => v.variant === "scatter-countries");
  if (variant === undefined) throw new Error("scatter-countries gallery variant missing");
  const { data } = variant;
  const block = data.blocks[0] as ScatterData;
  const make = (label: string, x: number, y: number, size: number) => ({
    key: label,
    label,
    x,
    y,
    size,
  });
  const points = [
    make("Large background", 500, 40, 1000),
    make("Small foreground", 505, 40, 5),
    make("Low anchor", 0, 0, 1),
    make("High anchor", 1000, 100, 1),
  ];
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.setContent(renderFragment({ ...data, blocks: [{ ...block, points }] }));
    await page.addScriptTag({
      path: fileURLToPath(new URL("../../assets/runtime/hatchmark.js", import.meta.url)),
    });
    const circles = page.locator("svg:visible circle");
    const target = circles.nth(1);
    const box = await target.boundingBox();
    if (box === null) throw new Error("target bubble has no box");
    const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    expect(
      await target.evaluate((node, p) => document.elementFromPoint(p.x, p.y) === node, center),
    ).toBe(true);
    await page.mouse.move(center.x, center.y);
    expect(await page.locator(".hm-tip-h").textContent()).toBe("Small foreground");
  } finally {
    await browser.close();
  }
});
