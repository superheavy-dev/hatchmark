import { describe, expect, it } from "vitest";
import { checkComments, scanComments } from "./check-comments.ts";

const rules = (source: string) => checkComments(source).map((v) => `${v.line}:${v.rule}`);

describe("scanComments", () => {
  it("ignores comment markers inside strings, templates and regexes", () => {
    const source = [
      'const url = "https://example.com/*not*/";',
      `const t = \`a // b \${x ? \`/* c */\` : "//"} d\`;`,
      "const r = /\\/\\/[/*]/g.test(url) ? 1 / 2 : 3;",
      "const nested = { a: { b: 1 } }; // real",
    ].join("\n");
    expect(scanComments(source).map((c) => c.text.trim())).toEqual(["real"]);
  });

  it("tracks line numbers across block comments and templates", () => {
    const source = "/**\n * doc\n */\nconst a = `\n`;\n// here";
    expect(scanComments(source).map((c) => [c.line, c.doc])).toEqual([
      [1, true],
      [6, false],
    ]);
  });
});

describe("checkComments", () => {
  it("flags commented-out code", () => {
    expect(
      rules(
        [
          "// const total = rows.length;",
          "// import { x } from './x.ts';",
          "// if (rows.length > 0) {",
          "// console.log(total);",
          "// }",
          "/* return total; */",
        ].join("\n"),
      ),
    ).toEqual([
      "1:commented-out-code",
      "2:commented-out-code",
      "3:commented-out-code",
      "4:commented-out-code",
      "5:commented-out-code",
      "6:commented-out-code",
    ]);
  });

  it("flags banners, dividers and TODO markers", () => {
    expect(rules("// ---- oracle ----\n/* ====== */\n// TODO: later\n// FIXME")).toEqual([
      "1:divider",
      "2:divider",
      "3:todo",
      "4:todo",
    ]);
  });

  it("flags suppressions without a reason", () => {
    expect(
      rules(
        [
          "// biome-ignore lint/suspicious/noExplicitAny:",
          "// biome-ignore lint/suspicious/noExplicitAny",
          "// @ts-expect-error",
          "// @ts-ignore -- ",
        ].join("\n"),
      ),
    ).toEqual([
      "1:suppression-without-reason",
      "2:suppression-without-reason",
      "3:suppression-without-reason",
      "4:suppression-without-reason",
    ]);
  });

  it("accepts the allowed kinds", () => {
    const source = [
      "// SPDX-License-Identifier: Apache-2.0",
      "// DuckDB returns BIGINT as bigint; Number() keeps JSON.stringify working.",
      "// Safari ignores scrollbar-gutter on tables, so the wrapper reserves the space.",
      "// See https://github.com/duckdb/duckdb/issues/1234 for the overflow;",
      "/**",
      " * Builds the dashboard. Throws when the spec is invalid; callers catch it.",
      " * @example build(spec);",
      " */",
      "// biome-ignore lint/suspicious/noThenProperty: a JSON Schema keyword, not a thenable",
      "// @ts-expect-error -- the DOM lib lacks the CSS Typed OM types",
      '/// <reference types="vite/client" />',
    ].join("\n");
    expect(rules(source)).toEqual([]);
  });
});
