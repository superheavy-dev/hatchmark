import { describe, expect, it } from "vitest";
import { JsonDocument, parseJsonFile } from "../../src/diagnostics/index.js";

function errorsOf(text: string) {
  return parseJsonFile("x.json", text).diagnostics.map((d) => ({
    code: d.code,
    message: d.message,
    at: d.range ? `${d.range.start.line}:${d.range.start.column}` : undefined,
    fix: d.fix?.op === "text" ? d.fix.text : undefined,
  }));
}

describe("JsonDocument", () => {
  it("parses the same values as JSON.parse", () => {
    const samples = [
      '{"a": [1, -2.5e3, true, false, null], "b": {"c": "d\\u00e9\\n"}}',
      "[]",
      "{}",
      '"x"',
      "0",
      '{"__proto__": {"polluted": true}}',
    ];
    for (const text of samples) {
      const doc = new JsonDocument("x.json", text);
      expect(doc.errors).toEqual([]);
      expect(doc.value).toEqual(JSON.parse(text));
    }
  });

  it("keeps __proto__ as an own property instead of setting the prototype", () => {
    const value = new JsonDocument("x.json", '{"__proto__": {"polluted": true}}').value as object;
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
    expect(Object.keys(value)).toEqual(["__proto__"]);
  });

  it("maps JSON Pointers to 1-based line and column ranges", () => {
    const text = '{\n  "charts": [\n    {"metric": "net_revenu"}\n  ]\n}\n';
    const doc = new JsonDocument("dashboards/sales.json", text);
    expect(doc.rangeOf("/charts/0/metric")).toEqual({
      start: { line: 3, column: 16 },
      end: { line: 3, column: 28 },
    });
    expect(doc.rangeOf("/charts/0/metric", "key")).toEqual({
      start: { line: 3, column: 6 },
      end: { line: 3, column: 14 },
    });
  });

  it("resolves a missing pointer to its deepest existing ancestor", () => {
    const doc = new JsonDocument("x.json", '{\n  "a": {\n    "b": 1\n  }\n}');
    expect(doc.locate("/a/missing")?.exact).toBe(false);
    expect(doc.rangeOf("/a/missing")?.start).toEqual({ line: 2, column: 3 });
    expect(doc.rangeOf("/nothing/deeper")?.start).toEqual({ line: 1, column: 1 });
  });

  it("decodes escaped pointer tokens", () => {
    const doc = new JsonDocument("x.json", '{"a/b": {"m~n": 1}}');
    expect(doc.locate("/a~1b/m~0n")?.exact).toBe(true);
  });

  it("counts columns in code points, not UTF-16 units", () => {
    const doc = new JsonDocument("x.json", '{"t": "📈", "v": 1}');
    expect(doc.rangeOf("/v")?.start).toEqual({ line: 1, column: 17 });
  });

  it("ignores a leading byte order mark", () => {
    expect(new JsonDocument("x.json", "\ufeff[1]").value).toEqual([1]);
  });

  it("handles CRLF line endings", () => {
    const doc = new JsonDocument("x.json", '{\r\n  "a": 1\r\n}');
    expect(doc.rangeOf("/a")?.start).toEqual({ line: 2, column: 8 });
    expect(doc.lineText(2)).toBe('  "a": 1');
  });
});

describe("parseJsonFile syntax diagnostics", () => {
  it("reports a trailing comma with a safe deletion", () => {
    expect(errorsOf('{\n  "a": 1,\n}')).toEqual([
      { code: "HM1002", message: "trailing commas are not allowed in JSON", at: "2:9", fix: "" },
    ]);
    expect(errorsOf("[1, 2, ]")[0]).toMatchObject({ at: "1:6", fix: "" });
  });

  it("reports comments with a safe deletion", () => {
    expect(errorsOf('{\n  // note\n  "a": 1\n}')[0]).toMatchObject({
      message: "comments are not allowed in JSON",
      at: "2:3",
      fix: "",
    });
    expect(errorsOf('{"a": /* x */ 1}')[0]).toMatchObject({ at: "1:7" });
  });

  it("offers a comma between properties", () => {
    expect(errorsOf('{"a": 1\n "b": 2}')[0]).toMatchObject({
      message: 'expected "," between properties',
      at: "2:2",
      fix: ",",
    });
  });

  it("explains unquoted keys, single quotes and bare words", () => {
    expect(errorsOf("{a: 1}")[0]?.message).toBe("object keys must be strings in double quotes");
    expect(errorsOf("{\"a\": 'x'}")[0]?.message).toBe("strings must use double quotes");
    expect(errorsOf('{"a": revenue}')[0]?.message).toBe(
      'unexpected word "revenue": strings must be in double quotes',
    );
  });

  it("rejects malformed numbers, escapes and strings", () => {
    for (const text of ["01", "1.", "+1", "0x10", "NaN", '"\\x"', '"abc', '"a\nb"', "1 2", ""]) {
      expect(errorsOf(text).length, text).toBe(1);
      expect(errorsOf(text)[0]?.code, text).toBe("HM1002");
    }
  });

  it("reports duplicate keys with the first occurrence", () => {
    const { diagnostics, document } = parseJsonFile("x.json", '{\n  "a": 1,\n  "a": 2\n}');
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      code: "HM1003",
      message: 'duplicate key "a"',
      range: { start: { line: 3, column: 3 } },
      help: "the first one is at line 2; keep one of them",
    });
    expect(document.value).toEqual({ a: 2 });
  });
});
