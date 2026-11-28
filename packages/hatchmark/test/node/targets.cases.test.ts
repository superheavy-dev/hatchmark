import { mkdir } from "node:fs/promises";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  type BarData,
  type DashboardData,
  explainDefaults,
  type KpiData,
  type LineData,
  pointTarget,
} from "../../src/compiler/index.js";
import { parseInstant } from "../../src/compiler/instants.js";
import { PROJECT_DEFAULTS } from "../../src/spec/index.js";
import { loadAt, metric, Oracle, removeProjects, run, writeProject } from "./fixture.js";

vi.setConfig({ testTimeout: 120_000 });
afterAll(removeProjects);

function days(from: string, to: string): string[] {
  const out: string[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t < Date.parse(`${to}T00:00:00Z`); t += 86_400_000)
    out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}
const ORDERS = [
  "day,region,channel,amount",
  ...days("2026-01-01", "2026-03-16").map(
    (d, i) =>
      d +
      "," +
      (i % 2 === 0 ? "Americas" : "EMEA") +
      "," +
      (i % 3 === 0 ? "online" : "retail") +
      ",10",
  ),
].join("\n");

async function build(
  extra: Record<string, unknown>,
  blocks: unknown[],
  dash: Record<string, unknown> = {},
  tz = "UTC",
) {
  const { root } = await writeProject({
    "hatchmark.yaml": {
      ...PROJECT_DEFAULTS,
      name: "edge",
      timezone: tz,
      sources: {
        orders: { type: "csv", path: "data/orders.csv" },
        plan: { type: "csv", path: "data/plan.csv" },
        ...(extra.sources as object),
      },
    },
    "data/orders.csv": ORDERS,
    "data/plan.csv": extra.plan ?? "month,region,amount\n2026-01-01,Americas,155",
    "segments/am_online.yaml": {
      label: "Americas online",
      filters: [
        { column: "region", op: "eq", value: "Americas" },
        { column: "channel", op: "eq", value: "online" },
      ],
    },
    "metrics/revenue.yaml": metric({
      type: "aggregate",
      table: "orders",
      aggregate: "sum",
      column: "amount",
      time: "day",
      targets: extra.targets,
    }),
    "metrics/average.yaml": metric({
      type: "aggregate",
      table: "orders",
      aggregate: "avg",
      column: "amount",
      time: "day",
      targets: extra.avgTargets ?? [],
    }),
    "dashboards/d.yaml": {
      title: "D",
      period: { asOf: "2026-03-15", range: "month_to_date", compare: "none" },
      blocks,
      ...dash,
    },
    ...((extra.files as object) ?? {}),
  });
  if (extra.parquet) await (extra.parquet as (root: string) => Promise<void>)(root);
  const { project } = await loadAt(root);
  const result = await run(root, project, "d");
  if (result.data === undefined)
    console.log("NO DATA", JSON.stringify(result.diagnostics.map((d) => `${d.code} ${d.message}`)));
  return { data: result.data as DashboardData, diagnostics: result.diagnostics };
}
const block = <T>(data: DashboardData, id: string) => data.blocks.find((b) => b.id === id) as T;

describe("target edge cases", () => {
  it("reads a TIMESTAMPTZ target date column in a non-UTC project", async () => {
    const { data, diagnostics } = await build(
      {
        sources: { tplan: { type: "parquet", path: "data/tplan.parquet" } },
        targets: [{ id: "t", grain: "month", table: "tplan", date: "month", value: "amount" }],
        parquet: async (root: string) => {
          const db = await Oracle.open();
          await mkdir(path.join(root, "data"), { recursive: true });
          await db.run(
            "CREATE TABLE t AS SELECT timezone('Asia/Seoul', TIMESTAMP '2026-03-01 00:00:00') AS month, 310.0 AS amount UNION ALL SELECT timezone('Asia/Seoul', TIMESTAMP '2026-02-01 00:00:00'), 280.0",
          );
          await db.run(`COPY t TO '${path.join(root, "data", "tplan.parquet")}' (FORMAT parquet)`);
          db.close();
        },
      },
      [{ type: "kpi", id: "k", metric: "revenue", target: "t" }],
      {},
      "Asia/Seoul",
    );
    expect(block<KpiData>(data, "k").target).toMatchObject({ value: 310, pace: 150 });
    expect(diagnostics.map((d) => d.code)).toEqual([]);
  });

  it("hides a table target under a two-column segment the table has one column of", async () => {
    const { data, diagnostics } = await build(
      {
        plan: "month,channel,amount\n2026-03-01,online,100\n2026-03-01,retail,210",
        targets: [{ id: "t", grain: "month", table: "plan", date: "month", value: "amount" }],
      },
      [{ type: "kpi", id: "k", metric: "revenue", target: "t" }],
      {
        filters: [{ type: "segment", id: "seg", segments: ["am_online"], default: ["am_online"] }],
      },
    );
    expect(block<KpiData>(data, "k").target).toMatchObject({ value: null, hidden: "segment" });
    expect(diagnostics.map((d) => d.code)).toEqual([]);
  });

  it("keeps the target under a select filter on a column only the target table has", async () => {
    const { data, diagnostics } = await build(
      {
        plan: "month,owner,amount\n2026-03-01,ann,100\n2026-03-01,bob,210",
        targets: [{ id: "t", grain: "month", table: "plan", date: "month", value: "amount" }],
      },
      [{ type: "kpi", id: "k", metric: "revenue", target: "t" }],
      { filters: [{ type: "select", id: "owner", column: "owner", default: "ann" }] },
    );
    expect(block<KpiData>(data, "k").target).toEqual({
      id: "t",
      label: "t",
      value: 310,
      pace: 150,
      attainment: 1,
    });
    expect(diagnostics.map((d) => d.code)).toEqual([]);
  });

  it("gives a non-additive metric's target no pace in a partial month", async () => {
    const { data, diagnostics } = await build(
      { targets: [], avgTargets: [{ id: "a", grain: "month", values: { "2026-03-01": 10 } }] },
      [
        { type: "kpi", id: "k", metric: "average", target: "a" },
        { type: "line", id: "l", metrics: ["average"], grain: "month", target: "a" },
      ],
    );
    expect(block<KpiData>(data, "k").value).toBe(10);
    expect(block<KpiData>(data, "k").target).toEqual({
      id: "a",
      label: "a",
      value: 10,
      attainment: 1,
    });
    expect(block<LineData>(data, "l").series[0]?.target).toEqual({ values: [10] });
    expect(diagnostics.map((d) => d.code)).toEqual([]);
  });

  it("rejects prorate days on a non-additive metric at a finer grain", async () => {
    const { data, diagnostics } = await build(
      {
        targets: [],
        avgTargets: [{ id: "a", grain: "month", prorate: "days", values: { "2026-03-01": 10 } }],
      },
      [{ type: "line", id: "l", metrics: ["average"], grain: "week", target: "a" }],
    );
    expect(data).toBeUndefined();
    expect(diagnostics.map((d) => d.code)).toContain("HM3007");
  });

  it("targets an area block and a bar with both by and split", async () => {
    const { data, diagnostics } = await build(
      {
        plan: "month,region,channel,amount\n2026-03-01,Americas,online,100\n2026-03-01,EMEA,online,210\n2026-03-01,Americas,retail,1\n2026-03-01,EMEA,retail,2",
        targets: [{ id: "t", grain: "month", table: "plan", date: "month", value: "amount" }],
      },
      [
        { type: "area", id: "a", metrics: ["revenue"], grain: "week", target: "t" },
        { type: "bar", id: "b", metrics: ["revenue"], by: "region", split: "channel", target: "t" },
      ],
    );
    const b = block<BarData>(data, "b");
    const area = block<LineData>(data, "a").series[0]?.target;
    expect(area?.values[0]).toBeNull();
    expect(area?.values[1]).toBeCloseTo((313 * 7) / 31, 9);
    expect(b.axis.kind === "category" && b.axis.categories).toEqual(["EMEA", "Americas"]);
    expect(b.series.map((s) => [s.label, s.target?.values])).toEqual([
      ["retail", [2, 1]],
      ["online", [210, 100]],
    ]);
    expect(b.target?.values).toEqual([212, 101]);
    expect(b.target?.pace?.[0]).toBeCloseTo((212 * 15) / 31, 9);
    expect(diagnostics.map((d) => d.code).sort()).toEqual(["HM4020", "HM4022"]);
  });

  it("shows no target for last_complete_month when only a later month has one", async () => {
    const { data, diagnostics } = await build(
      { targets: [{ id: "t", grain: "month", values: { "2026-03-01": 310 } }] },
      [{ type: "kpi", id: "k", metric: "revenue", target: "t" }],
      { period: { asOf: "2026-03-15", range: "last_complete_month", compare: "none" } },
    );
    expect(block<KpiData>(data, "k").target).toEqual({
      id: "t",
      label: "t",
      value: null,
      attainment: null,
    });
    expect(diagnostics.map((d) => d.code)).toEqual(["HM4020"]);
  });

  it("skips a plan row with an empty value in a bucket", async () => {
    const { data } = await build(
      {
        plan: "month,region,amount\n2026-03-01,Americas,155\n2026-03-01,EMEA,",
        targets: [{ id: "t", grain: "month", table: "plan", date: "month", value: "amount" }],
      },
      [{ type: "kpi", id: "k", metric: "revenue", target: "t" }],
    );
    expect(block<KpiData>(data, "k").target).toMatchObject({ value: 155 });
  });

  it("reads a compound target's own value at its instant after a non-positive one", () => {
    const values = new Map([
      ["2026-01-01", 0],
      ["2026-02-01", 100],
    ]);
    const grain = { unit: "month" } as const;
    expect(pointTarget(values, { grain, path: "compound" }, parseInstant("2026-02-01"))).toBe(0);
    expect(pointTarget(values, { grain, path: "compound" }, parseInstant("2026-02-15"))).toBeNull();
    expect(pointTarget(values, { grain, path: "compound" }, parseInstant("2026-03-01"))).toBe(100);
  });

  it("keeps an inline target under a select filter with no default", async () => {
    const { data } = await build(
      { targets: [{ id: "t", grain: "month", values: { "2026-03-01": 310 } }] },
      [{ type: "kpi", id: "k", metric: "revenue", target: "t" }],
      { filters: [{ type: "select", id: "region", column: "region" }] },
    );
    expect(block<KpiData>(data, "k").target).toEqual({
      id: "t",
      label: "t",
      value: 310,
      pace: 150,
      attainment: 1,
    });
  });

  it("notes HM4022 at a category bar's own block when its window splits a month", async () => {
    const { diagnostics } = await build(
      {
        plan: "month,region,amount\n2026-02-01,Americas,140\n2026-02-01,EMEA,140\n2026-03-01,Americas,155\n2026-03-01,EMEA,155",
        targets: [{ id: "t", grain: "month", table: "plan", date: "month", value: "amount" }],
      },
      [
        { type: "kpi", id: "k", metric: "revenue" },
        { type: "bar", id: "b", metrics: ["revenue"], by: "region", target: "t" },
      ],
      { period: { asOf: "2026-03-15", range: "last_30_days", compare: "none" } },
    );
    expect(diagnostics.filter((d) => d.code === "HM4022").map((d) => d.pointer)).toEqual([
      "/blocks/1/target",
    ]);
  });

  it("gives no HM4040 prorate note for a metric that doesn't add up over time", async () => {
    const { root } = await writeProject({
      "hatchmark.yaml": {
        ...PROJECT_DEFAULTS,
        name: "edge",
        sources: { orders: { type: "csv", path: "data/orders.csv" } },
      },
      "data/orders.csv": ORDERS,
      "metrics/average.yaml": metric({
        type: "aggregate",
        table: "orders",
        aggregate: "avg",
        column: "amount",
        time: "day",
        targets: [{ id: "a", grain: "month", values: { "2026-03-01": 10 } }],
      }),
      "dashboards/d.yaml": {
        title: "D",
        period: { asOf: "2026-03-15", range: "month_to_date", compare: "none" },
        blocks: [{ type: "kpi", id: "k", metric: "average", target: "a" }],
      },
    });
    const { project } = await loadAt(root);
    expect(explainDefaults(project).filter((d) => d.pointer?.startsWith("/targets/"))).toEqual([]);
  });
});
