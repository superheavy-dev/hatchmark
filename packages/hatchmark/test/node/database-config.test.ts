import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { run as cli } from "../../src/cli/main.js";
import { redact } from "../../src/node/index.js";
import { checkReferences, PROJECT_DEFAULTS } from "../../src/spec/index.js";
import { projectFrom } from "../spec/helpers.js";
import { toYaml } from "../yaml.js";

const roots: string[] = [];
afterAll(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const metric = (body: Record<string, unknown>) => ({
  label: "Metric",
  format: { type: "number" },
  better: "up",
  type: "aggregate",
  table: "orders",
  time: "ordered_at",
  ...body,
});

async function project(source: Record<string, unknown>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "hatchmark-db-unit-"));
  roots.push(root);
  const files: Record<string, unknown> = {
    "hatchmark.yaml": { ...PROJECT_DEFAULTS, name: "Shop", sources: { orders: source } },
    "metrics/revenue.yaml": metric({ aggregate: "sum", column: "amount" }),
    "dashboards/sales.yaml": {
      title: "Sales",
      period: { asOf: "2026-01-31", range: "all_time", compare: "none" },
      blocks: [{ type: "kpi", id: "revenue", metric: "revenue" }],
    },
  };
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), toYaml(content));
  }
  return root;
}

async function cliJson(root: string, args: string[], env: Record<string, string> = {}) {
  let stdout = "";
  const code = await cli([...args, "--json", "--cwd", root], {
    stdout: (t) => {
      stdout += t;
    },
    stderr: () => {},
    cwd: root,
    env,
    stdoutIsTTY: false,
    isAgent: async () => false,
  });
  return {
    code,
    stdout,
    report: JSON.parse(stdout) as {
      diagnostics: { code: string; severity: string; pointer?: string; message: string }[];
    },
  };
}

describe("redact", () => {
  it("removes the connection string and every password form from a message", () => {
    const cases: [string, string, string[]][] = [
      [
        "postgresql://reader:s3cr3t@db.example.com:5432/shop",
        "s3cr3t",
        ["reader", "db.example.com"],
      ],
      ["postgresql://reader:p%40ss%3Aword@db.example.com/shop", "p@ss:word", ["db.example.com"]],
      [
        "postgresql://db.example.com/shop?user=reader&password=hunter22",
        "hunter22",
        ["db.example.com"],
      ],
      [
        "host=db.example.com user=reader password=hunter22 database=shop",
        "hunter22",
        ["db.example.com"],
      ],
      ["host=db port=3306 password='two words' database=shop", "two words", ["db"]],
    ];
    for (const [connection, password, kept] of cases) {
      const message =
        'IO Error: Unable to connect at "' +
        connection +
        '": password ' +
        password +
        " was refused; retry " +
        connection;
      const out = redact(message, connection);
      expect(out, connection).not.toContain(password);
      expect(out, connection).not.toContain(connection);
      expect(out).toContain("***");
      for (const k of kept) expect(redact("server " + k, connection)).toContain(k);
    }
  });

  it("masks URL and keyword passwords even from another connection string", () => {
    const out = redact(
      "tried postgresql://admin:other-pw@10.0.0.1/db and password=other-pw2 too",
      "postgresql://reader:mine@db/shop",
    );
    expect(out).not.toContain("other-pw");
    expect(out).toBe("tried postgresql://admin:***@10.0.0.1/db and password=*** too");
  });
});

describe("database source config", () => {
  it("takes an environment variable name, never a connection string", async () => {
    const root = await project({
      type: "postgres",
      env: "postgresql://reader:s3cr3t@db.example.com/shop",
      table: "orders",
    });
    const { code, stdout, report } = await cliJson(root, ["check"]);
    expect(code).toBe(2);
    expect(report.diagnostics[0]?.pointer).toBe("/sources/orders/env");
    expect(report.diagnostics[0]?.message).toMatch(/name of an environment variable/);
    expect(stdout).not.toContain("s3cr3t");
  });

  it("needs exactly one of table and query, and a plain table name", async () => {
    const both = await cliJson(
      await project({ type: "mysql", env: "SHOP_URL", table: "orders", query: "SELECT 1" }),
      ["check"],
    );
    expect(both.report.diagnostics.map((d) => d.code)).toContain("HM3007");
    const neither = await cliJson(await project({ type: "mysql", env: "SHOP_URL" }), ["check"]);
    expect(neither.report.diagnostics.map((d) => d.code)).toContain("HM3001");
    for (const table of ["a.b.c", "o'rders", 'public."orders"', "my orders"]) {
      const bad = await cliJson(await project({ type: "postgres", env: "SHOP_URL", table }), [
        "check",
      ]);
      expect(bad.report.diagnostics[0]?.pointer, table).toBe("/sources/orders/table");
    }
  });

  it("warns in check and fails build when the variable is not set", async () => {
    const root = await project({ type: "postgres", env: "SHOP_URL", table: "public.orders" });
    const checked = await cliJson(root, ["check"]);
    expect(checked.code).toBe(0);
    expect(checked.report.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "HM2040",
        severity: "warning",
        pointer: "/sources/orders/env",
      }),
    );
    expect((await cliJson(root, ["check", "--strict"])).code).toBe(1);
    const built = await cliJson(root, ["build"]);
    expect(built.code).toBe(3);
    expect(built.report.diagnostics).toContainEqual(
      expect.objectContaining({ code: "HM2040", severity: "error" }),
    );
    const explained = await cliJson(root, ["explain", "revenue"]);
    expect(explained.report.diagnostics.map((d) => d.code)).toContain("HM2040");
  });
});

describe("database column types", () => {
  const config = {
    ...PROJECT_DEFAULTS,
    name: "Shop",
    sources: { orders: { type: "postgres", env: "SHOP_URL", table: "orders" } },
  };
  const columns = [
    { name: "ordered_at", type: "TIMESTAMP WITH TIME ZONE" },
    { name: "amount", type: "DECIMAL(12,2)" },
    { name: "price", type: "DOUBLE" },
    { name: "region", type: "VARCHAR" },
    { name: "wait", type: "INTERVAL" },
    { name: "tags", type: "VARCHAR[]" },
    { name: "day_number", type: "INTEGER" },
  ];
  const check = (metrics: Record<string, unknown>) =>
    checkReferences(
      projectFrom({
        config,
        metrics,
        columns: { orders: columns.map((c) => c.name) },
        columnTypes: { orders: columns },
        databases: { orders: { columns, decimals: ["price"], origin: "database" } },
      }),
    ).map((d) => d.code + " " + d.file + " " + d.pointer + " " + d.severity);

  it("rejects types a metric cannot use and warns about decimals read as floats", () => {
    const found = check({
      revenue: metric({ aggregate: "sum", column: "amount" }),
      prices: metric({ aggregate: "avg", column: "price" }),
      price_count: metric({ aggregate: "count", column: "price" }),
      text_sum: metric({ aggregate: "sum", column: "region" }),
      waits: metric({ aggregate: "max", column: "wait" }),
      tagged: metric({ aggregate: "count", filters: [{ column: "tags", op: "eq", value: "a" }] }),
      by_day: metric({ aggregate: "count", time: "day_number" }),
      regions: metric({ aggregate: "count_distinct", column: "region" }),
    });
    expect(found).toContain("HM4080 metrics/prices.yaml /column warning");
    expect(found).toContain("HM2043 metrics/text_sum.yaml /column error");
    expect(found).toContain("HM2043 metrics/waits.yaml /column error");
    expect(found).toContain("HM2043 metrics/tagged.yaml /filters/0/column error");
    expect(found).toContain("HM2043 metrics/by_day.yaml /time error");
    for (const ok of ["revenue", "price_count", "regions"]) {
      expect(
        found.filter((f) => f.includes("metrics/" + ok + ".yaml") && /HM2043|HM4080/.test(f)),
      ).toEqual([]);
    }
  });
});
