import { describe, expect, it } from "vitest";
import { flowTarget, pointTarget, targetBuckets } from "../../src/compiler/index.js";
import { parseInstant } from "../../src/compiler/instants.js";

const month = { unit: "month" } as const;
const flow = (prorate: "days" | "none" = "days") => ({ grain: month, additive: true, prorate });
const values = new Map([
  ["2026-01-01", 310],
  ["2026-02-01", 280],
  ["2026-03-01", 310],
]);

describe("flowTarget", () => {
  it("prorates the buckets a window starts and ends inside by their days", () => {
    expect(flowTarget(values, flow(), "2026-01-21", "2026-02-11")).toEqual({
      value: (310 * 11) / 31 + (280 * 10) / 28,
      prorated: true,
    });
  });

  it("sums whole buckets into a coarser one without prorating", () => {
    expect(flowTarget(values, flow(), "2026-01-01", "2026-04-01")).toEqual({
      value: 900,
      prorated: false,
    });
  });

  it("has no value for a coarser bucket with a missing month", () => {
    const gap = new Map([
      ["2026-01-01", 310],
      ["2026-03-01", 310],
    ]);
    expect(flowTarget(gap, flow(), "2026-01-01", "2026-04-01").value).toBeNull();
  });

  it("with prorate none, has a value only where buckets fit whole", () => {
    expect(flowTarget(values, flow("none"), "2026-02-01", "2026-03-01").value).toBe(280);
    expect(flowTarget(values, flow("none"), "2026-02-02", "2026-03-01").value).toBeNull();
  });

  it("for a metric that doesn't add up, has a value only for exactly one bucket", () => {
    const target = { grain: month, additive: false, prorate: "none" as const };
    expect(flowTarget(values, target, "2026-02-01", "2026-03-01").value).toBe(280);
    expect(flowTarget(values, target, "2026-01-01", "2026-03-01").value).toBeNull();
  });

  it("snaps dates to their bucket and splits a week by its days in the window", () => {
    const weeks = targetBuckets(
      [
        { date: "2026-01-26", value: 70 },
        { date: "2026-01-28", value: 7 },
      ],
      { unit: "week", anchor: "monday" },
    );
    expect([...weeks]).toEqual([["2026-01-26", 77]]);
    const target = { grain: { unit: "week", anchor: "monday" } as const, additive: true };
    expect(flowTarget(weeks, { ...target, prorate: "days" }, "2026-01-26", "2026-02-01")).toEqual({
      value: 66,
      prorated: true,
    });
  });
});

describe("pointTarget", () => {
  const goal = new Map([
    ["2026-12-01", 7_400_000],
    ["2027-12-01", 12_000_000],
  ]);
  const at = (date: string) => parseInstant(date);

  it("holds each value at its bucket's end", () => {
    expect(pointTarget(goal, { grain: month }, at("2027-01-01"))).toBe(7_400_000);
    expect(pointTarget(goal, { grain: month }, at("2028-01-01"))).toBe(12_000_000);
  });

  it("moves linearly by default", () => {
    const value = pointTarget(goal, { grain: month }, at("2027-07-01"));
    expect(value).toBeCloseTo(7_400_000 + (4_600_000 * 181) / 365, 6);
  });

  it("moves by a constant factor with path compound, checked by hand", () => {
    const value = pointTarget(goal, { grain: month, path: "compound" }, at("2027-07-01"));
    expect(value).toBeCloseTo(7_400_000 * (12 / 7.4) ** (181 / 365), 4);
    expect(Math.round(value ?? 0)).toBe(9_404_672);
  });

  it("has no target before the first value or after the last", () => {
    expect(pointTarget(goal, { grain: month }, at("2026-12-31"))).toBeNull();
    expect(pointTarget(goal, { grain: month }, at("2028-01-01") + 1n)).toBeNull();
  });

  it("compound needs positive values on both sides", () => {
    const signs = new Map([
      ["2026-01-01", -10],
      ["2026-02-01", 10],
    ]);
    expect(pointTarget(signs, { grain: month, path: "compound" }, at("2026-02-15"))).toBeNull();
    expect(pointTarget(signs, { grain: month }, at("2026-02-15"))).toBeCloseTo(
      -10 + (20 * 14) / 28,
      9,
    );
  });
});
