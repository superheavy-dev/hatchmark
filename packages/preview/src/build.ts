import { execFileSync } from "node:child_process";
import { copyFileSync, cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { entries, head } from "./entries.js";
import { type BuildInfo, renderSite } from "./page.js";

/** packages/, from dist/lib/preview/src/build.js (tsc compiles the hatchmark gallery sources too). */
const PACKAGES = fileURLToPath(new URL("../../../../../", import.meta.url));
const DIST = join(PACKAGES, "preview", "dist");
const HATCHMARK = join(PACKAGES, "hatchmark");
const BRAND = join(PACKAGES, "..", "assets", "brand");

/** Reads the build info the workflow passes in PREVIEW_PR and PREVIEW_SHA. */
export function buildInfo(env: Readonly<Record<string, string | undefined>>): BuildInfo {
  const pr = Number(env.PREVIEW_PR);
  return {
    ...(Number.isInteger(pr) && pr > 0 ? { pr } : {}),
    ...(env.PREVIEW_SHA ? { sha: env.PREVIEW_SHA } : {}),
  };
}

function write(dir: string, files: Map<string, string>): void {
  rmSync(dir, { recursive: true, force: true });
  for (const [path, content] of files) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
}

const site = join(DIST, "site");
write(site, renderSite({ entries, head, build: buildInfo(process.env) }));
cpSync(join(HATCHMARK, "assets", "fonts"), join(site, "_hatchmark"), { recursive: true });
for (const icon of [
  "favicon.svg",
  "favicon.ico",
  "favicon-16.png",
  "favicon-32.png",
  "apple-touch-icon-180.png",
]) {
  copyFileSync(join(BRAND, icon), join(site, icon));
}
mkdirSync(join(site, "_brand"));
for (const scheme of ["light", "dark"]) {
  const lockup = `hatchmark-lockup-horizontal-${scheme}.svg`;
  copyFileSync(join(BRAND, lockup), join(site, "_brand", lockup));
}
copyFileSync(
  join(HATCHMARK, "assets", "runtime", "hatchmark.js"),
  join(site, "_hatchmark", "hatchmark.js"),
);
const dashboard = JSON.parse(
  execFileSync(
    process.execPath,
    [
      join(HATCHMARK, "dist", "cli", "bin.js"),
      "build",
      "--cwd",
      join(HATCHMARK, "examples", "global-sales"),
      "--out",
      join(site, "dashboard"),
      "--json",
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  ),
);
if (!dashboard.ok)
  throw new Error(`hatchmark build failed: ${JSON.stringify(dashboard.diagnostics)}`);
console.log(
  `Preview site written to ${site}: ${entries.length} gallery entries and the example dashboard.`,
);
