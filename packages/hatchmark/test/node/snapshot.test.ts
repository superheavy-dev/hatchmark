import { afterAll, describe, expect, it } from "vitest";
import {
  type BarData,
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
    ns?: string[];
    declared?: boolean;
    compare?: unknown;
    filters?: unknown[];
    blocks?: unknown[];
  }) {
    const parquet = options.ns !== undefined;
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
          `COPY (SELECT * FROM (VALUES ${(options.ns ?? [])
            .map((row) => {
              const [at, g, v] = row.split(",");
              return `(TIMESTAMP_NS '${at}', '${g}', ${v})`;
            })
            .join(", ")}) AS t("at", g, v)) TO '${root}/data/s.parquet' (FORMAT PARQUET)`,
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
    const { project, executor } = await setup({
      ns: ["2026-10-31 00:00:00.000000100,a,10", "2026-10-31 00:00:00.000000200,b,20"],
      asOf: "2026-10-31",
    });
    try {
      const result = await runDashboard(project, "d", executor);
      expect(lineOf(result.data)).toEqual([20]);
    } finally {
      await executor.close();
    }
  });

  const MIDNIGHT = ["2026-10-30 23:59:59.999999900,a,10", "2026-10-31 00:00:00.000000200,b,20"];

  it("keeps a Parquet snapshot 100 ns before midnight in its own day", async () => {
    const { project, executor } = await setup({ ns: MIDNIGHT, asOf: "2026-10-30" });
    try {
      const result = await runDashboard(project, "d", executor);
      expect(kpiOf(result.data)).toBe(10);
      expect(lineOf(result.data)).toEqual([10]);
    } finally {
      await executor.close();
    }
  });

  it("puts a Parquet snapshot 1 ns after midnight in the new day, in presets and custom ranges", async () => {
    for (const [pick, range, want] of [
      ["first", { start: "2026-10-31", end: "2026-11-01" }, 20],
      ["last", { start: "2026-10-30", end: "2026-10-31" }, 10],
    ] as const) {
      const { project, executor } = await setup({
        ns: [
          "2026-10-30 23:59:59.999999999,a,10",
          "2026-10-31 00:00:00.000000001,b,20",
          "2026-11-02 12:00:00,a,30",
        ],
        pick,
        asOf: "2026-11-02",
        filters: PERIOD,
      });
      try {
        const base = await runDashboard(project, "d", executor);
        expect(lineOf(base.data), pick).toEqual([10, 20, null, 30]);
        const periods = await runPeriodData(project, "d", executor, base.data as DashboardData);
        expect(periods.diagnostics, pick).toEqual([]);
        const custom = periods.data?.custom;
        if (custom === undefined) throw new Error("no custom range cube");
        const bound = await runDashboard(project, "d", executor, undefined, { p: range });
        expect(kpiOf(bound.data), pick).toBe(want);
        expect(kpiOf(customRangeDashboard(custom, "p", range)), pick).toBe(want);
      } finally {
        await executor.close();
      }
    }
  });

  it("cuts the previous to-date window at the same nanosecond after midnight", async () => {
    const { project, executor } = await setup({
      ns: [
        "2026-10-01 00:00:00.000000001,a,10",
        "2026-10-01 00:00:00.000000002,a,99",
        "2026-11-01 00:00:00.000000001,a,20",
      ],
      asOf: "latest_data",
      range: "month_to_date",
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

  it("ends a series at a nanosecond horizon in presets, executor custom ranges and the cube", async () => {
    const { root, project } = await writeProject({
      "hatchmark.yaml": {
        ...PROJECT_DEFAULTS,
        name: "horizon",
        timezone: "UTC",
        sources: {
          s: { type: "parquet", path: "s.parquet", snapshot: "at" },
          t: { type: "parquet", path: "t.parquet" },
        },
      },
      "metrics/m.yaml": metric({
        type: "aggregate",
        table: "s",
        time: "at",
        column: "v",
        aggregate: "sum",
        over_time: "last",
      }),
      "metrics/n.yaml": metric({
        type: "aggregate",
        table: "t",
        time: "at",
        column: "v",
        aggregate: "sum",
      }),
      "dashboards/d.yaml": {
        title: "Horizon",
        period: { range: "month_to_date", asOf: "latest_common_data", compare: "previous_period" },
        filters: [
          { type: "period", id: "p", options: ["month_to_date"], default: "month_to_date" },
        ],
        blocks: [
          { type: "kpi", id: "k", metric: "m" },
          { type: "line", id: "l", metrics: ["m"], grain: "day" },
          { type: "kpi", id: "n", metric: "n" },
        ],
      },
    });
    const oracle = await Oracle.open();
    try {
      await oracle.run(
        `COPY (SELECT * FROM (VALUES (TIMESTAMP_NS '2026-10-01 00:00:00.000000001', 10), (TIMESTAMP_NS '2026-10-01 00:00:00.000000002', 99), (TIMESTAMP_NS '2026-10-31 12:00:00', 5), (TIMESTAMP_NS '2026-11-01 00:00:00.000000001', 20), (TIMESTAMP_NS '2026-11-01 00:00:00.000000002', 30), (TIMESTAMP_NS '2026-11-01 00:00:00.000000003', 40)) AS x("at", v)) TO '${root}/s.parquet' (FORMAT PARQUET)`,
      );
      await oracle.run(
        `COPY (SELECT TIMESTAMP_NS '2026-11-01 00:00:00.000000001' AS "at", 1 AS v) TO '${root}/t.parquet' (FORMAT PARQUET)`,
      );
    } finally {
      oracle.close();
    }
    const config = project.config.spec;
    if (config === undefined) throw new Error("invalid hatchmark.yaml");
    const executor = await createDuckDbExecutor({ root, config, threads: 1 });
    try {
      const base = await runDashboard(project, "d", executor);
      expect(base.data?.horizons.map((h) => [h.source, h.through])).toEqual([
        ["s", "2026-11-01T00:00:00.000000004Z"],
        ["t", "2026-11-01T00:00:00.000000002Z"],
      ]);
      expect(base.data?.blocks.find((b) => b.id === "k")).toMatchObject({
        value: 20,
        previousValue: 10,
      });
      expect(lineOf(base.data)).toEqual([20]);
      const periods = await runPeriodData(project, "d", executor, base.data as DashboardData);
      expect(periods.diagnostics).toEqual([]);
      const custom = periods.data?.custom;
      if (custom === undefined) throw new Error("no custom range cube");
      const range = { start: "2026-10-31", end: "2026-11-02" };
      const bound = await runDashboard(project, "d", executor, undefined, { p: range });
      expect(lineOf(bound.data)).toEqual([5, 20]);
      expect(lineOf(customRangeDashboard(custom, "p", range))).toEqual([5, 20]);
    } finally {
      await executor.close();
    }
  });

  it("keeps a Parquet flow row 100 ns before midnight in its own day", async () => {
    const { project, executor } = await setup({
      ns: MIDNIGHT,
      asOf: "2026-10-30",
      declared: false,
      pick: "sum",
    });
    try {
      const result = await runDashboard(project, "d", executor);
      expect(kpiOf(result.data)).toBe(10);
      expect(lineOf(result.data)).toEqual([10]);
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

describe("snapshot values with null balances, custom ranges, Other rows and notes", () => {
  const CSV = [
    "t,acct,region,bal",
    "2026-01-05,a,east,10",
    "2026-01-05,b,west,",
    "2026-01-12,a,east,",
    "2026-01-12,c,east,",
    "2026-01-19,a,east,30",
    "2026-01-19,b,west,4",
    "2026-01-26,b,west,6",
  ].join("\n");
  const m = (over_time: string, aggregate: string, column?: string) =>
    metric({
      type: "aggregate",
      table: "b",
      time: "t",
      over_time,
      aggregate,
      ...(column === undefined ? {} : { column }),
    });

  async function setup() {
    const { root, project } = await writeProject({
      "hatchmark.yaml": {
        ...PROJECT_DEFAULTS,
        name: "nulls",
        sources: { b: { type: "csv", path: "data/b.csv", snapshot: "t" } },
      },
      "data/b.csv": CSV,
      "metrics/avg_av.yaml": m("avg", "avg", "bal"),
      "metrics/avg_mn.yaml": m("avg", "min", "bal"),
      "metrics/avg_n.yaml": m("avg", "count"),
      "metrics/min_sb.yaml": m("min", "sum", "bal"),
      "metrics/last_sb.yaml": m("last", "sum", "bal"),
      "dashboards/d.yaml": {
        title: "Nulls",
        period: { asOf: "2026-01-31", range: "all_time", compare: "none" },
        filters: [
          {
            type: "period",
            id: "period",
            options: ["all_time", { last_complete: "month" }],
            default: "all_time",
          },
        ],
        blocks: [
          { type: "kpi", id: "k_avg_av", metric: "avg_av" },
          { type: "kpi", id: "k_avg_mn", metric: "avg_mn" },
          { type: "bar", id: "n_by_region", metrics: ["avg_n"], by: "region" },
          {
            type: "table",
            id: "t",
            by: ["region"],
            metrics: ["avg_n", "min_sb", "last_sb"],
            limit: 1,
            other: true,
            sort: { by: "region", order: "asc" },
          },
        ],
      },
      "dashboards/e.yaml": {
        title: "Share",
        period: { asOf: "2026-01-31", range: "all_time", compare: "none" },
        blocks: [
          {
            type: "table",
            id: "share",
            by: ["region"],
            metrics: ["min_sb", "last_sb"],
            percentOfTotal: ["min_sb", "last_sb"],
          },
        ],
      },
    });
    const config = project.config.spec;
    if (config === undefined) throw new Error("invalid hatchmark.yaml");
    return { project, executor: await createDuckDbExecutor({ root, config, threads: 1 }) };
  }
  const kpi = (data: DashboardData | undefined, id: string) =>
    (data?.blocks.find((b) => b.id === id) as KpiData | undefined)?.value;

  it("skips snapshots whose value is null in an average over time", async () => {
    const { project, executor } = await setup();
    try {
      const { data } = await runDashboard(project, "d", executor);
      expect(kpi(data, "k_avg_av")).toBeCloseTo(11, 9);
      expect(kpi(data, "k_avg_mn")).toBeCloseTo(20 / 3, 9);
    } finally {
      await executor.close();
    }
  });

  it("averages a custom range over the snapshots present, counting an absent group as 0", async () => {
    const { project, executor } = await setup();
    try {
      const base = await runDashboard(project, "d", executor);
      const periods = await runPeriodData(project, "d", executor, base.data as DashboardData);
      const custom = periods.data?.custom;
      if (custom === undefined) throw new Error("no custom range cube");
      expect(custom.presetOnly).toEqual(["avg_av"]);
      const data = customRangeDashboard(custom, "period", {
        start: "2026-01-05",
        end: "2026-01-27",
      });
      expect(kpi(data, "k_avg_mn")).toBeCloseTo(20 / 3, 9);
      const bars = data.blocks.find((b) => b.id === "n_by_region") as BarData | undefined;
      const categories = bars?.axis.kind === "category" ? bars.axis.categories : [];
      const at = (key: string) => bars?.series[0]?.values[categories.indexOf(key)];
      expect(at("east")).toBeCloseTo(1, 9);
      expect(at("west")).toBeCloseTo(0.75, 9);
    } finally {
      await executor.close();
    }
  });

  it("folds an average over time of a count and a last into Other, never a min over time", async () => {
    const { project, executor } = await setup();
    try {
      const { data } = await runDashboard(project, "d", executor);
      const table = data?.blocks.find((b) => b.id === "t") as TableData | undefined;
      const other = table?.rows.find((r) => r.kind === "other");
      expect(other?.values.avg_n).toBeCloseTo(0.75, 9);
      expect(other?.values.last_sb).toBe(6);
      expect(other?.values.min_sb).toBeNull();
    } finally {
      await executor.close();
    }
  });

  it("refuses percent of total for a min over time (HM4001) and allows it for a last", async () => {
    const { project, executor } = await setup();
    await executor.close();
    const share = checkReferences(project).filter(
      (d) => d.code === "HM4001" && d.file?.includes("dashboards/e"),
    );
    expect(share.map((d) => d.pointer)).toEqual(["/blocks/0/percentOfTotal/0"]);
  });

  it("notes the HM4040 average default on over_time avg metrics only", async () => {
    const { project, executor } = await setup();
    await executor.close();
    const notes = checkReferences(project).filter(
      (d) => d.code === "HM4040" && d.file?.includes("metrics/"),
    );
    expect(notes.map((d) => d.file?.split("/").pop()).sort()).toEqual([
      "avg_av.yaml",
      "avg_mn.yaml",
      "avg_n.yaml",
    ]);
  });
});
