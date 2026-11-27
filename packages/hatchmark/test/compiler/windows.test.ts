import { describe, expect, it } from "vitest";
import { bucketStart, resolveRange, timeBuckets } from "../../src/compiler/index.js";
import { DEFAULT_ANCHORS } from "../../src/spec/index.js";

const days = (start: string, end: string) => (Date.parse(end) - Date.parse(start)) / 86_400_000;

describe("resolveRange (named ranges)", () => {
  it("compares the last complete month with the calendar month before it (HAT-14)", () => {
    expect(resolveRange("last_complete_month", "none", "2026-11-15", DEFAULT_ANCHORS)).toEqual({
      kind: "bounded",
      start: "2026-10-01",
      end: "2026-11-01",
    });
    const previous = resolveRange(
      "last_complete_month",
      "previous_period",
      "2026-11-15",
      DEFAULT_ANCHORS,
    );
    expect(previous).toEqual({ kind: "bounded", start: "2026-09-01", end: "2026-10-01" });
    const perDay = 100;
    const current = 31 * perDay;
    const before = 30 * perDay;
    expect(((current - before) / before) * 100).toBeCloseTo(3.33, 2);
    expect(
      resolveRange("last_complete_month", "previous_year", "2026-11-15", DEFAULT_ANCHORS),
    ).toEqual({
      kind: "bounded",
      start: "2025-10-01",
      end: "2025-11-01",
    });
    expect(
      resolveRange("last_complete_month", "none", "2026-11-30", DEFAULT_ANCHORS),
    ).toMatchObject({
      start: "2026-11-01",
    });
  });

  it("shifts a rolling 30-day range back by 30 days", () => {
    const current = resolveRange("last_30_days", "none", "2026-11-15", DEFAULT_ANCHORS);
    const previous = resolveRange("last_30_days", "previous_period", "2026-11-15", DEFAULT_ANCHORS);
    expect(current).toEqual({ kind: "bounded", start: "2026-10-17", end: "2026-11-16" });
    expect(previous).toEqual({ kind: "bounded", start: "2026-09-17", end: "2026-10-17" });
    if (current?.kind === "bounded" && previous?.kind === "bounded") {
      expect(days(current.start, current.end)).toBe(30);
      expect(days(previous.start, previous.end)).toBe(30);
    }
    expect(resolveRange("last_7_days", "previous_year", "2026-11-15", DEFAULT_ANCHORS)).toEqual({
      kind: "bounded",
      start: "2025-11-09",
      end: "2025-11-16",
    });
  });

  it("compares to-date ranges with the same elapsed span of the previous unit", () => {
    expect(
      resolveRange("quarter_to_date", "previous_period", "2026-11-15", DEFAULT_ANCHORS),
    ).toEqual({
      kind: "bounded",
      start: "2026-07-01",
      end: "2026-08-16",
    });
    expect(resolveRange("month_to_date", "previous_period", "2026-03-31", DEFAULT_ANCHORS)).toEqual(
      {
        kind: "bounded",
        start: "2026-02-01",
        end: "2026-03-01",
      },
    );
    expect(resolveRange("year_to_date", "previous_period", "2028-02-29", DEFAULT_ANCHORS)).toEqual({
      kind: "bounded",
      start: "2027-01-01",
      end: "2027-03-01",
    });
  });

  it("treats last_12_months as rolling calendar months and quarters as calendar units", () => {
    expect(resolveRange("last_12_months", "none", "2026-11-15", DEFAULT_ANCHORS)).toEqual({
      kind: "bounded",
      start: "2025-12-01",
      end: "2026-11-16",
    });
    expect(
      resolveRange("last_12_months", "previous_period", "2026-11-15", DEFAULT_ANCHORS),
    ).toEqual({
      kind: "bounded",
      start: "2024-12-01",
      end: "2025-11-16",
    });
    expect(
      resolveRange("last_complete_quarter", "previous_period", "2026-11-15", DEFAULT_ANCHORS),
    ).toEqual({
      kind: "bounded",
      start: "2026-04-01",
      end: "2026-07-01",
    });
    expect(resolveRange("last_complete_year", "none", "2026-12-31", DEFAULT_ANCHORS)).toMatchObject(
      {
        start: "2026-01-01",
        end: "2027-01-01",
      },
    );
  });

  it("leaves all_time unbounded and without a comparison", () => {
    expect(resolveRange("all_time", "none", "2026-11-15", DEFAULT_ANCHORS)).toEqual({
      kind: "unbounded",
    });
    expect(
      resolveRange("all_time", "previous_period", "2026-11-15", DEFAULT_ANCHORS),
    ).toBeUndefined();
  });
});

describe("resolveRange (shorthands, anchors and shifts)", () => {
  const b = (start: string, end: string) => ({ kind: "bounded", start, end });
  const FISCAL = { week: "sunday", quarter: "02-01", year: "02-01" } as const;

  it("resolves every named range exactly like its shorthand", () => {
    const pairs = [
      ["last_7_days", { last: 7, unit: "day" }],
      ["last_90_days", { last: 90, unit: "day" }],
      ["last_12_months", { last: 12, unit: "month" }],
      ["quarter_to_date", { to_date: "quarter" }],
      ["year_to_date", { to_date: "year" }],
      ["last_complete_quarter", { last_complete: "quarter" }],
      ["last_complete_year", { last_complete: "year" }],
    ] as const;
    for (const [name, shorthand] of pairs) {
      for (const shift of ["none", "previous_period", "previous_year"] as const) {
        for (const asOf of ["2024-02-29", "2026-03-31", "2026-12-31"]) {
          expect(resolveRange(name, shift, asOf, FISCAL), `${name} ${shift} ${asOf}`).toEqual(
            resolveRange(shorthand, shift, asOf, FISCAL),
          );
        }
      }
    }
  });

  it("starts quarters and years at their anchors", () => {
    expect(resolveRange({ to_date: "quarter" }, "none", "2026-03-10", FISCAL)).toEqual(
      b("2026-02-01", "2026-03-11"),
    );
    expect(resolveRange({ to_date: "year" }, "previous_period", "2026-01-15", FISCAL)).toEqual(
      b("2024-02-01", "2025-01-16"),
    );
    expect(resolveRange({ last_complete: "year" }, "none", "2026-01-31", FISCAL)).toEqual(
      b("2025-02-01", "2026-02-01"),
    );
    expect(resolveRange({ last_complete: "year" }, "none", "2026-01-30", FISCAL)).toEqual(
      b("2024-02-01", "2025-02-01"),
    );
    expect(resolveRange({ last_complete: "week" }, "none", "2026-11-27", FISCAL)).toEqual(
      b("2026-11-15", "2026-11-22"),
    );
    expect(resolveRange({ last_complete: "week" }, "none", "2026-11-28", FISCAL)).toEqual(
      b("2026-11-22", "2026-11-29"),
    );
  });

  it("shifts by whole units, clamping month ends and leap days", () => {
    const shift = (unit: "day" | "week" | "month" | "year", by: number) => ({
      shift: { unit, by },
    });
    expect(
      resolveRange(
        { start: "2026-01-01", end: "2026-04-01" },
        shift("year", -1),
        "2026-05-01",
        FISCAL,
      ),
    ).toEqual(b("2025-01-01", "2025-04-01"));
    expect(
      resolveRange(
        { start: "2026-01-01", end: "2026-04-01" },
        "previous_period",
        "2026-05-01",
        FISCAL,
      ),
    ).toEqual(b("2025-10-03", "2026-01-01"));
    expect(resolveRange({ to_date: "month" }, shift("month", -1), "2026-03-31", FISCAL)).toEqual(
      b("2026-02-01", "2026-03-01"),
    );
    expect(
      resolveRange({ to_date: "year" }, "previous_year", "2028-02-29", DEFAULT_ANCHORS),
    ).toEqual(b("2027-01-01", "2027-03-01"));
    expect(
      resolveRange({ last: 7, unit: "day" }, shift("week", -52), "2026-11-27", FISCAL),
    ).toEqual(b("2025-11-22", "2025-11-29"));
    expect(
      resolveRange({ last_complete: "month" }, shift("month", -12), "2026-11-15", FISCAL),
    ).toEqual(resolveRange("last_complete_month", "previous_year", "2026-11-15", FISCAL));
  });

  it("leaves all_time without any shifted window", () => {
    expect(
      resolveRange("all_time", { shift: { unit: "year", by: -1 } }, "2026-11-27", FISCAL),
    ).toBe(undefined);
  });
});

describe("resolveRange (review of #14)", () => {
  const b = (start: string, end: string) => ({ kind: "bounded", start, end });
  const shift = (unit: "day" | "week" | "month" | "year", by: number) => ({ shift: { unit, by } });

  it("moves both ends of a non-to-date range by an explicit shift", () => {
    expect(
      resolveRange({ last_complete: "month" }, shift("week", -1), "2026-03-15", DEFAULT_ANCHORS),
    ).toEqual(b("2026-01-25", "2026-02-22"));
    expect(
      resolveRange({ last: 2, unit: "month" }, shift("month", -1), "2026-03-30", DEFAULT_ANCHORS),
    ).toEqual(b("2026-01-01", "2026-02-28"));
    expect(
      resolveRange({ last_complete: "quarter" }, "previous_year", "2026-11-15", DEFAULT_ANCHORS),
    ).toEqual(b("2025-07-01", "2025-10-01"));
  });

  it("reads to_date day as the as-of day", () => {
    expect(resolveRange({ to_date: "day" }, "none", "2026-03-01", DEFAULT_ANCHORS)).toEqual(
      b("2026-03-01", "2026-03-02"),
    );
    expect(
      resolveRange({ to_date: "day" }, "previous_period", "2026-03-01", DEFAULT_ANCHORS),
    ).toEqual(b("2026-02-28", "2026-03-01"));
  });

  it("keeps years 0 to 99 as themselves", () => {
    expect(timeBuckets("0099-12-30", "0100-01-02", { unit: "day" })).toEqual([
      "0099-12-30",
      "0099-12-31",
      "0100-01-01",
    ]);
    expect(bucketStart("0004-03-03", { unit: "week", anchor: "monday" })).toBe("0004-03-01");
    expect(bucketStart("0004-02-29", { unit: "week", anchor: "monday" })).toBe("0004-02-23");
  });

  it("clamps windows to years 0000 to 9999, and has none beyond them", () => {
    const range = { start: "2026-02-01", end: "2026-03-01" };
    expect(resolveRange(range, shift("year", -3000), "2026-03-15", DEFAULT_ANCHORS)).toBe(
      undefined,
    );
    expect(
      resolveRange(
        { start: "9000-01-01", end: "9000-02-01" },
        shift("year", 1000),
        "9000-03-15",
        DEFAULT_ANCHORS,
      ),
    ).toBe(undefined);
    expect(
      resolveRange({ last: 3000, unit: "year" }, "none", "2026-03-15", DEFAULT_ANCHORS),
    ).toEqual(b("0000-01-01", "2026-03-16"));
  });
});
