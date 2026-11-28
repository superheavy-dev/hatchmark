import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { run } from "../../src/cli/main.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function cli(argv: string[], cwd: string, tty = false) {
  let stdout = "";
  const code = await run(argv, {
    stdout: (t) => {
      stdout += t;
    },
    stderr: () => {},
    cwd,
    env: {},
    stdoutIsTTY: tty,
    isAgent: async () => false,
  });
  return { code, stdout, json: () => JSON.parse(stdout) };
}

async function sample(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "hatchmark-test-"));
  dirs.push(dir);
  expect((await cli(["init", "p"], dir)).code).toBe(0);
  return path.join(dir, "p");
}

async function append(file: string, text: string) {
  await writeFile(file, (await readFile(file, "utf8")) + text);
}

describe("hatchmark test", () => {
  it("says there are no tests and exits 0", async () => {
    const p = await sample();
    const result = await cli(["test"], p);
    expect(result.code).toBe(0);
    expect(result.json()).toMatchObject({ ok: true, passed: 0, failed: 0, errors: 0, results: [] });
    expect((await cli(["test"], p, true)).stdout).toContain("no tests");
  });

  it("runs only the named metrics and sources, and rejects unknown names", async () => {
    const p = await sample();
    await append(
      path.join(p, "metrics/revenue.yaml"),
      "tests:\n  - window: [2026-10-01, 2026-10-31]\n    expect: 1\n",
    );
    await append(
      path.join(p, "metrics/orders.yaml"),
      "tests:\n  - window: [2026-10-01, 2026-10-31]\n    expect: 1\n",
    );
    const one = await cli(["test", "orders"], p);
    expect(one.json().results.map((r: { target: string }) => r.target)).toEqual(["orders"]);
    expect(one.code).toBe(1);
    const unknown = await cli(["test", "revenu"], p);
    expect(unknown.code).toBe(2);
    expect(unknown.json().diagnostics[0]).toMatchObject({
      code: "HM0002",
      help: 'did you mean "revenue"?',
    });
  });

  it("reports a missing fixture file as HM1001 without running the test", async () => {
    const p = await sample();
    await append(
      path.join(p, "metrics/revenue.yaml"),
      "tests:\n  - window: [2026-10-01, 2026-10-31]\n    data: { orders: tests/none.csv }\n    expect: 1\n",
    );
    const result = await cli(["test"], p);
    expect(result.code).toBe(3);
    expect(result.json()).toMatchObject({ errors: 1, results: [{ status: "error" }] });
    expect(result.json().diagnostics[0]).toMatchObject({
      code: "HM1001",
      pointer: "/tests/0/data",
    });
  });

  it("stops on errors in hatchmark.yaml", async () => {
    const p = await sample();
    await append(path.join(p, "hatchmark.yaml"), "bogus: 1\n");
    const result = await cli(["test"], p);
    expect(result.code).toBe(2);
    expect(result.json().diagnostics[0].code).toBe("HM3002");
  });

  it("does not change query ids or the build cache when only tests change", async () => {
    const p = await sample();
    const before = (await cli(["explain", "revenue"], p))
      .json()
      .queries.map((q: { id: string }) => q.id);
    const config = path.join(p, "hatchmark.yaml");
    await writeFile(
      config,
      (await readFile(config, "utf8")).replace(
        "    path: data/orders.csv\n",
        "    path: data/orders.csv\n    tests:\n      - rows: { min: 1 }\n",
      ),
    );
    expect((await cli(["check"], p)).code).toBe(0);
    const after = (await cli(["explain", "revenue"], p))
      .json()
      .queries.map((q: { id: string }) => q.id);
    expect(after).toEqual(before);
    expect((await cli(["test"], p)).json()).toMatchObject({ ok: true, passed: 1 });
  });
});
