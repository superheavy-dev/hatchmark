import { describe, expect, it } from "vitest";
import { PROJECT_DEFAULTS, parseSpecFile } from "../../src/spec/index.js";
import { applyFix, CONFIG, DASHBOARD, METRICS, projectFrom } from "./helpers.js";

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
      fix: { applicability: "safe" },
    });
    const fixed = applyFix(json(rest), d?.fix);
    expect(JSON.parse(fixed)).toEqual({ ...rest, locale: PROJECT_DEFAULTS.locale });
    expect(fixed).toContain('\n  "locale": "en-US"\n}');
    expect(diagnose("project", fixed)).toEqual([]);
    const compact = JSON.stringify(rest);
    expect(JSON.parse(applyFix(compact, diagnose("project", compact)[0]?.fix))).toEqual({
      ...rest,
      locale: "en-US",
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
      fix: { text: '"metric"', applicability: "unsafe" },
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
      fix: { text: '"line"', applicability: "unsafe" },
    });
  });

  it("mark a case-only enum fix as safe", () => {
    const [d] = diagnose("dashboard", {
      ...DASHBOARD,
      blocks: [{ type: "line", metrics: ["revenue"], grain: "Week" }],
    });
    expect(d).toMatchObject({ code: "HM3004", fix: { text: '"week"', applicability: "safe" } });
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

  it("validate a metric's currency override like the project currency", () => {
    const withCurrency = (currency: string) => ({
      ...(METRICS.revenue as object),
      format: { type: "currency", currency },
    });
    for (const bad of ["123", "usd", "XYZ"]) {
      expect(diagnose("metric", withCurrency(bad)), bad).toMatchObject([
        { code: "HM3005", pointer: "/format/currency" },
      ]);
    }
    expect(diagnose("metric", withCurrency("EUR"))).toEqual([]);
    expect(() =>
      new Intl.NumberFormat("en-US", { style: "currency", currency: "EUR" }).format(1),
    ).not.toThrow();
  });

  it("require a column for every aggregate except count", () => {
    const { column: _, ...metric } = METRICS.revenue as Record<string, unknown>;
    expect(diagnose("metric", metric)).toMatchObject([
      {
        code: "HM3001",
        pointer: "/column",
        message: 'missing required property "column" (or "value") for aggregate "sum"',
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

  it("accept anchors, grains with an anchor, range shorthands and shift comparisons", () => {
    const { weekStart: _, ...config } = CONFIG;
    expect(
      diagnose("project", {
        ...config,
        anchors: { week: "sunday", quarter: "02-01", year: "02-01" },
      }),
    ).toEqual([]);
    const dashboard = {
      ...DASHBOARD,
      period: {
        asOf: "latest_data",
        range: { last: 6, unit: "week" },
        compare: { shift: { unit: "week", by: -1 } },
      },
      blocks: [
        { type: "line", metrics: ["revenue"], grain: { unit: "week", anchor: "sunday" } },
        { type: "bar", metrics: ["orders"], grain: { unit: "quarter", anchor: "02-01" } },
        { type: "kpi", metric: "revenue", compare: { shift: { unit: "year", by: -1 } } },
      ],
    };
    expect(diagnose("dashboard", dashboard)).toEqual([]);
    for (const range of [
      { start: "2026-01-01", end: "2026-04-01" },
      { to_date: "quarter" },
      { last_complete: "week" },
    ]) {
      const period = { asOf: "latest_data", range, compare: "previous_period" };
      expect(diagnose("dashboard", { ...DASHBOARD, period }), JSON.stringify(range)).toEqual([]);
    }
  });

  it("reject anchors that conflict or do not fit their unit (HM3005, HM3007)", () => {
    const conflict = { ...CONFIG, anchors: { week: "sunday" } };
    const quarter = {
      ...CONFIG,
      weekStart: undefined,
      anchors: { quarter: "02-15", year: "01-01" },
    };
    expect(diagnose("project", conflict).map((d) => [d.code, d.pointer])).toEqual([
      ["HM3007", "/weekStart"],
    ]);
    expect(diagnose("project", quarter).map((d) => d.code)).toEqual(["HM3007"]);
    const grain = (g: unknown) =>
      diagnose("dashboard", {
        ...DASHBOARD,
        blocks: [{ type: "line", metrics: ["revenue"], grain: g }],
      });
    expect(grain({ unit: "week", anchor: "01-01" }).map((d) => d.code)).toEqual(["HM3007"]);
    expect(grain({ unit: "month", anchor: "monday" }).map((d) => d.code)).toEqual(["HM3007"]);
    expect(grain({ unit: "quarter", anchor: "02-30" }).map((d) => d.code)).not.toEqual([]);
    const range = (r: unknown) =>
      diagnose("dashboard", {
        ...DASHBOARD,
        period: { asOf: "latest_data", range: r, compare: "none" },
      });
    expect(range({ start: "2026-04-01", end: "2026-04-01" }).map((d) => d.code)).toEqual([
      "HM3005",
    ]);
    expect(range({ to_date: "hour" }).map((d) => d.code)).not.toEqual([]);
    expect(range({ to_date: "day" })).toEqual([]);
    expect(range({ last: 0, unit: "day" }).map((d) => d.code)).not.toEqual([]);
  });

  it("accept grain switches and one grain filter, and reject a list of one or grains on a by bar", () => {
    const line = (extra: Record<string, unknown>) => ({
      type: "line",
      metrics: ["revenue"],
      grain: "month",
      ...extra,
    });
    const grainFilter = {
      type: "grain",
      id: "grain",
      options: ["week", "month"],
      default: "month",
    };
    expect(
      diagnose("dashboard", {
        ...DASHBOARD,
        filters: [grainFilter],
        blocks: [
          line({ grains: ["week", "month", { unit: "quarter", anchor: "02-01" }] }),
          { type: "bar", metrics: ["orders"], grain: "month", grains: ["month", "quarter"] },
        ],
      }),
    ).toEqual([]);
    const codes = (blocks: unknown[], filters?: unknown[]) =>
      diagnose("dashboard", { ...DASHBOARD, ...(filters ? { filters } : {}), blocks }).map((d) => [
        d.code,
        d.pointer,
      ]);
    expect(codes([line({ grains: ["month"] })]).map(([c]) => c)).toEqual(["HM3005"]);
    expect(
      codes([{ type: "bar", metrics: ["orders"], by: "plan", grains: ["month", "quarter"] }]),
    ).toEqual([["HM3007", "/blocks/0/grains"]]);
  });

  it("reject the reserved $hm_p prefix anywhere in a sql metric (HM3005)", () => {
    const sql = (text: string) =>
      diagnose("metric", {
        label: "X",
        type: "sql",
        table: "orders",
        additive: true,
        sql: text,
        format: { type: "number" },
        better: "up",
      }).map((d) => [d.code, d.pointer]);
    expect(sql("count(*)")).toEqual([]);
    for (const text of [
      "count(*) FILTER (WHERE status <> $$hm_p1$)",
      "count(*) FILTER (WHERE status <> E'\\'$hm_p1')",
      'sum("cost$HM_P2")',
    ]) {
      expect(sql(text), text).toEqual([["HM3005", "/sql"]]);
    }
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
