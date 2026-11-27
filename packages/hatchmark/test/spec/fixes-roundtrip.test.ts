import { describe, expect, it } from "vitest";
import { SpecDocument } from "../../src/diagnostics/index.js";
import { addPropertyFix, replaceValueFix } from "../../src/spec/fixes.js";
import { applyFix } from "./helpers.js";

const STRINGS = [
  "",
  " ",
  "x",
  "0123",
  "08",
  "1e3",
  ".5",
  "+1",
  "0x10",
  "0o17",
  ".inf",
  "-.inf",
  ".nan",
  ".NaN",
  "1_000",
  "12:30",
  "2026-01-01",
  "true",
  "True",
  "TRUE",
  "false",
  "yes",
  "no",
  "on",
  "off",
  "y",
  "n",
  "null",
  "Null",
  "NULL",
  "~",
  "-",
  "--",
  "---",
  "...",
  "- x",
  "-x",
  "?",
  "? x",
  "?x",
  ":",
  "a:",
  "a: b",
  "a:b",
  ":a",
  "#",
  "#x",
  "a #b",
  "a#b",
  "a\t#b",
  " a",
  "a ",
  "\ta",
  "a\t",
  "'",
  "''",
  '"',
  "'a'",
  '"a"',
  "a'b",
  'a"b',
  "\\",
  "a\\nb",
  "&a",
  "*a",
  "!a",
  "!!str",
  "%a",
  "@a",
  "`a",
  "|",
  ">",
  "|-",
  "a, b",
  "[a]",
  "{a}",
  "a]",
  "a}",
  "a\nb",
  "a\r\nb",
  "a\n",
  "\n",
  "a\u2028b",
  "a\u0085b",
  "\ufeffa",
  "a\ufeff",
  "a\u0000b",
  "a\u0007b",
  "\u00a0",
  "a\u00a0",
  "a\u3000",
  "😀",
  "é",
  "Store #12",
  "<<",
  "=",
  "a=b",
  "$hm_p1",
  "{{revenue}}",
  "x".repeat(300),
  "a  b",
  "a\t\tb",
  "-1",
  "-0",
  "0",
  "00",
  "1.",
  "1.0",
  "1e+3",
  "0b101",
  "0.1e-5",
];
const VALUES: unknown[] = [
  ...STRINGS,
  0,
  1,
  -1,
  1.5,
  1e21,
  1e-7,
  0.1,
  true,
  false,
  null,
  [],
  ["a,b", "0123", "x y", "#c", ""],
  [1, "1"],
  {},
  { a: "0123" },
  { "a b": 1, on: "yes" },
  { "x: y": ["#", "[]"] },
  [{ a: [{ b: "c, d" }] }],
];
const OLD: Record<string, string> = {
  plain: "old",
  single: "'old'",
  double: '"old"',
  literal: "|\n  old\n",
  literalKeep: "|+\n  old\n\n",
  literalKeepEnd: "|+\n  old",
  foldedKeep: ">+\n  old\n\n",
  folded: ">\n  old\n",
  comment: "old # c",
  multiplain: "old\n  more",
  number: "5",
  flowseq: "[a, b]",
  flowmap: "{a: 1}",
  blockseq: "\n  - a\n  - b",
  blockmap: "\n  a: 1",
  empty: "",
  tilde: "~",
  tagged: "!!str old",
};

function contexts(): { name: string; text: string; pointer: string }[] {
  const out: { name: string; text: string; pointer: string }[] = [];
  for (const [name, old] of Object.entries(OLD)) {
    out.push({ name: `block ${name}`, text: `x: ${old}\ny: 1\n`, pointer: "/x" });
    out.push({ name: `end of file ${name}`, text: `y: 1\nx: ${old}`, pointer: "/x" });
    out.push({
      name: `crlf ${name}`,
      text: `x: ${old}\ny: 1\n`.replace(/\n/g, "\r\n"),
      pointer: "/x",
    });
    out.push({
      name: `list item ${name}`,
      text: `- x: ${old.replace(/\n {2}/g, "\n    ")}\n  y: 1\n`,
      pointer: "/0/x",
    });
  }
  for (const old of ["old", "'old'", '"old"', "[a, b]", "{a: 1}", "5"]) {
    out.push({ name: `flow map ${old}`, text: `{x: ${old}, y: 1}\n`, pointer: "/x" });
    out.push({ name: `flow map last ${old}`, text: `z: {y: 1, x: ${old}}\n`, pointer: "/z/x" });
    out.push({ name: `flow list ${old}`, text: `x: [${old}, 2]\n`, pointer: "/x/0" });
    out.push({ name: `flow list last ${old}`, text: `x: [2, ${old}]\n`, pointer: "/x/1" });
    out.push({
      name: `multi-line flow list ${old}`,
      text: `x: [\n  2,\n  ${old},\n]\n`,
      pointer: "/x/1",
    });
    out.push({ name: `block list ${old}`, text: `x:\n  - ${old}\n  - 2\n`, pointer: "/x/0" });
    out.push({ name: `block list last ${old}`, text: `x:\n  - 2\n  - ${old}\n`, pointer: "/x/1" });
  }
  return out;
}

const same = (a: unknown, b: unknown) => {
  const key = (_: string, v: unknown) => (Object.is(v, -0) ? "-0" : v);
  return JSON.stringify(a, key) === JSON.stringify(b, key);
};

function withValue(root: unknown, pointer: string, value: unknown): unknown {
  const copy = structuredClone(root) as Record<string, unknown>;
  const keys = pointer.split("/").slice(1);
  let target = copy;
  for (const k of keys.slice(0, -1)) target = target[k] as Record<string, unknown>;
  target[keys.at(-1) ?? ""] = value;
  return copy;
}

describe("fixes read back as exactly the value they write", () => {
  it("replaces a value in every block, flow, end-of-file and CRLF position", () => {
    const failures: string[] = [];
    for (const context of contexts()) {
      const doc = new SpecDocument("x.yaml", context.text);
      expect(doc.errors, context.name).toEqual([]);
      for (const value of VALUES) {
        const fix = replaceValueFix(doc, context.pointer, value, "safe", "replace");
        const fixed = new SpecDocument("x.yaml", applyFix(context.text, fix));
        if (
          fixed.errors.length > 0 ||
          !same(fixed.value, withValue(doc.value, context.pointer, value))
        )
          failures.push(
            `${context.name}: ${JSON.stringify(value)} as ${JSON.stringify(fix?.text)}`,
          );
      }
    }
    expect(failures.slice(0, 10)).toEqual([]);
  });

  it("adds a property after every kind of last value, without changing it", () => {
    const objects: Record<string, string> = {
      block: "a: 1\nb: B\n",
      "end of file": "a: 1\nb: B",
      crlf: "a: 1\r\nb: B\r\n",
      "list item": "- a: 1\n  b: B\n",
      "only member": "b: B",
      "list item at end of file": "- a: 1\n  b: B",
      nested: "o:\n  a: 1\n  b: B\nz: 2\n",
    };
    const lasts: Record<string, string> = {
      plain: "x",
      empty: "",
      literal: "|\n  x\n",
      literalKeep: "|+\n  x\n\n",
      literalKeepEnd: "|+\n  x",
      foldedKeep: ">+\n  x\n\n",
      literalStrip: "|-\n  x\n",
      folded: ">\n  x\n",
      comment: "x # c",
      blockseq: "\n  - x",
      flowmap: "{c: 1}",
      multiplain: "x\n  y",
      single: "'x'",
      tagged: "!!str x",
    };
    const failures: string[] = [];
    for (const [objectName, object] of Object.entries(objects))
      for (const [lastName, last] of Object.entries(lasts)) {
        const list = objectName.startsWith("list item");
        const nested = list || objectName === "nested";
        const text = object.replace("B", last.replace(/\n {2}/g, nested ? "\n    " : "\n  "));
        const pointer = list ? "/0" : objectName === "nested" ? "/o" : "";
        const doc = new SpecDocument("x.yaml", text);
        expect(doc.errors, text).toEqual([]);
        const parent = (
          pointer === ""
            ? doc.value
            : pointer === "/0"
              ? (doc.value as unknown[])[0]
              : (doc.value as Record<string, unknown>).o
        ) as Record<string, unknown>;
        for (const value of VALUES) {
          const fix = addPropertyFix(doc, pointer, "newkey", value, "safe", "add");
          const fixed = new SpecDocument("x.yaml", applyFix(text, fix));
          const { b, ...rest } = parent;
          const added =
            /[\r\n]$/.test(text) || !last.startsWith("|+")
              ? { ...parent, newkey: value }
              : { ...rest, newkey: value, b };
          const want = pointer === "" ? added : withValue(doc.value, pointer, added);
          if (fixed.errors.length > 0 || !same(fixed.value, want))
            failures.push(
              `${objectName} after ${lastName}: ${JSON.stringify(value)} gives ${JSON.stringify(applyFix(text, fix))}`,
            );
        }
      }
    for (const text of ["x: {}\n", "x: {a: 1}\n", "x: {\n  a: 1,\n}\n", "x: {a: {b: 1}}\n"]) {
      const doc = new SpecDocument("x.yaml", text);
      for (const value of VALUES) {
        const fix = addPropertyFix(doc, "/x", "newkey", value, "safe", "add");
        const fixed = new SpecDocument("x.yaml", applyFix(text, fix));
        const x = (doc.value as Record<string, Record<string, unknown>>).x;
        if (fixed.errors.length > 0 || !same(fixed.value, { x: { ...x, newkey: value } }))
          failures.push(`${text}: ${JSON.stringify(value)}`);
      }
    }
    expect(failures.slice(0, 10)).toEqual([]);
  });
});
