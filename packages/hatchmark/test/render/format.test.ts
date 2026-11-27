import { describe, expect, it } from "vitest";
import {
  formatBucket,
  formatBucketTick,
  formatChange,
  formatSpan,
  formatTicks,
  formatValue,
} from "../../src/render/index.js";

const usd = { format: { type: "currency", currency: "USD" } } as const;
const pct = { format: { type: "percent" } } as const;
const num = { format: { type: "number" } } as const;

describe("formatValue", () => {
  it("shows null as an em dash and a real zero as zero", () => {
    expect(formatValue(null, usd, "en-US", "full")).toBe("\u2014");
    expect(formatValue(0, usd, "en-US", "full")).toBe("$0");
    expect(formatValue(0, pct, "en-US", "headline")).toBe("0.0%");
  });

  it("uses compact currency for large headline values and the minus sign for negatives", () => {
    expect(formatValue(6_142_903, usd, "en-US", "headline")).toBe("$6.14M");
    expect(formatValue(332, usd, "en-US", "headline")).toBe("$332");
    expect(formatValue(18_493, num, "en-US", "headline")).toBe("18,493");
    expect(formatValue(-12_300, usd, "en-US", "full")).toBe("\u2212$12,300");
  });

  it("formats in the dashboard locale and currency", () => {
    expect(
      formatValue(
        1234.5,
        { format: { type: "currency", currency: "EUR", decimals: 2 } },
        "de-DE",
        "full",
      ),
    ).toBe("1.234,50\u00a0\u20ac");
  });
});

describe("formatTicks", () => {
  it("uses the fewest decimals that keep every tick exact", () => {
    expect(formatTicks([0, 500_000, 1_000_000, 1_500_000, 2_000_000], usd, "en-US")).toEqual([
      "$0",
      "$500K",
      "$1M",
      "$1.5M",
      "$2M",
    ]);
    expect(formatTicks([0, 0.01, 0.02, 0.03], pct, "en-US")).toEqual(["0%", "1%", "2%", "3%"]);
  });
});

describe("formatChange", () => {
  it("signs relative changes and shows percentage points with two decimals", () => {
    expect(formatChange(0.1, "relative", "en-US")).toBe("+10.0%");
    expect(formatChange(-0.024, "relative", "en-US")).toBe("\u22122.4%");
    expect(formatChange(0.0027, "points", "en-US")).toBe("+0.27 pp");
    expect(formatChange(null, "relative", "en-US")).toBeUndefined();
  });
});

describe("dates", () => {
  it("names spans by month, quarter, year or days", () => {
    expect(formatSpan({ start: "2026-10-01", end: "2026-11-01" }, "en-US")).toBe("Oct 2026");
    expect(formatSpan({ start: "2025-11-01", end: "2026-11-01" }, "en-US")).toBe(
      "Nov 2025 \u2013 Oct 2026",
    );
    expect(formatSpan({ start: "2026-07-01", end: "2026-10-01" }, "en-US")).toBe("Q3 2026");
    expect(formatSpan({ start: "2026-01-01", end: "2027-01-01" }, "en-US")).toBe("2026");
    expect(formatSpan({ start: "2026-09-07", end: "2026-11-02" }, "en-US")).toBe(
      "Sep 7 \u2013 Nov 1, 2026",
    );
  });

  it("names buckets by grain", () => {
    expect(formatBucket("2026-10-05", "week", "en-US")).toBe("Week of Oct 5, 2026");
    expect(formatBucket("2026-10-01", "quarter", "en-US")).toBe("Q4 2026");
  });

  it("names anchored quarters and years by their first day, never as calendar ones", () => {
    expect(formatBucket("2025-07-01", "year", "en-US")).toBe("Year of Jul 1, 2025");
    expect(formatBucket("2025-02-15", "quarter", "en-US")).toBe("Quarter of Feb 15, 2025");
    expect(formatBucket("2025-01-01", "year", "en-US")).toBe("2025");
    expect(formatBucketTick("2025-07-01", "year", "en-US", false)).toBe("Jul 2025");
    expect(formatBucketTick("2025-02-01", "quarter", "en-US", false)).toBe("Feb 2025");
    expect(formatBucketTick("2025-04-01", "quarter", "en-US", false)).toBe("Q2");
  });
});
