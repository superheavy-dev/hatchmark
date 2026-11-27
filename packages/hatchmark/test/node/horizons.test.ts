import { afterAll, describe, expect, it } from "vitest";
import { explainDashboard, type KpiData } from "../../src/compiler/index.js";
import { createDuckDbExecutor } from "../../src/node/index.js";
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
      { source: "orders", column: "ordered_at", through: "2026-04-29T15:30:00.000001Z" },
      { source: "sessions", column: "day", through: "2026-05-03T00:00:00.000000Z" },
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
      { source: "sessions", column: "day", through: "2026-05-03T00:00:00.000000Z" },
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
      through: "2026-05-02T06:00:00.000001Z",
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
      "2026-04-28T15:30:00.000001Z",
      "2026-05-02T00:00:00.000000Z",
    ]);
    expect(days?.asOf).toBe("2026-05-01");
    const hours = await lagged({ hours: 6 });
    expect(hours?.horizons.map((h) => h.through)).toEqual([
      "2026-04-29T09:30:00.000001Z",
      "2026-05-02T18:00:00.000000Z",
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
      { source: "orders", through: "2026-05-11T00:00:00.000000Z" },
      { source: "sessions", through: "2026-05-11T00:00:00.000000Z" },
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
    const behind = await build(fixture, new Date("2026-04-30T12:00:00Z"));
    expect(behind.codes).toEqual([
      ["HM4010", "warning", "/sources/orders"],
      ["HM4012", "warning", "/sources/sessions"],
    ]);
    const current = await build(fixture, new Date("2026-05-02T00:00:00Z"));
    expect(current.codes).toEqual([["HM4010", "warning", "/sources/orders"]]);
    expect(JSON.stringify(behind.data)).toBe(JSON.stringify(current.data));
  });

  it("warns with HM4013 when a block's window starts after the data it reads ends", async () => {
    const { codes, value } = await build(
      await project({ asOf: "2026-05-31", range: { start: "2026-05-10", end: "2026-05-20" } }),
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
    expect(data?.horizons[0]?.through).toBe("2026-04-30T02:00:00.000001Z");
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
    expect(data?.horizons[0]?.through).toBe("2026-04-30T09:00:00.000001Z");
    expect(data?.asOf).toBe("2026-04-30");
  });

  it("needs no note in a UTC project", async () => {
    const { codes } = await build(await project({ metrics: one, files: { "orders.csv": NAIVE } }));
    expect(codes).toEqual([]);
  });
});

/** A project of one CSV source per entry, a sum metric per source and a KPI block each. */
async function sources(
  csv: Record<string, { text: string; options?: Record<string, unknown>; column?: string }>,
  period: Record<string, unknown>,
  options: { timezone?: string; files?: Record<string, unknown>; blocks?: unknown[] } = {},
) {
  return writeProject({
    "hatchmark.json": {
      ...PROJECT_DEFAULTS,
      name: "Edges",
      timezone: options.timezone ?? "UTC",
      sources: Object.fromEntries(
        Object.entries(csv).map(([n, s]) => [n, { type: "csv", path: `${n}.csv`, ...s.options }]),
      ),
    },
    ...Object.fromEntries(Object.entries(csv).map(([n, s]) => [`${n}.csv`, s.text])),
    ...Object.fromEntries(
      Object.entries(csv).map(([n, s]) => [
        `metrics/${n}.json`,
        metric({
          type: "aggregate",
          table: n,
          aggregate: "sum",
          column: "v",
          time: s.column ?? "at",
        }),
      ]),
    ),
    ...options.files,
    "dashboards/d.json": {
      title: "D",
      period: { compare: "none", ...period },
      blocks: options.blocks ?? Object.keys(csv).map((n) => ({ type: "kpi", id: n, metric: n })),
    },
  });
}

describe("horizon edges (HAT-44 and HAT-45 on #19)", () => {
  it("keeps a timestamp exactly at local midnight on its own day", async () => {
    const one = await build(
      await sources(
        { orders: { text: "at,v\n2026-06-01T12:00:00Z,5\n2026-06-02T00:00:00Z,17\n" } },
        { asOf: "latest_data", range: { last: 1, unit: "day" } },
      ),
    );
    expect(one.data?.asOf).toBe("2026-06-02");
    expect(one.value("orders")).toBe(22);
    const week = await build(
      await sources(
        {
          orders: {
            text: "at,v\n2026-04-28T00:00:00Z,1\n2026-04-29T00:00:00Z,2\n2026-04-30T00:00:00Z,4\n",
          },
        },
        { asOf: "latest_data", range: "last_7_days" },
      ),
    );
    expect(week.data?.asOf).toBe("2026-04-30");
    expect(week.value("orders")).toBe(7);
  });

  it("orders horizons by instant across a fall-back hour, not by wall-clock time", async () => {
    const { data } = await build(
      await sources(
        {
          a: { text: "at,v\n2026-11-01T01:45:00-04:00,1\n" },
          b: { text: "at,v\n2026-11-01T01:15:00-05:00,1\n" },
          c: {
            text: "at,v\n2026-10-01T00:00:00Z,1\n",
            options: { freshness: { through: "as_of" } },
          },
        },
        { asOf: "latest_common_data", range: "all_time" },
        { timezone: "America/New_York" },
      ),
    );
    expect(data?.horizons).toEqual([
      { source: "a", column: "at", through: "2026-11-01T05:45:00.000001Z" },
      { source: "b", column: "at", through: "2026-11-01T06:15:00.000001Z" },
      { source: "c", through: "2026-11-01T05:45:00.000001Z" },
    ]);
    expect(data?.asOf).toBe("2026-11-01");
  });

  it("ends a DATE source at the first instant of the next day where DST starts at midnight", async () => {
    for (const asOf of ["latest_data", "latest_common_data"]) {
      const { data } = await build(
        await sources(
          { orders: { text: "at,v\n2026-09-04,1\n2026-09-05,2\n" } },
          { asOf, range: "all_time" },
          { timezone: "America/Santiago" },
        ),
      );
      expect(data?.asOf).toBe("2026-09-05");
      expect(data?.horizons[0]?.through).toBe("2026-09-06T04:00:00.000000Z");
    }
  });

  it("rejects a horizon past the supported dates instead of comparing it as text", async () => {
    const dated = await build(
      await sources(
        {
          late: { text: "at,v\n9999-12-31,1\n" },
          orders: { text: "at,v\n2026-06-01,1\n" },
        },
        { asOf: "latest_data", range: "all_time" },
      ),
    );
    expect(dated.data).toBeUndefined();
    expect(dated.codes).toEqual([["HM2015", "error", undefined]]);
    const through = await build(
      await sources(
        {
          late: { text: "at,v\n2026-06-01,1\n", options: { freshness: { through: "9999-12-31" } } },
          orders: { text: "at,v\n2026-06-01,1\n" },
        },
        { asOf: "latest_data", range: "all_time" },
      ),
    );
    expect(through.data).toBeUndefined();
    expect(through.diagnostics.map((d) => d.message)).toEqual([
      "the as-of instant 10000-01-01T00:00:00.000000Z is outside the supported dates 0001-01-01 to 9998-12-31",
    ]);
  });

  it("ends a ratio at its laggiest operand's horizon: a last-N-days KPI slides, a fixed span is empty (HM4013)", async () => {
    const at = (range: unknown) =>
      sources(
        {
          num: { text: "at,v\n2026-06-01,5\n" },
          den: { text: "at,v\n2026-06-01,10\n2026-06-10,17\n" },
        },
        { asOf: "2026-06-10", range },
        {
          files: {
            "metrics/share.json": metric({ type: "ratio", numerator: "num", denominator: "den" }),
          },
          blocks: [
            { type: "kpi", id: "share", metric: "share" },
            { type: "kpi", id: "num", metric: "num" },
            { type: "kpi", id: "den", metric: "den" },
          ],
        },
      );
    const slid = await build(await at({ last: 1, unit: "day" }));
    expect(slid.codes).toEqual([["HM4010", "warning", "/sources/num"]]);
    expect([slid.value("share"), slid.value("num"), slid.value("den")]).toEqual([0.5, 5, 17]);
    const fixed = await build(await at({ start: "2026-06-10", end: "2026-06-11" }));
    expect(fixed.codes).toEqual([
      ["HM4010", "warning", "/sources/num"],
      ["HM4013", "warning", "/blocks/0"],
      ["HM4013", "warning", "/blocks/1"],
    ]);
    expect(fixed.value("den")).toBe(17);
  });

  it("notes HM4016 for a naive time column even when freshness measures something else", async () => {
    for (const options of [
      { freshness: { through: "2026-06-01" } },
      { freshness: { column: "exported" } },
    ]) {
      const { codes } = await build(
        await sources(
          { orders: { text: "at,exported,v\n2026-06-01T18:00:00,2026-06-01,1\n", options } },
          { asOf: "2026-06-01", range: "all_time" },
          { timezone: "America/New_York" },
        ),
      );
      expect(codes).toEqual([["HM4016", "note", "/sources/orders"]]);
    }
  });

  it("warns with HM4012 next to HM4010 on the same source, naming the newest value", async () => {
    const fixture = await sources(
      {
        orders: {
          text: "at,shipped_at,v\n2026-06-01T10:00:00Z,2099-06-01T18:00:00Z,1\n2026-06-02T10:00:00Z,2099-06-02T18:00:00Z,2\n",
        },
      },
      { asOf: "latest_data", range: "all_time" },
      {
        files: {
          "metrics/shipped.json": metric({
            type: "aggregate",
            table: "orders",
            aggregate: "sum",
            column: "v",
            time: "shipped_at",
          }),
        },
        blocks: [
          { type: "kpi", id: "orders", metric: "orders" },
          { type: "kpi", id: "shipped", metric: "shipped" },
        ],
      },
    );
    const now = new Date("2026-11-27T00:00:00Z");
    const built = await build(fixture, now);
    expect(built.codes).toEqual([
      ["HM4010", "warning", "/sources/orders"],
      ["HM4012", "warning", "/sources/orders"],
    ]);
    expect(built.diagnostics[1]?.message).toBe(
      'source "orders" has data in "shipped_at" through 2099-06-02 18:00, more than a day after this machine\'s clock (2026-11-27 00:00)',
    );
    const config = fixture.project.config.spec;
    if (config === undefined) throw new Error("no config");
    const executor = await createDuckDbExecutor({ root: fixture.root, config });
    try {
      const explained = await explainDashboard(fixture.project, "d", executor, undefined, now);
      expect(explained.diagnostics.map((d) => d.code)).toEqual(["HM4010", "HM4012"]);
    } finally {
      await executor.close();
    }
  });

  it("builds future-dated data byte for byte the same under any clock, warning with HM4012", async () => {
    const fixture = await sources(
      { orders: { text: "at,v\n2026-05-30T10:00:00Z,3\n2099-06-01T18:00:00Z,7\n" } },
      { asOf: "latest_data", range: "all_time" },
    );
    const runs = await Promise.all(
      ["2026-06-01T00:00:00Z", "2099-06-01T00:00:00Z", "2100-06-01T00:00:00Z"].map((now) =>
        build(fixture, new Date(now)),
      ),
    );
    expect(runs.map((r) => r.diagnostics.map((d) => d.message))).toEqual([
      [
        'source "orders" has data in "at" through 2099-06-01 18:00, more than a day after this machine\'s clock (2026-06-01 00:00)',
      ],
      [],
      [],
    ]);
    expect(runs[0]?.value("orders")).toBe(10);
    const bytes = runs.map((r) => JSON.stringify(r.data));
    expect(new Set([...bytes, JSON.stringify((await build(fixture)).data)]).size).toBe(1);
  });

  it("warns with HM4012 exactly when a row is more than a day after the clock, and lists it", async () => {
    const date = await build(
      await sources(
        { orders: { text: "at,v\n2026-06-02,7\n" } },
        { asOf: "latest_data", range: "all_time" },
      ),
      new Date("2026-06-01T12:00:00Z"),
    );
    expect(date.codes).toEqual([]);
    const dayAfter = await build(
      await sources(
        { orders: { text: "at,v\n2026-06-03,7\n" } },
        { asOf: "latest_data", range: "all_time" },
      ),
      new Date("2026-06-01T12:00:00Z"),
    );
    expect(dayAfter.diagnostics.map((d) => d.message)).toEqual([
      'source "orders" has data in "at" through 2026-06-03 00:00, more than a day after this machine\'s clock (2026-06-01 12:00)',
    ]);
    const fixture = await sources(
      { orders: { text: "at,v\n2026-06-02T00:00:00.500Z,7\n" } },
      { asOf: "latest_data", range: "all_time" },
    );
    expect((await build(fixture, new Date("2026-06-01T00:00:00.500Z"))).codes).toEqual([]);
    expect((await build(fixture, new Date("2026-06-01T00:00:00.499Z"))).codes).toEqual([
      ["HM4012", "warning", "/sources/orders"],
    ]);
  });

  it("rejects an as-of in year 10000 reached through a timestamp's local date", async () => {
    for (const [timezone, text] of [
      ["Europe/Berlin", "at,v\n9999-12-31 23:59:59,1\n"],
      ["Asia/Tokyo", "at,v\n9999-12-31T23:00:00Z,1\n"],
    ] as const) {
      const built = await build(
        await sources(
          { orders: { text, options: { timezone: "UTC" } } },
          { asOf: "latest_data", range: "all_time" },
          { timezone },
        ),
      );
      expect(built.data).toBeUndefined();
      expect(built.diagnostics.map((d) => d.code)).toEqual(["HM2015"]);
      expect(built.diagnostics[0]?.message).toMatch(
        /^the as-of instant 9999-12-31T\S+Z is outside the supported dates/,
      );
    }
  });
});
