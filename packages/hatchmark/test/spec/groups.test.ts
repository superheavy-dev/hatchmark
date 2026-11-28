import { describe, expect, it } from "vitest";
import { checkReferences, parseDiagnostics } from "../../src/spec/index.js";
import { GROUP_MAX_COUNT, GROUP_MAX_SIZE } from "../../src/spec/units.js";
import { fromYaml, toYaml } from "../yaml.js";
import { applyFix, DASHBOARD, projectFrom } from "./helpers.js";

const dashboard = (...blocks: unknown[]) => ({ sales: { ...DASHBOARD, filters: [], blocks } });
const project = (...blocks: unknown[]) => projectFrom({ dashboards: dashboard(...blocks) });
const refs = (...blocks: unknown[]) => checkReferences(project(...blocks));
const text = (block: unknown) => toYaml({ ...DASHBOARD, filters: [], blocks: [block] });
const afterFix = (block: unknown, fix: Parameters<typeof applyFix>[1]) =>
  refs(...(fromYaml(applyFix(text(block), fix)) as { blocks: unknown[] }).blocks);
const line = (groups: unknown, extra: Record<string, unknown> = {}) => ({
  type: "line",
  metrics: ["revenue", "net_revenue", "orders"],
  grain: "month",
  groups,
  ...extra,
});

describe("series groups", () => {
  it("accepts groups on line, area and bar, with metrics or a split", () => {
    const ok = [
      line([{ label: "Revenue", series: ["revenue", "net_revenue"] }]),
      {
        ...line([{ label: "Revenue", series: ["revenue", "net_revenue"] }], {
          metrics: ["revenue", "net_revenue"],
        }),
        type: "area",
        stack: true,
      },
      {
        type: "bar",
        metrics: ["revenue", "net_revenue"],
        by: "plan",
        stack: "percent",
        groups: [{ label: "Revenue", series: ["revenue", "net_revenue"] }],
      },
      {
        type: "bar",
        metrics: ["revenue"],
        grain: "month",
        split: "plan",
        groups: [{ label: "Paid plans", series: ["Pro", "Business", 2026] }],
      },
    ];
    for (const block of ok) {
      const p = project(block);
      expect(parseDiagnostics(p)).toEqual([]);
      expect(checkReferences(p)).toEqual([]);
    }
  });

  it("rejects groups on blocks without series, empty groups and one-series groups", () => {
    const shapes = [
      { type: "pie", metric: "revenue", by: "plan", groups: [{ label: "A", series: ["x", "y"] }] },
      line([]),
      line([{ label: "Revenue", series: ["revenue"] }]),
      line([{ series: ["revenue", "net_revenue"] }]),
      line([{ label: "", series: ["revenue", "net_revenue"] }]),
    ];
    for (const block of shapes) {
      expect(parseDiagnostics(project(block)).map((d) => d.severity)).toContain("error");
    }
  });

  it("rejects a group on a single-series chart (HM5031)", () => {
    const [d, ...rest] = refs({
      type: "line",
      metrics: ["revenue"],
      grain: "month",
      groups: [{ label: "Revenue", series: ["revenue", "net_revenue"] }],
    });
    expect(rest).toEqual([]);
    expect(d).toMatchObject({
      code: "HM5031",
      severity: "error",
      pointer: "/blocks/0/groups",
      message: "groups need a chart with two or more series",
    });
  });

  it("names an unknown metric with a suggestion (HM2027)", () => {
    const block = line([{ label: "Revenue", series: ["revenue", "net_revenu"] }]);
    const [d, ...rest] = refs(block);
    expect(rest).toEqual([]);
    expect(d).toMatchObject({
      code: "HM2027",
      severity: "error",
      pointer: "/blocks/0/groups/0/series/1",
      message: 'group "Revenue" names "net_revenu", which this chart does not draw',
      help: 'did you mean "net_revenue"?',
      expected: ["revenue", "net_revenue", "orders"],
    });
    expect(afterFix(block, d?.fix)).toEqual([]);
  });

  it("leaves split values to the build", () => {
    expect(
      refs({
        type: "line",
        metrics: ["revenue"],
        grain: "month",
        split: "plan",
        groups: [{ label: "Paid", series: ["no-such-plan", "Pro"] }],
      }),
    ).toEqual([]);
  });

  it("rejects a series in two groups or twice in one (HM3011), with a fix", () => {
    const block = line([
      { label: "Revenue", series: ["revenue", "net_revenue"] },
      { label: "Other", series: ["orders", "revenue"] },
    ]);
    const [d, ...rest] = refs(block);
    expect(rest).toEqual([]);
    expect(d).toMatchObject({
      code: "HM3011",
      severity: "error",
      pointer: "/blocks/0/groups/1/series/1",
      message: '"revenue" is already in group "Revenue"',
    });
    expect(afterFix(block, d?.fix)).toEqual([]);
    const [twice] = refs(
      line([{ label: "Revenue", series: ["revenue", "net_revenue", "revenue"] }]),
    );
    expect(twice).toMatchObject({
      code: "HM3011",
      message: '"revenue" is listed twice in group "Revenue"',
    });
  });

  it("tells two groups with the same label apart (HM3011)", () => {
    const [d] = refs(
      line([
        { label: "Revenue", series: ["revenue", "net_revenue"] },
        { label: "Revenue", series: ["orders", "revenue"] },
      ]),
    );
    expect(d).toMatchObject({ code: "HM3011", message: '"revenue" is already in group "Revenue"' });
  });

  it("rejects a group larger than a hue family (HM5030)", () => {
    const metrics = ["revenue", "net_revenue", "orders", "avg_order_value", "merchants"];
    const series = metrics.slice(0, GROUP_MAX_SIZE + 1);
    const ds = refs({ type: "bar", metrics, by: "plan", groups: [{ label: "Big", series }] });
    expect(ds.map((d) => [d.code, d.pointer, d.message])).toEqual([
      [
        "HM5030",
        "/blocks/0/groups/0/series",
        `group "Big" has ${series.length} series; a group holds at most ${GROUP_MAX_SIZE}`,
      ],
    ]);
  });

  it("rejects more groups than hue families (HM5032)", () => {
    const groups = Array.from({ length: GROUP_MAX_COUNT + 1 }, (_, i) => ({
      label: `G${i}`,
      series: [`v${i}a`, `v${i}b`],
    }));
    const ds = refs({ type: "bar", metrics: ["revenue"], by: "plan", split: "region", groups });
    expect(ds.map((d) => [d.code, d.pointer, d.message])).toEqual([
      [
        "HM5032",
        "/blocks/0/groups",
        `${groups.length} groups are more than the ${GROUP_MAX_COUNT} hue families a chart can give groups`,
      ],
    ]);
  });
});
