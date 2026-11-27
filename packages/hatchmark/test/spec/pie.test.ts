import { describe, expect, it } from "vitest";
import { checkReferences, parseDiagnostics } from "../../src/spec/index.js";
import { applyFix, DASHBOARD, projectFrom } from "./helpers.js";

/** check's guards for pie and donut blocks. */

const dashboard = (...blocks: unknown[]) => ({ sales: { ...DASHBOARD, filters: [], blocks } });
const refs = (...blocks: unknown[]) =>
  checkReferences(projectFrom({ dashboards: dashboard(...blocks) }));
const text = (block: unknown) =>
  `${JSON.stringify({ ...DASHBOARD, filters: [], blocks: [block] }, null, 2)}\n`;

describe("pie checks", () => {
  it("accepts pie and donut with a limit of 1 to 12, and rejects other limits", () => {
    for (const type of ["pie", "donut"]) {
      for (const limit of [undefined, 1, 6]) {
        const project = projectFrom({
          dashboards: dashboard({
            type,
            metric: "revenue",
            by: "plan",
            ...(limit ? { limit } : {}),
          }),
        });
        expect(parseDiagnostics(project)).toEqual([]);
        expect(checkReferences(project)).toEqual([]);
      }
    }
    for (const limit of [0, 13, 2.5]) {
      const bad = projectFrom({
        dashboards: dashboard({ type: "pie", metric: "revenue", by: "plan", limit }),
      });
      expect(parseDiagnostics(bad).map((d) => [d.severity, d.pointer])).toEqual([
        ["error", "/blocks/0/limit"],
      ]);
    }
  });

  it("rejects a ratio or a distinct count (HM4001)", () => {
    const [ratio, ...rest] = refs({ type: "pie", metric: "avg_order_value", by: "plan" });
    expect(rest).toEqual([]);
    expect(ratio).toMatchObject({
      code: "HM4001",
      severity: "error",
      pointer: "/blocks/0/metric",
      message: 'a pie is not meaningful for "avg_order_value"',
      label: "ratio does not add up across rows",
    });
    const [distinct] = refs({ type: "donut", metric: "merchants", by: "plan" });
    expect(distinct).toMatchObject({
      code: "HM4001",
      message: 'a donut is not meaningful for "merchants"',
      label: "count_distinct does not add up across rows",
    });
  });

  it("warns on more than 6 slices (HM5010) with a fix to 6 that leaves check quiet", () => {
    const block = { type: "pie", metric: "revenue", by: "plan", limit: 10 };
    const [d, ...rest] = refs(block);
    expect(rest).toEqual([]);
    expect(d).toMatchObject({
      code: "HM5010",
      severity: "warning",
      pointer: "/blocks/0/limit",
      fix: { applicability: "unsafe" },
    });
    const fixed = applyFix(text(block), d?.fix);
    expect(fixed).toContain('"limit": 6');
    expect(refs(JSON.parse(fixed).blocks[0])).toEqual([]);
  });
});
