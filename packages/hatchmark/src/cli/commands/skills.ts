import { createHash, randomBytes } from "node:crypto";
import type { Stats } from "node:fs";
import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
    "hatchmark skills install [--agent claude|codex] [--scope project|user] [--force] | hatchmark skills status [--agent claude|codex] [--scope project|user]",
  options: [
    {
      flag: "install",
      description:
        "Copy the skill bundled with this version into each agent's skills directory, or refresh an unchanged older copy.",
    },
    {
      flag: "status",
      description:
        "Show each skills directory and whether its copy is current, stale, modified, foreign, blocked or unreadable.",
    },
    {
      flag: "--agent <claude|codex>",
      description:
        "claude: .claude/skills/hatchmark. codex: .agents/skills/hatchmark, the shared Agent Skills directory. Default: both.",
    },
    {
      flag: "--scope <project|user>",
      description:
        "project (default): under the project (--cwd). user: under the home directory, for every project. Status shows both by default.",
    },
    {
      flag: "--force",
      description:
        "Replace a copy that was changed since it was installed, or a hatchmark skill directory that Hatchmark did not write.",
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
export const SKILL_MANIFEST = ".hatchmark-skill.json";
const AGENTS = Object.keys(SKILL_AGENTS) as SkillAgent[];
const FS_ERRORS = new Set(["EACCES", "EPERM", "EROFS", "ENOSPC"]);

export interface SkillLocation {
  agent: SkillAgent;
  scope: SkillScope;
  base: string;
  dir: string;
}

export type CopyStatus =
  | "missing"
  | "current"
  | "stale"
  | "modified"
  | "foreign"
  | "blocked"
  | "unreadable";

export interface SkillCopy extends SkillLocation {
  status: CopyStatus;
  version: string | null;
  files: Map<string, string>;
  problem?: string;
}

export type InstallStatus = "created" | "updated" | "unchanged";

export interface SkillPlan {
  location: SkillLocation;
  status: InstallStatus;
  files: Map<string, string>;
}

export interface StagedSkills {
  plans: SkillPlan[];
  staged: { plan: SkillPlan; temp: string }[];
  created: string[];
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
  const open = /^---(\r?\n)/.exec(text);
  const close = open === null ? null : /\r?\n---(?:\r?\n|$)/.exec(text.slice(open[0].length - 1));
  if (open === null || close === null) throw new Error("SKILL.md has no front matter");
  const eol = open[1] ?? "\n";
  const end = open[0].length - 1 + close.index;
  return `${text.slice(0, end)}${eol}metadata:${eol}  ${VERSION_KEY}: "${version}"${text.slice(end)}`;
}

function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function manifestText(files: Map<string, string>, version: string): string {
  const digests = Object.fromEntries(
    [...files.keys()].sort().map((file) => [file, digest(files.get(file) ?? "")]),
  );
  return `${JSON.stringify({ format_version: "1", name: SKILL_NAME, version, files: digests }, null, 2)}\n`;
}

function parseManifest(
  text: string | undefined,
): { version: string; files: Record<string, string> } | undefined {
  if (text === undefined) return undefined;
  try {
    const value = JSON.parse(text) as { version?: unknown; files?: unknown };
    if (
      typeof value.version !== "string" ||
      typeof value.files !== "object" ||
      value.files === null
    )
      return undefined;
    const files = value.files as Record<string, unknown>;
    if (!Object.values(files).every((d) => typeof d === "string")) return undefined;
    return { version: value.version, files: files as Record<string, string> };
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
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const full = path.join(entry.parentPath, entry.name);
    const file = path.relative(dir, full).split(path.sep).join("/");
    const text = await readFile(full, "utf8");
    files.set(file, file === "SKILL.md" ? stampVersion(text, version) : text);
  }
  return files;
}

function fsErrorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && FS_ERRORS.has(code) ? code : undefined;
}

function entryProblem(file: string, info: Pick<Stats, "isSymbolicLink" | "isFile">): string {
  return info.isSymbolicLink()
    ? `${file} is a symlink`
    : info.isFile()
      ? `${file} is a file, not a directory`
      : `${file} is not a regular file or directory`;
}

export async function inspectSkill(location: SkillLocation): Promise<SkillCopy> {
  const copy = (status: CopyStatus, extra: Partial<SkillCopy> = {}): SkillCopy => ({
    ...location,
    status,
    version: null,
    files: new Map(),
    ...extra,
  });
  let current = location.base;
  try {
    for (const part of path.relative(location.base, location.dir).split(path.sep)) {
      current = path.join(current, part);
      const info = await lstat(current).catch((error: { code?: string }) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (info === undefined) return copy("missing");
      if (!info.isDirectory()) return copy("blocked", { problem: entryProblem(current, info) });
    }
    const entries = await readdir(location.dir, { recursive: true, withFileTypes: true });
    const files = new Map<string, string>();
    for (const entry of entries) {
      const full = path.join(entry.parentPath, entry.name);
      if (entry.isDirectory()) continue;
      if (!entry.isFile()) {
        return copy("blocked", {
          problem: entry.isSymbolicLink()
            ? `${full} is a symlink`
            : `${full} is not a regular file or directory`,
        });
      }
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      current = path.join(entry.parentPath, entry.name);
      files.set(
        path.relative(location.dir, current).split(path.sep).join("/"),
        await readFile(current, "utf8"),
      );
    }
    const manifest = parseManifest(files.get(SKILL_MANIFEST));
    files.delete(SKILL_MANIFEST);
    if (manifest === undefined) return copy("foreign", { files });
    const clean =
      files.size === Object.keys(manifest.files).length &&
      [...files].every(([file, text]) => manifest.files[file] === digest(text));
    return copy(clean ? (manifest.version === VERSION ? "current" : "stale") : "modified", {
      version: manifest.version,
      files,
    });
  } catch (error) {
    const code = fsErrorCode(error);
    if (code === undefined) throw error;
    return copy("unreadable", { problem: `${current} cannot be read (${code})` });
  }
}

function sameFiles(a: Map<string, string>, b: Map<string, string>): boolean {
  return a.size === b.size && [...a].every(([file, text]) => b.get(file) === text);
}

function refuse(problems: string[]): CommandResult {
  return usageError(
    "HM0010",
    `cannot install the agent skill: ${problems.length} skill director${problems.length === 1 ? "y" : "ies"} cannot be written safely, so nothing was written`,
    {
      expected: problems,
      help: "--force replaces a changed copy or one Hatchmark did not write; symlinks, other special files and unreadable or read-only paths are never written through, so move or fix them, or choose another --agent or --scope",
    },
  );
}

export async function planSkillInstall(
  locations: readonly SkillLocation[],
  force: boolean,
): Promise<SkillPlan[] | CommandResult> {
  const files = await bundledSkill();
  const plans: SkillPlan[] = [];
  const problems: string[] = [];
  for (const location of locations) {
    const copy = await inspectSkill(location);
    if (copy.status === "blocked" || copy.status === "unreadable") {
      problems.push(copy.problem ?? copy.dir);
    } else if ((copy.status === "modified" || copy.status === "foreign") && !force) {
      problems.push(
        copy.status === "modified"
          ? `${copy.dir} was changed since hatchmark ${copy.version} installed it`
          : `${copy.dir} was not written by Hatchmark`,
      );
    } else {
      const status: InstallStatus =
        copy.status === "missing"
          ? "created"
          : copy.status === "current" && sameFiles(copy.files, files)
            ? "unchanged"
            : "updated";
      plans.push({ location, status, files });
    }
  }
  return problems.length > 0 ? refuse(problems) : plans;
}

async function remove(dirs: readonly string[]): Promise<void> {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
}

function suffix(): string {
  return randomBytes(6).toString("hex");
}

export async function stageSkillInstall(plans: SkillPlan[]): Promise<StagedSkills | CommandResult> {
  const result: StagedSkills = { plans, staged: [], created: [] };
  let current = "";
  try {
    for (const plan of plans) {
      if (plan.status === "unchanged") continue;
      const parent = path.dirname(plan.location.dir);
      current = parent;
      const made = await mkdir(parent, { recursive: true });
      if (made !== undefined) result.created.unshift(made);
      const temp = path.join(parent, `.hatchmark-staging-${suffix()}`);
      current = temp;
      await mkdir(temp);
      result.staged.push({ plan, temp });
      for (const [file, text] of [
        ...plan.files,
        [SKILL_MANIFEST, manifestText(plan.files, VERSION)] as const,
      ]) {
        current = path.join(temp, ...file.split("/"));
        await mkdir(path.dirname(current), { recursive: true });
        await writeFile(current, text);
      }
    }
    return result;
  } catch (error) {
    await discardSkillInstall(result);
    const code = fsErrorCode(error);
    if (code === undefined) throw error;
    return refuse([`${current} cannot be written (${code})`]);
  }
}

export async function discardSkillInstall(staged: StagedSkills): Promise<void> {
  await remove(staged.staged.map((s) => s.temp));
  await remove(staged.created);
}

export async function commitSkillInstall(
  staged: StagedSkills,
): Promise<{ problem: string } | { warnings: string[] }> {
  const swapped: { dir: string; old: string | undefined }[] = [];
  let current = "";
  try {
    for (const { plan, temp } of staged.staged) {
      const dir = plan.location.dir;
      current = dir;
      const old =
        plan.status === "updated"
          ? path.join(path.dirname(dir), `.hatchmark-old-${suffix()}`)
          : undefined;
      if (old !== undefined) await rename(dir, old);
      try {
        await rename(temp, dir);
      } catch (error) {
        if (old !== undefined) await rename(old, dir).catch(() => undefined);
        throw error;
      }
      swapped.push({ dir, old });
    }
  } catch (error) {
    for (const { dir, old } of swapped.reverse()) {
      await remove([dir]);
      if (old !== undefined) await rename(old, dir).catch(() => undefined);
    }
    await discardSkillInstall(staged);
    const code = fsErrorCode(error);
    if (code === undefined) throw error;
    return { problem: `${current} cannot be written (${code})` };
  }
  const warnings: string[] = [];
  for (const { old } of swapped) {
    if (old === undefined) continue;
    await rm(old, { recursive: true }).catch((error: { code?: unknown }) => {
      warnings.push(
        `the new copy is installed, but the previous copy at ${old} could not be removed (${String(error.code ?? error)}); delete it so agents do not load it as a second skill`,
      );
    });
  }
  return { warnings };
}

export function shellQuote(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, "'\\''")}'`;
}

export function installCommand(
  ctx: CommandContext,
  agent: SkillAgent,
  scope: SkillScope,
  force = false,
): string {
  return [
    "hatchmark skills install --agent",
    agent,
    "--scope",
    scope,
    ...(scope === "project" && ctx.root !== ctx.io.cwd ? ["--cwd", shellQuote(ctx.root)] : []),
    ...(force ? ["--force"] : []),
  ].join(" ");
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
    const list = [];
    for (const location of skillLocations(ctx.root, home, agents, scopes)) {
      const { agent, scope, dir, status, version, problem } = await inspectSkill(location);
      list.push({
        agent,
        scope,
        path: dir,
        status,
        version,
        ...(problem ? { detail: problem } : {}),
      });
    }
    return {
      exitCode: EXIT.ok,
      json: { format_version: "1", version: VERSION, skills: list },
      human: list
        .map(
          (c) =>
            `${c.status.padEnd(10)}  ${c.agent.padEnd(6)}  ${c.scope.padEnd(7)}  ${c.path}${c.version === null ? "" : `  ${c.version}`}${c.detail ? `  (${c.detail})` : ""}`,
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
  const staged = await stageSkillInstall(plans);
  if (!("staged" in staged)) return staged;
  const committed = await commitSkillInstall(staged);
  if ("problem" in committed) return refuse([committed.problem]);
  const list = plans.map(({ location, status }) => ({
    agent: location.agent,
    scope: location.scope,
    path: location.dir,
    status,
  }));
  return {
    exitCode: EXIT.ok,
    json: {
      format_version: "1",
      ok: true,
      version: VERSION,
      skills: list,
      warnings: committed.warnings,
    },
    human: [
      `Hatchmark agent skill ${VERSION}:`,
      ...list.map((s) => `  ${s.status.padEnd(9)}  ${s.path}  (${s.agent}, ${s.scope})`),
      ...committed.warnings.map((w) => `warning: ${w}`),
    ].join("\n"),
  };
}
