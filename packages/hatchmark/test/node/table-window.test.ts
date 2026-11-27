import path from "node:path";
import { afterAll, expect, it } from "vitest";
import type { TableData } from "../../src/compiler/index.js";
import { renderFragment } from "../../src/render/index.js";
import { PROJECT_DEFAULTS } from "../../src/spec/index.js";
import { metric, Oracle, removeProjects, run, writeProject } from "./fixture.js";

afterAll(removeProjects);

const columns = "at,market,amount,units\n";
const sum = (table: string, column: string, label: string, time: string | null = "at") =>
  metric({ type: "aggregate", label, table, aggregate: "sum", column, ...(time ? { time } : {}) });
const METRICS = {
  revenue: sum("sales", "amount", "Revenue"),
  refunds: sum("refunds", "amount", "Refunds"),
  units: sum("sales", "units", "Units", null),
  stock: sum("sales", "units", "Stock", null),
};
const SOURCES = {
  sales:
    "2026-10-29T15:00:00Z,A,300,2\n2026-11-01T15:00:00Z,A,70,1\n2026-11-02T18:00:00Z,B,99,3\n" +
    "2026-11-03T18:00:00Z,A,35,4\n2026-11-04T23:03:00Z,A,600,5\n",
  refunds:
    "2026-10-30T15:00:00Z,A,9,0\n2026-11-01T16:00:00Z,A,7,0\n2026-11-01T20:00:00Z,B,5,0\n" +
    "2026-11-02T18:00:00Z,A,4,0\n",
  old: "2026-10-20T15:00:00Z,A,11,0\n2026-10-21T15:00:00Z,B,13,0\n",
};

async function table(
  metrics: string[],
  range = "month_to_date",
  extra: Record<string, unknown> = {},
) {
  const fixture = await writeProject({
    "hatchmark.yaml": {
      ...PROJECT_DEFAULTS,
      name: "Table windows",
      timezone: "America/New_York",
      sources: Object.fromEntries(
        Object.keys(SOURCES).map((key) => [key, { type: "csv", path: `${key}.csv` }]),
      ),
    },
    ...Object.fromEntries(
      Object.entries(SOURCES).map(([key, csv]) => [`${key}.csv`, columns + csv]),
    ),
    ...Object.fromEntries(
      Object.entries({ ...METRICS, ...extra }).map(([key, spec]) => [`metrics/${key}.yaml`, spec]),
    ),
    "dashboards/d.yaml": {
      title: "D",
      period: { asOf: "2026-11-05", range, compare: "none" },
      blocks: [{ id: "t", type: "table", by: ["market"], metrics }],
    },
  });
  expect(fixture.diagnostics).toEqual([]);
  const result = await run(fixture.root, fixture.project, "d");
  if (result.data === undefined) throw new Error("no dashboard data");
  const block = result.data.blocks[0] as TableData;
  const html = renderFragment(result.data);
  const subtitle = html.match(/<\/h2><p id="hm-t-s">([^<]+)/)?.[1];
  const described = html.includes('<table aria-describedby="hm-t-s"');
  const notes = Object.fromEntries(
    [...html.matchAll(/role="tooltip" id="hm-t-w(\d+)">([^<]+)</g)].map(([, i, text]) => [
      metrics[Number(i)],
      text,
    ]),
  );
  const sortDescribed = [...html.matchAll(/class="hm-sort" aria-describedby="hm-t-w(\d+)"/g)].map(
    ([, i]) => metrics[Number(i)],
  );
  const raw = (source: string) => `read_csv('${path.join(fixture.root, `${source}.csv`)}')`;
  const oracle = await Oracle.open();
  const sql = async (q: string) => {
    try {
      return await oracle.rows(q);
    } finally {
      oracle.close();
    }
  };
  const values = Object.fromEntries(block.rows.map((r) => [String(r.keys[0]), r.values]));
  return { block, subtitle, described, notes, sortDescribed, sql, raw, values };
}

const newYorkMidnight = (day: string) =>
  `TIMESTAMPTZ '${day} ${day < "2026-11-02" ? "04" : "05"}:00:00+00'`;
const newYorkDays = (first: string, end: string) =>
  `FILTER (WHERE "at" >= ${newYorkMidnight(first)} AND "at" < ${newYorkMidnight(end)})`;

it("names the metric that ends at an earlier horizon and the untimed one, each matching SQL", async () => {
  const { block, subtitle, notes, sql, raw, values } = await table(["revenue", "refunds", "units"]);
  const expected = await sql(`
    SELECT s.market, s.revenue, r.refunds, s.units FROM
      (SELECT market, sum(amount) ${newYorkDays("2026-11-01", "2026-11-04")} AS revenue, sum(units) AS units
        FROM ${raw("sales")} GROUP BY market) s
      LEFT JOIN (SELECT market, sum(amount) ${newYorkDays("2026-11-01", "2026-11-02")} AS refunds
        FROM ${raw("refunds")} GROUP BY market) r USING (market)
    ORDER BY s.market`);
  expect(expected).toEqual([
    { market: "A", revenue: 105, refunds: 7, units: 12 },
    { market: "B", revenue: 99, refunds: 5, units: 3 },
  ]);
  for (const row of expected)
    expect(values[row.market as string]).toEqual({
      revenue: row.revenue,
      refunds: row.refunds,
      units: row.units,
    });
  expect(block.window).toEqual({ start: "2026-11-01", end: "2026-11-04" });
  expect(block.windows).toEqual({ refunds: { start: "2026-11-01", end: "2026-11-02" } });
  expect(block.allTime).toEqual(["units"]);
  expect(subtitle).toBe("Nov 1 – Nov 3, 2026");
  expect(notes).toEqual({ refunds: "Data through Nov 1, 2026 · 2 days behind", units: "All time" });
});

it("takes the window from the first dated metric when the first metric has no time column", async () => {
  const { block, subtitle, notes } = await table(["units", "revenue"]);
  expect(block.window).toEqual({ start: "2026-11-01", end: "2026-11-04" });
  expect(subtitle).toBe("Nov 1 – Nov 3, 2026");
  expect(notes).toEqual({ units: "All time" });
});

it("says through each horizon for an all-time period, matching SQL", async () => {
  const { block, subtitle, notes, sql, raw, values } = await table(
    ["revenue", "refunds", "units"],
    "all_time",
  );
  const expected = await sql(`
    SELECT (SELECT sum(amount) FILTER (WHERE "at" < ${newYorkMidnight("2026-11-04")}) FROM ${raw("sales")}
        WHERE market = 'A') AS revenue,
      (SELECT sum(amount) FILTER (WHERE "at" < ${newYorkMidnight("2026-11-02")}) FROM ${raw("refunds")}
        WHERE market = 'A') AS refunds,
      (SELECT sum(units) FROM ${raw("sales")} WHERE market = 'A') AS units`);
  expect(expected).toEqual([{ revenue: 405, refunds: 16, units: 12 }]);
  expect(values.A).toEqual(expected[0]);
  expect(block.through).toBe("2026-11-03");
  expect(block.throughs).toEqual({ refunds: "2026-11-01" });
  expect(subtitle).toBe("through Nov 3, 2026");
  expect(notes).toEqual({ refunds: "Data through Nov 1, 2026 · 2 days behind", units: "All time" });
});

it("says all time when no metric has a time column", async () => {
  const { block, subtitle, notes } = await table(["units", "stock"]);
  expect(block.window).toBeUndefined();
  expect(subtitle).toBe("all time");
  expect(notes).toEqual({});
});

it("says which metric has no data in the period while the others fill the rows", async () => {
  const { block, subtitle, notes, values } = await table(["revenue", "lapsed"], "month_to_date", {
    lapsed: sum("old", "amount", "Lapsed"),
  });
  expect(block.emptyMetrics).toEqual({ lapsed: "no_data" });
  expect(values.A).toEqual({ revenue: 105, lapsed: null });
  expect(subtitle).toBe("Nov 1 – Nov 3, 2026");
  expect(notes).toEqual({ lapsed: "No data in this period" });
});

it("takes the main window from most metrics and marks the column that reads another", async () => {
  const { block, subtitle, described, notes, sortDescribed } = await table(
    ["refunds", "revenue", "orders"],
    "month_to_date",
    { orders: sum("sales", "units", "Orders") },
  );
  expect(block.window).toEqual({ start: "2026-11-01", end: "2026-11-04" });
  expect(block.windows).toEqual({ refunds: { start: "2026-11-01", end: "2026-11-02" } });
  expect(subtitle).toBe("Nov 1 – Nov 3, 2026");
  expect(notes).toEqual({ refunds: "Data through Nov 1, 2026 · 2 days behind" });
  expect(sortDescribed).toEqual(["refunds"]);
  expect(described).toBe(true);
});

it("keeps the plain window and no marker when every metric shares it", async () => {
  const { subtitle, described, notes } = await table(["revenue", "orders"], "month_to_date", {
    orders: sum("sales", "units", "Orders"),
  });
  expect(subtitle).toBe("Nov 1 – Nov 3, 2026");
  expect(notes).toEqual({});
  expect(described).toBe(true);
});

it.each(["month_to_date", "all_time"])(
  "renders a metric named constructor next to one with another window (%s)",
  async (range) => {
    const { subtitle, notes, values, sql, raw } = await table(["constructor", "refunds"], range, {
      constructor: sum("sales", "amount", "Constructor"),
    });
    const start = range === "all_time" ? "" : `"at" >= ${newYorkMidnight("2026-11-01")} AND `;
    const [expected] = await sql(`
      SELECT (SELECT sum(amount) FROM ${raw("sales")} WHERE ${start}"at" < ${newYorkMidnight("2026-11-04")}
          AND market = 'A') AS sales,
        (SELECT sum(amount) FROM ${raw("refunds")} WHERE ${start}"at" < ${newYorkMidnight("2026-11-02")}
          AND market = 'A') AS refunds`);
    expect(values.A).toEqual({ constructor: expected?.sales, refunds: expected?.refunds });
    expect(subtitle).toBe(range === "all_time" ? "through Nov 3, 2026" : "Nov 1 – Nov 3, 2026");
    expect(notes).toEqual({ refunds: "Data through Nov 1, 2026 · 2 days behind" });
  },
);
