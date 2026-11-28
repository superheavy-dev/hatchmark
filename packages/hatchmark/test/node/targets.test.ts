import { afterAll, describe, expect, it, vi } from "vitest";
import { run as cli } from "../../src/cli/main.js";
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

function files(
  blocks: unknown[],
  extra: Record<string, unknown> = {},
  sources: Record<string, unknown> = {},
) {
  return {
    "hatchmark.yaml": {
      ...PROJECT_DEFAULTS,
      name: "targets",
      sources: {
        orders: { type: "csv", path: "data/orders.csv" },
        plan: { type: "csv", path: "data/plan.csv" },
        ...sources,
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

async function build(
  blocks: unknown[],
  extra: Record<string, unknown> = {},
  more: Record<string, unknown> = {},
  sources: Record<string, unknown> = {},
) {
  const { root, project } = await writeProject({ ...files(blocks, extra, sources), ...more });
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
    expect(per.series[0]?.target).toEqual({
      values: [155, 155],
      pace: [75, 75],
      attainment: per.series[0]?.values.map((v) => (v as number) / 75),
    });
    expect(chart<BarData>(data, "total").target?.window).toEqual({
      value: 310,
      pace: 150,
      attainment: 1,
    });
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

describe("target edge cases", () => {
  it("reads a last-N-days window by local dates across a midnight DST change", async () => {
    const orders = [
      "day,region,amount",
      ...days("2024-10-20", "2024-11-10").map((d) => `${d},Americas,10`),
    ].join("\n");
    for (const asOf of ["2024-11-02", "2024-11-09"]) {
      const { root, project } = await writeProject({
        ...files([]),
        "hatchmark.yaml": {
          ...PROJECT_DEFAULTS,
          name: "targets",
          timezone: "America/Havana",
          sources: { orders: { type: "csv", path: "data/orders.csv" } },
        },
        "data/orders.csv": orders,
        "metrics/revenue.yaml": metric({
          type: "aggregate",
          table: "orders",
          aggregate: "sum",
          column: "amount",
          time: "day",
          targets: [
            { id: "plan", grain: "month", values: { "2024-10-01": 310, "2024-11-01": 300 } },
          ],
        }),
        "metrics/average.yaml": metric({
          type: "aggregate",
          table: "orders",
          aggregate: "avg",
          column: "amount",
          time: "day",
        }),
        "dashboards/d.yaml": {
          title: "D",
          period: { asOf, range: "last_7_days", compare: "none" },
          blocks: [{ type: "kpi", id: "k", metric: "revenue", target: "plan" }],
        },
      });
      const data = (await run(root, project, "d")).data as DashboardData;
      expect([asOf, kpi(data, "k").target]).toEqual([
        asOf,
        expect.objectContaining({ value: expect.closeTo(70, 9), attainment: expect.closeTo(1, 9) }),
      ]);
    }
  });

  it("gives a bucket whose value rows are all empty no value, and keeps an explicit 0", async () => {
    const plan = (feb: string) =>
      [
        "month,region,amount",
        "2026-01-01,Americas,100",
        `2026-02-01,Americas,${feb}`,
        `2026-02-01,EMEA,${feb}`,
      ].join("\n");
    const period = { asOf: "2026-03-15", range: "last_complete_month", compare: "none" };
    const blocks = [{ type: "kpi", id: "k", metric: "revenue", target: "plan" }];
    const empty = await build(blocks, { period }, { "data/plan.csv": plan("") });
    expect(kpi(empty.data, "k").target).toMatchObject({ value: null, attainment: null });
    expect(empty.diagnostics.some((d) => d.code === "HM4020")).toBe(true);
    const zero = await build(blocks, { period }, { "data/plan.csv": plan("0") });
    expect(kpi(zero.data, "k").target).toMatchObject({ value: 0, attainment: null });
    expect(zero.diagnostics.some((d) => d.code === "HM4020")).toBe(false);
  });

  it("warns with HM4023 at the target for a lookup target table and keeps the numbers", async () => {
    const { data, diagnostics } = await build(
      [{ type: "kpi", id: "k", metric: "revenue", target: "joined" }],
      {},
      {
        "data/regions.csv": "region,manager\nAmericas,Ana\nEMEA,Eli",
        "metrics/revenue.yaml": metric({
          type: "aggregate",
          table: "orders",
          aggregate: "sum",
          column: "amount",
          time: "day",
          targets: [
            {
              id: "joined",
              grain: "month",
              table: "plan_by_manager",
              date: "month",
              value: "amount",
            },
          ],
        }),
      },
      {
        regions: { type: "csv", path: "data/regions.csv" },
        plan_by_manager: {
          type: "lookup",
          from: "plan",
          lookups: [{ table: "regions", key: { region: "region" } }],
        },
      },
    );
    expect(kpi(data, "k").value).toBe(150);
    expect(kpi(data, "k").target).toBeUndefined();
    expect(diagnostics.find((d) => d.code === "HM4023")).toMatchObject({
      severity: "warning",
      pointer: "/blocks/0/target",
    });
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

  it("HM4022 from check alone for a grain finer than the target, worded as build words it", async () => {
    const blocks = [
      { type: "line", id: "daily", metrics: ["revenue"], grain: "day", target: "inline" },
      { type: "line", id: "monthly", metrics: ["revenue"], grain: "month", target: "inline" },
      {
        type: "bar",
        id: "switch",
        metrics: ["revenue"],
        grain: "month",
        grains: ["month", "week"],
        target: "inline",
      },
      { type: "line", id: "whole", metrics: ["revenue"], grain: "day", target: "gap" },
      { type: "line", id: "none", metrics: ["revenue"], grain: "day", target: "whole" },
      { type: "line", id: "avg", metrics: ["average"], grain: "day", target: "avg" },
    ];
    const { project } = await writeProject(files(blocks));
    const notes = checkReferences(project).filter((d) => d.code === "HM4022");
    expect(notes.map((d) => [d.severity, d.pointer])).toEqual([
      ["note", "/blocks/0/target"],
      ["note", "/blocks/2/target"],
      ["note", "/blocks/3/target"],
    ]);
    const built = (await build(blocks)).diagnostics.filter((d) => d.code === "HM4022");
    expect(built.find((d) => d.pointer === "/blocks/0/target")).toEqual(notes[0]);
  });

  it("hatchmark check --json reports HM4022 for a day-grain block on a monthly target", async () => {
    const { root } = await writeProject(
      files([{ type: "line", id: "l", metrics: ["revenue"], grain: "day", target: "inline" }]),
    );
    let stdout = "";
    const code = await cli(["check", "--json", "--cwd", root], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
      cwd: root,
      env: {},
      stdoutIsTTY: false,
      isAgent: async () => false,
    });
    expect(code).toBe(0);
    const reported: { code: string; pointer?: string }[] = JSON.parse(stdout).diagnostics;
    expect(reported.filter((d) => d.code === "HM4022").map((d) => d.pointer)).toEqual([
      "/blocks/0/target",
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

describe("targets under an in_table segment toggle", () => {
  const sources = {
    keys: { type: "csv", path: "data/keys.csv" },
    regions: { type: "csv", path: "data/regions.csv" },
    keyed: {
      type: "lookup",
      from: "keys",
      lookups: [{ table: "regions", key: { region: "region" } }],
    },
  };
  const more = (table: string) => ({
    "data/keys.csv": "region\nAmericas\n",
    "data/regions.csv": "region,caption\nAmericas,The Americas\nEMEA,Europe\n",
    "segments/listed.yaml": {
      label: "Listed",
      filters: [{ column: "region", op: "in_table", table, key: "region" }],
    },
    "segments/unlisted.yaml": {
      label: "Unlisted",
      filters: [{ column: "region", op: "not_in_table", table, key: "region" }],
    },
  });
  const blocks = [
    { type: "kpi", id: "k", metric: "revenue", target: "plan" },
    { type: "bar", id: "b", metrics: ["revenue"], by: "region", target: "plan" },
  ];

  it.each([
    ["listed", [], 310, { Americas: 155, EMEA: 155 }],
    ["listed", ["listed"], 155, { Americas: 155 }],
    ["unlisted", [], 310, { Americas: 155, EMEA: 155 }],
    ["unlisted", ["unlisted"], 155, { EMEA: 155 }],
  ] as const)(
    "%s toggled to %j: the target table's rows the key table keeps",
    async (segment, on, value, bars) => {
      const { data, diagnostics } = await build(
        blocks,
        { filters: [{ type: "segment", id: "seg", segments: [segment], default: [...on] }] },
        more("keys"),
        sources,
      );
      expect(diagnostics.filter((d) => d.severity === "error")).toEqual([]);
      expect(kpi(data, "k").target?.value).toBe(value);
      const bar = chart<BarData>(data, "b");
      const categories = bar.axis.kind === "category" ? bar.axis.categories : [];
      expect(
        Object.fromEntries(categories.map((c, i) => [c, bar.series[0]?.target?.values[i]])),
      ).toEqual(bars);
    },
  );

  it("a block whose target follows a toggle with a lookup key table is left out with a note, and the build runs", async () => {
    const { data, diagnostics } = await build(
      blocks,
      { filters: [{ type: "segment", id: "seg", segments: ["listed"], default: ["listed"] }] },
      more("keyed"),
      sources,
    );
    expect(data?.blocks).toEqual([]);
    expect(diagnostics.map((d) => [d.code, d.severity, d.pointer])).toEqual([
      ["HM4023", "warning", "/blocks/0"],
      ["HM4023", "warning", "/blocks/1"],
    ]);
  });
});
