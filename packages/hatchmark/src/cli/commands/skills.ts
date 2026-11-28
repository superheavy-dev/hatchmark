import { lstat, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { VERSION } from "../../version.js";
import type { CommandHelp } from "../help.js";
import { type CommandContext, type CommandResult, EXIT } from "../io.js";
import { packageRoot } from "../package-root.js";
import { usageError } from "../usage.js";

export const skillsHelp: CommandHelp = {
  name: "skills",
  summary:
    "Install the Hatchmark agent skill for coding agents such as Claude Code and Codex, or show where it is installed.",
  usage:
    "hatchmark skills install [--agent claude|codex] [--scope project|user] [--force] | hatchmark skills status",
  options: [
    {
      flag: "install",
      description:
        "Copy the skill bundled with this version into each agent's skills directory, or refresh an older copy.",
    },
    { flag: "status", description: "Show each skills directory and the version of its copy." },
    {
      flag: "--agent <claude|codex>",
      description:
        "claude: .claude/skills/hatchmark. codex: .agents/skills/hatchmark, the shared Agent Skills directory. Default: both.",
    },
    {
      flag: "--scope <project|user>",
      description:
        "project (default): under the project (--cwd). user: under the home directory, for every project.",
    },
    {
      flag: "--force",
      description: "Replace a hatchmark skill directory that Hatchmark did not write.",
    },
  ],
  example: {
    command: "hatchmark skills install --json",
    description: "Lists each skill directory as created, updated or unchanged; never prompts.",
  },
};

export const SKILL_AGENTS = { claude: ".claude/skills", codex: ".agents/skills" } as const;
export type SkillAgent = keyof typeof SKILL_AGENTS;
export const SKILL_SCOPES = ["project", "user"] as const;
export type SkillScope = (typeof SKILL_SCOPES)[number];
const SKILL_NAME = "hatchmark";
const VERSION_KEY = "hatchmark-version";
const AGENTS = Object.keys(SKILL_AGENTS) as SkillAgent[];

export interface SkillLocation {
  agent: SkillAgent;
  scope: SkillScope;
  base: string;
  dir: string;
}

export type InstallStatus = "created" | "updated" | "unchanged";

export interface SkillPlan {
  location: SkillLocation;
  status: InstallStatus;
  files: Map<string, string>;
}

export function homeDir(env: Readonly<Record<string, string | undefined>>): string | undefined {
  return env.HOME || env.USERPROFILE || undefined;
}

export function skillLocations(
  root: string,
  home: string | undefined,
  agents: readonly SkillAgent[] = AGENTS,
  scopes: readonly SkillScope[] = SKILL_SCOPES,
): SkillLocation[] {
  return scopes.flatMap((scope) => {
    const base = scope === "project" ? root : home;
    if (base === undefined) return [];
    return agents.map((agent) => ({
      agent,
      scope,
      base,
      dir: path.join(base, SKILL_AGENTS[agent], SKILL_NAME),
    }));
  });
}

export function stampVersion(text: string, version: string): string {
  const end = text.indexOf("\n---\n", 3);
  if (!text.startsWith("---\n") || end === -1) throw new Error("SKILL.md has no front matter");
  return `${text.slice(0, end)}\nmetadata:\n  ${VERSION_KEY}: "${version}"${text.slice(end)}`;
}

export function skillVersion(text: string): string | undefined {
  const front = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text)?.[1];
  if (front === undefined) return undefined;
  try {
    const value = (parse(front) as { metadata?: Record<string, unknown> } | null)?.metadata?.[
      VERSION_KEY
    ];
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

export async function bundledSkill(version = VERSION): Promise<Map<string, string>> {
  const dir = path.join(
    await packageRoot(path.dirname(fileURLToPath(import.meta.url))),
    "skills",
    SKILL_NAME,
  );
  const files = new Map<string, string>();
  for (const entry of (await readdir(dir, { recursive: true, withFileTypes: true })).sort((a, b) =>
    path.join(a.parentPath, a.name).localeCompare(path.join(b.parentPath, b.name)),
  )) {
    if (!entry.isFile()) continue;
    const full = path.join(entry.parentPath, entry.name);
    const file = path.relative(dir, full).split(path.sep).join("/");
    const text = await readFile(full, "utf8");
    files.set(file, file === "SKILL.md" ? stampVersion(text, version) : text);
  }
  return files;
}

type Existing =
  | { kind: "missing" }
  | { kind: "blocked"; path: string }
  | { kind: "directory"; files: Map<string, string> };

async function readExisting(location: SkillLocation): Promise<Existing> {
  let current = location.base;
  for (const part of path.relative(location.base, location.dir).split(path.sep)) {
    current = path.join(current, part);
    const info = await lstat(current).catch(() => undefined);
    if (info === undefined) return { kind: "missing" };
    if (!info.isDirectory()) return { kind: "blocked", path: current };
  }
  const files = new Map<string, string>();
  for (const entry of await readdir(location.dir, { recursive: true, withFileTypes: true })) {
    const full = path.join(entry.parentPath, entry.name);
    if (entry.isDirectory()) continue;
    if (!entry.isFile()) return { kind: "blocked", path: full };
    files.set(
      path.relative(location.dir, full).split(path.sep).join("/"),
      await readFile(full, "utf8"),
    );
  }
  return { kind: "directory", files };
}

function sameFiles(a: Map<string, string>, b: Map<string, string>): boolean {
  return a.size === b.size && [...a].every(([file, text]) => b.get(file) === text);
}

export async function planSkillInstall(
  locations: readonly SkillLocation[],
  force: boolean,
): Promise<SkillPlan[] | CommandResult> {
  const files = await bundledSkill();
  const plans: SkillPlan[] = [];
  const blocked: string[] = [];
  const foreign: string[] = [];
  for (const location of locations) {
    const existing = await readExisting(location);
    if (existing.kind === "blocked") {
      blocked.push(existing.path);
      continue;
    }
    if (existing.kind === "missing") {
      plans.push({ location, status: "created", files });
      continue;
    }
    const skill = existing.files.get("SKILL.md");
    if ((skill === undefined || skillVersion(skill) === undefined) && !force) {
      foreign.push(location.dir);
      continue;
    }
    plans.push({
      location,
      status: sameFiles(existing.files, files) ? "unchanged" : "updated",
      files,
    });
  }
  if (blocked.length > 0) {
    return usageError(
      "HM0010",
      `cannot install the agent skill: ${blocked.length} path${blocked.length === 1 ? " is" : "s are"} a symlink or something else that is not a regular file or directory`,
      {
        expected: blocked,
        help: "Hatchmark never writes through a symlink; move or remove these paths, or choose another --agent or --scope",
      },
    );
  }
  if (foreign.length > 0) {
    return usageError(
      "HM0010",
      `cannot install the agent skill: ${foreign.length} hatchmark skill director${foreign.length === 1 ? "y was" : "ies were"} not written by Hatchmark`,
      {
        expected: foreign,
        help: "pass --force to replace them, or move them away",
      },
    );
  }
  return plans;
}

export async function applySkillInstall(plans: readonly SkillPlan[]): Promise<void> {
  for (const { location, status, files } of plans) {
    if (status === "unchanged") continue;
    if (status === "updated") await rm(location.dir, { recursive: true });
    for (const [file, text] of files) {
      const full = path.join(location.dir, ...file.split("/"));
      await mkdir(path.dirname(full), { recursive: true });
      await writeFile(full, text);
    }
  }
}

export type CopyStatus = "missing" | "current" | "stale" | "foreign";

export async function skillCopies(
  locations: readonly SkillLocation[],
): Promise<(SkillLocation & { status: CopyStatus; version: string | null })[]> {
  return Promise.all(
    locations.map(async (location) => {
      const text = await readFile(path.join(location.dir, "SKILL.md"), "utf8").catch(
        () => undefined,
      );
      const exists = await lstat(location.dir).then(
        () => true,
        () => false,
      );
      const version = text === undefined ? undefined : skillVersion(text);
      const status: CopyStatus =
        version !== undefined
          ? version === VERSION
            ? "current"
            : "stale"
          : exists
            ? "foreign"
            : "missing";
      return { ...location, status, version: version ?? null };
    }),
  );
}

export function installCommand(ctx: CommandContext, agent: SkillAgent, scope: SkillScope): string {
  const cwd = scope === "project" && ctx.root !== ctx.io.cwd ? ` --cwd ${ctx.root}` : "";
  return `hatchmark skills install --agent ${agent} --scope ${scope}${cwd}`;
}

const SUBCOMMANDS = ["install", "status"];

export async function skills(
  ctx: CommandContext,
  positionals: string[],
  flags: { agent?: string; scope?: string; force?: boolean },
): Promise<CommandResult> {
  const [sub, ...rest] = positionals;
  if (sub === undefined) {
    return usageError("HM0003", "missing subcommand: install or status", {
      help: "run hatchmark skills install, or hatchmark skills status",
    });
  }
  if (!SUBCOMMANDS.includes(sub)) {
    return usageError("HM0002", `unknown skills subcommand "${sub}"`, {
      expected: SUBCOMMANDS,
      input: sub,
    });
  }
  if (rest.length > 0) return usageError("HM0002", `unexpected argument "${rest[0]}"`);
  if (flags.agent !== undefined && !(AGENTS as string[]).includes(flags.agent)) {
    return usageError("HM0002", `unknown agent "${flags.agent}"`, {
      expected: AGENTS,
      input: flags.agent,
    });
  }
  if (flags.scope !== undefined && !(SKILL_SCOPES as readonly string[]).includes(flags.scope)) {
    return usageError("HM0002", `unknown scope "${flags.scope}"`, {
      expected: [...SKILL_SCOPES],
      input: flags.scope,
    });
  }
  const agents = flags.agent === undefined ? AGENTS : [flags.agent as SkillAgent];
  const home = homeDir(ctx.io.env);

  if (sub === "status") {
    if (flags.force === true) return usageError("HM0002", "--force applies to skills install only");
    const scopes = flags.scope === undefined ? SKILL_SCOPES : [flags.scope as SkillScope];
    const copies = await skillCopies(skillLocations(ctx.root, home, agents, scopes));
    const list = copies.map(({ agent, scope, dir, status, version }) => ({
      agent,
      scope,
      path: dir,
      status,
      version,
    }));
    return {
      exitCode: EXIT.ok,
      json: { format_version: "1", version: VERSION, skills: list },
      human: list
        .map(
          (c) =>
            `${c.status.padEnd(8)}  ${c.agent.padEnd(6)}  ${c.scope.padEnd(7)}  ${c.path}${c.version === null ? "" : `  ${c.version}`}`,
        )
        .join("\n"),
    };
  }

  const scope = (flags.scope ?? "project") as SkillScope;
  if (scope === "user" && home === undefined) {
    return usageError(
      "HM0010",
      "cannot install the agent skill for --scope user: HOME is not set",
      {
        help: "set HOME, or install with --scope project",
      },
    );
  }
  const plans = await planSkillInstall(
    skillLocations(ctx.root, home, agents, [scope]),
    flags.force === true,
  );
  if (!Array.isArray(plans)) return plans;
  await applySkillInstall(plans);
  const list = plans.map(({ location, status }) => ({
    agent: location.agent,
    scope: location.scope,
    path: location.dir,
    status,
  }));
  return {
    exitCode: EXIT.ok,
    json: { format_version: "1", ok: true, version: VERSION, skills: list },
    human: [
      `Hatchmark agent skill ${VERSION}:`,
      ...list.map((s) => `  ${s.status.padEnd(9)}  ${s.path}  (${s.agent}, ${s.scope})`),
    ].join("\n"),
  };
}
