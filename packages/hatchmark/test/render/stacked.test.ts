import { describe, expect, it } from "vitest";
import { GALLERY } from "../../gallery/variants.js";
import type { BarData, DashboardData } from "../../src/compiler/dashboard-data.js";
import { chartRuntimeData, renderChartSvg } from "../../src/render/index.js";
import { DEFAULT_THEME } from "../../src/render/theme.js";

/** Stacked renders: key height, the horizontal 100% axis, one series. */

function variant(name: string): { block: BarData; data: DashboardData } {
  const data = GALLERY.find((v) => v.variant === name)?.data;
  if (!data) throw new Error(`no gallery variant ${name}`);
  return { block: data.blocks[0] as BarData, data };
}

const plotHeight = (svg: string) => {
  const [, top, , bottom] = (/data-hm-plot="([^"]+)"/.exec(svg)?.[1] ?? "").split(",").map(Number);
  return (bottom ?? 0) - (top ?? 0);
};
const texts = (svg: string) =>
  [...svg.matchAll(/<text[^>]*>(?:<title>[^<]*<\/title>)?([^<]*)<\/text>/g)].map((m) => m[1]);
const ctx = (data: DashboardData) => ({ data, theme: DEFAULT_THEME, paint: { attrs: () => "" } });

describe("stacked renders", () => {
  it("keeps a vertical bar chart's plot height when its key wraps, and grows the chart", () => {
    const { block, data } = variant("bar-percent");
    const short = renderChartSvg(block, data, { width: 390 });
    const long = renderChartSvg(
      {
        ...block,
        series: block.series.map((s, k) => ({
          ...s,
          label: `Long but valid channel name number ${k + 1}`,
        })),
      },
      data,
      { width: 390 },
    );
    expect(plotHeight(long)).toBe(plotHeight(short));
    expect(Number(/height="([\d.]+)"/.exec(long)?.[1])).toBeGreaterThan(
      Number(/height="([\d.]+)"/.exec(short)?.[1]),
    );
  });

  it("draws the 0–100% axis on a horizontal 100% stack: quarters when wide, halves when narrow", () => {
    const { block, data } = variant("bar-horizontal-percent");
    expect(texts(renderChartSvg(block, data, { width: 900 }))).toEqual(
      expect.arrayContaining(["0%", "25%", "50%", "75%", "100%"]),
    );
    const narrow = texts(renderChartSvg(block, data, { width: 300 }));
    expect(narrow).toEqual(expect.arrayContaining(["0%", "50%", "100%"]));
    expect(narrow).not.toContain("25%");
  });

  it("keeps share and total in the tooltip of a plain stack filtered down to one series", () => {
    const { block, data } = variant("bar-stacked");
    const only = block.series[0] as BarData["series"][number];
    const one: BarData = {
      ...block,
      series: [{ ...only, share: only.values.map(() => 1) }],
      totals: only.values,
    };
    const runtime = chartRuntimeData(one, ctx(data));
    expect(runtime.series[0]?.pct?.[0]).toBe("100.0%");
    expect(runtime.total?.[0]).toMatch(/^\$[\d,]+$/);
  });

  it("shows values beside shares and the total in a narrow 100% area's readout", () => {
    const data = GALLERY.find((v) => v.variant === "area-percent-narrow")?.data as DashboardData;
    const block = data.blocks[0] as Parameters<typeof renderChartSvg>[0];
    const svg = renderChartSvg(block, data, { width: 360 });
    const shown = texts(svg);
    expect(shown.some((t) => /^\$[\d.]+[KM]? \d+(\.\d)?%$/.test(t ?? ""))).toBe(true);
    expect(shown.some((t) => /· Total \$[\d.]+[KM]?$/.test(t ?? ""))).toBe(true);
    const runtime = chartRuntimeData(block, ctx(data));
    expect(runtime.heads?.at(-1)).toMatch(/· Total \$/);
    expect(runtime.series[0]?.short.at(-1)).toMatch(/^\$[\d.]+[KM]? \d+(\.\d)?%$/);
  });
});
