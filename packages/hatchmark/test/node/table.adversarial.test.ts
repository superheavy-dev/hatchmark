import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TableData, TableRow, Value } from "../../src/compiler/index.js";
import { checkReferences, PROJECT_DEFAULTS, parseDiagnostics } from "../../src/spec/index.js";
import { metric, Oracle, removeProjects, run, writeProject } from "./fixture.js";

let oracle: Oracle;
let root = "";

// DuckDB reads an empty CSV field as NULL, which is how these rows get null groups.
function ordersCsv(): string {
  let state = 48;
  const next = () => {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    return state / 2 ** 32;
  };
  const lines = ["day,region,country,channel,customer_id,amount,refunded"];
  const add = (region: string, country: string, amounts: (number | null)[], channel?: string) => {
    amounts.forEach((amount, i) => {
      const day = `2026-0${1 + (i % 2)}-${String(1 + ((i * 7) % 27)).padStart(2, "0")}`;
      const ch = channel ?? (next() < 0.5 ? "web" : next() < 0.5 ? "store" : "");
      const customer = `c${Math.floor(next() * 40)}`;
      lines.push(
        [day, region, country, ch, customer, amount ?? "", next() < 0.2 ? "true" : "false"].join(
          ",",
        ),
      );
    });
  };
  const random = (n: number, scale: number) =>
    Array.from({ length: n }, () => Math.round(next() * scale * 100) / 100);
  add("Americas", "US", random(40, 120));
  add("Americas", "CA", random(12, 90));
  add("Americas", "MX", [50, 50, 25, null]);
  add("Americas", "BR", [50, 75]);
  add("Europe", "UK", random(15, 100));
  add("Europe", "DE", [60, 40, 25]);
  add("Europe", "FR", [100, 25]);
  add("Europe", "ES", random(5, 80));
  add("Europe", "IT", [null, null]);
  add("", "", [30, 12.5]);
  add("", "NO", [7]);
  add("Other", "Other", [33.25, 10]);
  return `${lines.join("\n")}\n`;
}

const VISITS = "country,visits\nUS,9000\nCA,2100\nMX,800\nUK,2600\nDE,700\nFR,650\nJP,400\n,120\n";

const orders = (body: Record<string, unknown>) =>
  metric({ table: "orders", time: "day", type: "aggregate", ...body });

const METRICS: Record<string, unknown> = {
  "metrics/revenue.json": orders({ aggregate: "sum", column: "amount" }),
  "metrics/orders.json": orders({ aggregate: "count" }),
  "metrics/aov.json": orders({ aggregate: "avg", column: "amount" }),
  "metrics/biggest.json": orders({ aggregate: "max", column: "amount" }),
  "metrics/smallest.json": orders({ aggregate: "min", column: "amount" }),
  "metrics/customers.json": orders({ aggregate: "count_distinct", column: "customer_id" }),
  "metrics/refunds.json": orders({
    aggregate: "count",
    filters: [{ column: "refunded", op: "eq", value: true }],
  }),
  "metrics/refund_rate.json": metric({
    type: "ratio",
    numerator: "refunds",
    denominator: "orders",
  }),
  "metrics/visits.json": metric({
    type: "aggregate",
    table: "visits",
    aggregate: "sum",
    column: "visits",
  }),
  "metrics/sales.json": metric({
    type: "aggregate",
    table: "orders",
    aggregate: "sum",
    column: "amount",
  }),
  "metrics/per_visit.json": metric({ type: "ratio", numerator: "sales", denominator: "visits" }),
};

const ADDITIVE = ["revenue", "orders", "aov", "biggest", "smallest", "refund_rate"];

beforeAll(async () => {
  oracle = await Oracle.open();
  const fixture = await writeProject({
    "hatchmark.json": {
      ...PROJECT_DEFAULTS,
      name: "Tables",
      sources: {
        orders: { type: "csv", path: "orders.csv", freshness: { through: "as_of" } },
        visits: { type: "csv", path: "visits.csv", freshness: { through: "as_of" } },
      },
    },
    "orders.csv": ordersCsv(),
    "visits.csv": VISITS,
    ...METRICS,
    "dashboards/probe.json": { title: "Probe", blocks: [{ type: "text", markdown: "x" }] },
  });
  root = fixture.root;
  await oracle.run(
    `CREATE TABLE o AS SELECT * FROM read_csv('${root}/orders.csv', types = {'region': 'VARCHAR', 'country': 'VARCHAR', 'channel': 'VARCHAR'})`,
  );
  await oracle.run(
    `CREATE TABLE v AS SELECT * FROM read_csv('${root}/visits.csv', types = {'country': 'VARCHAR'})`,
  );
});
afterAll(async () => {
  oracle.close();
  await removeProjects();
});

async function table(block: Record<string, unknown>, filters: unknown[] = []) {
  const fixture = await writeProject({
    "hatchmark.json": {
      ...PROJECT_DEFAULTS,
      name: "Tables",
      sources: {
        orders: { type: "csv", path: "orders.csv", freshness: { through: "as_of" } },
        visits: { type: "csv", path: "visits.csv", freshness: { through: "as_of" } },
      },
    },
    "orders.csv": ordersCsv(),
    "visits.csv": VISITS,
    ...METRICS,
    "dashboards/probe.json": {
      title: "Probe",
      period: { asOf: "2026-02-28", range: "all_time", compare: "none" },
      filters,
      blocks: [{ type: "table", ...block }],
    },
  });
  const checks = [...parseDiagnostics(fixture.project), ...checkReferences(fixture.project)];
  const { data, diagnostics } = await run(fixture.root, fixture.project, "probe");
  const result = data?.blocks[0];
  if (result?.type !== "table") throw new Error(`no table: ${JSON.stringify(diagnostics)}`);
  return { data: result as TableData, checks, diagnostics };
}

const SELECT = `
  CAST(coalesce(sum(amount), 0) AS DOUBLE) AS revenue,
  CAST(count(*) AS DOUBLE) AS orders,
  CAST(avg(amount) AS DOUBLE) AS aov,
  CAST(max(amount) AS DOUBLE) AS biggest,
  CAST(min(amount) AS DOUBLE) AS smallest,
  CAST(count(DISTINCT customer_id) AS DOUBLE) AS customers,
  CAST(count(*) FILTER (WHERE refunded) AS DOUBLE) / NULLIF(count(*), 0) AS refund_rate`;

const close = (got: Value | undefined, want: unknown, what: string) => {
  const expected = want === undefined || want === null ? null : Number(want);
  if (expected === null || got === null || got === undefined) {
    expect(got ?? null, what).toBe(expected);
    return;
  }
  expect(Math.abs(got - expected), `${what}: ${got} vs ${expected}`).toBeLessThanOrEqual(
    1e-9 * Math.max(1, Math.abs(expected)),
  );
};

const expectRow = (row: TableRow | undefined, want: Record<string, unknown>, metrics: string[]) => {
  for (const m of metrics) close(row?.values[m], want[m], `${JSON.stringify(row?.keys)} ${m}`);
};

describe("top N plus Other", () => {
  const metrics = [...ADDITIVE, "customers"];

  for (const [label, sort, orderSql] of [
    [
      "revenue descending",
      { by: "revenue", order: "desc" },
      "revenue DESC NULLS LAST, country ASC NULLS LAST",
    ],
    [
      "orders ascending",
      { by: "orders", order: "asc" },
      "orders ASC NULLS LAST, country ASC NULLS LAST",
    ],
    ["country descending", { by: "country", order: "desc" }, "country DESC NULLS LAST"],
    [
      "average ascending",
      { by: "aov", order: "asc" },
      "aov ASC NULLS LAST, country ASC NULLS LAST",
    ],
  ] as const) {
    it(`matches SQL for the top 4 and Other, sorted by ${label}`, async () => {
      const { data, checks } = await table({
        by: ["country"],
        metrics,
        percentOfTotal: ["revenue", "orders"],
        sort,
        limit: 4,
        other: true,
      });
      expect(checks.map((d) => [d.code, d.severity])).toEqual([["HM4063", "warning"]]);
      const ranked = await oracle.rows(`
        WITH g AS (SELECT country, ${SELECT} FROM o GROUP BY country)
        SELECT *, ROW_NUMBER() OVER (ORDER BY ${orderSql}) AS rn FROM g ORDER BY rn`);
      const [other] = await oracle.rows(`
        WITH g AS (SELECT country, ${SELECT} FROM o GROUP BY country),
        top AS (SELECT country FROM g ORDER BY ${orderSql} LIMIT 4)
        SELECT ${SELECT}, count(DISTINCT country) + count(DISTINCT CASE WHEN country IS NULL THEN 1 END) AS n
        FROM o WHERE NOT EXISTS (SELECT 1 FROM top WHERE top.country IS NOT DISTINCT FROM o.country)`);
      const [total] = await oracle.rows(`SELECT ${SELECT} FROM o`);
      expect(data.rowCount).toBe(ranked.length);
      expect(data.rows.slice(0, 4).map((r) => r.keys[0])).toEqual(
        ranked.slice(0, 4).map((r) => r.country),
      );
      data.rows.slice(0, 4).forEach((row, i) => {
        expectRow(row, ranked[i] ?? {}, metrics);
      });
      const otherRow = data.rows[4];
      expect(otherRow).toMatchObject({ kind: "other", keys: [null], count: ranked.length - 4 });
      expect(otherRow?.count).toBe(Number(other?.n));
      expectRow(otherRow, other ?? {}, ADDITIVE);
      expect(otherRow?.values.customers).toBeNull();
      expect(data.rows).toHaveLength(5);
      expectRow({ keys: [], values: data.total?.values ?? {} }, total ?? {}, metrics);
      for (const row of data.rows) {
        close(row.share?.revenue, Number(row.values.revenue) / Number(total?.revenue), "share");
        close(row.share?.orders, Number(row.values.orders) / Number(total?.orders), "share");
      }
      const shown = data.rows.reduce((sum, r) => sum + (r.values.orders ?? 0), 0);
      close(shown, total?.orders, "rows and Other add up to the total");
    });
  }

  it("breaks ties at the N boundary by key, the same on every build", async () => {
    const ties = await oracle.rows(`
      SELECT country, CAST(sum(amount) AS DOUBLE) AS revenue FROM o GROUP BY country
      HAVING coalesce(sum(amount), 0) = 125 ORDER BY country`);
    expect(ties.map((r) => r.country)).toEqual(["BR", "DE", "FR", "MX"]);
    const ranks = await oracle.rows(`
      SELECT country FROM (SELECT country, coalesce(sum(amount), 0) AS revenue FROM o GROUP BY country)
      ORDER BY revenue DESC NULLS LAST, country ASC NULLS LAST`);
    const n = ranks.findIndex((r) => r.country === "BR") + 1;
    const first = await table({ by: ["country"], metrics: ["revenue"], limit: n, other: true });
    const again = await table({ by: ["country"], metrics: ["revenue"], limit: n, other: true });
    expect(JSON.stringify(again.data)).toBe(JSON.stringify(first.data));
    expect(first.data.rows.at(-2)?.keys).toEqual(["BR"]);
    expect(first.checks).toEqual([]);
    const [other] = await oracle.rows(`
      WITH top AS (SELECT country FROM (SELECT country, coalesce(sum(amount), 0) AS revenue FROM o GROUP BY country)
        ORDER BY revenue DESC NULLS LAST, country ASC NULLS LAST LIMIT ${n})
      SELECT CAST(sum(amount) AS DOUBLE) AS revenue FROM o
      WHERE NOT EXISTS (SELECT 1 FROM top WHERE top.country IS NOT DISTINCT FROM o.country)`);
    close(first.data.rows.at(-1)?.values.revenue, other?.revenue, "Other after a tie");
  });

  it("keeps the null group and a group named Other apart from the Other row", async () => {
    const { data } = await table({
      by: ["country"],
      metrics: ["revenue", "orders"],
      sort: { by: "country", order: "asc" },
      limit: 30,
      other: true,
    });
    const keys = data.rows.map((r) => r.keys[0]);
    expect(keys).toContain(null);
    expect(keys.at(-1)).toBeNull();
    expect(keys).toContain("Other");
    expect(data.rows.some((r) => r.kind === "other")).toBe(false);
    const named = data.rows.find((r) => r.keys[0] === "Other");
    expect(named?.kind).toBeUndefined();
    const [want] = await oracle.rows(`SELECT ${SELECT} FROM o WHERE country = 'Other'`);
    expectRow(named, want ?? {}, ["revenue", "orders"]);
  });

  it("sorts a group whose average is undefined last and folds it into Other without poisoning it", async () => {
    const { data } = await table({
      by: ["country"],
      metrics: ["revenue", "orders", "aov"],
      sort: { by: "aov", order: "asc" },
      limit: 3,
      other: true,
    });
    const [it_] = await oracle.rows(`SELECT ${SELECT} FROM o WHERE country = 'IT'`);
    expect(it_?.aov).toBeNull();
    expect(it_?.revenue).toBe(0);
    expect(data.rows.slice(0, 3).map((r) => r.keys[0])).not.toContain("IT");
    const [other] = await oracle.rows(`
      WITH top AS (SELECT country FROM (SELECT country, avg(amount) AS aov FROM o GROUP BY country)
        ORDER BY aov ASC NULLS LAST, country ASC NULLS LAST LIMIT 3)
      SELECT ${SELECT} FROM o
      WHERE NOT EXISTS (SELECT 1 FROM top WHERE top.country IS NOT DISTINCT FROM o.country)`);
    expect(data.rows[3]?.kind).toBe("other");
    expectRow(data.rows[3], other ?? {}, ["revenue", "orders", "aov"]);
  });

  it("divides a cross-source ratio's folded parts, with groups only one source has", async () => {
    const { data, checks } = await table({
      by: ["country"],
      metrics: ["sales", "visits", "per_visit"],
      limit: 3,
      other: true,
    });
    expect(checks).toEqual([]);
    const groups = await oracle.rows(`
      WITH a AS (SELECT country, coalesce(sum(amount), 0) AS revenue FROM o GROUP BY country),
      b AS (SELECT country, sum(visits) AS visits FROM v GROUP BY country),
      k AS (SELECT country FROM a UNION SELECT country FROM b)
      SELECT k.country, CAST(coalesce(a.revenue, 0) AS DOUBLE) AS revenue,
        CAST(coalesce(b.visits, 0) AS DOUBLE) AS visits
      FROM k LEFT JOIN a ON a.country IS NOT DISTINCT FROM k.country
        LEFT JOIN b ON b.country IS NOT DISTINCT FROM k.country
      ORDER BY revenue DESC, k.country ASC NULLS LAST`);
    expect(data.rowCount).toBe(groups.length);
    expect(groups.map((g) => g.country)).toContain("JP");
    const rest = groups.slice(3);
    const revenue = rest.reduce((s, g) => s + Number(g.revenue), 0);
    const visits = rest.reduce((s, g) => s + Number(g.visits), 0);
    const other = data.rows[3];
    expect(other?.kind).toBe("other");
    close(other?.values.sales, revenue, "Other revenue");
    close(other?.values.visits, visits, "Other visits");
    close(other?.values.per_visit, revenue / visits, "Other revenue per visit");
    const [total] = await oracle.rows(
      "SELECT (SELECT sum(amount) FROM o) / (SELECT sum(visits) FROM v) AS per_visit",
    );
    close(data.total?.values.per_visit, total?.per_visit, "total revenue per visit");
  });

  it("applies a dashboard filter to the rows, Other and the total alike", async () => {
    const { data } = await table(
      { by: ["country"], metrics: ["revenue", "orders", "aov"], limit: 3, other: true },
      [{ id: "channel", type: "select", column: "channel", default: "web" }],
    );
    const [other] = await oracle.rows(`
      WITH f AS (SELECT * FROM o WHERE channel = 'web'),
      top AS (SELECT country FROM (SELECT country, coalesce(sum(amount), 0) AS revenue FROM f GROUP BY country)
        ORDER BY revenue DESC NULLS LAST, country ASC NULLS LAST LIMIT 3)
      SELECT ${SELECT} FROM f
      WHERE NOT EXISTS (SELECT 1 FROM top WHERE top.country IS NOT DISTINCT FROM f.country)`);
    const [total] = await oracle.rows(`SELECT ${SELECT} FROM o WHERE channel = 'web'`);
    expectRow(data.rows[3], other ?? {}, ["revenue", "orders", "aov"]);
    expectRow({ keys: [], values: data.total?.values ?? {} }, total ?? {}, [
      "revenue",
      "orders",
      "aov",
    ]);
  });

  it("leaves the rows alone when the limit cuts nothing", async () => {
    const { data } = await table({
      by: ["country"],
      metrics: ["revenue"],
      limit: 100,
      other: true,
    });
    expect(data.rows.some((r) => r.kind === "other")).toBe(false);
    expect(data.rows).toHaveLength(data.rowCount);
  });
});

describe("subtotals", () => {
  const metrics = [...ADDITIVE, "customers"];

  it("matches GROUPING SETS for two levels, non-additive metrics included", async () => {
    const { data, checks } = await table({
      by: ["region", "country"],
      metrics,
      percentOfTotal: ["revenue"],
      subtotals: true,
    });
    expect(checks).toEqual([]);
    const sets = await oracle.rows(`
      SELECT region, country, ${SELECT}, CAST(GROUPING(region, country) AS INTEGER) AS g
      FROM o GROUP BY GROUPING SETS ((region, country), (region), ())`);
    const total = sets.find((s) => s.g === 3) ?? {};
    const regions = sets
      .filter((s) => s.g === 1)
      .sort(
        (a, b) =>
          Number(b.revenue) - Number(a.revenue) ||
          (a.region === null
            ? 1
            : b.region === null
              ? -1
              : String(a.region) < String(b.region)
                ? -1
                : 1),
      );
    const expected: { keys: unknown[]; want: Record<string, unknown>; kind?: string }[] = [];
    for (const r of regions) {
      expected.push({ keys: [r.region, null], want: r, kind: "subtotal" });
      const leaves = sets
        .filter((s) => s.g === 0 && s.region === r.region)
        .sort(
          (a, b) =>
            (b.revenue === null
              ? -1
              : a.revenue === null
                ? 1
                : Number(b.revenue) - Number(a.revenue)) ||
            (a.country === null
              ? 1
              : b.country === null
                ? -1
                : String(a.country) < String(b.country)
                  ? -1
                  : 1),
        );
      for (const l of leaves) expected.push({ keys: [r.region, l.country], want: l });
    }
    expect(data.rows.map((r) => [r.kind ?? "row", ...r.keys])).toEqual(
      expected.map((e) => [e.kind ?? "row", ...e.keys]),
    );
    data.rows.forEach((row, i) => {
      expectRow(row, expected[i]?.want ?? {}, metrics);
      close(row.share?.revenue, Number(row.values.revenue) / Number(total.revenue), "share");
      if (row.kind === "subtotal") expect(row.level).toBe(1);
    });
    expectRow({ keys: [], values: data.total?.values ?? {} }, total, metrics);
    const europe = data.rows.find((r) => r.kind === "subtotal" && r.keys[0] === "Europe");
    const europeLeaves = data.rows.filter((r) => !r.kind && r.keys[0] === "Europe");
    expect(europe?.values.customers).toBeLessThan(
      europeLeaves.reduce((s, r) => s + (r.values.customers ?? 0), 0),
    );
  });

  it("matches GROUPING SETS for three levels, null channel and empty region included", async () => {
    const { data } = await table({
      by: ["region", "country", "channel"],
      metrics: ["revenue", "customers", "aov"],
      subtotals: true,
      sort: { by: "region", order: "asc" },
    });
    const sets = await oracle.rows(`
      SELECT region, country, channel, ${SELECT}, CAST(GROUPING(region, country, channel) AS INTEGER) AS g
      FROM o GROUP BY ROLLUP (region, country, channel)`);
    const level = (s: Record<string, unknown>) =>
      s.g === 3 ? 1 : s.g === 1 ? 2 : s.g === 0 ? 3 : 0;
    const find = (row: TableRow) =>
      sets.find(
        (s) =>
          level(s) === (row.kind === "subtotal" ? row.level : 3) &&
          row.keys.every(
            (k, i) =>
              k === [s.region, s.country, s.channel][i] || (k === null && i >= (row.level ?? 3)),
          ),
      );
    expect(data.rows.filter((r) => !r.kind)).toHaveLength(sets.filter((s) => s.g === 0).length);
    expect(data.rows.filter((r) => r.level === 1)).toHaveLength(
      sets.filter((s) => s.g === 3).length,
    );
    expect(data.rows.filter((r) => r.level === 2)).toHaveLength(
      sets.filter((s) => s.g === 1).length,
    );
    for (const row of data.rows) expectRow(row, find(row) ?? {}, ["revenue", "customers", "aov"]);
    expect(data.rows.filter((r) => r.level === 1).map((r) => r.keys[0])).toEqual([
      "Americas",
      "Europe",
      "Other",
      null,
    ]);
    let region: unknown;
    for (const row of data.rows) {
      if (row.level === 1) region = row.keys[0];
      else expect(row.keys[0]).toBe(region);
    }
  });

  it("cuts each innermost group to its top 2 and folds the rest into that group's Other row", async () => {
    const { data } = await table({
      by: ["region", "country"],
      metrics: ["revenue", "orders", "aov", "biggest"],
      subtotals: true,
      limit: 2,
      other: true,
    });
    const others = await oracle.rows(`
      WITH g AS (SELECT region, country, coalesce(sum(amount), 0) AS revenue FROM o GROUP BY region, country),
      ranked AS (SELECT *, ROW_NUMBER() OVER (PARTITION BY region ORDER BY revenue DESC NULLS LAST, country ASC NULLS LAST) AS rn FROM g)
      SELECT o.region, ${SELECT}, count(DISTINCT ranked.country) AS n FROM o JOIN ranked
        ON ranked.region IS NOT DISTINCT FROM o.region AND ranked.country IS NOT DISTINCT FROM o.country
      WHERE rn > 2 GROUP BY o.region`);
    const otherRows = data.rows.filter((r) => r.kind === "other");
    expect(otherRows.map((r) => r.keys[0]).sort()).toEqual(others.map((o) => o.region).sort());
    for (const row of otherRows) {
      const want = others.find((o) => o.region === row.keys[0]) ?? {};
      expect(row.keys[1]).toBeNull();
      expect(row.count).toBe(Number(want.n));
      expectRow(row, want, ["revenue", "orders", "aov", "biggest"]);
    }
    const [total] = await oracle.rows(`SELECT ${SELECT} FROM o`);
    expectRow({ keys: [], values: data.total?.values ?? {} }, total ?? {}, [
      "revenue",
      "orders",
      "aov",
      "biggest",
    ]);
    for (const sub of data.rows.filter((r) => r.kind === "subtotal")) {
      const members = data.rows.filter((r) => r.kind !== "subtotal" && r.keys[0] === sub.keys[0]);
      close(
        members.reduce((s, r) => s + (r.values.orders ?? 0), 0),
        sub.values.orders,
        "group adds up",
      );
      expect(members.filter((r) => !r.kind).length).toBeLessThanOrEqual(2);
    }
    expect(data.rowCount).toBe(
      (await oracle.rows("SELECT DISTINCT region, country FROM o")).length,
    );
  });
});

describe("check guidance", () => {
  it("warns that Other cannot fold a distinct count, and builds with — for it", async () => {
    const { data, checks } = await table({
      by: ["country"],
      metrics: ["revenue", "customers"],
      limit: 2,
      other: true,
    });
    expect(checks.map((d) => [d.code, d.severity, d.pointer])).toEqual([
      ["HM4063", "warning", "/blocks/0/other"],
    ]);
    expect(checks[0]?.fix?.text).toBe("false");
    expect(data.rows.at(-1)).toMatchObject({ kind: "other", values: { customers: null } });
  });
});
