/// <reference lib="dom" />
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GALLERY } from "../../gallery/variants.js";
import type { DashboardData } from "../../src/compiler/index.js";
import { renderDashboardPage } from "../../src/render/index.js";
import tokens from "../../src/render/themes/default.json" with { type: "json" };

let browser: Browser;
let dir: string;
beforeAll(async () => {
  browser = await chromium.launch();
  dir = await mkdtemp(path.join(tmpdir(), "hatchmark-groups-"));
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
const [blue, pink] = tokens.data.groups.families;

async function open(
  variant: string,
  theme: "light" | "dark",
  width = 1440,
  edit: (data: DashboardData) => DashboardData = (d) => d,
) {
  const found = GALLERY.find((v) => v.variant === variant)?.data;
  if (found === undefined) throw new Error(`gallery variant ${variant} missing`);
  const data = edit(found);
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  const file = path.join(dir, `${variant}.html`);
  await writeFile(
    file,
    renderDashboardPage(data, { assets: { runtime: "hatchmark.js", fonts: {} } }),
  );
  await page.goto(`file://${file}?theme=${theme}`);
  return page;
}

async function tooltip(variant: string, theme: "light" | "dark", width = 1440) {
  const page = await open(variant, theme, width);
  try {
    await page.locator("svg[data-hm-kind]").filter({ visible: true }).first().focus();
    await page.keyboard.press("ArrowRight");
    const tip = page.locator(".hm-tip").filter({ visible: true });
    return await tip.evaluate((node) =>
      [...node.children].map((child) => {
        const swatch = child.querySelector(".hm-tip-n i");
        return {
          kind: child.className,
          text:
            child.querySelector(".hm-tip-n")?.textContent ??
            child.firstElementChild?.textContent ??
            child.textContent,
          color: swatch ? getComputedStyle(swatch).backgroundColor : "",
        };
      }),
    );
  } finally {
    await page.close();
  }
}

describe.each(["light", "dark"] as const)("series groups in the browser, %s", (theme) => {
  it("heads each group's tooltip rows with its name, in series order, in the group's colours", async () => {
    const rows = (await tooltip("groups-bar-stacked", theme)).filter((r) => r.kind !== "hm-tip-h");
    expect(rows.map((r) => [r.kind, r.text])).toEqual([
      ["hm-tip-g", "Online"],
      ["hm-tip-r", "Online store"],
      ["hm-tip-r", "Marketplace"],
      ["hm-tip-g", "Offline"],
      ["hm-tip-r", "Retail partners"],
      ["hm-tip-r", "Wholesale"],
      ["hm-tip-r hm-tip-t", "Total"],
    ]);
    const swatches = rows.filter((r) => r.kind === "hm-tip-r").map((r) => r.color);
    expect(swatches).toEqual(
      [...(blue?.[theme].fill.slice(0, 2) ?? []), ...(pink?.[theme].fill.slice(0, 2) ?? [])].map(
        rgb,
      ),
    );
  });

  it("keeps an ungrouped series on a slot outside the held family", async () => {
    const rows = (await tooltip("groups-bar-years", theme)).filter((r) => r.kind === "hm-tip-r");
    expect(rows.map((r) => r.text)).toEqual(["2026", "2025", "Plan 2026"]);
    expect(rows.map((r) => r.color)).toEqual(
      [blue?.[theme].fill[0], blue?.[theme].fill[1], tokens.data[theme].categoricalFill[1]].map(
        (h) => rgb(h as string),
      ),
    );
  });

  it("keeps a long group heading inside the chart at 390 px", async () => {
    const label =
      "Direct-to-consumer channels across North America, Europe and Asia-Pacific, excluding wholesale partners";
    const long = (data: DashboardData): DashboardData => ({
      ...data,
      blocks: data.blocks.map((b) =>
        "groups" in b && b.groups ? { ...b, groups: b.groups.map((g) => ({ ...g, label })) } : b,
      ),
    });
    for (const variant of ["groups-bar-stacked", "groups-line-two-groups"]) {
      const page = await open(variant, theme, 390, long);
      try {
        const svg = page.locator("svg[data-hm-kind]").filter({ visible: true }).first();
        const box = await svg.boundingBox();
        const headings = await svg.locator("text:has(title)").evaluateAll((nodes) =>
          nodes.map((n) => ({
            title: n.querySelector("title")?.textContent,
            right: n.getBoundingClientRect().right,
          })),
        );
        const named = headings.filter((h) => h.title === label);
        expect(named.length, variant).toBeGreaterThan(0);
        for (const h of named)
          expect(h.right, variant).toBeLessThanOrEqual((box?.x ?? 0) + (box?.width ?? 0) + 0.5);
      } finally {
        await page.close();
      }
    }
  });

  it("names the group before its members in the key, on desktop and phone", async () => {
    for (const width of [1440, 390]) {
      const page = await open("groups-line-two-groups", theme, width);
      try {
        const key = page
          .locator("svg[data-hm-kind] .hm-readout, svg[data-hm-kind] .hm-key")
          .filter({ visible: true });
        const texts =
          (await key.count()) > 0 ? await key.first().locator("text").allTextContents() : [];
        if (width === 390) {
          const names = texts.filter((t) => !/^\$|^Oct|^Total/.test(t));
          expect(names.indexOf("North America")).toBeLessThan(names.indexOf("2026"));
          expect(names.indexOf("Europe")).toBeGreaterThan(names.indexOf("2025"));
        }
        const fills = await page
          .locator("svg[data-hm-kind] path[stroke-width]")
          .filter({ visible: true })
          .evaluateAll((nodes) => nodes.map((n) => getComputedStyle(n).stroke));
        expect(fills).toEqual(
          expect.arrayContaining(
            [blue?.[theme].stroke[1], pink?.[theme].stroke[1]].map((h) => rgb(h as string)),
          ),
        );
      } finally {
        await page.close();
      }
    }
  });
});
