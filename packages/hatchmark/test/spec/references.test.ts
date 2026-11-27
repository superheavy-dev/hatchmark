import { describe, expect, it } from "vitest";
import {
  checkReferences,
  dashboardDependencies,
  dashboardsAffectedBy,
} from "../../src/spec/index.js";
import { applyFix, CONFIG, DASHBOARD, METRICS, projectFrom } from "./helpers.js";

function refs(files: Parameters<typeof projectFrom>[0]) {
  return checkReferences(projectFrom(files));
}

const withBlocks = (...blocks: unknown[]) => ({ sales: { ...DASHBOARD, blocks } });

describe("checkReferences", () => {
  it("is clean for the sample project", () => {
    expect(refs({})).toEqual([]);
  });

  it("reports an unknown metric with suggestions", () => {
    const [d, ...rest] = refs({ dashboards: withBlocks({ type: "kpi", metric: "revenu" }) });
    expect(rest).toEqual([]);
    expect(d).toMatchObject({
      code: "HM2003",
      file: "dashboards/sales.json",
      pointer: "/blocks/0/metric",
      label: "no file metrics/revenu.json",
      help: 'did you mean "revenue"?',
      fix: { text: '"revenue"', applicability: "unsafe" },
    });
    expect(d?.expected).toEqual(Object.keys(METRICS));
  });

  it("reports an unknown source", () => {
    const metrics = { ...METRICS, orders: { ...(METRICS.orders as object), table: "order" } };
    expect(refs({ metrics })).toMatchObject([
      {
        code: "HM2001",
        file: "metrics/orders.json",
        pointer: "/table",
        help: 'did you mean "orders"?',
      },
    ]);
  });

  it("reports ratio references and cycles", () => {
    const metrics = {
      ...METRICS,
      a: {
        label: "A",
        type: "ratio",
        numerator: "b",
        denominator: "orders",
        format: { type: "number" },
        better: "up",
      },
      b: {
        label: "B",
        type: "ratio",
        numerator: "a",
        denominator: "nope",
        format: { type: "number" },
        better: "up",
      },
    };
    const ds = refs({ metrics, dashboards: {} }).map((d) => [d.file, d.code, d.pointer]);
    expect(ds).toEqual([
      ["metrics/a.json", "HM2004", "/numerator"],
      ["metrics/b.json", "HM2004", "/numerator"],
      ["metrics/b.json", "HM2003", "/denominator"],
    ]);
  });

  it("requires a time column where a block needs one", () => {
    const ds = refs({
      dashboards: withBlocks(
        { type: "kpi", metric: "merchants" },
        { type: "kpi", metric: "merchants", compare: "none" },
        { type: "line", metrics: ["merchants"], grain: "month" },
        { type: "bar", metrics: ["merchants"], by: "plan" },
        { type: "bar", metrics: ["merchants"], grain: "month" },
        { type: "kpi", metric: "avg_order_value" },
      ),
    });
    expect(ds.map((d) => [d.code, d.pointer])).toEqual([
      ["HM2005", "/blocks/0/metric"],
      ["HM2005", "/blocks/2/metrics/0"],
      ["HM2005", "/blocks/4/metrics/0"],
    ]);
    expect(ds[0]?.help).toContain('"compare": "none"');
  });

  it("allows percent of total only for additive metrics in the table", () => {
    const table = (percentOfTotal: string[]) => ({
      type: "table",
      by: ["country"],
      metrics: ["revenue", "orders", "avg_order_value", "merchants", "net_revenue"],
      percentOfTotal,
    });
    expect(refs({ dashboards: withBlocks(table(["revenue", "orders", "net_revenue"])) })).toEqual(
      [],
    );
    const ds = refs({
      dashboards: withBlocks(table(["avg_order_value", "merchants"]), {
        type: "table",
        by: ["country"],
        metrics: ["orders"],
        percentOfTotal: ["revenue"],
      }),
    });
    expect(ds.map((d) => [d.code, d.pointer])).toEqual([
      ["HM4001", "/blocks/0/percentOfTotal/0"],
      ["HM4001", "/blocks/0/percentOfTotal/1"],
      ["HM2006", "/blocks/1/percentOfTotal/0"],
    ]);
    expect(ds[1]?.label).toBe("count_distinct does not add up across rows");
    const text =
      projectFrom({
        dashboards: withBlocks(table(["avg_order_value", "merchants"])),
      }).dashboards.get("sales")?.document.text ?? "";
    const [first] = refs({ dashboards: withBlocks(table(["avg_order_value", "merchants"])) });
    const fixed = JSON.parse(applyFix(text, first?.fix));
    expect(fixed.blocks[0].percentOfTotal).toEqual(["merchants"]);
  });

  it("checks sort keys", () => {
    const ds = refs({
      dashboards: withBlocks(
        {
          type: "table",
          by: ["country"],
          metrics: ["orders"],
          sort: { by: "country", order: "asc" },
        },
        { type: "bar", metrics: ["orders"], by: "plan", sort: { by: "order", order: "desc" } },
      ),
    });
    expect(ds).toMatchObject([
      { code: "HM2009", pointer: "/blocks/1/sort/by", expected: ["orders", "plan"] },
    ]);
  });

  it("reports duplicate block and filter ids, including default ids", () => {
    const dashboards = {
      sales: {
        ...DASHBOARD,
        filters: [
          { type: "select", id: "region", column: "region" },
          { type: "select", id: "region", column: "country" },
        ],
        blocks: [
          { type: "kpi", metric: "orders", id: "kpi_1" },
          { type: "kpi", metric: "orders" },
        ],
      },
    };
    expect(refs({ dashboards }).map((d) => [d.code, d.pointer])).toEqual([
      ["HM2008", "/blocks/1"],
      ["HM2008", "/filters/1/id"],
    ]);
  });

  it("checks text references with exact positions inside the string", () => {
    const markdown =
      "Hi\\n{{revenue.chnage}} and {{ revenu }} and {{ 1x }} and {{merchants.previous}}";
    const text = `{"title": "T", "blocks": [{"type": "text", "markdown": "${markdown}"}]}`;
    const ds = refs({ dashboards: { sales: text } });
    const col = (needle: string) => text.indexOf(needle) + 1;
    expect(ds.map((d) => [d.code, d.message, d.range?.start.column])).toEqual([
      ["HM2007", 'unknown field ".chnage" in "{{revenue.chnage}}"', col("{{revenue.chnage}}")],
      ["HM2003", 'unknown metric "revenu" in "{{ revenu }}"', col("{{ revenu }}")],
      ["HM2007", 'invalid metric reference "{{ 1x }}"', col("{{ 1x }}")],
      [
        "HM2005",
        '"{{merchants.previous}}" needs a comparison, but metric "merchants" has no time column',
        col("{{merchants.previous}}"),
      ],
    ]);
    expect(ds[0]?.range?.end.column).toBe(col("{{revenue.chnage}}") + "{{revenue.chnage}}".length);
  });

  it("skips source checks when the config itself is invalid", () => {
    const { sources: _, ...config } = CONFIG;
    expect(refs({ config })).toEqual([]);
  });
});

describe("dependency graph", () => {
  const project = projectFrom({
    dashboards: {
      sales: DASHBOARD,
      merchants: {
        title: "Merchants",
        blocks: [{ type: "kpi", metric: "merchants", compare: "none" }],
      },
      notes: { title: "Notes", blocks: [{ type: "text", markdown: "AOV {{avg_order_value}}" }] },
    },
  });

  it("follows ratios to their sources", () => {
    const deps = dashboardDependencies(project, "notes");
    expect([...deps.metrics].sort()).toEqual(["avg_order_value", "orders", "revenue"]);
    expect([...deps.sources]).toEqual(["orders"]);
  });

  it("names the dashboards to recompile after an edit", () => {
    expect(dashboardsAffectedBy(project, "hatchmark.json")).toEqual([
      "merchants",
      "notes",
      "sales",
    ]);
    expect(dashboardsAffectedBy(project, "metrics/orders.json")).toEqual(["notes", "sales"]);
    expect(dashboardsAffectedBy(project, "data/merchants.parquet")).toEqual(["merchants", "sales"]);
    expect(dashboardsAffectedBy(project, "dashboards/notes.json")).toEqual(["notes"]);
    expect(dashboardsAffectedBy(project, "README.md")).toEqual([]);
  });
});
