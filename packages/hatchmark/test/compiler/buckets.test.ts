import { describe, expect, it } from "vitest";
import {
  bucketStart,
  type PlannedParam,
  type PlannedQuery,
  queryBounds,
  selectValues,
  timeBuckets,
} from "../../src/compiler/index.js";

describe("bucketStart", () => {
  it("starts weeks on Monday or Sunday", () => {
    expect(bucketStart("2026-11-28", "week", "monday")).toBe("2026-11-23");
    expect(bucketStart("2026-11-28", "week", "sunday")).toBe("2026-11-22");
    expect(bucketStart("2026-11-29", "week", "sunday")).toBe("2026-11-29");
    expect(bucketStart("2026-11-29", "week", "monday")).toBe("2026-11-23");
    expect(bucketStart("2027-01-01", "week", "monday")).toBe("2026-12-28");
  });

  it("truncates to day, month, quarter and year", () => {
    expect(bucketStart("2026-08-17", "day", "monday")).toBe("2026-08-17");
    expect(bucketStart("2026-08-17", "month", "monday")).toBe("2026-08-01");
    expect(bucketStart("2026-08-17", "quarter", "monday")).toBe("2026-07-01");
    expect(bucketStart("2026-08-17", "year", "monday")).toBe("2026-01-01");
  });
});

describe("timeBuckets", () => {
  it("lists every bucket of the span, the partial first and last ones included", () => {
    expect(timeBuckets("2026-04-01", "2026-05-01", "week", "sunday")).toEqual([
      "2026-03-29",
      "2026-04-05",
      "2026-04-12",
      "2026-04-19",
      "2026-04-26",
    ]);
    expect(timeBuckets("2025-11-01", "2026-11-01", "month", "monday")).toHaveLength(12);
    expect(timeBuckets("2026-02-27", "2026-03-02", "day", "monday")).toEqual([
      "2026-02-27",
      "2026-02-28",
      "2026-03-01",
    ]);
    expect(timeBuckets("2025-12-15", "2026-01-02", "quarter", "monday")).toEqual([
      "2025-10-01",
      "2026-01-01",
    ]);
    expect(timeBuckets("2026-01-01", "2026-01-01", "day", "monday")).toEqual([]);
  });
});

describe("queryBounds", () => {
  const query: PlannedQuery = {
    id: "q",
    source: "orders",
    measures: [],
    dimensions: [],
    groupingSets: [[]],
    window: { range: "last_12_months", shift: "previous_period", column: "ordered_at" },
    params: [
      {
        id: "period",
        kind: "period",
        source: "orders",
        column: "ordered_at",
        default: "last_30_days",
      },
    ],
  };

  it("reads the period filter's binding, else its default, on the query's time column", () => {
    expect(queryBounds(query, { asOf: "2026-10-31", bindings: {} })).toEqual({
      kind: "bounded",
      start: "2026-09-02",
      end: "2026-10-02",
    });
    expect(
      queryBounds(query, { asOf: "2026-10-31", bindings: { period: "last_complete_month" } }),
    ).toEqual({
      kind: "bounded",
      start: "2026-09-01",
      end: "2026-10-01",
    });
    expect(() =>
      queryBounds(query, { asOf: "2026-10-31", bindings: { period: "forever" } }),
    ).toThrow("not a period range");
    expect(queryBounds({ ...query, params: [] }, { asOf: "2026-10-31", bindings: {} })).toEqual({
      kind: "bounded",
      start: "2024-11-01",
      end: "2025-11-01",
    });
    const { column: _, ...untimed } = query.window;
    expect(
      queryBounds(
        { ...query, window: { ...untimed, range: "all_time", shift: "none" } },
        { asOf: "2026-10-31", bindings: {} },
      ),
    ).toEqual({
      kind: "unbounded",
    });
  });
});

describe("selectValues", () => {
  const param: PlannedParam & { kind: "select" } = {
    id: "region",
    kind: "select",
    source: "orders",
    column: "region",
    operator: "in",
    multiple: false,
    default: ["West"],
  };

  it("binds the value, else the default; an empty binding means every row", () => {
    expect(selectValues(param, {})).toEqual(["West"]);
    expect(selectValues(param, { region: "East" })).toEqual(["East"]);
    expect(selectValues(param, { region: [] })).toEqual([]);
    expect(selectValues({ ...param, multiple: true }, { region: ["East", "West"] })).toEqual([
      "East",
      "West",
    ]);
  });

  it("refuses several values on a single select, and values that are not scalars", () => {
    expect(() => selectValues(param, { region: ["East", "West"] })).toThrow("takes one value");
    expect(() => selectValues(param, { region: { or: 1 } })).toThrow("not scalar values");
    expect(() => selectValues(param, { region: [Number.NaN] })).toThrow("not scalar values");
  });
});
