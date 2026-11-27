import { describe, expect, it } from "vitest";
import { checkComments } from "./check-comments.ts";

const rules = (source: string, file = "probe.ts") =>
  checkComments(file, source).map((v) => `${v.line}:${v.rule}`);

describe("checkComments", () => {
  it("reads comments from the parser, not from strings, regexes, templates, JSX or shebangs", () => {
    expect(rules('const url = "https://example.com/*TODO*/";')).toEqual([]);
    expect(rules('if (true) /[//]TODO/.test("x");')).toEqual([]);
    expect(rules("const t = `${/[//]TODO/.test('x')}`;")).toEqual([]);
    expect(rules("#!/usr/bin/env -S node --title=review//TODO\nexport {};")).toEqual([]);
    expect(rules("const v = <p>https://example.test/TODO</p>;", "probe.tsx")).toEqual([]);
    expect(rules("const z = [10].with(0, 5) / 2; // TODO", "probe.ts")).toEqual(["1:todo"]);
    expect(rules("const v = <p>{/* FIXME */}</p>; // TODO", "probe.tsx")).toEqual([
      "1:todo",
      "1:todo",
    ]);
  });

  it("flags TODO-style markers but not the words in prose or code", () => {
    expect(
      rules(
        [
          "// TODO: later",
          "// FIXME",
          "/* HACK(alex): until DuckDB 2 */",
          "// Don't remove this (TODO: wait until it's deployed).",
        ].join("\n"),
      ),
    ).toEqual(["1:todo", "2:todo", "3:todo", "4:todo"]);
    expect(
      rules(
        [
          "// Works around the hack in DuckDB's CSV sniffer.",
          '/** @example setStatus("TODO"); */',
          "// XXX-large sizes are clamped by the browser.",
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  it("flags banners and dividers", () => {
    expect(rules("// ---- oracle ----\n/* ====== */\n// ****\n//////\n/**\n * #####\n */")).toEqual(
      ["1:divider", "2:divider", "3:divider", "4:divider", "6:divider"],
    );
    expect(rules('/// <reference lib="dom" />\n// See https://example.com/a----b')).toEqual([]);
  });

  it("flags suppressions without a reason", () => {
    expect(
      rules(
        [
          "// biome-ignore lint/suspicious/noExplicitAny:",
          "// biome-ignore lint/suspicious/noExplicitAny",
          "// biome-ignore lint/suspicious/noExplicitAny: ...",
          "// @ts-expect-error",
          "// @ts-ignore -- ----",
          "/// @ts-ignore",
        ].join("\n"),
      ),
    ).toEqual([
      "1:suppression-without-reason",
      "2:suppression-without-reason",
      "3:suppression-without-reason",
      "4:suppression-without-reason",
      "5:suppression-without-reason",
      "6:suppression-without-reason",
    ]);
    expect(
      rules(
        [
          "// biome-ignore lint/suspicious/noThenProperty: a JSON Schema keyword, not a thenable",
          "// @ts-expect-error -- the DOM lib lacks the CSS Typed OM types",
        ].join("\n"),
      ),
    ).toEqual([]);
  });
});
