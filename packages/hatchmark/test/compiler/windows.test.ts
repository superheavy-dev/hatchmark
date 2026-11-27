import { describe, expect, it } from "vitest";
import { windowBounds } from "../../src/compiler/index.js";

const days = (start: string, end: string) => (Date.parse(end) - Date.parse(start)) / 86_400_000;

describe("windowBounds", () => {
  it("compares the last complete month with the calendar month before it (HAT-14)", () => {
    expect(windowBounds("last_complete_month", "none", "2026-11-15")).toEqual({
      kind: "bounded",
      start: "2026-10-01",
      end: "2026-11-01",
    });
    const previous = windowBounds("last_complete_month", "previous_period", "2026-11-15");
    expect(previous).toEqual({ kind: "bounded", start: "2026-09-01", end: "2026-10-01" });
    const perDay = 100;
    const current = 31 * perDay;
    const before = 30 * perDay;
    expect(((current - before) / before) * 100).toBeCloseTo(3.33, 2);
    expect(windowBounds("last_complete_month", "previous_year", "2026-11-15")).toEqual({
      kind: "bounded",
      start: "2025-10-01",
      end: "2025-11-01",
    });
    expect(windowBounds("last_complete_month", "none", "2026-11-30")).toMatchObject({
      start: "2026-11-01",
    });
  });

  it("shifts a rolling 30-day range back by 30 days", () => {
    const current = windowBounds("last_30_days", "none", "2026-11-15");
    const previous = windowBounds("last_30_days", "previous_period", "2026-11-15");
    expect(current).toEqual({ kind: "bounded", start: "2026-10-17", end: "2026-11-16" });
    expect(previous).toEqual({ kind: "bounded", start: "2026-09-17", end: "2026-10-17" });
    if (current?.kind === "bounded" && previous?.kind === "bounded") {
      expect(days(current.start, current.end)).toBe(30);
      expect(days(previous.start, previous.end)).toBe(30);
    }
    expect(windowBounds("last_7_days", "previous_year", "2026-11-15")).toEqual({
      kind: "bounded",
      start: "2025-11-09",
      end: "2025-11-16",
    });
  });

  it("compares to-date ranges with the same elapsed span of the previous unit", () => {
    expect(windowBounds("quarter_to_date", "previous_period", "2026-11-15")).toEqual({
      kind: "bounded",
      start: "2026-07-01",
      end: "2026-08-16",
    });
    expect(windowBounds("month_to_date", "previous_period", "2026-03-31")).toEqual({
      kind: "bounded",
      start: "2026-02-01",
      end: "2026-03-01",
    });
    expect(windowBounds("year_to_date", "previous_period", "2028-02-29")).toEqual({
      kind: "bounded",
      start: "2027-01-01",
      end: "2027-03-01",
    });
  });

  it("treats last_12_months as rolling calendar months and quarters as calendar units", () => {
    expect(windowBounds("last_12_months", "none", "2026-11-15")).toEqual({
      kind: "bounded",
      start: "2025-12-01",
      end: "2026-11-16",
    });
    expect(windowBounds("last_12_months", "previous_period", "2026-11-15")).toEqual({
      kind: "bounded",
      start: "2024-12-01",
      end: "2025-11-16",
    });
    expect(windowBounds("last_complete_quarter", "previous_period", "2026-11-15")).toEqual({
      kind: "bounded",
      start: "2026-04-01",
      end: "2026-07-01",
    });
    expect(windowBounds("last_complete_year", "none", "2026-12-31")).toMatchObject({
      start: "2026-01-01",
      end: "2027-01-01",
    });
  });

  it("leaves all_time unbounded and without a comparison", () => {
    expect(windowBounds("all_time", "none", "2026-11-15")).toEqual({ kind: "unbounded" });
    expect(windowBounds("all_time", "previous_period", "2026-11-15")).toBeUndefined();
  });
});
