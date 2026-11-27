import { describe, expect, it } from "vitest";
import { checkReferences } from "../../src/spec/index.js";
import { applyFix, DASHBOARD, projectFrom } from "./helpers.js";

describe("HM2018", () => {
  const withSpans = (line: number, bar: number, table: number) =>
    projectFrom({
      dashboards: {
        sales: {
          ...DASHBOARD,
          blocks: [
            { type: "line", metrics: ["revenue"], grain: "month", span: line },
            { type: "bar", metrics: ["orders"], by: "plan", span: bar },
            { type: "table", by: ["region"], metrics: ["revenue"], span: table },
          ],
        },
      },
    });

  it("warns on a line or bar chart narrower than 3 columns, with a safe fix to span 3", () => {
    const project = withSpans(1, 2, 1);
    const found = checkReferences(project).filter((d) => d.code === "HM2018");
    expect(found.map((d) => d.pointer)).toEqual(["/blocks/0/span", "/blocks/1/span"]);
    expect(found[0]).toMatchObject({
      severity: "warning",
      file: "dashboards/sales.json",
      message: "a line chart needs at least 3 of the 12 columns, but this one has span 1",
      fix: { text: "3", applicability: "safe" },
      docs: "hatchmark explain HM2018",
    });
    const fixed = applyFix(project.dashboards.get("sales")?.document.text ?? "", found[0]?.fix);
    expect(JSON.parse(fixed).blocks[0].span).toBe(3);
  });

  it("is quiet from span 3, and for tables and KPIs at any span", () => {
    expect(checkReferences(withSpans(3, 12, 1)).filter((d) => d.code === "HM2018")).toEqual([]);
  });
});
