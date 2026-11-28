import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { Document, isScalar, visit } from "yaml";
import { CONFIG_FILE } from "../../spec/index.js";
import { VERSION } from "../../version.js";
import type { CommandHelp } from "../help.js";
import { type CommandContext, type CommandResult, EXIT } from "../io.js";
import {
  AGENTS_END,
  AGENTS_START,
  agentsBlock,
  SAMPLE_DASHBOARD,
  SAMPLE_METRICS,
  sampleConfig,
  sampleOrdersCsv,
} from "../sample.js";
import { usageError } from "../usage.js";
import {
  commitSkillInstall,
  discardSkillInstall,
  planSkillInstall,
  type StagedSkills,
  skillLocations,
  stageSkillInstall,
} from "./skills.js";

export const initHelp: CommandHelp = {
  name: "init",
  summary:
    "Create a project: hatchmark.yaml with every setting written out, sample US data, and an AGENTS.md block.",
  usage: "hatchmark init [dir] [--template sample|minimal] [--name <name>] [--skills] [--force]",
  options: [
    {
      flag: "[dir]",
      description: "Directory to create the project in. Default: the current directory.",
    },
    {
      flag: "--template <sample|minimal>",
      description:
        "sample (default): orders data, four metrics and a dashboard. minimal: config only.",
    },
    { flag: "--name <name>", description: "Project name. Default: the directory name." },
    {
      flag: "--skills",
      description:
        "Also install the Hatchmark agent skill for every supported agent, as hatchmark skills install does.",
    },
    { flag: "--force", description: "Overwrite files init writes if they already exist." },
  ],
  example: {
    command: "hatchmark init sales --json && hatchmark check --cwd sales",
    description: "Creates ./sales and checks it; never prompts and never runs git.",
  },
};

const TEMPLATES = ["sample", "minimal"] as const;
const GITIGNORE = ["dist/", ".hatchmark/"];

function specYaml({ $schema, ...spec }: Record<string, unknown>): string {
  const document = new Document(spec, { aliasDuplicateObjects: false });
  visit(document, {
    Seq(_, seq) {
      if (seq.items.every((item) => isScalar(item))) seq.flow = true;
    },
  });
  const header = typeof $schema === "string" ? `# yaml-language-server: $schema=${$schema}\n` : "";
  return `${header}${document.toString({ lineWidth: 0, flowCollectionPadding: false })}`;
}

async function readOptional(file: string): Promise<string | undefined> {
  return readFile(file, "utf8").catch(() => undefined);
}

async function resolveRoot(dir: string): Promise<string> {
  const missing: string[] = [];
  let existing = dir;
  while (
    !(await lstat(existing).then(
      () => true,
      () => false,
    )) &&
    existing !== path.dirname(existing)
  ) {
    missing.unshift(path.basename(existing));
    existing = path.dirname(existing);
  }
  return path.join(await realpath(existing), ...missing);
}

type Entry = "missing" | "file" | "directory" | "other";

async function lstatEntry(file: string): Promise<Entry> {
  const info = await lstat(file).catch(() => undefined);
  if (info === undefined) return "missing";
  return info.isFile() ? "file" : info.isDirectory() ? "directory" : "other";
}

function markerLines(text: string): { starts: number[]; ends: number[]; stray: number[] } {
  const found = { starts: [] as number[], ends: [] as number[], stray: [] as number[] };
  text.split("\n").forEach((raw, i) => {
    const line = raw.trim();
    if (line === AGENTS_START) found.starts.push(i + 1);
    else if (line === AGENTS_END) found.ends.push(i + 1);
    else if (raw.includes(AGENTS_START) || raw.includes(AGENTS_END)) found.stray.push(i + 1);
  });
  return found;
}

export async function init(
  ctx: CommandContext,
  positionals: string[],
  flags: { template?: string; name?: string; force?: boolean; skills?: boolean },
): Promise<CommandResult> {
  const [dir, ...rest] = positionals;
  if (rest.length > 0)
    return usageError("HM0002", `unexpected argument "${rest[0]}"`, {
      help: "pass at most one directory",
    });
  const template = flags.template ?? "sample";
  if (!(TEMPLATES as readonly string[]).includes(template)) {
    return usageError("HM0002", `unknown template "${template}"`, {
      expected: [...TEMPLATES],
      input: template,
    });
  }
  const requested = path.resolve(ctx.root, dir ?? ".");
  const target = await resolveRoot(requested);
  const name = flags.name ?? path.basename(requested);
  const withData = template === "sample";

  const owned = new Map<string, string>([[CONFIG_FILE, specYaml(sampleConfig(name, withData))]]);
  if (withData) {
    owned.set("data/orders.csv", sampleOrdersCsv());
    for (const [metric, spec] of Object.entries(SAMPLE_METRICS))
      owned.set(`metrics/${metric}.yaml`, specYaml(spec as Record<string, unknown>));
    owned.set("dashboards/sales.yaml", specYaml(SAMPLE_DASHBOARD));
  }

  const blocked: string[] = [];
  const existing: string[] = [];
  const dirs = new Set(["data", "metrics", "dashboards"]);
  for (const file of owned.keys()) if (file.includes("/")) dirs.add(path.posix.dirname(file));
  for (const dir of dirs) {
    const kind = await lstatEntry(path.join(target, dir));
    if (kind !== "missing" && kind !== "directory") blocked.push(dir);
  }
  for (const file of [...owned.keys(), "AGENTS.md", "CLAUDE.md", ".gitignore"]) {
    const kind = await lstatEntry(path.join(target, file));
    if (kind === "file" && owned.has(file)) existing.push(file);
    else if (kind !== "missing" && kind !== "file") blocked.push(file);
  }
  if (blocked.length > 0) {
    return usageError(
      "HM0004",
      `init cannot write ${blocked.length} path${blocked.length === 1 ? "" : "s"} in ${target}: something other than a regular file or directory, such as a symlink, is there`,
      {
        expected: blocked,
        help: "init never writes through symlinks inside the project; move or remove these paths, or choose another directory",
      },
    );
  }
  if (existing.length > 0 && flags.force !== true) {
    return usageError(
      "HM0004",
      `init would overwrite ${existing.length} existing file${existing.length === 1 ? "" : "s"} in ${target}`,
      {
        expected: existing,
        help: "pass --force to overwrite them, or choose another directory",
      },
    );
  }

  const skillPlans = flags.skills
    ? await planSkillInstall(
        skillLocations(target, undefined, undefined, ["project"]),
        flags.force === true,
      )
    : [];
  if (!Array.isArray(skillPlans)) return skillPlans;

  const block = agentsBlock(VERSION);
  const agents = await readOptional(path.join(target, "AGENTS.md"));
  let nextAgents = `${block}\n`;
  if (agents !== undefined) {
    const { starts, ends, stray } = markerLines(agents);
    const [startLine] = starts;
    const [endLine] = ends;
    if (starts.length === 0 && ends.length === 0 && stray.length === 0) {
      nextAgents = `${agents.replace(/\n*$/, "")}\n\n${block}\n`;
    } else if (
      stray.length === 0 &&
      starts.length === 1 &&
      ends.length === 1 &&
      startLine !== undefined &&
      endLine !== undefined &&
      startLine < endLine
    ) {
      const lines = agents.split("\n");
      nextAgents = [...lines.slice(0, startLine - 1), block, ...lines.slice(endLine)].join("\n");
    } else {
      return usageError(
        "HM0005",
        `AGENTS.md does not have exactly one ${AGENTS_START} line followed by one ${AGENTS_END} line, each alone on its line`,
        {
          expected: [
            ...starts.map((line) => `AGENTS.md:${line}: ${AGENTS_START}`),
            ...ends.map((line) => `AGENTS.md:${line}: ${AGENTS_END}`),
            ...stray.map((line) => `AGENTS.md:${line}: marker text that is not alone on its line`),
          ].sort((x, y) => Number(x.split(":")[1]) - Number(y.split(":")[1])),
          help: "keep one start line before one end line around the Hatchmark block, or delete every marker line so init appends a fresh block",
        },
      );
    }
  }

  let staged: StagedSkills | undefined;
  if (Array.isArray(skillPlans) && skillPlans.length > 0) {
    const result = await stageSkillInstall(skillPlans);
    if (!("staged" in result)) return result;
    staged = result;
  }

  const created: string[] = [];
  const updated: string[] = [];
  const unchanged: string[] = [];
  const notes: string[] = [];
  const write = async (file: string, text: string): Promise<void> => {
    const full = path.join(target, file);
    const before = await readOptional(full);
    if (before === text) {
      unchanged.push(file);
      return;
    }
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, text);
    (before === undefined ? created : updated).push(file);
  };

  try {
    await mkdir(target, { recursive: true });
    for (const [file, text] of owned) await write(file, text);
    for (const sub of ["data", "metrics", "dashboards"])
      await mkdir(path.join(target, sub), { recursive: true });
    await write("AGENTS.md", nextAgents);

    const claude = await readOptional(path.join(target, "CLAUDE.md"));
    if (claude === undefined) await write("CLAUDE.md", "@AGENTS.md\n");
    else if (!claude.includes("@AGENTS.md")) {
      notes.push(
        "CLAUDE.md exists and does not include @AGENTS.md; add that line so Claude Code reads the Hatchmark block",
      );
    }

    const gitignore = (await readOptional(path.join(target, ".gitignore"))) ?? "";
    const lines = gitignore.split(/\r?\n/);
    const missing = GITIGNORE.filter((entry) => !lines.includes(entry));
    if (missing.length > 0) {
      await write(
        ".gitignore",
        `${gitignore}${gitignore === "" || gitignore.endsWith("\n") ? "" : "\n"}${missing.join("\n")}\n`,
      );
    }
  } catch (error) {
    if (staged !== undefined) await discardSkillInstall(staged);
    throw error;
  }
  if (staged !== undefined) {
    const failed = await commitSkillInstall(staged);
    if (failed !== undefined) return failed;
  }
  const skills = skillPlans.map(({ location, status }) => ({
    agent: location.agent,
    scope: location.scope,
    path: location.dir,
    status,
  }));

  const relative = path.relative(ctx.io.cwd, requested) || ".";
  const next = relative === "." ? ["hatchmark check"] : [`hatchmark check --cwd ${relative}`];
  const human = [
    `Created a Hatchmark project in ${relative} (template: ${template}).`,
    ...created.map((f) => `  created    ${f}`),
    ...updated.map((f) => `  updated    ${f}`),
    ...unchanged.map((f) => `  unchanged  ${f}`),
    ...skills.map(
      (s) => `  ${s.status.padEnd(9)}  ${path.relative(target, s.path)}/ (${s.agent} skill)`,
    ),
    ...notes.map((n) => `note: ${n}`),
    "",
    `Next: ${next.join("; ")}`,
  ].join("\n");
  return {
    exitCode: EXIT.ok,
    json: {
      format_version: "1",
      ok: true,
      root: target,
      template,
      created,
      updated,
      unchanged,
      notes,
      ...(flags.skills ? { skills } : {}),
      next,
    },
    human,
  };
}
