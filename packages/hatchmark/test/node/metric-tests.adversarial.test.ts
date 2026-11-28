import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { run as cli } from "../../src/cli/main.js";
import { PROJECT_DEFAULTS } from "../../src/spec/index.js";
import { metric, Oracle, removeProjects, writeProject } from "./fixture.js";

const FULL = process.env.HM_SWEEP === "full";
const WINDOWS = FULL ? 200 : 12;

function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}
const DAY = 86_400_000;
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
const addDays = (d: string, n: number) => iso(Date.parse(`${d}T00:00:00Z`) + n * DAY);
const FIRST = "2025-11-01";
const LAST = "2026-10-31";
const REGIONS = ["West", "South", "Northeast", "Midwest", ""];

function ordersCsv(seed: number, rows: number): string {
  const r = rng(seed);
  const lines = ["id,ordered_at,region,status,amount"];
  for (let i = 0; i < rows; i++) {
    const day = i === 0 ? FIRST : i === rows - 1 ? LAST : addDays(FIRST, Math.floor(r() * 365));
    const region = REGIONS[Math.floor(r() * REGIONS.length)];
    const status = r() < 0.8 ? "paid" : "refunded";
    const amount = (Math.floor(r() * 100_000) / 100).toFixed(2);
    lines.push(`o${i},${day},${region},${status},${amount}`);
  }
  return `${lines.join("\n")}\n`;
}

function snapshotsCsv(seed: number): string {
  const r = rng(seed);
  const lines = ["account,as_of,plan,mrr"];
  for (let day = FIRST; day <= LAST; day = addDays(day, 1 + Math.floor(r() * 9))) {
    for (let a = 0; a < 12; a++) {
      if (r() < 0.3) continue;
      lines.push(
        `a${a},${day},${r() < 0.5 ? "pro" : "free"},${(Math.floor(r() * 50_000) / 100).toFixed(2)}`,
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

const CONFIG = {
  ...PROJECT_DEFAULTS,
  name: "tests",
  timezone: "UTC",
  sources: {
    orders: {
      type: "csv",
      path: "data/orders.csv",
      tests: [] as unknown[],
    },
    accounts: { type: "csv", path: "data/accounts.csv", snapshot: "as_of" },
  },
};

const METRICS = {
  revenue: metric({
    type: "aggregate",
    table: "orders",
    aggregate: "sum",
    column: "amount",
    filters: [{ column: "status", op: "eq", value: "paid" }],
    time: "ordered_at",
  }),
  orders: metric({ type: "aggregate", table: "orders", aggregate: "count", time: "ordered_at" }),
  aov: metric({ type: "ratio", numerator: "revenue", denominator: "orders" }),
  mrr: metric({
    type: "aggregate",
    table: "accounts",
    aggregate: "sum",
    column: "mrr",
    time: "as_of",
    over_time: "last",
  }),
};

let oracle: Oracle;
let files: Record<string, unknown>;

beforeAll(async () => {
  oracle = await Oracle.open();
  files = {
    "data/orders.csv": ordersCsv(7, 600),
    "data/accounts.csv": snapshotsCsv(11),
    "tests/small.csv":
      "id,ordered_at,region,status,amount\na,2026-03-02,West,paid,10.25\nb,2026-03-03,,paid,4.75\nc,2026-03-03,West,refunded,99\n",
    "segments/west.yaml": {
      label: "West",
      filters: [{ column: "region", op: "eq", value: "West" }],
    },
  };
  const { root } = await writeProject({ ...files, "hatchmark.yaml": CONFIG });
  await oracle.run(
    `CREATE TABLE orders AS SELECT * FROM read_csv('${root}/data/orders.csv', sample_size = -1)`,
  );
  await oracle.run(
    `CREATE TABLE accounts AS SELECT * FROM read_csv('${root}/data/accounts.csv', sample_size = -1)`,
  );
  await oracle.run(
    `CREATE TABLE small AS SELECT * FROM read_csv('${root}/tests/small.csv', sample_size = -1)`,
  );
});

afterAll(async () => {
  oracle.close();
  await removeProjects();
});

async function value(sql: string): Promise<number> {
  const [row] = await oracle.rows(sql);
  return Number(Object.values(row ?? {})[0] ?? 0);
}

async function runTests(
  metrics: Record<string, Record<string, unknown>>,
  sourceTests: unknown[] = [],
) {
  const { root } = await writeProject({
    ...files,
    "hatchmark.yaml": {
      ...CONFIG,
      sources: { ...CONFIG.sources, orders: { ...CONFIG.sources.orders, tests: sourceTests } },
    },
    ...Object.fromEntries(
      Object.entries(metrics).map(([name, spec]) => [`metrics/${name}.yaml`, spec]),
    ),
  });
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
  return { code, out: JSON.parse(stdout) };
}

const where = (column: string, op: string, values: unknown) => ({
  column,
  op,
  ...(Array.isArray(values) ? { values } : { value: values }),
});

describe("hatchmark test against an independent SQL oracle", () => {
  it("pins flow sums, filters, ratios, segments and breakdowns over random windows", async () => {
    const r = rng(3);
    const revenueTests: Record<string, unknown>[] = [];
    const aovTests: Record<string, unknown>[] = [];
    for (let i = 0; i < WINDOWS; i++) {
      const a = addDays(FIRST, Math.floor(r() * 380) - 10);
      const b = addDays(a, Math.floor(r() * 90));
      const end = b > LAST ? LAST : b;
      const start = a < FIRST && i % 2 === 0 ? FIRST : a;
      if (start > end) continue;
      const span = `ordered_at BETWEEN DATE '${start}' AND DATE '${end}'`;
      revenueTests.push({
        window: [start, end],
        expect: await value(
          `SELECT coalesce(sum(amount), 0) FROM orders WHERE status = 'paid' AND ${span}`,
        ),
      });
      revenueTests.push({
        window: [start, end],
        where: [where("region", "in", ["West", "South"])],
        expect: await value(
          `SELECT coalesce(sum(amount), 0) FROM orders WHERE status = 'paid' AND region IN ('West', 'South') AND ${span}`,
        ),
      });
      revenueTests.push({
        window: [start, end],
        segments: ["west"],
        expect: await value(
          `SELECT coalesce(sum(amount), 0) FROM orders WHERE status = 'paid' AND region = 'West' AND ${span}`,
        ),
      });
      const groups = await oracle.rows(
        `SELECT coalesce(region, '(empty)') AS k, sum(amount) AS v FROM orders WHERE status = 'paid' AND ${span} GROUP BY 1`,
      );
      if (groups.length > 0) {
        revenueTests.push({
          window: [start, end],
          by: "region",
          expect: Object.fromEntries(groups.map((g) => [String(g.k), Number(g.v)])),
        });
      }
      const n = await value(`SELECT count(*) FROM orders WHERE region = 'West' AND ${span}`);
      if (n > 0) {
        aovTests.push({
          window: [start, end],
          where: [where("region", "eq", "West")],
          expect: await value(
            `SELECT coalesce(sum(amount) FILTER (WHERE status = 'paid'), 0) / count(*) FROM orders WHERE region = 'West' AND ${span}`,
          ),
        });
      }
    }
    const { code, out } = await runTests({
      ...METRICS,
      revenue: { ...METRICS.revenue, tests: revenueTests },
      aov: { ...METRICS.aov, tests: aovTests },
    });
    const failing = out.results.filter((t: { status: string }) => t.status !== "pass");
    expect(failing).toEqual([]);
    expect(code).toBe(0);
    expect(out.passed).toBe(revenueTests.length + aovTests.length);
  });

  it("reads a snapshot metric at the last snapshot on or before at, chosen before filters", async () => {
    const r = rng(5);
    const tests: Record<string, unknown>[] = [];
    const dates = [FIRST, LAST, addDays(FIRST, 1)];
    for (let i = 0; i < WINDOWS; i++) dates.push(addDays(FIRST, Math.floor(r() * 365)));
    for (const at of dates) {
      const snap = `(SELECT max(as_of) FROM accounts WHERE as_of <= DATE '${at}')`;
      tests.push({
        at,
        expect: await value(`SELECT coalesce(sum(mrr), 0) FROM accounts WHERE as_of = ${snap}`),
      });
      tests.push({
        at,
        where: [where("plan", "eq", "pro")],
        expect: await value(
          `SELECT coalesce(sum(mrr), 0) FROM accounts WHERE plan = 'pro' AND as_of = ${snap}`,
        ),
      });
      const groups = await oracle.rows(
        `SELECT plan AS k, sum(mrr) AS v FROM accounts WHERE as_of = ${snap} GROUP BY 1`,
      );
      tests.push({
        at,
        by: "plan",
        expect: Object.fromEntries(groups.map((g) => [String(g.k), Number(g.v)])),
      });
    }
    const { out } = await runTests({ ...METRICS, mrr: { ...METRICS.mrr, tests } });
    const failing = out.results.filter((t: { status: string }) => t.status !== "pass");
    expect(failing).toEqual([]);
    expect(out.passed).toBe(tests.length);
  });

  it("swaps a source for a fixture file", async () => {
    const expected = await value("SELECT sum(amount) FROM small WHERE status = 'paid'");
    const { out } = await runTests({
      ...METRICS,
      revenue: {
        ...METRICS.revenue,
        tests: [
          {
            window: ["2026-03-01", "2026-03-31"],
            data: { orders: "tests/small.csv" },
            expect: expected,
          },
          {
            window: ["2026-03-01", "2026-03-31"],
            data: { orders: "tests/small.csv" },
            by: "region",
            expect: { West: 10.25, "(empty)": 4.75 },
          },
        ],
      },
    });
    expect(out.results.map((t: { status: string }) => t.status)).toEqual(["pass", "pass"]);
    expect(out.results[0].actual).toBe(15);
  });

  it("fails with the actual value, the difference and an unsafe fix", async () => {
    const actual = await value(
      "SELECT sum(amount) FROM orders WHERE status = 'paid' AND ordered_at BETWEEN DATE '2026-01-01' AND DATE '2026-01-31'",
    );
    const window = ["2026-01-01", "2026-01-31"];
    const { code, out } = await runTests({
      ...METRICS,
      revenue: {
        ...METRICS.revenue,
        tests: [
          { window, expect: actual + 0.004, tolerance: 0.005 },
          { window, expect: actual + 0.004, tolerance: 0.003 },
          { window, expect: actual + 0.0000004 },
          { window, expect: actual + 1, name: "off by one" },
          { window, by: "region", expect: { Nowhere: 1 } },
        ],
      },
    });
    expect(code).toBe(1);
    expect(out.results.map((t: { status: string }) => t.status)).toEqual([
      "pass",
      "fail",
      "pass",
      "fail",
      "fail",
    ]);
    const off = out.results[3];
    expect(off).toMatchObject({
      name: "off by one",
      file: "metrics/revenue.yaml",
      pointer: "/tests/3",
    });
    expect(off.actual).toBeCloseTo(actual, 6);
    expect(off.difference).toBeCloseTo(-1, 6);
    const fix = out.diagnostics.find(
      (d: { code: string; pointer: string }) =>
        d.code === "HM4030" && d.pointer === "/tests/3/expect",
    );
    expect(fix.fix).toMatchObject({ applicability: "unsafe" });
    expect(Number(fix.fix.text)).toBeCloseTo(actual, 6);
    expect(out.results[4].actual).toEqual({ Nowhere: null });
  });

  it("warns when a test reads past the data and checks row counts", async () => {
    const paid = await value("SELECT count(*) FROM orders WHERE status = 'paid'");
    const all = await value("SELECT count(*) FROM orders");
    const { code, out } = await runTests(
      {
        ...METRICS,
        revenue: {
          ...METRICS.revenue,
          tests: [
            {
              window: ["2026-10-01", "2026-11-15"],
              expect: await value(
                "SELECT sum(amount) FROM orders WHERE status = 'paid' AND ordered_at >= DATE '2026-10-01'",
              ),
            },
            {
              window: ["2026-10-01", "2026-10-31"],
              expect: await value(
                "SELECT sum(amount) FROM orders WHERE status = 'paid' AND ordered_at >= DATE '2026-10-01'",
              ),
            },
          ],
        },
      },
      [
        { rows: { min: all, max: all } },
        { rows: { min: paid + 1 }, where: [where("status", "eq", "paid")] },
        { rows: { max: 0 }, where: [{ column: "region", op: "is_null" }] },
      ],
    );
    expect(code).toBe(1);
    const warn = out.diagnostics.filter((d: { code: string }) => d.code === "HM4031");
    expect(warn.map((d: { pointer: string }) => d.pointer)).toEqual(["/tests/0"]);
    const source = out.results.filter((t: { kind: string }) => t.kind === "source");
    expect(source.map((t: { status: string }) => t.status)).toEqual(["pass", "fail", "fail"]);
    expect(source[1].actual).toBe(paid);
    const typo = await runTests(METRICS, [{ rows: { min: 1 }, where: [where("nope", "eq", "x")] }]);
    expect(typo.code).toBe(2);
    expect(typo.out.diagnostics).toEqual([
      expect.objectContaining({
        code: "HM2018",
        file: "hatchmark.yaml",
        pointer: "/sources/orders/tests/0/where/0/column",
      }),
    ]);
  });
});
