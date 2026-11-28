/// <reference lib="dom" />
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type Browser, chromium, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GALLERY } from "../../gallery/variants.js";
import type { DashboardData, TableData } from "../../src/compiler/dashboard-data.js";
import { DEFAULT_THEME, FONT_FILES, renderDashboardPage } from "../../src/render/index.js";
import type { HeightPreset } from "../../src/spec/layout.js";

let browser: Browser;
let dir: string;

const HEIGHTS = GALLERY.filter((v) => v.component === "height");
const CHARTS = HEIGHTS.filter(
  (v) =>
    v.variant !== "height-row" &&
    v.data.blocks.every((b) => b.type !== "kpi" && b.type !== "table"),
);
const READOUT_ON_PHONES = new Set(["height-line", "height-area"]);
const DEVICES = [
  { device: "desktop", viewport: { width: 1440, height: 900 } },
  { device: "phone", viewport: { width: 390, height: 844 } },
] as const;
const tokens = DEFAULT_THEME.height;

const variant = (name: string): DashboardData => {
  const found = GALLERY.find((v) => v.variant === name)?.data;
  if (!found) throw new Error(`gallery variant ${name} is missing`);
  return found;
};

beforeAll(async () => {
  browser = await chromium.launch();
  dir = await mkdtemp(path.join(tmpdir(), "hatchmark-heights-"));
  const assets = new URL("../../assets/", import.meta.url);
  await cp(new URL("runtime/hatchmark.js", assets), path.join(dir, "hatchmark.js"));
  const fonts: Record<string, string> = {};
  for (const font of FONT_FILES) {
    await cp(new URL(`fonts/${font.file}`, assets), path.join(dir, font.file));
    fonts[font.file] = font.file;
  }
  for (const entry of HEIGHTS) {
    await writeFile(
      path.join(dir, `${entry.variant}.html`),
      renderDashboardPage(entry.data, { assets: { runtime: "hatchmark.js", fonts } }),
    );
  }
  const tables = variant("height-table");
  for (const [name, rows] of [
    ["height-table-untotalled", undefined],
    ["height-table-untotalled-8", 8],
  ] as const) {
    const blocks = tables.blocks.map((b) => {
      const { total: _, ...block } = b as TableData;
      return { ...block, rows: block.rows.slice(0, rows) };
    });
    await writeFile(
      path.join(dir, `${name}.html`),
      renderDashboardPage({ ...tables, blocks }, { assets: { runtime: "hatchmark.js", fonts } }),
    );
  }
  const compact = { ...(tables.blocks[0] as TableData), span: 6 };
  const { total: _, ...untotalled } = { ...compact, id: `${compact.id}_bare` };
  for (const [name, blocks] of [
    ["height-tables-totals-first", [compact, untotalled]],
    ["height-tables-totals-last", [untotalled, compact]],
  ] as const) {
    await writeFile(
      path.join(dir, `${name}.html`),
      renderDashboardPage(
        { ...tables, blocks: [...blocks] },
        { assets: { runtime: "hatchmark.js", fonts } },
      ),
    );
  }
  const kpis = variant("height-strip").blocks;
  await writeFile(
    path.join(dir, "height-strips.html"),
    renderDashboardPage(
      {
        ...tables,
        blocks: [kpis[0], kpis[1], { ...compact, span: 12 }, kpis[3]] as DashboardData["blocks"],
      },
      { assets: { runtime: "hatchmark.js", fonts } },
    ),
  );
});

afterAll(async () => {
  await browser.close();
  await rm(dir, { recursive: true, force: true });
});

async function open(
  name: string,
  viewport: { width: number; height: number },
  theme = "light",
): Promise<Page> {
  const page = await browser.newPage({ viewport });
  await page.goto(`file://${path.join(dir, `${name}.html`)}?theme=${theme}`);
  await page.evaluate(() => document.fonts.ready);
  return page;
}

/** Every visible chart's id, drawn height and the overlaps between its text labels. */
function charts(page: Page) {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>("figure.hm-chart")].map((figure) => {
      const svg = [...figure.querySelectorAll<SVGSVGElement>(".hm-v svg")].find(
        (s) => s.getBoundingClientRect().height > 0,
      ) as SVGSVGElement;
      const card = figure.closest(".hm-card")?.getBoundingClientRect() as DOMRect;
      const texts = [...svg.querySelectorAll("text")]
        .filter((t) => t.getAttribute("visibility") !== "hidden" && t.textContent)
        .map((t) => ({ text: t.textContent, box: t.getBoundingClientRect() }));
      const overlaps: string[] = [];
      texts.forEach((a, i) => {
        for (const b of texts.slice(i + 1)) {
          const x = Math.min(a.box.right, b.box.right) - Math.max(a.box.left, b.box.left);
          const y = Math.min(a.box.bottom, b.box.bottom) - Math.max(a.box.top, b.box.top);
          if (x > 1 && y > 1) overlaps.push(`${a.text} / ${b.text}`);
        }
      });
      const outside = texts
        .filter(
          (t) =>
            t.box.left < card.left ||
            t.box.right > card.right ||
            t.box.top < card.top ||
            t.box.bottom > card.bottom,
        )
        .map((t) => t.text);
      return {
        id: figure.dataset.hmChart as string,
        drawn: svg.getBoundingClientRect().height,
        attr: Number(svg.getAttribute("height")),
        cardTop: card.top,
        overlaps,
        outside,
      };
    }),
  );
}

describe.each(DEVICES)("height presets at $device width", ({ device, viewport }) => {
  it.each(CHARTS.map((c) => c.variant))(
    "%s: every preset draws unscaled with no clashing or clipped labels",
    async (name) => {
      const page = await open(name, viewport);
      try {
        const found = await charts(page);
        expect(found).toHaveLength(3);
        for (const chart of found) {
          expect(chart.drawn, chart.id).toBeCloseTo(chart.attr, 0);
          expect(chart.overlaps, chart.id).toEqual([]);
          expect(chart.outside, chart.id).toEqual([]);
        }
        const [compact, standard, tall] = found.map((c) => c.drawn) as [number, number, number];
        expect(compact).toBeLessThanOrEqual(standard);
        expect(standard).toBeLessThanOrEqual(tall);
        expect(compact).toBeLessThan(tall);
        if (name === "height-bar-horizontal") expect(compact).toBeLessThan(standard);
      } finally {
        await page.close();
      }
    },
  );

  it.each(CHARTS.map((c) => c.variant))(
    "%s: the compact chart's tooltip or readout opens inside the screen",
    async (name) => {
      const page = await open(name, viewport);
      try {
        const svg = page.locator(".hm-v svg[data-hm-kind]").filter({ visible: true }).first();
        await svg.focus();
        if (device === "phone" && READOUT_ON_PHONES.has(name)) {
          const before = await svg.textContent();
          await page.keyboard.press("ArrowLeft");
          await page.keyboard.press("ArrowLeft");
          expect(await svg.textContent()).not.toBe(before);
          expect((await charts(page))[0]?.outside).toEqual([]);
          return;
        }
        await page.keyboard.press("ArrowRight");
        await page.keyboard.press("ArrowRight");
        const tip = page.locator(".hm-tip").filter({ visible: true }).first();
        const box = await tip.boundingBox();
        expect(box).not.toBeNull();
        const { x, y, width, height } = box as {
          x: number;
          y: number;
          width: number;
          height: number;
        };
        const scroll = await page.evaluate(() => window.scrollY);
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x + width).toBeLessThanOrEqual(viewport.width);
        expect(y + scroll).toBeGreaterThanOrEqual(0);
        expect(height).toBeGreaterThan(0);
      } finally {
        await page.close();
      }
    },
  );

  it.each(["compact", "default", "tall"] as const)(
    "a %s KPI strip sizes its figure and sparkline from the tokens, in light and dark",
    async (preset: HeightPreset) => {
      const expected = tokens[preset][device];
      for (const theme of ["light", "dark"]) {
        const page = await open(`height-kpi-${preset}`, viewport, theme);
        try {
          const sizes = await page.evaluate(() => {
            const value = getComputedStyle(document.querySelector(".hm-kpi-value") as Element);
            const spark = (document.querySelector(".hm-spark") as Element).getBoundingClientRect();
            const figure = document.querySelector(".hm-kpi-value") as HTMLElement;
            return {
              size: value.fontSize,
              line: value.lineHeight,
              spark: spark.height,
              fits: figure.scrollWidth <= (figure.closest(".hm-kpi") as HTMLElement).clientWidth,
            };
          });
          expect(sizes).toEqual({
            size: `${expected.kpiSize}px`,
            line: `${expected.kpiLineHeight}px`,
            spark: expected.sparkline,
            fits: true,
          });
        } finally {
          await page.close();
        }
      }
    },
  );

  it.each(["height-table", "height-table-untotalled"])(
    "a table scrolls past its preset's rows inside a card of that height (%s)",
    async (name) => {
      const page = await open(name, viewport);
      try {
        const wraps = await page.evaluate(() =>
          [...document.querySelectorAll<HTMLElement>(".hm-table-wrap")].map((w) => {
            const row = (w.querySelector("tbody tr") as HTMLElement).getBoundingClientRect().height;
            return {
              rows:
                (w.clientHeight -
                  (w.querySelector("thead") as HTMLElement).offsetHeight -
                  ((w.querySelector("tfoot") as HTMLElement | null)?.offsetHeight ?? 0)) /
                row,
              scrolls: w.scrollHeight > w.clientHeight,
            };
          }),
        );
        expect(wraps.map((w) => w.scrolls)).toEqual([true, true, true]);
        (["compact", "default", "tall"] as const).forEach((preset, i) => {
          const rows = tokens[preset][device].tableRows;
          const legacy = preset === "default" && name === "height-table-untotalled";
          expect(wraps[i]?.rows, preset).toBeCloseTo(legacy ? rows + 1 : rows, 0);
        });
      } finally {
        await page.close();
      }
    },
  );

  it("a compact table without totals scrolls with one row more than it shows", async () => {
    const page = await open("height-table-untotalled-8", viewport);
    try {
      const compact = await page.evaluate(() => {
        const wrap = document.querySelector<HTMLElement>(".hm-table-wrap") as HTMLElement;
        return {
          tfoot: wrap.querySelector("tfoot") !== null,
          scrolls: wrap.scrollHeight > wrap.clientHeight,
        };
      });
      expect(compact).toEqual({ tfoot: false, scrolls: true });
    } finally {
      await page.close();
    }
  });

  it.each(["height-tables-totals-first", "height-tables-totals-last"])(
    "compact tables with and without totals keep their own caps on one page (%s)",
    async (name) => {
      const caps = async (file: string) => {
        const page = await open(file, viewport);
        try {
          return await page.evaluate(() =>
            Object.fromEntries(
              [...document.querySelectorAll<HTMLElement>(".hm-table-wrap")]
                .reverse()
                .map((w) => [w.querySelector("tfoot") ? "totals" : "bare", w.clientHeight]),
            ),
          );
        } finally {
          await page.close();
        }
      };
      const alone = { ...(await caps("height-table")), ...(await caps("height-table-untotalled")) };
      const together = await caps(name);
      expect(together.totals).toBeGreaterThan(together.bare as number);
      expect(together.totals).toBeCloseTo(alone.totals as number, 0);
      expect(together.bare).toBeCloseTo(alone.bare as number, 0);
    },
  );

  it("a later KPI strip does not undo the levelling of an earlier one", async () => {
    const widths = device === "desktop" ? [viewport, { ...viewport, width: 1024 }] : [viewport];
    for (const size of widths) {
      const page = await open("height-strips", size);
      try {
        const sizes = await page.evaluate(() =>
          [...document.querySelectorAll(".hm-kpi-value")].map((v) => getComputedStyle(v).fontSize),
        );
        const expected = (
          device === "desktop" ? ["tall", "tall", "compact"] : ["compact", "tall", "compact"]
        ).map((p) => `${tokens[p as HeightPreset][device].kpiSize}px`);
        expect(sizes, String(size.width)).toEqual(expected);
      } finally {
        await page.close();
      }
    }
  });

  it("cards in a mixed row end level on desktop and keep their own preset on phones", async () => {
    const page = await open("height-row", viewport);
    try {
      const [line, bar] = await charts(page);
      if (device === "desktop") {
        expect(line?.cardTop).toBe(bar?.cardTop);
        expect(bar?.drawn).toBe(tokens.tall.desktop.chart);
        expect(line?.drawn).toBeGreaterThanOrEqual(tokens.tall.desktop.chart);
      } else {
        expect(bar?.drawn).toBeCloseTo(tokens.tall.phone.chart, 0);
        expect(line?.drawn).toBeLessThan(bar?.drawn as number);
      }
      const strip = await open("height-strip", viewport);
      try {
        const sizes = await strip.evaluate(() =>
          [...document.querySelectorAll(".hm-kpi-value")].map((v) => getComputedStyle(v).fontSize),
        );
        const own = (["compact", "tall", "default", "compact"] as const).map(
          (preset) => `${tokens[device === "desktop" ? "tall" : preset][device].kpiSize}px`,
        );
        expect(sizes).toEqual(own);
      } finally {
        await strip.close();
      }
    } finally {
      await page.close();
    }
  });
});

it("a page without presets has no preset styles", async () => {
  const page = await browser.newPage();
  try {
    const html = renderDashboardPage(variant("kpi-strip"), {
      assets: { runtime: "hatchmark.js", fonts: {} },
    });
    expect(html).not.toContain("data-hm-height");
  } finally {
    await page.close();
  }
});
