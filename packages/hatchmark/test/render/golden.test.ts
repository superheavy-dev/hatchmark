import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { GALLERY, SALES } from "../../gallery/variants.js";
import type {
  BarData,
  DashboardData,
  LineData,
  PieData,
} from "../../src/compiler/dashboard-data.js";
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

/**
 * Golden files: every gallery variant rendered and compared byte for byte with the committed
 * output in goldens/. After an intended rendering change, regenerate them with
 * pnpm test:update-goldens and review the diff (and the before/after renders) in the PR.
 */
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
      const block = entry.data.blocks[0];
      if (entry.component === "kpi" || entry.component === "table") {
        golden(`${entry.variant}.html`, `${renderBlocks(entry.data.blocks, ctx)}\n`);
        return;
      }
      const chart = block as LineData | BarData | PieData;
      const desktop = cardWidth(LAYOUTS[0], chart.span) - 34;
      golden(
        `${entry.variant}.desktop.svg`,
        `${renderChartSvg(chart, entry.data, { width: desktop })}\n`,
      );
      golden(
        `${entry.variant}.mobile-dark.svg`,
        `${renderChartSvg(chart, entry.data, { width: 324, height: 230, mode: "dark" })}\n`,
      );
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
