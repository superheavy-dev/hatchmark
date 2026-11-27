import { afterAll, describe, expect, it } from "vitest";
import type { KpiData } from "../../src/compiler/index.js";
import { PROJECT_DEFAULTS } from "../../src/spec/index.js";
import { metric, removeProjects, run, writeProject } from "./fixture.js";

afterAll(removeProjects);

async function kpi(options: {
  timezone: string;
  rows: [string, number][];
  period: Record<string, unknown>;
}) {
  const fixture = await writeProject({
    "hatchmark.yaml": {
      ...PROJECT_DEFAULTS,
      name: "ToDate",
      timezone: options.timezone,
      sources: { orders: { type: "csv", path: "orders.csv" } },
    },
    "orders.csv": "at,v\n" + options.rows.map(([at, v]) => at + "," + v).join("\n") + "\n",
    "metrics/orders.yaml": metric({
      type: "aggregate",
      table: "orders",
      aggregate: "sum",
      column: "v",
      time: "at",
    }),
    "dashboards/d.yaml": {
      title: "D",
      period: options.period,
      blocks: [{ type: "kpi", id: "k", metric: "orders" }],
    },
  });
  const { data, diagnostics } = await run(fixture.root, fixture.project, "d");
  const block = data?.blocks.find((b) => b.id === "k") as KpiData | undefined;
  return { block, asOf: data?.asOf, codes: diagnostics.map((d) => d.code + " " + d.message) };
}

describe("to-date KPIs end to end", () => {
  it("east of UTC, month-to-date early on the 1st reads the day so far and notes no HM4024", async () => {
    const { block, codes } = await kpi({
      timezone: "Asia/Seoul",
      rows: [
        ["2026-11-30T23:00:00+09:00", 1],
        ["2026-12-01T01:00:00+09:00", 2],
        ["2026-12-01T05:00:00+09:00", 4],
      ],
      period: { asOf: "latest_data", range: "month_to_date", compare: "previous_period" },
    });
    expect(block?.value).toBe(6);
    expect(codes.filter((c) => c.startsWith("HM4024") || c.startsWith("HM4013"))).toEqual([]);
  });

  it("quarter-to-date compares the same elapsed time of the previous quarter, capped at section 6.2's day", async () => {
    const { block } = await kpi({
      timezone: "UTC",
      rows: [
        ["2026-01-01T00:00:00Z", 1],
        ["2026-02-28T12:00:00Z", 2],
        ["2026-03-01T10:00:00Z", 4],
        ["2026-03-01T15:00:00Z", 8],
        ["2026-04-01T00:00:00Z", 16],
        ["2026-05-30T14:03:00Z", 32],
      ],
      period: { asOf: "latest_data", range: "quarter_to_date", compare: "previous_period" },
    });
    expect(block?.value).toBe(48);
    expect(block?.previousValue).toBe(1 + 2);
  });

  it("year-to-date in a leap year compares through the same date last year, not one more elapsed day", async () => {
    const { block } = await kpi({
      timezone: "America/New_York",
      rows: [
        ["2027-01-01T12:00:00-05:00", 1],
        ["2027-03-15T09:00:00-04:00", 2],
        ["2027-03-15T16:00:00-04:00", 4],
        ["2028-01-02T12:00:00-05:00", 8],
        ["2028-03-14T14:03:00-04:00", 16],
      ],
      period: { asOf: "latest_data", range: "year_to_date", compare: "previous_period" },
    });
    expect(block?.value).toBe(24);
    expect(block?.previousValue).toBe(1);
  });

  it("a comparison end in Auckland's spring-forward gap is read with the offset before the change", async () => {
    const { block } = await kpi({
      timezone: "Pacific/Auckland",
      rows: [
        ["2026-09-01T09:00:00+12:00", 1],
        ["2026-09-27T01:45:00+12:00", 2],
        ["2026-09-27T03:15:00+13:00", 4],
        ["2026-09-27T03:45:00+13:00", 8],
        ["2026-10-02T09:00:00+13:00", 16],
        ["2026-10-27T02:30:00+13:00", 32],
      ],
      period: { asOf: "latest_data", range: "month_to_date", compare: "previous_period" },
    });
    expect(block?.value).toBe(48);
    expect(block?.previousValue).toBe(1 + 2 + 4);
  });

  it("a comparison end in New York's repeated hour is its later occurrence", async () => {
    const { block } = await kpi({
      timezone: "America/New_York",
      rows: [
        ["2026-11-01T01:10:00-04:00", 1],
        ["2026-11-01T01:40:00-04:00", 2],
        ["2026-11-01T01:10:00-05:00", 4],
        ["2026-11-01T01:40:00-05:00", 8],
        ["2026-12-01T01:30:00-05:00", 16],
      ],
      period: { asOf: "latest_data", range: "month_to_date", compare: "previous_period" },
    });
    expect(block?.value).toBe(16);
    expect(block?.previousValue).toBe(1 + 2 + 4);
  });

  it("a fixed as-of on the eve of Havana's fall-back keeps that date and is complete", async () => {
    const { block, codes, asOf } = await kpi({
      timezone: "America/Havana",
      rows: [
        ["2027-10-02T12:00:00-04:00", 1],
        ["2027-11-06T12:00:00-04:00", 2],
        ["2027-11-07T00:30:00-04:00", 4],
        ["2027-11-08T12:00:00-05:00", 8],
      ],
      period: { asOf: "2027-11-06", range: "month_to_date", compare: "previous_period" },
    });
    expect(asOf).toBe("2027-11-06");
    expect(block?.current).toEqual({ start: "2027-11-01", end: "2027-11-07" });
    expect(block?.value).toBe(2 + 4);
    expect(codes).toEqual([]);
  });

  it("a DATE source whose newest day is the eve of Havana's fall-back reads through that day", async () => {
    const { block, asOf } = await kpi({
      timezone: "America/Havana",
      rows: [
        ["2027-10-02", 1],
        ["2027-11-05", 2],
        ["2027-11-06", 4],
      ],
      period: { asOf: "latest_data", range: "month_to_date", compare: "previous_period" },
    });
    expect(asOf).toBe("2027-11-06");
    expect(block?.current).toEqual({ start: "2027-11-01", end: "2027-11-07" });
    expect(block?.value).toBe(6);
  });
});
