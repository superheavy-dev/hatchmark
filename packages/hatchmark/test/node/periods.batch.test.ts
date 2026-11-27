import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  type DashboardExecutor,
  type ExecutionContext,
  executionContext,
  type PlannedQuery,
  planDashboard,
  type QueryPlan,
  type QueryResult,
  queryBounds,
  runDashboard,
  runDashboardBindings,
} from "../../src/compiler/index.js";
import { runPeriodData } from "../../src/compiler/period-build.js";
import { createDuckDbExecutor } from "../../src/node/index.js";
import { PROJECT_DEFAULTS, type Project } from "../../src/spec/index.js";
import { fromYaml, toYaml } from "../yaml.js";
import { EXAMPLE, loadAt, metric, removeProjects, writeExample, writeProject } from "./fixture.js";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const PRESETS = [
  { last: 7, unit: "day" },
  { last: 30, unit: "day" },
  { to_date: "month" },
  { last_complete: "month" },
  { to_date: "year" },
  { last: 12, unit: "month" },
  { start: "2025-01-01", end: "2025-06-30" },
  "all_time",
];

const METRICS = {
  net_sql: {
    label: "Net",
    type: "sql",
    table: "orders",
    sql: "sum(amount)",
    additive: true,
    time: "ordered_at",
    format: { type: "number" },
    better: "up",
  },
  spread_sql: {
    label: "Spread",
    type: "sql",
    table: "orders",
    sql: "max(amount) - min(amount)",
    additive: false,
    time: "ordered_at",
    format: { type: "number" },
    better: "up",
  },
  query_text: {
    label: "Query text",
    type: "sql",
    table: "orders",
    sql: "count(*) + length(current_query())",
    additive: false,
    time: "ordered_at",
    format: { type: "number" },
    better: "up",
  },
  net_per_customer: {
    label: "Net per customer",
    type: "ratio",
    numerator: "net_sql",
    denominator: "customers",
    format: { type: "number" },
    better: "up",
  },
};

const period = (compare: string) => ({ asOf: "latest_data", range: "last_12_months", compare });
const filters = [
  { type: "select", id: "region", column: "region", multiple: true, default: ["EMEA", "APAC"] },
  { type: "period", id: "period", options: PRESETS, default: { last: 12, unit: "month" } },
  { type: "grain", id: "grain", options: ["day", "week", "month"], default: "week" },
];
const blocks = [
  { type: "kpi", metric: "revenue", sparkline: true },
  { type: "kpi", metric: "customers" },
  { type: "kpi", metric: "net_sql" },
  { type: "kpi", metric: "spread_sql" },
  { type: "kpi", metric: "net_per_customer" },
  { type: "line", metrics: ["revenue", "orders"], grain: "week" },
  { type: "bar", metrics: ["revenue"], by: "channel" },
  { type: "table", by: ["region", "country"], metrics: ["revenue", "refund_rate", "spread_sql"] },
];

let root: string;
let project: Project;
let db: Awaited<ReturnType<typeof createDuckDbExecutor>>;

beforeAll(async () => {
  const explorer = fromYaml(await readFile(path.join(EXAMPLE, "dashboards/explorer.yaml"), "utf8"));
  root = await writeExample(
    {},
    {
      explorer,
      previous: { title: "Previous period", period: period("previous_period"), filters, blocks },
      year: { title: "Previous year", period: period("previous_year"), filters, blocks },
      raw: {
        title: "Raw SQL",
        period: { asOf: "latest_data", range: "last_7_days", compare: "none" },
        filters: [
          {
            type: "period",
            id: "period",
            options: [
              { last: 7, unit: "day" },
              { last: 30, unit: "day" },
              { last: 90, unit: "day" },
            ],
            default: { last: 7, unit: "day" },
            custom: false,
          },
        ],
        blocks: [{ type: "kpi", metric: "query_text" }],
      },
      select: {
        title: "Region select",
        period: period("previous_period"),
        filters: filters.slice(0, 2),
        blocks: [{ type: "kpi", metric: "revenue" }],
      },
      single: {
        title: "One preset",
        period: { asOf: "latest_data", range: "last_7_days", compare: "none" },
        filters: [
          {
            type: "period",
            id: "period",
            options: [{ last: 7, unit: "day" }],
            default: { last: 7, unit: "day" },
            custom: false,
          },
        ],
        blocks: [{ type: "kpi", metric: "revenue" }],
      },
    },
  );
  for (const [name, spec] of Object.entries(METRICS)) {
    await writeFile(path.join(root, "metrics", `${name}.yaml`), toYaml(spec));
  }
  project = (await loadAt(root)).project;
  const config = project.config.spec;
  if (config === undefined) throw new Error("invalid hatchmark.yaml");
  db = await createDuckDbExecutor({ root, config });
});

afterAll(async () => {
  await db?.close();
  await removeProjects();
});

const oneByOne = (inner: DashboardExecutor): DashboardExecutor => ({
  execute: (query, context) => inner.execute(query, context),
  horizon: (column) => inner.horizon(column),
});

function counted(inner: DashboardExecutor) {
  const calls = { execute: 0, executeMany: 0, horizon: 0 };
  const executor: DashboardExecutor = {
    execute: (query, context) => {
      calls.execute++;
      return inner.execute(query, context);
    },
    executeMany: (query, contexts) => {
      calls.executeMany++;
      return (inner.executeMany as NonNullable<DashboardExecutor["executeMany"]>)(query, contexts);
    },
    horizon: (column) => {
      calls.horizon++;
      return inner.horizon(column);
    },
  };
  return { executor, calls };
}

async function periodData(name: string, executor: DashboardExecutor) {
  const base = await runDashboard(project, name, executor);
  if (base.data === undefined) throw new Error(JSON.stringify(base.diagnostics));
  return { base, period: await runPeriodData(project, name, executor, base.data) };
}

describe("period presets run as one batch per query", () => {
  it.each(["explorer", "previous", "year", "raw"])(
    "%s: every preset, custom range data and diagnostic is the same JSON as one query at a time",
    async (name) => {
      const batched = await periodData(name, db);
      const single = await periodData(name, oneByOne(db));
      expect(Object.keys(batched.period.data?.presets ?? {})).toHaveLength(
        name === "explorer" ? 8 : name === "raw" ? 3 : PRESETS.length,
      );
      expect(JSON.stringify(batched)).toBe(JSON.stringify(single));
    },
  );

  it("keeps each window's own float magnitude in a batch, so HM4004 follows the window", async () => {
    const rows = [
      ...Array.from(
        { length: 5 },
        (_, i) => `2025-03-0${i + 1}T12:00:00Z,${i % 2 ? "a" : "b"},${(i + 2) * 1e13 + 0.5}`,
      ),
      ...Array.from(
        { length: 5 },
        (_, i) => `2025-06-2${i + 1}T12:00:00Z,${i % 2 ? "a" : "b"},${i + 1.25}`,
      ),
    ];
    const options = [
      { last: 7, unit: "day" },
      { start: "2025-03-01", end: "2025-03-31" },
      { last: 30, unit: "day" },
    ];
    const { root: at, project: large } = await writeProject({
      "hatchmark.yaml": {
        ...PROJECT_DEFAULTS,
        name: "Large",
        sources: { s: { type: "csv", path: "s.csv" } },
      },
      "s.csv": `at,g,v\n${rows.join("\n")}\n`,
      "metrics/v.yaml": metric({
        type: "aggregate",
        table: "s",
        aggregate: "sum",
        column: "v",
        time: "at",
      }),
      "dashboards/d.yaml": {
        title: "D",
        period: { asOf: "2025-06-25", range: "last_30_days", compare: "none" },
        filters: [{ type: "period", id: "period", options, default: options[2], custom: false }],
        blocks: [
          { type: "kpi", metric: "v" },
          { type: "bar", metrics: ["v"], by: "g" },
        ],
      },
    });
    const config = large.config.spec;
    if (config === undefined) throw new Error("invalid hatchmark.yaml");
    const own = await createDuckDbExecutor({ root: at, config });
    try {
      const sets = options.slice(0, 2).map((option) => ({ period: option }));
      const together = await runDashboardBindings(large, "d", own, sets);
      const alone: Awaited<ReturnType<typeof runDashboard>>[] = [];
      for (const bindings of sets) {
        alone.push(await runDashboard(large, "d", oneByOne(own), undefined, bindings));
      }
      const codes = (runs: typeof alone) => runs.map((run) => run.diagnostics.map((d) => d.code));
      expect(codes(alone)).toEqual([[], ["HM4004", "HM4004"]]);
      expect(codes(together)).toEqual(codes(alone));
      expect(JSON.stringify(together)).toBe(JSON.stringify(alone));
      const plan = planDashboard(large, "d").plan;
      const base = (await executionContext(large, plan as QueryPlan, own)).context;
      if (base === undefined) throw new Error("no context");
      const contexts = sets.map((bindings) => ({ ...base, bindings }));
      for (const query of plan?.queries ?? []) {
        const each: QueryResult[] = [];
        for (const context of contexts) each.push(await own.execute(query, context));
        expect(await own.executeMany?.(query, contexts)).toEqual(each);
      }
    } finally {
      await own.close();
    }
  });

  it("runs raw SQL once per window, never inside a shared statement", async () => {
    const { executor, calls } = counted(db);
    const base = await runDashboard(project, "raw", executor);
    if (base.data === undefined) throw new Error("no raw data");
    await runPeriodData(project, "raw", executor, base.data);
    expect(calls.executeMany).toBe(0);
    expect(calls.execute).toBe(3);
  });

  it("gives every set of bindings the result runDashboard gives it alone, invalid selects included", async () => {
    const sets = [
      {},
      { region: null },
      { region: Number.NaN },
      { region: "EMEA" },
      { region: ["EMEA"] },
      { region: [] },
      { region: Array(1) },
    ];
    const together = await runDashboardBindings(project, "previous", db, sets);
    const alone = [];
    for (const bindings of sets) {
      alone.push(await runDashboard(project, "previous", oneByOne(db), undefined, bindings));
    }
    expect(JSON.stringify(together)).toBe(JSON.stringify(alone));
    expect(together[1]?.diagnostics.some((d) => d.code === "HM2015")).toBe(true);
    expect(together[2]?.diagnostics.some((d) => d.code === "HM2015")).toBe(true);
    expect(together[6]?.diagnostics.some((d) => d.code === "HM2015")).toBe(true);
    const sparse = [{ region: [] }, { region: Array(1) }];
    const pair = await runDashboardBindings(project, "select", db, sparse);
    const solo = await runDashboard(project, "select", oneByOne(db), undefined, {
      region: Array(1),
    });
    expect(pair[0]?.data).toBeDefined();
    expect(pair[1]?.diagnostics.some((d) => d.code === "HM2015")).toBe(true);
    expect(JSON.stringify(pair[1])).toBe(JSON.stringify(solo));
  });

  it("returns no results for no contexts, and reads nothing when there is no other preset", async () => {
    const plan = planDashboard(project, "single").plan;
    const query = plan?.queries[0];
    if (query === undefined) throw new Error("no query");
    expect(await db.executeMany?.(query, [])).toEqual([]);
    expect(await db.executeMany?.({ ...query, source: "missing" }, [])).toEqual([]);
    const { executor, calls } = counted(db);
    const base = await runDashboard(project, "single", db);
    if (base.data === undefined) throw new Error("no single data");
    await runPeriodData(project, "single", executor, base.data);
    expect(calls).toEqual({ execute: 0, executeMany: 0, horizon: 0 });
  });

  it("keeps each preset's own error when one window fails", async () => {
    const failing = (context: ExecutionContext, query: PlannedQuery) =>
      JSON.stringify(queryBounds(query, context)).includes("2025-01-01");
    const flaky: DashboardExecutor = {
      execute: (query, context) =>
        failing(context, query)
          ? Promise.reject(new Error(`no rows for ${query.id}`))
          : db.execute(query, context),
      executeMany: (query, contexts) =>
        contexts.some((c) => failing(c, query))
          ? Promise.reject(new Error("batch failed"))
          : (db.executeMany as NonNullable<DashboardExecutor["executeMany"]>)(query, contexts),
      horizon: (column) => db.horizon(column),
    };
    const batched = await periodData("previous", flaky);
    const single = await periodData("previous", oneByOne(flaky));
    expect(batched.period.diagnostics.map((d) => d.message)).toEqual(
      single.period.diagnostics.map((d) => d.message),
    );
    expect(batched.period.diagnostics[0]?.message).toContain("no rows for");
    expect(JSON.stringify(batched)).toBe(JSON.stringify(single));
  });

  it("runs the explorer's presets in one statement per planned query, with one horizon read", async () => {
    const { executor, calls } = counted(db);
    const base = await runDashboard(project, "explorer", executor);
    const baseCalls = { ...calls };
    if (base.data === undefined) throw new Error("no explorer data");
    const started = performance.now();
    await runPeriodData(project, "explorer", executor, base.data);
    const elapsed = performance.now() - started;
    const presetStatements = calls.execute + calls.executeMany - baseCalls.execute;
    expect(baseCalls).toEqual({ execute: 14, executeMany: 0, horizon: 1 });
    expect(presetStatements).toBe(21);
    expect(calls.horizon - baseCalls.horizon).toBe(2);
    expect(elapsed).toBeLessThan(10_000);
    console.log(`explorer presets: ${JSON.stringify(calls)}, ${elapsed.toFixed(0)} ms`);
  });
});
