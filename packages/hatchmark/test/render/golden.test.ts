import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { GALLERY, SALES } from "../../gallery/variants.js";
import type {
  BarData,
  DashboardData,
  LineData,
  PieData,
} from "../../src/compiler/dashboard-data.js";

type Chart = LineData | BarData | PieData;

import {
  cardWidth,
  cssPaint,
  DEFAULT_THEME,
  LAYOUTS,
  type RenderContext,
  renderBlocks,
  renderChartSvg,
  renderDashboardPage,
} from "../../src/render/index.js";
import GLOBAL_SALES from "../fixtures/global-sales/sales.data.json" with { type: "json" };

const DIR = new URL("./goldens/", import.meta.url);
const UPDATE = process.env.HATCHMARK_UPDATE_GOLDENS === "1";

function golden(name: string, actual: string): void {
  const file = new URL(name, DIR);
  if (UPDATE || !existsSync(file)) {
    if (!UPDATE) throw new Error(`missing golden ${name}; run pnpm test:update-goldens`);
    mkdirSync(DIR, { recursive: true });
    writeFileSync(file, actual);
    return;
  }
  expect(actual === readFileSync(file, "utf8"), `${name} differs from its golden`).toBe(true);
}

const ASSETS = {
  runtime: "../_hatchmark/hatchmark.js",
  fonts: { "IBMPlexSans-Regular-Latin1.woff2": "../_hatchmark/IBMPlexSans-Regular-Latin1.woff2" },
};

describe("golden renders", () => {
  for (const entry of GALLERY) {
    it(`${entry.component}/${entry.variant}`, () => {
      const ctx: RenderContext = { data: entry.data, theme: DEFAULT_THEME, paint: cssPaint };
      const charts = (blocks: DashboardData["blocks"], name: (b: Chart) => string) => {
        for (const chart of blocks as Chart[]) {
          const desktop = cardWidth(LAYOUTS[0], chart.span) - 34;
          golden(
            `${name(chart)}.desktop.svg`,
            `${renderChartSvg(chart, entry.data, { width: desktop })}\n`,
          );
          golden(
            `${name(chart)}.mobile-dark.svg`,
            `${renderChartSvg(chart, entry.data, { width: 324, device: "phone", mode: "dark" })}\n`,
          );
        }
      };
      if (entry.component === "height") {
        golden(`${entry.variant}.html`, `${renderBlocks(entry.data.blocks, ctx)}\n`);
        const each = entry.data.blocks.filter((b) => b.type !== "kpi" && b.type !== "table");
        if (each.length === entry.data.blocks.length)
          charts(each, (b) => `${entry.variant}.${b.id}`);
        return;
      }
      if (entry.component === "kpi" || entry.component === "table") {
        golden(`${entry.variant}.html`, `${renderBlocks(entry.data.blocks, ctx)}\n`);
        return;
      }
      charts(entry.data.blocks.slice(0, 1), () => entry.variant);
    });
  }

  it("the gallery's sample dashboard page", () => {
    golden("sales.html", renderDashboardPage(SALES, { assets: ASSETS, sources: ["orders.csv"] }));
  });

  it("the global-sales example page, from the engine's DashboardData", () => {
    const data = GLOBAL_SALES as DashboardData;
    golden(
      "global-sales.html",
      renderDashboardPage(data, { assets: ASSETS, sources: ["orders.csv"] }),
    );
  });

  for (const locale of ["de-DE", "ja-JP"]) {
    it(`the global-sales example page in ${locale}`, () => {
      const data = { ...(GLOBAL_SALES as DashboardData), locale };
      golden(
        `global-sales.${locale}.html`,
        renderDashboardPage(data, { assets: ASSETS, sources: ["orders.csv"] }),
      );
    });
  }
});
