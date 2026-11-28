import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { run as cli } from "../../src/cli/main.js";
import type { KpiData, LineData, TableData } from "../../src/compiler/dashboard-data.js";
import { runDashboard } from "../../src/compiler/index.js";
import {
  createDatabaseStore,
  createDuckDbExecutor,
  nodeProjectHost,
} from "../../src/node/index.js";
import { loadProject, PROJECT_DEFAULTS } from "../../src/spec/index.js";
import { toYaml } from "../yaml.js";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

type Engine = "postgres" | "mysql";

const URLS: Record<Engine, string | undefined> = {
  postgres: process.env.HM_TEST_POSTGRES_URL,
  mysql: process.env.HM_TEST_MYSQL_URL,
};

const roots: string[] = [];
afterAll(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Row {
  id: number;
  customer: string;
  region: string | null;
  amount: string;
  qty: string;
  price: string;
  at: string;
}

const START = Date.parse("2025-01-01T00:00:00Z");
const REGIONS = ["West", "East", "North", null];

function rows(count: number, seed: number): Row[] {
  const random = rng(seed);
  return Array.from({ length: count }, (_, i) => {
    const cents = Math.floor(random() * 1_000_000);
    return {
      id: i + 1,
      customer: "c" + String(Math.floor(random() * 137)),
      region: i % 11 === 0 ? null : (REGIONS[Math.floor(random() * 3)] ?? null),
      amount: String(Math.floor(cents / 100)) + "." + String(cents % 100).padStart(2, "0"),
      qty: i < 3 ? "4000000000000000000" : String(i),
      price: String(i) + "." + String(i % 10) + "000000001",
      at: new Date(START + Math.floor(random() * 400 * 86_400_000))
        .toISOString()
        .replace("T", " ")
        .slice(0, 19),
    };
  });
}

const literal = (value: string | null) =>
  value === null ? "NULL" : "'" + value.replaceAll("'", "''") + "'";

function createSql(engine: Engine, table: string): string {
  return engine === "postgres"
    ? "CREATE TABLE " +
        table +
        " (id integer, customer text, region text, amount numeric(12,2), qty bigint, price numeric, at timestamptz, local_at timestamp, span interval)"
    : "CREATE TABLE " +
        table +
        " (id int, customer varchar(20), region varchar(10), amount decimal(12,2), qty bigint, price decimal(50,10), at timestamp(6) NULL, local_at datetime(6), span blob)";
}

function insertSql(engine: Engine, table: string, batch: Row[]): string {
  const values = batch.map((r) =>
    [
      String(r.id),
      literal(r.customer),
      literal(r.region),
      r.amount,
      r.qty,
      r.price,
      engine === "postgres" ? literal(r.at + "+00") : literal(r.at),
      literal(r.at),
      engine === "postgres" ? "'1 day'" : "NULL",
    ].join(", "),
  );
  return "INSERT INTO " + table + " VALUES (" + values.join("), (") + ")";
}

class Remote {
  private constructor(
    private readonly engine: Engine,
    private readonly connection: Awaited<ReturnType<DuckDBInstance["connect"]>>,
  ) {}

  static async open(engine: Engine, url: string): Promise<Remote> {
    const instance = await DuckDBInstance.create(":memory:");
    const connection = await instance.connect();
    await connection.run("INSTALL " + engine);
    await connection.run("LOAD " + engine);
    if (engine === "mysql") await connection.run("SET mysql_session_time_zone = '+00:00'");
    await connection.run("ATTACH " + literal(url) + " AS remote (TYPE " + engine + ")");
    return new Remote(engine, connection);
  }

  async execute(sql: string): Promise<void> {
    await this.connection.run("CALL " + this.engine + "_execute('remote', " + literal(sql) + ")");
  }

  async query(sql: string): Promise<unknown[][]> {
    const reader = await this.connection.runAndReadAll(
      "SELECT * FROM " + this.engine + "_query('remote', " + literal(sql) + ")",
    );
    return reader.getRows();
  }

  close(): void {
    this.connection.closeSync();
  }
}

async function cliRun(root: string, args: string[], env: Record<string, string | undefined>) {
  let stdout = "";
  let stderr = "";
  const code = await cli([...args, "--cwd", root], {
    stdout: (t) => {
      stdout += t;
    },
    stderr: (t) => {
      stderr += t;
    },
    cwd: root,
    env,
    stdoutIsTTY: false,
    isAgent: async () => false,
  });
  return { code, stdout, stderr, all: stdout + stderr };
}

async function writeFiles(root: string, files: Record<string, unknown>): Promise<void> {
  for (const [file, content] of Object.entries(files)) {
    const target = path.join(root, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, typeof content === "string" ? content : toYaml(content));
  }
}

const metric = (body: Record<string, unknown>) => ({
  label: "Metric",
  format: { type: "number" },
  better: "up",
  ...body,
});

async function project(
  engine: Engine,
  source: Record<string, unknown>,
  metrics: Record<string, unknown>,
  dashboards: Record<string, unknown>,
  timezone = "America/New_York",
): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "hatchmark-db-"));
  roots.push(root);
  await writeFiles(root, {
    "hatchmark.yaml": {
      ...PROJECT_DEFAULTS,
      name: "Shop",
      timezone,
      sources: {
        sales: { type: engine, env: "HM_DB_URL", freshness: { through: "as_of" }, ...source },
      },
    },
    ...Object.fromEntries(Object.entries(metrics).map(([n, m]) => ["metrics/" + n + ".yaml", m])),
    ...Object.fromEntries(
      Object.entries(dashboards).map(([n, d]) => ["dashboards/" + n + ".yaml", d]),
    ),
  });
  return root;
}

async function dashboard(root: string, name: string, env: Record<string, string | undefined>) {
  const { project: loaded } = await loadProject(nodeProjectHost(root, env));
  const config = loaded?.config.spec;
  if (loaded === undefined || config === undefined) throw new Error("invalid project");
  const databases = createDatabaseStore({ root, env });
  const executor = await createDuckDbExecutor({ root, config, databases });
  try {
    return await runDashboard(loaded, name, executor);
  } finally {
    await executor.close();
    await databases.close();
  }
}

const ALL_TIME = { asOf: "2026-11-01", range: "all_time", compare: "none" };

const METRICS = {
  revenue: metric({
    type: "aggregate",
    table: "sales",
    aggregate: "sum",
    column: "amount",
    time: "at",
  }),
  orders: metric({ type: "aggregate", table: "sales", aggregate: "count", time: "at" }),
  avg_amount: metric({
    type: "aggregate",
    table: "sales",
    aggregate: "avg",
    column: "amount",
    time: "at",
  }),
  customers: metric({
    type: "aggregate",
    table: "sales",
    aggregate: "count_distinct",
    column: "customer",
    time: "at",
  }),
  units: metric({ type: "aggregate", table: "sales", aggregate: "sum", column: "qty", time: "at" }),
  west_east_big: metric({
    type: "aggregate",
    table: "sales",
    aggregate: "sum",
    column: "amount",
    time: "at",
    filters: [
      { column: "region", op: "in", values: ["West", "East"] },
      { column: "amount", op: "gt", value: 5000 },
    ],
  }),
};

const DASHBOARDS = {
  totals: {
    title: "Totals",
    period: ALL_TIME,
    blocks: [
      {
        type: "table",
        id: "by_region",
        by: ["region"],
        metrics: ["revenue", "orders", "avg_amount", "customers", "units"],
      },
      { type: "kpi", id: "filtered", metric: "west_east_big" },
      { type: "line", id: "monthly", metrics: ["orders"], grain: "month" },
    ],
  },
};

for (const engine of ["postgres", "mysql"] as const) {
  const url = URLS[engine];
  describe.skipIf(url === undefined)(engine + " sources", () => {
    const table = "hm_sales_" + String(process.pid) + "_" + engine;
    const data = rows(2400, engine === "postgres" ? 11 : 12);
    const env = { HM_DB_URL: url };
    let remote: Remote;

    beforeAll(async () => {
      remote = await Remote.open(engine, url as string);
      await remote.execute("DROP TABLE IF EXISTS " + table);
      await remote.execute(createSql(engine, table));
      for (let i = 0; i < data.length; i += 400) {
        await remote.execute(insertSql(engine, table, data.slice(i, i + 400)));
      }
    });

    afterAll(async () => {
      if (engine === "mysql") await remote?.execute("SET GLOBAL time_zone = '+00:00'");
      await remote?.execute("DROP TABLE IF EXISTS " + table);
      remote?.close();
    });

    it("matches the database's own GROUP BY ROLLUP, null group and filters included", async () => {
      const root = await project(engine, { table }, METRICS, DASHBOARDS);
      const { data: built, diagnostics } = await dashboard(root, "totals", env);
      expect(diagnostics.filter((d) => d.severity === "error")).toEqual([]);
      const text = engine === "postgres" ? "TEXT" : "CHAR";
      const oracle = await remote.query(
        "SELECT region, CAST(SUM(amount) AS " +
          text +
          "), COUNT(*), CAST(AVG(amount) AS " +
          text +
          "), COUNT(DISTINCT customer), CAST(SUM(qty) AS " +
          text +
          "), GROUPING(region) FROM " +
          table +
          " GROUP BY " +
          (engine === "postgres" ? "ROLLUP(region)" : "region WITH ROLLUP"),
      );
      const block = built?.blocks.find((b) => b.id === "by_region") as TableData;
      const expectRow = (values: Record<string, number | null>, o: unknown[]) => {
        expect(values.revenue).toBe(Number(o[1]));
        expect(values.orders).toBe(Number(o[2]));
        expect(values.avg_amount).toBeCloseTo(Number(o[1]) / Number(o[2]), 9);
        expect(values.customers).toBe(Number(o[4]));
        expect(values.units).toBe(Number(o[5]));
      };
      const groups = oracle.filter((o) => Number(o[6]) === 0);
      expect(block.rows.filter((r) => r.kind === undefined)).toHaveLength(groups.length);
      for (const o of groups) {
        const row = block.rows.find((r) => r.kind === undefined && r.keys[0] === (o[0] ?? null));
        expect(row, String(o[0])).toBeDefined();
        expectRow(row?.values as Record<string, number | null>, o);
      }
      const total = oracle.find((o) => Number(o[6]) === 1) as unknown[];
      expectRow(block.total?.values as Record<string, number | null>, total);
      const filtered = await remote.query(
        "SELECT CAST(SUM(amount) AS " +
          text +
          ") FROM " +
          table +
          " WHERE region IN ('West', 'East') AND amount > 5000",
      );
      expect((built?.blocks.find((b) => b.id === "filtered") as KpiData | undefined)?.value).toBe(
        Number(filtered[0]?.[0]),
      );
    });

    it("buckets instants by the project time zone, whatever the server's time zone", async () => {
      if (engine === "mysql") await remote.execute("SET GLOBAL time_zone = '+09:00'");
      const root = await project(engine, { table }, METRICS, DASHBOARDS);
      const { data: built } = await dashboard(root, "totals", env);
      const expected = new Map<string, number>();
      for (const r of data) {
        const local = new Intl.DateTimeFormat("en-CA", {
          timeZone: "America/New_York",
          year: "numeric",
          month: "2-digit",
        }).format(new Date(r.at.replace(" ", "T") + "Z"));
        const month = local.slice(0, 7) + "-01";
        expected.set(month, (expected.get(month) ?? 0) + 1);
      }
      const line = built?.blocks.find((b) => b.id === "monthly") as LineData;
      const got = new Map<string, number>();
      line.axis.buckets.forEach((bucket, i) => {
        const value = line.series[0]?.values[i];
        if (typeof value === "number" && value !== 0) got.set(bucket, value);
      });
      expect(Object.fromEntries(got)).toEqual(Object.fromEntries(expected));
      if (engine === "mysql") await remote.execute("SET GLOBAL time_zone = '+00:00'");
    });

    it("sums an empty table to 0 and reads a query source", async () => {
      const empty = table + "_empty";
      await remote.execute("DROP TABLE IF EXISTS " + empty);
      await remote.execute(createSql(engine, empty));
      const root = await project(engine, { table: empty }, METRICS, {
        d: {
          title: "D",
          period: { asOf: "2026-01-31", range: "all_time", compare: "none" },
          blocks: [{ type: "kpi", id: "r", metric: "revenue" }],
        },
      });
      const { data: built } = await dashboard(root, "d", env);
      expect((built?.blocks[0] as KpiData | undefined)?.value).toBe(0);
      await remote.execute("DROP TABLE " + empty);

      const query =
        "SELECT id, region, amount * 2 AS amount, at FROM " + table + " WHERE region = 'West'";
      const queried = await project(
        engine,
        { query },
        { revenue: METRICS.revenue },
        {
          d: {
            title: "D",
            period: ALL_TIME,
            blocks: [{ type: "kpi", id: "r", metric: "revenue" }],
          },
        },
      );
      const result = await dashboard(queried, "d", env);
      const oracle = await remote.query(
        "SELECT CAST(SUM(amount * 2) AS " +
          (engine === "postgres" ? "TEXT" : "CHAR") +
          ") FROM " +
          table +
          " WHERE region = 'West'",
      );
      expect((result.data?.blocks[0] as KpiData | undefined)?.value).toBe(Number(oracle[0]?.[0]));
    });

    it("check reports unknown tables, columns, unreadable types and float decimals", async () => {
      const missing = await project(
        engine,
        { table: "no_such_table" },
        { revenue: METRICS.revenue },
        {},
      );
      const a = await cliRun(missing, ["check", "--json"], env);
      expect(JSON.parse(a.stdout).diagnostics.map((d: { code: string }) => d.code)).toContain(
        "HM2042",
      );

      const root = await project(
        engine,
        { table },
        {
          wrong: metric({
            type: "aggregate",
            table: "sales",
            aggregate: "sum",
            column: "amout",
            time: "at",
          }),
          spans: metric({
            type: "aggregate",
            table: "sales",
            aggregate: "sum",
            column: "span",
            time: "at",
          }),
          text_sum: metric({
            type: "aggregate",
            table: "sales",
            aggregate: "sum",
            column: "region",
            time: "at",
          }),
          prices: metric({
            type: "aggregate",
            table: "sales",
            aggregate: "sum",
            column: "price",
            time: "at",
          }),
          by_id: metric({ type: "aggregate", table: "sales", aggregate: "count", time: "id" }),
        },
        {},
      );
      const b = await cliRun(root, ["check", "--json"], env);
      const found = JSON.parse(b.stdout).diagnostics.map(
        (d: { code: string; file?: string }) => d.code + " " + d.file,
      );
      expect(found).toContain("HM2018 metrics/wrong.yaml");
      expect(found).toContain("HM2043 metrics/spans.yaml");
      expect(found).toContain("HM2043 metrics/text_sum.yaml");
      expect(found).toContain("HM4080 metrics/prices.yaml");
      expect(found).toContain("HM2043 metrics/by_id.yaml");
    });

    it("needs the variable to build, and checks against the last copy without it", async () => {
      const root = await project(engine, { table }, METRICS, DASHBOARDS);
      const unset = await cliRun(root, ["check", "--json"], {});
      const before = JSON.parse(unset.stdout);
      expect(unset.code).toBe(0);
      expect(before.diagnostics).toContainEqual(
        expect.objectContaining({ code: "HM2040", severity: "warning" }),
      );
      const failed = await cliRun(root, ["build", "--json"], {});
      expect(failed.code).toBe(3);
      expect(JSON.parse(failed.stdout).diagnostics).toContainEqual(
        expect.objectContaining({ code: "HM2040", severity: "error" }),
      );

      expect((await cliRun(root, ["build", "--json"], env)).code).toBe(0);
      await writeFiles(root, {
        "metrics/typo.yaml": metric({
          type: "aggregate",
          table: "sales",
          aggregate: "sum",
          column: "amout",
          time: "at",
        }),
      });
      const offline = JSON.parse((await cliRun(root, ["check", "--json"], {})).stdout);
      expect(offline.diagnostics).toContainEqual(
        expect.objectContaining({ code: "HM2040", severity: "note" }),
      );
      expect(offline.diagnostics).toContainEqual(
        expect.objectContaining({ code: "HM2018", file: "metrics/typo.yaml" }),
      );
    });

    it("reuses a copy younger than max_age, byte for byte, and refetches without it", async () => {
      const root = await project(engine, { table, max_age: { hours: 1 } }, METRICS, DASHBOARDS);
      const first = await cliRun(root, ["build", "--json"], env);
      expect(first.code).toBe(0);
      const dir = path.join(root, ".hatchmark", "cache", "v1", "s");
      const [copy] = await readdir(dir);
      const stamp = (await stat(path.join(dir, copy as string))).mtimeMs;
      const html = await readFile(path.join(root, "dist", "totals", "index.html"), "utf8");
      const second = JSON.parse((await cliRun(root, ["build", "--json"], env)).stdout);
      expect(second.cache.misses).toBe(0);
      expect((await stat(path.join(dir, copy as string))).mtimeMs).toBe(stamp);
      expect(await readFile(path.join(root, "dist", "totals", "index.html"), "utf8")).toBe(html);

      const explained = await cliRun(
        root,
        ["explain", "--dashboard", "totals", "--block", "by_region", "--format", "human"],
        env,
      );
      expect(explained.stdout).toMatch(/rows of database source "sales" fetched 20/);

      const fresh = await project(engine, { table }, METRICS, DASHBOARDS);
      await cliRun(fresh, ["build", "--json"], env);
      const extra = rows(1, 99)[0] as Row;
      await remote.execute(
        insertSql(engine, table, [{ ...extra, id: 999_999, region: "West", amount: "1.00" }]),
      );
      const after = await dashboard(fresh, "totals", env);
      const block = after.data?.blocks.find((b) => b.id === "by_region") as TableData;
      expect(block.total?.values.orders).toBe(data.length + 1);
      await remote.execute("DELETE FROM " + table + " WHERE id = 999999");
    });

    it("never prints or stores a password", async () => {
      const secret = "Pw-" + String(process.pid) + "-x9";
      const wrong =
        engine === "postgres"
          ? (url as string).replace(/:[^:@/]*@/, ":" + secret + "@")
          : (url as string).replace(/password=[^ ]*/, "password=" + secret);
      const closed =
        engine === "postgres"
          ? "postgresql://reader:" + secret + "@127.0.0.1:1/shop"
          : "host=127.0.0.1 port=1 user=reader password=" + secret + " database=shop";
      for (const connection of [wrong, closed]) {
        const root = await project(engine, { table }, METRICS, DASHBOARDS);
        for (const args of [
          ["check", "--json"],
          ["check"],
          ["build", "--json"],
          ["explain", "revenue", "--json"],
        ]) {
          const out = await cliRun(root, args, { HM_DB_URL: connection });
          expect(out.all).toContain("HM2041");
          expect(out.all).not.toContain(secret);
          expect(out.all).not.toContain(connection);
        }
      }
      const root = await project(engine, { table, max_age: { hours: 1 } }, METRICS, DASHBOARDS);
      await cliRun(root, ["build", "--json"], env);
      const password =
        engine === "postgres"
          ? new URL(url as string).password
          : (/password=([^ ]*)/.exec(url as string)?.[1] ?? "");
      const dir = path.join(root, ".hatchmark", "cache", "v1", "s");
      for (const file of await readdir(dir)) {
        expect(file).not.toContain(password);
        expect((await readFile(path.join(dir, file))).includes(Buffer.from(url as string))).toBe(
          false,
        );
      }
    });
  });
}
