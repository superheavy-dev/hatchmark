import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { exitCodeFor } from "../../src/cli/commands/check.js";
import { stampVersion } from "../../src/cli/commands/skills.js";
import { run } from "../../src/cli/main.js";
import type { Diagnostic, DiagnosticCode } from "../../src/diagnostics/index.js";

const PACKAGE = path.resolve(import.meta.dirname, "../..");
const BUNDLE = path.join(PACKAGE, "skills/hatchmark");
const PACKAGE_VERSION = (
  JSON.parse(await readFile(path.join(PACKAGE, "package.json"), "utf8")) as { version: string }
).version;
const MANIFEST = ".hatchmark-skill.json";
const POSIX_USER = process.platform !== "win32" && process.getuid?.() !== 0;

const dirs: string[] = [];
const locked: string[] = [];
const immutable: string[] = [];
afterEach(async () => {
  for (const dir of immutable.splice(0)) execFileSync("chflags", ["nouchg", dir]);
  for (const dir of locked.splice(0)) await chmod(dir, 0o755).catch(() => undefined);
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "hatchmark-skills-"));
  dirs.push(dir);
  return dir;
}

async function lock(dir: string, mode: number): Promise<void> {
  locked.push(dir);
  await chmod(dir, mode);
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

async function project(name = "project"): Promise<{ base: string; root: string; home: string }> {
  const base = await tempDir();
  const root = path.join(base, name);
  const home = path.join(base, "home");
  await mkdir(root);
  await mkdir(home);
  return { base, root, home };
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

function stamped(text: string, version: string): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const close = text.indexOf(`${eol}---${eol}`, 3);
  return `${text.slice(0, close)}${eol}metadata:${eol}  hatchmark-version: "${version}"${text.slice(close)}`;
}

async function manifest(dir: string): Promise<{ version: string; files: Record<string, string> }> {
  return JSON.parse(await readFile(path.join(dir, MANIFEST), "utf8"));
}

async function setManifestVersion(dir: string, version: string): Promise<void> {
  const value = await manifest(dir);
  await writeFile(path.join(dir, MANIFEST), JSON.stringify({ ...value, version }));
}

async function expectBundle(dir: string): Promise<void> {
  const bundle = await tree(BUNDLE);
  const installed = await tree(dir);
  expect([...installed.keys()].sort()).toEqual([...bundle.keys(), MANIFEST].sort());
  for (const [file, text] of bundle) {
    expect(installed.get(file), file).toBe(
      file === "SKILL.md" ? stamped(text, PACKAGE_VERSION) : text,
    );
  }
  const recorded = await manifest(dir);
  expect(recorded.version).toBe(PACKAGE_VERSION);
  expect(Object.keys(recorded.files).sort()).toEqual([...bundle.keys()].sort());
  for (const [file, digest] of Object.entries(recorded.files)) {
    expect(digest, file).toBe(sha256(installed.get(file) ?? ""));
  }
}

const statusOf = async (root: string, home: string | undefined, agent: string, scope: string) =>
  (
    await cli(["skills", "status", "--agent", agent, "--scope", scope], {
      cwd: root,
      ...(home ? { home } : {}),
    })
  ).json().skills[0];

describe("the bundled skill", () => {
  it("follows the Agent Skills format and carries no version of its own", async () => {
    const text = await readFile(path.join(BUNDLE, "SKILL.md"), "utf8");
    const front = parse(/^---\n([\s\S]*?)\n---\n/.exec(text)?.[1] ?? "") as Record<string, unknown>;
    expect(front.name).toBe("hatchmark");
    expect(typeof front.description).toBe("string");
    expect((front.description as string).length).toBeLessThanOrEqual(1024);
    expect(front.metadata).toBeUndefined();
    expect(text).not.toContain("hatchmark-version");
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

  it("states check's exit-code rule exactly as check applies it", async () => {
    const text = await readFile(path.join(BUNDLE, "references/diagnostics.md"), "utf8");
    const rules = [...text.matchAll(/^ {2}(\d)\. (\d) (when|otherwise)(.*(?:\n {5}.*)*)/gm)].map(
      ([, step, exit, , rest = ""]) => ({
        step: Number(step),
        exit: Number(exit),
        rest: rest.replace(/\s+/g, " "),
      }),
    );
    expect(rules.map((r) => [r.step, r.exit])).toEqual([
      [1, 2],
      [2, 3],
      [3, 1],
      [4, 0],
    ]);
    expect(rules[0]?.rest).toBe(
      " any error is in `hatchmark.yaml` and is not an environment error.",
    );
    expect(rules[2]?.rest).toBe(" there is any other error, or any warning with `--strict`.");
    const environment = new Set(rules[1]?.rest.match(/HM\d{4}/g));
    expect(rules[1]?.rest).toMatch(/^ every error is an environment error:/);
    expect(environment.size).toBeGreaterThan(0);

    type D = Pick<Diagnostic, "code" | "severity" | "file">;
    const stated = (diagnostics: D[], strict: boolean) => {
      const errors = diagnostics.filter((d) => d.severity === "error");
      if (errors.some((d) => d.file === "hatchmark.yaml" && !environment.has(d.code))) return 2;
      if (errors.length > 0 && errors.every((d) => environment.has(d.code))) return 3;
      if (errors.length > 0 || (strict && diagnostics.some((d) => d.severity === "warning")))
        return 1;
      return 0;
    };
    const err = (code: DiagnosticCode, file: string): D => ({ code, severity: "error", file });
    const sets: D[][] = [
      [],
      [{ code: "HM4040", severity: "warning", file: "dashboards/sales.yaml" }],
      [err("HM3003", "metrics/revenue.yaml")],
      [err("HM3003", "hatchmark.yaml")],
      [err("HM2010", "hatchmark.yaml")],
      [err("HM1001", "data/orders.csv")],
      [err("HM2010", "hatchmark.yaml"), err("HM1001", "data/other.csv")],
      [err("HM2010", "hatchmark.yaml"), err("HM3003", "metrics/revenue.yaml")],
      [err("HM2010", "hatchmark.yaml"), err("HM3003", "hatchmark.yaml")],
      [err("HM3003", "metrics/revenue.yaml"), err("HM3003", "hatchmark.yaml")],
      [err("HM2003", "dashboards/sales.yaml"), { code: "HM4001", severity: "warning" }],
    ];
    for (const diagnostics of sets) {
      for (const strict of [false, true]) {
        expect(
          exitCodeFor(
            diagnostics.map((d) => ({ ...d, message: "", docs: "" })),
            strict,
          ),
          JSON.stringify({ diagnostics, strict }),
        ).toBe(stated(diagnostics, strict));
      }
    }
    expect(
      stated([err("HM2010", "hatchmark.yaml"), err("HM3003", "metrics/revenue.yaml")], false),
    ).toBe(1);
  });

  it("is in the published files", async () => {
    const manifest = JSON.parse(await readFile(path.join(PACKAGE, "package.json"), "utf8"));
    expect(manifest.files).toContain("skills");
  });

  it("stamps the version into LF and CRLF front matter alike", () => {
    expect(stampVersion("---\nname: x\ndescription: y\n---\n\n# X\n", "1.2.3")).toBe(
      '---\nname: x\ndescription: y\nmetadata:\n  hatchmark-version: "1.2.3"\n---\n\n# X\n',
    );
    expect(stampVersion("---\r\nname: x\r\ndescription: y\r\n---\r\n\r\n# X\r\n", "1.2.3")).toBe(
      '---\r\nname: x\r\ndescription: y\r\nmetadata:\r\n  hatchmark-version: "1.2.3"\r\n---\r\n\r\n# X\r\n',
    );
    expect(() => stampVersion("# no front matter\n", "1.2.3")).toThrow("no front matter");
  });
});

describe("hatchmark skills install", () => {
  it("copies the bundled skill for every agent with a manifest of what it wrote", async () => {
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
      warnings: [],
    });
    await expectBundle(path.join(root, ".claude/skills/hatchmark"));
    await expectBundle(path.join(root, ".agents/skills/hatchmark"));
    expect(await readdir(home)).toEqual([]);
    expect((await readdir(path.join(root, ".claude/skills"))).sort()).toEqual(["hatchmark"]);

    const again = await cli(["skills", "install", "--cwd", root], { cwd: root, home });
    expect(again.json().skills.map((s: { status: string }) => s.status)).toEqual([
      "unchanged",
      "unchanged",
    ]);
  });

  it("refreshes a clean older copy without asking and drops files the bundle no longer has", async () => {
    const { root } = await project();
    await cli(["skills", "install", "--agent", "claude"], { cwd: root });
    const dir = path.join(root, ".claude/skills/hatchmark");
    const old = "old reference\n";
    await writeFile(path.join(dir, "references/gone.md"), old);
    const value = await manifest(dir);
    await writeFile(
      path.join(dir, MANIFEST),
      JSON.stringify({
        ...value,
        version: "0.0.0-old",
        files: { ...value.files, "references/gone.md": sha256(old) },
      }),
    );
    expect((await statusOf(root, undefined, "claude", "project")).status).toBe("stale");
    const out = await cli(["skills", "install", "--agent", "claude"], { cwd: root });
    expect(out.code).toBe(0);
    expect(out.json().skills).toEqual([
      { agent: "claude", scope: "project", path: dir, status: "updated" },
    ]);
    await expectBundle(dir);
  });

  it("keeps a copy with local edits unless --force", async () => {
    const { root } = await project();
    await cli(["skills", "install", "--agent", "claude"], { cwd: root });
    const dir = path.join(root, ".claude/skills/hatchmark");
    const edited = `${await readFile(path.join(dir, "SKILL.md"), "utf8")}\nMy own paragraph.\n`;
    await writeFile(path.join(dir, "SKILL.md"), edited);
    await writeFile(path.join(dir, "notes.md"), "notes\n");
    expect(await statusOf(root, undefined, "claude", "project")).toMatchObject({
      status: "modified",
      version: PACKAGE_VERSION,
    });

    const out = await cli(["skills", "install", "--agent", "claude"], { cwd: root });
    expect(out.code).toBe(2);
    expect(out.json().diagnostics[0].code).toBe("HM0010");
    expect(out.json().diagnostics[0].expected[0]).toContain(dir);
    expect(await readFile(path.join(dir, "SKILL.md"), "utf8")).toBe(edited);
    expect(await readFile(path.join(dir, "notes.md"), "utf8")).toBe("notes\n");

    await writeFile(
      path.join(dir, "SKILL.md"),
      stamped(await readFile(path.join(BUNDLE, "SKILL.md"), "utf8"), PACKAGE_VERSION),
    );
    await rm(path.join(dir, "notes.md"));
    await rm(path.join(dir, "references/metrics.md"));
    expect((await statusOf(root, undefined, "claude", "project")).status).toBe("modified");
    expect((await cli(["skills", "install", "--agent", "claude"], { cwd: root })).code).toBe(2);
    expect((await tree(dir)).has("references/metrics.md")).toBe(false);

    const forced = await cli(["skills", "install", "--agent", "claude", "--force"], { cwd: root });
    expect(forced.code).toBe(0);
    expect(forced.json().skills[0].status).toBe("updated");
    await expectBundle(dir);
  });

  it("refuses a directory Hatchmark did not write unless --force", async () => {
    const { root } = await project();
    const dir = path.join(root, ".agents/skills/hatchmark");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "SKILL.md"), "---\nname: hatchmark\ndescription: mine\n---\n");
    const out = await cli(["skills", "install"], { cwd: root });
    expect(out.code).toBe(2);
    expect(out.json().diagnostics[0].code).toBe("HM0010");
    expect(out.json().diagnostics[0].expected).toEqual([`${dir} was not written by Hatchmark`]);
    expect(await readdir(root)).toEqual([".agents"]);
    expect(await readFile(path.join(dir, "SKILL.md"), "utf8")).toContain("description: mine");

    const forced = await cli(["skills", "install", "--force"], { cwd: root });
    expect(forced.code).toBe(0);
    expect(forced.json().skills.map((s: { status: string }) => s.status)).toEqual([
      "created",
      "updated",
    ]);
    await expectBundle(dir);
  });

  it("never writes through a symlink, even with --force", async () => {
    const { root, home } = await project();
    const elsewhere = await tempDir();
    await mkdir(path.join(root, ".claude"));
    await symlink(elsewhere, path.join(root, ".claude/skills"));
    const out = await cli(["skills", "install", "--force"], { cwd: root });
    expect(out.code).toBe(2);
    expect(out.json().diagnostics[0].code).toBe("HM0010");
    expect(out.json().diagnostics[0].expected).toEqual([
      `${path.join(root, ".claude/skills")} is a symlink`,
    ]);
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
    expect(file.json().diagnostics[0].expected).toEqual([
      `${path.join(dir, "SKILL.md")} is a symlink`,
    ]);
    expect(await readFile(path.join(elsewhere, "target.md"), "utf8")).toBe("keep\n");
  });

  it.skipIf(!POSIX_USER)("writes nothing when one target cannot be written", async () => {
    const { root } = await project();
    await cli(["skills", "install", "--agent", "claude"], { cwd: root });
    const claude = path.join(root, ".claude/skills/hatchmark");
    await setManifestVersion(claude, "0.0.0-old");
    const before = await tree(claude);
    const codex = path.join(root, ".agents/skills");
    await mkdir(codex, { recursive: true });
    await lock(codex, 0o555);

    const out = await cli(["skills", "install"], { cwd: root });
    expect(out.code).toBe(2);
    expect(out.json().diagnostics[0].code).toBe("HM0010");
    expect(out.json().diagnostics[0].expected[0]).toMatch(/\.agents\/skills.*EACCES/);
    expect(await tree(claude)).toEqual(before);
    expect(await readdir(path.join(root, ".claude/skills"))).toEqual(["hatchmark"]);
    expect(await readdir(codex)).toEqual([]);

    await rm(path.join(root, ".claude"), { recursive: true });
    const fresh = await cli(["skills", "install"], { cwd: root });
    expect(fresh.code).toBe(2);
    expect(await readdir(root)).toEqual([".agents"]);
  });

  it.skipIf(!POSIX_USER)(
    "reports success with a warning when the previous copy cannot be removed",
    async () => {
      for (const force of [true, false]) {
        const { root } = await project();
        await cli(["skills", "install", "--agent", "claude"], { cwd: root });
        const dir = path.join(root, ".claude/skills/hatchmark");
        if (force) await writeFile(path.join(dir, "local.md"), "mine\n");
        else await setManifestVersion(dir, "0.0.0-old");
        await chmod(path.join(dir, "references"), 0o555);

        const out = await cli(
          ["skills", "install", "--agent", "claude", ...(force ? ["--force"] : [])],
          {
            cwd: root,
          },
        );
        const leftovers = (await readdir(path.join(root, ".claude/skills")))
          .filter((name) => name.startsWith(".hatchmark-old-"))
          .map((name) => path.join(root, ".claude/skills", name));
        for (const old of leftovers) locked.push(path.join(old, "references"));
        expect(out.code, `force: ${force}`).toBe(0);
        expect(leftovers).toHaveLength(1);
        expect(out.json()).toMatchObject({
          ok: true,
          skills: [{ path: dir, status: "updated" }],
          warnings: [expect.stringContaining(leftovers[0] ?? "")],
        });
        await expectBundle(dir);
        const human = await run(["skills", "install", "--agent", "claude", "--format", "human"], {
          stdout: () => {},
          stderr: () => {},
          cwd: root,
          env: {},
          stdoutIsTTY: false,
          isAgent: async () => false,
        });
        expect(human).toBe(0);
      }
    },
  );

  it.skipIf(!POSIX_USER)("reports a directory it cannot read as unreadable", async () => {
    const { root } = await project();
    await mkdir(path.join(root, ".claude"));
    await lock(path.join(root, ".claude"), 0o000);
    expect(await statusOf(root, undefined, "claude", "project")).toMatchObject({
      status: "unreadable",
      detail: expect.stringContaining("EACCES"),
    });
    const out = await cli(["skills", "install", "--agent", "claude"], { cwd: root });
    expect(out.code).toBe(2);
    expect(out.json().diagnostics[0]).toMatchObject({ code: "HM0010" });
    expect(out.json().diagnostics[0].expected[0]).toContain("EACCES");
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

  it.skipIf(process.platform === "win32")(
    "calls a FIFO blocked without opening it, and doctor suggests no install",
    { timeout: 5000 },
    async () => {
      const { root, home } = await project();
      const dir = path.join(root, ".claude/skills/hatchmark");
      await mkdir(dir, { recursive: true });
      execFileSync("mkfifo", [path.join(dir, "SKILL.md")]);
      expect(await statusOf(root, home, "claude", "project")).toMatchObject({
        status: "blocked",
        detail: `${path.join(dir, "SKILL.md")} is not a regular file or directory`,
      });
      const doctor = await cli(["doctor"], { cwd: root, home });
      expect(doctor.code).toBe(0);
      const check = doctor.json().checks.find((c: { name: string }) => c.name === "skills");
      expect(check.detail).not.toContain("skills install --agent");
    },
  );

  it.skipIf(process.platform === "win32")(
    "calls a stale copy behind a symlink blocked, and doctor suggests no install",
    async () => {
      const { base, root, home } = await project();
      await cli(["skills", "install", "--agent", "claude"], { cwd: root, home });
      const real = path.join(base, "real-skills");
      await mkdir(real);
      execFileSync("mv", [path.join(root, ".claude/skills/hatchmark"), real]);
      await rm(path.join(root, ".claude/skills"), { recursive: true });
      await symlink(real, path.join(root, ".claude/skills"));
      await setManifestVersion(path.join(real, "hatchmark"), "0.0.0-old");
      expect(await statusOf(root, home, "claude", "project")).toMatchObject({ status: "blocked" });
      const check = (await cli(["doctor"], { cwd: root, home }))
        .json()
        .checks.find((c: { name: string }) => c.name === "skills");
      expect(check.status).toBe("ok");
      expect(check.detail).not.toContain("skills install --agent");
    },
  );
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
    await expectBundle(path.join(root, ".claude/skills/hatchmark"));
  });

  it("writes nothing when the skill directory is refused", async () => {
    const cwd = await tempDir();
    await mkdir(path.join(cwd, "shop/.claude/skills/hatchmark"), { recursive: true });
    const out = await cli(["init", "shop", "--skills"], { cwd });
    expect(out.code).toBe(2);
    expect(out.json().diagnostics[0].code).toBe("HM0010");
    expect(await readdir(path.join(cwd, "shop"))).toEqual([".claude"]);
  });

  it.skipIf(process.platform !== "darwin" || !POSIX_USER)(
    "says which project files it wrote when the skill cannot be swapped in",
    async () => {
      const cwd = await tempDir();
      const root = path.join(cwd, "shop");
      await mkdir(root);
      await cli(["skills", "install", "--agent", "claude"], { cwd: root });
      const dir = path.join(root, ".claude/skills/hatchmark");
      await writeFile(path.join(dir, "local.md"), "mine\n");
      const before = await tree(dir);
      execFileSync("chflags", ["uchg", dir]);
      immutable.push(dir);

      let stdout = "";
      const io = {
        stdout: (t: string) => {
          stdout += t;
        },
        stderr: () => {},
        cwd,
        env: {},
        stdoutIsTTY: false,
        isAgent: async () => false,
      };
      expect(await run(["init", "shop", "--skills", "--force", "--json"], io)).toBe(2);
      const json = JSON.parse(stdout);
      expect(json.diagnostics[0].code).toBe("HM0010");
      expect(json.diagnostics[0].message).toContain(`init wrote the project in ${json.root}`);
      expect(stdout).not.toContain("nothing was written");
      expect(json.created).toContain("hatchmark.yaml");
      expect(json.skills).toEqual([]);
      for (const file of json.created) {
        expect(await readFile(path.join(root, file), "utf8"), file).not.toBe("");
      }
      expect(await tree(dir)).toEqual(before);
      expect(await readdir(root)).not.toContain(".agents");
      expect((await readdir(path.join(root, ".claude/skills"))).sort()).toEqual(["hatchmark"]);

      stdout = "";
      await rm(path.join(root, "hatchmark.yaml"));
      expect(await run(["init", "shop", "--skills", "--force", "--format", "human"], io)).toBe(2);
      expect(stdout).toContain("init wrote the project");
      expect(stdout).toContain("created    hatchmark.yaml");
      expect(stdout).not.toContain("nothing was written");
    },
  );

  it.skipIf(!POSIX_USER)("writes nothing when the skill cannot be staged", async () => {
    const cwd = await tempDir();
    await mkdir(path.join(cwd, "shop/.agents/skills"), { recursive: true });
    await lock(path.join(cwd, "shop/.agents/skills"), 0o555);
    const out = await cli(["init", "shop", "--skills"], { cwd });
    expect(out.code).toBe(2);
    expect(out.json().diagnostics[0].code).toBe("HM0010");
    expect(await readdir(path.join(cwd, "shop"))).toEqual([".agents"]);
  });
});

describe("hatchmark doctor and the agent skill", () => {
  const skillsCheck = async (root: string, home: string, cwd = root) => {
    const out = await cli(["doctor", "--cwd", root], { cwd, home });
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
    const dir = path.join(home, ".claude/skills/hatchmark");
    await setManifestVersion(dir, "0.0.0-old");
    const check = await skillsCheck(root, home);
    expect(check.status).toBe("warn");
    expect(check.detail).toContain(dir);
    expect(check.detail).toContain("0.0.0-old");
    expect(check.detail).toContain(PACKAGE_VERSION);
    expect(check.detail).toContain("run hatchmark skills install --agent claude --scope user");
  });

  it("warns about an edited copy and offers the --force replacement", async () => {
    const { root, home } = await project();
    await cli(["skills", "install", "--agent", "codex"], { cwd: root, home });
    await writeFile(path.join(root, ".agents/skills/hatchmark/notes.md"), "mine\n");
    const check = await skillsCheck(root, home);
    expect(check.status).toBe("warn");
    expect(check.detail).toContain("was changed");
    expect(check.detail).toContain(
      "hatchmark skills install --agent codex --scope project --force",
    );
  });

  it.skipIf(process.platform === "win32")(
    "prints a repair command a shell runs as is, for any project path",
    async () => {
      const { base, root, home } = await project("project with spaces and 'quotes'");
      await cli(["skills", "install", "--agent", "claude"], { cwd: root, home });
      const dir = path.join(root, ".claude/skills/hatchmark");
      await setManifestVersion(dir, "0.0.0-old");
      const detail: string = (await skillsCheck(root, home, base)).detail;
      const command = /run (hatchmark skills install .*)$/.exec(detail)?.[1] ?? "";
      expect(command).toContain("--agent claude --scope project --cwd");
      const argv = execFileSync(
        "sh",
        ["-c", `printf '%s\\0' ${command.slice("hatchmark ".length)}`],
        {
          encoding: "utf8",
        },
      )
        .split("\0")
        .slice(0, -1);
      expect(argv).toEqual([
        "skills",
        "install",
        "--agent",
        "claude",
        "--scope",
        "project",
        "--cwd",
        root,
      ]);
      const fixed = await cli(argv, { cwd: base, home });
      expect(fixed.code).toBe(0);
      expect(fixed.json().skills[0]).toMatchObject({ path: dir, status: "updated" });
      expect((await manifest(dir)).version).toBe(PACKAGE_VERSION);
    },
  );
});
