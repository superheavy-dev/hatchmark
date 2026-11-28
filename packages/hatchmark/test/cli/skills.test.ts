import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { skillVersion, stampVersion } from "../../src/cli/commands/skills.js";
import { run } from "../../src/cli/main.js";

const PACKAGE = path.resolve(import.meta.dirname, "../..");
const BUNDLE = path.join(PACKAGE, "skills/hatchmark");
const PACKAGE_VERSION = (
  JSON.parse(await readFile(path.join(PACKAGE, "package.json"), "utf8")) as { version: string }
).version;

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "hatchmark-skills-"));
  dirs.push(dir);
  return dir;
}

async function cli(argv: string[], opts: { cwd: string; home?: string }) {
  let stdout = "";
  const code = await run(argv, {
    stdout: (t) => {
      stdout += t;
    },
    stderr: () => {},
    cwd: opts.cwd,
    env: opts.home === undefined ? {} : { HOME: opts.home },
    stdoutIsTTY: false,
    isAgent: async () => false,
  });
  return { code, json: () => JSON.parse(stdout) };
}

async function tree(dir: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const full = path.join(entry.parentPath, entry.name);
    files.set(path.relative(dir, full).split(path.sep).join("/"), await readFile(full, "utf8"));
  }
  return files;
}

async function project(): Promise<{ root: string; home: string }> {
  const base = await tempDir();
  const root = path.join(base, "project");
  const home = path.join(base, "home");
  await mkdir(root);
  await mkdir(home);
  return { root, home };
}

describe("the bundled skill", () => {
  it("follows the Agent Skills format and carries no version of its own", async () => {
    const text = await readFile(path.join(BUNDLE, "SKILL.md"), "utf8");
    const front = parse(/^---\n([\s\S]*?)\n---\n/.exec(text)?.[1] ?? "") as Record<string, unknown>;
    expect(front.name).toBe("hatchmark");
    expect(typeof front.description).toBe("string");
    expect((front.description as string).length).toBeLessThanOrEqual(1024);
    expect(front.metadata).toBeUndefined();
    expect(skillVersion(text)).toBeUndefined();
    expect(text.split("\n").length).toBeLessThan(150);
  });

  it("names only real commands, subcommands and flags", async () => {
    const help = (await cli(["help"], { cwd: tmpdir() })).json();
    const names = new Set<string>(help.commands.map((c: { name: string }) => c.name));
    const globals = help.global_options.flatMap(
      (o: { flag: string }) => o.flag.match(/--[a-z-]+/g) ?? [],
    );
    const files = await tree(BUNDLE);
    let seen = 0;
    for (const [file, text] of files) {
      for (const [, span = ""] of text.matchAll(/`(hatchmark [^`]*)`/g)) {
        const [, command = "", sub] = span.split(/\s+/);
        if (command.startsWith("<")) continue;
        expect(names.has(command), `${file}: ${span}`).toBe(true);
        const usage = (await cli([command, "--help"], { cwd: tmpdir() })).json();
        const known = [
          ...globals,
          ...(usage.usage.match(/--[a-z-]+/g) ?? []),
          ...usage.options.flatMap((o: { flag: string }) => o.flag.match(/--[a-z-]+/g) ?? []),
        ];
        for (const flag of span.match(/--[a-z-]+/g) ?? []) {
          expect(known, `${file}: ${span}`).toContain(flag);
        }
        if (
          (command === "data" || command === "skills") &&
          sub !== undefined &&
          !sub.startsWith("-")
        ) {
          expect(usage.usage, `${file}: ${span}`).toContain(`hatchmark ${command} ${sub}`);
        }
        seen++;
      }
      for (const [, link = ""] of text.matchAll(/\]\(([^)]+)\)/g)) {
        expect(files.has(path.posix.join(path.posix.dirname(file), link)), `${file}: ${link}`).toBe(
          true,
        );
      }
    }
    expect(seen).toBeGreaterThan(20);
  });

  it("is in the published files", async () => {
    const manifest = JSON.parse(await readFile(path.join(PACKAGE, "package.json"), "utf8"));
    expect(manifest.files).toContain("skills");
  });
});

describe("hatchmark skills install", () => {
  it("copies the bundled skill for every agent and stamps the package version", async () => {
    const { root, home } = await project();
    const out = await cli(["skills", "install", "--cwd", root], { cwd: root, home });
    expect(out.code).toBe(0);
    expect(out.json()).toEqual({
      format_version: "1",
      ok: true,
      version: PACKAGE_VERSION,
      skills: [
        {
          agent: "claude",
          scope: "project",
          path: path.join(root, ".claude/skills/hatchmark"),
          status: "created",
        },
        {
          agent: "codex",
          scope: "project",
          path: path.join(root, ".agents/skills/hatchmark"),
          status: "created",
        },
      ],
    });
    const bundle = await tree(BUNDLE);
    for (const dir of [".claude/skills/hatchmark", ".agents/skills/hatchmark"]) {
      const installed = await tree(path.join(root, dir));
      expect([...installed.keys()].sort()).toEqual([...bundle.keys()].sort());
      for (const [file, text] of bundle) {
        expect(installed.get(file), file).toBe(
          file === "SKILL.md" ? stampVersion(text, PACKAGE_VERSION) : text,
        );
      }
      expect(skillVersion(installed.get("SKILL.md") ?? "")).toBe(PACKAGE_VERSION);
    }
    expect(await readdir(home)).toEqual([]);

    const again = await cli(["skills", "install", "--cwd", root], { cwd: root, home });
    expect(again.json().skills.map((s: { status: string }) => s.status)).toEqual([
      "unchanged",
      "unchanged",
    ]);
  });

  it("updates an older copy Hatchmark wrote and drops files the bundle no longer has", async () => {
    const { root } = await project();
    const dir = path.join(root, ".claude/skills/hatchmark");
    await mkdir(path.join(dir, "references"), { recursive: true });
    const old = stampVersion(await readFile(path.join(BUNDLE, "SKILL.md"), "utf8"), "0.0.0-old");
    await writeFile(path.join(dir, "SKILL.md"), old);
    await writeFile(path.join(dir, "references/gone.md"), "old\n");
    const out = await cli(["skills", "install", "--agent", "claude"], { cwd: root });
    expect(out.json().skills).toEqual([
      { agent: "claude", scope: "project", path: dir, status: "updated" },
    ]);
    expect(skillVersion(await readFile(path.join(dir, "SKILL.md"), "utf8"))).toBe(PACKAGE_VERSION);
    expect((await tree(dir)).has("references/gone.md")).toBe(false);
  });

  it("refuses a directory Hatchmark did not write unless --force", async () => {
    const { root } = await project();
    const dir = path.join(root, ".agents/skills/hatchmark");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "SKILL.md"), "---\nname: hatchmark\ndescription: mine\n---\n");
    const out = await cli(["skills", "install"], { cwd: root });
    expect(out.code).toBe(2);
    expect(out.json().diagnostics[0]).toMatchObject({ code: "HM0010", expected: [dir] });
    expect(await readdir(root)).toEqual([".agents"]);
    expect(await readFile(path.join(dir, "SKILL.md"), "utf8")).toContain("description: mine");

    const forced = await cli(["skills", "install", "--force"], { cwd: root });
    expect(forced.code).toBe(0);
    expect(forced.json().skills.map((s: { status: string }) => s.status)).toEqual([
      "created",
      "updated",
    ]);
    expect(skillVersion(await readFile(path.join(dir, "SKILL.md"), "utf8"))).toBe(PACKAGE_VERSION);
  });

  it("never writes through a symlink, even with --force", async () => {
    const { root, home } = await project();
    const elsewhere = await tempDir();
    await mkdir(path.join(root, ".claude"));
    await symlink(elsewhere, path.join(root, ".claude/skills"));
    const out = await cli(["skills", "install", "--force"], { cwd: root });
    expect(out.code).toBe(2);
    expect(out.json().diagnostics[0]).toMatchObject({
      code: "HM0010",
      expected: [path.join(root, ".claude/skills")],
    });
    expect(await readdir(elsewhere)).toEqual([]);
    expect(await readdir(root)).toEqual([".claude"]);

    const dir = path.join(home, ".claude/skills/hatchmark");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(elsewhere, "target.md"), "keep\n");
    await symlink(path.join(elsewhere, "target.md"), path.join(dir, "SKILL.md"));
    const file = await cli(["skills", "install", "--scope", "user", "--force"], {
      cwd: root,
      home,
    });
    expect(file.json().diagnostics[0]).toMatchObject({
      code: "HM0010",
      expected: [path.join(dir, "SKILL.md")],
    });
    expect(await readFile(path.join(elsewhere, "target.md"), "utf8")).toBe("keep\n");
  });

  it("installs under the home directory with --scope user", async () => {
    const { root, home } = await project();
    const out = await cli(["skills", "install", "--scope", "user"], { cwd: root, home });
    expect(out.json().skills.map((s: { path: string }) => s.path)).toEqual([
      path.join(home, ".claude/skills/hatchmark"),
      path.join(home, ".agents/skills/hatchmark"),
    ]);
    expect(await readdir(root)).toEqual([]);
    const homeless = await cli(["skills", "install", "--scope", "user"], { cwd: root });
    expect(homeless.code).toBe(2);
    expect(homeless.json().diagnostics[0].code).toBe("HM0010");
  });

  it("rejects bad usage with HM0002 and HM0003", async () => {
    const { root } = await project();
    const codes = async (argv: string[]) =>
      (await cli(argv, { cwd: root })).json().diagnostics[0].code;
    expect(await codes(["skills"])).toBe("HM0003");
    expect(await codes(["skills", "remove"])).toBe("HM0002");
    expect(await codes(["skills", "install", "--agent", "cursor"])).toBe("HM0002");
    expect(await codes(["skills", "install", "--scope", "global"])).toBe("HM0002");
    expect(await codes(["skills", "status", "--force"])).toBe("HM0002");
    expect(await readdir(root)).toEqual([]);
  });
});

describe("hatchmark skills status", () => {
  it("lists every location with the version of its copy", async () => {
    const { root, home } = await project();
    await cli(["skills", "install", "--agent", "codex"], { cwd: root, home });
    const foreign = path.join(home, ".claude/skills/hatchmark");
    await mkdir(foreign, { recursive: true });
    const out = await cli(["skills", "status"], { cwd: root, home });
    expect(out.code).toBe(0);
    expect(out.json()).toEqual({
      format_version: "1",
      version: PACKAGE_VERSION,
      skills: [
        {
          agent: "claude",
          scope: "project",
          path: path.join(root, ".claude/skills/hatchmark"),
          status: "missing",
          version: null,
        },
        {
          agent: "codex",
          scope: "project",
          path: path.join(root, ".agents/skills/hatchmark"),
          status: "current",
          version: PACKAGE_VERSION,
        },
        { agent: "claude", scope: "user", path: foreign, status: "foreign", version: null },
        {
          agent: "codex",
          scope: "user",
          path: path.join(home, ".agents/skills/hatchmark"),
          status: "missing",
          version: null,
        },
      ],
    });
  });
});

describe("hatchmark init --skills", () => {
  it("installs the skill at project scope and leaves the default output alone", async () => {
    const cwd = await tempDir();
    const plain = await cli(["init", "plain"], { cwd });
    expect(plain.json()).not.toHaveProperty("skills");
    expect(await readdir(path.join(cwd, "plain"))).not.toContain(".claude");

    const out = await cli(["init", "shop", "--skills"], { cwd, home: path.join(cwd, "home") });
    expect(out.code).toBe(0);
    const { root } = out.json();
    expect(out.json().skills).toEqual([
      {
        agent: "claude",
        scope: "project",
        path: path.join(root, ".claude/skills/hatchmark"),
        status: "created",
      },
      {
        agent: "codex",
        scope: "project",
        path: path.join(root, ".agents/skills/hatchmark"),
        status: "created",
      },
    ]);
    expect(out.json().created).toEqual(plain.json().created);
    expect(
      skillVersion(await readFile(path.join(root, ".claude/skills/hatchmark/SKILL.md"), "utf8")),
    ).toBe(PACKAGE_VERSION);
  });

  it("writes nothing when the skill directory is refused", async () => {
    const cwd = await tempDir();
    await mkdir(path.join(cwd, "shop/.claude/skills/hatchmark"), { recursive: true });
    const out = await cli(["init", "shop", "--skills"], { cwd });
    expect(out.code).toBe(2);
    expect(out.json().diagnostics[0].code).toBe("HM0010");
    expect(await readdir(path.join(cwd, "shop"))).toEqual([".claude"]);
  });
});

describe("hatchmark doctor and the agent skill", () => {
  const skillsCheck = async (root: string, home: string) => {
    const out = await cli(["doctor", "--cwd", root], { cwd: root, home });
    expect(out.code).toBe(0);
    return out.json().checks.find((c: { name: string }) => c.name === "skills");
  };

  it("is ok without a copy and with a current one", async () => {
    const { root, home } = await project();
    expect(await skillsCheck(root, home)).toMatchObject({ status: "ok" });
    await cli(["skills", "install", "--scope", "user"], { cwd: root, home });
    const check = await skillsCheck(root, home);
    expect(check.status).toBe("ok");
    expect(check.detail).toContain(path.join(home, ".claude/skills/hatchmark"));
  });

  it("warns about a copy from another version with the command that fixes it", async () => {
    const { root, home } = await project();
    await cli(["skills", "install", "--agent", "claude", "--scope", "user"], { cwd: root, home });
    const file = path.join(home, ".claude/skills/hatchmark/SKILL.md");
    await writeFile(
      file,
      stampVersion(await readFile(path.join(BUNDLE, "SKILL.md"), "utf8"), "0.0.0-old"),
    );
    const check = await skillsCheck(root, home);
    expect(check.status).toBe("warn");
    expect(check.detail).toContain(path.dirname(file));
    expect(check.detail).toContain("0.0.0-old");
    expect(check.detail).toContain(PACKAGE_VERSION);
    expect(check.detail).toContain("hatchmark skills install --agent claude --scope user");
  });
});
