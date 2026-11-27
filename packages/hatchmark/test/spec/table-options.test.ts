import { describe, expect, it } from "vitest";
import { checkReferences, parseSpecFile } from "../../src/spec/index.js";
import { fromYaml } from "../yaml.js";
import { applyFix, DASHBOARD, METRICS, projectFrom } from "./helpers.js";

const columns = {
  orders: ["region", "country", "amount", "status", "ordered_at"],
  merchants: ["region", "country", "merchant_id"],
};

function schema(block: Record<string, unknown>) {
  const text = JSON.stringify({ ...DASHBOARD, blocks: [{ type: "table", ...block }] }, null, 2);
  return parseSpecFile("dashboard", "dashboards/x.yaml", text).diagnostics;
}

function refs(block: Record<string, unknown>) {
  const project = projectFrom({
    columns,
    dashboards: { sales: { ...DASHBOARD, blocks: [{ type: "table", ...block }] } },
  });
  return {
    diagnostics: checkReferences(project),
    text: project.dashboards.get("sales")?.document.text ?? "",
  };
}

describe("table options", () => {
  it("accepts every option together on a two-column table", () => {
    const block = {
      by: ["region", "country"],
      metrics: ["revenue", "orders"],
      percentOfTotal: ["revenue"],
      sort: { by: "revenue", order: "desc" },
      limit: 5,
      other: true,
      subtotals: true,
      bars: ["revenue", "orders"],
    };
    expect(schema(block)).toEqual([]);
    expect(refs(block).diagnostics).toEqual([]);
  });

  it("needs a limit for other (HM3007)", () => {
    const [d, ...rest] = schema({ by: ["country"], metrics: ["revenue"], other: true });
    expect(rest).toEqual([]);
    expect(d).toMatchObject({ code: "HM3007", pointer: "/blocks/0/other" });
    expect(d?.message).toContain('set "limit"');
  });

  it("needs two by columns for subtotals (HM3007)", () => {
    const [d, ...rest] = schema({ by: ["country"], metrics: ["revenue"], subtotals: true });
    expect(rest).toEqual([]);
    expect(d).toMatchObject({ code: "HM3007", pointer: "/blocks/0/subtotals" });
  });

  it("names a bar metric the table does not show (HM2006)", () => {
    const { diagnostics } = refs({ by: ["country"], metrics: ["revenue"], bars: ["orders"] });
    expect(diagnostics.map((d) => [d.code, d.pointer])).toEqual([["HM2006", "/blocks/0/bars/0"]]);
    expect(diagnostics[0]?.message).toBe('"orders" is in bars but not in metrics');
  });

  it("warns when Other cannot fold a metric, once per metric, and offers other: false (HM4063)", () => {
    const block = {
      by: ["country"],
      metrics: ["revenue", "merchants", "avg_order_value"],
      limit: 3,
      other: true,
    };
    const { diagnostics, text } = refs(block);
    expect(diagnostics.map((d) => [d.code, d.severity, d.pointer])).toEqual([
      ["HM4063", "warning", "/blocks/0/other"],
    ]);
    expect(diagnostics[0]?.message).toBe('the Other row cannot be computed for "merchants"');
    const fixed = fromYaml(applyFix(text, diagnostics[0]?.fix));
    expect(fixed.blocks[0].other).toBe(false);
    expect(refs({ ...block, other: false }).diagnostics).toEqual([]);
    expect(refs({ ...block, limit: undefined, other: undefined }).diagnostics).toEqual([]);
  });

  it("treats ratios of foldable metrics as foldable, and SQL by its additive flag", () => {
    const metrics = {
      ...METRICS,
      net: {
        label: "Net",
        type: "sql",
        table: "orders",
        sql: "sum(amount) - 1",
        additive: false,
        format: { type: "number" },
        better: "up",
      },
    };
    const project = projectFrom({
      columns,
      metrics,
      dashboards: {
        sales: {
          ...DASHBOARD,
          blocks: [
            {
              type: "table",
              by: ["country"],
              metrics: ["avg_order_value", "net"],
              limit: 2,
              other: true,
            },
          ],
        },
      },
    });
    const ds = checkReferences(project).filter((d) => d.code === "HM4063");
    expect(ds.map((d) => d.message)).toEqual(['the Other row cannot be computed for "net"']);
  });

  for (const key of ["pagination", "pageSize", "page", "per_page", "offset"]) {
    it(`explains that tables do not paginate when an agent writes "${key}"`, () => {
      const [d] = schema({ by: ["country"], metrics: ["revenue"], [key]: 25 });
      expect(d).toMatchObject({ code: "HM3002", pointer: `/blocks/0/${key}` });
      expect(d?.help).toContain("tables do not paginate");
      expect(d?.help).toContain('"other": true');
      expect(d?.fix).toBeUndefined();
    });
  }

  it("keeps the usual rename hint for a misspelled table option", () => {
    const [d] = schema({ by: ["country"], metrics: ["revenue"], subtotal: true });
    expect(d).toMatchObject({ code: "HM3002", help: 'did you mean "subtotals"?' });
  });

  it("does not call a page key pagination on other blocks", () => {
    const text = JSON.stringify({
      ...DASHBOARD,
      blocks: [{ type: "kpi", metric: "revenue", page: 2 }],
    });
    const [d] = parseSpecFile("dashboard", "dashboards/x.yaml", text).diagnostics;
    expect(d?.code).toBe("HM3002");
    expect(d?.help ?? "").not.toContain("paginate");
  });
});
