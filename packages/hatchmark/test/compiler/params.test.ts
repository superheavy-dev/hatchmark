import { describe, expect, it } from "vitest";
import {
  type ExecutionContext,
  type PlannedQuery,
  paramsForQuery,
  planHash,
  type QueryPlan,
  resolveParams,
} from "../../src/compiler/index.js";
import { DEFAULT_ANCHORS } from "../../src/spec/index.js";
import { CONFIG, METRICS, projectFrom } from "../spec/helpers.js";

const dashboard = (filters: unknown[]) => ({
  sales: { title: "Sales", filters, blocks: [{ type: "kpi", metric: "orders", compare: "none" }] },
});

describe("resolveParams", () => {
  it("carries the column, operator, default and sources of each select filter (HAT-13)", () => {
    const params = (column: string) =>
      resolveParams(
        projectFrom({
          dashboards: dashboard([{ type: "select", id: "slice", column }]),
          columns: { orders: ["region", "channel"] },
        }),
        "sales",
      );
    expect(params("region")).toEqual([
      {
        id: "slice",
        kind: "select",
        column: "region",
        operator: "in",
        multiple: false,
        default: [],
        sources: ["orders"],
      },
    ]);
    expect(JSON.stringify(params("region"))).not.toBe(JSON.stringify(params("channel")));
  });

  it("changes the plan whenever a filter is retargeted to another column (property)", () => {
    const columns = ["region", "channel", "state", "plan", "status", "industry"];
    for (const from of columns) {
      for (const to of columns) {
        if (from === to) continue;
        const make = (column: string) =>
          JSON.stringify(
            resolveParams(
              projectFrom({
                dashboards: dashboard([
                  { type: "select", id: "f", column, default: "West", multiple: true },
                ]),
              }),
              "sales",
            ),
          );
        expect(make(from), `${from} -> ${to}`).not.toBe(make(to));
      }
    }
  });

  it("binds only to sources that can have the column, and lists period time columns", () => {
    const project = projectFrom({
      config: CONFIG,
      metrics: METRICS,
      columns: { orders: ["region"], merchants: ["merchant_id"] },
      dashboards: {
        sales: {
          title: "Sales",
          filters: [
            { type: "select", id: "region", column: "region", default: ["West", "East"] },
            {
              type: "period",
              id: "range",
              options: ["last_7_days", "last_30_days"],
              default: "last_30_days",
            },
          ],
          blocks: [
            { type: "kpi", metric: "revenue" },
            { type: "kpi", metric: "merchants", compare: "none" },
          ],
        },
      },
    });
    expect(resolveParams(project, "sales")).toEqual([
      {
        id: "region",
        kind: "select",
        column: "region",
        operator: "in",
        multiple: false,
        default: ["West", "East"],
        sources: ["orders"],
      },
      {
        id: "range",
        kind: "period",
        options: ["last_7_days", "last_30_days"],
        default: "last_30_days",
        columns: { orders: ["ordered_at"] },
      },
    ]);
  });
});

const ROWS = [
  { region: "West", ordered_at: "2026-04-02" },
  { region: "West", ordered_at: "2026-04-03" },
  { region: "East", ordered_at: "2026-04-04" },
];

function regionQuery(regionDefault: unknown): PlannedQuery {
  const project = projectFrom({
    config: CONFIG,
    metrics: METRICS,
    dashboards: dashboard([
      { type: "select", id: "region", column: "region", default: regionDefault },
    ]),
  });
  return {
    id: "orders_count",
    source: "orders",
    input: { type: "csv", path: "data/orders.csv" },
    measures: [],
    dimensions: [],
    groupingSets: [[]],
    window: { range: "all_time", shift: "none" },
    params: paramsForQuery(resolveParams(project, "sales"), "orders", "ordered_at"),
  };
}

/** A stand-in executor that reads only the query and the context, as QueryExecutor must. */
function countRows(query: PlannedQuery, context: ExecutionContext): number {
  return ROWS.filter((row) =>
    query.params.every((param) => {
      if (param.kind !== "select") return true;
      const bound = context.bindings[param.id];
      const values = bound === undefined ? param.default : (bound as unknown[]);
      return values.length === 0 || values.includes(row[param.column as keyof typeof row]);
    }),
  ).length;
}

describe("paramsForQuery", () => {
  const context: ExecutionContext = {
    asOf: "2026-04-30",
    timezone: "UTC",
    anchors: { ...DEFAULT_ANCHORS, week: "monday" },
    bindings: {},
  };

  it("carries each filter's default, so West and East defaults give different executor inputs (HAT-13)", () => {
    const west = regionQuery("West");
    const east = regionQuery("East");
    expect(west.params).toEqual([
      {
        id: "region",
        kind: "select",
        source: "orders",
        column: "region",
        operator: "in",
        multiple: false,
        default: ["West"],
      },
    ]);
    expect(JSON.stringify([west, context])).not.toBe(JSON.stringify([east, context]));
    expect(countRows(west, context)).toBe(2);
    expect(countRows(east, context)).toBe(1);
    expect(countRows(regionQuery(undefined), context)).toBe(3);
    expect(countRows(west, { ...context, bindings: { region: ["East"] } })).toBe(1);
  });

  it("changes the query and the plan hash whenever a default changes (property)", () => {
    const defaults: unknown[] = [undefined, "West", "East", ["West"], ["West", "East"], 1, true];
    const plan = (regionDefault: unknown): QueryPlan => ({
      version: 2,
      dashboard: "sales",
      period: { asOf: "latest_data", range: "all_time", compare: "none" },
      timezone: "UTC",
      anchors: { ...DEFAULT_ANCHORS, week: "monday" },
      params: [],
      blocks: [],
      queries: [regionQuery(regionDefault)],
      materialization: {},
    });
    for (const from of defaults) {
      for (const to of defaults) {
        const label = `${JSON.stringify(from)} -> ${JSON.stringify(to)}`;
        const values = (d: unknown) =>
          JSON.stringify(Array.isArray(d) ? d : d === undefined ? [] : [d]);
        if (values(from) === values(to)) continue;
        expect(JSON.stringify(regionQuery(from)), label).not.toBe(JSON.stringify(regionQuery(to)));
        expect(planHash(plan(from)), label).not.toBe(planHash(plan(to)));
      }
    }
  });

  it("windows the query's time column with the period filter's default, and skips other columns", () => {
    const project = projectFrom({
      config: CONFIG,
      metrics: METRICS,
      dashboards: dashboard([
        {
          type: "period",
          id: "range",
          options: ["last_7_days", "last_30_days"],
          default: "last_7_days",
        },
      ]),
    });
    const params = resolveParams(project, "sales");
    expect(paramsForQuery(params, "orders", "ordered_at")).toEqual([
      {
        id: "range",
        kind: "period",
        source: "orders",
        column: "ordered_at",
        default: "last_7_days",
      },
    ]);
    expect(paramsForQuery(params, "orders", "shipped_at")).toEqual([]);
    expect(paramsForQuery(params, "orders", undefined)).toEqual([]);
  });
});
