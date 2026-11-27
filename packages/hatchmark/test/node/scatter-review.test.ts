import path from "node:path";
import { afterAll, expect, it } from "vitest";
import type { ScatterData, TableData } from "../../src/compiler/index.js";
import { renderFragment } from "../../src/render/index.js";
import { checkReferences, PROJECT_DEFAULTS } from "../../src/spec/index.js";
import { applyFix, DASHBOARD, projectFrom } from "../spec/helpers.js";
import { fromYaml } from "../yaml.js";
import { metric, Oracle, removeProjects, run, writeProject } from "./fixture.js";

afterAll(removeProjects);

const fail = (): never => {
  throw new Error("no dashboard data");
};

const columns = "at,market,amount,units,margin,status,channel,country\n";
const agg = (table: string, column: string, extra: Record<string, unknown> = {}) =>
  metric({
    type: "aggregate",
    label: column,
    table,
    time: "at",
    aggregate: "sum",
    column,
    ...extra,
  });
const scatter = (x: string, y: string, extra: Record<string, unknown> = {}) => ({
  id: "s",
  type: "scatter",
  x,
  y,
  by: "market",
  ...extra,
});

async function check(
  sources: Record<string, string>,
  metrics: Record<string, unknown>,
  blocks: unknown[],
  range: unknown = "month_to_date",
  filters: unknown[] = [],
) {
  const fixture = await writeProject({
    "hatchmark.yaml": {
      ...PROJECT_DEFAULTS,
      name: "Independent scatter oracle",
      timezone: "America/New_York",
      sources: Object.fromEntries(
        Object.keys(sources).map((key) => [key, { type: "csv", path: `${key}.csv` }]),
      ),
    },
    ...Object.fromEntries(
      Object.entries(sources).map(([key, csv]) => [`${key}.csv`, columns + csv]),
    ),
    ...Object.fromEntries(
      Object.entries(metrics).map(([key, spec]) => [`metrics/${key}.yaml`, spec]),
    ),
    "dashboards/d.yaml": {
      title: "D",
      period: { asOf: "2026-11-05", range, compare: "none" },
      filters,
      blocks,
    },
  });
  expect(fixture.diagnostics).toEqual([]);
  const result = await run(fixture.root, fixture.project, "d");
  expect(result.data?.blocks[0]?.type).toBe("scatter");
  const oracle = await Oracle.open();
  const raw = (source: string) => `read_csv('${path.join(fixture.root, `${source}.csv`)}')`;
  return {
    ...result,
    b: result.data?.blocks[0] as ScatterData,
    table: result.data?.blocks[1] as TableData,
    query: async (sql: string) => {
      try {
        return await oracle.rows(sql);
      } finally {
        oracle.close();
      }
    },
    raw,
  };
}

it("matches independent SQL with two select defaults, signed sizes, null keys and a partial day", async () => {
  const { b, query, raw, diagnostics } = await check(
    {
      sales:
        "2026-11-01T03:59:59Z,A,900,1,50,paid,Web,US\n" +
        "2026-11-01T04:00:00Z,A,30,1,-15,paid,Web,US\n" +
        "2026-11-01T14:00:00Z,A,10,3,-4,paid,Web,US\n" +
        "2026-11-02T13:00:00Z,A,999,9,99,paid,Store,US\n" +
        "2026-11-02T13:00:00Z,A,888,8,88,paid,Web,CA\n" +
        "2026-11-02T13:00:00Z,A,777,7,11,refunded,Web,US\n" +
        "2026-11-02T01:30:00Z,,80,2,5,paid,Web,US\n" +
        "2026-11-03T18:00:00Z,Returns,35,3,2,refunded,Web,US\n" +
        "2026-11-04T05:00:00Z,A,300,1,90,paid,Web,US\n" +
        "2026-11-04T19:03:00Z,Partial,600,2,99,paid,Web,US\n",
    },
    {
      units: agg("sales", "units", { filters: [{ column: "status", op: "eq", value: "paid" }] }),
      paid: agg("sales", "amount", { filters: [{ column: "status", op: "eq", value: "paid" }] }),
      per_unit: metric({ type: "ratio", numerator: "paid", denominator: "units" }),
      margin: agg("sales", "margin"),
    },
    [scatter("units", "per_unit", { size: "margin" })],
    "month_to_date",
    [
      { type: "select", id: "channel", column: "channel", default: "Web" },
      { type: "select", id: "country", column: "country", default: "US" },
    ],
  );
  const rows = await query(`
    SELECT market AS key, sum(units) FILTER (WHERE status = 'paid') AS x,
      sum(amount) FILTER (WHERE status = 'paid') / nullif(sum(units) FILTER (WHERE status = 'paid'), 0) AS y,
      sum(margin) AS size FROM ${raw("sales")}
    WHERE "at" >= TIMESTAMPTZ '2026-11-01 04:00:00+00' AND "at" < TIMESTAMPTZ '2026-11-04 05:00:00+00'
      AND country = 'US' AND channel = 'Web'
    GROUP BY market ORDER BY size DESC, market`);
  expect(b.window).toEqual({ start: "2026-11-01", end: "2026-11-04" });
  expect(b.points.map(({ label: _, ...p }) => p)).toEqual(rows.filter((r) => r.y !== null));
  expect(b.omittedPoints).toBe(1);
  expect(diagnostics.map((d) => d.code)).toEqual(["HM4010", "HM4070", "HM4071"]);
});

it("excludes points whose second source has no complete day instead of plotting false zeros", async () => {
  const { b, table, query, raw } = await check(
    {
      current:
        "2026-11-01T15:00:00Z,A,70,1,1,paid,Web,US\n2026-11-04T18:00:00Z,A,99,1,1,paid,Web,US\n",
      partial: "2026-11-01T18:00:00Z,A,13,1,1,paid,Web,US\n",
    },
    { newest: agg("current", "amount"), lagged: agg("partial", "amount") },
    [
      scatter("newest", "lagged"),
      { type: "table", id: "control", metrics: ["newest", "lagged"], by: ["market"] },
    ],
  );
  const rows = await query(`
    WITH x AS (
      SELECT market, sum(amount) AS x FROM ${raw("current")} WHERE "at" >= TIMESTAMPTZ '2026-11-01 04:00:00+00' AND "at" < TIMESTAMPTZ '2026-11-04 05:00:00+00' GROUP BY market
    ), y AS (
      SELECT market, sum(amount) AS y FROM ${raw("partial")} WHERE "at" >= TIMESTAMPTZ '2026-11-01 04:00:00+00' AND "at" < TIMESTAMPTZ '2026-11-01 04:00:00+00' GROUP BY market
    )
    SELECT x.market, x.x, y.y FROM x LEFT JOIN y USING (market)`);
  expect(rows).toEqual([{ market: "A", x: 70, y: null }]);
  expect(table.rows[0]?.values).toEqual({ newest: 70, lagged: null });
  expect(b.points).toEqual([]);
});

it("breaks a size tie by category name before applying limit, as ScatterData documents", async () => {
  const { b, query, raw } = await check(
    {
      sales:
        "2026-11-01T15:00:00Z,A,10,9,5,paid,Web,US\n2026-11-01T15:00:00Z,Z,90,1,5,paid,Web,US\n2026-11-04T19:03:00Z,Partial,600,2,99,paid,Web,US\n",
    },
    {
      units: agg("sales", "units"),
      amount: agg("sales", "amount"),
      margin: agg("sales", "margin"),
    },
    [scatter("units", "amount", { size: "margin", limit: 1 })],
  );
  const rows = await query(`
    SELECT market AS key FROM ${raw("sales")}
    WHERE "at" >= TIMESTAMPTZ '2026-11-01 04:00:00+00' AND "at" < TIMESTAMPTZ '2026-11-04 05:00:00+00'
    GROUP BY market ORDER BY sum(margin) DESC, market LIMIT 1`);
  expect(b.points.map(({ key }) => ({ key }))).toEqual(rows);
});

it("does not advertise the x reading's date range as if it also applied to y", async () => {
  const { b, data, query, raw } = await check(
    {
      current:
        "2026-11-01T15:00:00Z,A,70,1,1,paid,Web,US\n2026-11-04T18:00:00Z,A,99,1,1,paid,Web,US\n",
      partial:
        "2026-11-01T18:00:00Z,A,13,1,1,paid,Web,US\n2026-11-02T18:00:00Z,A,100,1,1,paid,Web,US\n",
    },
    {
      newest: agg("current", "amount", { label: "Current sales" }),
      lagged: agg("partial", "amount", { label: "Lagged sales" }),
    },
    [scatter("newest", "lagged", { title: "Comparing sales" })],
  );
  const rows = await query(`
    SELECT
      (SELECT sum(amount) FROM ${raw("current")} WHERE "at" >= TIMESTAMPTZ '2026-11-01 04:00:00+00' AND "at" < TIMESTAMPTZ '2026-11-04 05:00:00+00') AS x,
      (SELECT sum(amount) FROM ${raw("partial")} WHERE "at" >= TIMESTAMPTZ '2026-11-01 04:00:00+00' AND "at" < TIMESTAMPTZ '2026-11-02 05:00:00+00') AS y,
      (SELECT sum(amount) FROM ${raw("partial")} WHERE "at" >= TIMESTAMPTZ '2026-11-01 04:00:00+00' AND "at" < TIMESTAMPTZ '2026-11-04 05:00:00+00') AS y_if_subtitle_were_true`);
  expect(rows).toEqual([{ x: 70, y: 13, y_if_subtitle_were_true: 113 }]);
  expect(b.points).toEqual([{ key: "A", label: "A", x: 70, y: 13 }]);
  if (data === undefined) throw new Error("no dashboard data");
  const subtitle = renderFragment(data).match(/<\/h2><p>([^<]+)/)?.[1];
  expect(subtitle).not.toMatch(/^Lagged sales against Current sales by market, Nov 1.*3, 2026$/i);
});

it("does not advertise one shared date range for a dated metric and an all-time metric", async () => {
  const { b, data, query, raw } = await check(
    {
      sales:
        "2026-10-29T15:00:00Z,A,300,2,1,paid,Web,US\n" +
        "2026-11-01T15:00:00Z,A,70,1,1,paid,Web,US\n" +
        "2026-11-02T18:00:00Z,A,99,3,1,paid,Web,US\n",
    },
    {
      units: agg("sales", "units", { time: undefined, label: "Units" }),
      sales: agg("sales", "amount", { label: "Revenue" }),
    },
    [scatter("units", "sales", { title: "Comparing sales" })],
  );
  const rows = await query(`
    SELECT sum(units) AS x_all_time,
      sum(units) FILTER (WHERE "at" >= TIMESTAMPTZ '2026-11-01 04:00:00+00' AND "at" < TIMESTAMPTZ '2026-11-02 05:00:00+00') AS x_one_day,
      sum(amount) FILTER (WHERE "at" >= TIMESTAMPTZ '2026-11-01 04:00:00+00' AND "at" < TIMESTAMPTZ '2026-11-02 05:00:00+00') AS y_one_day,
      sum(amount) FILTER (WHERE "at" >= TIMESTAMPTZ '2026-11-01 04:00:00+00' AND "at" < TIMESTAMPTZ '2026-11-06 05:00:00+00') AS y_dashboard_range
    FROM ${raw("sales")}`);
  expect(rows).toEqual([{ x_all_time: 6, x_one_day: 1, y_one_day: 70, y_dashboard_range: 169 }]);
  expect(b.points).toEqual([{ key: "A", label: "A", x: 6, y: 70 }]);
  if (data === undefined) throw new Error("no dashboard data");
  const subtitle = renderFragment(data).match(/<\/h2><p>([^<]+)/)?.[1];
  expect(subtitle).not.toMatch(/^Revenue against Units by market, Nov 1.*5, 2026$/i);
  expect(subtitle).toBe("Revenue against Units by market, Nov 1, 2026, Units over all time");
});

it("says all time, not the dashboard period, when no scatter metric has a time column", async () => {
  const { b, data } = await check(
    {
      sales:
        "2026-10-29T15:00:00Z,A,300,2,1,paid,Web,US\n2026-11-02T18:00:00Z,A,99,3,1,paid,Web,US\n",
    },
    {
      units: agg("sales", "units", { time: undefined, label: "Units" }),
      sales: agg("sales", "amount", { time: undefined, label: "Revenue" }),
    },
    [scatter("units", "sales", { title: "Comparing sales" })],
  );
  expect(b.points).toEqual([{ key: "A", label: "A", x: 5, y: 399 }]);
  expect(b.window).toBeUndefined();
  if (data === undefined) throw new Error("no dashboard data");
  const subtitle = renderFragment(data).match(/<\/h2><p>([^<]+)/)?.[1];
  expect(subtitle).toBe("Revenue against Units by market, all time");
});

it("the HM2024 safe edit and the documented HM5020/HM5021 manual edits clear the warnings", () => {
  const make = (b: unknown) =>
    projectFrom({ dashboards: { sales: { ...DASHBOARD, filters: [], blocks: [b] } } });
  const spec = make(scatter("orders", "orders", { by: "country", size: "orders", span: 2 }));
  const diagnostics = checkReferences(spec);
  expect(diagnostics.map((d) => d.code).sort()).toEqual(["HM2024", "HM5020", "HM5021"]);
  const span = diagnostics.find((d) => d.code === "HM2024");
  expect(span?.fix?.applicability).toBe("safe");
  const sales = spec.dashboards.get("sales");
  if (sales === undefined) throw new Error("sales dashboard missing");
  const fixed = fromYaml(applyFix(sales.document.text, span?.fix)).blocks[0];
  expect(fixed.span).toBe(3);
  fixed.y = "avg_order_value";
  delete fixed.size;
  expect(checkReferences(make(fixed))).toEqual([]);
});

it.each(["x", "y", "size"] as const)(
  "an untimed %s names its scope in the subtitle while dated metrics use the complete-day window",
  async (untimed) => {
    const names = { x: "units", y: "amount", size: "margin" };
    const labels = { x: "Units", y: "Revenue", size: "Margin" };
    const { b, data, query, raw } = await check(
      {
        sales:
          "2026-10-29T15:00:00Z,A,300,2,4,paid,Web,US\n2026-11-01T15:00:00Z,A,70,1,7,paid,Web,US\n2026-11-02T18:00:00Z,A,99,3,8,paid,Web,US\n",
      },
      Object.fromEntries(
        Object.entries(names).map(([axis, name]) => [
          name,
          agg("sales", name, {
            time: axis === untimed ? undefined : "at",
            label: labels[axis as keyof typeof labels],
          }),
        ]),
      ),
      [scatter(names.x, names.y, { size: names.size, title: "Comparing sales" })],
    );
    const where = (axis: keyof typeof names) =>
      axis === untimed
        ? ""
        : `FILTER (WHERE "at" >= TIMESTAMPTZ '2026-11-01 04:00:00+00' AND "at" < TIMESTAMPTZ '2026-11-02 05:00:00+00')`;
    const rows = await query(`
    SELECT market AS key, market AS label, sum(units) ${where("x")} AS x,
      sum(amount) ${where("y")} AS y, sum(margin) ${where("size")} AS size FROM ${raw("sales")}
    GROUP BY market`);
    expect(b.points).toEqual(rows);
    expect(b.window).toEqual({ start: "2026-11-01", end: "2026-11-02" });
    const subtitle = renderFragment(data ?? fail()).match(/<\/h2><p>([^<]+)/)?.[1];
    expect(subtitle).toBe(
      `Revenue against Units by market, Nov 1, 2026, ${labels[untimed]} over all time`,
    );
  },
);

it("distinguishes an untimed axis from the dated cutoff even for an all_time dashboard", async () => {
  const { b, data, query, raw } = await check(
    {
      sales:
        "2026-10-29T15:00:00Z,A,300,2,4,paid,Web,US\n2026-11-01T15:00:00Z,A,70,1,7,paid,Web,US\n2026-11-02T18:00:00Z,A,99,3,8,paid,Web,US\n",
    },
    {
      units: agg("sales", "units", { time: undefined, label: "Units" }),
      amount: agg("sales", "amount", { label: "Revenue" }),
    },
    [scatter("units", "amount", { title: "Comparing sales" })],
    "all_time",
  );
  const rows = await query(`
    SELECT market AS key, market AS label, sum(units) AS x,
      sum(amount) FILTER (WHERE "at" < TIMESTAMPTZ '2026-11-02 05:00:00+00') AS y,
      sum(amount) AS y_all_rows FROM ${raw("sales")} GROUP BY market`);
  expect(rows).toEqual([{ key: "A", label: "A", x: 6, y: 370, y_all_rows: 469 }]);
  expect(b.points).toEqual(rows.map(({ y_all_rows: _, ...point }) => point));
  const subtitle = renderFragment(data ?? fail()).match(/<\/h2><p>([^<]+)/)?.[1];
  expect(subtitle).toMatch(/\bNov [12], 2026\b/);
  expect(subtitle).toContain("Units over all time");
  expect(subtitle).toBe(
    "Revenue against Units by market, through Nov 1, 2026, Units over all time",
  );
  expect(b.through).toBe("2026-11-01");
});

it("the documented explicit limit keeps the highest y values and clears HM5022", async () => {
  const rows510 = Array.from(
    { length: 510 },
    (_, i) => `2026-11-01T15:00:00Z,M${i},${i},1,5,paid,Web,US\n`,
  ).join("");
  const sales = `${rows510}2026-11-04T19:03:00Z,Partial,999,2,99,paid,Web,US\n`;
  const { b, data, diagnostics, query, raw } = await check(
    { sales },
    {
      units: agg("sales", "units"),
      amount: agg("sales", "amount"),
    },
    [scatter("units", "amount"), scatter("units", "amount", { id: "fixed", limit: 20 })],
  );
  const rows = await query(`
    SELECT market AS key, sum(units) AS x, sum(amount) AS y FROM ${raw("sales")}
    WHERE "at" >= TIMESTAMPTZ '2026-11-01 04:00:00+00' AND "at" < TIMESTAMPTZ '2026-11-04 05:00:00+00'
    GROUP BY market ORDER BY y DESC, market`);
  const fixed = data?.blocks[1] as ScatterData;
  expect(b.points.map(({ label: _, ...p }) => p)).toEqual(rows.slice(0, 500));
  expect(b.omittedCategories).toBe(10);
  expect(fixed.points.map(({ label: _, ...p }) => p)).toEqual(rows.slice(0, 20));
  expect(fixed.omittedCategories).toBe(490);
  expect(diagnostics.filter((d) => d.code === "HM5022").map((d) => d.pointer)).toEqual([
    "/blocks/0/by",
  ]);
});
