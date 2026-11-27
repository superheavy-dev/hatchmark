import { describe, expect, it } from "vitest";
import { JsonDocument, parseJsonFile } from "../../src/diagnostics/index.js";

function errorsOf(text: string) {
  return parseJsonFile("x.json", text).diagnostics.map((d) => ({
    code: d.code,
    message: d.message,
    at: d.range ? `${d.range.start.line}:${d.range.start.column}` : undefined,
    fix: d.fix?.text,
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

  it("parses deeply nested input without overflowing the stack", () => {
    const depth = 100_000;
    const text = `${"[".repeat(depth)}0${"]".repeat(depth)}`;
    const doc = new JsonDocument("x.json", text);
    expect(doc.errors).toEqual([]);
    let value = doc.value;
    for (let i = 0; i < depth; i++) value = (value as unknown[])[0];
    expect(value).toBe(0);
    const objects = `${'{"a":'.repeat(depth)}1${"}".repeat(depth)}`;
    expect(new JsonDocument("x.json", objects).errors).toEqual([]);
  });

  it("maps positions in linear time on one long line", () => {
    const item = `{"a":1,"a":2,"v":"${"x".repeat(1000)}"},`;
    const time = (n: number) => {
      const text = `[${item.repeat(n)}0]`;
      const t0 = performance.now();
      const { diagnostics } = parseJsonFile("x.json", text);
      expect(diagnostics).toHaveLength(n);
      return performance.now() - t0;
    };
    time(200);
    const small = time(1000);
    const large = time(4000);
    expect(large).toBeLessThan(small * 12 + 50);
    expect(large).toBeLessThan(2000);
  });

  it("treats a lone carriage return as a line break", () => {
    const doc = new JsonDocument("x.json", '{\r  "a": 1,\r  "b": 2\r}');
    expect(doc.rangeOf("/b")?.start).toEqual({ line: 3, column: 8 });
    expect(doc.lineText(2)).toBe('  "a": 1,');
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

  it("rejects a leading byte order mark like JSON.parse, with a safe deletion", () => {
    expect(() => JSON.parse("\ufeff[1]")).toThrow();
    expect(errorsOf("\ufeff[1]")).toEqual([
      {
        code: "HM1002",
        message: "a byte order mark is not allowed at the start of a JSON file",
        at: "1:1",
        fix: "",
      },
    ]);
  });

  it("never joins tokens when deleting a comment", () => {
    const apply = (text: string) => {
      const d = parseJsonFile("x.json", text).diagnostics[0];
      if (d?.fix === undefined) throw new Error("no fix");
      const doc = new JsonDocument("x.json", text);
      const toOffset = (line: number, column: number) => {
        let offset = 0;
        for (let l = 1; l < line; l++) offset += doc.lineText(l).length + 1;
        return offset + column - 1;
      };
      const { start, end } = d.fix.range;
      return (
        text.slice(0, toOffset(start.line, start.column)) +
        d.fix.text +
        text.slice(toOffset(end.line, end.column))
      );
    };
    expect(apply("[1/*x*/2]")).toBe("[1 2]");
    expect(apply("[//x\r1,2]")).toBe("[\r1,2]");
    expect(JSON.parse(apply("[//x\r1,2]"))).toEqual([1, 2]);
    expect(apply("[1, // x\n2]")).toBe("[1, \n2]");
    expect(errorsOf("[1 /* open")[0]).toMatchObject({ code: "HM1002", fix: undefined });
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

  it("keeps error ranges inside the file and on whole code points", () => {
    for (const text of ['"\\', "📈", '"a', "[1,", "{", '["\\u12', "[📈]"]) {
      const [d] = parseJsonFile("x.json", text).diagnostics;
      const range = d?.range;
      expect(range, text).toBeDefined();
      if (!range) continue;
      const lastColumn = [...text].length + 1;
      expect(range.end.column, text).toBeLessThanOrEqual(lastColumn);
      expect(range.start.column, text).toBeLessThanOrEqual(range.end.column);
      if (range.start.column < lastColumn)
        expect(range.end.column, text).toBeGreaterThan(range.start.column);
    }
    expect(parseJsonFile("x.json", "📈").diagnostics[0]?.range).toEqual({
      start: { line: 1, column: 1 },
      end: { line: 1, column: 2 },
    });
  });

  it("clamps raw parser error offsets to the text", () => {
    for (const text of ['"\\', '["\\u12', "", "[", '"a']) {
      const { document, diagnostics } = parseJsonFile("x.json", text);
      for (const error of document.errors) {
        expect(error.start, text).toBeGreaterThanOrEqual(0);
        expect(error.start, text).toBeLessThanOrEqual(error.end);
        expect(error.end, text).toBeLessThanOrEqual(text.length);
        if (error.repair) expect(error.repair.end, text).toBeLessThanOrEqual(text.length);
      }
      expect(diagnostics.length, text).toBe(1);
    }
  });

  it("puts the empty-file error at the zero-width span at end of input", () => {
    const [d] = parseJsonFile("x.json", "").diagnostics;
    expect(d).toMatchObject({
      message: "expected a JSON value, found end of file",
      range: { start: { line: 1, column: 1 }, end: { line: 1, column: 1 } },
    });
    expect(d?.fix).toBeUndefined();
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

  it("points every repeat of a key at its first occurrence", () => {
    const { diagnostics } = parseJsonFile("x.json", '{\n"a":1,\n"a":2,\n"a":3\n}');
    expect(diagnostics.map((d) => [d.range?.start.line, d.label, d.help])).toEqual([
      [3, "repeated here", "the first one is at line 2; keep one of them"],
      [4, "repeated here", "the first one is at line 2; keep one of them"],
    ]);
  });
});
