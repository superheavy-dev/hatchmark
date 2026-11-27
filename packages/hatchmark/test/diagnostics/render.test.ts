import { describe, expect, it } from "vitest";
import {
  closestMatch,
  createReport,
  type Diagnostic,
  parseYamlFile,
  renderHuman,
  renderJson,
  SpecDocument,
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
  const doc = new SpecDocument("dashboards/sales.yaml", sales);
  const location = doc.locationOf("/charts/2/metric");
  if (location === undefined) throw new Error("range not found");
  return {
    code: "HM1002",
    severity: "error",
    message: 'unknown metric "net_revenu"',
    file: "dashboards/sales.yaml",
    pointer: "/charts/2/metric",
    ...location,
    label: "no file metrics/net_revenu.yaml",
    expected: ["gross_revenue", "net_revenue", "orders", "refunds"],
    help: 'did you mean "net_revenue"? (metrics/net_revenue.yaml)',
    fix: {
      range: location.range,
      text: '"net_revenue"',
      applicability: "safe",
      description: 'replace with "net_revenue"',
    },
    docs: "hatchmark explain HM1002",
  };
}

describe("renderHuman", () => {
  it("prints the rustc-style block with carets under the value", () => {
    const report = createReport([unknownMetric()]);
    expect(renderHuman(report)).toBe(
      [
        'error[HM1002]: unknown metric "net_revenu"',
        " --> dashboards/sales.yaml:6:17",
        "  |",
        '6 |       "metric": "net_revenu",',
        "  |                 ^^^^^^^^^^^^ no file metrics/net_revenu.yaml",
        '  = help: did you mean "net_revenue"? (metrics/net_revenue.yaml)',
        "  = valid: gross_revenue, net_revenue, orders, refunds",
        '  = fix (safe): replace with "net_revenue"   ·   hatchmark explain HM1002',
        "",
        "failed: 1 error, 0 warnings",
      ].join("\n"),
    );
  });

  it("still prints the location when there is no frame", () => {
    const { frame: _, ...rest } = unknownMetric();
    const text = renderHuman(createReport([rest]));
    expect(text).toContain(" --> dashboards/sales.yaml:6:17");
    expect(text).toContain("  = no file metrics/net_revenu.yaml");
  });

  it("cuts long expected lists", () => {
    const d = { ...unknownMetric(), expected: Array.from({ length: 20 }, (_, i) => `m${i}`) };
    expect(renderHuman(createReport([d]), { maxExpected: 3 })).toContain(
      "= valid: m0, m1, m2, and 17 more",
    );
  });

  it("aligns carets after tabs", () => {
    const text = '{\n\t"a": *xy\n}';
    const { diagnostics } = parseYamlFile("x.yaml", text);
    const out = renderHuman(createReport(diagnostics));
    expect(out).toContain('2 |     "a": *xy');
    expect(out).toContain("  |          ^^^");
  });

  it("frames the right line in CR-only files", () => {
    const text = '{\r\t"a": *xy\r}';
    const { diagnostics } = parseYamlFile("x.yaml", text);
    const out = renderHuman(createReport(diagnostics));
    expect(out).toContain(" --> x.yaml:2:7");
    expect(out).toContain('2 |     "a": *xy');
    expect(out).toContain("  |          ^^^");
  });

  it("aligns carets after wide characters and combining marks", () => {
    for (const [text, line, caret] of [
      ['{"界": *xy}', '1 | {"界": *xy}', `  | ${" ".repeat(7)}^^^`],
      ['{"e\u0301": *xy}', '1 | {"e\u0301": *xy}', `  | ${" ".repeat(6)}^^^`],
      ['{"📈": *xy}', '1 | {"📈": *xy}', `  | ${" ".repeat(7)}^^^`],
    ] as const) {
      const { diagnostics } = parseYamlFile("x.yaml", text);
      const out = renderHuman(createReport(diagnostics));
      expect(out, text).toContain(line);
      expect(out, text).toContain(caret);
    }
  });

  it("draws each frame from the text it was checked against, even after the file changes", () => {
    const first = parseYamlFile("x.yaml", '{"before": *xy}').diagnostics;
    const second = parseYamlFile("x.yaml", '{"after": *xy}').diagnostics;
    expect(renderHuman(createReport(first)).split("\n")[3]).toBe('1 | {"before": *xy}');
    expect(renderHuman(createReport(second)).split("\n")[3]).toBe('1 | {"after": *xy}');
    expect(renderHuman(createReport(first)).split("\n")[3]).toBe('1 | {"before": *xy}');
  });

  it("windows very long lines", () => {
    const text = `[${"1,".repeat(500)}*xy, ${"2,".repeat(500)}3]`;
    const [d] = parseYamlFile("x.yaml", text).diagnostics;
    expect(d?.frame?.column).toBeGreaterThan(1);
    expect(d?.frame?.more).toBe(true);
    expect(d?.frame?.text.length).toBeLessThanOrEqual(240);
    const lines = renderHuman(createReport(d ? [d] : [])).split("\n");
    const caretAt = lines[4]?.indexOf("^") ?? -1;
    expect(lines[3]?.slice(caretAt, caretAt + 3)).toBe("*xy");
    expect(lines[3]).toMatch(/^1 \| …1,.*…$/);
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
    const warning: Diagnostic = { ...base, severity: "warning", file: "a.yaml" };
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

  it("emits fix text verbatim", () => {
    for (const text of ["-0", "1e6000", '{"": null}', "\u2028", '"\\u00e9"', ""]) {
      const base = unknownMetric();
      const fix = { ...(base.fix as NonNullable<Diagnostic["fix"]>), text };
      expect(JSON.parse(renderJson(createReport([{ ...base, fix }]))).diagnostics[0].fix.text).toBe(
        text,
      );
    }
  });

  it("is ok with warnings only", () => {
    expect(createReport([{ ...unknownMetric(), severity: "warning" }]).ok).toBe(true);
  });

  it("serialises to one line of JSON with the diagnostic fields", () => {
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
      frame: { text: '      "metric": "net_revenu",', column: 1, more: false },
      fix: {
        range: { start: { line: 6, column: 17 }, end: { line: 6, column: 29 } },
        text: '"net_revenue"',
        applicability: "safe",
      },
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
