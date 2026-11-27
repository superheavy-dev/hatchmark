import { describe, expect, it } from "vitest";
import { checkReferences, parseDiagnostics } from "../../src/spec/index.js";
import { applyFix, DASHBOARD, projectFrom } from "./helpers.js";

/** check's guards for stacked and 100% stacked bar and area blocks. */

const dashboard = (...blocks: unknown[]) => ({ sales: { ...DASHBOARD, filters: [], blocks } });
const refs = (...blocks: unknown[]) =>
  checkReferences(projectFrom({ dashboards: dashboard(...blocks) }));
const text = (block: unknown) =>
  `${JSON.stringify({ ...DASHBOARD, filters: [], blocks: [block] }, null, 2)}\n`;

describe("stack checks", () => {
  it("accepts stack true, false and percent, and rejects other values (HM3004)", () => {
    for (const stack of [true, false, "percent"]) {
      const project = projectFrom({
        dashboards: dashboard({
          type: "bar",
          metrics: ["revenue"],
          by: "plan",
          split: "region",
          stack,
        }),
      });
      expect(parseDiagnostics(project)).toEqual([]);
    }
    const bad = projectFrom({
      dashboards: dashboard({ type: "area", metrics: ["revenue"], grain: "month", stack: "100%" }),
    });
    expect(parseDiagnostics(bad).map((d) => d.code)).toContain("HM3004");
  });

  it("is quiet for 100% stacks of sums and counts", () => {
    expect(
      refs(
        { type: "bar", metrics: ["revenue"], by: "plan", split: "region", stack: "percent" },
        { type: "area", metrics: ["orders"], grain: "month", split: "plan", stack: "percent" },
        { type: "bar", metrics: ["net_revenue"], grain: "month", split: "plan", stack: "percent" },
      ),
    ).toEqual([]);
  });

  it("rejects a 100% stack of a ratio or a distinct count (HM4001) with a fix to a plain stack", () => {
    const block = {
      type: "bar",
      metrics: ["avg_order_value"],
      by: "plan",
      split: "region",
      stack: "percent",
    };
    const [d, ...rest] = refs(block);
    expect(rest).toEqual([]);
    expect(d).toMatchObject({
      code: "HM4001",
      severity: "error",
      pointer: "/blocks/0/metrics/0",
      message: 'a 100% stack is not meaningful for "avg_order_value"',
      label: "ratio does not add up across rows",
      fix: { text: "true", applicability: "unsafe" },
    });
    expect(applyFix(text(block), d?.fix)).toContain('"stack": true');
    const [distinct] = refs({
      type: "bar",
      metrics: ["merchants"],
      by: "plan",
      split: "plan",
      stack: "percent",
    });
    expect(distinct).toMatchObject({
      code: "HM4001",
      label: "count_distinct does not add up across rows",
    });
  });

  it("warns when a plain stack of a split or of several metrics does not add up (HM4060)", () => {
    const [d, ...rest] = refs({
      type: "bar",
      metrics: ["merchants"],
      by: "plan",
      split: "region",
      stack: true,
    });
    expect(rest).toEqual([]);
    expect(d).toMatchObject({
      code: "HM4060",
      severity: "warning",
      pointer: "/blocks/0/metrics/0",
      fix: { text: "false", applicability: "unsafe" },
    });
    expect(
      refs({ type: "bar", metrics: ["revenue", "avg_order_value"], by: "plan", stack: true }).map(
        (x) => [x.code, x.pointer],
      ),
    ).toEqual([["HM4060", "/blocks/0/metrics/1"]]);
  });

  it("warns when stacked metrics have different units (HM4060)", () => {
    const [d, ...rest] = refs({
      type: "bar",
      metrics: ["revenue", "orders"],
      by: "plan",
      stack: true,
    });
    expect(rest).toEqual([]);
    expect(d).toMatchObject({
      code: "HM4060",
      pointer: "/blocks/0/metrics",
      message: "stacked metrics are in different units (USD, number)",
    });
  });

  it("ignores a stack with nothing to stack and grouped bars of anything", () => {
    expect(
      refs(
        { type: "bar", metrics: ["merchants"], by: "plan", stack: true },
        { type: "bar", metrics: ["revenue", "orders"], by: "plan" },
        { type: "area", metrics: ["avg_order_value"], grain: "month", split: "plan" },
      ),
    ).toEqual([]);
  });

  it("checks the metrics of a 100% stack without a split too, per metric", () => {
    expect(
      refs({
        type: "bar",
        metrics: ["revenue", "avg_order_value"],
        by: "plan",
        stack: "percent",
      }).map((d) => d.code),
    ).toEqual(["HM4001"]);
  });
});
