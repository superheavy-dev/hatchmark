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
import {
  buildProject,
  loadAt,
  Oracle,
  removeProjects,
  run,
  writeExample,
  writeProject,
} from "./fixture.js";

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

describe("segment filter with key tables", () => {
  const vipKeys = "customer_id\nC00400\nC00316\nC00017\nC00123\nC00250\n";
  async function keyProject(keys: string, extra: Record<string, unknown> = {}) {
    const root = await writeExample(
      {
        sources: {
          orders: { type: "csv", path: "data/orders.csv" },
          vips: { type: "csv", path: "data/vips.csv" },
        },
      },
      {
        keyed: {
          title: "Keyed",
          period: PERIOD,
          filters: [
            {
              type: "period",
              id: "period",
              options: ["last_30_days", "last_12_months"],
              default: "last_12_months",
            },
            { type: "segment", id: "segments", segments: ["vip", "not_vip", "americas"] },
          ],
          blocks: KPIS,
        },
        ...extra,
      },
    );
    await writeFile(path.join(root, "data", "vips.csv"), keys);
    await mkdir(path.join(root, "segments"));
    const specs: Record<string, unknown> = {
      vip: {
        label: "VIP",
        filters: [{ column: "customer_id", op: "in_table", table: "vips", key: "customer_id" }],
      },
      not_vip: {
        label: "Not VIP",
        filters: [{ column: "customer_id", op: "not_in_table", table: "vips", key: "customer_id" }],
      },
      americas: SEGMENTS.americas?.spec,
      nowhere: { label: "Nowhere", filters: [{ column: "planet", op: "eq", value: "Mars" }] },
    };
    for (const [name, spec] of Object.entries(specs)) {
      await writeFile(path.join(root, "segments", `${name}.yaml`), toYaml(spec));
    }
    return root;
  }
  const keyWhere: Record<string, string> = {
    vip: "customer_id IN (SELECT customer_id FROM read_csv('VIPS'))",
    not_vip:
      "(customer_id IS NULL OR customer_id NOT IN (SELECT customer_id FROM read_csv('VIPS')))",
    americas: "region = 'Americas'",
  };

  it("runs every combination of in_table and not_in_table toggles, presets and day cubes included", async () => {
    const keyed = await keyProject(vipKeys);
    const loaded = await loadAt(keyed);
    expect([...parseDiagnostics(loaded.project), ...checkReferences(loaded.project)]).toEqual([]);
    const { code } = await buildProject(keyed);
    expect(code).toBe(0);
    const html = await readFile(path.join(keyed, "dist", "keyed", "index.html"), "utf8");
    const json = html.match(
      /<script type="application\/json" data-hm-segments[^>]*>(.*?)<\/script>/s,
    );
    const states: Record<
      string,
      {
        selected: string[];
        data: DashboardData;
        periods?: { presets: Record<string, DashboardData>; custom?: unknown };
      }
    > = JSON.parse(json?.[1] ?? "{}").states;
    expect(Object.keys(states)).toHaveLength(8);
    const vips = path.join(keyed, "data", "vips.csv");
    for (const [key, state] of Object.entries(states)) {
      expect(state.periods?.custom, key).toBeDefined();
      for (const [preset, data] of Object.entries(state.periods?.presets ?? {})) {
        const span = kpi(data, "orders").current;
        if (span === undefined) throw new Error("no window");
        const where = [
          `${LOCAL} >= TIMESTAMP '${span.start}' AND ${LOCAL} < TIMESTAMP '${span.end}'`,
          ...state.selected.map((name) => (keyWhere[name] ?? "FALSE").replaceAll("VIPS", vips)),
        ].join(" AND ");
        const [row] = await oracle.rows(
          `SELECT CAST(count(*) FILTER (WHERE status = 'paid') AS DOUBLE) AS orders FROM read_csv('${path.join(keyed, "data", "orders.csv")}') WHERE ${where}`,
        );
        expect(kpi(data, "orders").value, `${key} ${preset}`).toBe(row?.orders);
      }
    }
  });

  it("checks the key types of toggled segments (HM2029)", async () => {
    const keyed = await keyProject("customer_id\n1\n2\n3\n");
    const loaded = await loadAt(keyed);
    const found = checkReferences(loaded.project).map((d) => [d.code, d.pointer]);
    expect(found).toContainEqual(["HM2029", "/filters/1/segments/0"]);
    expect(found).toContainEqual(["HM2029", "/filters/1/segments/1"]);
  });

  it("warns about a toggled segment no source of the dashboard can apply (HM2030)", async () => {
    const keyed = await keyProject(vipKeys, {
      lost: {
        title: "Lost",
        period: PERIOD,
        filters: [
          { type: "segment", id: "segments", segments: ["americas", "nowhere"] },
          { type: "select", id: "planet", column: "planet" },
        ],
        blocks: KPIS,
      },
    });
    const loaded = await loadAt(keyed);
    const found = checkReferences(loaded.project)
      .filter((d) => d.file?.includes("lost"))
      .map((d) => [d.code, d.severity, d.pointer]);
    expect(found).toEqual([
      ["HM2030", "warning", "/filters/0/segments/1"],
      ["HM2030", "warning", "/filters/1/column"],
    ]);
  });
});

describe("segment filter key-table edges", () => {
  const files = (
    sources: Record<string, unknown>,
    data: Record<string, string>,
    segment: unknown,
    metrics: Record<string, unknown>,
  ) => ({
    "hatchmark.yaml": {
      version: 1,
      name: "Edges",
      dataDir: "data",
      metricsDir: "metrics",
      dashboardsDir: "dashboards",
      outDir: "dist",
      locale: "en-US",
      currency: "USD",
      timezone: "UTC",
      weekStart: "sunday",
      theme: "default",
      telemetry: false,
      sources,
    },
    ...Object.fromEntries(Object.entries(data).map(([n, csv]) => [`data/${n}.csv`, csv])),
    ...Object.fromEntries(Object.entries(metrics).map(([n, m]) => [`metrics/${n}.yaml`, m])),
    "segments/eligible.yaml": segment,
    "dashboards/d.yaml": {
      title: "D",
      period: { asOf: "2026-10-31", range: "all_time", compare: "none" },
      filters: [{ type: "segment", id: "segments", segments: ["eligible"] }],
      blocks: Object.keys(metrics).map((n) => ({ type: "kpi", id: n, metric: n })),
    },
  });
  const count = (table: string) => ({
    type: "aggregate",
    aggregate: "count",
    table,
    label: "Count",
    better: "up",
    format: { type: "number" },
  });

  it("checks the key type of a headerless source's generated column (HM2029)", async () => {
    const { project } = await writeProject(
      files(
        {
          keys: { type: "csv", path: "data/keys.csv" },
          hidden: { type: "csv", path: "data/hidden.csv", header: false },
        },
        { keys: "customer\na\nb\n", hidden: "10\n20\n" },
        {
          label: "Eligible",
          filters: [{ column: "column0", op: "in_table", table: "keys", key: "customer" }],
        },
        { hidden_count: count("hidden") },
      ),
    );
    expect(checkReferences(project).map((d) => [d.code, d.pointer])).toContainEqual([
      "HM2029",
      "/filters/0/segments/0",
    ]);
  });

  it("leaves blocks out with HM4023 when a toggled segment's key table is a lookup source", async () => {
    const { root } = await writeProject(
      files(
        {
          rows: { type: "csv", path: "data/rows.csv" },
          visits: { type: "csv", path: "data/visits.csv" },
          keys: { type: "csv", path: "data/keys.csv" },
          labels: { type: "csv", path: "data/labels.csv" },
          enriched: {
            type: "lookup",
            from: "keys",
            lookups: [{ table: "labels", key: { customer: "customer" } }],
          },
        },
        {
          rows: "customer\na\nb\nc\n",
          visits: "country\nUS\nCA\n",
          keys: "customer\na\nb\n",
          labels: "customer,tier\na,Gold\nb,Silver\n",
        },
        {
          label: "Eligible",
          filters: [{ column: "customer", op: "in_table", table: "enriched", key: "customer" }],
        },
        { row_count: count("rows"), visit_count: count("visits") },
      ),
    );
    const { code, report } = await buildProject(root);
    const diagnostics = (report as { diagnostics: { code: string; pointer?: string }[] })
      .diagnostics;
    expect(code).toBe(0);
    expect(diagnostics.filter((d) => d.code === "HM4023").map((d) => d.pointer)).toEqual([
      "/blocks/0",
    ]);
    expect(diagnostics.map((d) => d.code)).not.toContain("HM2015");
    const html = await readFile(path.join(root, "dist", "d", "index.html"), "utf8");
    const json = html.match(
      /<script type="application\/json" data-hm-segments[^>]*>(.*?)<\/script>/s,
    );
    const states: Record<string, { data: DashboardData }> = JSON.parse(json?.[1] ?? "{}").states;
    for (const [key, state] of Object.entries(states)) {
      expect(
        state.data.blocks.map((b) => b.id),
        key,
      ).toEqual(["visit_count"]);
      expect(kpi(state.data, "visit_count").value, key).toBe(2);
    }
  });

  it("never removes a block whose sources cannot apply a lookup-keyed toggle", async () => {
    const { root } = await writeProject(
      files(
        {
          visits: { type: "csv", path: "data/visits.csv" },
          keys: { type: "csv", path: "data/keys.csv" },
          labels: { type: "csv", path: "data/labels.csv" },
          enriched: {
            type: "lookup",
            from: "keys",
            lookups: [{ table: "labels", key: { customer: "customer" } }],
          },
        },
        {
          visits: "country\nUS\nCA\n",
          keys: "customer\na\nb\n",
          labels: "customer,tier\na,Gold\nb,Silver\n",
        },
        {
          label: "Eligible",
          filters: [{ column: "customer", op: "in_table", table: "enriched", key: "customer" }],
        },
        { visit_count: count("visits") },
      ),
    );
    const { code, report } = await buildProject(root);
    const codes = (report as { diagnostics: { code: string }[] }).diagnostics.map((d) => d.code);
    expect(code).toBe(0);
    expect(codes).toEqual(["HM2030"]);
  });
  it("gives a map block's match report the key tables of the toggled segments it binds", async () => {
    const project = files(
      {
        orders: { type: "csv", path: "data/orders.csv" },
        keys: { type: "csv", path: "data/keys.csv" },
      },
      {
        orders: "customer,state,amount\na,CA,10\nb,NY,20\nc,TX,40\n",
        keys: "customer\na\nb\n",
      },
      {
        label: "Eligible",
        filters: [{ column: "customer", op: "in_table", table: "keys", key: "customer" }],
      },
      {
        revenue: {
          type: "aggregate",
          aggregate: "sum",
          table: "orders",
          column: "amount",
          label: "Revenue",
          better: "up",
          format: { type: "number" },
        },
      },
    );
    (project["dashboards/d.yaml"] as { blocks: unknown[] }).blocks = [
      { type: "map", id: "m", geo: "us-states", region: "state", value: "revenue" },
    ];
    const { root } = await writeProject(project);
    const { code, report } = await buildProject(root);
    const codes = (report as { diagnostics: { code: string }[] }).diagnostics.map((d) => d.code);
    expect(code).toBe(0);
    expect(codes).not.toContain("HM2015");
    expect(codes).not.toContain("HM4023");
    const html = await readFile(path.join(root, "dist", "d", "index.html"), "utf8");
    const json = html.match(
      /<script type="application\/json" data-hm-segments[^>]*>(.*?)<\/script>/s,
    );
    const states: Record<string, { data: DashboardData }> = JSON.parse(json?.[1] ?? "{}").states;
    expect(Object.keys(states).length).toBeGreaterThan(1);
    for (const [key, state] of Object.entries(states)) {
      expect(
        state.data.blocks.map((b) => b.id),
        key,
      ).toEqual(["m"]);
    }
  });
});
