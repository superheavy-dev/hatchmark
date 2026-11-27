// Fails when the repository tracks a JavaScript source file (.js, .mjs or .cjs). Hatchmark is
// written in TypeScript, which Node runs directly, so there is no reason to hand-write JavaScript.
// Only git-tracked files count, so build output such as dist/ never trips it.
import { execFileSync } from "node:child_process";

const ALLOWED = new Set<string>([]);

const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
  .split("\0")
  .filter((file) => /\.(?:js|mjs|cjs)$/.test(file) && !ALLOWED.has(file));

if (files.length > 0) {
  console.error("JavaScript source files are not allowed in this repository:");
  for (const file of files) console.error(`  ${file}`);
  console.error("Write them in TypeScript (.ts) instead; Node runs .ts files directly.");
  process.exit(1);
}
