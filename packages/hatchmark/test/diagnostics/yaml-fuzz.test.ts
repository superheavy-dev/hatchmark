import { describe, expect, it } from "vitest";
import { parseAllDocuments, stringify } from "yaml";
import {
  type Position,
  parseYamlFile,
  type Range,
  SpecDocument,
} from "../../src/diagnostics/index.js";

function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

const seeds = [
  "title: Sales\nblocks:\n  - type: kpi\n    metric: net_revenue\n    span: 3\nx: null\n",
  "sql: |\n  sum(amount)\n    - sum(refund)\nfilters: [{ column: status, op: eq, value: 'paid' }]\n",
  'a: "é\\u00e9\\n"\nb:\n  - 1\n  - -0.5\n  - 2e10\nc: >-\n  folded\n  text\n',
];
const alphabet = [
  "\r",
  "\ufeff",
  "\t",
  "0",
  '"',
  "'",
  ",",
  ":",
  "{",
  "}",
  "[",
  "]",
  " ",
  "\n",
  "-",
  "#",
  "&",
  "*",
  "!",
  "|",
  ">",
  "a",
  "📈",
  "界",
];

function mutate(random: () => number, text: string): string {
  let out = text;
  const edits = 1 + Math.floor(random() * 3);
  for (let e = 0; e < edits; e++) {
    const at = Math.floor(random() * (out.length + 1));
    const ch = alphabet[Math.floor(random() * alphabet.length)] ?? "";
    out =
      random() < 0.5 ? out.slice(0, at) + out.slice(at + 1) : out.slice(0, at) + ch + out.slice(at);
  }
  return out;
}

const before = (a: Position, b: Position): boolean =>
  a.line < b.line || (a.line === b.line && a.column <= b.column);

describe("SpecDocument agrees with the yaml package on mutated input", () => {
  it("reports a syntax error exactly when the yaml package does, and otherwise the same value", () => {
    const random = lcg(20261128);
    let accepted = 0;
    for (let i = 0; i < 5000; i++) {
      const text = mutate(random, seeds[i % seeds.length] ?? "");
      const docs = parseAllDocuments(text, {
        version: "1.2",
        schema: "core",
        strict: true,
        uniqueKeys: false,
        merge: false,
        prettyErrors: false,
      });
      const list = Array.isArray(docs) ? docs : [];
      const libErrors = list.some(
        (d) => d.errors.length > 0 || d.warnings.some((w) => w.code !== "TAG_RESOLVE_FAILED"),
      );
      const doc = new SpecDocument("x.yaml", text);
      expect(
        doc.errors.some((e) => e.kind === "syntax"),
        text,
      ).toBe(libErrors);
      if (doc.errors.length === 0) {
        accepted++;
        expect(list.length, text).toBeLessThanOrEqual(1);
        expect(doc.value, text).toEqual(list[0]?.toJS() ?? null);
      }
    }
    expect(accepted).toBeGreaterThan(500);
  });
});

describe("span invariants", () => {
  it("keep every range inside the text, non-empty for diagnostics, with a frame from that text", () => {
    const random = lcg(1127);
    const extra = ['"\\', "📈", "", " ", '"a', "[1,", "\r\n", "a: &x 1\nb: *x", "a: 1\n---\nb: 2"];
    const inputs = [
      ...extra,
      ...Array.from({ length: 3000 }, (_, i) => mutate(random, seeds[i % seeds.length] ?? "")),
    ];
    for (const text of inputs) {
      const doc = new SpecDocument("x.yaml", text);
      const eof = doc.positionAt(text.length);
      const checkRange = (range: Range, allowEmpty: boolean) => {
        expect(before({ line: 1, column: 1 }, range.start), text).toBe(true);
        expect(before(range.start, range.end), text).toBe(true);
        expect(before(range.end, eof), text).toBe(true);
        const empty =
          range.start.line === range.end.line && range.start.column === range.end.column;
        if (empty && !allowEmpty)
          expect(text, "only an empty file has an empty diagnostic range").toBe("");
      };
      const { diagnostics } = parseYamlFile("x.yaml", text);
      const located = [
        ...diagnostics,
        ...Array.from({ length: 4 }, () => {
          const a = Math.floor(random() * (text.length + 20)) - 10;
          const b = Math.floor(random() * (text.length + 20)) - 10;
          return doc.location(a, b);
        }),
        doc.location(Number.NaN, Number.POSITIVE_INFINITY),
      ];
      for (const d of located) {
        if (!d.range) continue;
        checkRange(d.range, false);
        if (d.frame) {
          const line = [...doc.lineText(d.range.start.line)];
          expect(
            line
              .slice(d.frame.column - 1)
              .join("")
              .startsWith(d.frame.text),
            text,
          ).toBe(true);
        }
      }
    }
  });
});

describe("stringOffset on every scalar style", () => {
  const WORDS = ["a", "bb", "é", "😀", "x#y", "q'q", 'd"d', "b\\s", "--", ":", "-", "  ", "\t"];
  const STYLES = [
    "PLAIN",
    "QUOTE_SINGLE",
    "QUOTE_DOUBLE",
    "BLOCK_LITERAL",
    "BLOCK_FOLDED",
  ] as const;
  it("maps a token's start and end to the token in the source, however the value is written", () => {
    const random = lcg(1839);
    let checked = 0;
    for (let n = 0; n < 400; n++) {
      const words = Array.from(
        { length: 2 + Math.floor(random() * 14) },
        () => WORDS[Math.floor(random() * WORDS.length)],
      );
      const at = Math.floor(random() * (words.length + 1));
      words.splice(at, 0, "{{tok}}");
      const value = words.join(random() < 0.2 ? "\n" : " ").trim();
      const style = STYLES[Math.floor(random() * STYLES.length)] ?? "PLAIN";
      const text = stringify(
        { x: value },
        {
          version: "1.2",
          defaultStringType: style,
          lineWidth: 12 + Math.floor(random() * 30),
          minContentWidth: 4,
        },
      );
      const doc = new SpecDocument("x.yaml", text);
      const node = doc.locate("/x")?.node;
      if (node?.kind !== "string" || node.value !== value) continue;
      const index = node.value.indexOf("{{tok}}");
      const start = doc.stringOffset(node, index);
      const end = doc.stringOffset(node, index + "{{tok}}".length, "end");
      const where = JSON.stringify(text);
      expect(text[start], where).toBe("{");
      expect(text[end - 1], where).toBe("}");
      expect(text.slice(start, end).replace(/\\\r?\n\s*/g, ""), where).toBe("{{tok}}");
      checked++;
    }
    expect(checked).toBeGreaterThan(300);
  });
});
