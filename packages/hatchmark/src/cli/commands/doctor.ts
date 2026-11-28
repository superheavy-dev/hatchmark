import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_FILE, SCHEMA_FILES } from "../../spec/index.js";
import { VERSION } from "../../version.js";
import type { CommandHelp } from "../help.js";
import { type CommandContext, type CommandResult, EXIT } from "../io.js";
import { packageRoot } from "../package-root.js";

export const doctorHelp: CommandHelp = {
  name: "doctor",
  summary:
    "Check that this machine can run Hatchmark: Node.js, bundled docs and schemas, project config.",
  usage: "hatchmark doctor",
  options: [],
  example: {
    command: "hatchmark doctor --json",
    description: "Exits 3 when a check fails; each check says how to fix it.",
  },
};

type Status = "ok" | "warn" | "fail";
interface Check {
  name: string;
  status: Status;
  detail: string;
}

async function exists(file: string): Promise<boolean> {
  return access(file).then(
    () => true,
    () => false,
  );
}

export async function doctor(ctx: CommandContext): Promise<CommandResult> {
  const root = await packageRoot(path.dirname(fileURLToPath(import.meta.url)));
  const checks: Check[] = [];
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  const nodeOk = major >= 24 || (major === 23 && minor >= 6) || (major === 22 && minor >= 18);
  checks.push({
    name: "node",
    status: nodeOk ? "ok" : "fail",
    detail: nodeOk
      ? `Node.js ${process.versions.node}`
      : `Node.js ${process.versions.node} is not supported; install 22.18 or later on the 22 line, or 23.6 or later`,
  });

  const docs = path.join(root, "docs", "diagnostics.md");
  checks.push({
    name: "docs",
    status: (await exists(docs)) ? "ok" : "fail",
    detail: (await exists(docs))
      ? `bundled docs for ${VERSION} at ${path.dirname(docs)}`
      : `bundled docs missing at ${path.dirname(docs)}; reinstall hatchmark`,
  });

  const missing: string[] = [];
  for (const file of Object.values(SCHEMA_FILES)) {
    if (!(await exists(path.join(root, "schema", file)))) missing.push(file);
  }
  checks.push({
    name: "schemas",
    status: missing.length === 0 ? "ok" : "fail",
    detail:
      missing.length === 0
        ? "JSON Schemas present"
        : `missing ${missing.join(", ")}; reinstall hatchmark`,
  });

  const config = await readFile(path.join(ctx.root, CONFIG_FILE), "utf8").then(
    () => true,
    () => false,
  );
  checks.push({
    name: "project",
    status: config ? "ok" : "warn",
    detail: config
      ? `${CONFIG_FILE} found in ${ctx.root}`
      : `no ${CONFIG_FILE} in ${ctx.root}; run hatchmark init to create a project`,
  });

  const ok = checks.every((c) => c.status !== "fail");
  return {
    exitCode: ok ? EXIT.ok : EXIT.environment,
    json: { format_version: "1", ok, version: VERSION, checks },
    human: checks.map((c) => `${c.status.padEnd(4)}  ${c.name.padEnd(8)}  ${c.detail}`).join("\n"),
  };
}
