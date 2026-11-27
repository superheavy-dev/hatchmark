import { describe, expect, it } from "vitest";
import { JsonDocument } from "../../src/diagnostics/index.js";

function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

const seeds = [
  '{"title": "Sales", "charts": [{"type": "kpi", "metric": "net_revenue", "w": 3}], "x": null}',
  '[1, -0.5, 2e10, "a\\"b", true, false, {"k": [[], {}]}]',
  '{\n  "a": "é\\u00e9\\n",\n  "b": [\n    1,\n    2\n  ]\n}\n',
];
const alphabet = [
  "\r",
  "\ufeff",
  "\t",
  "0",
  '"',
  ",",
  ":",
  "{",
  "}",
  "[",
  "]",
  " ",
  "\n",
  "1",
  "e",
  "-",
  ".",
  "\\",
  "a",
  "/",
  "*",
  "t",
];

describe("JsonDocument agrees with JSON.parse on mutated input", () => {
  it("accepts exactly what JSON.parse accepts and yields the same value", () => {
    const random = lcg(20261127);
    let accepted = 0;
    for (let i = 0; i < 20000; i++) {
      let text = seeds[i % seeds.length] ?? "";
      const edits = 1 + Math.floor(random() * 3);
      for (let e = 0; e < edits; e++) {
        const at = Math.floor(random() * (text.length + 1));
        const roll = random();
        const ch = alphabet[Math.floor(random() * alphabet.length)] ?? "";
        if (roll < 0.4) text = text.slice(0, at) + text.slice(at + 1);
        else if (roll < 0.8) text = text.slice(0, at) + ch + text.slice(at);
        else text = text.slice(0, at) + ch + text.slice(at + 1);
      }
      let expected: { ok: true; value: unknown } | { ok: false };
      try {
        expected = { ok: true, value: JSON.parse(text) };
      } catch {
        expected = { ok: false };
      }
      const doc = new JsonDocument("x.json", text);
      const syntaxErrors = doc.errors.filter((err) => err.kind === "syntax");
      expect(syntaxErrors.length === 0, text).toBe(expected.ok);
      if (expected.ok) {
        accepted++;
        expect(doc.value, text).toEqual(expected.value);
      } else {
        const error = syntaxErrors[0];
        expect(error, text).toBeDefined();
        expect(error?.start, text).toBeGreaterThanOrEqual(0);
        expect(error?.start, text).toBeLessThanOrEqual(text.length);
      }
    }
    expect(accepted).toBeGreaterThan(1000);
  });
});
