import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  type MeasureExpression,
  type PlannedQuery,
  planBlock,
  planDashboard,
  planHash,
  type QueryPlan,
} from "../../src/compiler/index.js";
import { METRICS, projectFrom } from "../spec/helpers.js";

function plan(dashboard: unknown, metrics: Record<string, unknown> = METRICS): QueryPlan {
  const result = planDashboard(projectFrom({ metrics, dashboards: { d: dashboard } }), "d");
  if (result.plan === undefined) throw new Error(JSON.stringify(result.diagnostics));
  return result.plan;
}

function query(p: QueryPlan, id: string | undefined): PlannedQuery {
  const found = p.queries.find((q) => q.id === id);
  if (found === undefined) throw new Error(`no query ${id}`);
  return found;
}

function ref(expression: MeasureExpression | undefined): string {
  if (expression?.op !== "ref") throw new Error("not a ref");
  return expression.queryId;
}

const dash = (blocks: unknown[], extra: Record<string, unknown> = {}) => ({
  title: "D",
  blocks,
  ...extra,
});

describe("planner", () => {
  it("plans the same project to the same bytes and hash", () => {
    const project = projectFrom({});
    const a = planDashboard(project, "sales");
    const b = planDashboard(projectFrom({}), "sales");
    expect(a.plan && canonicalJson(a.plan)).toBe(b.plan && canonicalJson(b.plan));
    expect(a.plan && planHash(a.plan)).toBe(b.plan && planHash(b.plan));
  });

  it("leaves bar_list and text blocks out with an HM4002 warning", () => {
    const result = planDashboard(projectFrom({}), "sales");
    expect(result.diagnostics.map((d) => [d.code, d.severity, d.pointer, d.message])).toEqual([
      [
        "HM4002",
        "warning",
        "/blocks/5",
        'bar_list blocks are not built yet; block "bar_list_5" is left out',
      ],
      [
        "HM4002",
        "warning",
        "/blocks/7",
        'text blocks are not built yet; block "text_7" is left out',
      ],
    ]);
    expect(result.diagnostics[0]?.range?.start.line).toBeGreaterThan(1);
    expect(result.plan?.blocks.map((b) => b.blockId)).toEqual([
      "kpi_0",
      "kpi_1",
      "line_2",
      "area_3",
      "bar_4",
      "by_country",
    ]);
  });

  it("shares one query between blocks that read the same shape, whatever the metric order", () => {
    const p = plan(
      dash([
        { type: "table", id: "a", by: ["region"], metrics: ["revenue", "orders"] },
        { type: "table", id: "b", by: ["region"], metrics: ["orders", "revenue"] },
        { type: "kpi", id: "c", metric: "revenue", compare: "none" },
        { type: "kpi", id: "d", metric: "revenue", compare: "none" },
      ]),
    );
    expect(p.queries).toHaveLength(2);
    expect(p.blocks[0]?.queryIds).toEqual(p.blocks[1]?.queryIds);
    expect(p.blocks[2]?.queryIds).toEqual(p.blocks[3]?.queryIds);
    expect(p.queries.every((q) => /^q_[0-9a-f]{16}$/.test(q.id))).toBe(true);
  });

  it("reads a KPI's comparison window, with the block's compare overriding the period's", () => {
    const p = plan(
      dash([
        { type: "kpi", id: "inherit", metric: "revenue" },
        { type: "kpi", id: "year", metric: "revenue", compare: "previous_year" },
        { type: "kpi", id: "none", metric: "revenue", compare: "none" },
        { type: "kpi", id: "spark", metric: "revenue", compare: "none", sparkline: true },
      ]),
    );
    const [inherit, year, none, spark] = p.blocks;
    expect(query(p, ref(inherit?.measures.revenue)).window).toEqual({
      range: "last_12_months",
      shift: "none",
      column: "ordered_at",
    });
    expect(query(p, ref(inherit?.previous?.revenue)).window.shift).toBe("previous_period");
    expect(query(p, ref(year?.previous?.revenue)).window.shift).toBe("previous_year");
    expect(none?.previous).toBeUndefined();
    expect(query(p, ref(spark?.sparkline?.revenue)).dimensions).toEqual([
      { kind: "time", column: "ordered_at", grain: "month" },
    ]);
    const allTime = plan(
      dash([{ type: "kpi", metric: "revenue" }], {
        period: { asOf: "2026-01-31", range: "all_time", compare: "previous_period" },
      }),
    );
    expect(query(allTime, ref(allTime.blocks[0]?.previous?.revenue)).window).toMatchObject({
      range: "all_time",
      shift: "previous_period",
    });
  });

  it("splits avg into sum and count of the column, and marks what cannot be re-aggregated", () => {
    const p = plan(dash([{ type: "table", by: ["plan"], metrics: ["aov2", "users", "net"] }]), {
      aov2: { ...(METRICS.revenue as object), aggregate: "avg" },
      users: { ...(METRICS.revenue as object), aggregate: "count_distinct", column: "user_id" },
      net: { ...(METRICS.net_revenue as object), additive: false },
    });
    const measures = p.queries[0]?.measures ?? [];
    expect(
      measures.map((m) => [
        m.metric,
        m.combine,
        m.components.map((c) => [c.id, c.aggregate, c.column, c.reaggregate]),
      ]),
    ).toEqual([
      [
        "aov2",
        { op: "divide", numerator: "aov2__sum", denominator: "aov2__count" },
        [
          ["aov2__sum", "sum", "amount", "sum"],
          ["aov2__count", "count", "amount", "sum"],
        ],
      ],
      ["net", { op: "identity", component: "net__sql" }, [["net__sql", "sql", undefined, "none"]]],
      [
        "users",
        { op: "identity", component: "users__count_distinct" },
        [["users__count_distinct", "count_distinct", "user_id", "none"]],
      ],
    ]);
  });

  it("gives tables leaf and grand total grouping sets, and only leaves without totals", () => {
    const sets = (block: Record<string, unknown>) =>
      plan(dash([{ type: "table", by: ["region", "country"], metrics: ["revenue"], ...block }]))
        .queries[0]?.groupingSets;
    expect(sets({})).toEqual([[0, 1], []]);
    expect(sets({ totals: false })).toEqual([[0, 1]]);
    expect(sets({ totals: false, percentOfTotal: ["revenue"] })).toEqual([[0, 1], []]);
  });

  it("groups time series and bars by the block's axes and split", () => {
    const p = plan(
      dash([
        { type: "line", metrics: ["revenue"], grain: "week", split: "plan" },
        { type: "bar", metrics: ["orders"], by: "plan", split: "region" },
        { type: "bar", metrics: ["orders"], grain: "month" },
      ]),
    );
    const shape = (i: number) => {
      const q = query(p, p.blocks[i]?.queryIds[0]);
      return [q.dimensions, q.groupingSets];
    };
    expect(shape(0)).toEqual([
      [
        { kind: "time", column: "ordered_at", grain: "week" },
        { kind: "column", column: "plan" },
      ],
      [[0, 1], [1]],
    ]);
    expect(shape(1)).toEqual([
      [
        { kind: "column", column: "plan" },
        { kind: "column", column: "region" },
      ],
      [[0, 1], [0], [1]],
    ]);
    expect(shape(2)).toEqual([[{ kind: "time", column: "ordered_at", grain: "month" }], [[0]]]);
  });

  it("divides a ratio across sources with one query per source, both in the same scope", () => {
    const metrics = {
      ...METRICS,
      sessions: {
        label: "Sessions",
        type: "aggregate",
        table: "merchants",
        aggregate: "count",
        time: "started_at",
        format: { type: "number" },
        better: "up",
      },
      conversion: {
        label: "Conversion",
        type: "ratio",
        numerator: "orders",
        denominator: "sessions",
        format: { type: "percent" },
        better: "up",
      },
    };
    const p = plan(dash([{ type: "table", by: ["region"], metrics: ["conversion"] }]), metrics);
    const expression = p.blocks[0]?.measures.conversion;
    expect(expression?.op).toBe("divide");
    if (expression?.op !== "divide") return;
    const [numerator, denominator] = [
      query(p, ref(expression.numerator)),
      query(p, ref(expression.denominator)),
    ];
    expect([numerator.source, numerator.window.column]).toEqual(["orders", "ordered_at"]);
    expect([denominator.source, denominator.window.column]).toEqual(["merchants", "started_at"]);
    expect(denominator.groupingSets).toEqual(numerator.groupingSets);
    expect(denominator.dimensions).toEqual(numerator.dimensions);
  });

  it("gives a SQL metric with filters a query of its own", () => {
    const p = plan(
      dash([
        { type: "kpi", metric: "net", compare: "none" },
        { type: "table", by: ["plan"], metrics: ["net", "revenue"] },
      ]),
      {
        ...METRICS,
        net: {
          ...(METRICS.net_revenue as object),
          filters: [{ column: "status", op: "eq", value: "paid" }],
        },
      },
    );
    expect(p.blocks[1]?.queryIds).toHaveLength(2);
  });

  it("plans one block with the same query ids as the whole dashboard", () => {
    const project = projectFrom({});
    const whole = planDashboard(project, "sales").plan;
    const one = planBlock(project, "sales", "by_country").plan;
    const fromWhole = whole?.blocks.find((b) => b.blockId === "by_country");
    expect(one?.block).toEqual(fromWhole);
    expect(one?.queries).toEqual(whole?.queries.filter((q) => fromWhole?.queryIds.includes(q.id)));
    expect(planBlock(project, "sales", "nope").diagnostics[0]?.code).toBe("HM1001");
    expect(planBlock(project, "sales", "text_7").diagnostics[0]?.code).toBe("HM4002");
    expect(planDashboard(project, "missing").diagnostics[0]?.code).toBe("HM1001");
  });

  it("carries the project time zone and week start, and the filters with their defaults", () => {
    const p = planDashboard(
      projectFrom({ columns: { orders: ["ordered_at", "region"] } }),
      "sales",
    ).plan;
    expect([p?.timezone, p?.weekStart]).toEqual(["America/New_York", "monday"]);
    expect(p?.materialization).toEqual({});
    const kpi = p && query(p, p.blocks[0]?.queryIds[0]);
    expect(kpi?.params).toEqual([
      {
        id: "region",
        kind: "select",
        source: "orders",
        column: "region",
        operator: "in",
        multiple: false,
        default: [],
      },
    ]);
  });
});
