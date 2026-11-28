import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  type DashboardData,
  type KpiData,
  runSegmentData,
  segmentKey,
} from "../../src/compiler/index.js";
import { runPeriodData } from "../../src/compiler/period-build.js";
import { createDuckDbExecutor } from "../../src/node/index.js";
import { checkReferences, type Project, parseDiagnostics } from "../../src/spec/index.js";
import { toYaml } from "../yaml.js";
import { buildProject, loadAt, Oracle, removeProjects, run, writeExample } from "./fixture.js";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const LOCAL = "(ordered_at AT TIME ZONE 'America/New_York')";
const PERIOD = { asOf: "latest_data", range: "last_12_months", compare: "previous_period" };

const SEGMENTS: Record<string, { label: string; spec: unknown; where: string }> = {
  paid_marketing: {
    label: "Paid marketing",
    spec: {
      label: "Paid marketing",
      filters: [{ column: "channel", op: "in", values: ["Paid search", "Social", "Affiliate"] }],
    },
    where: "channel IN ('Paid search', 'Social', 'Affiliate')",
  },
  americas: {
    label: "Americas",
    spec: { label: "Americas", filters: [{ column: "region", op: "eq", value: "Americas" }] },
    where: "region = 'Americas'",
  },
  large_orders: {
    label: "Orders of $100+",
    spec: { label: "Orders of $100+", filters: [{ column: "amount", op: "gte", value: 100 }] },
    where: "amount >= 100",
  },
};
const ORDER = Object.keys(SEGMENTS);

const KPIS = [
  { type: "kpi", id: "revenue", metric: "revenue" },
  { type: "kpi", id: "orders", metric: "orders" },
  { type: "kpi", id: "refund_rate", metric: "refund_rate" },
];

const DASHBOARDS = {
  toggles: {
    title: "Toggles",
    period: PERIOD,
    filters: [{ type: "segment", id: "segments", segments: ORDER }],
    blocks: KPIS,
  },
  "default-on": {
    title: "Default on",
    period: PERIOD,
    filters: [
      {
        type: "segment",
        id: "audience",
        label: "Audience",
        segments: ["paid_marketing", "large_orders"],
        default: ["large_orders"],
      },
    ],
    blocks: KPIS,
  },
  "with-periods": {
    title: "With periods",
    period: PERIOD,
    filters: [
      {
        type: "period",
        id: "period",
        options: ["last_30_days", "last_12_months"],
        default: "last_12_months",
        custom: false,
      },
      { type: "segment", id: "segments", segments: ["paid_marketing", "americas"] },
    ],
    blocks: KPIS,
  },
};

async function withSegments(dashboards: Record<string, unknown>): Promise<string> {
  const root = await writeExample({}, dashboards);
  await mkdir(path.join(root, "segments"));
  for (const [name, { spec }] of Object.entries(SEGMENTS)) {
    await writeFile(path.join(root, "segments", `${name}.yaml`), toYaml(spec));
  }
  return root;
}

let oracle: Oracle;
let root: string;
let project: Project;

function kpi(data: DashboardData, id: string): KpiData {
  const found = data.blocks.find((b) => b.id === id);
  if (found === undefined) throw new Error(`no block ${id}`);
  return found as KpiData;
}

async function segmentRun(dashboard: string) {
  const config = project.config.spec;
  if (config === undefined) throw new Error("invalid hatchmark.yaml");
  const base = await run(root, project, dashboard);
  expect(base.diagnostics).toEqual([]);
  if (base.data === undefined) throw new Error("no data");
  const executor = await createDuckDbExecutor({ root, config });
  try {
    const result = await runSegmentData(project, dashboard, executor, base.data);
    expect(result.diagnostics).toEqual([]);
    if (result.data === undefined) throw new Error("no segment data");
    return { base: base.data, segments: result.data };
  } finally {
    await executor.close();
  }
}

async function expectKpis(data: DashboardData, selected: readonly string[], label: string) {
  const span = kpi(data, "revenue").current;
  if (span === undefined) throw new Error("no window");
  const where = [
    `${LOCAL} >= TIMESTAMP '${span.start}' AND ${LOCAL} < TIMESTAMP '${span.end}'`,
    ...selected.map((name) => SEGMENTS[name]?.where ?? "false"),
  ].join(" AND ");
  const row =
    (
      await oracle.rows(`
        SELECT CAST(coalesce(sum(amount) FILTER (WHERE status = 'paid'), 0) AS DOUBLE) AS revenue,
          CAST(count(*) FILTER (WHERE status = 'paid') AS DOUBLE) AS orders,
          CAST(count(*) FILTER (WHERE status = 'refunded') AS DOUBLE) AS refunded,
          CAST(count(*) AS DOUBLE) AS placed
        FROM read_csv('${path.join(root, "data", "orders.csv")}') WHERE ${where}`)
    )[0] ?? {};
  const n = (key: string) => row[key] as number;
  const want = {
    revenue: n("revenue"),
    orders: n("orders"),
    refund_rate: n("refunded") / n("placed"),
  };
  for (const [id, value] of Object.entries(want)) {
    expect(kpi(data, id).value, `${label} ${id}`).toBeCloseTo(value, 6);
  }
  return want;
}

beforeAll(async () => {
  oracle = await Oracle.open();
  root = await withSegments(DASHBOARDS);
  const loaded = await loadAt(root);
  project = loaded.project;
  expect([
    ...loaded.diagnostics,
    ...parseDiagnostics(project),
    ...checkReferences(project),
  ]).toEqual([]);
});
afterAll(async () => {
  oracle.close();
  await removeProjects();
});

describe("segment filter", () => {
  it("runs every combination, each matching the oracle with its segments ANDed", async () => {
    const { base, segments } = await segmentRun("toggles");
    expect(base.segmentFilter).toEqual({
      id: "segments",
      label: "Segments",
      options: ORDER.map((name) => ({ name, label: SEGMENTS[name]?.label })),
      selected: [],
    });
    const keys = Object.keys(segments.states);
    expect(keys).toHaveLength(8);
    expect(keys).toEqual([...keys].sort());
    expect(segments.states[""]?.data).toBe(base);
    const orders: Record<string, number> = {};
    for (const [key, state] of Object.entries(segments.states)) {
      expect(segmentKey(state.selected, ORDER)).toBe(key);
      expect(state.data.segmentFilter?.selected).toEqual(state.selected);
      orders[key] = (await expectKpis(state.data, state.selected, key)).orders;
    }
    expect(orders[ORDER.join(",")]).toBeGreaterThan(0);
    expect(orders[ORDER.join(",")]).toBeLessThan(orders.americas ?? 0);
    expect(orders.americas).toBeLessThan(orders[""] ?? 0);
  });

  it("opens on the default combination", async () => {
    const { base, segments } = await segmentRun("default-on");
    expect(base.segmentFilter?.selected).toEqual(["large_orders"]);
    expect(base.segmentFilter?.label).toBe("Audience");
    expect(Object.keys(segments.states)).toEqual([
      "",
      "large_orders",
      "paid_marketing",
      "paid_marketing,large_orders",
    ]);
    expect(segments.states.large_orders?.data).toBe(base);
    await expectKpis(base, ["large_orders"], "default");
  });

  it("gives each combination period presets that carry its segments", async () => {
    const config = project.config.spec;
    if (config === undefined) throw new Error("invalid hatchmark.yaml");
    const { segments } = await segmentRun("with-periods");
    const executor = await createDuckDbExecutor({ root, config });
    try {
      for (const [key, state] of Object.entries(segments.states)) {
        const periods = await runPeriodData(
          project,
          "with-periods",
          executor,
          state.data,
          undefined,
          { segments: state.selected },
        );
        expect(periods.diagnostics).toEqual([]);
        const presets = Object.entries(periods.data?.presets ?? {});
        expect(presets).toHaveLength(2);
        for (const [preset, data] of presets) {
          expect(data.segmentFilter?.selected, preset).toEqual(state.selected);
          await expectKpis(data, state.selected, `${key} ${preset}`);
        }
      }
    } finally {
      await executor.close();
    }
  });

  it("embeds every combination in the built page", async () => {
    const built = await withSegments({ toggles: DASHBOARDS.toggles });
    const { code } = await buildProject(built);
    expect(code).toBe(0);
    const html = await readFile(path.join(built, "dist", "toggles", "index.html"), "utf8");
    expect(html).toContain('data-hm-segment-filter="segments"');
    expect(html.match(/aria-pressed="false"/g)).toHaveLength(3);
    const json = html.match(
      /<script type="application\/json" data-hm-segments[^>]*>(.*?)<\/script>/s,
    );
    expect(Object.keys(JSON.parse(json?.[1] ?? "{}").states)).toHaveLength(8);
  });
});

describe("segment filter checks", () => {
  const codes = async (filters: unknown[]) => {
    const r = await withSegments({ d: { title: "D", period: PERIOD, filters, blocks: KPIS } });
    const loaded = await loadAt(r);
    return [...parseDiagnostics(loaded.project), ...checkReferences(loaded.project)].map(
      (d) => d.code,
    );
  };

  it("rejects a second segment filter, a repeated segment and a default outside the list", async () => {
    expect(
      await codes([
        { type: "segment", id: "a", segments: ["americas"] },
        { type: "segment", id: "b", segments: ["large_orders"] },
      ]),
    ).toContain("HM3007");
    expect(
      await codes([{ type: "segment", id: "a", segments: ["americas", "americas"] }]),
    ).toContain("HM3007");
    expect(
      await codes([
        { type: "segment", id: "a", segments: ["americas"], default: ["large_orders"] },
      ]),
    ).toContain("HM3007");
  });

  it("rejects an unknown segment", async () => {
    expect(await codes([{ type: "segment", id: "a", segments: ["emea"] }])).toContain("HM2021");
  });
});

describe("segment filter over several sources", () => {
  it("binds each segment to the sources that have its columns, for the default and every combination", async () => {
    const both = {
      type: "segment",
      id: "segments",
      segments: ["americas", "paid_marketing"],
      default: ["americas", "paid_marketing"],
    };
    const mixed = await writeExample(
      {
        sources: {
          orders: { type: "csv", path: "data/orders.csv" },
          sessions: { type: "csv", path: "data/sessions.csv", freshness: { through: "as_of" } },
        },
      },
      {
        mixed: {
          title: "Mixed",
          period: { asOf: "2026-10-31", range: "last_30_days", compare: "previous_period" },
          filters: [both],
          blocks: [
            { type: "kpi", id: "orders", metric: "orders" },
            { type: "kpi", id: "sessions", metric: "sessions" },
          ],
        },
      },
    );
    await writeFile(
      path.join(mixed, "data", "sessions.csv"),
      "region,started_at\nAmericas,2026-10-20T14:00:00Z\nEMEA,2026-10-21T19:00:00Z\nAmericas,2026-10-22T09:00:00Z\n",
    );
    await writeFile(
      path.join(mixed, "metrics", "sessions.yaml"),
      toYaml({
        label: "Sessions",
        type: "aggregate",
        aggregate: "count",
        table: "sessions",
        time: "started_at",
        format: { type: "number" },
        better: "up",
      }),
    );
    await mkdir(path.join(mixed, "segments"));
    for (const [name, { spec }] of Object.entries(SEGMENTS)) {
      await writeFile(path.join(mixed, "segments", `${name}.yaml`), toYaml(spec));
    }
    const loaded = await loadAt(mixed);
    expect([...parseDiagnostics(loaded.project), ...checkReferences(loaded.project)]).toEqual([]);
    const base = await run(mixed, loaded.project, "mixed");
    expect(base.diagnostics).toEqual([]);
    if (base.data === undefined) throw new Error("no data");
    const config = loaded.project.config.spec;
    if (config === undefined) throw new Error("invalid hatchmark.yaml");
    const executor = await createDuckDbExecutor({ root: mixed, config });
    try {
      const result = await runSegmentData(loaded.project, "mixed", executor, base.data);
      expect(result.diagnostics).toEqual([]);
      const states = Object.values(result.data?.states ?? {});
      expect(states).toHaveLength(4);
      for (const state of states) {
        const sessions = state.selected.includes("americas") ? 2 : 3;
        expect(kpi(state.data, "sessions").value, state.selected.join(",")).toBe(sessions);
      }
    } finally {
      await executor.close();
    }
  });
});
