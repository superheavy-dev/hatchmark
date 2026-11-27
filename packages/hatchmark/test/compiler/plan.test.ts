import { describe, expect, it } from "vitest";
import type {
  ExecutionContext,
  PlannedParam,
  PlannedQuery,
  PlannedWindow,
} from "../../src/compiler/index.js";

describe("query plan types", () => {
  it("give 7-day and 30-day KPIs different windows, and comparisons their own", () => {
    const query = (window: PlannedWindow): PlannedQuery => ({
      id: "q",
      source: "orders",
      measures: [],
      dimensions: [],
      groupingSets: [[]],
      window,
      params: [],
    });
    const windows = [
      query({ range: "last_7_days", shift: "none", column: "at" }),
      query({ range: "last_30_days", shift: "none", column: "at" }),
      query({ range: "last_7_days", shift: "previous_period", column: "at" }),
      query({ range: "last_7_days", shift: "previous_year", column: "at" }),
      query({ range: "last_7_days", shift: "none", column: "shipped_at" }),
    ].map((q) => JSON.stringify(q.window));
    expect(new Set(windows).size).toBe(windows.length);
    const context: ExecutionContext = {
      asOf: "2026-04-30",
      timezone: "UTC",
      weekStart: "monday",
      bindings: {},
    };
    expect(Object.keys(context)).toEqual(["asOf", "timezone", "weekStart", "bindings"]);
  });

  it("carry each filter's column, so the same filter id on another column is another query", () => {
    const params = (column: string): PlannedParam[] => [
      { id: "slice", kind: "select", source: "orders", column, operator: "in", multiple: false },
    ];
    expect(JSON.stringify(params("region"))).not.toBe(JSON.stringify(params("channel")));
  });
});
