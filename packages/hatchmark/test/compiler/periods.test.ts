import { describe, expect, it } from "vitest";
import {
  cubeResult,
  type DayCube,
  dayCubeQuery,
  effectiveRange,
  PAGE_BUDGET,
  type PlannedQuery,
  pageWeight,
  parseDaysKey,
  rangeKey,
  rangeName,
} from "../../src/compiler/index.js";
import { DEFAULT_ANCHORS } from "../../src/spec/index.js";
import { DASHBOARD, projectFrom } from "../spec/helpers.js";

describe("period keys and names", () => {
  it("gives every spelling of the same span one key", () => {
    expect(rangeKey("last_30_days")).toBe("last_30_days");
    expect(rangeKey({ last: 30, unit: "day" })).toBe("last_30_days");
    expect(rangeKey({ last: 12, unit: "month" })).toBe("last_12_months");
    expect(rangeKey({ to_date: "month" })).toBe("month_to_date");
    expect(rangeKey({ last: 1, unit: "month" })).toBe("month_to_date");
    expect(rangeKey({ last_complete: "quarter" })).toBe("last_complete_quarter");
    expect(rangeKey("last_complete_quarter")).toBe("last_complete_quarter");
    expect(rangeKey({ start: "2026-01-01", end: "2026-04-01" })).toBe("2026-01-01..2026-03-31");
    expect(rangeKey({ start: "2024-02-01", end: "2024-03-01" })).toBe("2024-02-01..2024-02-29");
  });

  it("parses a range of days with the last day included, and nothing else", () => {
    expect(parseDaysKey("2026-01-01..2026-03-31")).toEqual({
      start: "2026-01-01",
      end: "2026-04-01",
    });
    expect(parseDaysKey("2026-03-05..2026-03-05")).toEqual({
      start: "2026-03-05",
      end: "2026-03-06",
    });
    for (const bad of [
      "2026-03-05..2026-03-04",
      "2026-02-30..2026-03-04",
      "2026-1-01..2026-03-04",
      "last_7_days",
      "2026-01-01...2026-02-01",
      "",
    ]) {
      expect(parseDaysKey(bad), bad).toBeUndefined();
    }
  });

  it("names presets the way a reader says them", () => {
    expect(rangeName({ last: 7, unit: "day" })).toBe("Last 7 days");
    expect(rangeName("last_12_months")).toBe("Last 12 months");
    expect(rangeName({ to_date: "quarter" })).toBe("Quarter to date");
    expect(rangeName({ last: 1, unit: "week" })).toBe("Week to date");
    expect(rangeName({ last_complete: "month" })).toBe("Last month");
    expect(rangeName("all_time")).toBe("All time");
    expect(rangeName({ start: "2026-01-01", end: "2026-02-01" })).toBeUndefined();
  });
});

describe("effectiveRange", () => {
  const param = { id: "p", default: "last_30_days" as const };
  it("binds named ranges, shorthands and custom ranges", () => {
    expect(effectiveRange("all_time", param, {})).toBe("last_30_days");
    expect(effectiveRange("all_time", param, { p: "year_to_date" })).toBe("year_to_date");
    const custom = { start: "2026-01-01", end: "2026-02-01" };
    expect(effectiveRange("all_time", param, { p: custom })).toBe(custom);
    expect(effectiveRange("all_time", param, { p: { to_date: "week" } })).toEqual({
      to_date: "week",
    });
  });

  it("refuses anything that is not a range", () => {
    for (const bad of [
      "last_8_days",
      { start: "2026-02-01", end: "2026-01-01" },
      { start: "2026-02-30", end: "2026-03-01" },
      { start: "2026-01-01", end: "2026-02-01", extra: 1 },
      { last: 0, unit: "day" },
      { last: 2.5, unit: "day" },
      { to_date: "decade" },
      ["2026-01-01"],
      null,
      7,
    ]) {
      expect(() => effectiveRange("all_time", param, { p: bad }), JSON.stringify(bad)).toThrow(
        TypeError,
      );
    }
  });
});

const measures: PlannedQuery["measures"] = [
  {
    metric: "revenue",
    components: [
      { id: "revenue__sum", aggregate: "sum", column: "amount", filters: [], reaggregate: "sum" },
    ],
    combine: { op: "identity", component: "revenue__sum" },
  },
  {
    metric: "orders",
    components: [{ id: "orders__count", aggregate: "count", filters: [], reaggregate: "sum" }],
    combine: { op: "identity", component: "orders__count" },
  },
  {
    metric: "biggest",
    components: [
      { id: "biggest__max", aggregate: "max", column: "amount", filters: [], reaggregate: "max" },
    ],
    combine: { op: "identity", component: "biggest__max" },
  },
  {
    metric: "customers",
    components: [
      {
        id: "customers__count_distinct",
        aggregate: "count_distinct",
        column: "c",
        filters: [],
        reaggregate: "none",
      },
    ],
    combine: { op: "identity", component: "customers__count_distinct" },
  },
];

function query(extra: Partial<PlannedQuery>): PlannedQuery {
  return {
    id: "q",
    source: "orders",
    input: { type: "csv", path: "data/orders.csv" } as PlannedQuery["input"],
    measures,
    dimensions: [],
    groupingSets: [[]],
    window: { range: "all_time", shift: "none", column: "ordered_at" },
    params: [
      { id: "p", kind: "period", source: "orders", column: "ordered_at", default: "all_time" },
    ],
    ...extra,
  };
}

const CUBE: DayCube = {
  columns: ["region"],
  days: [0, 0, 1, 2, 3],
  keys: [["A", null, "A", "A", null]],
  values: {
    revenue__sum: [10, 5, 7, 0, 1.5],
    orders__count: [2, 1, 1, 0, 1],
    biggest__max: [6, 5, 7, null, 1.5],
    customers__count_distinct: [2, 1, 1, 0, 1],
  },
};

const context = (start: string, end: string) => ({
  asOf: "2026-03-10",
  timezone: "UTC",
  anchors: DEFAULT_ANCHORS,
  bindings: { p: { start, end } },
});

describe("cubeResult", () => {
  it("re-aggregates days into weeks and grouping sets, nulls as a real group", () => {
    const q = query({
      dimensions: [
        { kind: "time", column: "ordered_at", grain: { unit: "week", anchor: "monday" } },
        { kind: "column", column: "region" },
      ],
      groupingSets: [[0, 1], [1], []],
    });
    const result = cubeResult(q, CUBE, "2026-03-07", context("2026-03-07", "2026-03-11"));
    expect(result?.rows).toEqual([
      ["2026-03-02", "A", 17, 3, 7, null],
      ["2026-03-02", null, 5, 1, 5, null],
      ["2026-03-09", "A", 0, 0, null, null],
      ["2026-03-09", null, 1.5, 1, 1.5, null],
      [null, "A", 17, 3, 7, null],
      [null, null, 6.5, 2, 5, null],
      [null, null, 23.5, 5, 7, null],
    ]);
    expect(result?.groupingSet).toEqual([0, 0, 0, 0, 1, 1, 2]);
  });

  it("keeps one grand-total row for an empty window, with sums and counts at 0", () => {
    const result = cubeResult(query({}), CUBE, "2026-03-07", context("2026-03-20", "2026-03-25"));
    expect(result?.rows).toEqual([[0, 0, null, null]]);
  });

  it("reads only the days inside the window, its comparison included", () => {
    const shifted = query({
      window: { range: "all_time", shift: "previous_period", column: "ordered_at" },
    });
    const current = cubeResult(query({}), CUBE, "2026-03-07", context("2026-03-08", "2026-03-10"));
    const previous = cubeResult(shifted, CUBE, "2026-03-07", context("2026-03-08", "2026-03-10"));
    expect(current?.rows).toEqual([[7, 1, 7, null]]);
    expect(previous?.rows).toEqual([[15, 3, 6, null]]);
  });
});

describe("dayCubeQuery", () => {
  it("keeps the column dimensions and select filters, drops the period filter, and opens the window", () => {
    const q = query({
      dimensions: [
        { kind: "time", column: "ordered_at", grain: { unit: "month" } },
        { kind: "column", column: "region" },
      ],
      groupingSets: [[0, 1], [1]],
      params: [
        { id: "p", kind: "period", source: "orders", column: "ordered_at", default: "all_time" },
        {
          id: "r",
          kind: "select",
          source: "orders",
          column: "region",
          operator: "in",
          multiple: false,
          default: ["A"],
        },
      ],
      window: { range: "last_12_months", shift: "previous_year", column: "ordered_at" },
    });
    const cube = dayCubeQuery(q);
    expect(cube).toMatchObject({
      dimensions: [
        { kind: "time", column: "ordered_at", grain: { unit: "day" } },
        { kind: "column", column: "region" },
      ],
      groupingSets: [[0, 1]],
      window: { range: "all_time", shift: "none", column: "ordered_at" },
      params: [{ id: "r", kind: "select" }],
    });
    expect(dayCubeQuery({ ...q, window: { range: "all_time", shift: "none" } })).toBeUndefined();
    expect(dayCubeQuery({ ...q, params: [] })).toBeUndefined();
  });
});

describe("pageWeight (HM5002)", () => {
  const project = projectFrom({
    dashboards: {
      sales: {
        ...DASHBOARD,
        filters: [{ type: "period", id: "p", options: ["last_7_days"], default: "last_7_days" }],
      },
    },
  });
  it("is quiet within the budget and names the parts above it", () => {
    expect(pageWeight(project, "sales", "x".repeat(PAGE_BUDGET), undefined)).toBeUndefined();
    const heavy = pageWeight(project, "sales", "x".repeat(PAGE_BUDGET + 1), undefined);
    expect(heavy).toMatchObject({ code: "HM5002", severity: "warning", pointer: "" });
    expect(heavy?.message).toContain("charts and markup 3.0 MB");
  });

  it("counts multi-byte text in bytes and points at the period filter when custom data weighs", () => {
    const text = "\u20ac".repeat(Math.ceil(PAGE_BUDGET / 3) + 1);
    const periods = {
      version: 1 as const,
      filter: "p",
      presets: {},
      custom: { cubes: { big: "x".repeat(1_000_000) } } as never,
    };
    const heavy = pageWeight(project, "sales", text, periods);
    expect(heavy?.pointer).toBe("/filters/0");
    expect(heavy?.message).toContain("day-grain data for custom ranges 1.0 MB");
    expect(heavy?.help).toContain("custom: false");
  });
});
