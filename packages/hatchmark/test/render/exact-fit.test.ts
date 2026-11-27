import { describe, expect, it } from "vitest";
import { GALLERY } from "../../gallery/variants.js";
import type { BarData, DashboardData, PieData } from "../../src/compiler/dashboard-data.js";
import { formatValue, renderChartSvg } from "../../src/render/index.js";

function variant<T>(name: string, values: (data: DashboardData, block: T) => void) {
  const found = GALLERY.find((v) => v.variant === name)?.data;
  if (!found) throw new Error(`no gallery variant ${name}`);
  const data = structuredClone(found);
  data.locale = "de-DE";
  const block = data.blocks[0] as T;
  values(data, block);
  return { data, block };
}

const sixDecimals = (data: DashboardData, metric: string) => {
  const info = data.metrics[metric];
  if (info) info.format = { type: "currency", currency: "USD", decimals: 6 };
};

const bars = (svg: string) =>
  [...svg.matchAll(/<rect x="([\d.-]+)" y="([\d.-]+)" width="([\d.]+)" height="[\d.]+" rx=/g)].map(
    (m) => ({
      x: Number(m[1]),
      y: Number(m[2]),
      w: Number(m[3]),
    }),
  );

describe("exact values that are too long for the chart", () => {
  const signed = variant<BarData>("bar-horizontal", (data, block) => {
    const series = block.series[0];
    if (!series) throw new Error("no series");
    sixDecimals(data, series.metric);
    series.values = series.values.map((_, i) =>
      i === 0 ? 845_678.123456 : i === 1 ? -987_654.123456 : 74_321.012345,
    );
  });

  for (const width of [324, 390, 1280]) {
    it(`keeps a signed horizontal bar's direction at ${width} px`, () => {
      const svg = renderChartSvg(signed.block, signed.data, { width });
      const drawn = bars(svg).sort((a, b) => a.y - b.y);
      const [positive, negative] = drawn;
      if (!positive || !negative) throw new Error("bars missing");
      expect(positive.x).toBeGreaterThanOrEqual(negative.x + negative.w - 0.5);
      for (const bar of drawn) {
        expect(bar.x).toBeGreaterThanOrEqual(0);
        expect(bar.x + bar.w).toBeLessThanOrEqual(width + 0.5);
      }
    });
  }

  it("drops the inline values when they would squeeze the bars, and keeps them when there is room", () => {
    const metric = signed.data.metrics[signed.block.series[0]?.metric ?? ""];
    if (!metric) throw new Error("no metric");
    const label = formatValue(845_678.123456, metric, "de-DE", "compact");
    expect(renderChartSvg(signed.block, signed.data, { width: 390 })).not.toContain(label);
    expect(renderChartSvg(signed.block, signed.data, { width: 1280 })).toContain(label);
  });

  const donut = (total: number) =>
    variant<PieData>("donut-channels", (data, block) => {
      sixDecimals(data, block.metric);
      block.total = total;
    });

  for (const width of [390, 1280]) {
    it(`moves a donut total that does not fit the hole into the key at ${width} px`, () => {
      const { block, data } = donut(-987_654.123456);
      const metric = data.metrics[block.metric];
      if (!metric) throw new Error("no metric");
      const total = formatValue(block.total, metric, "de-DE", "headline");
      const svg = renderChartSvg(block, data, { width });
      const element = new RegExp(`<text[^>]*>${total.replace(/[.$]/g, "\\$&")}</text>`).exec(
        svg,
      )?.[0];
      expect(element).toBeDefined();
      expect(element).not.toContain('text-anchor="middle"');
      expect(svg).toMatch(/>Total<\/text>/);
    });
  }

  it("keeps a total that fits in the hole", () => {
    const { block, data } = donut(1234.5);
    const svg = renderChartSvg(block, data, { width: 1280 });
    expect(svg).toMatch(/text-anchor="middle"[^>]*>1\.234,500000/);
    expect(svg).not.toMatch(/>Total<\/text>/);
  });
});
