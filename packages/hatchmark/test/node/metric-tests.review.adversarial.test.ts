import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { run as cli } from "../../src/cli/main.js";
import { PROJECT_DEFAULTS } from "../../src/spec/index.js";
import { metric, Oracle, removeProjects, writeProject } from "./fixture.js";

const SALES = [
  "id,sold,region,status,amount",
  "s1,2026-03-08,West,paid,2000000000",
  "s2,2026-03-08,East,paid,10",
  "s3,2026-03-08,,paid,20",
  "s4,2026-03-08,(empty),paid,7",
  "s5,2026-03-09,West,refunded,40",
].join("\n");
const FIXTURE =
  "id,sold,region,status,amount,channel\nf1,2026-03-08,West,paid,20,direct\nf2,2026-03-08,East,paid,5,retail\n";
const ACCOUNTS = "account,as_of,mrr\na1,2026-01-01,10\na2,2026-01-01,0\na1,2026-02-01,11\n";
const LABELS = "region,title\nWest,West\nEast,East\n";

const CONFIG = {
  ...PROJECT_DEFAULTS,
  name: "review",
  timezone: "UTC",
  sources: {
    sales: { type: "csv", path: "data/sales.csv" },
    accounts: { type: "csv", path: "data/accounts.csv", snapshot: "as_of" },
    labels: { type: "csv", path: "data/labels.csv" },
    joined: {
      type: "lookup",
      from: "sales",
      lookups: [{ table: "labels", key: { region: "region" } }],
    },
  },
};

const FILES = {
  "data/sales.csv": `${SALES}\n`,
  "data/accounts.csv": ACCOUNTS,
  "data/labels.csv": LABELS,
  "tests/fixture.csv": FIXTURE,
};

const WINDOW = ["2026-03-08", "2026-03-08"];

const revenue = (tests: unknown[], body: Record<string, unknown> = {}) =>
  metric({
    type: "aggregate",
    table: "sales",
    aggregate: "sum",
    column: "amount",
    time: "sold",
    tests,
    ...body,
  });
const count = metric({ type: "aggregate", table: "sales", aggregate: "count", time: "sold" });

let oracle: Oracle;
beforeAll(async () => {
  oracle = await Oracle.open();
  const { root } = await writeProject({ ...FILES, "hatchmark.yaml": CONFIG });
  for (const [table, file] of [
    ["sales", "data/sales.csv"],
    ["accounts", "data/accounts.csv"],
    ["fixture", "tests/fixture.csv"],
  ]) {
    await oracle.run(
      `CREATE TABLE ${table} AS SELECT * FROM read_csv('${root}/${file}', sample_size = -1)`,
    );
  }
});
afterAll(async () => {
  oracle.close();
  await removeProjects();
});

async function value(sql: string): Promise<number> {
  const [row] = await oracle.rows(sql);
  return Number(Object.values(row ?? {})[0]);
}

async function hm(
  command: string,
  metrics: Record<string, unknown>,
  config: Record<string, unknown> = CONFIG,
) {
  const { root } = await writeProject({
    ...FILES,
    "hatchmark.yaml": config,
    ...Object.fromEntries(Object.entries(metrics).map(([n, s]) => [`metrics/${n}.yaml`, s])),
  });
  let stdout = "";
  const code = await cli([command, "--json"], {
    stdout: (t) => {
      stdout += t;
    },
    stderr: () => {},
    cwd: root,
    env: {},
    stdoutIsTTY: false,
    isAgent: async () => false,
  });
  return { code, out: JSON.parse(stdout) };
}

const typo = [{ column: "regoin", op: "eq", value: "West" }];
const at = (d: { code: string; file?: string; pointer?: string }) => [d.code, d.file, d.pointer];

describe("hatchmark test: review cases", () => {
  it("holds the absolute tolerance on large values, and never rounds through an overflow", async () => {
    const total = await value("SELECT sum(amount) FROM sales WHERE sold = DATE '2026-03-08'");
    const { code, out } = await hm("test", {
      revenue: revenue([
        { window: WINDOW, expect: total },
        { window: WINDOW, expect: total + 0.5, tolerance: 0 },
        { window: WINDOW, expect: total + 1.25, tolerance: 0.5 },
        { window: WINDOW, expect: total + 1, tolerance: 1 },
        { window: WINDOW, expect: total + 1 },
      ]),
      huge: revenue([{ window: WINDOW, expect: 1.1e305 }], {
        filters: [{ column: "id", op: "eq", value: "s1" }],
        aggregate: "max",
      }),
    });
    expect(code).toBe(1);
    const status = (target: string) =>
      out.results
        .filter((r: { target: string }) => r.target === target)
        .map((r: { status: string }) => r.status);
    expect(status("revenue")).toEqual(["pass", "fail", "fail", "pass", "fail"]);
    expect(status("huge")).toEqual(["fail"]);
  });

  it("reports one HM2018 at the test for a where or by typo, from check and test", async () => {
    for (const [name, metrics, pointer] of [
      [
        "metric",
        { revenue: revenue([{ window: WINDOW, expect: 0, where: typo }]) },
        "/tests/0/where/0/column",
      ],
      [
        "by",
        { revenue: revenue([{ window: WINDOW, expect: { West: 0 }, by: "regoin" }]) },
        "/tests/0/by",
      ],
      [
        "ratio",
        {
          revenue: revenue([]),
          orders: count,
          aov: metric({
            type: "ratio",
            numerator: "revenue",
            denominator: "orders",
            tests: [{ window: WINDOW, expect: 0, where: typo }],
          }),
        },
        "/tests/0/where/0/column",
      ],
    ] as const) {
      const file = name === "ratio" ? "metrics/aov.yaml" : "metrics/revenue.yaml";
      for (const command of ["check", "test"]) {
        const { code, out } = await hm(command, metrics);
        expect(code, `${name} ${command}`).toBe(1);
        expect(out.diagnostics.map(at), `${name} ${command}`).toEqual([["HM2018", file, pointer]]);
      }
    }
  });

  it("checks a test's columns against its fixture, not the source it swaps", async () => {
    const direct = await value("SELECT sum(amount) FROM fixture WHERE channel = 'direct'");
    const tests = [
      {
        window: WINDOW,
        data: { sales: "tests/fixture.csv" },
        where: [{ column: "channel", op: "eq", value: "direct" }],
        expect: direct,
      },
      {
        window: WINDOW,
        data: { sales: "tests/fixture.csv" },
        where: [{ column: "chanel", op: "eq", value: "direct" }],
        expect: direct,
      },
    ];
    const check = await hm("check", { revenue: revenue(tests), orders: count });
    expect(check.code).toBe(0);
    const { code, out } = await hm("test", { revenue: revenue(tests), orders: count });
    expect(code).toBe(1);
    expect(out.results.map((r: { status: string }) => r.status)).toEqual(["pass", "error"]);
    expect(out.diagnostics.map(at)).toEqual([
      ["HM2018", "metrics/revenue.yaml", "/tests/1/where/0/column"],
    ]);
  });

  it("counts every row of a snapshot source and refuses row counts on a lookup source", async () => {
    const rows = await value("SELECT count(*) FROM accounts");
    const snapshot = await hm(
      "test",
      {},
      {
        ...CONFIG,
        sources: {
          ...CONFIG.sources,
          accounts: {
            ...CONFIG.sources.accounts,
            tests: [{ rows: { min: rows, max: rows } }, { rows: { max: rows - 1 } }],
          },
        },
      },
    );
    expect(snapshot.code).toBe(1);
    expect(
      snapshot.out.results.map((r: { status: string; actual: number }) => [r.status, r.actual]),
    ).toEqual([
      ["pass", rows],
      ["fail", rows],
    ]);
    const lookup = await hm(
      "test",
      {},
      {
        ...CONFIG,
        sources: {
          ...CONFIG.sources,
          joined: { ...CONFIG.sources.joined, tests: [{ rows: { min: 1 } }] },
        },
      },
    );
    expect(lookup.code).toBe(2);
    expect(lookup.out.diagnostics.map(at)).toEqual([
      ["HM3002", "hatchmark.yaml", "/sources/joined/tests"],
    ]);
  });

  it("refuses to pin (empty) when the data has both empty values and the text (empty)", async () => {
    const empty = await value("SELECT sum(amount) FROM sales WHERE region IS NULL");
    const { code, out } = await hm("test", {
      revenue: revenue([{ window: WINDOW, by: "region", expect: { "(empty)": empty } }]),
    });
    expect(code).toBe(1);
    expect(out.results[0]).toMatchObject({ status: "fail", actual: { "(empty)": null } });
    expect(out.diagnostics[0].message).toContain("ambiguous");
  });

  it("keeps HM4031 for horizons and HM4030 for compared values", async () => {
    const total = await value("SELECT sum(amount) FROM sales");
    const untimed = {
      ...revenue([
        { window: WINDOW, expect: total },
        { window: WINDOW, by: "status", expect: {} },
      ]),
    };
    delete (untimed as Record<string, unknown>).time;
    const plain = await hm("test", { revenue: untimed });
    expect(plain.code).toBe(0);
    expect(plain.out.diagnostics).toEqual([]);
    const unsupported = await hm("test", {
      zoned: revenue([{ window: WINDOW, expect: 0 }], { table: "joined" }),
    });
    expect(unsupported.code).toBe(1);
    expect(unsupported.out).toMatchObject({ passed: 0, failed: 0, errors: 1 });
    expect(unsupported.out.diagnostics.map(at)).toEqual([
      ["HM4023", "metrics/zoned.yaml", "/tests/0"],
    ]);
  });

  it("rejects a data swap of a lookup source", async () => {
    const { code, out } = await hm("test", {
      zoned: revenue([{ window: WINDOW, expect: 0, data: { joined: "tests/fixture.csv" } }], {
        table: "joined",
      }),
    });
    expect(code).toBe(1);
    expect(out.diagnostics.map(at)).toEqual([
      ["HM2019", "metrics/zoned.yaml", "/tests/0/data/joined"],
    ]);
  });

  it("gives one JSON shape and exit 2 without a project", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "hatchmark-empty-"));
    let stdout = "";
    const code = await cli(["test", "--json"], {
      stdout: (t) => {
        stdout += t;
      },
      stderr: () => {},
      cwd: root,
      env: {},
      stdoutIsTTY: false,
      isAgent: async () => false,
    });
    await rm(root, { recursive: true, force: true });
    expect(code).toBe(2);
    expect(JSON.parse(stdout)).toMatchObject({
      ok: false,
      passed: 0,
      failed: 0,
      errors: 0,
      results: [],
    });
  });
});
