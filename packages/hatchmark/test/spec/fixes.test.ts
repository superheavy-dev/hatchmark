import { describe, expect, it } from "vitest";
import { SpecDocument } from "../../src/diagnostics/index.js";
import { addPropertyFix, removeItemFix, replaceValueFix } from "../../src/spec/fixes.js";
import { fromYaml } from "../yaml.js";
import { applyFix } from "./helpers.js";

const doc = (text: string) => new SpecDocument("x.yaml", text);

describe("text fixes", () => {
  it("remove any item of a flow sequence and keep it valid", () => {
    const text = '{"a": ["x", "y", "z"]}';
    expect(
      [0, 1, 2].map(
        (i) => fromYaml(applyFix(text, removeItemFix(doc(text), "/a", i, "unsafe", "r"))).a,
      ),
    ).toEqual([
      ["y", "z"],
      ["x", "z"],
      ["x", "y"],
    ]);
    const one = '{"a": ["x"]}';
    expect(fromYaml(applyFix(one, removeItemFix(doc(one), "/a", 0, "unsafe", "r")))).toEqual({
      a: [],
    });
    expect(removeItemFix(doc(one), "/a", 3, "unsafe", "r")).toBeUndefined();
  });

  it("remove any item of a block sequence, leaving [] for the last one", () => {
    const text = "a:\n  - x\n  - type: y\n    id: y\n  - z\nb: 1\n";
    expect(
      [0, 1, 2].map(
        (i) => fromYaml(applyFix(text, removeItemFix(doc(text), "/a", i, "unsafe", "r"))).a,
      ),
    ).toEqual([
      [{ type: "y", id: "y" }, "z"],
      ["x", "z"],
      ["x", { type: "y", id: "y" }],
    ]);
    const one = "a:\n  - x\nb: 1\n";
    expect(fromYaml(applyFix(one, removeItemFix(doc(one), "/a", 0, "unsafe", "r")))).toEqual({
      a: [],
      b: 1,
    });
  });

  it("add a property at the end of a block mapping, after nested values and block scalars", () => {
    for (const text of [
      "a: 1\n",
      "a:\n  b: 2\n  c: [1]\n",
      "sql: |\n  sum(x)\n    - 1\n\n",
      "# comment\na: 1 # trailing\n",
    ]) {
      const fixed = applyFix(text, addPropertyFix(doc(text), "", "k", [1, "v"], "safe", "add"));
      expect(fromYaml(fixed), fixed).toEqual({ ...fromYaml(text), k: [1, "v"] });
    }
    const nested = "a:\n  b: 1\nz: 2\n";
    expect(applyFix(nested, addPropertyFix(doc(nested), "/a", "k", "v", "safe", "add"))).toBe(
      "a:\n  b: 1\n  k: v\nz: 2\n",
    );
  });

  it("add a property to empty, compact and indented objects", () => {
    for (const text of ["{}", '{"a": 1}', '{\n    "a": 1\n}', '{\r\n\t"a": {"b": 2}\r\n}']) {
      const fixed = applyFix(text, addPropertyFix(doc(text), "", "k", [1, "v"], "safe", "add"));
      expect(fromYaml(fixed)).toEqual({ ...fromYaml(text), k: [1, "v"] });
    }
    expect(
      applyFix(
        '{\n    "a": 1\n}',
        addPropertyFix(doc('{\n    "a": 1\n}'), "", "k", 2, "safe", "add"),
      ),
    ).toBe('{\n    "a": 1, k: 2\n}');
    expect(addPropertyFix(doc("[]"), "", "k", 1, "safe", "add")).toBeUndefined();
  });

  it("replace a value with YAML text that reads back as the same value", () => {
    const cases: [unknown, string][] = [
      ['say "hi"', 'say "hi"'],
      ["week", "week"],
      ["0123", '"0123"'],
      ["2026", '"2026"'],
      ["Store\u00a0", "Store\u00a0"],
      ["Store ", '"Store "'],
      [" Store", '" Store"'],
      ["a\tb", "a\tb"],
      ["yes", "yes"],
      ["true", '"true"'],
      ["a: b", '"a: b"'],
      ["Store #12", '"Store #12"'],
      ["a, b", '"a, b"'],
      ["[x]", '"[x]"'],
      ["two\nlines", '"two\\nlines"'],
      [{ unit: "year", anchor: "07-01" }, "{unit: year, anchor: 07-01}"],
      [["day", "week"], "[day, week]"],
      [12, "12"],
      [false, "false"],
    ];
    for (const text of ['{"a": "📈x"}', "a: x\n", "b: [1, {a: x}]\n"]) {
      const pointer = text.startsWith("b") ? "/b/1/a" : "/a";
      for (const [value, written] of cases) {
        const fix = replaceValueFix(doc(text), pointer, value, "unsafe", "r");
        expect(fix?.text, String(value)).toBe(written);
        const fixed = new SpecDocument("x.yaml", applyFix(text, fix));
        expect(fixed.errors, `${text} ${String(value)}`).toEqual([]);
        expect(fixed.locate(pointer)?.node, `${text} ${String(value)}`).toBeDefined();
        const read = pointer
          .split("/")
          .slice(1)
          .reduce<unknown>((v, k) => (v as Record<string, unknown> | undefined)?.[k], fixed.value);
        expect(read, `${text} ${String(value)}`).toEqual(value);
      }
    }
    expect(replaceValueFix(doc("a: x\n"), "/missing", 1, "unsafe", "r")).toBeUndefined();
  });
});
