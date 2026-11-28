import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { packageRoot } from "../../hatchmark/src/cli/package-root.js";
import { entries, head } from "./entries.js";
import { type BuildInfo, renderSite } from "./page.js";
import { periodProject } from "./periods.js";

const PACKAGES = dirname(
  await packageRoot(dirname(fileURLToPath(import.meta.url)), "@hatchmark/preview"),
);
const DIST = join(PACKAGES, "preview", "dist");
const HATCHMARK = join(PACKAGES, "hatchmark");
const BRAND = join(PACKAGES, "..", "assets", "brand");

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
  const mark = `hatchmark-mark-${scheme}.svg`;
  copyFileSync(join(BRAND, mark), join(site, "_brand", mark));
}
copyFileSync(
  join(HATCHMARK, "assets", "runtime", "hatchmark.js"),
  join(site, "_hatchmark", "hatchmark.js"),
);
function buildDashboards(cwd: string, out: string): void {
  const report = JSON.parse(
    execFileSync(
      process.execPath,
      [
        join(HATCHMARK, "dist", "cli", "bin.js"),
        "build",
        "--cwd",
        cwd,
        "--out",
        out,
        "--no-cache",
        "--json",
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
    ),
  );
  if (!report.ok) throw new Error(`hatchmark build failed: ${JSON.stringify(report.diagnostics)}`);
}
const example = join(HATCHMARK, "examples", "global-sales");
buildDashboards(example, join(site, "dashboard"));
for (const [locale, weekStart] of [
  ["de-DE", "monday"],
  ["ja-JP", "sunday"],
]) {
  const copy = mkdtempSync(join(tmpdir(), `hatchmark-preview-${locale}-`));
  try {
    cpSync(example, copy, {
      recursive: true,
      filter: (path) => !path.includes(join(example, "dist")),
    });
    const config = join(copy, "hatchmark.yaml");
    writeFileSync(
      config,
      readFileSync(config, "utf8")
        .replace(/^locale: .*$/m, `locale: ${locale}`)
        .replace(/^weekStart: .*$/m, `weekStart: ${weekStart}`),
    );
    buildDashboards(copy, join(site, `dashboard-${locale}`));
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
}
const periods = periodProject(example);
try {
  buildDashboards(periods, join(site, "periods"));
} finally {
  rmSync(periods, { recursive: true, force: true });
}
console.log(
  `Preview site written to ${site}: ${entries.length} gallery entries and the example dashboard in en-US, de-DE and ja-JP.`,
);
