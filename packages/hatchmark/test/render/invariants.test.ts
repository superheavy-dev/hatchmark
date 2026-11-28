import { describe, expect, it } from "vitest";
import type { DashboardData, LineData } from "../../src/compiler/dashboard-data.js";
import { renderChartSvg } from "../../src/render/index.js";

const data = {
  locale: "en-US",
  metrics: { v: { name: "v", label: "Value", format: { type: "number" }, better: "neutral" } },
} as unknown as DashboardData;

const line = (arrays: (number | null)[][], overrides: Partial<LineData> = {}): LineData =>
  ({
    id: "proof",
    type: "line",
    span: 12,
    axis: {
      kind: "time",
      grain: "month",
      buckets: ["2026-01-01", "2026-02-01"],
      window: { start: "2026-01-01", end: "2026-03-01" },
    },
    series: arrays.map((values, i) => ({
      metric: "v",
      key: `s${i}`,
      label: `Series ${i}`,
      values,
    })),
    ...overrides,
  }) as LineData;

const texts = (svg: string) =>
  [...svg.matchAll(/<text[^>]*>(?:<title>[^<]*<\/title>)?([^<]*)<\/text>/g)].map((m) => m[1]);
const paths = (svg: string) => [...svg.matchAll(/<path d="([^"]+)"/g)].map((m) => m[1] as string);
const ys = (d: string) => [...d.matchAll(/[MLH]?[\d.]+,([\d.]+)/g)].map((m) => Number(m[1]));

describe("renderer invariants", () => {
  it("titles the pinned readout and its values with the same bucket", () => {
    const svg = renderChartSvg(
      line([
        [10, null],
        [20, 30],
      ]),
      data,
      { width: 324 },
    );
    const readout = svg.slice(svg.indexOf('class="hm-readout"'), svg.indexOf("</g>"));
    expect(texts(readout)).toEqual(["Feb 2026", "Series 0", "\u2014", "Series 1", "30"]);
  });

  it("draws no stacked band where every value is missing, and says so", () => {
    const svg = renderChartSvg(
      line(
        [
          [null, null],
          [null, null],
        ],
        { type: "area", stack: true },
      ),
      data,
      {
        width: 324,
      },
    );
    expect(paths(svg)).toEqual([]);
    expect(texts(svg)).toContain("No value in this period");
  });

  it("stacks negative values below zero and positive values above it", () => {
    const svg = renderChartSvg(
      line(
        [
          [100, 100],
          [-100, -100],
        ],
        { type: "area", stack: true },
      ),
      data,
      {
        width: 324,
      },
    );
    const [d0, d1, bottom, top] = (svg.match(/data-hm-y="([^"]+)"/)?.[1] ?? "")
      .split(",")
      .map(Number);
    const zero =
      (bottom as number) -
      ((0 - (d0 as number)) / ((d1 as number) - (d0 as number))) *
        ((bottom as number) - (top as number));
    const [negativeFill, positiveFill] = paths(svg);
    expect(Math.min(...ys(negativeFill as string))).toBeGreaterThanOrEqual(zero - 0.1);
    expect(Math.max(...ys(positiveFill as string))).toBeLessThanOrEqual(zero + 0.1);
    expect(Math.max(...ys(negativeFill as string))).toBeGreaterThan(zero + 1);
  });

  it("gives every y tick a distinct label, however small the range", () => {
    const svg = renderChartSvg(line([[1e-6, 2e-6]]), data, { width: 324 });
    const ticks = [...svg.matchAll(/text-anchor="end"[^>]*>([^<]*)</g)].map((m) => m[1]);
    expect(ticks.length).toBeGreaterThanOrEqual(3);
    expect(new Set(ticks).size).toBe(ticks.length);
  });

  it("keeps geometry finite and inside the chart for the extremes of the number range", () => {
    const svg = renderChartSvg(line([[-1e308, 1e308]]), data, { width: 324 });
    expect(svg).not.toMatch(/NaN|Infinity/);
    for (const m of svg.matchAll(/ (?:x|x1|x2|cx)="([^"]+)"/g)) {
      expect(Number(m[1])).toBeGreaterThanOrEqual(0);
      expect(Number(m[1])).toBeLessThanOrEqual(324);
    }
    for (const d of paths(svg)) {
      for (const m of d.matchAll(/([\d.]+),/g)) expect(Number(m[1])).toBeLessThanOrEqual(324);
    }
  });
});
