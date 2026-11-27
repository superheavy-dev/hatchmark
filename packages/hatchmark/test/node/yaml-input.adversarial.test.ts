import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { KpiData } from "../../src/compiler/index.js";
import { parseSpecFile, type SpecKind } from "../../src/spec/index.js";
import { applyFix } from "../spec/helpers.js";
import { Oracle, removeProjects, run, writeProject } from "./fixture.js";

const CODES = ["0123", "123", "08", "8", "09", "9", "000000", "0", "+1", "1", "Store #12", "Store"];
const ROWS = CODES.map((code, i) => ({
  day: `2026-01-${String(i + 1).padStart(2, "0")}`,
  code,
  amount: 2 ** i,
}));

const CONFIG = `version: 1
name: Codes
dataDir: data
metricsDir: metrics
dashboardsDir: dashboards
outDir: dist
locale: en-US
currency: USD
timezone: UTC
weekStart: monday
theme: default
telemetry: false
sources:
  codes:
    type: json
    path: data/codes.json
`;

const HEAD =
  "label: Probe\ntype: aggregate\ntable: codes\naggregate: sum\ncolumn: amount\nbetter: up\ntime: day\nformat:\n  type: number\n";
const metricWith = (filters: string) => `${HEAD}filters:\n${filters}`;
const eq = (value: string) => metricWith(`  - column: code\n    op: eq\n    value: ${value}\n`);
const dashboard = (filters = "") =>
  `title: Probe\nperiod:\n  asOf: 2026-01-31\n  range: last_12_months\n  compare: none\n${filters}blocks:\n  - type: kpi\n    id: probe\n    metric: probe\n`;
const select = (value: string) =>
  dashboard(`filters:\n  - type: select\n    id: code\n    column: code\n    default: ${value}\n`);
const sqlMetric = (block: string) =>
  `label: Probe\ntype: sql\ntable: codes\nadditive: true\ntime: day\nbetter: up\nformat:\n  type: number\nsql: ${block}`;

const SPELLINGS = [
  "0123",
  "08",
  "000000",
  "+1",
  "0x10",
  "0o17",
  ".5",
  ".inf",
  "-.inf",
  "1E+3x",
].filter((s) => !s.endsWith("x"));

const PLACES: { name: string; kind: SpecKind; text: (s: string) => string; pointers: string[] }[] =
  [
    { name: "eq value", kind: "metric", text: eq, pointers: ["/filters/0/value"] },
    {
      name: "flow values",
      kind: "metric",
      text: (s) => metricWith(`  - column: code\n    op: in\n    values: [${s}, paid]\n`),
      pointers: ["/filters/0/values/0"],
    },
    {
      name: "block values",
      kind: "metric",
      text: (s) =>
        metricWith(`  - column: code\n    op: in\n    values:\n      - paid\n      - ${s}\n`),
      pointers: ["/filters/0/values/1"],
    },
    {
      name: "between",
      kind: "metric",
      text: (s) => metricWith(`  - column: code\n    op: between\n    from: ${s}\n    to: ${s}\n`),
      pointers: ["/filters/0/from", "/filters/0/to"],
    },
    {
      name: "flow map",
      kind: "metric",
      text: (s) => metricWith(`  - {column: code, op: eq, value: ${s}}\n`),
      pointers: ["/filters/0/value"],
    },
    { name: "select default", kind: "dashboard", text: select, pointers: ["/filters/0/default"] },
    {
      name: "select default list",
      kind: "dashboard",
      text: (s) => select(`[${s}, paid]`),
      pointers: ["/filters/0/default/0"],
    },
  ];

function fixAll(kind: SpecKind, text: string): string {
  for (let round = 0; round < 4; round++) {
    const parsed = parseSpecFile(kind, `${kind}s/probe.yaml`, text);
    const fix = parsed.diagnostics.find((d) => d.code === "HM1006" && d.fix)?.fix;
    if (fix === undefined) return text;
    text = applyFix(text, fix);
  }
  return text;
}

describe("numbers YAML reads from spellings JSON does not have", () => {
  for (const place of PLACES) {
    it(`rejects them in ${place.name}, and the safe fix keeps the text as written`, () => {
      for (const spelling of SPELLINGS) {
        const text = place.text(spelling);
        const parsed = parseSpecFile(place.kind, `${place.kind}s/probe.yaml`, text);
        const errors = parsed.diagnostics.filter((d) => d.severity === "error");
        expect(errors.length, `${place.name} ${spelling}`).toBeGreaterThan(0);
        expect(new Set(errors.map((d) => d.code)), spelling).toEqual(new Set(["HM1006"]));
        expect(parsed.spec, spelling).toBeUndefined();
        const fixed = parseSpecFile(
          place.kind,
          `${place.kind}s/probe.yaml`,
          fixAll(place.kind, text),
        );
        expect(
          fixed.diagnostics.filter((d) => d.severity === "error"),
          spelling,
        ).toEqual([]);
        for (const pointer of place.pointers)
          expect(fixed.document.locate(pointer)?.node, `${pointer} ${spelling}`).toMatchObject({
            kind: "string",
            value: spelling,
          });
      }
    });
  }

  it("keeps numbers written as JSON writes them", () => {
    for (const spelling of ["10", "-0", "1.5", "1e3", "1E+3", "0.25", "12345678901234567890"]) {
      const parsed = parseSpecFile("metric", "metrics/probe.yaml", eq(spelling));
      expect(parsed.diagnostics, spelling).toEqual([]);
      expect(parsed.document.locate("/filters/0/value")?.node, spelling).toMatchObject({
        kind: "number",
        value: JSON.parse(spelling),
      });
    }
  });

  it("rejects a %YAML directive other than 1.2", () => {
    for (const version of ["1.0", "1.1", "1.3"]) {
      const parsed = parseSpecFile(
        "metric",
        "metrics/probe.yaml",
        `%YAML ${version}\n---\n${eq("paid")}`,
      );
      const errors = parsed.diagnostics.filter((d) => d.severity === "error");
      expect(
        errors.map((d) => d.range?.start.line),
        version,
      ).toEqual([1]);
      expect(parsed.spec, version).toBeUndefined();
    }
    expect(
      parseSpecFile("metric", "metrics/probe.yaml", `%YAML 1.2\n---\n${eq("paid")}`).diagnostics,
    ).toEqual([]);
  });

  it("rejects folded or multi-line plain SQL, and accepts a literal block", () => {
    for (const block of [
      ">\n  sum(amount) -- all rows\n  - 1\n",
      ">-\n  sum(amount)\n",
      "sum(amount)\n  - 1\n",
      '"sum(amount)\n  - 1"\n',
    ]) {
      const parsed = parseSpecFile("metric", "metrics/probe.yaml", sqlMetric(block));
      expect(
        parsed.diagnostics.map((d) => d.code),
        block,
      ).toEqual(["HM1006"]);
    }
    for (const block of [
      "|\n  sum(amount) -- all rows\n  - 1\n",
      "sum(amount) - 1\n",
      "|-\n  sum(amount)\n",
    ])
      expect(
        parseSpecFile("metric", "metrics/probe.yaml", sqlMetric(block)).diagnostics,
        block,
      ).toEqual([]);
  });

  it("warns when a comment follows an unquoted filter value or select default", () => {
    const cases: [SpecKind, string, string][] = [
      ["metric", eq("Store #12"), "Store"],
      [
        "metric",
        metricWith("  - column: code\n    op: in\n    values:\n      - Store #12\n"),
        "Store",
      ],
      [
        "metric",
        metricWith("  - column: code\n    op: between\n    from: A # low\n    to: B\n"),
        "A",
      ],
      ["dashboard", select("Store #12"), "Store"],
    ];
    for (const [kind, text, read] of cases) {
      const parsed = parseSpecFile(kind, `${kind}s/probe.yaml`, text);
      const warning = parsed.diagnostics.find((d) => d.code === "HM1008");
      expect(warning, text).toMatchObject({ severity: "warning" });
      expect(warning?.message, text).toContain(JSON.stringify(read));
    }
    for (const text of [
      eq('"Store #12"'),
      eq("Store#12"),
      `${eq("paid")}# trailing\n`,
      `${HEAD.replace("label: Probe", "label: Probe # name")}`,
    ])
      expect(
        parseSpecFile("metric", "metrics/probe.yaml", text).diagnostics.map((d) => d.code),
        text,
      ).not.toContain("HM1008");
  });
});

describe("main's JSON spec text renamed to .yaml", () => {
  const base = {
    label: "Probe",
    type: "aggregate",
    table: "codes",
    aggregate: "sum",
    column: "amount",
    filters: [{ column: "code", op: "eq", value: "0123" }],
    time: "day",
    better: "up",
    format: { type: "number" },
  };
  const pretty = JSON.stringify(base, null, 2);
  const texts: Record<string, string> = {
    tabs: JSON.stringify(base, null, "\t"),
    minified: JSON.stringify(base),
    "long line": JSON.stringify({ ...base, description: "d".repeat(50_000) }),
    "zero indent": pretty
      .split("\n")
      .map((l) => l.trimStart())
      .join("\n"),
    "space before colon": pretty.replaceAll('": ', '" : '),
    "no space after colon": pretty.replaceAll('": ', '":'),
    CRLF: pretty.replaceAll("\n", "\r\n"),
    "escaped slash and hash": pretty.replace('"0123"', '"a: b #c \\/ d"'),
    "unicode escapes": pretty.replace('"0123"', '"\\u0030\\u0031 \\ud83d\\ude00 \\u2028"'),
    "raw U+2028": pretty.replace('"0123"', '"a\u2028b"'),
    "number forms": pretty.replace('"0123"', "[1.0, -0, 1E2, 1e-2, 12345678901234567890, 0.1]"),
    "key __proto__": pretty.replace('"op": "eq",', '"op": "eq", "__proto__": {"value": "x"},'),
    "trailing newlines": `${pretty}\n\n\n`,
    "--- prefix": `---\n${pretty}`,
  };
  it("reads the same value JSON.parse does, with no diagnostics", () => {
    for (const [name, text] of Object.entries(texts)) {
      const parsed = parseSpecFile("metric", "metrics/probe.yaml", text);
      expect(
        parsed.diagnostics.filter((d) => d.code.startsWith("HM1")),
        name,
      ).toEqual([]);
      expect(parsed.document.value, name).toEqual(JSON.parse(text.replace(/^---\n/, "")));
    }
  });

  it("rejects duplicate keys as JSON text too", () => {
    const text = pretty.replace('"op": "eq",', '"op": "eq",\n      "value": "08",');
    expect(
      parseSpecFile("metric", "metrics/probe.yaml", text).diagnostics.map((d) => d.code),
    ).toContain("HM1003");
  });
});

describe("fixed spellings compute what the SQL oracle computes", () => {
  let oracle: Oracle;
  const sum = async (where: string) =>
    Number(
      (
        await oracle.rows(
          `SELECT sum(amount) AS v FROM (VALUES ${ROWS.map((r) => `('${r.code}', ${r.amount})`).join(", ")}) t(code, amount) WHERE ${where}`,
        )
      )[0]?.v ?? 0,
    );

  beforeAll(async () => {
    oracle = await Oracle.open();
  });
  afterAll(async () => {
    oracle.close();
    await removeProjects();
  });

  const kpi = async (metricText: string, dashboardText = dashboard()) => {
    const { root, project, diagnostics } = await writeProject({
      "hatchmark.yaml": CONFIG,
      "data/codes.json": JSON.stringify(ROWS),
      "metrics/probe.yaml": fixAll("metric", metricText),
      "dashboards/probe.yaml": fixAll("dashboard", dashboardText),
    });
    expect(diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const result = await run(root, project, "probe");
    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    return (result.data?.blocks.find((b) => b.id === "probe") as KpiData | undefined)?.value;
  };

  it("matches one code for eq 0123, not 0123 and 123", async () => {
    expect(await kpi(eq("0123"))).toBe(await sum("code = '0123'"));
  });

  it("matches the codes as written for in [0123, 08] and between 08 and 09", async () => {
    expect(await kpi(metricWith("  - column: code\n    op: in\n    values: [0123, 08]\n"))).toBe(
      await sum("code IN ('0123', '08')"),
    );
    expect(
      await kpi(metricWith("  - column: code\n    op: between\n    from: 08\n    to: 09\n")),
    ).toBe(await sum("code BETWEEN '08' AND '09'"));
  });

  it("binds a select default of +1 as the string +1", async () => {
    expect(
      await kpi(metricWith("  - column: code\n    op: neq\n    value: zzz\n"), select("+1")),
    ).toBe(await sum("code = '+1'"));
  });

  it("keeps the # of a quoted value", async () => {
    expect(await kpi(eq('"Store #12"'))).toBe(await sum("code = 'Store #12'"));
  });

  it("keeps a literal SQL block's -- comment on its own line", async () => {
    expect(await kpi(sqlMetric("|\n  sum(amount) -- all rows\n  - 1\n"))).toBe(
      (await sum("true")) - 1,
    );
  });
});
