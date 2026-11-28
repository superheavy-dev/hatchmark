import { afterAll, describe, expect, it } from "vitest";
import {
  type DashboardData,
  type KpiData,
  type LineData,
  planDashboard,
  type TableData,
} from "../../src/compiler/index.js";
import { checkReferences, PROJECT_DEFAULTS } from "../../src/spec/index.js";
import { metric, removeProjects, run, writeProject } from "./fixture.js";

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
    expect(codes).toEqual([]);
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
