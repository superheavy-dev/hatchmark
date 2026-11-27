import { describe, expect, it } from "vitest";
import { checkReferences, parseCsvRecord, parseDiagnostics } from "../../src/spec/index.js";
import { CONFIG, METRICS, projectFrom } from "./helpers.js";

// Regression tests for HAT-14's numbers-path blockers on hatchmark#5.
const config = {
  ...CONFIG,
  sources: { ...CONFIG.sources, sessions: { type: "csv", path: "data/sessions.csv" } },
};
const metrics = {
  ...METRICS,
  sessions: {
    label: "Sessions",
    type: "aggregate",
    table: "sessions",
    aggregate: "count",
    time: "started_at",
    format: { type: "number" },
    better: "up",
  },
  conversion: {
    label: "Conversion rate",
    type: "ratio",
    numerator: "orders",
    denominator: "sessions",
    format: { type: "percent", decimals: 1 },
    better: "up",
  },
  order_count: {
    label: "Orders",
    type: "aggregate",
    table: "orders",
    aggregate: "count",
    format: { type: "number" },
    better: "up",
  },
  revenue_per_order: {
    label: "Revenue per order",
    type: "ratio",
    numerator: "revenue",
    denominator: "order_count",
    format: { type: "currency" },
    better: "up",
  },
};
const period = { asOf: "2026-11-15", range: "last_12_months", compare: "none" };
const filters = [{ type: "select", id: "region", column: "region" }];

function diagnostics(dashboard: unknown, columns?: Record<string, string[]>) {
  const project = projectFrom({
    config,
    metrics,
    dashboards: { sales: dashboard },
    ...(columns ? { columns } : {}),
  });
  return [...parseDiagnostics(project), ...checkReferences(project)].filter(
    (d) => d.file === "dashboards/sales.json",
  );
}

function metricDiagnostics() {
  const project = projectFrom({ config, metrics, dashboards: {} });
  return checkReferences(project);
}

describe("ratio scope", () => {
  it("B1: rejects a filter that would bind to one side of a cross-source ratio", () => {
    const dashboard = {
      title: "Funnel",
      period,
      filters,
      blocks: [{ type: "kpi", metric: "conversion" }],
    };
    const known = diagnostics(dashboard, {
      orders: ["region", "ordered_at"],
      sessions: ["started_at"],
    });
    expect(known.map((d) => [d.code, d.pointer])).toEqual([["HM2013", "/blocks/0"]]);
    expect(known[0]?.message).toBe(
      'filter "region" would apply to orders but not to sessions in this block',
    );
    const unknown = diagnostics(dashboard);
    expect(unknown.map((d) => d.code)).toEqual(["HM2013"]);
    expect(unknown[0]?.message).toContain("cannot confirm");
  });

  it("B1: accepts the filter when every source has the column, or none does", () => {
    const dashboard = {
      title: "Funnel",
      period,
      filters,
      blocks: [{ type: "kpi", metric: "conversion" }],
    };
    expect(diagnostics(dashboard, { orders: ["region"], sessions: ["region"] })).toEqual([]);
    expect(diagnostics(dashboard, { orders: ["x"], sessions: ["y"] })).toEqual([]);
  });

  it("B1: checks multi-source line charts and text blocks too", () => {
    const dashboard = {
      title: "Funnel",
      period,
      filters,
      blocks: [
        { type: "line", metrics: ["orders", "sessions"], grain: "week" },
        { type: "text", markdown: "{{orders}} from {{sessions}}" },
        { type: "kpi", metric: "orders" },
      ],
    };
    const ds = diagnostics(dashboard, { orders: ["region"], sessions: [] });
    expect(ds.map((d) => [d.code, d.pointer])).toEqual([
      ["HM2013", "/blocks/0"],
      ["HM2013", "/blocks/1"],
    ]);
  });

  it("B2: rejects a ratio whose sides disagree on time, wherever it is used", () => {
    const ds = metricDiagnostics();
    expect(ds.map((d) => [d.file, d.code, d.pointer])).toEqual([
      ["metrics/revenue_per_order.json", "HM2012", "/denominator"],
    ]);
  });
});

describe("parseCsvRecord", () => {
  it("reads quoted headers, custom delimiters and CRLF", () => {
    expect(parseCsvRecord('a,"b,c","d""e"\r\n1,2,3', ",")).toEqual(["a", "b,c", 'd"e']);
    expect(parseCsvRecord("x;y\n", ";")).toEqual(["x", "y"]);
    expect(parseCsvRecord('"open', ",")).toBeUndefined();
  });
});
