import { describe, expect, it } from "vitest";
import {
  closestMatch,
  createReport,
  type Diagnostic,
  JsonDocument,
  parseJsonFile,
  renderHuman,
  renderJson,
} from "../../src/diagnostics/index.js";

const sales = `{
  "charts": [
    { "type": "kpi", "metric": "revenue" },
    { "type": "kpi", "metric": "orders" },
    {
      "metric": "net_revenu",
      "type": "line"
    }
  ]
}
`;

function unknownMetric(): Diagnostic {
  const doc = new JsonDocument("dashboards/sales.json", sales);
  const range = doc.rangeOf("/charts/2/metric");
  if (range === undefined) throw new Error("range not found");
  return {
    code: "HM1002",
    severity: "error",
    message: 'unknown metric "net_revenu"',
    file: "dashboards/sales.json",
    pointer: "/charts/2/metric",
    range,
    label: "no file metrics/net_revenu.json",
    expected: ["gross_revenue", "net_revenue", "orders", "refunds"],
    help: 'did you mean "net_revenue"? (metrics/net_revenue.json)',
    fix: {
      op: "replace",
      pointer: "/charts/2/metric",
      value: "net_revenue",
      applicability: "safe",
      description: 'replace with "net_revenue"',
    },
    docs: "hatchmark explain HM1002",
  };
}

describe("renderHuman", () => {
  it("prints the rustc-style block with carets under the value", () => {
    const report = createReport([unknownMetric()]);
    const sources = new Map([["dashboards/sales.json", sales]]);
    expect(renderHuman(report, { sources })).toBe(
      [
        'error[HM1002]: unknown metric "net_revenu"',
        " --> dashboards/sales.json:6:17",
        "  |",
        '6 |       "metric": "net_revenu",',
        "  |                 ^^^^^^^^^^^^ no file metrics/net_revenu.json",
        '  = help: did you mean "net_revenue"? (metrics/net_revenue.json)',
        "  = valid: gross_revenue, net_revenue, orders, refunds",
        '  = fix (safe): replace with "net_revenue"   ·   hatchmark explain HM1002',
        "",
        "failed: 1 error, 0 warnings",
      ].join("\n"),
    );
  });

  it("still prints the location when the source is not available", () => {
    const text = renderHuman(createReport([unknownMetric()]));
    expect(text).toContain(" --> dashboards/sales.json:6:17");
    expect(text).toContain("  = no file metrics/net_revenu.json");
  });

  it("cuts long expected lists", () => {
    const d = { ...unknownMetric(), expected: Array.from({ length: 20 }, (_, i) => `m${i}`) };
    expect(renderHuman(createReport([d]), { maxExpected: 3 })).toContain(
      "= valid: m0, m1, m2, and 17 more",
    );
  });

  it("aligns carets after tabs", () => {
    const text = '{\n\t"a": tru\n}';
    const { diagnostics } = parseJsonFile("x.json", text);
    const out = renderHuman(createReport(diagnostics), { sources: new Map([["x.json", text]]) });
    expect(out).toContain('2 |     "a": tru');
    expect(out).toContain("  |          ^^^");
  });

  it("frames the right line in CR-only files", () => {
    const text = '{\r\t"a": tru\r}';
    const { diagnostics } = parseJsonFile("x.json", text);
    const out = renderHuman(createReport(diagnostics), { sources: new Map([["x.json", text]]) });
    expect(out).toContain(" --> x.json:2:7");
    expect(out).toContain('2 |     "a": tru');
    expect(out).toContain("  |          ^^^");
  });

  it("aligns carets after wide characters and combining marks", () => {
    for (const [text, line, caret] of [
      ['{"界": tru}', '1 | {"界": tru}', `  | ${" ".repeat(7)}^^^`],
      ['{"e\u0301": tru}', '1 | {"e\u0301": tru}', `  | ${" ".repeat(6)}^^^`],
      ['{"📈": tru}', '1 | {"📈": tru}', `  | ${" ".repeat(7)}^^^`],
    ] as const) {
      const { diagnostics } = parseJsonFile("x.json", text);
      const out = renderHuman(createReport(diagnostics), { sources: new Map([["x.json", text]]) });
      expect(out, text).toContain(line);
      expect(out, text).toContain(caret);
    }
  });

  it("only adds ANSI colour when asked", () => {
    const report = createReport([unknownMetric()]);
    expect(renderHuman(report)).not.toContain("\u001b[");
    expect(renderHuman(report, { color: true })).toContain("\u001b[31merror[HM1002]");
  });

  it("summarises a clean report as ok", () => {
    expect(renderHuman(createReport([]))).toBe("ok: 0 errors, 0 warnings");
  });
});

describe("createReport and renderJson", () => {
  it("counts and sorts diagnostics deterministically", () => {
    const base = unknownMetric();
    const warning: Diagnostic = { ...base, severity: "warning", file: "a.json" };
    const later: Diagnostic = {
      ...base,
      range: { start: { line: 9, column: 1 }, end: { line: 9, column: 2 } },
    };
    const report = createReport([later, base, warning]);
    expect(report).toMatchObject({
      format_version: "1",
      ok: false,
      error_count: 2,
      warning_count: 1,
    });
    expect(report.diagnostics).toEqual([warning, base, later]);
  });

  it("gives the same bytes whatever the input order, even for ties", () => {
    const base = unknownMetric();
    const a = { ...base, pointer: "/a" };
    const b = { ...base, pointer: "/b" };
    expect(renderJson(createReport([a, b]))).toBe(renderJson(createReport([b, a])));
  });

  it("refuses values JSON cannot carry instead of changing them", () => {
    const base = unknownMetric();
    const fix = {
      op: "replace" as const,
      pointer: "/amount",
      value: Number.POSITIVE_INFINITY,
      applicability: "safe" as const,
      description: "x",
    };
    expect(() => renderJson(createReport([{ ...base, fix }]))).toThrow(TypeError);
    expect(() =>
      renderJson(createReport([{ ...base, fix: { ...fix, value: [undefined] } }])),
    ).toThrow(TypeError);
  });

  it("is ok with warnings only", () => {
    expect(createReport([{ ...unknownMetric(), severity: "warning" }]).ok).toBe(true);
  });

  it("serialises to one line of JSON with the HAT-4 fields", () => {
    const json = renderJson(createReport([unknownMetric()]));
    expect(json).not.toContain("\n");
    const parsed = JSON.parse(json);
    expect(Object.keys(parsed)).toEqual([
      "format_version",
      "ok",
      "error_count",
      "warning_count",
      "diagnostics",
    ]);
    expect(parsed.diagnostics[0]).toMatchObject({
      pointer: "/charts/2/metric",
      range: { start: { line: 6, column: 17 }, end: { line: 6, column: 29 } },
      fix: { op: "replace", applicability: "safe", value: "net_revenue" },
    });
  });
});

describe("closestMatch", () => {
  const metrics = ["gross_revenue", "net_revenue", "orders", "refunds"];
  it("finds likely typos and case slips", () => {
    expect(closestMatch("net_revenu", metrics)).toBe("net_revenue");
    expect(closestMatch("ordres", metrics)).toBe("orders");
    expect(closestMatch("Orders", metrics)).toBe("orders");
  });
  it("returns nothing for unrelated names", () => {
    expect(closestMatch("churn", metrics)).toBeUndefined();
    expect(closestMatch("x", [])).toBeUndefined();
  });
});
