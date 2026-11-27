import { describe, expect, it } from "vitest";
import { JsonDocument } from "../../src/diagnostics/index.js";
import { addPropertyFix, removeItemFix, replaceValueFix } from "../../src/spec/fixes.js";
import { applyFix } from "./helpers.js";

const doc = (text: string) => new JsonDocument("x.json", text);

describe("text fixes", () => {
  it("remove any array item and keep valid JSON", () => {
    const text = '{"a": ["x", "y", "z"]}';
    expect(
      [0, 1, 2].map(
        (i) => JSON.parse(applyFix(text, removeItemFix(doc(text), "/a", i, "unsafe", "r"))).a,
      ),
    ).toEqual([
      ["y", "z"],
      ["x", "z"],
      ["x", "y"],
    ]);
    const one = '{"a": ["x"]}';
    expect(JSON.parse(applyFix(one, removeItemFix(doc(one), "/a", 0, "unsafe", "r")))).toEqual({
      a: [],
    });
    expect(removeItemFix(doc(one), "/a", 3, "unsafe", "r")).toBeUndefined();
  });

  it("add a property to empty, compact and indented objects", () => {
    for (const text of ["{}", '{"a": 1}', '{\n    "a": 1\n}', '{\r\n\t"a": {"b": 2}\r\n}']) {
      const fixed = applyFix(text, addPropertyFix(doc(text), "", "k", [1, "v"], "safe", "add"));
      expect(JSON.parse(fixed)).toEqual({ ...JSON.parse(text), k: [1, "v"] });
    }
    expect(
      applyFix(
        '{\n    "a": 1\n}',
        addPropertyFix(doc('{\n    "a": 1\n}'), "", "k", 2, "safe", "add"),
      ),
    ).toBe('{\n    "a": 1,\n    "k": 2\n}');
    expect(addPropertyFix(doc("[]"), "", "k", 1, "safe", "add")).toBeUndefined();
  });

  it("replace a value with escaped JSON text", () => {
    const text = '{"a": "📈x"}';
    const fix = replaceValueFix(doc(text), "/a", 'say "hi"', "unsafe", "r");
    expect(fix?.text).toBe('"say \\"hi\\""');
    expect(JSON.parse(applyFix(text, fix))).toEqual({ a: 'say "hi"' });
    expect(replaceValueFix(doc(text), "/missing", 1, "unsafe", "r")).toBeUndefined();
  });
});
