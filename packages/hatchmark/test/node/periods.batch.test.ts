import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  type DashboardExecutor,
  type ExecutionContext,
  type PlannedQuery,
  planDashboard,
  queryBounds,
  runDashboard,
  runDashboardBindings,
} from "../../src/compiler/index.js";
import { runPeriodData } from "../../src/compiler/period-build.js";
import { createDuckDbExecutor } from "../../src/node/index.js";
import type { Project } from "../../src/spec/index.js";
import { fromYaml, toYaml } from "../yaml.js";
import { EXAMPLE, loadAt, removeProjects, writeExample } from "./fixture.js";

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
    ];
    const together = await runDashboardBindings(project, "previous", db, sets);
    const alone = [];
    for (const bindings of sets) {
      alone.push(await runDashboard(project, "previous", oneByOne(db), undefined, bindings));
    }
    expect(JSON.stringify(together)).toBe(JSON.stringify(alone));
    expect(together[1]?.diagnostics.some((d) => d.code === "HM2015")).toBe(true);
    expect(together[2]?.diagnostics.some((d) => d.code === "HM2015")).toBe(true);
  });

  it("returns no results for no contexts, and reads nothing when there is no other preset", async () => {
    const plan = planDashboard(project, "single").plan;
    const query = plan?.queries[0];
    if (query === undefined) throw new Error("no query");
    expect(await db.executeMany?.(query, [])).toEqual([]);
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
    expect(presetStatements).toBeLessThanOrEqual(2 * baseCalls.execute);
    expect(calls.horizon - baseCalls.horizon).toBeLessThanOrEqual(2);
    expect(elapsed).toBeLessThan(10_000);
    console.log(`explorer presets: ${JSON.stringify(calls)}, ${elapsed.toFixed(0)} ms`);
  });
});
