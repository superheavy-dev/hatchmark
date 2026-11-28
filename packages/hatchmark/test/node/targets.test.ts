import { afterAll, describe, expect, it, vi } from "vitest";
import type { BarData, DashboardData, KpiData, LineData } from "../../src/compiler/index.js";
import { explainDefaults } from "../../src/compiler/index.js";
import { checkReferences, PROJECT_DEFAULTS } from "../../src/spec/index.js";
import { metric, removeProjects, run, writeProject } from "./fixture.js";

vi.setConfig({ testTimeout: 120_000 });

afterAll(removeProjects);

function days(from: string, to: string): string[] {
  const out: string[] = [];
  for (
    let t = Date.parse(`${from}T00:00:00Z`);
    t < Date.parse(`${to}T00:00:00Z`);
    t += 86_400_000
  ) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

const ORDERS = [
  "day,region,amount",
  ...days("2026-01-01", "2026-03-16").map((d, i) => `${d},${i % 2 === 0 ? "Americas" : "EMEA"},10`),
].join("\n");

const PLAN = [
  "month,region,amount",
  "2026-01-01,Americas,155",
  "2026-01-01,EMEA,155",
  "2026-02-01,Americas,140",
  "2026-02-01,EMEA,140",
  "2026-03-01,Americas,155",
  "2026-03-01,EMEA,155",
].join("\n");

const INLINE = { "2026-01-01": 310, "2026-02-01": 280, "2026-03-01": 310 };

function files(blocks: unknown[], extra: Record<string, unknown> = {}) {
  return {
    "hatchmark.yaml": {
      ...PROJECT_DEFAULTS,
      name: "targets",
      sources: {
        orders: { type: "csv", path: "data/orders.csv" },
        plan: { type: "csv", path: "data/plan.csv" },
      },
    },
    "data/orders.csv": ORDERS,
    "data/plan.csv": PLAN,
    "segments/americas.yaml": {
      label: "Americas",
      filters: [{ column: "region", op: "eq", value: "Americas" }],
    },
    "metrics/revenue.yaml": metric({
      type: "aggregate",
      table: "orders",
      aggregate: "sum",
      column: "amount",
      time: "day",
      targets: [
        { id: "plan", grain: "month", table: "plan", date: "month", value: "amount" },
        { id: "inline", label: "Inline plan", grain: "month", values: INLINE },
        { id: "whole", grain: "month", prorate: "none", values: INLINE },
        { id: "gap", grain: "month", values: { "2026-01-01": 310, "2026-03-01": 310 } },
        { id: "set", grain: "month", values: INLINE, segments: ["americas"] },
      ],
    }),
    "metrics/average.yaml": metric({
      type: "aggregate",
      table: "orders",
      aggregate: "avg",
      column: "amount",
      time: "day",
      targets: [{ id: "avg", grain: "month", values: { "2026-03-01": 10 } }],
    }),
    "dashboards/d.yaml": {
      title: "D",
      period: { asOf: "2026-03-15", range: "month_to_date", compare: "none" },
      blocks,
      ...extra,
    },
  };
}

async function build(blocks: unknown[], extra: Record<string, unknown> = {}) {
  const { root, project } = await writeProject(files(blocks, extra));
  const result = await run(root, project, "d");
  return { project, data: result.data as DashboardData, diagnostics: result.diagnostics };
}

const kpi = (data: DashboardData, id: string) => data.blocks.find((b) => b.id === id) as KpiData;
const chart = <T extends LineData | BarData>(data: DashboardData, id: string) =>
  data.blocks.find((b) => b.id === id) as T;

describe("target windows", () => {
  it("month to date: the month's target with a pace by elapsed days", async () => {
    const { data } = await build([{ type: "kpi", id: "k", metric: "revenue", target: "inline" }]);
    expect(kpi(data, "k").target).toEqual({
      id: "inline",
      label: "Inline plan",
      value: 310,
      pace: 150,
      attainment: 1,
    });
  });

  it("prorates at the edges of a last-N-days window and notes it", async () => {
    const { data, diagnostics } = await build([], {
      period: { asOf: "2026-03-15", range: "last_30_days", compare: "none" },
      blocks: [{ type: "kpi", id: "k", metric: "revenue", target: "inline" }],
    });
    const target = kpi(data, "k").target;
    expect(target?.value).toBeCloseTo((280 * 15) / 28 + (310 * 15) / 31, 9);
    expect(target?.pace).toBeUndefined();
    expect(diagnostics.some((d) => d.code === "HM4022" && d.pointer === "/blocks/0/target")).toBe(
      true,
    );
  });

  it("trims an explicit range by whole days", async () => {
    const { data } = await build([], {
      period: {
        asOf: "2026-03-15",
        range: { start: "2026-03-01", end: "2026-04-01" },
        compare: "none",
      },
      blocks: [{ type: "kpi", id: "k", metric: "revenue", target: "plan" }],
    });
    expect(kpi(data, "k").target).toMatchObject({ value: 310, pace: 150, attainment: 1 });
  });

  it("gives no target and warns when the window crosses a missing month", async () => {
    const { data, diagnostics } = await build([], {
      period: { asOf: "2026-03-15", range: "last_90_days", compare: "none" },
      blocks: [{ type: "kpi", id: "k", metric: "revenue", target: "gap" }],
    });
    expect(kpi(data, "k").target).toMatchObject({ value: null, attainment: null });
    const warning = diagnostics.find((d) => d.code === "HM4020");
    expect(warning).toMatchObject({ severity: "warning", pointer: "/blocks/0/target" });
  });

  it("keeps a whole-month target whole: none over a window that splits a month", async () => {
    const { data } = await build([], {
      period: { asOf: "2026-03-15", range: "last_30_days", compare: "none" },
      blocks: [{ type: "kpi", id: "k", metric: "revenue", target: "whole" }],
    });
    expect(kpi(data, "k").target?.value).toBeNull();
  });
});

describe("target series", () => {
  it("sums months into a quarter, with the pace of the partial quarter", async () => {
    const { data } = await build([], {
      period: { asOf: "2026-03-15", range: "year_to_date", compare: "none" },
      blocks: [{ type: "line", id: "l", metrics: ["revenue"], grain: "quarter", target: "inline" }],
    });
    const series = chart<LineData>(data, "l").series[0];
    expect(series?.target?.values).toEqual([900]);
    expect(series?.partial?.[0]?.elapsed).toBe(0.822222);
    expect(series?.target?.pace?.[0]).toBeCloseTo((900 * 74) / 90, 9);
  });

  it("shows no quarter when one of its months has no target", async () => {
    const { data, diagnostics } = await build([], {
      period: { asOf: "2026-03-15", range: "year_to_date", compare: "none" },
      blocks: [{ type: "line", id: "l", metrics: ["revenue"], grain: "quarter", target: "gap" }],
    });
    expect(chart<LineData>(data, "l").series[0]?.target?.values).toEqual([null]);
    expect(diagnostics.some((d) => d.code === "HM4020")).toBe(true);
  });

  it("prorates months into weeks by days", async () => {
    const { data } = await build([], {
      period: {
        asOf: "2026-03-15",
        range: { start: "2026-01-26", end: "2026-02-09" },
        compare: "none",
      },
      blocks: [{ type: "line", id: "l", metrics: ["revenue"], grain: "week", target: "inline" }],
    });
    const line = chart<LineData>(data, "l");
    expect(line.axis.buckets).toEqual(["2026-01-26", "2026-02-02"]);
    const [a, b] = line.series[0]?.target?.values ?? [];
    expect(a).toBeCloseTo((310 * 6) / 31 + (280 * 1) / 28, 9);
    expect(b).toBeCloseTo((280 * 7) / 28, 9);
  });

  it("hides a prorate: none target at a finer grain", async () => {
    const { data } = await build([
      { type: "line", id: "l", metrics: ["revenue"], grain: "week", target: "whole" },
    ]);
    const line = chart<LineData>(data, "l");
    expect(line.target).toEqual({
      id: "whole",
      label: "whole",
      metric: "revenue",
      hidden: "grain",
    });
    expect(line.series[0]?.target).toBeUndefined();
  });

  it("gives each split series its target from the table's split column", async () => {
    const { data } = await build([
      {
        type: "bar",
        id: "b",
        metrics: ["revenue"],
        grain: "month",
        split: "region",
        target: "plan",
      },
    ]);
    const bar = chart<BarData>(data, "b");
    expect(bar.target?.values).toEqual([310]);
    expect(Object.fromEntries(bar.series.map((s) => [s.label, s.target?.values]))).toEqual({
      Americas: [155],
      EMEA: [155],
    });
  });

  it("per category when the target's table has the by column, else over the window", async () => {
    const { data } = await build([
      { type: "bar", id: "per", metrics: ["revenue"], by: "region", target: "plan" },
      { type: "bar", id: "total", metrics: ["revenue"], by: "region", target: "inline" },
    ]);
    const per = chart<BarData>(data, "per");
    expect(per.series[0]?.target).toEqual({ values: [155, 155], pace: [75, 75] });
    expect(chart<BarData>(data, "total").target?.window).toEqual({ value: 310, pace: 150 });
  });

  it("shows a non-additive flow target only at its own grain", async () => {
    const { data } = await build([
      { type: "line", id: "m", metrics: ["average"], grain: "month", target: "avg" },
      { type: "line", id: "q", metrics: ["average"], grain: "quarter", target: "avg" },
    ]);
    expect(chart<LineData>(data, "m").series[0]?.target?.values).toEqual([10]);
    expect(chart<LineData>(data, "q").series[0]?.target?.values).toEqual([null]);
  });
});

describe("targets under filters and segments", () => {
  it("filters a table target with a select filter and hides an inline one", async () => {
    const { data } = await build(
      [
        { type: "kpi", id: "table", metric: "revenue", target: "plan" },
        { type: "kpi", id: "inline", metric: "revenue", target: "inline" },
      ],
      {
        filters: [{ type: "select", id: "region", column: "region", default: "Americas" }],
      },
    );
    expect(kpi(data, "table").target).toMatchObject({ value: 155, pace: 75 });
    expect(kpi(data, "inline").target).toEqual({
      id: "inline",
      label: "Inline plan",
      value: null,
      attainment: null,
      hidden: "filter",
    });
  });

  it("follows a segment toggle on a table target, keeps one set for it, hides the rest", async () => {
    const { data } = await build(
      [
        { type: "kpi", id: "table", metric: "revenue", target: "plan" },
        { type: "kpi", id: "set", metric: "revenue", target: "set" },
        { type: "kpi", id: "inline", metric: "revenue", target: "inline" },
      ],
      {
        filters: [{ type: "segment", id: "seg", segments: ["americas"], default: ["americas"] }],
      },
    );
    expect(kpi(data, "table").target).toMatchObject({ value: 155 });
    expect(kpi(data, "set").target).toMatchObject({ value: 310 });
    expect(kpi(data, "inline").target?.hidden).toBe("segment");
  });
});

describe("target checks", () => {
  it("HM2022 for an unknown target id, with a did-you-mean", async () => {
    const { project } = await writeProject(
      files([{ type: "kpi", id: "k", metric: "revenue", target: "plann" }]),
    );
    const found = checkReferences(project).find((d) => d.code === "HM2022");
    expect(found).toMatchObject({
      severity: "error",
      pointer: "/blocks/0/target",
      help: 'did you mean "plan"?',
    });
  });

  it("HM4021 ahead of time for a filter or segment the target cannot follow", async () => {
    const { project } = await writeProject(
      files([{ type: "kpi", id: "k", metric: "revenue", target: "inline" }], {
        filters: [
          { type: "select", id: "region", column: "region" },
          { type: "segment", id: "seg", segments: ["americas"] },
        ],
      }),
    );
    const found = checkReferences(project).filter((d) => d.code === "HM4021");
    expect(found.map((d) => [d.severity, d.pointer])).toEqual([
      ["warning", "/blocks/0/target"],
      ["warning", "/blocks/0/target"],
    ]);
  });

  it("HM4040 for the default flow prorate and point-in-time path, silenced when set", async () => {
    const project = (
      await writeProject({
        ...files([
          { type: "kpi", id: "a", metric: "revenue", target: "plan" },
          { type: "kpi", id: "b", metric: "revenue", target: "whole" },
          { type: "line", id: "c", metrics: ["revenue"], grain: "week", target: "plan" },
          { type: "kpi", id: "d", metric: "balance", target: "goal" },
          { type: "kpi", id: "e", metric: "balance", target: "steep" },
        ]),
        "metrics/balance.yaml": metric({
          type: "aggregate",
          table: "orders",
          aggregate: "sum",
          column: "amount",
          time: "day",
          over_time: "last",
          targets: [
            { id: "goal", grain: "month", values: INLINE },
            { id: "steep", grain: "month", values: INLINE, path: "compound" },
          ],
        }),
      })
    ).project;
    const notes = explainDefaults(project)
      .filter((d) => d.pointer?.startsWith("/targets/"))
      .map((d) => [d.code, d.file, d.pointer, d.message.split(":")[0]]);
    expect(notes).toEqual([
      ["HM4040", "metrics/revenue.yaml", "/targets/0", 'target "plan" uses prorate'],
      ["HM4040", "metrics/balance.yaml", "/targets/0", 'target "goal" uses path'],
    ]);
  });

  it("no HM4021 for a table target that has the columns", async () => {
    const { project } = await writeProject(
      files([{ type: "kpi", id: "k", metric: "revenue", target: "plan" }], {
        filters: [
          { type: "select", id: "region", column: "region" },
          { type: "segment", id: "seg", segments: ["americas"] },
        ],
      }),
    );
    expect(checkReferences(project).filter((d) => d.code === "HM4021")).toEqual([]);
  });
});
