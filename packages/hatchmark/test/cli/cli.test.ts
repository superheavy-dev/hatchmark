import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { run } from "../../src/cli/main.js";
import { jsonSchema } from "../../src/spec/index.js";
import { fromYaml } from "../yaml.js";

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
      "hatchmark.yaml",
      "data/orders.csv",
      "metrics/revenue.yaml",
      "metrics/orders.yaml",
      "metrics/avg_order_value.yaml",
      "metrics/customers.yaml",
      "dashboards/sales.yaml",
      "AGENTS.md",
      "CLAUDE.md",
      ".gitignore",
    ]);
    const config = fromYaml(await readFile(path.join(cwd, "shop/hatchmark.yaml"), "utf8"));
    expect(config).toMatchObject({
      name: "shop",
      locale: "en-US",
      currency: "USD",
      timezone: "UTC",
      telemetry: false,
    });
    const check = await cli(["check", "--cwd", "shop"], { cwd });
    expect(check.code).toBe(0);
    expect(check.json()).toMatchObject({
      format_version: "1",
      ok: true,
      error_count: 0,
      warning_count: 0,
    });
    expect(
      check
        .json()
        .diagnostics.map((d: { code: string; severity: string; file: string; pointer: string }) => [
          d.code,
          d.severity,
          d.file,
          d.pointer,
        ]),
    ).toEqual([
      ["HM4040", "note", "dashboards/sales.yaml", "/blocks/4/grain"],
      ["HM4040", "note", "dashboards/sales.yaml", "/blocks/4/grain"],
      ["HM4040", "note", "hatchmark.yaml", "/name"],
    ]);
    const human = await cli(["check", "--cwd", "shop", "--format", "human"], { cwd });
    expect(human.code).toBe(0);
    expect(human.stdout.trim().split("\n\n")).toEqual([
      "note[HM4040]: dashboards/sales.yaml: 2 default definitions, run hatchmark check --explain-defaults",
      "note[HM4040]: hatchmark.yaml: 1 default definition, run hatchmark check --explain-defaults",
      "ok: 0 errors, 0 warnings",
    ]);
    expect((await cli(["check", "--cwd", "shop", "--strict"], { cwd })).code).toBe(0);
    const explained = await cli(
      ["check", "--cwd", "shop", "--format", "human", "--explain-defaults"],
      { cwd },
    );
    expect(explained.code).toBe(0);
    expect(explained.stdout.match(/^note\[HM4040\]: uses /gm)).toHaveLength(3);
  });

  it("writes the same bytes every time", async () => {
    const cwd = await tempDir();
    await cli(["init", "a", "--name", "x"], { cwd });
    await cli(["init", "b", "--name", "x"], { cwd });
    for (const file of [
      "hatchmark.yaml",
      "data/orders.csv",
      "dashboards/sales.yaml",
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
    await writeFile(path.join(cwd, "metrics/revenue.yaml"), "{}");
    const again = await cli(["init"], { cwd });
    expect(again.code).toBe(2);
    expect(again.json().diagnostics[0]).toMatchObject({
      code: "HM0004",
      expected: expect.arrayContaining(["hatchmark.yaml"]),
    });
    expect(await readFile(path.join(cwd, "metrics/revenue.yaml"), "utf8")).toBe("{}");
    const forced = await cli(["init", "--force"], { cwd });
    expect(forced.code).toBe(0);
    expect(forced.json().updated).toEqual(["metrics/revenue.yaml"]);
    expect(forced.json().unchanged).toContain("hatchmark.yaml");
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
      path.join(cwd, "dashboards/broken.yaml"),
      '{"title": "x", "blocks": [{"type": "kpi", "metric": "revenu"}]}',
    );
    const broken = await cli(["check"], { cwd });
    expect(broken.code).toBe(1);
    expect(broken.json().diagnostics.map((d: { code: string }) => d.code)).toEqual(["HM2003"]);
    expect((await cli(["check", "metrics"], { cwd })).json().ok).toBe(true);
    await rm(path.join(cwd, "dashboards/broken.yaml"));
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
      path.join(cwd, "dashboards/broken.yaml"),
      '{"title": "x", "blocks": [{"type": "kpi", "metric": "revenu"}]}',
    );
    const out = await cli(["check", "--no-color"], { cwd, tty: true });
    expect(out.stdout).toContain('error[HM2003]: unknown metric "revenu"');
    expect(out.stdout).toContain(" --> dashboards/broken.yaml:1:");
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
      [["explain"], "missing argument <code> or <metric>"],
      [["explain", "HM9999"], 'unknown diagnostic code "HM9999"'],
      [["explain", "--block", "revenue"], "missing option --dashboard"],
      [
        ["explain", "revenue", "--dashboard", "sales"],
        'unexpected argument "revenue" with --dashboard and --block',
      ],
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

describe("CLI regressions", () => {
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
      path.join(cwd, "p/dashboards/bad.yaml"),
      '{"title":"Broken","blocks":[{"type":"kpi","metric":"revenu"}]}',
    );
    const out = await cli(["check", "--cwd", "p", "dashboards/bad.yaml"], { cwd });
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
      await expect(readFile(path.join(cwd, "hatchmark.yaml"))).rejects.toThrow();
    }
    const dangling = await tempDir();
    await symlink("notes", path.join(dangling, "CLAUDE.md"));
    const out = await cli(["init", "--template", "minimal"], { cwd: dangling });
    expect(out.code).toBe(2);
    expect(out.json().diagnostics[0]).toMatchObject({ code: "HM0004", expected: ["CLAUDE.md"] });
    await expect(readFile(path.join(dangling, "notes"))).rejects.toThrow();
    await expect(readFile(path.join(dangling, "hatchmark.yaml"))).rejects.toThrow();
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
      await expect(readFile(path.join(cwd, "hatchmark.yaml"))).rejects.toThrow();
    }
  });

  it("counts a marker only when it is alone on its line", async () => {
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

  it("resolves symlinks above the project root and refuses them inside it", async () => {
    const cwd = await tempDir();
    await mkdir(path.join(cwd, "private/tmp"), { recursive: true });
    await symlink("private/tmp", path.join(cwd, "tmp"));
    const macStyle = await cli(["init", path.join(cwd, "tmp/x"), "--template", "minimal"], {
      cwd: await tempDir(),
    });
    expect(macStyle.code).toBe(0);
    expect(macStyle.json().root).toBe(path.join(await realpath(cwd), "private/tmp/x"));
    expect(await readFile(path.join(cwd, "private/tmp/x/hatchmark.yaml"), "utf8")).toContain(
      "name: x\n",
    );
    expect(
      (await cli(["init", "--template", "minimal", "--force"], { cwd: path.join(cwd, "tmp/x") }))
        .code,
    ).toBe(0);
    await symlink("private/tmp/x", path.join(cwd, "project"));
    expect((await cli(["init", "project", "--template", "minimal", "--force"], { cwd })).code).toBe(
      0,
    );

    const inside = await tempDir();
    await mkdir(path.join(inside, "elsewhere"));
    await symlink("elsewhere", path.join(inside, "data"));
    for (const force of [[], ["--force"]]) {
      const out = await cli(["init", ...force], { cwd: inside });
      expect(out.code).toBe(2);
      expect(out.json().diagnostics[0]).toMatchObject({ code: "HM0004", expected: ["data"] });
    }
    await expect(readFile(path.join(inside, "hatchmark.yaml"))).rejects.toThrow();
  });

  it("checks hatchmark.yaml first, whatever the path scope", async () => {
    const cwd = await tempDir();
    await cli(["init"], { cwd });
    await writeFile(path.join(cwd, "hatchmark.yaml"), "{");
    for (const scope of [["dashboards/sales.yaml"], ["metrics"], ["data/orders.csv"]]) {
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

  it("exits 2 for a malformed hatchmark.yaml and for inherited property names as commands", async () => {
    const cwd = await tempDir();
    await writeFile(path.join(cwd, "hatchmark.yaml"), "{");
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
    for (const command of [
      "init",
      "check",
      "build",
      "dev",
      "schema",
      "explain",
      "version",
      "doctor",
    ]) {
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
    expect((await cli(["help"], { cwd })).json().commands).toHaveLength(8);
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
      "segment",
    ]);
  });

  it("explains codes case-insensitively", async () => {
    const cwd = await tempDir();
    expect((await cli(["explain", "hm2003"], { cwd })).json()).toMatchObject({
      code: "HM2003",
      title: "unknown metric",
    });
  });

  it("prints the SQL of a metric, of a block, and of every block with check --sql", async () => {
    const cwd = await tempDir();
    await cli(["init", "shop"], { cwd });
    const metric = await cli(["explain", "revenue", "--cwd", "shop"], { cwd });
    expect(metric.code).toBe(0);
    const explained = metric.json();
    expect(explained).toMatchObject({ format_version: "1", metric: "revenue" });
    expect(explained.as_of).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(explained.queries).toHaveLength(1);
    expect(explained.queries[0]).toMatchObject({ source: "orders" });
    expect(explained.queries[0].sql).toContain("date_trunc('month'");
    expect(explained.queries[0].sql).toContain("$hm_p1");

    const human = await cli(["explain", "revenue", "--cwd", "shop"], { cwd, tty: true });
    expect(human.stdout).toContain(
      `-- revenue by month over last_12_months as of ${explained.as_of}`,
    );
    expect(human.stdout).toMatch(/>= CAST\('\d{4}-\d{2}-01' AS DATE\)/);
    expect(human.stdout).not.toContain("$hm_p");

    const unknown = await cli(["explain", "revenu", "--cwd", "shop"], { cwd });
    expect(unknown.code).toBe(2);
    expect(unknown.json().diagnostics[0]).toMatchObject({
      message: 'unknown metric "revenu"',
      help: 'did you mean "revenue"?',
    });

    const check = await cli(["check", "--sql", "--cwd", "shop"], { cwd });
    expect(check.code).toBe(0);
    const blocks: { dashboard: string; block: string; queries: { id: string }[] }[] =
      check.json().sql;
    expect(blocks.length).toBeGreaterThan(1);
    const first = blocks[0] as (typeof blocks)[number];
    const block = await cli(
      ["explain", "--dashboard", first.dashboard, "--block", first.block, "--cwd", "shop"],
      { cwd },
    );
    expect(block.code).toBe(0);
    expect(block.json()).toMatchObject({
      dashboard: first.dashboard,
      block: first.block,
      queries: first.queries,
    });
    const missing = await cli(
      ["explain", "--dashboard", first.dashboard, "--block", "nope", "--cwd", "shop"],
      { cwd },
    );
    expect(missing.code).toBe(2);
    expect(missing.json().diagnostics[0]).toMatchObject({
      code: "HM0002",
      message: `unknown block "nope" in dashboard "${first.dashboard}"`,
    });
    expect((await cli(["check", "--cwd", "shop"], { cwd })).json()).not.toHaveProperty("sql");

    await writeFile(
      path.join(cwd, "shop/metrics/hm1.yaml"),
      await readFile(path.join(cwd, "shop/metrics/orders.yaml"), "utf8"),
    );
    expect((await cli(["explain", "hm1", "--cwd", "shop"], { cwd })).json()).toMatchObject({
      metric: "hm1",
    });
    expect((await cli(["explain", "hm2003", "--cwd", "shop"], { cwd })).json()).toMatchObject({
      code: "HM2003",
    });

    await writeFile(path.join(cwd, "shop/metrics/unused.yaml"), "{\n");
    const scoped = ["check", "dashboards/sales.yaml", "--cwd", "shop"];
    expect((await cli(scoped, { cwd })).code).toBe(0);
    const blocked = await cli([...scoped, "--sql"], { cwd });
    expect(blocked.code).toBe(1);
    expect(
      blocked.json().diagnostics.map((d: { code: string; file: string }) => [d.code, d.file]),
    ).toEqual([["HM2015", "dashboards/sales.yaml"]]);
    expect(blocked.json().sql).toEqual([]);
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
