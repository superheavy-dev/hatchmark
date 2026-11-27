import { describe, expect, it } from "vitest";
import { checkReferences } from "../../src/spec/index.js";
import { fromYaml } from "../yaml.js";
import { applyFix, DASHBOARD, projectFrom } from "./helpers.js";

describe("HM2024", () => {
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
    const found = checkReferences(project).filter((d) => d.code === "HM2024");
    expect(found.map((d) => d.pointer)).toEqual(["/blocks/0/span", "/blocks/1/span"]);
    expect(found[0]).toMatchObject({
      severity: "warning",
      file: "dashboards/sales.yaml",
      message: "a line chart needs at least 3 of the 12 columns, but this one has span 1",
      fix: { text: "3", applicability: "safe" },
      docs: "hatchmark explain HM2024",
    });
    const fixed = applyFix(project.dashboards.get("sales")?.document.text ?? "", found[0]?.fix);
    expect(fromYaml(fixed).blocks[0].span).toBe(3);
  });

  it("is quiet from span 3, and for tables and KPIs at any span", () => {
    expect(checkReferences(withSpans(3, 12, 1)).filter((d) => d.code === "HM2024")).toEqual([]);
  });
});

describe("HM2026", () => {
  const withTables = (blocks: Record<string, unknown>[]) =>
    projectFrom({ dashboards: { sales: { ...DASHBOARD, blocks } } });
  const table = (extra: Record<string, unknown>) => ({
    type: "table",
    by: ["region"],
    metrics: ["revenue"],
    ...extra,
  });
  const codes = (blocks: Record<string, unknown>[]) =>
    checkReferences(withTables(blocks))
      .filter((d) => d.code === "HM2026")
      .map((d) => [d.pointer, d.severity]);

  it('warns on "overflow": "page" for a table that shares its grid row', () => {
    expect(
      codes([
        table({ span: 8, overflow: "page" }),
        { type: "bar", metrics: ["orders"], by: "plan", span: 4 },
      ]),
    ).toEqual([["/blocks/0/overflow", "warning"]]);
  });

  it("counts a strip of KPIs as one card and a narrow chart at its drawn width", () => {
    expect(
      codes([
        { type: "kpi", metric: "revenue" },
        { type: "kpi", metric: "orders" },
        table({ span: 6, overflow: "page" }),
        { type: "line", metrics: ["revenue"], grain: "month", span: 1 },
        table({ span: 9, overflow: "page" }),
      ]),
    ).toEqual([
      ["/blocks/2/overflow", "warning"],
      ["/blocks/4/overflow", "warning"],
    ]);
  });

  it("counts pie, donut and scatter charts as cards that share the row", () => {
    expect(
      codes([
        table({ span: 8, overflow: "page" }),
        { type: "pie", metric: "revenue", by: "region", span: 4 },
        table({ span: 6, overflow: "page" }),
        { type: "scatter", x: "orders", y: "revenue", by: "region", span: 6 },
      ]),
    ).toEqual([
      ["/blocks/0/overflow", "warning"],
      ["/blocks/2/overflow", "warning"],
    ]);
  });

  it("is quiet for a table alone in its row, for scroll, and for the default", () => {
    expect(
      codes([
        table({ overflow: "page" }),
        table({ span: 6, overflow: "page" }),
        table({ span: 12 }),
        table({ span: 6, overflow: "scroll" }),
        { type: "bar", metrics: ["orders"], by: "plan", span: 6 },
        table({ span: 4 }),
      ]),
    ).toEqual([]);
  });
});
