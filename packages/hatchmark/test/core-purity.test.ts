import { readdirSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { fileURLToPath } from "node:url";
import { build, transform } from "esbuild";
import { describe, expect, it } from "vitest";

const CORE = ["compiler", "diagnostics", "render", "spec"];
const BUILTINS = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));
const GLOBALS = /\brequire\s*\(|\bprocess\s*[.[]|\bBuffer\b|\b__(?:dirname|filename)\b/;

function files(dir: URL): URL[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? files(new URL(`${entry.name}/`, dir))
      : entry.name.endsWith(".ts")
        ? [new URL(entry.name, dir)]
        : [],
  );
}

const coreFiles = CORE.flatMap((module) => files(new URL(`../src/${module}/`, import.meta.url)));
const label = (file: string) => file.split("/src/")[1] ?? file;

async function imports(
  entries: string[] = coreFiles.map((f) => fileURLToPath(f)),
): Promise<{ importer: string; kind: string; path: string }[]> {
  const found: { importer: string; kind: string; path: string }[] = [];
  await build({
    entryPoints: entries,
    bundle: true,
    write: false,
    outdir: "unused",
    platform: "neutral",
    logLevel: "silent",
    plugins: [
      {
        name: "record-imports",
        setup(b) {
          b.onResolve({ filter: /.*/ }, (args) => {
            if (args.kind === "entry-point") return undefined;
            found.push({ importer: label(args.importer), kind: args.kind, path: args.path });
            return args.path.startsWith(".") ? undefined : { path: args.path, external: true };
          });
        },
      },
    ],
  });
  return found;
}

const HIDDEN =
  /\bimport\s*\((?!\s*(?:\/\*[\s\S]*?\*\/\s*)*["'])|\brequire\s*\(|\beval\s*\(|\bFunction\s*\(/g;

/**
 * Lines that load code the import graph cannot follow. esbuild strips comments and types first and
 * prints every literal import() as import("..."), so a remaining import( without a quote is computed.
 */
async function hiddenImports(source: string, name: string): Promise<string[]> {
  const { code } = await transform(source, { loader: "ts", legalComments: "none" });
  const lines = code.split("\n");
  return [...code.matchAll(HIDDEN)].map((match) => {
    const line = code.slice(0, match.index).split("\n").length;
    return `${name}: ${lines[line - 1]?.trim()}`;
  });
}

describe("engine core", () => {
  it("imports no Node built-in in any form, so it runs in browsers and workers", async () => {
    const found = await imports();
    expect(found.some((i) => i.path === "zod")).toBe(true);
    const offenders = found
      .filter((i) => i.path.startsWith("node:") || BUILTINS.has(i.path.split("/")[0] ?? ""))
      .map((i) => `${i.importer}: ${i.kind} "${i.path}"`);
    expect(offenders).toEqual([]);
  });

  it("catches every import form of a built-in", async () => {
    const dir = new URL("./fixtures/purity/", import.meta.url);
    const found = await imports(files(dir).map((f) => fileURLToPath(f)));
    const flagged = found
      .filter((i) => i.path.startsWith("node:") || BUILTINS.has(i.path.split("/")[0] ?? ""))
      .map((i) => `${i.importer.split("/").pop()} ${i.kind} ${i.path}`)
      .sort();
    expect(flagged).toEqual([
      "bare.ts import-statement path",
      "dynamic.ts dynamic-import fs",
      "multiline.ts dynamic-import node:fs/promises",
      "reexport.ts import-statement crypto",
      "require.ts require-call node:os",
      "side-effect.ts import-statement node:fs",
      "subpath.ts import-statement fs/promises",
    ]);
  });

  it("has no import the graph cannot see: computed import(), require, eval or Function", async () => {
    const offenders: string[] = [];
    for (const file of coreFiles) {
      offenders.push(...(await hiddenImports(readFileSync(file, "utf8"), label(file.pathname))));
    }
    expect(offenders).toEqual([]);
    const probe = [
      "export async function probe() {",
      '  const moduleName = "node:fs/promises";',
      "  return import(moduleName);",
      "}",
      'export const literal = () => import(/* fine */ "./plan.js");',
      "export const run = (code: string) => new Function(code);",
    ].join("\n");
    expect(await hiddenImports(probe, "probe.ts")).toEqual([
      "probe.ts: return import(moduleName);",
      "probe.ts: export const run = (code) => new Function(code);",
    ]);
  });

  it("uses no Node-only globals", () => {
    const offenders: string[] = [];
    for (const file of coreFiles) {
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (GLOBALS.test(line))
            offenders.push(`${label(file.pathname)}:${i + 1}: ${line.trim()}`);
        });
    }
    expect(offenders).toEqual([]);
  });
});
