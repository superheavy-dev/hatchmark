// Adopted from the HAT-59 review of hatchmark#25 (pie and donut): hat-59-review.test.ts. Each case is
// checked against plain SQL on the oracle's own DuckDB, or against the rendered markup.
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { PieData } from "../../src/compiler/index.js";
import { renderDashboardPage } from "../../src/render/index.js";
import { PROJECT_DEFAULTS } from "../../src/spec/index.js";
import { metric, Oracle, removeProjects, run, writeProject } from "./fixture.js";

const category = { type: "donut", metric: "amount", by: "category", limit: 1, id: "share" };
const period = { range: "month_to_date", asOf: "2026-06-03", compare: "none" };
const source = [
  "at,category,segment,status,amount",
  "2026-06-01T04:00:00Z,USA,paid,open,60",
  "2026-06-02T09:00:00Z,Canada,paid,open,30",
  "2026-06-02T10:00:00Z,,paid,open,20",
  "2026-06-02T15:00:00Z,Japan,paid,open,15",
  "2026-06-03T03:59:59Z,France,paid,open,10",
  "2026-06-02T19:00:00Z,Refund,negative,open,-6",
  "2026-06-02T19:05:00Z,Chargeback,negative,open,-4",
  "2026-06-02T20:00:00Z,Zero,paid,open,0",
  "2026-06-02T21:00:00Z,Missing,paid,open,",
  "2026-06-02T22:00:00Z,Voided,paid,void,500",
  "2026-06-03T04:00:00Z,Incomplete,paid,open,900",
  "2026-06-03T17:00:00Z,Incomplete,paid,open,1000",
].join("\n");

const dashboard = (selection?: string) => ({
  title: "Parts",
  period,
  blocks: [category],
  ...(selection
    ? {
        filters: [{ type: "select", id: "segment", column: "segment", default: selection }],
      }
    : {}),
});

let project: Awaited<ReturnType<typeof writeProject>>;
let oracle: Oracle;

beforeAll(async () => {
  project = await writeProject({
    "hatchmark.json": {
      ...PROJECT_DEFAULTS,
      name: "Parts",
      timezone: "America/New_York",
      sources: { orders: { type: "csv", path: "data/orders.csv" } },
    },
    "data/orders.csv": source,
    "metrics/amount.json": metric(
      {
        label: "Revenue",
        type: "aggregate",
        table: "orders",
        time: "at",
        aggregate: "sum",
        column: "amount",
        filters: [{ column: "status", op: "eq", value: "open" }],
      },
      { type: "currency", currency: "USD" },
    ),
    "dashboards/ordinary.json": dashboard(),
    "dashboards/filtered.json": dashboard("paid"),
    "dashboards/negative.json": dashboard("negative"),
    "dashboards/partial.json": {
      ...dashboard(),
      period: { ...period, range: { start: "2026-06-03", end: "2026-06-04" } },
      blocks: [category, { type: "table", by: ["category"], metrics: ["amount"] }],
    },
  });
  oracle = await Oracle.open();
});

afterAll(async () => {
  oracle.close();
  await removeProjects();
});

const read = async (name: string) => {
  const result = await run(project.root, project.project, name);
  expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  expect(result.data?.blocks[0]?.type).toBe("donut");
  return { ...result, pie: result.data?.blocks[0] as PieData };
};

const raw = () => `read_csv('${path.join(project.root, "data/orders.csv")}')`;

it.each(["ordinary", "filtered", "negative"])("matches raw SQL for %s", async (name) => {
  const { pie, diagnostics } = await read(name);
  const segment =
    name === "ordinary" ? "" : `AND segment = '${name === "filtered" ? "paid" : "negative"}'`;
  const query = await oracle.rows(`
    WITH eligible AS (
      SELECT category, amount, status FROM ${raw()}
      WHERE "at" >= TIMESTAMPTZ '2026-06-01 04:00:00+00'
        AND "at" < TIMESTAMPTZ '2026-06-03 04:00:00+00' ${segment}
    ), groups_and_total AS (
      SELECT category, sum(amount) FILTER (WHERE status = 'open') AS v, grouping(category) AS total_row
      FROM eligible GROUP BY ROLLUP(category)
    ), ranked AS (
      SELECT *, row_number() OVER (ORDER BY v DESC NULLS LAST, category NULLS LAST) AS rank
      FROM groups_and_total WHERE total_row = 0 AND v > 0
    )
    SELECT
      (SELECT category FROM ranked WHERE rank = 1) AS head_key,
      (SELECT v FROM ranked WHERE rank = 1) AS head,
      (SELECT sum(v) FROM ranked) AS whole,
      (SELECT sum(v) FROM ranked WHERE rank > 1) AS other,
      (SELECT count(*) FROM ranked WHERE rank > 1) AS other_count,
      (SELECT v FROM groups_and_total WHERE total_row = 1) AS total,
      (SELECT count(*) FROM groups_and_total WHERE total_row = 0 AND (v IS NULL OR v = 0)) AS empty,
      (SELECT count(*) FROM groups_and_total WHERE total_row = 0 AND v < 0) AS negative
  `);
  const expected = query[0] as Record<string, unknown>;
  expect(pie.window).toEqual({ start: "2026-06-01", end: "2026-06-03" });
  expect(pie.total).toBe(expected.total);
  expect(pie.whole).toBe(expected.whole ?? 0);
  expect(pie.excluded?.empty ?? 0).toBe(expected.empty);
  expect(pie.excluded?.negative.length ?? 0).toBe(expected.negative);
  if (expected.head !== null) {
    expect(pie.slices).toHaveLength(1);
    expect(pie.slices[0]).toMatchObject({ key: expected.head_key, value: expected.head });
    expect(pie.slices[0]?.share).toBeCloseTo(Number(expected.head) / Number(expected.whole), 12);
    expect(pie.other).toMatchObject({ count: expected.other_count, value: expected.other });
    expect(pie.other?.share).toBeCloseTo(Number(expected.other) / Number(expected.whole), 12);
  } else {
    expect(pie.slices).toEqual([]);
    expect(pie.other).toBeUndefined();
  }
  expect(diagnostics.some((d) => d.code === "HM4061")).toBe(Number(expected.negative) > 0);
  expect(diagnostics.some((d) => d.code === "HM5011")).toBe(
    Number(expected.other) > Number(expected.head),
  );
});

it("uses no total value when the window has no complete day", async () => {
  const { data, pie, diagnostics } = await read("partial");
  const [{ n } = {}] = await oracle.rows(`
    SELECT count(*) AS n FROM ${raw()} WHERE "at" >= TIMESTAMPTZ '2026-06-03 04:00:00+00'
      AND "at" < TIMESTAMPTZ '2026-06-04 04:00:00+00'
  `);
  expect(n).toBe(2);
  expect(diagnostics).toContainEqual(
    expect.objectContaining({ code: "HM4024", pointer: "/blocks/0" }),
  );
  expect(data?.blocks[1]).toMatchObject({
    empty: "no_complete_day",
    total: { values: { amount: null } },
  });
  expect(pie.slices).toEqual([]);
  expect(pie.total).toBeNull();
  expect(pie).toMatchObject({ empty: "no_complete_day" });
  const html = renderDashboardPage(data as NonNullable<typeof data>, {
    assets: { runtime: "", fonts: {} },
  });
  const markup = html.match(/<section class="hm-card hm-donut".*?<\/section>/s)?.[0];
  expect(markup).toBeDefined();
  expect(markup).not.toContain("Jun 3 – Jun 2, 2026");
});

it("HM4061 explains that negative categories are excluded, not misnormalised", async () => {
  const { pie, diagnostics } = await read("ordinary");
  expect((pie.slices[0]?.share ?? 0) + (pie.other?.share ?? 0)).toBeCloseTo(1, 12);
  const d = diagnostics.find((entry) => entry.code === "HM4061");
  expect(d?.pointer).toBe("/blocks/0/metric");
  expect(d?.message).toMatch(/leav|exclud|omit/i);
  expect(d?.message).not.toContain("do not add up to 100%");
});

it("on an all-negative donut, states the real total and what it left out instead of no data", async () => {
  const { data, pie } = await read("negative");
  expect(pie.total).toBe(-10);
  const html = renderDashboardPage(data as NonNullable<typeof data>, {
    assets: { runtime: "", fonts: {} },
  });
  const card = html.match(/<section class="hm-card hm-donut".*?<\/section>/s)?.[0] ?? "";
  const svg = card.match(/<svg[^>]*data-hm-kind="pie".*?<\/svg>/s)?.[0] ?? "";
  const text = [...svg.matchAll(/<text[^>]*>(?:<title>[^<]*<\/title>)?([^<]*)<\/text>/g)]
    .map((m) => m[1])
    .join(" ");
  expect(text).toMatch(/[-\u2212]\$10/);
  expect(text).not.toContain("No revenue in this period");
  expect(card).toContain("Chargeback");
  expect(card).not.toContain("no data in this period");
});

it("wraps long key names instead of shortening them (gallery donut-long-labels)", async () => {
  const { GALLERY } = await import("../../gallery/variants.js");
  const { renderChartSvg } = await import("../../src/render/index.js");
  const data = GALLERY.find((v) => v.variant === "donut-long-labels")?.data;
  if (!data) throw new Error("no donut-long-labels variant");
  for (let width = 300; width <= 1200; width += 10) {
    const svg = renderChartSvg(data.blocks[0] as PieData, data, { width });
    expect(svg, `width ${width}`).not.toContain("\u2026");
  }
});
