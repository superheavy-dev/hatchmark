import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { docs, headingAnchor } from "../../src/cli/commands/docs.js";
import { run } from "../../src/cli/main.js";
import { VERSION } from "../../src/version.js";

const DOCS = path.resolve(import.meta.dirname, "../../docs");

async function cli(argv: string[]) {
  let stdout = "";
  const code = await run(argv, {
    stdout: (t) => {
      stdout += t;
    },
    stderr: () => {},
    cwd: tmpdir(),
    env: {},
    stdoutIsTTY: false,
    isAgent: async () => false,
  });
  return { code, json: () => JSON.parse(stdout) };
}

describe("hatchmark docs", () => {
  it("lists every bundled page with the installed version", async () => {
    const files = (await readdir(DOCS, { recursive: true }))
      .map((f) => f.split(path.sep).join("/"))
      .filter((f) => f.endsWith(".md"))
      .sort();
    const out = (await cli(["docs"])).json();
    expect(out.version).toBe(VERSION);
    expect(out.topics.map((t: { path: string }) => t.path)).toEqual(files);
    expect(out.topics[0]).toMatchObject({
      topic: "index",
      path: "README.md",
      title: "Hatchmark docs",
    });
  });

  it("prints a page byte for byte, by full or short topic", async () => {
    const text = await readFile(path.join(DOCS, "components/table.md"), "utf8");
    for (const topic of ["components/table", "table", "components/table.md"]) {
      const result = await cli(["docs", topic]);
      expect(result.code, topic).toBe(0);
      expect(result.json().content, topic).toBe(text);
    }
  });

  it("prints one section up to the next heading of its level", async () => {
    const out = (await cli(["docs", "cli#data"])).json();
    expect(out).toMatchObject({ topic: "cli", section: "data", title: "data" });
    expect(out.content).toMatch(/^## data\r?\n/);
    expect(out.content).not.toContain("## init");
    const cli_md = await readFile(path.join(DOCS, "cli.md"), "utf8");
    expect(cli_md.split(/\r?\n/)[out.line - 1]).toBe("## data");
    expect(cli_md).toContain(out.content);
  });

  it("finds only sections that hold every word, best first", async () => {
    const out = (await cli(["docs", "--search", "Percent of TOTAL", "--limit", "50"])).json();
    expect(out.results.length).toBeGreaterThan(1);
    const scores = out.results.map((r: { score: number }) => r.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
    for (const r of out.results) {
      const section = (await cli(["docs", r.section])).json();
      const own = section.content.toLowerCase();
      for (const word of ["percent", "of", "total"]) expect(own, r.section).toContain(word);
    }
    expect(
      (await cli(["docs", "--search", "percent", "--limit", "2"])).json().results,
    ).toHaveLength(2);
    expect((await cli(["docs", "--search", "qqqzzz"])).json()).toMatchObject({ results: [] });
  });

  it("uses GitHub's anchors for headings with HTML tags, code and links", async () => {
    expect((await cli(["docs", "metrics#metrics-metricsyaml"])).json().title).toBe(
      "Metrics (metrics/<name>.yaml)",
    );
    expect((await cli(["docs", "dashboards#dashboards-dashboardsyaml"])).code).toBe(0);
    expect(headingAnchor("The `format` field [docs](x.md) <b>now</b>")).toBe(
      "the-format-field-docs-now",
    );
  });

  it("numbers repeated headings and skips headings inside code fences", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "hatchmark-docs-"));
    try {
      await writeFile(
        path.join(dir, "page.md"),
        "# Page\n\n## Example\none\n\n```yaml\n# not a heading\n```\n\n## Example\ntwo\n",
      );
      const sections = await docs(["page#example-1"], {}, dir);
      expect(sections.json).toMatchObject({ content: "## Example\ntwo" });
      const first = await docs(["page#example"], {}, dir);
      expect((first.json as { content: string }).content).toContain("# not a heading");
      const missing = await docs(["page#not-a-heading"], {}, dir);
      expect(missing.exitCode).toBe(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reports unknown topics and sections with the valid names", async () => {
    const topic = await cli(["docs", "metric"]);
    expect(topic.code).toBe(2);
    expect(topic.json().diagnostics[0]).toMatchObject({
      code: "HM0002",
      help: 'did you mean "metrics"?',
    });
    const section = (await cli(["docs", "cli#dta"])).json().diagnostics[0];
    expect(section).toMatchObject({ code: "HM0002", help: 'did you mean "data"?' });
    expect((await cli(["docs", "cli", "--search", "x"])).code).toBe(2);
    expect((await cli(["docs", "--search", " "])).json().diagnostics[0].code).toBe("HM0003");
    expect((await cli(["docs", "--search", "x", "--limit", "0"])).code).toBe(2);
  });
});
