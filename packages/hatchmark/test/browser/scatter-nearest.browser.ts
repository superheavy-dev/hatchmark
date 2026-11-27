// Adopted from the HAT-61 review of hatchmark#28 (scatter): nearest.browser.ts.
/// <reference lib="dom" />
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { expect, it } from "vitest";
import { GALLERY } from "../../gallery/variants.js";
import type { ScatterData } from "../../src/compiler/dashboard-data.js";
import { renderFragment } from "../../src/render/index.js";

it.each([5, 1000])(
  "picks the foreground center with size %s, including matching radii",
  async (size) => {
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
      make("Small foreground", 505, 40, size),
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
  },
);

it.each([
  ["drawn after", 500, 505],
  ["drawn before", 505, 500],
])(
  "equal-radius overlap: tooltip, ring and keyboard report the bubble on top (%s by x)",
  async (_, back, front) => {
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
      make("Back", back, 40, 1000),
      make("Front", front, 40, 1000),
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
      const svg = page.locator('svg[data-hm-kind="scatter"]').filter({ visible: true }).first();
      const circles = svg.locator("circle");
      const boxes = await Promise.all([0, 1].map((i) => circles.nth(i).boundingBox()));
      const [b0, b1] = boxes;
      if (!b0 || !b1) throw new Error("bubbles have no box");
      const at = {
        x: (b0.x + b0.width / 2 + b1.x + b1.width / 2) / 2,
        y: (b0.y + b0.height / 2 + b1.y + b1.height / 2) / 2,
      };
      const visible = await circles.evaluateAll(
        (nodes, p) => nodes.indexOf(document.elementFromPoint(p.x, p.y) as SVGElement),
        at,
      );
      expect(points[visible]?.label).toBe("Front");
      await page.mouse.move(at.x, at.y);
      expect(await page.locator(".hm-tip-h").textContent()).toBe("Front");
      const ring = await svg.locator(".hm-hover circle").first().getAttribute("cx");
      expect(ring).toBe(await circles.nth(1).getAttribute("cx"));
      await svg.focus();
      await page.keyboard.press("ArrowLeft");
      await page.keyboard.press("ArrowRight");
      expect(await page.locator("[aria-live]").first().textContent()).toMatch(/^Front, /);
    } finally {
      await browser.close();
    }
  },
);
