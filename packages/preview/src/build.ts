import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { entries, head } from "./entries.js";
import { type BuildInfo, renderSite } from "./page.js";

const DIST = fileURLToPath(new URL("../", import.meta.url));

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
console.log(`Preview site written to ${site}: ${entries.length} gallery entries.`);
