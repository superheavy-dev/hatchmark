import { afterAll, describe, expect, it } from "vitest";
import type { KpiData } from "../../src/compiler/index.js";
import { PROJECT_DEFAULTS } from "../../src/spec/index.js";
import { metric, removeProjects, run, writeProject } from "./fixture.js";

// Source horizons and latest_data (RFC 0001 sections 6.1 and 6.3).

afterAll(removeProjects);

const ORDERS = "ordered_at,amount\n2026-04-28T10:00:00Z,10\n2026-04-29T15:30:00Z,20\n";
const SESSIONS = "day\n2026-04-30\n2026-05-02\n";

async function project(options: {
  sources?: Record<string, unknown>;
  files?: Record<string, string>;
  asOf?: string;
  range?: unknown;
  timezone?: string;
  metrics?: Record<string, unknown>;
}) {
  const metrics = options.metrics ?? {
    revenue: metric({
      type: "aggregate",
      table: "orders",
      aggregate: "sum",
      column: "amount",
      time: "ordered_at",
    }),
    sessions: metric({ type: "aggregate", table: "sessions", aggregate: "count", time: "day" }),
  };
  return writeProject({
    "hatchmark.json": {
      ...PROJECT_DEFAULTS,
      name: "Horizons",
      timezone: options.timezone ?? "UTC",
      sources: options.sources ?? {
        orders: { type: "csv", path: "orders.csv" },
        sessions: { type: "csv", path: "sessions.csv" },
      },
    },
    "orders.csv": ORDERS,
    "sessions.csv": SESSIONS,
    ...options.files,
    ...Object.fromEntries(Object.entries(metrics).map(([n, m]) => [`metrics/${n}.json`, m])),
    "dashboards/d.json": {
      title: "D",
      period: {
        asOf: options.asOf ?? "latest_data",
        range: options.range ?? "all_time",
        compare: "none",
      },
      blocks: Object.keys(metrics).map((m) => ({ type: "kpi", id: m, metric: m })),
    },
  });
}

async function build(fixture: Awaited<ReturnType<typeof project>>, now?: Date) {
  const result = await run(fixture.root, fixture.project, "d", now ? { now } : {});
  return {
    ...result,
    codes: result.diagnostics.map((d) => [d.code, d.severity, d.pointer]),
    value: (id: string) => (result.data?.blocks.find((b) => b.id === id) as KpiData)?.value,
  };
}

describe("source horizons", () => {
  it("resolves latest_data to the newest horizon and carries every horizon in the data", async () => {
    const { data, codes } = await build(await project({}));
    expect(data?.asOf).toBe("2026-05-02");
    expect(data?.horizons).toEqual([
      { source: "orders", column: "ordered_at", through: "2026-04-29T15:30:00.000000" },
      { source: "sessions", column: "day", through: "2026-05-03T00:00:00.000000" },
    ]);
    expect(codes).toEqual([["HM4010", "warning", "/sources/orders"]]);
  });

  it("resolves latest_common_data to the oldest horizon, so the as-of is the laggiest source's", async () => {
    const { data, codes, value } = await build(
      await project({ asOf: "latest_common_data", range: "year_to_date" }),
    );
    expect(data?.asOf).toBe("2026-04-29");
    expect(codes).toEqual([]);
    expect(value("sessions")).toBe(0);
    expect(value("revenue")).toBe(30);
  });

  it("measures a date column as complete through the end of its latest date", async () => {
    const { data } = await build(
      await project({
        metrics: {
          sessions: metric({
            type: "aggregate",
            table: "sessions",
            aggregate: "count",
            time: "day",
          }),
        },
      }),
    );
    expect(data?.asOf).toBe("2026-05-02");
    expect(data?.horizons).toEqual([
      { source: "sessions", column: "day", through: "2026-05-03T00:00:00.000000" },
    ]);
  });

  it("measures freshness.column instead of the metric's time column", async () => {
    const { data, codes } = await build(
      await project({
        sources: {
          orders: { type: "csv", path: "orders.csv", freshness: { column: "exported_at" } },
          sessions: { type: "csv", path: "sessions.csv" },
        },
        files: {
          "orders.csv":
            "ordered_at,exported_at,amount\n2026-04-28T10:00:00Z,2026-05-02T06:00:00Z,10\n2026-04-29T15:30:00Z,2026-05-02T06:00:00Z,20\n",
        },
      }),
    );
    expect(data?.horizons[0]).toEqual({
      source: "orders",
      column: "exported_at",
      through: "2026-05-02T06:00:00.000000",
    });
    expect(codes).toEqual([]);
  });

  it("takes a lag in days off local dates and a lag in hours off the instant", async () => {
    const lagged = async (lag: unknown) =>
      (
        await build(
          await project({
            sources: {
              orders: { type: "csv", path: "orders.csv", freshness: { lag } },
              sessions: { type: "csv", path: "sessions.csv", freshness: { lag } },
            },
          }),
        )
      ).data;
    const days = await lagged({ days: 1 });
    expect(days?.horizons.map((h) => h.through)).toEqual([
      "2026-04-28T15:30:00.000000",
      "2026-05-02T00:00:00.000000",
    ]);
    expect(days?.asOf).toBe("2026-05-01");
    const hours = await lagged({ hours: 6 });
    expect(hours?.horizons.map((h) => h.through)).toEqual([
      "2026-04-29T09:30:00.000000",
      "2026-05-02T18:00:00.000000",
    ]);
    expect(hours?.asOf).toBe("2026-05-02");
  });

  it("takes freshness.through a date as the end of that date, and as_of as never voting", async () => {
    const through = await build(
      await project({
        sources: {
          orders: { type: "csv", path: "orders.csv", freshness: { through: "2026-05-10" } },
          sessions: { type: "csv", path: "sessions.csv", freshness: { through: "as_of" } },
        },
      }),
    );
    expect(through.data?.asOf).toBe("2026-05-10");
    expect(through.data?.horizons).toEqual([
      { source: "orders", through: "2026-05-11T00:00:00.000000" },
      { source: "sessions", through: "2026-05-11T00:00:00.000000" },
    ]);
    expect(through.codes).toEqual([]);
  });

  it("fails with HM4011 when latest_data has no source that votes", async () => {
    const asOf = await build(
      await project({
        sources: {
          orders: { type: "csv", path: "orders.csv", freshness: { through: "as_of" } },
          sessions: { type: "csv", path: "sessions.csv", freshness: { through: "as_of" } },
        },
      }),
    );
    expect(asOf.data).toBeUndefined();
    expect(asOf.codes).toEqual([["HM4011", "error", undefined]]);
    const timeless = await build(
      await project({
        metrics: { orders: metric({ type: "aggregate", table: "orders", aggregate: "count" }) },
      }),
    );
    expect(timeless.data).toBeUndefined();
    expect(timeless.diagnostics.map((d) => [d.code, d.message])).toEqual([
      [
        "HM4011",
        "latest_data needs a source to resolve from, but no metric on this dashboard has a time column that votes",
      ],
    ]);
  });

  it("warns with HM4010 when a fixed as-of is more than a day past a source's horizon", async () => {
    const day = await build(await project({ asOf: "2026-05-03" }));
    expect(day.codes).toEqual([["HM4010", "warning", "/sources/orders"]]);
    const later = await build(await project({ asOf: "2026-05-04" }));
    expect(later.codes).toEqual([
      ["HM4010", "warning", "/sources/orders"],
      ["HM4010", "warning", "/sources/sessions"],
    ]);
    expect((await build(await project({ asOf: "2026-05-02" }))).codes).toEqual([
      ["HM4010", "warning", "/sources/orders"],
    ]);
    expect((await build(await project({ asOf: "2026-04-29" }))).codes).toEqual([]);
  });

  it("warns with HM4012 only against the clock passed in, without changing the output", async () => {
    const fixture = await project({});
    const behind = await build(fixture, new Date("2026-05-01T12:00:00Z"));
    expect(behind.codes).toEqual([
      ["HM4010", "warning", "/sources/orders"],
      ["HM4012", "warning", "/sources/sessions"],
    ]);
    const current = await build(fixture, new Date("2026-05-02T00:00:00Z"));
    expect(current.codes).toEqual([["HM4010", "warning", "/sources/orders"]]);
    expect(JSON.stringify(behind.data)).toBe(JSON.stringify(current.data));
  });

  it("warns with HM4013 when a block's window starts after every source it reads ends", async () => {
    const { codes, value } = await build(
      await project({ asOf: "2026-05-31", range: { last: 7, unit: "day" } }),
    );
    expect(codes).toEqual([
      ["HM4010", "warning", "/sources/orders"],
      ["HM4010", "warning", "/sources/sessions"],
      ["HM4013", "warning", "/blocks/0"],
      ["HM4013", "warning", "/blocks/1"],
    ]);
    expect(value("revenue")).toBe(0);
  });
});

describe("time zones of timestamps without an offset", () => {
  const NAIVE = "ordered_at,amount\n2026-04-29T22:30:00,10\n2026-04-30T02:00:00,20\n";
  const one = {
    revenue: metric({
      type: "aggregate",
      table: "orders",
      aggregate: "sum",
      column: "amount",
      time: "ordered_at",
    }),
  };

  it("notes HM4016 when a non-UTC project reads naive timestamps as UTC", async () => {
    const { data, codes } = await build(
      await project({ timezone: "America/New_York", metrics: one, files: { "orders.csv": NAIVE } }),
    );
    expect(codes).toEqual([["HM4016", "note", "/sources/orders"]]);
    expect(data?.horizons[0]?.through).toBe("2026-04-29T22:00:00.000000");
    expect(data?.asOf).toBe("2026-04-29");
  });

  it("reads naive timestamps in the source's timezone, with no note", async () => {
    const { data, codes } = await build(
      await project({
        timezone: "America/New_York",
        metrics: one,
        sources: { orders: { type: "csv", path: "orders.csv", timezone: "America/Los_Angeles" } },
        files: { "orders.csv": NAIVE },
      }),
    );
    expect(codes).toEqual([]);
    expect(data?.horizons[0]?.through).toBe("2026-04-30T05:00:00.000000");
    expect(data?.asOf).toBe("2026-04-30");
  });

  it("needs no note in a UTC project", async () => {
    const { codes } = await build(await project({ metrics: one, files: { "orders.csv": NAIVE } }));
    expect(codes).toEqual([]);
  });
});
