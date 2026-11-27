import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { entries, head } from "./entries.js";
import { type BuildInfo, renderSite } from "./page.js";

const PACKAGE = fileURLToPath(new URL("../../", import.meta.url));
const REPO = join(PACKAGE, "../..");
const SITE = join(PACKAGE, "dist/site");
const EXAMPLE = join(REPO, "packages/hatchmark/examples/global-sales");
const HATCHMARK = join(REPO, "packages/hatchmark/dist/cli/bin.js");

/** Reads the build info the workflow passes in PREVIEW_PR and PREVIEW_SHA. */
export function buildInfo(env: Readonly<Record<string, string | undefined>>): BuildInfo {
  const pr = Number(env.PREVIEW_PR);
  return {
    ...(Number.isInteger(pr) && pr > 0 ? { pr } : {}),
    ...(env.PREVIEW_SHA ? { sha: env.PREVIEW_SHA } : {}),
  };
}

function hatchmark(args: string[]) {
  return spawnSync(process.execPath, [HATCHMARK, ...args], { encoding: "utf8" });
}

function hasBuildCommand(): boolean {
  if (!existsSync(HATCHMARK)) return false;
  const help = hatchmark(["--help", "--json"]);
  if (help.status !== 0) return false;
  const commands = (JSON.parse(help.stdout) as { commands: { name: string }[] }).commands;
  return commands.some((c) => c.name === "build");
}

/**
 * Builds the example dashboard into `out` with `hatchmark build` once that command and the
 * example exist. Returns whether it built; throws when the command exists but fails.
 */
function buildDashboard(out: string): boolean {
  if (!existsSync(EXAMPLE) || !hasBuildCommand()) return false;
  const result = hatchmark(["build", "--cwd", EXAMPLE, "--out", out]);
  if (result.status !== 0 || !existsSync(join(out, "index.html"))) {
    throw new Error(
      `hatchmark build failed for the example dashboard (exit ${result.status}):\n${result.stderr}${result.stdout}`,
    );
  }
  return true;
}

rmSync(SITE, { recursive: true, force: true });
mkdirSync(SITE, { recursive: true });
const dashboard = buildDashboard(join(SITE, "dashboard"));
const build = buildInfo(process.env);
for (const [path, content] of renderSite({ entries, head, build, dashboard })) {
  mkdirSync(dirname(join(SITE, path)), { recursive: true });
  writeFileSync(join(SITE, path), content);
}
console.log(
  `Preview site written to ${SITE}: ${entries.length} gallery entries, example dashboard ${dashboard ? "built" : "not built yet"}.`,
);
