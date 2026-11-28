import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { run } from "../../src/cli/main.js";

let root = "";
let project = "";

async function cli(argv: string[], cwd = project) {
  let stdout = "";
  const code = await run(argv, {
    stdout: (t) => {
      stdout += t;
    },
    stderr: () => {},
    cwd,
    env: {},
    stdoutIsTTY: false,
    isAgent: async () => false,
  });
  return { code, stdout, json: () => JSON.parse(stdout) };
}

function parseCsv(text: string): Record<string, string>[] {
  const [head = "", ...lines] = text.trim().split("\n");
  const names = head.split(",");
  return lines.map((line) => {
    const cells: string[] = [];
    let cell = "";
    let quoted = false;
    for (const ch of line) {
      if (ch === '"') quoted = !quoted;
      else if (ch === "," && !quoted) {
        cells.push(cell);
        cell = "";
      } else cell += ch;
    }
    cells.push(cell);
    return Object.fromEntries(names.map((n, i) => [n, cells[i] ?? ""]));
  });
}

async function withProject(fn: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(path.join(tmpdir(), "hatchmark-data-"));
  try {
    expect((await cli(["init", "p"], dir)).code).toBe(0);
    await fn(path.join(dir, "p"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "hatchmark-data-"));
  expect((await cli(["init", "shop"], root)).code).toBe(0);
  project = path.join(root, "shop");
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("hatchmark data describe", () => {
  it("matches counts, nulls, distincts and ranges computed from the CSV", async () => {
    const rows = parseCsv(await readFile(path.join(project, "data/orders.csv"), "utf8"));
    const result = await cli(["data", "describe", "orders"]);
    expect(result.code).toBe(0);
    const out = result.json();
    expect(out).toMatchObject({ format_version: "1", source: "orders", type: "csv" });
    expect(out.row_count).toBe(rows.length);
    const byName = new Map<string, Record<string, unknown>>(
      out.columns.map((c: Record<string, unknown>) => [c.name, c]),
    );
    expect([...byName.keys()]).toEqual(Object.keys(rows[0] ?? {}));
    for (const [name, column] of byName) {
      const values = rows.map((r) => r[name] ?? "");
      expect(column.nulls, name).toBe(values.filter((v) => v === "").length);
      expect(column.distinct, name).toBe(new Set(values.filter((v) => v !== "")).size);
    }
    const dates = rows.map((r) => r.ordered_at ?? "").sort();
    expect(byName.get("ordered_at")).toMatchObject({
      type: "DATE",
      kind: "time",
      min: dates[0],
      max: dates.at(-1),
    });
    const amounts = rows.map((r) => Number(r.amount));
    expect(byName.get("amount")).toMatchObject({
      kind: "number",
      min: Math.min(...amounts),
      max: Math.max(...amounts),
    });
    expect(byName.get("region")).not.toHaveProperty("min");
    expect(out.sample.rows).toHaveLength(5);
    expect(out.sample.rows[0][0]).toBe(rows[0]?.order_id);
  });

  it("counts nulls and reads timestamps in UTC", async () => {
    await withProject(async (p) => {
      await writeFile(
        path.join(p, "data/orders.csv"),
        "order_id,ordered_at,amount\nA,2026-01-01T23:30:00-05:00,1\nB,,\nC,2026-01-03T00:00:00Z,3\n",
      );
      const out = (await cli(["data", "describe", "orders"], p)).json();
      expect(out.row_count).toBe(3);
      const [, at, amount] = out.columns;
      expect(at).toMatchObject({ kind: "time", nulls: 1, distinct: 2 });
      expect(at.min).toMatch(/^2026-01-02 04:30:00/);
      expect(amount).toMatchObject({ nulls: 1, min: 1, max: 3 });
      expect(out.sample.rows[1]).toEqual(["B", null, null]);
    });
  });

  it("takes --limit for sample rows, 0 included", async () => {
    expect((await cli(["data", "describe", "orders", "--limit", "0"])).json().sample.rows).toEqual(
      [],
    );
    expect(
      (await cli(["data", "describe", "orders", "--limit", "12"])).json().sample.rows,
    ).toHaveLength(12);
  });

  it("rejects an unknown source with the valid names", async () => {
    const result = await cli(["data", "describe", "order"]);
    expect(result.code).toBe(2);
    expect(result.json().diagnostics[0]).toMatchObject({
      code: "HM0002",
      expected: ["orders"],
      help: 'did you mean "orders"?',
    });
  });
});

describe("hatchmark data query", () => {
  it("returns the same counts as the CSV", async () => {
    const rows = parseCsv(await readFile(path.join(project, "data/orders.csv"), "utf8"));
    const expected = new Map<string, number>();
    for (const r of rows) expected.set(r.region ?? "", (expected.get(r.region ?? "") ?? 0) + 1);
    const result = await cli([
      "data",
      "query",
      "SELECT region, count(*) AS n FROM Orders GROUP BY region ORDER BY region",
    ]);
    expect(result.code).toBe(0);
    const out = result.json();
    expect(out.sources).toEqual(["orders"]);
    expect(out.columns).toEqual([
      { name: "region", type: "VARCHAR" },
      { name: "n", type: "BIGINT" },
    ]);
    expect(out.rows).toEqual([...expected].sort(([a], [b]) => (a < b ? -1 : 1)));
    expect(out.truncated).toBe(false);
  });

  it("stops at --limit and says whether rows were left out", async () => {
    const out = (await cli(["data", "query", "SELECT * FROM orders", "--limit", "3"])).json();
    expect(out.rows).toHaveLength(3);
    expect(out.truncated).toBe(true);
    const exact = (
      await cli(["data", "query", "SELECT 1 UNION ALL SELECT 2", "--limit", "2"])
    ).json();
    expect(exact.truncated).toBe(false);
  });

  it("keeps integers past 2^53 as strings and decimals as numbers", async () => {
    const sql =
      "SELECT 9007199254740993::BIGINT AS big, 7::BIGINT AS small, 1.50::DECIMAL(10,2) AS d";
    expect((await cli(["data", "query", sql])).json().rows).toEqual([["9007199254740993", 7, 1.5]]);
  });

  it.each([
    ["CREATE TABLE t AS SELECT 1", "not a SELECT"],
    ["SELECT 1; SELECT 2", "2 statements"],
    [" ; ", "empty"],
    ["COPY orders TO 'out.csv'", "outside the project's sources"],
    ["SELECT * FROM read_csv('data/orders.csv')", "outside the project's sources"],
    ["ATTACH 'x.db'", "not a SELECT"],
    ["SET enable_external_access = true", "not a SELECT"],
  ])("refuses %s with HM0008", async (sql, message) => {
    const result = await cli(["data", "query", sql]);
    expect(result.code).toBe(2);
    expect(result.json().diagnostics[0].code).toBe("HM0008");
    expect(result.json().diagnostics[0].message).toContain(message);
  });

  it("writes nothing into the project", async () => {
    await cli(["data", "query", "COPY orders TO 'leak.csv'"]);
    await cli(["data", "query", "COPY orders TO '" + path.join(project, "leak.csv") + "'"]);
    await expect(readFile(path.join(project, "leak.csv"))).rejects.toThrow();
  });

  it("reports DuckDB errors as HM0009, with the source names for an unknown table", async () => {
    const result = await cli(["data", "query", "SELECT * FROM customers"]);
    expect(result.code).toBe(2);
    expect(result.json().diagnostics[0]).toMatchObject({ code: "HM0009", expected: ["orders"] });
    expect((await cli(["data", "query", "SELEC 1"])).json().diagnostics[0].code).toBe("HM0009");
  });
});

describe("hatchmark data errors", () => {
  it("reports a missing data file as HM2010 and exits 3", async () => {
    await withProject(async (p) => {
      await rm(path.join(p, "data/orders.csv"));
      const result = await cli(["data", "describe", "orders"], p);
      expect(result.code).toBe(3);
      expect(result.json().diagnostics[0].code).toBe("HM2010");
      expect((await cli(["data", "query", "SELECT 42"], p)).json().rows).toEqual([[42]]);
    });
  });

  it("reports a file DuckDB cannot read as HM2015", async () => {
    await withProject(async (p) => {
      const config = await readFile(path.join(p, "hatchmark.yaml"), "utf8");
      await writeFile(path.join(p, "hatchmark.yaml"), config.replace("type: csv", "type: parquet"));
      const result = await cli(["data", "describe", "orders"], p);
      expect(result.json().diagnostics[0].code).toBe("HM2015");
      expect(result.code).toBe(1);
    });
  });

  it("checks subcommands, arguments and --limit", async () => {
    expect((await cli(["data"])).json().diagnostics[0].code).toBe("HM0003");
    expect((await cli(["data", "describ", "orders"])).json().diagnostics[0]).toMatchObject({
      code: "HM0002",
      help: 'did you mean "describe"?',
    });
    expect((await cli(["data", "query"])).json().diagnostics[0].code).toBe("HM0003");
    expect((await cli(["data", "query", "SELECT", "1"])).json().diagnostics[0].code).toBe("HM0002");
    for (const limit of ["0", "-1", "1.5", "10001", "x"]) {
      const result = await cli(["data", "query", "SELECT 1", "--limit", limit]);
      expect(result.json().diagnostics[0].code, limit).toBe("HM0002");
    }
  });
});
