import { afterAll, describe, expect, it } from "vitest";
import {
  customRangeDashboard,
  type DashboardData,
  type KpiData,
  type LineData,
  planDashboard,
  runDashboard,
  runPeriodData,
  runSegmentData,
  type TableData,
} from "../../src/compiler/index.js";
import { createDuckDbExecutor } from "../../src/node/index.js";
import { checkReferences, PROJECT_DEFAULTS } from "../../src/spec/index.js";
import { metric, Oracle, removeProjects, run, writeProject } from "./fixture.js";

const BALANCES = [
  "snapshot_date,account,region,balance",
  "2026-01-10,a,east,100",
  "2026-01-10,b,west,50",
  "2026-01-31,a,east,110",
  "2026-01-31,b,west,60",
  "2026-01-31,c,east,5",
  "2026-03-15,a,east,200",
  "2026-03-31,b,west,70",
].join("\n");

const base = {
  type: "aggregate",
  table: "balances",
  aggregate: "sum",
  column: "balance",
  time: "snapshot_date",
};
const east = [{ column: "region", op: "eq", value: "east" }];
const PICKS = ["last", "first", "avg", "min", "max"] as const;
const METRICS = Object.fromEntries(
  PICKS.flatMap((pick) => [
    [pick, metric({ ...base, over_time: pick })],
    [`${pick}_east`, metric({ ...base, over_time: pick, filters: east })],
  ]),
);

async function build(extra: Record<string, unknown> = {}): Promise<{
  data: DashboardData | undefined;
  codes: string[];
}> {
  const names = Object.keys(METRICS);
  const { root, project } = await writeProject({
    "hatchmark.yaml": {
      ...PROJECT_DEFAULTS,
      name: "snapshots",
      sources: {
        balances: { type: "csv", path: "data/balances.csv", snapshot: "snapshot_date" },
      },
    },
    "data/balances.csv": BALANCES,
    ...Object.fromEntries(Object.entries(METRICS).map(([n, m]) => [`metrics/${n}.yaml`, m])),
    "dashboards/d.yaml": {
      title: "Snapshots",
      period: { asOf: "2026-03-31", range: "all_time", compare: "none" },
      ...extra,
      blocks: [
        ...names.map((n) => ({ type: "kpi", id: `k_${n}`, metric: n })),
        { type: "line", id: "monthly", metrics: [...PICKS], grain: "month" },
        {
          type: "line",
          id: "monthly_east",
          metrics: PICKS.map((p) => `${p}_east`),
          grain: "month",
        },
        { type: "table", id: "by_region", by: ["region"], metrics: names },
      ],
    },
  });
  const result = await run(root, project, "d");
  return { data: result.data, codes: result.diagnostics.map((d) => `${d.code}:${d.message}`) };
}

const kpi = (data: DashboardData | undefined, id: string) =>
  (data?.blocks.find((b) => b.id === id) as KpiData | undefined)?.value;

afterAll(removeProjects);

describe("snapshot over_time", () => {
  it("reads KPIs at the source's snapshots, chosen before filters", async () => {
    const { data, codes } = await build();
    expect(codes).toEqual([
      'HM4015:block "monthly" has 1 complete month with no snapshot of source "balances" (from 2026-02-01), shown as gaps',
      'HM4015:block "monthly_east" has 1 complete month with no snapshot of source "balances" (from 2026-02-01), shown as gaps',
    ]);
    const got = Object.fromEntries(Object.keys(METRICS).map((n) => [n, kpi(data, `k_${n}`)]));
    expect(got).toEqual({
      last: 70,
      last_east: 0,
      first: 150,
      first_east: 100,
      avg: 148.75,
      avg_east: 103.75,
      min: 70,
      min_east: 0,
      max: 200,
      max_east: 200,
    });
  });

  it("buckets by month, with a gap where the source has no snapshot", async () => {
    const { data } = await build();
    const lines = ["monthly", "monthly_east"].map(
      (id) => data?.blocks.find((b) => b.id === id) as LineData,
    );
    expect(lines[0]?.axis.buckets).toEqual(["2026-01-01", "2026-02-01", "2026-03-01"]);
    const series = Object.fromEntries(
      lines.flatMap((line) => line.series.map((s) => [s.key, s.values])),
    );
    expect(series).toEqual({
      last: [175, null, 70],
      last_east: [115, null, 0],
      first: [150, null, 200],
      first_east: [100, null, 200],
      avg: [162.5, null, 135],
      avg_east: [107.5, null, 100],
      min: [150, null, 70],
      min_east: [100, null, 0],
      max: [175, null, 200],
      max_east: [115, null, 200],
    });
  });

  it("computes each group over time, and totals from rows, not from groups", async () => {
    const { data } = await build();
    const table = data?.blocks.find((b) => b.id === "by_region") as TableData;
    const rows = Object.fromEntries(
      table.rows.map((r) => [String(r.keys?.[0] ?? r.kind), r.values]),
    );
    expect(rows).toMatchObject({
      east: { last: 0, first: 100, avg: 103.75, min: 0, max: 200 },
      west: { last: 70, first: 50, avg: 45, min: 0, max: 70 },
    });
  });
  it("reads two instants on one day as two snapshots, and rows at one instant together", async () => {
    const { root, project } = await writeProject({
      "hatchmark.yaml": {
        ...PROJECT_DEFAULTS,
        name: "instants",
        timezone: "America/New_York",
        sources: { seats: { type: "csv", path: "data/seats.csv", snapshot: "at" } },
      },
      "data/seats.csv": [
        "at,team,seats",
        "2026-03-02T09:00:00Z,a,10",
        "2026-03-02T09:00:00Z,a,5",
        "2026-03-02T21:00:00Z,b,7",
        "2026-03-03T03:00:00Z,a,1",
        "2026-03-04T15:00:00Z,a,99",
      ].join("\n"),
      ...Object.fromEntries(
        PICKS.map((pick) => [
          `metrics/${pick}.yaml`,
          metric({
            type: "aggregate",
            table: "seats",
            aggregate: "sum",
            column: "seats",
            time: "at",
            over_time: pick,
          }),
        ]),
      ),
      "dashboards/d.yaml": {
        title: "Seats",
        period: { asOf: "2026-03-02", range: "all_time", compare: "none" },
        blocks: PICKS.map((pick) => ({ type: "kpi", id: pick, metric: pick })),
      },
    });
    const { data } = await run(root, project, "d");
    expect(Object.fromEntries(PICKS.map((pick) => [pick, kpi(data, pick)]))).toEqual({
      last: 1,
      first: 15,
      avg: 7.66666666666667,
      min: 1,
      max: 15,
    });
  });

  it("keeps HM4023 for what the planner does not evaluate yet, and plans the rest as snapshots", async () => {
    const { project } = await writeProject({
      "hatchmark.yaml": {
        ...PROJECT_DEFAULTS,
        name: "left-out",
        sources: {
          balances: { type: "csv", path: "data/balances.csv", snapshot: "snapshot_date" },
          events: { type: "csv", path: "data/events.csv" },
        },
      },
      "data/balances.csv": BALANCES,
      "data/events.csv": "at,account,balance\n2026-01-01,a,1\n",
      "metrics/last.yaml": METRICS.last,
      "metrics/scaled.yaml": metric({ ...base, over_time: "last", scale: 12 }),
      "metrics/raw.yaml": metric({
        type: "sql",
        table: "balances",
        sql: "sum(balance)",
        additive: true,
        time: "snapshot_date",
      }),
      "metrics/state.yaml": metric({
        type: "aggregate",
        table: "events",
        aggregate: "sum",
        column: "balance",
        time: "at",
        over_time: "last",
        entity: "account",
      }),
      "dashboards/d.yaml": {
        title: "D",
        blocks: ["last", "scaled", "raw", "state"].map((m) => ({ type: "kpi", id: m, metric: m })),
      },
    });
    const { plan, diagnostics } = planDashboard(project, "d");
    expect(diagnostics.map((d) => [d.code, d.pointer])).toEqual([
      ["HM4023", "/blocks/1"],
      ["HM4023", "/blocks/2"],
      ["HM4023", "/blocks/3"],
    ]);
    expect(plan?.queries.map((q) => [q.window.shift, q.evaluation])).toEqual([
      ["none", { kind: "snapshot", column: "snapshot_date", pick: "last" }],
      ["previous_period", { kind: "snapshot", column: "snapshot_date", pick: "last" }],
    ]);
  });

  it("notes the over_time avg default once per metric (HM4040)", async () => {
    const { project } = await writeProject({
      "hatchmark.yaml": {
        ...PROJECT_DEFAULTS,
        name: "notes",
        sources: {
          balances: { type: "csv", path: "data/balances.csv", snapshot: "snapshot_date" },
        },
      },
      "data/balances.csv": BALANCES,
      "metrics/avg.yaml": METRICS.avg,
      "metrics/last.yaml": METRICS.last,
    });
    const notes = checkReferences(project).filter((d) => d.code === "HM4040");
    expect(notes.map((d) => [d.file, d.pointer, d.severity])).toEqual([
      ["metrics/avg.yaml", "/over_time", "note"],
    ]);
  });
  it("shows point targets on snapshot metrics, read at each bucket's end and at the horizon", async () => {
    const values = { "2025-12-01": 100, "2026-03-01": 400 };
    const targets = [
      { id: "linear", grain: "month", values, path: "linear" },
      { id: "compound", grain: "month", values, path: "compound" },
    ];
    const seats = (pick: string) =>
      metric({
        type: "aggregate",
        table: "seats",
        aggregate: "sum",
        column: "seats",
        time: "day",
        over_time: pick,
        targets,
      });
    const blocks = ["last", "avg"].flatMap((m) =>
      ["linear", "compound"].flatMap((t) => [
        { type: "kpi", id: `k_${m}_${t}`, metric: m, target: t },
        { type: "line", id: `l_${m}_${t}`, metrics: [m], grain: "month", target: t },
      ]),
    );
    const { root, project } = await writeProject({
      "hatchmark.yaml": {
        ...PROJECT_DEFAULTS,
        name: "point-targets",
        sources: { seats: { type: "csv", path: "data/seats.csv", snapshot: "day" } },
      },
      "data/seats.csv": [
        "day,team,seats",
        "2026-01-31,a,100",
        "2026-02-10,a,80",
        "2026-02-28,a,150",
        "2026-02-28,b,50",
        "2026-03-15,b,300",
      ].join("\n"),
      "metrics/last.yaml": seats("last"),
      "metrics/avg.yaml": seats("avg"),
      "dashboards/d.yaml": {
        title: "Targets",
        period: { asOf: "latest_data", range: { to_date: "year" }, compare: "none" },
        blocks,
      },
    });
    const { data, diagnostics } = await run(root, project, "d");
    expect(diagnostics.filter((d) => d.severity !== "note").map((d) => d.code)).toEqual([]);
    const linear = (days: number) => 100 + (300 * days) / 90;
    const compound = (days: number) => 100 * 4 ** (days / 90);
    const path = { linear, compound };
    const close = (a: unknown, b: number) => typeof a === "number" && Math.abs(a - b) < 1e-9 * b;
    for (const [m, value] of [
      ["last", 300],
      ["avg", 170],
    ] as const) {
      for (const t of ["linear", "compound"] as const) {
        const k = data?.blocks.find((b) => b.id === `k_${m}_${t}`) as KpiData;
        expect(k.value).toBe(value);
        expect(close(k.target?.value, path[t](74)), `${m} ${t} kpi`).toBe(true);
        expect(close(k.target?.attainment, value / path[t](74)), `${m} ${t} attainment`).toBe(true);
        const line = data?.blocks.find((b) => b.id === `l_${m}_${t}`) as LineData;
        expect(line.axis.buckets).toEqual(["2026-01-01", "2026-02-01", "2026-03-01"]);
        const series = line.series[0];
        expect(series?.values).toEqual(m === "last" ? [100, 200, 300] : [100, 140, 300]);
        expect(series?.partial?.map((b) => b.index)).toEqual([2]);
        const want = [path[t](31), path[t](59), path[t](74)];
        want.forEach((w, i) => {
          expect(close(series?.target?.values[i], w), `${m} ${t} bucket ${i}`).toBe(true);
        });
      }
    }
  });
});

describe("snapshot edge cases", () => {
  const DEFAULT_BLOCKS = [
    { type: "kpi", id: "k", metric: "m" },
    { type: "line", id: "l", metrics: ["m"], grain: "day" },
  ];
  async function setup(options: {
    rows?: string[];
    pick?: string;
    timezone?: string;
    range?: unknown;
    asOf?: string;
    inner?: string;
    parquet?: boolean;
    declared?: boolean;
    compare?: unknown;
    filters?: unknown[];
    blocks?: unknown[];
  }) {
    const parquet = options.parquet === true;
    const { root, project } = await writeProject({
      "hatchmark.yaml": {
        ...PROJECT_DEFAULTS,
        name: "edges",
        timezone: options.timezone ?? "UTC",
        sources: {
          s: {
            type: parquet ? "parquet" : "csv",
            path: parquet ? "data/s.parquet" : "data/s.csv",
            ...(options.declared === false ? {} : { snapshot: "at" }),
          },
          keys: { type: "csv", path: "data/keys.csv" },
        },
      },
      "data/keys.csv": "g\na\n",
      "segments/vips.yaml": {
        label: "VIPs",
        filters: [{ column: "g", op: "in_table", table: "keys", key: "g" }],
      },
      "segments/others.yaml": {
        label: "Others",
        filters: [{ column: "g", op: "not_in_table", table: "keys", key: "g" }],
      },
      "data/s.csv": ["at,g,v", ...(options.rows ?? [])].join("\n"),
      "metrics/m.yaml": metric({
        type: "aggregate",
        table: "s",
        time: "at",
        column: "v",
        aggregate: options.inner ?? "sum",
        over_time: options.pick ?? "last",
      }),
      "dashboards/d.yaml": {
        title: "Edges",
        period: {
          range: options.range ?? "all_time",
          asOf: options.asOf ?? "2026-11-04",
          compare: options.compare ?? "none",
        },
        filters: options.filters ?? [],
        blocks: options.blocks ?? DEFAULT_BLOCKS,
      },
    });
    if (parquet) {
      const oracle = await Oracle.open();
      try {
        await oracle.run(
          `COPY (SELECT * FROM (VALUES (TIMESTAMP_NS '2026-10-31 00:00:00.000000100', 'a', 10), (TIMESTAMP_NS '2026-10-31 00:00:00.000000200', 'b', 20)) AS t("at", g, v)) TO '${root}/data/s.parquet' (FORMAT PARQUET)`,
        );
      } finally {
        oracle.close();
      }
    }
    const config = project.config.spec;
    if (config === undefined) throw new Error("invalid hatchmark.yaml");
    return { project, executor: await createDuckDbExecutor({ root, config, threads: 1 }) };
  }
  const PERIOD = [{ type: "period", id: "p", options: ["all_time"], default: "all_time" }];
  const kpiOf = (data: DashboardData | undefined) =>
    (data?.blocks.find((b) => b.id === "k") as KpiData | undefined)?.value;
  const lineOf = (data: DashboardData | undefined) =>
    (data?.blocks.find((b) => b.id === "l") as LineData | undefined)?.series[0]?.values;

  it("warns HM4015 for a complete bucket with no snapshot, at the block", async () => {
    const { project, executor } = await setup({
      rows: ["2026-10-01,a,10", "2026-10-03,a,30"],
      asOf: "2026-10-03",
    });
    try {
      const result = await runDashboard(project, "d", executor);
      expect(lineOf(result.data)).toEqual([10, null, 30]);
      const warned = result.diagnostics.filter((d) => d.code === "HM4015");
      expect(warned.map((d) => [d.severity, d.pointer, d.message])).toEqual([
        [
          "warning",
          "/blocks/1",
          'block "l" has 1 complete day with no snapshot of source "s" (from 2026-10-02), shown as gaps',
        ],
      ]);
    } finally {
      await executor.close();
    }
  });

  it("warns HM4015 for a complete bucket whose last snapshot is before its last day", async () => {
    const { project, executor } = await setup({
      rows: ["2026-09-30,a,10", "2026-10-28,a,30", "2026-11-03,a,40"],
      asOf: "2026-11-04",
      blocks: [{ type: "line", id: "l", metrics: ["m"], grain: "month" }],
    });
    try {
      const result = await runDashboard(project, "d", executor);
      expect(lineOf(result.data)).toEqual([10, 30, 40]);
      expect(result.diagnostics.filter((d) => d.code === "HM4015").map((d) => d.message)).toEqual([
        'block "l" reads 1 complete month of source "s" at a snapshot before the month\'s last day (the month from 2026-10-01 at 2026-10-28)',
      ]);
    } finally {
      await executor.close();
    }
  });

  it("leaves out the earlier occurrence of a repeated midnight in a custom range, like the executor", async () => {
    const { project, executor } = await setup({
      rows: [
        "2026-10-31T20:00:00+00:00,a,5",
        "2026-11-01T04:30:00+00:00,a,10",
        "2026-11-01T05:30:00+00:00,a,20",
        "2026-11-02T12:00:00+00:00,a,30",
      ],
      timezone: "America/Havana",
      pick: "first",
      filters: PERIOD,
    });
    try {
      const base = await runDashboard(project, "d", executor);
      const periods = await runPeriodData(project, "d", executor, base.data as DashboardData);
      expect(periods.diagnostics).toEqual([]);
      const range = { start: "2026-11-01", end: "2026-11-02" };
      const bound = await runDashboard(project, "d", executor, undefined, { p: range });
      const custom = periods.data?.custom;
      if (custom === undefined) throw new Error("no custom range data");
      expect(kpiOf(bound.data)).toBe(20);
      expect(kpiOf(customRangeDashboard(custom, "p", range))).toBe(20);
    } finally {
      await executor.close();
    }
  });

  it("compares a point with the previous unit at the same local elapsed time", async () => {
    const { project, executor } = await setup({
      rows: [
        "2026-10-01T14:00:00+00:00,a,10",
        "2026-10-01T16:00:00+00:00,a,99",
        "2026-11-01T14:00:00+00:00,a,12",
        "2026-11-01T16:00:00+00:00,a,20",
      ],
      asOf: "latest_data",
      timezone: "America/New_York",
      range: { to_date: "month" },
      compare: "previous_period",
    });
    try {
      const result = await runDashboard(project, "d", executor);
      expect(result.data?.blocks.find((b) => b.id === "k")).toMatchObject({
        value: 20,
        previousValue: 10,
      });
    } finally {
      await executor.close();
    }
  });

  it("folds an additive Other row and keeps a true total and shares", async () => {
    const { project, executor } = await setup({
      rows: [
        "2026-10-01,a,100",
        "2026-10-01,c,10",
        "2026-10-31,a,20",
        "2026-10-31,b,8",
        "2026-10-31,c,2",
      ],
      asOf: "2026-10-31",
      blocks: [
        {
          type: "table",
          id: "t",
          by: ["g"],
          metrics: ["m"],
          limit: 1,
          other: true,
          percentOfTotal: ["m"],
        },
      ],
    });
    try {
      const result = await runDashboard(project, "d", executor);
      expect(result.data?.blocks.find((b) => b.id === "t")).toMatchObject({
        rows: [
          { keys: ["a"], values: { m: 20 }, share: { m: 20 / 30 } },
          { kind: "other", count: 2, values: { m: 10 }, share: { m: 10 / 30 } },
        ],
        total: { values: { m: 30 }, share: { m: 1 } },
      });
    } finally {
      await executor.close();
    }
  });

  it("warns HM4063 when Other cannot fold an average over time of a min", async () => {
    const { project, executor } = await setup({
      rows: [
        "2026-10-01,a,100",
        "2026-10-01,b,80",
        "2026-10-01,c,10",
        "2026-10-31,a,100",
        "2026-10-31,b,10",
        "2026-10-31,c,80",
      ],
      asOf: "2026-10-31",
      pick: "avg",
      inner: "min",
      blocks: [{ type: "table", id: "t", by: ["g"], metrics: ["m"], limit: 1, other: true }],
    });
    try {
      const result = await runDashboard(project, "d", executor);
      expect(result.data?.blocks.find((b) => b.id === "t")).toMatchObject({
        rows: [
          { keys: ["a"], values: { m: 100 } },
          { kind: "other", count: 2, values: { m: null } },
        ],
        total: { values: { m: 10 } },
      });
      expect(checkReferences(project).map((d) => [d.code, d.pointer])).toContainEqual([
        "HM4063",
        "/blocks/0/other",
      ]);
    } finally {
      await executor.close();
    }
  });

  it("keeps Parquet nanosecond timestamps a hundred nanoseconds apart as two snapshots", async () => {
    const { project, executor } = await setup({ parquet: true, asOf: "2026-10-31" });
    try {
      const result = await runDashboard(project, "d", executor);
      expect(lineOf(result.data)).toEqual([20]);
    } finally {
      await executor.close();
    }
  });

  it("gives every segment toggle state the same snapshot, in presets and custom ranges, without a declared snapshot", async () => {
    const { project, executor } = await setup({
      rows: ["2026-10-01,a,100", "2026-10-01,b,5", "2026-10-31,b,20"],
      asOf: "2026-10-31",
      declared: false,
      filters: [
        ...PERIOD,
        { type: "segment", id: "seg", segments: ["vips", "others"], default: ["vips"] },
      ],
    });
    try {
      const base = await runDashboard(project, "d", executor);
      expect(base.diagnostics.filter((d) => d.code !== "HM4015")).toEqual([]);
      const built = await runSegmentData(project, "d", executor, base.data as DashboardData);
      expect(built.diagnostics).toEqual([]);
      for (const [key, want] of [
        ["", 20],
        ["vips", 0],
        ["others", 20],
        ["vips,others", 0],
      ] as const) {
        const state = built.data?.states[key];
        if (state === undefined) throw new Error(key);
        expect(kpiOf(state.data), key).toBe(want);
        const periods = await runPeriodData(project, "d", executor, state.data, undefined, {
          seg: state.selected,
        });
        expect(periods.diagnostics).toEqual([]);
        const custom = periods.data?.custom;
        if (custom === undefined) throw new Error("no custom range data");
        expect(
          kpiOf(customRangeDashboard(custom, "p", { start: "2026-10-01", end: "2026-11-01" })),
          key,
        ).toBe(want);
      }
    } finally {
      await executor.close();
    }
  });
});
