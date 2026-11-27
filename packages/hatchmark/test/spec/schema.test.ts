import { describe, expect, it } from "vitest";
import { PROJECT_DEFAULTS, parseSpecFile } from "../../src/spec/index.js";
import { CONFIG, DASHBOARD, METRICS, projectFrom } from "./helpers.js";

const json = (v: unknown): string => `${JSON.stringify(v, null, 2)}\n`;

function diagnose(kind: "project" | "metric" | "dashboard", value: unknown, name = "x") {
  const file = kind === "project" ? "hatchmark.json" : `${kind}s/${name}.json`;
  return parseSpecFile(kind, file, typeof value === "string" ? value : json(value)).diagnostics;
}

describe("spec schemas", () => {
  it("accept the sample project", () => {
    const project = projectFrom({});
    expect(project.config.diagnostics).toEqual([]);
    for (const file of [...project.metrics.values(), ...project.dashboards.values()]) {
      expect(file.diagnostics, file.file).toEqual([]);
      expect(file.spec, file.file).toBeDefined();
    }
  });

  it("require every config field and offer the default as a safe fix", () => {
    const { locale: _, ...rest } = CONFIG;
    const [d, ...others] = diagnose("project", rest);
    expect(others).toEqual([]);
    expect(d).toMatchObject({
      code: "HM3001",
      message: 'missing required property "locale"',
      pointer: "/locale",
      range: { start: { line: 1, column: 1 } },
      fix: { op: "add", pointer: "/locale", value: PROJECT_DEFAULTS.locale, applicability: "safe" },
    });
  });

  it("validate locale, currency, time zone and paths", () => {
    const bad = {
      ...CONFIG,
      locale: "english",
      currency: "usd",
      timezone: "Mars/Olympus",
      outDir: "../out",
    };
    const codes = diagnose("project", bad).map((d) => [d.pointer, d.code]);
    expect(codes).toEqual([
      ["/outDir", "HM3005"],
      ["/locale", "HM3005"],
      ["/currency", "HM3005"],
      ["/timezone", "HM3005"],
    ]);
  });

  it("reject unknown properties and suggest a rename", () => {
    const dashboard = { ...DASHBOARD, blocks: [{ type: "kpi", metirc: "revenue" }] };
    const ds = diagnose("dashboard", dashboard);
    const unknown = ds.find((d) => d.code === "HM3002");
    expect(unknown).toMatchObject({
      message: 'unknown property "metirc"',
      pointer: "/blocks/0/metirc",
      help: 'did you mean "metric"?',
      fix: { op: "text", text: '"metric"', applicability: "unsafe" },
    });
    expect(unknown?.expected).toContain("sparkline");
    expect(ds.find((d) => d.code === "HM3001")?.pointer).toBe("/blocks/0/metric");
  });

  it("list block types for an unknown type", () => {
    const [d] = diagnose("dashboard", {
      ...DASHBOARD,
      blocks: [{ type: "lin", metrics: ["revenue"], grain: "week" }],
    });
    expect(d).toMatchObject({
      code: "HM3004",
      pointer: "/blocks/0/type",
      expected: ["kpi", "line", "area", "bar", "bar_list", "table", "text"],
      fix: { op: "replace", value: "line", applicability: "unsafe" },
    });
  });

  it("mark a case-only enum fix as safe", () => {
    const [d] = diagnose("dashboard", {
      ...DASHBOARD,
      blocks: [{ type: "line", metrics: ["revenue"], grain: "Week" }],
    });
    expect(d).toMatchObject({ code: "HM3004", fix: { value: "week", applicability: "safe" } });
  });

  it("report a missing type with the allowed values", () => {
    const [d] = diagnose("dashboard", { ...DASHBOARD, blocks: [{ metric: "revenue" }] });
    expect(d).toMatchObject({
      code: "HM3001",
      pointer: "/blocks/0/type",
      expected: expect.arrayContaining(["kpi"]),
    });
  });

  it("report wrong types and ranges in plain words", () => {
    const ds = diagnose("dashboard", {
      ...DASHBOARD,
      title: 3,
      blocks: [{ type: "kpi", metric: "revenue", span: 13 }],
    });
    expect(ds.map((d) => [d.code, d.pointer, d.message])).toEqual([
      ["HM3003", "/title", "expected string, found number"],
      ["HM3005", "/blocks/0/span", "must be at most 12"],
    ]);
    expect(diagnose("dashboard", { ...DASHBOARD, blocks: [] })[0]?.message).toBe(
      "must have at least 1 item",
    );
  });

  it("explain a scalar union mismatch", () => {
    const metric = {
      ...(METRICS.revenue as object),
      filters: [{ column: "status", op: "eq", value: null }],
    };
    expect(diagnose("metric", metric)[0]?.message).toBe(
      "expected string or number or boolean, found null",
    );
  });

  it("require a column for every aggregate except count", () => {
    const { column: _, ...metric } = METRICS.revenue as Record<string, unknown>;
    expect(diagnose("metric", metric)).toMatchObject([
      {
        code: "HM3001",
        pointer: "/column",
        message: 'missing required property "column" for aggregate "sum"',
      },
    ]);
  });

  it("reject conflicting bar axes and split with several metrics", () => {
    const both = { type: "bar", metrics: ["orders"], by: "plan", grain: "month" };
    const neither = { type: "bar", metrics: ["orders"] };
    const split = { type: "line", metrics: ["revenue", "orders"], grain: "week", split: "plan" };
    const ds = diagnose("dashboard", { ...DASHBOARD, blocks: [both, neither, split] });
    expect(ds.map((d) => [d.code, d.pointer])).toEqual([
      ["HM3007", "/blocks/0/grain"],
      ["HM3001", "/blocks/1/by"],
      ["HM3007", "/blocks/2/split"],
    ]);
  });

  it("reject invalid file names", () => {
    expect(diagnose("metric", METRICS.orders, "Net-Revenue")[0]).toMatchObject({ code: "HM1004" });
    expect(diagnose("dashboard", DASHBOARD, "sales-overview")).toEqual([]);
  });

  it("stop at JSON syntax errors without schema noise", () => {
    expect(diagnose("dashboard", '{"title": "x",}').map((d) => d.code)).toEqual(["HM1002"]);
  });

  it("validate after duplicate keys but keep the file unusable", () => {
    const file = parseSpecFile(
      "metric",
      "metrics/orders.json",
      json(METRICS.orders).replace('"label"', '"label": "A",\n  "label"'),
    );
    expect(file.diagnostics.map((d) => d.code)).toEqual(["HM1003"]);
    expect(file.spec).toBeUndefined();
  });
});
