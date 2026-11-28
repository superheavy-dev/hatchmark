import { describe, expect, it } from "vitest";
import type { BarData, LineData, Series } from "../../src/compiler/dashboard-data.js";
import { chartRuntimeData, chartTable, describeChart } from "../../src/render/describe.js";
import {
  colorValue,
  cssPaint,
  DEFAULT_THEME,
  groupColorKeys,
  hexPaint,
  type RenderContext,
  renderChartSvg,
  seriesPaints,
  type Theme,
} from "../../src/render/index.js";
import { GROUP_MAX_COUNT, GROUP_MAX_SIZE } from "../../src/spec/units.js";

const steps = (prefix: string) => ["1", "2", "3"].map((s) => `#${prefix}000${s}`);
const FIXTURE: Theme = {
  ...DEFAULT_THEME,
  groups: {
    dash: null,
    families: [
      {
        name: "first",
        slots: [1, 5],
        stroke: { light: steps("a1"), dark: steps("d1") },
        fill: { light: steps("b1"), dark: steps("e1") },
      },
      {
        name: "second",
        slots: [2, 6, 8],
        stroke: { light: steps("a2"), dark: steps("d2") },
        fill: { light: steps("b2"), dark: steps("e2") },
      },
    ],
  },
};

const tagged = (groups: ({ index: number; step: number } | undefined)[]) =>
  groups.map((group) => (group === undefined ? {} : { group }));

describe("series paints", () => {
  it("lets the spec allow exactly what the Default theme can colour", () => {
    const families = DEFAULT_THEME.groups?.families ?? [];
    expect(families).toHaveLength(GROUP_MAX_COUNT);
    for (const f of families) {
      for (const mode of ["light", "dark"] as const) {
        expect(f.stroke[mode]).toHaveLength(GROUP_MAX_SIZE);
        expect(f.fill[mode]).toHaveLength(GROUP_MAX_SIZE);
      }
    }
  });

  it("gives series without groups the categorical slots in order, wrapping after 8", () => {
    const paints = seriesPaints(FIXTURE, tagged(Array.from({ length: 10 }, () => undefined)));
    expect(paints.map((p) => p.stroke)).toEqual([
      "c1",
      "c2",
      "c3",
      "c4",
      "c5",
      "c6",
      "c7",
      "c8",
      "c1",
      "c2",
    ]);
    expect(paints.map((p) => p.fill)).toEqual([
      "f1",
      "f2",
      "f3",
      "f4",
      "f5",
      "f6",
      "f7",
      "f8",
      "f1",
      "f2",
    ]);
    expect(paints.every((p) => !p.secondary)).toBe(true);
  });

  it("gives a group its family's steps and ungrouped series the slots outside held families", () => {
    const paints = seriesPaints(
      FIXTURE,
      tagged([
        { index: 0, step: 0 },
        { index: 0, step: 1 },
        { index: 0, step: 2 },
        undefined,
        undefined,
      ]),
    );
    expect(paints.map((p) => [p.stroke, p.fill, p.secondary])).toEqual([
      ["cg1-1", "fg1-1", false],
      ["cg1-2", "fg1-2", true],
      ["cg1-3", "fg1-3", true],
      ["c2", "f2", false],
      ["c3", "f3", false],
    ]);
  });

  it("holds every group's family and skips all their slots", () => {
    const paints = seriesPaints(
      FIXTURE,
      tagged([
        undefined,
        { index: 1, step: 0 },
        { index: 1, step: 1 },
        undefined,
        { index: 0, step: 0 },
        undefined,
        undefined,
        undefined,
      ]),
    );
    expect(paints.map((p) => p.stroke)).toEqual([
      "c3",
      "cg2-1",
      "cg2-2",
      "c4",
      "cg1-1",
      "c7",
      "c3",
      "c4",
    ]);
  });

  it("is deterministic and follows the step, not the position", () => {
    const a = seriesPaints(FIXTURE, tagged([{ index: 0, step: 2 }, undefined]));
    const b = seriesPaints(FIXTURE, tagged([{ index: 0, step: 2 }, undefined]));
    expect(a).toEqual(b);
    expect(a[0]?.stroke).toBe("cg1-3");
  });

  it("falls back to the plain slots when the theme has no families", () => {
    const bare: Theme = { ...DEFAULT_THEME, groups: { dash: null, families: [] } };
    const paints = seriesPaints(bare, tagged([{ index: 0, step: 1 }, undefined]));
    expect(paints.map((p) => p.stroke)).toEqual(["c1", "c2"]);
  });

  it("resolves group keys per mode and lists every key the theme defines", () => {
    expect(colorValue(FIXTURE, "light", "cg2-3")).toBe("#a20003");
    expect(colorValue(FIXTURE, "dark", "fg1-1")).toBe("#e10001");
    expect(groupColorKeys(FIXTURE)).toHaveLength(12);
    expect(hexPaint(FIXTURE, "dark").attrs("fg2-2")).toBe(' fill="#e20002"');
    expect(cssPaint.attrs(undefined, "cg1-2")).toBe(' class="hm-s-cg1-2"');
  });
});

function series(key: string, label: string, values: number[], group?: Series["group"]): Series {
  return { key, metric: "revenue", label, values, ...(group ? { group } : {}) };
}

const DATA = {
  version: 2,
  title: "Groups",
  project: "Test",
  locale: "en-US",
  asOf: "2026-06-30",
  metrics: {
    revenue: { name: "revenue", label: "Revenue", format: { type: "number" }, better: "up" },
  },
} as unknown as RenderContext["data"];

const BAR: BarData = {
  id: "b",
  type: "bar",
  span: 12,
  orientation: "vertical",
  stack: false,
  axis: { kind: "category", column: "region", categories: ["US", "EU"] },
  groups: [{ label: "Revenue" }],
  series: [
    series("actual", "Actual", [5, 6], { index: 0, step: 0 }),
    series("target", "Target", [4, 7], { index: 0, step: 1 }),
    series("cost", "Cost", [2, 3]),
  ],
};

describe("grouped charts", () => {
  const ctx: RenderContext = { data: { ...DATA, blocks: [BAR] }, theme: FIXTURE, paint: cssPaint };

  it("names the group before its members in the key", () => {
    const svg = renderChartSvg(BAR, ctx.data, { width: 600, theme: FIXTURE });
    const key = svg.slice(svg.indexOf('<g class="hm-key">'), svg.indexOf("</g>"));
    expect(key.indexOf(">Revenue<")).toBeGreaterThan(-1);
    expect(key.indexOf(">Revenue<")).toBeLessThan(key.indexOf(">Actual<"));
    expect(key).toContain('fill="#b10001"');
    expect(key).toContain('fill="#b10002"');
    expect(key).toContain(`fill="${colorValue(FIXTURE, "light", "f2")}"`);
  });

  it("heads the data table with the group over its members", () => {
    const table = chartTable(BAR, ctx, "Groups");
    expect(table).toContain(
      '<thead><tr><th scope="col" rowspan="2">region</th><th scope="colgroup" colspan="2">Revenue</th><th scope="col" rowspan="2">Cost</th></tr><tr><th scope="col">Actual</th><th scope="col">Target</th></tr></thead>',
    );
    expect(describeChart(BAR, ctx)).toMatch(
      /^Bar chart, grouped of Revenue \(Actual, Target\), Cost by region/,
    );
  });

  it("gives the runtime group colours and names", () => {
    const runtime = chartRuntimeData(BAR, ctx);
    expect(runtime.groups).toEqual(["Revenue"]);
    expect(runtime.series.map((s) => [s.color, s.group])).toEqual([
      ["g1-1", 0],
      ["g1-2", 0],
      [2, undefined],
    ]);
  });

  it("dashes secondary lines only when the theme sets a dash", () => {
    const line: LineData = {
      id: "l",
      type: "line",
      span: 12,
      axis: {
        kind: "time",
        grain: "month",
        buckets: ["2026-01-01", "2026-02-01", "2026-03-01"],
        window: { start: "2026-01-01", end: "2026-04-01" },
      },
      groups: [{ label: "Revenue" }],
      series: [
        series("actual", "Actual", [5, 6, 7], { index: 0, step: 0 }),
        series("target", "Target", [4, 7, 8], { index: 0, step: 1 }),
      ],
    };
    const data = { ...DATA, blocks: [line] };
    const plain = renderChartSvg(line, data, { width: 600, theme: FIXTURE });
    expect(plain).not.toContain("stroke-dasharray");
    const dashed: Theme = {
      ...FIXTURE,
      groups: { ...(FIXTURE.groups as NonNullable<Theme["groups"]>), dash: "4 2" },
    };
    const svg = renderChartSvg(line, data, { width: 600, theme: dashed });
    expect(svg.match(/stroke-dasharray="4 2"/g)).toHaveLength(1);
    expect(svg).toContain('stroke="#a10002" stroke-dasharray="4 2"');
  });
});
