/// <reference lib="dom" />
import { readFile } from "node:fs/promises";
import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FONT_FILES, type FontWeight, textWidth } from "../../src/render/index.js";

// Linux Chromium's default full hinting snaps every glyph advance to a whole pixel, unlike macOS
// and most browsers, so these tests turn hinting off.
const STRINGS = [
  "Revenue",
  "United States",
  "United Kingdom",
  "Côte d’Ivoire",
  "Health & beauty",
  "Average order value",
  "Technical shells and insulated outerwear",
  "Kids' outdoor clothing",
  "AVAWAY To Ty Yo",
  "$1,722,238",
  "$1.84M",
  "\u2212$12,300",
  "+0.27 pp",
  "39.2%",
  "Nov 2024",
  "Jan 2026",
  "Week of Oct 5, 2026",
  "Sep 7 \u2013 Nov 1, 2026",
  "Données · Łódź · Kraków",
  "(empty)",
  "0123456789",
  "fifty flowers",
];
const SIZES = [12, 13, 14, 20];
const WEIGHTS: FontWeight[] = [400, 500, 600];

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({ args: ["--font-render-hinting=none"] });
});
afterAll(async () => {
  await browser?.close();
});

describe("text measurer vs Chromium", () => {
  it("matches SVG text widths within 0.5 px or 0.5%", async () => {
    const faces = await Promise.all(
      FONT_FILES.map(async (f) => {
        const data = (
          await readFile(new URL(`../../assets/fonts/${f.file}`, import.meta.url))
        ).toString("base64");
        return `@font-face{font-family:"M";font-weight:${f.weight};src:url(data:font/woff2;base64,${data}) format("woff2");unicode-range:${f.unicodeRange}}`;
      }),
    );
    const page = await browser.newPage();
    await page.setContent(
      `<style>${faces.join("")}</style><svg width="2000" height="100" font-family="M"></svg>`,
    );
    const cases = STRINGS.flatMap((text) =>
      SIZES.flatMap((size) => WEIGHTS.map((weight) => ({ text, size, weight }))),
    );
    const measured = await page.evaluate(async (all) => {
      const svg = document.querySelector("svg") as SVGSVGElement;
      for (const w of [400, 500, 600]) await document.fonts.load(`${w} 12px M`, "AĄ");
      return all.map(({ text, size, weight }) => {
        const node = document.createElementNS("http://www.w3.org/2000/svg", "text");
        node.setAttribute("font-size", String(size));
        node.setAttribute("font-weight", String(weight));
        node.textContent = text;
        svg.append(node);
        const width = node.getComputedTextLength();
        node.remove();
        return width;
      });
    }, cases);
    const worst = cases
      .map((c, i) => {
        const ours = textWidth(c.text, { size: c.size, weight: c.weight });
        const theirs = measured[i] as number;
        return { ...c, ours, theirs, diff: Math.abs(ours - theirs) };
      })
      .sort((a, b) => b.diff - a.diff);
    const failures = worst.filter((w) => w.diff > Math.max(0.5, w.theirs * 0.005));
    console.log(
      `measurer: ${cases.length} cases, max diff ${worst[0]?.diff.toFixed(3)} px (${worst[0]?.text} @ ${worst[0]?.size}/${worst[0]?.weight})`,
    );
    expect(failures).toEqual([]);
  });
});
