import { spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderPlaceholder } from "./page.js";

const PACKAGE = fileURLToPath(new URL("../../", import.meta.url));
const WRANGLER = join(
  dirname(createRequire(import.meta.url).resolve("wrangler/package.json")),
  "bin/wrangler.js",
);
/** Wrangler's own check before \`versions upload\` when the Worker is missing (API errors 10007 and 10090). */
const WORKER_NOT_FOUND = "Worker that does not yet exist";

/** One line of the file wrangler writes to WRANGLER_OUTPUT_FILE_PATH. */
interface WranglerOutput {
  type: string;
  code?: number;
  message?: string;
  version_id?: string;
  preview_url?: string;
  preview_alias_url?: string;
  targets?: string[];
}

function fail(message: string): never {
  console.error(`::error::${message}`);
  process.exit(1);
}

/** Runs wrangler with inherited output and returns the last entry it wrote to its output file. */
function wrangler(args: string[]): WranglerOutput | undefined {
  const dir = mkdtempSync(join(tmpdir(), "hatchmark-preview-"));
  const file = join(dir, "output.ndjson");
  writeFileSync(file, "");
  try {
    spawnSync(process.execPath, [WRANGLER, ...args], {
      cwd: PACKAGE,
      stdio: "inherit",
      env: { ...process.env, WRANGLER_OUTPUT_FILE_PATH: file, WRANGLER_SEND_METRICS: "false" },
    });
    const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
    return lines
      .map((line) => JSON.parse(line) as WranglerOutput)
      .filter((entry) => entry.type !== "wrangler-session")
      .at(-1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function output(values: Record<string, string>): void {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  for (const [key, value] of Object.entries(values)) appendFileSync(file, `${key}=${value}\n`);
}

function summary(markdown: string): void {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (file) appendFileSync(file, `${markdown}\n`);
}

/** Creates the Worker by deploying a placeholder page, so a pull request can upload versions to it. */
function createWorker(): void {
  console.log(
    "::notice::The preview Worker does not exist yet; deploying a placeholder page to create it.",
  );
  const dir = mkdtempSync(join(tmpdir(), "hatchmark-placeholder-"));
  try {
    for (const [path, content] of renderPlaceholder()) writeFileSync(join(dir, path), content);
    const result = wrangler([
      "deploy",
      "--assets",
      dir,
      "--message",
      "Placeholder until main deploys",
    ]);
    if (result?.type !== "deploy")
      fail(`Creating the preview Worker failed: ${result?.message ?? "no output"}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function deployPullRequest(pr: number, sha: string): void {
  const args = [
    "versions",
    "upload",
    "--preview-alias",
    `pr-${pr}`,
    "--message",
    `PR #${pr} at ${sha}`,
  ];
  let result = wrangler(args);
  if (result?.type === "command-failed" && result.message?.includes(WORKER_NOT_FOUND)) {
    createWorker();
    result = wrangler(args);
  }
  if (result?.type !== "version-upload")
    fail(`Uploading the preview failed: ${result?.message ?? "no output"}`);
  if (!result.preview_alias_url) {
    fail(
      "Wrangler uploaded the version but returned no preview alias URL; are preview URLs enabled on the Worker?",
    );
  }
  output({
    alias_url: result.preview_alias_url,
    version_url: result.preview_url ?? "",
    version_id: result.version_id ?? "",
  });
  summary(`Preview of PR #${pr} at \`${sha}\`: ${result.preview_alias_url}`);
}

function deployProduction(sha: string): void {
  const result = wrangler(["deploy", "--message", `main at ${sha}`]);
  if (result?.type !== "deploy") fail(`Deploying main failed: ${result?.message ?? "no output"}`);
  const url = result.targets?.[0] ?? "";
  output({ url });
  summary(`Gallery of main at \`${sha}\`: ${url}`);
}

if (!process.env.CLOUDFLARE_API_TOKEN || !process.env.CLOUDFLARE_ACCOUNT_ID) {
  console.log(
    "::notice::No Cloudflare credentials in this run (pull requests from forks and Dependabot get no secrets), so the preview is built but not deployed.",
  );
  process.exit(0);
}
const sha = process.env.PREVIEW_SHA ?? fail("PREVIEW_SHA is not set");
const mode = process.argv[2];
if (mode === "production") deployProduction(sha);
else if (mode === "pr") {
  const pr = Number(process.env.PREVIEW_PR);
  if (!Number.isInteger(pr) || pr <= 0) fail("PREVIEW_PR must be a pull request number");
  deployPullRequest(pr, sha);
} else fail("usage: deploy <pr|production>");
