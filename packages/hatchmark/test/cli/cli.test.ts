import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { run } from "../../src/cli/main.js";
import { jsonSchema } from "../../src/spec/index.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "hatchmark-cli-"));
  dirs.push(dir);
  return dir;
}

async function cli(
  argv: string[],
  opts: { cwd: string; tty?: boolean; agent?: boolean; env?: Record<string, string> },
) {
  let stdout = "";
  let stderr = "";
  const code = await run(argv, {
    stdout: (t) => {
      stdout += t;
    },
    stderr: (t) => {
      stderr += t;
    },
    cwd: opts.cwd,
    env: opts.env ?? {},
    stdoutIsTTY: opts.tty ?? false,
    isAgent: async () => opts.agent ?? false,
  });
  return { code, stdout, stderr, json: () => JSON.parse(stdout) };
}

describe("hatchmark init and check", () => {
  it("creates a sample project that checks clean", async () => {
    const cwd = await tempDir();
    const init = await cli(["init", "shop"], { cwd });
    expect(init.code).toBe(0);
    expect(init.json()).toMatchObject({
      format_version: "1",
      ok: true,
      template: "sample",
      next: ["hatchmark check --cwd shop"],
    });
    expect(init.json().created).toEqual([
      "hatchmark.json",
      "data/orders.csv",
      "metrics/revenue.json",
      "metrics/orders.json",
      "metrics/avg_order_value.json",
      "metrics/customers.json",
      "dashboards/sales.json",
      "AGENTS.md",
      "CLAUDE.md",
      ".gitignore",
    ]);
    const config = JSON.parse(await readFile(path.join(cwd, "shop/hatchmark.json"), "utf8"));
    expect(config).toMatchObject({
      name: "shop",
      locale: "en-US",
      currency: "USD",
      timezone: "UTC",
      telemetry: false,
    });
    const check = await cli(["check", "--cwd", "shop"], { cwd });
    expect(check.code).toBe(0);
    expect(check.json()).toEqual({
      format_version: "1",
      ok: true,
      error_count: 0,
      warning_count: 0,
      diagnostics: [],
    });
  });

  it("writes the same bytes every time", async () => {
    const cwd = await tempDir();
    await cli(["init", "a", "--name", "x"], { cwd });
    await cli(["init", "b", "--name", "x"], { cwd });
    for (const file of [
      "hatchmark.json",
      "data/orders.csv",
      "dashboards/sales.json",
      "AGENTS.md",
    ]) {
      expect(await readFile(path.join(cwd, "a", file), "utf8"), file).toBe(
        await readFile(path.join(cwd, "b", file), "utf8"),
      );
    }
    const csv = await readFile(path.join(cwd, "a/data/orders.csv"), "utf8");
    expect(csv.split("\n")[0]).toBe(
      "order_id,ordered_at,customer_id,region,state,plan,industry,status,amount",
    );
    expect(csv.trim().split("\n")).toHaveLength(1501);
  });

  it("refuses to overwrite without --force and writes nothing", async () => {
    const cwd = await tempDir();
    await cli(["init"], { cwd });
    await writeFile(path.join(cwd, "metrics/revenue.json"), "{}");
    const again = await cli(["init"], { cwd });
    expect(again.code).toBe(2);
    expect(again.json().diagnostics[0]).toMatchObject({
      code: "HM0004",
      expected: expect.arrayContaining(["hatchmark.json"]),
    });
    expect(await readFile(path.join(cwd, "metrics/revenue.json"), "utf8")).toBe("{}");
    const forced = await cli(["init", "--force"], { cwd });
    expect(forced.code).toBe(0);
    expect(forced.json().updated).toEqual(["metrics/revenue.json"]);
    expect(forced.json().unchanged).toContain("hatchmark.json");
  });

  it("merges AGENTS.md and .gitignore and leaves an existing CLAUDE.md alone", async () => {
    const cwd = await tempDir();
    await writeFile(path.join(cwd, "AGENTS.md"), "# Team rules\n\nBe nice.\n");
    await writeFile(path.join(cwd, "CLAUDE.md"), "Our own notes\n");
    await writeFile(path.join(cwd, ".gitignore"), "node_modules/\ndist/");
    const first = await cli(["init", "--template", "minimal"], { cwd });
    expect(first.json().notes[0]).toContain("CLAUDE.md");
    const agents = await readFile(path.join(cwd, "AGENTS.md"), "utf8");
    expect(agents.startsWith("# Team rules\n\nBe nice.\n\n<!-- hatchmark:start -->")).toBe(true);
    expect(await readFile(path.join(cwd, "CLAUDE.md"), "utf8")).toBe("Our own notes\n");
    expect(await readFile(path.join(cwd, ".gitignore"), "utf8")).toBe(
      "node_modules/\ndist/\n.hatchmark/\n",
    );
    await writeFile(
      path.join(cwd, "AGENTS.md"),
      agents.replace("## Hatchmark", "## Stale") + "After.\n",
    );
    await cli(["init", "--template", "minimal", "--force"], { cwd });
    const refreshed = await readFile(path.join(cwd, "AGENTS.md"), "utf8");
    expect(refreshed).toContain("## Hatchmark");
    expect(refreshed).not.toContain("## Stale");
    expect(refreshed.endsWith("<!-- hatchmark:end -->\nAfter.\n")).toBe(true);
    expect(refreshed.match(/hatchmark:start/g)).toHaveLength(1);
  });

  it("creates a minimal project that checks clean", async () => {
    const cwd = await tempDir();
    expect((await cli(["init", "--template", "minimal"], { cwd })).code).toBe(0);
    expect((await cli(["check"], { cwd })).json().ok).toBe(true);
  });

  it("exits 1 for errors in files, 3 for a missing data file, 2 without a project", async () => {
    const cwd = await tempDir();
    await cli(["init"], { cwd });
    await writeFile(
      path.join(cwd, "dashboards/broken.json"),
      '{"title": "x", "blocks": [{"type": "kpi", "metric": "revenu"}]}',
    );
    const broken = await cli(["check"], { cwd });
    expect(broken.code).toBe(1);
    expect(broken.json().diagnostics.map((d: { code: string }) => d.code)).toEqual(["HM2003"]);
    expect((await cli(["check", "metrics"], { cwd })).json().ok).toBe(true);
    await rm(path.join(cwd, "dashboards/broken.json"));
    await rm(path.join(cwd, "data/orders.csv"));
    const missing = await cli(["check"], { cwd });
    expect(missing.code).toBe(3);
    expect(missing.json().diagnostics[0].code).toBe("HM2010");
    const empty = await tempDir();
    const none = await cli(["check"], { cwd: empty });
    expect(none.code).toBe(2);
    expect(none.json().diagnostics[0].code).toBe("HM1005");
  });

  it("prints rustc-style text in a terminal", async () => {
    const cwd = await tempDir();
    await cli(["init"], { cwd });
    await writeFile(
      path.join(cwd, "dashboards/broken.json"),
      '{"title": "x", "blocks": [{"type": "kpi", "metric": "revenu"}]}',
    );
    const out = await cli(["check", "--no-color"], { cwd, tty: true });
    expect(out.stdout).toContain('error[HM2003]: unknown metric "revenu"');
    expect(out.stdout).toContain(" --> dashboards/broken.json:1:");
    expect(out.stdout).not.toContain("\u001b[");
    expect((await cli(["check"], { cwd, tty: true, env: { NO_COLOR: "1" } })).stdout).not.toContain(
      "\u001b[",
    );
    expect((await cli(["check"], { cwd, tty: true })).stdout).toContain("\u001b[");
  });
});

describe("output mode", () => {
  it("is JSON when stdout is not a terminal or an agent runs it, human otherwise", async () => {
    const cwd = await tempDir();
    expect((await cli(["version"], { cwd })).stdout.startsWith("{")).toBe(true);
    expect((await cli(["version"], { cwd, tty: true, agent: true })).stdout.startsWith("{")).toBe(
      true,
    );
    expect((await cli(["version"], { cwd, tty: true })).stdout.startsWith("hatchmark ")).toBe(true);
    expect(
      (await cli(["version", "--format", "human"], { cwd })).stdout.startsWith("hatchmark "),
    ).toBe(true);
    expect((await cli(["version", "--json"], { cwd, tty: true })).stdout.startsWith("{")).toBe(
      true,
    );
    const json = (await cli(["version"], { cwd })).stdout;
    expect(json.trimEnd().includes("\n")).toBe(false);
  });
});

describe("usage errors", () => {
  it("suggest the closest command and exit 2", async () => {
    const cwd = await tempDir();
    const out = await cli(["chek"], { cwd });
    expect(out.code).toBe(2);
    expect(out.json().diagnostics[0]).toMatchObject({
      code: "HM0001",
      help: 'did you mean "check"?',
    });
  });

  it("reject unknown options, bad values and extra arguments", async () => {
    const cwd = await tempDir();
    const cases: [string[], string][] = [
      [["check", "--nope"], "unknown option --nope"],
      [["version", "--format", "xml"], 'unknown --format "xml"'],
      [["init", "--template", "tiny"], 'unknown template "tiny"'],
      [["schema", "metrc"], 'unknown schema kind "metrc"'],
      [["explain"], "missing argument <code>"],
      [["explain", "HM9999"], 'unknown diagnostic code "HM9999"'],
    ];
    for (const [argv, message] of cases) {
      const out = await cli(argv, { cwd });
      expect(out.code, argv.join(" ")).toBe(2);
      expect(out.json().diagnostics[0].message, argv.join(" ")).toBe(message);
    }
  });

  it("accepts --yes as a no-op", async () => {
    const cwd = await tempDir();
    expect((await cli(["version", "--yes"], { cwd })).code).toBe(0);
    expect((await cli(["version", "-y"], { cwd })).code).toBe(0);
  });
});

describe("help", () => {
  it("gives every command its own help with one example", async () => {
    const cwd = await tempDir();
    for (const command of ["init", "check", "schema", "explain", "version", "doctor"]) {
      const out = await cli([command, "--help"], { cwd });
      expect(out.code, command).toBe(0);
      expect(out.stdout, command).toContain(`Usage: hatchmark ${command}`);
      expect(out.stdout.match(/^Example:$/gm), command).toHaveLength(1);
      expect((await cli(["help", command], { cwd })).stdout).toBe(out.stdout);
    }
    const top = await cli([], { cwd });
    expect(top.code).toBe(0);
    expect(top.stdout).toContain("Exit codes: 0 ok");
  });
});

describe("schema, explain, version, doctor", () => {
  it("prints the JSON Schemas", async () => {
    const cwd = await tempDir();
    expect((await cli(["schema", "dashboard"], { cwd })).json()).toEqual(jsonSchema("dashboard"));
    expect(Object.keys((await cli(["schema"], { cwd })).json())).toEqual([
      "project",
      "metric",
      "dashboard",
    ]);
  });

  it("explains codes case-insensitively", async () => {
    const cwd = await tempDir();
    expect((await cli(["explain", "hm2003"], { cwd })).json()).toMatchObject({
      code: "HM2003",
      title: "unknown metric",
    });
  });

  it("reports versions and environment checks", async () => {
    const cwd = await tempDir();
    expect((await cli(["version"], { cwd })).json()).toMatchObject({
      format_version: "1",
      version: "0.0.0",
    });
    const doctor = await cli(["doctor"], { cwd });
    expect(doctor.code).toBe(0);
    expect(
      doctor.json().checks.map((c: { name: string; status: string }) => [c.name, c.status]),
    ).toEqual([
      ["node", "ok"],
      ["docs", "ok"],
      ["schemas", "ok"],
      ["project", "warn"],
    ]);
    await mkdir(path.join(cwd, "x"));
  });
});
