import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { run } from "../../src/cli/main.js";
import { startDevServer } from "../../src/dev/server.js";
import { copyProject, EXAMPLE } from "../node/fixture.js";

const GOOD = await readFile(path.join(EXAMPLE, "hatchmark.yaml"), "utf8");

const CASES = [
  {
    name: "malformed YAML",
    text: GOOD.replace("theme: default\n", "theme: [default\n"),
    code: "HM1002",
    at: { line: 13, column: 1 },
  },
  {
    name: "a wrong type on a known field",
    text: GOOD.replace("telemetry: false", 'telemetry: "no"'),
    code: "HM3003",
    at: { line: 13, column: 12 },
  },
  {
    name: "an unknown field",
    text: GOOD.replace("theme: default\n", "theme: default\ncolour: blue\n"),
    code: "HM3002",
    at: { line: 13, column: 1 },
  },
  {
    name: "a missing required field",
    text: GOOD.replace("name: Global Sales\n", ""),
    code: "HM3001",
    at: { line: 2, column: 1 },
  },
  { name: "an empty file", text: "", code: "HM1002", at: { line: 1, column: 1 } },
] as const;

const dirs: string[] = [];
afterAll(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function project(config: string): Promise<string> {
  const dir = await copyProject(EXAMPLE, "hatchmark-config-");
  dirs.push(dir);
  await writeFile(path.join(dir, "hatchmark.yaml"), config);
  return dir;
}

async function cli(argv: string[], tty = false) {
  let stdout = "";
  const code = await run(argv, {
    stdout: (t) => {
      stdout += t;
    },
    stderr: () => {},
    cwd: "/",
    env: {},
    stdoutIsTTY: tty,
    isAgent: async () => false,
  });
  return { code, stdout };
}

describe("an invalid hatchmark.yaml", { timeout: 30_000 }, () => {
  for (const c of CASES) {
    it(`reports ${c.name} as ${c.code} from check and build`, async () => {
      const dir = await project(c.text);
      const reports: unknown[] = [];
      for (const command of ["check", "build"]) {
        const out = await cli([command, "--cwd", dir, "--json"]);
        expect(out.code, command).toBe(2);
        const report = JSON.parse(out.stdout);
        expect(report, command).toMatchObject({ format_version: "1", ok: false, error_count: 1 });
        expect(report.diagnostics, command).toEqual([
          expect.objectContaining({
            code: c.code,
            severity: "error",
            file: "hatchmark.yaml",
            docs: `hatchmark explain ${c.code}`,
          }),
        ]);
        expect(report.diagnostics[0].range.start, command).toEqual(c.at);
        reports.push(report);

        const human = await cli([command, "--cwd", dir, "--no-color"], true);
        expect(human.code, command).toBe(2);
        expect(human.stdout, command).toContain(
          `error[${c.code}]: ${report.diagnostics[0].message}`,
        );
        expect(human.stdout, command).toContain(` --> hatchmark.yaml:${c.at.line}:${c.at.column}`);
        expect(human.stdout, command).toContain(`hatchmark explain ${c.code}`);
      }
      expect(reports[1]).toEqual(reports[0]);
      expect(await readdir(dir)).not.toContain("dist");
    });
  }

  for (const argv of [
    ["data", "describe", "orders"],
    ["data", "query", "select 1"],
    ["explain", "orders"],
  ]) {
    it(`reports each case from ${argv.slice(0, 2).join(" ")}`, async () => {
      for (const c of CASES) {
        const dir = await project(c.text);
        const out = await cli([...argv, "--cwd", dir, "--json"]);
        expect(out.code, c.name).toBe(2);
        const report = JSON.parse(out.stdout);
        expect(report, c.name).toMatchObject({ ok: false, error_count: 1 });
        expect(report.diagnostics, c.name).toEqual([
          expect.objectContaining({
            code: c.code,
            file: "hatchmark.yaml",
            range: expect.objectContaining({ start: c.at }),
          }),
        ]);
      }
    });
  }

  it("exits 2 from data and explain without a usable hatchmark.yaml", async () => {
    const empty = await mkdtemp(path.join(tmpdir(), "hatchmark-noproject-"));
    const yml = await mkdtemp(path.join(tmpdir(), "hatchmark-yml-"));
    dirs.push(empty, yml);
    await writeFile(path.join(yml, "hatchmark.yml"), GOOD);
    for (const [dir, code] of [
      [empty, "HM1005"],
      [yml, "HM1007"],
    ] as const) {
      for (const argv of [
        ["data", "describe", "orders"],
        ["data", "query", "SELECT 1"],
        ["explain", "orders"],
      ]) {
        const out = await cli([...argv, "--cwd", dir, "--json"]);
        expect(out.code, `${code} ${argv.join(" ")}`).toBe(2);
        const report = JSON.parse(out.stdout);
        expect(report.ok).toBe(false);
        expect(report.diagnostics.map((d: { code: string }) => d.code)).toEqual([code]);
      }
    }
  });

  it("shows each case in the dev overlay, from startup and after an edit", async () => {
    const [first, ...rest] = CASES;
    const dir = await project(first.text);
    const errors: string[] = [];
    const started = await startDevServer({
      root: dir,
      port: 0,
      host: "127.0.0.1",
      log: () => {},
      onEvent: (e) => {
        if (e.event === "hatchmark:error") errors.push(...e.data.diagnostics.map((d) => d.code));
      },
    });
    if ("report" in started) throw new Error(JSON.stringify(started.report));
    const { server } = started;
    try {
      const page = await (await fetch(new URL("/", server.url))).text();
      expect(page).toContain('id="hm-dev-overlay"');
      expect(page).toContain(`error[${first.code}]</span>`);
      for (const c of rest) {
        errors.length = 0;
        await writeFile(path.join(dir, "hatchmark.yaml"), c.text);
        await expect.poll(() => errors, { timeout: 15_000 }).toContain(c.code);
        const html = await (await fetch(new URL("/", server.url))).text();
        expect(html, c.name).toContain(`error[${c.code}]</span>`);
      }
    } finally {
      await server.close();
    }
  }, 60_000);
});
