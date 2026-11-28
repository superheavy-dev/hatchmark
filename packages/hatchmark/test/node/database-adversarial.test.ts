import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { run as cli } from "../../src/cli/main.js";
import { runDashboard } from "../../src/compiler/index.js";
import {
  createDatabaseStore,
  createDuckDbExecutor,
  nodeProjectHost,
} from "../../src/node/index.js";
import { loadProject, PROJECT_DEFAULTS } from "../../src/spec/index.js";
import { toYaml } from "../yaml.js";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const PG = process.env.HM_TEST_POSTGRES_URL;
const MY = process.env.HM_TEST_MYSQL_URL;
const lit = (s: string) => "'" + s.replaceAll("'", "''") + "'";
const plain = (v: unknown) =>
  JSON.parse(JSON.stringify(v, (_, x) => (typeof x === "bigint" ? String(x) : x)));
const roots: string[] = [];
afterAll(async () => {
  for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true });
});

async function remote(engine: "postgres" | "mysql", url: string, sql: string, read = false) {
  const instance = await DuckDBInstance.create(":memory:");
  const c = await instance.connect();
  await c.run("INSTALL " + engine);
  await c.run("LOAD " + engine);
  if (engine === "mysql") await c.run("SET mysql_session_time_zone = '+00:00'");
  await c.run("ATTACH " + lit(url) + " AS r (TYPE " + engine + ")");
  try {
    if (read)
      return plain(
        (
          await c.runAndReadAll("SELECT * FROM " + engine + "_query('r', " + lit(sql) + ")")
        ).getRows(),
      ) as unknown[][];
    await c.run("CALL " + engine + "_execute('r', " + lit(sql) + ")");
    return [];
  } finally {
    c.closeSync();
    instance.closeSync();
  }
}

async function local(sql: string) {
  const instance = await DuckDBInstance.create(":memory:");
  const c = await instance.connect();
  try {
    return plain((await c.runAndReadAll(sql)).getRows()) as unknown[][];
  } finally {
    c.closeSync();
    instance.closeSync();
  }
}

async function cliRun(root: string, args: string[], env: Record<string, string | undefined>) {
  let out = "";
  const code = await cli([...args, "--cwd", root], {
    stdout: (t) => {
      out += t;
    },
    stderr: (t) => {
      out += t;
    },
    cwd: root,
    env,
    stdoutIsTTY: false,
    isAgent: async () => false,
  });
  return { code, out };
}

const metric = (b: Record<string, unknown>) => ({
  label: "M",
  format: { type: "number" },
  better: "up",
  ...b,
});
const kpi = (m: string) => ({
  t: {
    title: "T",
    period: { asOf: "2025-02-01", range: "all_time", compare: "none" },
    blocks: [{ type: "kpi", id: "k", metric: m }],
  },
});
const monthly = (m: string) => ({
  t: {
    title: "T",
    period: { asOf: "2025-04-01", range: "all_time", compare: "none" },
    blocks: [{ type: "line", id: "m", metrics: [m], grain: "month" }],
  },
});

async function project(
  sources: Record<string, unknown>,
  metrics: Record<string, unknown>,
  dashboards: Record<string, unknown>,
) {
  const root = await mkdtemp(path.join(tmpdir(), "hm-db-adv-"));
  roots.push(root);
  const files: Record<string, unknown> = {
    "hatchmark.yaml": { ...PROJECT_DEFAULTS, name: "Shop", timezone: "America/New_York", sources },
    ...Object.fromEntries(Object.entries(metrics).map(([n, m]) => ["metrics/" + n + ".yaml", m])),
    ...Object.fromEntries(
      Object.entries(dashboards).map(([n, d]) => ["dashboards/" + n + ".yaml", d]),
    ),
  };
  for (const [f, c] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, f)), { recursive: true });
    await writeFile(path.join(root, f), typeof c === "string" ? c : toYaml(c));
  }
  return root;
}

async function dash(root: string, env: Record<string, string | undefined>) {
  const { project: p } = await loadProject(nodeProjectHost(root, env));
  if (!p?.config.spec) throw new Error("invalid project");
  const databases = createDatabaseStore({ root, env });
  const executor = await createDuckDbExecutor({ root, config: p.config.spec, databases });
  try {
    return (await runDashboard(p, "t", executor)) as any;
  } finally {
    await executor.close();
    await databases.close();
  }
}

describe.skipIf(MY === undefined)("mysql", () => {
  const url = MY as string;
  beforeAll(async () => {
    await remote("mysql", url, "DROP TABLE IF EXISTS adv_ts");
    await remote("mysql", url, "CREATE TABLE adv_ts (id int, at timestamp(6) NULL)");
    await remote(
      "mysql",
      url,
      "INSERT INTO adv_ts VALUES (1, '2025-02-01 02:00:00'), (2, '2025-02-01 03:00:00'), (3, '2025-02-15 12:00:00')",
    );
    await remote("mysql", url, "DROP TABLE IF EXISTS adv_coll");
    await remote(
      "mysql",
      url,
      "CREATE TABLE adv_coll (id int, region varchar(10), customer varchar(10), amount decimal(10,2), at datetime)",
    );
    await remote(
      "mysql",
      url,
      "INSERT INTO adv_coll VALUES (1,'West','c1',10,'2025-01-05'),(2,'west','C1',20,'2025-01-06'),(3,'Wést','c2',30,'2025-01-07'),(4,'East','c3',40,'2025-01-08')",
    );
  });
  afterAll(async () => {
    await remote("mysql", url, "DROP TABLE IF EXISTS adv_ts");
    await remote("mysql", url, "DROP TABLE IF EXISTS adv_coll");
  });

  it("a TIMESTAMP column read through query lands in the same local month as through table, with the source's timezone set", async () => {
    const oracle = await remote(
      "mysql",
      url,
      "SELECT DATE_FORMAT(CONVERT_TZ(at, '+00:00', 'America/New_York'), '%Y-%m') m, COUNT(*) FROM adv_ts GROUP BY m ORDER BY m",
      true,
    );
    expect(oracle).toEqual([
      ["2025-01", "2"],
      ["2025-02", "1"],
    ]);
    const runs: Record<string, any> = {};
    for (const [label, spec] of [
      ["table", { table: "adv_ts", timezone: "America/New_York" }],
      ["query", { query: "SELECT id, at FROM adv_ts", timezone: "America/New_York" }],
      ["query without timezone", { query: "SELECT id, at FROM adv_ts" }],
    ] as const) {
      const root = await project(
        { ts: { type: "mysql", env: "DB", freshness: { through: "as_of" }, ...spec } },
        { n: metric({ type: "aggregate", table: "ts", aggregate: "count", time: "at" }) },
        monthly("n"),
      );
      runs[label] = await dash(root, { DB: url });
    }
    expect(runs.table.data.blocks[0].series[0].values).toEqual([2, 1, 0, 0]);
    expect(runs["query without timezone"].data.blocks[0].series[0].values).toEqual([2, 1, 0, 0]);
    expect(runs.query.data).toBeUndefined();
    expect(runs.query.diagnostics.map((d: { code: string }) => d.code)).toContain("HM2045");
  });

  it("stops on text that MySQL's collation treats as equal, and matches MySQL once the query compares bytes", async () => {
    const collated = await project(
      { s: { type: "mysql", env: "DB", table: "adv_coll", freshness: { through: "as_of" } } },
      { n: metric({ type: "aggregate", table: "s", aggregate: "count", time: "at" }) },
      kpi("n"),
    );
    const stopped = await dash(collated, { DB: url });
    expect(stopped.data).toBeUndefined();
    const hm2046 = stopped.diagnostics.find((d: { code: string }) => d.code === "HM2046");
    expect(hm2046?.message).toContain('"region"');
    expect(hm2046?.message).toContain('"customer"');
    const query =
      "SELECT id, region COLLATE utf8mb4_0900_as_cs AS region, customer COLLATE utf8mb4_0900_as_cs AS customer, amount, at FROM adv_coll";
    const root = await project(
      { s: { type: "mysql", env: "DB", query, freshness: { through: "as_of" } } },
      {
        cust: metric({
          type: "aggregate",
          table: "s",
          aggregate: "count_distinct",
          column: "customer",
          time: "at",
        }),
        west: metric({
          type: "aggregate",
          table: "s",
          aggregate: "sum",
          column: "amount",
          time: "at",
          filters: [{ column: "region", op: "in", values: ["West"] }],
        }),
      },
      {
        t: {
          title: "T",
          period: { asOf: "2025-02-01", range: "all_time", compare: "none" },
          blocks: [
            { type: "kpi", id: "c", metric: "cust" },
            { type: "kpi", id: "w", metric: "west" },
          ],
        },
      },
    );
    const built = await dash(root, { DB: url });
    expect(built.diagnostics.filter((d: { severity: string }) => d.severity === "error")).toEqual(
      [],
    );
    const [[distinct, west]] = (await remote(
      "mysql",
      url,
      "SELECT COUNT(DISTINCT customer), CAST(SUM(CASE WHEN region IN ('West') THEN amount END) AS CHAR) FROM (" +
        query +
        ") AS q",
      true,
    )) as [[string, string]];
    expect({ distinct: built.data.blocks[0].value, west: built.data.blocks[1].value }).toEqual({
      distinct: Number(distinct),
      west: Number(west),
    });
    expect({ distinct: Number(distinct), west: Number(west) }).toEqual({ distinct: 4, west: 10 });
  });
});

describe.skipIf(PG === undefined)("postgres credentials", () => {
  const base = new URL(PG as string);
  const at = (password: string) =>
    base.protocol + "//" + base.username + ":" + password + "@" + base.host + base.pathname;
  for (const [label, url, needle] of [
    ["an unencoded @ in a URL password", at("hunter2@prodpw"), "prodpw"],
    ["an unencoded / in a URL password", at("sl4sh/rest99"), "sl4sh"],
  ] as const) {
    it("never prints part of " + label, async () => {
      const root = await project(
        {
          s: {
            type: "postgres",
            env: "DB",
            table: "missing_table",
            freshness: { through: "as_of" },
          },
        },
        { n: metric({ type: "aggregate", table: "s", aggregate: "count", time: "at" }) },
        kpi("n"),
      );
      for (const args of [["check"], ["check", "--json"], ["build"], ["explain", "n"]]) {
        const { out } = await cliRun(root, args, { DB: url });
        expect(out, args.join(" ")).not.toContain(needle);
      }
    });
  }
});

describe.skipIf(MY === undefined)("mysql credentials", () => {
  for (const key of ["passwd", "pwd"]) {
    it("never prints a " + key + "= password", async () => {
      const secret = "Wr0ng" + key + "Secret";
      const dsn = (MY as string).replace(/\bpassword=\S+/, key + "=" + secret);
      const root = await project(
        {
          s: { type: "mysql", env: "DB", table: "missing_table", freshness: { through: "as_of" } },
        },
        { n: metric({ type: "aggregate", table: "s", aggregate: "count", time: "at" }) },
        kpi("n"),
      );
      for (const args of [["check"], ["check", "--json"], ["build"], ["explain", "n"]]) {
        const { out } = await cliRun(root, args, { DB: dsn });
        expect(out, args.join(" ")).not.toContain(secret);
      }
      const built = JSON.parse((await cliRun(root, ["build", "--json"], { DB: dsn })).out);
      expect(built.diagnostics.filter((d: { code: string }) => d.code === "HM2041")).toHaveLength(
        1,
      );
    });
  }
});

describe("credentials pasted into env", () => {
  for (const [label, value, needle] of [
    ["MySQL passwd=", "host=db user=reader passwd=Hunter2x database=shop", "Hunter2x"],
    ["pwd=", "host=db user=reader pwd=Hunter3x database=shop", "Hunter3x"],
  ] as const) {
    it("masks " + label + " in source frames", async () => {
      const root = await project({ s: { type: "mysql", env: value, table: "orders" } }, {}, {});
      for (const args of [["check"], ["check", "--json"], ["build"]]) {
        const { out } = await cliRun(root, args, {});
        expect(out, args.join(" ")).not.toContain(needle);
      }
    });
  }
});

describe.skipIf(PG === undefined || MY === undefined)("query sources", () => {
  it("build reads a query that ends in a line comment, as check does", async () => {
    await remote("postgres", PG as string, "DROP TABLE IF EXISTS adv_q");
    await remote("postgres", PG as string, "CREATE TABLE adv_q (id int, at timestamptz)");
    await remote(
      "postgres",
      PG as string,
      "INSERT INTO adv_q VALUES (1, '2025-01-02'), (2, '2025-01-03')",
    );
    const root = await project(
      {
        s: {
          type: "postgres",
          env: "DB",
          query: "SELECT id, at FROM adv_q -- every row",
          freshness: { through: "2025-01-31" },
        },
      },
      { n: metric({ type: "aggregate", table: "s", aggregate: "count", time: "at" }) },
      kpi("n"),
    );
    expect((await cliRun(root, ["check"], { DB: PG })).code).toBe(0);
    const built = await cliRun(root, ["build", "--json", "--out", path.join(root, "dist")], {
      DB: PG,
    });
    await remote("postgres", PG as string, "DROP TABLE IF EXISTS adv_q");
    expect(built.code, built.out).toBe(0);
  });

  it("refuses writes through a query", async () => {
    for (const [engine, url, sql] of [
      ["postgres", PG, "WITH d AS (DELETE FROM adv_rw RETURNING *) SELECT * FROM d"],
      ["mysql", MY, "DELETE FROM adv_rw"],
    ] as const) {
      await remote(engine, url as string, "DROP TABLE IF EXISTS adv_rw");
      await remote(
        engine,
        url as string,
        "CREATE TABLE adv_rw (id int, at " +
          (engine === "postgres" ? "timestamptz" : "datetime") +
          ")",
      );
      await remote(engine, url as string, "INSERT INTO adv_rw VALUES (1, '2025-01-02')");
      const root = await project(
        { s: { type: engine, env: "DB", query: sql, freshness: { through: "2025-01-31" } } },
        { n: metric({ type: "aggregate", table: "s", aggregate: "count", time: "at" }) },
        kpi("n"),
      );
      const built = await cliRun(root, ["build", "--json", "--out", path.join(root, "dist")], {
        DB: url,
      });
      expect(built.code).not.toBe(0);
      expect(await remote(engine, url as string, "SELECT COUNT(*) FROM adv_rw", true)).toEqual([
        ["1"],
      ]);
      await remote(engine, url as string, "DROP TABLE IF EXISTS adv_rw");
    }
  });
});

const ENGINES = { postgres: PG, mysql: MY } as const;

function withoutPassword(
  engine: "postgres" | "mysql",
  url: string,
): { url: string; password: string } {
  if (engine === "postgres") {
    const parsed = new URL(url);
    const password = decodeURIComponent(parsed.password);
    parsed.password = "";
    return { url: parsed.toString(), password };
  }
  const password = /\bpassword=(\S+)/.exec(url)?.[1] ?? "";
  return { url: url.replace(/\s*\bpassword=\S+/, ""), password };
}

for (const engine of ["postgres", "mysql"] as const) {
  const url = ENGINES[engine];
  describe.skipIf(url === undefined)(engine + " edge cases", () => {
    const base = url as string;
    const table = "adv_edge_" + engine;
    beforeAll(async () => {
      await remote(engine, base, "DROP TABLE IF EXISTS " + table);
      await remote(
        engine,
        base,
        "CREATE TABLE " +
          table +
          " (id int, amount decimal(38,0), at " +
          (engine === "postgres" ? "timestamptz" : "datetime") +
          ")",
      );
      await remote(
        engine,
        base,
        "INSERT INTO " +
          table +
          " VALUES " +
          Array.from(
            { length: 10 },
            (_, i) =>
              "(" +
              i +
              ", 10000000000000000000000000000000000000, '2025-01-0" +
              ((i % 9) + 1) +
              "')",
          ).join(", "),
      );
    });
    afterAll(async () => {
      await remote(engine, base, "DROP TABLE IF EXISTS " + table);
    });

    it("never connects with a password from outside the named variable", async () => {
      const { url: bare, password } = withoutPassword(engine, base);
      const ambient = engine === "postgres" ? "PGPASSWORD" : "MYSQL_PWD";
      const before = process.env[ambient];
      process.env[ambient] = password;
      try {
        const root = await mkdtemp(path.join(tmpdir(), "hm-db-adv-"));
        roots.push(root);
        const store = createDatabaseStore({ root, env: { DB: bare } });
        await expect(
          store.describe("s", { type: engine, env: "DB", table } as never),
        ).rejects.toMatchObject({ code: "HM2041" });
        await store.close();
      } finally {
        if (before === undefined) delete process.env[ambient];
        else process.env[ambient] = before;
      }
    });

    it("keeps no query text in the copy", async () => {
      const canary = "canary-" + engine + "-7f3a91";
      const root = await project(
        {
          s: {
            type: engine,
            env: "DB",
            query: "SELECT id, at FROM " + table + " /* " + canary + " */",
            freshness: { through: "as_of" },
          },
        },
        { n: metric({ type: "aggregate", table: "s", aggregate: "count", time: "at" }) },
        kpi("n"),
      );
      const built = await cliRun(root, ["build", "--json", "--out", path.join(root, "dist")], {
        DB: base,
      });
      expect(built.code, built.out).toBe(0);
      const dir = path.join(root, ".hatchmark", "cache", "v1", "s");
      const files = (await readdir(dir)).filter((f) => f.endsWith(".parquet"));
      expect(files).toHaveLength(1);
      const bytes = await readFile(path.join(dir, files[0] as string));
      expect(bytes.toString("latin1")).not.toContain(canary);
      const header = (
        await local(
          "SELECT decode(value) FROM parquet_kv_metadata(" +
            lit(path.join(dir, files[0] as string)) +
            ") WHERE decode(key) = 'hatchmark'",
        )
      )[0]?.[0];
      expect(Buffer.from(String(header), "base64").toString("utf8")).not.toContain(canary);
    });

    it("stops with a targeted error when an exact decimal sum passes 38 digits", async () => {
      const root = await project(
        { s: { type: engine, env: "DB", table, freshness: { through: "as_of" } } },
        {
          total: metric({
            type: "aggregate",
            table: "s",
            aggregate: "sum",
            column: "amount",
            time: "at",
          }),
        },
        kpi("total"),
      );
      const run = await dash(root, { DB: base });
      expect(run.data).toBeUndefined();
      const error = run.diagnostics.find((d: { severity: string }) => d.severity === "error");
      expect(error?.code).toBe("HM2015");
      expect(error?.help).toContain("38 digits");
    });

    it("validates a warm build against the copy it reuses", async () => {
      const warm = "adv_warm_" + engine;
      await remote(engine, base, "DROP TABLE IF EXISTS " + warm);
      await remote(
        engine,
        base,
        "CREATE TABLE " +
          warm +
          " (id int, amount decimal(10,2), at " +
          (engine === "postgres" ? "timestamptz" : "datetime") +
          ")",
      );
      await remote(
        engine,
        base,
        "INSERT INTO " + warm + " VALUES (1, 2.50, '2025-01-02'), (2, 4.25, '2025-01-03')",
      );
      const root = await project(
        {
          s: {
            type: engine,
            env: "DB",
            table: warm,
            max_age: { hours: 1 },
            freshness: { through: "as_of" },
          },
        },
        {
          total: metric({
            type: "aggregate",
            table: "s",
            aggregate: "sum",
            column: "amount",
            time: "at",
          }),
        },
        kpi("total"),
      );
      const out = path.join(root, "dist");
      expect((await cliRun(root, ["build", "--out", out], { DB: base })).code).toBe(0);
      await remote(engine, base, "ALTER TABLE " + warm + " RENAME COLUMN amount TO renamed");
      const renamed = await cliRun(root, ["build", "--json", "--out", out], { DB: base });
      expect(renamed.code, renamed.out).toBe(0);
      const { url: bare } = withoutPassword(engine, base);
      const wrong =
        engine === "postgres"
          ? bare.replace("@", ":wrong-password@")
          : bare + " password=wrong-password";
      const rejected = await cliRun(root, ["build", "--json", "--out", out], { DB: wrong });
      expect(rejected.code, rejected.out).toBe(0);
      await remote(engine, base, "DROP TABLE IF EXISTS " + warm);
    });
  });
}

describe.skipIf(PG === undefined)("postgres edge cases", () => {
  const base = PG as string;
  beforeAll(async () => {
    await remote("postgres", base, "DROP SCHEMA IF EXISTS adv_app CASCADE");
    await remote("postgres", base, "CREATE SCHEMA adv_app");
    await remote(
      "postgres",
      base,
      "CREATE TABLE adv_app.adv_local (id int, small numeric(3,5), at timestamptz)",
    );
    await remote(
      "postgres",
      base,
      "INSERT INTO adv_app.adv_local SELECT i, 0.00123, '2025-01-02' FROM generate_series(1, 10) i",
    );
    await remote("postgres", base, "DROP TABLE IF EXISTS adv_negative");
    await remote(
      "postgres",
      base,
      "CREATE TABLE adv_negative (id int, rounded numeric(5,-2), at timestamptz)",
    );
    await remote("postgres", base, "INSERT INTO adv_negative VALUES (1, 12345, '2025-01-02')");
  });
  afterAll(async () => {
    await remote("postgres", base, "DROP SCHEMA IF EXISTS adv_app CASCADE");
    await remote("postgres", base, "DROP TABLE IF EXISTS adv_negative");
  });

  it("finds an unqualified table on the connection's search path and sums a numeric whose scale passes its precision", async () => {
    const searchPath =
      base + (base.includes("?") ? "&" : "?") + "options=-csearch_path%3Dadv_app,public";
    const root = await project(
      { s: { type: "postgres", env: "DB", table: "adv_local", freshness: { through: "as_of" } } },
      {
        total: metric({
          type: "aggregate",
          table: "s",
          aggregate: "sum",
          column: "small",
          time: "at",
        }),
      },
      kpi("total"),
    );
    const run = await dash(root, { DB: searchPath });
    expect(
      await remote("postgres", base, "SELECT SUM(small)::text FROM adv_app.adv_local", true),
    ).toEqual([["0.01230"]]);
    expect(run.data?.blocks[0].value).toBe(0.0123);
  });

  it("refuses a numeric with a negative scale instead of misreading it", async () => {
    const root = await project(
      {
        s: { type: "postgres", env: "DB", table: "adv_negative", freshness: { through: "as_of" } },
      },
      {
        total: metric({
          type: "aggregate",
          table: "s",
          aggregate: "sum",
          column: "rounded",
          time: "at",
        }),
      },
      kpi("total"),
    );
    const { code, out } = await cliRun(root, ["check", "--json"], { DB: base });
    expect(code).not.toBe(0);
    expect(JSON.parse(out).diagnostics.map((d: { code: string }) => d.code)).toContain("HM2043");
  });

  it("checks a map over an unset database source with a warning only", async () => {
    const root = await project(
      { s: { type: "postgres", env: "DB", table: "adv_negative" } },
      { n: metric({ type: "aggregate", table: "s", aggregate: "count", time: "at" }) },
      {
        t: {
          title: "T",
          period: { asOf: "2025-02-01", range: "all_time", compare: "none" },
          blocks: [{ type: "map", id: "m", geo: "us-states", region: "region", value: "n" }],
        },
      },
    );
    const { code, out } = await cliRun(root, ["check", "--json"], {});
    const report = JSON.parse(out);
    expect(
      report.diagnostics.filter((d: { severity: string }) => d.severity === "error"),
      out,
    ).toEqual([]);
    expect(code).toBe(0);
  });
});
