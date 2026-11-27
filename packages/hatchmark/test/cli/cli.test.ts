import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
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

describe("review regressions (HAT-16)", () => {
  it("keeps the requested output mode for parse errors", async () => {
    const cwd = await tempDir();
    const agent = await cli(["check", "--json", "--bogus"], { cwd, tty: true, agent: true });
    expect(agent.code).toBe(2);
    expect(agent.json().diagnostics[0].message).toBe("unknown option --bogus");
    const human = await cli(["check", "--format=human", "--bogus"], { cwd });
    expect(human.stdout.startsWith("error[HM0002]")).toBe(true);
    expect(
      (await cli(["check", "--bogus"], { cwd, tty: true, agent: true })).stdout.startsWith("{"),
    ).toBe(true);
  });

  it("resolves check paths against --cwd", async () => {
    const cwd = await tempDir();
    await cli(["init", "p"], { cwd });
    await writeFile(
      path.join(cwd, "p/dashboards/bad.json"),
      '{"title":"Broken","blocks":[{"type":"kpi","metric":"revenu"}]}',
    );
    const out = await cli(["check", "--cwd", "p", "dashboards/bad.json"], { cwd });
    expect(out.code).toBe(1);
    expect(out.json().diagnostics.map((d: { code: string }) => d.code)).toEqual(["HM2003"]);
  });

  it("writes nothing when a path init owns is a directory or a symlink", async () => {
    const cwd = await tempDir();
    await mkdir(path.join(cwd, "data/orders.csv"), { recursive: true });
    for (const force of [[], ["--force"]]) {
      const out = await cli(["init", ...force], { cwd });
      expect(out.code).toBe(2);
      expect(out.json().diagnostics[0]).toMatchObject({
        code: "HM0004",
        expected: ["data/orders.csv"],
      });
      await expect(readFile(path.join(cwd, "hatchmark.json"))).rejects.toThrow();
    }
    const dangling = await tempDir();
    await symlink("notes", path.join(dangling, "CLAUDE.md"));
    const out = await cli(["init", "--template", "minimal"], { cwd: dangling });
    expect(out.code).toBe(2);
    expect(out.json().diagnostics[0]).toMatchObject({ code: "HM0004", expected: ["CLAUDE.md"] });
    await expect(readFile(path.join(dangling, "notes"))).rejects.toThrow();
    await expect(readFile(path.join(dangling, "hatchmark.json"))).rejects.toThrow();
    const linked = await tempDir();
    await writeFile(path.join(linked, "CLAUDE.md"), "My Claude notes\n");
    await symlink("CLAUDE.md", path.join(linked, "AGENTS.md"));
    for (const force of [[], ["--force"]]) {
      const refused = await cli(["init", "--template", "minimal", ...force], { cwd: linked });
      expect(refused.code).toBe(2);
      expect(refused.json().diagnostics[0]).toMatchObject({
        code: "HM0004",
        expected: ["AGENTS.md"],
      });
    }
    expect(await readFile(path.join(linked, "CLAUDE.md"), "utf8")).toBe("My Claude notes\n");
  });

  it("refuses to edit AGENTS.md unless its markers are one balanced pair", async () => {
    const cases: [string, string[]][] = [
      ["<!-- hatchmark:start -->\nKeep me\n", ["AGENTS.md:1: <!-- hatchmark:start -->"]],
      ["<!-- hatchmark:end -->\nKeep me\n", ["AGENTS.md:1: <!-- hatchmark:end -->"]],
      [
        "Intro\n<!-- hatchmark:end -->\n<!-- hatchmark:start -->\n",
        ["AGENTS.md:2: <!-- hatchmark:end -->", "AGENTS.md:3: <!-- hatchmark:start -->"],
      ],
      [
        "<!-- hatchmark:start -->\na\n<!-- hatchmark:end -->\n<!-- hatchmark:start -->\nb\n<!-- hatchmark:end -->\n",
        [
          "AGENTS.md:1: <!-- hatchmark:start -->",
          "AGENTS.md:3: <!-- hatchmark:end -->",
          "AGENTS.md:4: <!-- hatchmark:start -->",
          "AGENTS.md:6: <!-- hatchmark:end -->",
        ],
      ],
    ];
    for (const [text, lines] of cases) {
      const cwd = await tempDir();
      await writeFile(path.join(cwd, "AGENTS.md"), text);
      for (const force of [[], ["--force"]]) {
        const out = await cli(["init", "--template", "minimal", ...force], { cwd });
        expect(out.code, text).toBe(2);
        expect(out.json().diagnostics[0], text).toMatchObject({ code: "HM0005", expected: lines });
      }
      expect(await readFile(path.join(cwd, "AGENTS.md"), "utf8")).toBe(text);
      await expect(readFile(path.join(cwd, "hatchmark.json"))).rejects.toThrow();
    }
  });

  it("counts a marker only when it is alone on its line (HAT-16 round 3)", async () => {
    const cases: [string, string[]][] = [
      [
        "<!-- hatchmark:start --> <!-- hatchmark:start -->\nKeep me\n<!-- hatchmark:end -->\n",
        [
          "AGENTS.md:3: <!-- hatchmark:end -->",
          "AGENTS.md:1: marker text that is not alone on its line",
        ],
      ],
      [
        "See <!-- hatchmark:start --> below\n<!-- hatchmark:start -->\nx\n<!-- hatchmark:end -->\n",
        [
          "AGENTS.md:2: <!-- hatchmark:start -->",
          "AGENTS.md:4: <!-- hatchmark:end -->",
          "AGENTS.md:1: marker text that is not alone on its line",
        ],
      ],
    ];
    for (const [text, expected] of cases) {
      const cwd = await tempDir();
      await writeFile(path.join(cwd, "AGENTS.md"), text);
      const out = await cli(["init", "--template", "minimal"], { cwd });
      expect(out.code, text).toBe(2);
      expect(out.json().diagnostics[0], text).toMatchObject({ code: "HM0005" });
      expect([...out.json().diagnostics[0].expected].sort(), text).toEqual([...expected].sort());
      expect(await readFile(path.join(cwd, "AGENTS.md"), "utf8")).toBe(text);
    }
    const indented = await tempDir();
    await writeFile(
      path.join(indented, "AGENTS.md"),
      "Intro\n  <!-- hatchmark:start -->\nold\n<!-- hatchmark:end -->  \nAfter\n",
    );
    expect((await cli(["init", "--template", "minimal"], { cwd: indented })).code).toBe(0);
    const merged = await readFile(path.join(indented, "AGENTS.md"), "utf8");
    expect(merged.startsWith("Intro\n<!-- hatchmark:start -->")).toBe(true);
    expect(merged.endsWith("<!-- hatchmark:end -->\nAfter\n")).toBe(true);
    expect(merged).not.toContain("old");
  });

  it("refuses a symlinked directory between the project root and the target", async () => {
    const cwd = await tempDir();
    await mkdir(path.join(cwd, "real"));
    await symlink("real", path.join(cwd, "link"));
    for (const dir of ["link/new", "link"]) {
      const out = await cli(["init", dir, "--template", "minimal"], { cwd });
      expect(out.code, dir).toBe(2);
      expect(out.json().diagnostics[0], dir).toMatchObject({
        code: "HM0004",
        expected: [path.join(cwd, "link")],
      });
    }
    const outside = await tempDir();
    const fromOutside = await cli(["init", path.join(cwd, "link/new"), "--template", "minimal"], {
      cwd: outside,
    });
    expect(fromOutside.code).toBe(2);
    expect(fromOutside.json().diagnostics[0].expected).toContain(path.join(cwd, "link"));
    await expect(readFile(path.join(cwd, "real/new/hatchmark.json"))).rejects.toThrow();
    expect((await cli(["init", "real/new", "--template", "minimal"], { cwd })).code).toBe(0);
  });

  it("checks hatchmark.json first, whatever the path scope", async () => {
    const cwd = await tempDir();
    await cli(["init"], { cwd });
    await writeFile(path.join(cwd, "hatchmark.json"), "{");
    for (const scope of [["dashboards/sales.json"], ["metrics"], ["data/orders.csv"]]) {
      const out = await cli(["check", ...scope], { cwd });
      expect(out.code, scope.join(" ")).toBe(2);
      expect(out.json().diagnostics[0].code).toBe("HM1002");
    }
  });

  it("makes an invalid --format value a usage error whatever the other flags", async () => {
    const cwd = await tempDir();
    for (const argv of [
      ["check", "--json", "--format=invalid"],
      ["version", "--format", "xml", "--json"],
    ]) {
      const out = await cli(argv, { cwd, tty: true });
      expect(out.code, argv.join(" ")).toBe(2);
      expect(out.json().diagnostics[0].code, argv.join(" ")).toBe("HM0002");
    }
  });

  it("exits 2 for a malformed hatchmark.json and for inherited property names as commands", async () => {
    const cwd = await tempDir();
    await writeFile(path.join(cwd, "hatchmark.json"), "{");
    const out = await cli(["check"], { cwd });
    expect(out.code).toBe(2);
    expect(out.json().diagnostics[0].code).toBe("HM1002");
    for (const argv of [["constructor"], ["help", "constructor"], ["toString", "--help"]]) {
      const bad = await cli(argv, { cwd });
      expect(bad.code, argv.join(" ")).toBe(2);
      expect(bad.json().diagnostics[0].code, argv.join(" ")).toBe("HM0001");
    }
  });
});

describe("help", () => {
  it("gives every command its own help with one example", async () => {
    const cwd = await tempDir();
    for (const command of ["init", "check", "schema", "explain", "version", "doctor"]) {
      const out = await cli([command, "--help"], { cwd, tty: true });
      expect(out.code, command).toBe(0);
      expect(out.stdout, command).toContain(`Usage: hatchmark ${command}`);
      expect(out.stdout.match(/^Example:$/gm), command).toHaveLength(1);
      expect((await cli(["help", command], { cwd, tty: true })).stdout).toBe(out.stdout);
      expect((await cli([command, "--help", "--json"], { cwd, tty: true })).json()).toMatchObject({
        format_version: "1",
        command,
        usage: expect.stringContaining(`hatchmark ${command}`),
      });
    }
    expect((await cli(["help"], { cwd })).json().commands).toHaveLength(6);
    const top = await cli([], { cwd, tty: true });
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
