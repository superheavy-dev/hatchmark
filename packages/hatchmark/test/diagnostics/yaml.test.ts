import { describe, expect, it } from "vitest";
import { parseYamlFile, SpecDocument } from "../../src/diagnostics/index.js";

function errorsOf(text: string) {
  return parseYamlFile("x.yaml", text).diagnostics.map((d) => ({
    code: d.code,
    message: d.message,
    at: d.range ? `${d.range.start.line}:${d.range.start.column}` : undefined,
  }));
}

describe("SpecDocument", () => {
  it("reads YAML 1.2 core values, with no yes/no booleans and no dates", () => {
    const doc = new SpecDocument(
      "x.yaml",
      "a: [1, -2.5e3, true, false, null, ~]\nb: yes\nc: no\nd: on\ne: 2026-01-01\nf: 0012\ng: 1_000\nh: 0o17\ni: .inf\nj: 'it''s'\nk:\n",
    );
    expect(doc.errors).toEqual([]);
    expect(doc.value).toEqual({
      a: [1, -2500, true, false, null, null],
      b: "yes",
      c: "no",
      d: "on",
      e: "2026-01-01",
      f: 12,
      g: "1_000",
      h: 15,
      i: Number.POSITIVE_INFINITY,
      j: "it's",
      k: null,
    });
  });

  it("reads JSON text as YAML", () => {
    const text = '{"a": [1, true, null], "b": {"c": "d\\u00e9\\n"}}';
    expect(new SpecDocument("x.yaml", text).value).toEqual(JSON.parse(text));
  });

  it("keeps __proto__ as an own property instead of setting the prototype", () => {
    const value = new SpecDocument("x.yaml", "__proto__:\n  polluted: true\n").value as object;
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
    expect(Object.keys(value)).toEqual(["__proto__"]);
  });

  it("maps JSON Pointers to 1-based line and column ranges", () => {
    const doc = new SpecDocument(
      "dashboards/sales.yaml",
      "blocks:\n  - type: kpi\n    metric: net_revenu\n",
    );
    expect(doc.rangeOf("/blocks/0/metric")).toEqual({
      start: { line: 3, column: 13 },
      end: { line: 3, column: 23 },
    });
    expect(doc.rangeOf("/blocks/0/metric", "key")).toEqual({
      start: { line: 3, column: 5 },
      end: { line: 3, column: 11 },
    });
  });

  it("resolves a missing pointer to its deepest existing ancestor", () => {
    const doc = new SpecDocument("x.yaml", "a:\n  b: 1\n");
    expect(doc.locate("/a/missing")?.exact).toBe(false);
    expect(doc.rangeOf("/a/missing")?.start).toEqual({ line: 1, column: 1 });
    expect(doc.rangeOf("/nothing/deeper")?.start).toEqual({ line: 1, column: 1 });
  });

  it("decodes escaped pointer tokens", () => {
    const doc = new SpecDocument("x.yaml", "a/b:\n  m~n: 1\n");
    expect(doc.locate("/a~1b/m~0n")?.exact).toBe(true);
  });

  it("counts columns in code points, not UTF-16 units", () => {
    const doc = new SpecDocument("x.yaml", "{t: 📈, v: 1}");
    expect(doc.rangeOf("/v")?.start).toEqual({ line: 1, column: 11 });
  });

  it("handles CRLF line endings", () => {
    const doc = new SpecDocument("x.yaml", "a: 1\r\nb: 2\r\n");
    expect(doc.rangeOf("/b")?.start).toEqual({ line: 2, column: 4 });
    expect(doc.lineText(2)).toBe("b: 2");
  });

  it("maps string indexes to source offsets for every scalar style", () => {
    const cases: [string, string][] = [
      ["x: a + bad\n", "plain"],
      ["x: 'it''s bad'\n", "single"],
      ['x: "\\t\\u00e9 bad"\n', "double"],
      ["x: |\n  one\n  two bad\n", "literal"],
      ["x: >-\n  one\n  two bad\n", "folded"],
    ];
    for (const [text, style] of cases) {
      const doc = new SpecDocument("x.yaml", text);
      const node = doc.locate("/x")?.node;
      if (node?.kind !== "string") throw new Error("not a string");
      expect(node.style).toBe(style);
      const offset = doc.stringOffset(node, node.value.indexOf("bad"));
      expect(text.slice(offset, offset + 3), style).toBe("bad");
    }
  });

  it("maps string indexes past folded lines, kept spaces and indentation", () => {
    const cases = [
      "x: >-\n  first  second\n  {{bad}}\n",
      "x: >\n  a\n\n  b {{bad}}\n",
      "x: >\n  a\n    more\n  b {{bad}}\n",
      "x: >\n\n  {{bad}}\n",
      "x: >2\n    {{bad}}\n",
      "x: |2\n    a\n   {{bad}}\n",
      "x: plain  two\n  more {{bad}}\n",
      "x: 'it''s\n  {{bad}}'\n",
      'x: "a\\\n   b{{bad}}"\n',
    ];
    for (const text of cases) {
      const doc = new SpecDocument("x.yaml", text);
      const node = doc.locate("/x")?.node;
      if (node?.kind !== "string") throw new Error("not a string");
      const at = node.value.indexOf("{{bad}}");
      const start = doc.stringOffset(node, at);
      const end = doc.stringOffset(node, at + "{{bad}}".length);
      expect(text.slice(start, end), text).toBe("{{bad}}");
    }
  });
});

describe("parseYamlFile diagnostics", () => {
  it("reports the first syntax error at its position, with help for common slips", () => {
    const [colon] = parseYamlFile("x.yaml", "description: Revenue: last quarter\n").diagnostics;
    expect(colon).toMatchObject({ code: "HM1002", range: { start: { line: 1, column: 14 } } });
    expect(colon?.help).toContain("needs quotes");
    expect(errorsOf("a:\n\tb: 1\n")).toEqual([
      { code: "HM1002", message: "tabs are not allowed as indentation", at: "2:1" },
    ]);
    expect(errorsOf('a: "x\nb: [1\n')).toHaveLength(1);
  });

  it("reports duplicate keys with the first occurrence", () => {
    const [dup] = parseYamlFile("x.yaml", "a: 1\nb: 2\na: 3\n").diagnostics;
    expect(dup).toMatchObject({
      code: "HM1003",
      message: 'duplicate key "a"',
      range: { start: { line: 3, column: 1 } },
      help: "the first one is at line 1; keep one of them",
    });
  });

  it("rejects anchors, aliases and merge keys", () => {
    expect(errorsOf("a: &x 1\nb: *x\n")).toEqual([
      { code: "HM1006", message: "anchors (&x) are not allowed in spec files", at: "1:4" },
      { code: "HM1006", message: "aliases (*x) are not allowed in spec files", at: "2:4" },
    ]);
    expect(errorsOf("c:\n  <<: {a: 1}\n")).toEqual([
      { code: "HM1006", message: "merge keys (<<) are not allowed in spec files", at: "2:3" },
    ]);
  });

  it("points at the anchor or tag itself, not at the same text in a comment", () => {
    expect(errorsOf("a: &x # &x\n  b: 1\n")).toEqual([
      { code: "HM1006", message: "anchors (&x) are not allowed in spec files", at: "1:4" },
    ]);
    expect(errorsOf("a: !money # !money\n  b: 1\n").map((e) => e.at)).toEqual(["1:4"]);
  });

  it("rejects tags outside the core schema and allows the core ones", () => {
    expect(errorsOf("a: !!str 2026\nb: !!int 3\n")).toEqual([]);
    expect(new SpecDocument("x.yaml", "a: !!str 2026\n").value).toEqual({ a: "2026" });
    expect(errorsOf("a: !money 1\nb: !!timestamp 2026-01-01\n").map((e) => [e.code, e.at])).toEqual(
      [
        ["HM1006", "1:4"],
        ["HM1006", "2:4"],
      ],
    );
  });

  it("rejects a core tag that does not fit its value", () => {
    expect(errorsOf("label: !!int Revenue\nb: !!bool yes\nc: !!null x\n")).toEqual([
      { code: "HM1006", message: "the tag !!int does not fit this value", at: "1:8" },
      { code: "HM1006", message: "the tag !!bool does not fit this value", at: "2:4" },
      { code: "HM1006", message: "the tag !!null does not fit this value", at: "3:4" },
    ]);
  });

  it("rejects keys that are not strings and complex keys", () => {
    expect(errorsOf("2026: a\ntrue: b\n")).toEqual([
      { code: "HM1006", message: "the key 2026 is read as number, not a name", at: "1:1" },
      { code: "HM1006", message: "the key true is read as boolean, not a name", at: "2:1" },
    ]);
    expect(errorsOf("? [a]\n: 1\n")[0]?.code).toBe("HM1006");
  });

  it("rejects a second document", () => {
    expect(errorsOf("a: 1\n---\nb: 2\n")).toEqual([
      {
        code: "HM1006",
        message: "a spec file holds one YAML document, but this file has another after ---",
        at: "2:1",
      },
    ]);
    expect(errorsOf("---\na: 1\n...\n")).toEqual([]);
  });

  it("reports an empty file or one with only comments as HM1002 at the end of input", () => {
    expect(errorsOf("")).toEqual([{ code: "HM1002", message: "the file is empty", at: "1:1" }]);
    expect(errorsOf("# nothing yet\n")).toEqual([
      { code: "HM1002", message: "the file is empty", at: "1:14" },
    ]);
  });
});
