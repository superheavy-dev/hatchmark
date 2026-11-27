import { describe, expect, it } from "vitest";
import { CODES } from "../../src/diagnostics/index.js";
import { checkReferences, parseDiagnostics } from "../../src/spec/index.js";
import { DASHBOARD, projectFrom } from "./helpers.js";

/** The scatter block's schema and check's guards for it. */

const dashboard = (...blocks: unknown[]) => ({ sales: { ...DASHBOARD, filters: [], blocks } });
const project = (...blocks: unknown[]) => projectFrom({ dashboards: dashboard(...blocks) });
const refs = (...blocks: unknown[]) => checkReferences(project(...blocks));
const scatter = (extra: Record<string, unknown> = {}) => ({
  type: "scatter",
  title: "Bigger markets do not mean bigger baskets",
  x: "orders",
  y: "avg_order_value",
  by: "country",
  size: "revenue",
  ...extra,
});

describe("scatter checks", () => {
  it("accepts x, y, by, size and limit, and needs no time column", () => {
    const ok = project(scatter({ limit: 50 }), scatter({ size: undefined, x: "merchants" }));
    expect(parseDiagnostics(ok)).toEqual([]);
    expect(checkReferences(ok)).toEqual([]);
  });

  it("rejects a missing by, an unknown property and a limit past 500", () => {
    const codes = (extra: Record<string, unknown>) =>
      parseDiagnostics(project(scatter(extra))).map((d) => [d.code, d.pointer]);
    expect(codes({ by: undefined })).toEqual([["HM3001", "/blocks/0/by"]]);
    expect(codes({ metrics: ["revenue"] })).toEqual([["HM3002", "/blocks/0/metrics"]]);
    expect(codes({ limit: 501 })).toEqual([["HM3005", "/blocks/0/limit"]]);
    expect(codes({ limit: 0 })).toEqual([["HM3005", "/blocks/0/limit"]]);
  });

  it("reports unknown metrics on every axis (HM2003)", () => {
    const found = refs(scatter({ x: "order", size: "revenu" }));
    expect(found.map((d) => [d.code, d.pointer, d.help])).toEqual([
      ["HM2003", "/blocks/0/x", 'did you mean "orders"?'],
      ["HM2003", "/blocks/0/size", 'did you mean "revenue"?'],
    ]);
  });

  it("warns when both axes show the same metric (HM5020)", () => {
    const [d, ...rest] = refs(scatter({ y: "orders", size: undefined }));
    expect(rest).toEqual([]);
    expect(d).toMatchObject({
      code: "HM5020",
      severity: "warning",
      pointer: "/blocks/0/y",
      message: 'both axes show "orders", so every point sits on one diagonal',
    });
  });

  it("warns when size repeats an axis metric (HM5021)", () => {
    for (const [size, axis] of [
      ["orders", "x"],
      ["avg_order_value", "y"],
    ]) {
      const [d, ...rest] = refs(scatter({ size }));
      expect(rest).toEqual([]);
      expect(d).toMatchObject({
        code: "HM5021",
        severity: "warning",
        pointer: "/blocks/0/size",
        message: `size repeats the ${axis} metric "${size}", so bubble size adds nothing`,
      });
    }
  });

  it("widens a scatter narrower than 3 columns (HM2024)", () => {
    const [d] = refs(scatter({ span: 2 }));
    expect(d).toMatchObject({ code: "HM2024", pointer: "/blocks/0/span", severity: "warning" });
  });

  it("explains each scatter code with the fix", () => {
    for (const code of ["HM4070", "HM4071", "HM5020", "HM5021", "HM5022"] as const) {
      expect(CODES[code].explanation.length).toBeGreaterThan(200);
    }
    expect(CODES.HM5022.explanation).toContain('"limit"');
    expect(CODES.HM4071.explanation).toContain("smallest size");
  });
});
