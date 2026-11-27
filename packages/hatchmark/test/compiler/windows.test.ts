import { describe, expect, it } from "vitest";
import { bucketStart, resolveRange, timeBuckets } from "../../src/compiler/index.js";
import { comparison, DEFAULT_ANCHORS, PERIOD_RANGES } from "../../src/spec/index.js";

const days = (start: string, end: string) => (Date.parse(end) - Date.parse(start)) / 86_400_000;

describe("resolveRange (named ranges)", () => {
  it("compares the last complete month with the calendar month before it", () => {
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

describe("resolveRange (#14)", () => {
  const b = (start: string, end: string) => ({ kind: "bounded", start, end });
  const shift = (unit: "day" | "week" | "month" | "year", by: number) => ({ shift: { unit, by } });

  it("moves both ends of a non-to-date range by an explicit shift", () => {
    expect(
      resolveRange({ last_complete: "month" }, shift("week", -1), "2026-03-15", DEFAULT_ANCHORS),
    ).toEqual(b("2026-01-25", "2026-02-22"));
    expect(
      resolveRange({ last: 2, unit: "month" }, shift("month", -1), "2026-03-30", DEFAULT_ANCHORS),
    ).toEqual(b("2026-01-01", "2026-03-01"));
    expect(resolveRange("last_7_days", shift("month", -1), "2026-03-28", DEFAULT_ANCHORS)).toEqual(
      b("2026-02-22", "2026-03-01"),
    );
    expect(
      resolveRange({ last_complete: "day" }, shift("month", -1), "2026-03-30", DEFAULT_ANCHORS),
    ).toEqual(b("2026-02-28", "2026-03-01"));
    expect(
      resolveRange(
        { start: "2026-01-30", end: "2026-01-31" },
        shift("month", 1),
        "2026-03-30",
        DEFAULT_ANCHORS,
      ),
    ).toEqual(b("2026-02-28", "2026-03-01"));
    expect(resolveRange("last_7_days", "previous_year", "2029-02-28", DEFAULT_ANCHORS)).toEqual(
      b("2028-02-22", "2028-02-29"),
    );
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

  it("rejects windows outside the supported dates instead of truncating them", () => {
    const range = { start: "2026-02-01", end: "2026-03-01" };
    expect(() => resolveRange(range, shift("year", -3000), "2026-03-15", DEFAULT_ANCHORS)).toThrow(
      "outside the supported dates 0001-01-01 to 9998-12-31",
    );
    expect(() =>
      resolveRange({ last: 2, unit: "day" }, "none", "9998-12-31", DEFAULT_ANCHORS),
    ).not.toThrow();
    expect(() =>
      resolveRange({ last: 2, unit: "day" }, "none", "9999-12-31", DEFAULT_ANCHORS),
    ).toThrow(RangeError);
    expect(() =>
      resolveRange({ last: 7, unit: "day" }, "none", "0001-01-06", DEFAULT_ANCHORS),
    ).toThrow(RangeError);
    expect(resolveRange({ last: 7, unit: "day" }, "none", "0001-01-07", DEFAULT_ANCHORS)).toEqual(
      b("0001-01-01", "0001-01-08"),
    );
    expect(() =>
      resolveRange({ last: 1, unit: "day" }, shift("day", 1e15), "2026-03-15", DEFAULT_ANCHORS),
    ).toThrow(RangeError);
    expect(bucketStart("0000-01-01", { unit: "quarter", anchor: "02-01" })).toBe("-0001-11-01");
    expect(bucketStart("0001-01-01", { unit: "week", anchor: "monday" })).toBe("0001-01-01");
    expect(bucketStart("0001-01-01", { unit: "year", anchor: "02-01" })).toBe("0000-02-01");
  });

  it("accepts any shift that stays inside the supported dates (no fixed cap)", () => {
    const parsed = comparison.parse({ shift: { unit: "day", by: -3661 } });
    expect(
      resolveRange(
        { start: "2026-02-01", end: "2026-03-01" },
        parsed,
        "2026-03-15",
        DEFAULT_ANCHORS,
      ),
    ).toEqual(b("2016-01-24", "2016-02-21"));
    expect(comparison.safeParse({ shift: { unit: "year", by: -2025 } }).success).toBe(true);
    expect(comparison.safeParse({ shift: { unit: "year", by: 0.5 } }).success).toBe(false);
  });

  it("moves the first and last day of any range by whole months (property, 2023-2028)", () => {
    const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
    const DAY = 86_400_000;
    const oracle = (date: string, months: number) => {
      const [y = 0, m = 1, d = 1] = date.split("-").map(Number);
      const index = y * 12 + m - 1 + months;
      const ty = Math.floor(index / 12);
      const tm = index - ty * 12;
      const last = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
      return iso(Date.UTC(ty, tm, Math.min(d, last)));
    };
    const length = (w: { start: string; end: string }) =>
      (Date.parse(w.end) - Date.parse(w.start)) / DAY;
    let checked = 0;
    const failures: string[] = [];
    for (let t = Date.UTC(2023, 0, 1); t < Date.UTC(2029, 0, 1); t += 3 * DAY) {
      for (const days of [1, 2, 7, 28, 29, 30, 31, 45, 90, 365]) {
        const window = { start: iso(t), end: iso(t + days * DAY) };
        const lastDay = iso(t + (days - 1) * DAY);
        for (const by of [-25, -13, -12, -1, 1, 3, 12, 24]) {
          const moved = resolveRange(window, shift("month", by), "2026-01-01", DEFAULT_ANCHORS);
          if (moved?.kind !== "bounded") throw new Error("unbounded");
          const aligned = window.start.endsWith("-01") && window.end.endsWith("-01");
          const start = oracle(window.start, by);
          const end = aligned ? oracle(window.end, by) : iso(Date.parse(oracle(lastDay, by)) + DAY);
          const delta = length(moved) - days;
          const sameMonth = !aligned && window.start.slice(0, 7) === lastDay.slice(0, 7);
          if (
            moved.start !== start ||
            moved.end !== end ||
            length(moved) <= 0 ||
            (by % 12 === 0 && Math.abs(delta) > 1) ||
            (sameMonth && (delta > 0 || delta < -3))
          ) {
            failures.push(
              `${window.start} +${days}d by ${by}: got ${moved.start}..${moved.end} want ${start}..${end}`,
            );
          }
          checked++;
        }
      }
    }
    expect(failures.slice(0, 5)).toEqual([]);
    expect(checked).toBeGreaterThan(50_000);
    for (let y = 2023; y <= 2028; y++) {
      for (let m = 1; m <= 12; m++) {
        for (const months of [1, 2, 3, 12]) {
          const start = `${y}-${String(m).padStart(2, "0")}-01`;
          const window = { start, end: oracle(start, months) };
          for (const s of [
            shift("month", -1),
            shift("month", 5),
            shift("year", -1),
            { shift: { unit: "quarter", by: -1 } } as const,
          ]) {
            const moved = resolveRange(window, s, "2026-01-01", DEFAULT_ANCHORS);
            if (moved?.kind !== "bounded") throw new Error("unbounded");
            const by =
              s.shift.by * (s.shift.unit === "year" ? 12 : s.shift.unit === "quarter" ? 3 : 1);
            expect(moved, `${start} +${months}mo ${JSON.stringify(s)}`).toEqual(
              b(oracle(start, by), oracle(window.end, by)),
            );
          }
        }
      }
    }
  });

  it("makes previous_year exactly a shift by -1 year for every range kind", () => {
    const kinds = [
      ...PERIOD_RANGES.filter((r) => r !== "all_time"),
      { last: 7, unit: "day" },
      { last: 3, unit: "week" },
      { last: 2, unit: "month" },
      { to_date: "day" },
      { to_date: "week" },
      { last_complete: "day" },
      { last_complete: "week" },
      { start: "2024-02-29", end: "2024-03-02" },
      { start: "2024-02-01", end: "2024-03-01" },
    ] as const;
    for (let t = Date.UTC(2023, 0, 1); t < Date.UTC(2029, 0, 1); t += 86_400_000) {
      const asOf = new Date(t).toISOString().slice(0, 10);
      for (const range of kinds) {
        expect(
          resolveRange(range, "previous_year", asOf, DEFAULT_ANCHORS),
          `${JSON.stringify(range)} ${asOf}`,
        ).toEqual(resolveRange(range, shift("year", -1), asOf, DEFAULT_ANCHORS));
      }
    }
  });

  it("keeps whole months whole and rolling days exact", () => {
    expect(
      resolveRange("last_complete_month", "previous_year", "2021-03-15", DEFAULT_ANCHORS),
    ).toEqual(b("2020-02-01", "2020-03-01"));
    expect(
      resolveRange({ last_complete: "month" }, shift("month", -1), "2023-03-30", DEFAULT_ANCHORS),
    ).toEqual(b("2023-01-01", "2023-02-01"));
    expect(
      resolveRange(
        { start: "2026-04-01", end: "2026-05-01" },
        shift("month", -1),
        "2026-05-15",
        DEFAULT_ANCHORS,
      ),
    ).toEqual(b("2026-03-01", "2026-04-01"));
    expect(resolveRange("last_7_days", "previous_year", "2025-02-28", DEFAULT_ANCHORS)).toEqual(
      b("2024-02-22", "2024-02-29"),
    );
  });

  it("shifts every range kind exactly like its resolved window", () => {
    const kinds = [
      { last: 7, unit: "day" },
      { last: 2, unit: "month" },
      { last: 3, unit: "week" },
      { to_date: "month" },
      { to_date: "quarter" },
      { last_complete: "month" },
      { last_complete: "day" },
    ] as const;
    for (let t = Date.UTC(2023, 0, 1); t < Date.UTC(2029, 0, 1); t += 5 * 86_400_000) {
      const asOf = new Date(t).toISOString().slice(0, 10);
      for (const range of kinds) {
        const current = resolveRange(range, "none", asOf, DEFAULT_ANCHORS);
        if (current?.kind !== "bounded") throw new Error("unbounded");
        const window = { start: current.start, end: current.end };
        for (const s of [shift("month", -1), shift("year", -1), shift("week", -1)]) {
          expect(
            resolveRange(range, s, asOf, DEFAULT_ANCHORS),
            `${JSON.stringify(range)} ${asOf}`,
          ).toEqual(resolveRange(window, s, asOf, DEFAULT_ANCHORS));
        }
      }
    }
  });
});
