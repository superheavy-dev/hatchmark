import { readdirSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { describe, expect, it } from "vitest";

const CORE = ["compiler", "diagnostics", "spec"];
const BUILTIN = builtinModules.map((m) => m.replace(/[/]/g, "\\/")).join("|");
const MODULE = `["'\`](?:node:[^"'\`]+|(?:${BUILTIN})(?:\\/[^"'\`]*)?)["'\`]`;
const NODE_ONLY = new RegExp(
  [
    `\\b(?:from|import)\\s*${MODULE}`,
    `\\b(?:import|require)\\s*\\(\\s*${MODULE}`,
    "\\brequire\\s*\\(",
    "\\bprocess\\s*[.[]",
    "\\bBuffer\\b",
    "\\b__(?:dirname|filename)\\b",
  ].join("|"),
);

function files(dir: URL): URL[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? files(new URL(`${entry.name}/`, dir))
      : entry.name.endsWith(".ts")
        ? [new URL(entry.name, dir)]
        : [],
  );
}

describe("engine core", () => {
  it("uses no Node-only APIs, so it runs in browsers and workers", () => {
    const offenders: string[] = [];
    for (const module of CORE) {
      for (const file of files(new URL(`../src/${module}/`, import.meta.url))) {
        readFileSync(file, "utf8")
          .split("\n")
          .forEach((line, i) => {
            if (NODE_ONLY.test(line))
              offenders.push(`${file.pathname.split("/src/")[1]}:${i + 1}: ${line.trim()}`);
          });
      }
    }
    expect(offenders).toEqual([]);
  });
});
