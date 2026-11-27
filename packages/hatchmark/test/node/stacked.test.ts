import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BarData, DashboardData, LineData, Value } from "../../src/compiler/index.js";
import { checkReferences, PROJECT_DEFAULTS } from "../../src/spec/index.js";
import { metric, Oracle, removeProjects, run, writeProject } from "./fixture.js";

/**
 * Stacked and 100% stacked blocks against an independent SQL oracle: every position's total is
 * recomputed from rows (not summed from segments), shares divide by that total, and grain switches,
 * limits, null groups and a select filter keep both right.
 */

const NY = "America/New_York";
const REGIONS = ["North America", "Europe", "Asia-Pacific", "Latin America", ""];
const CHANNELS = ["Online store", "Marketplace", "Retail partners", ""];

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

/** Orders over Jan to Jun 2026 with null regions and channels, refunds and repeat customers. */
function orders(): string {
  const rand = random(47);
  const lines = ["order_id,ordered_at,region,channel,status,amount,refund,customer_id"];
  for (let i = 0; i < 600; i++) {
    const month = 1 + Math.floor(rand() * 6);
    const day = 1 + Math.floor(rand() * 28);
    const hour = Math.floor(rand() * 24);
    const at = `2026-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:15:00Z`;
    const region = REGIONS[Math.floor(rand() * REGIONS.length)] as string;
    const channel = CHANNELS[Math.floor(rand() * CHANNELS.length)] as string;
    const status = rand() < 0.1 ? "refunded" : "paid";
    const amount = (20 + rand() * 180).toFixed(2);
    const refund = rand() < 0.15 ? (rand() * 30).toFixed(2) : "0";
    const customer = `c${Math.floor(rand() * 90)}`;
    lines.push(`${i},${at},${region},${channel},${status},${amount},${refund},${customer}`);
  }
  // Jan 31 23:30 in New York is Feb 1 UTC: the boundary row must land in January.
  lines.push("9000,2026-02-01T04:30:00Z,Europe,Marketplace,paid,500.00,0,c1");
  lines.push("9001,2026-06-30T16:00:00Z,North America,Online store,paid,80.00,0,c2");
  return `${lines.join("\n")}\n`;
}

const paid = [{ column: "status", op: "eq", value: "paid" }];
const usd = { type: "currency", currency: "USD" };
const on = (body: Record<string, unknown>, format: unknown = usd) =>
  metric({ type: "aggregate", table: "orders", time: "ordered_at", ...body }, format);

const METRICS = {
  revenue: on({ label: "Revenue", aggregate: "sum", column: "amount", filters: paid }),
  refunds: on({ label: "Refunds", aggregate: "sum", column: "refund" }),
  customers: on(
    { label: "Customers", aggregate: "count_distinct", column: "customer_id", filters: paid },
    { type: "number" },
  ),
  net: metric(
    {
      label: "Net",
      type: "sql",
      table: "orders",
      sql: "sum(amount) - sum(refund) * 50",
      additive: true,
      time: "ordered_at",
    },
    usd,
  ),
};

const PERIOD = { asOf: "2026-06-30", range: "year_to_date", compare: "none" };
const DASHBOARDS = {
  stacked: {
    title: "Stacked",
    period: PERIOD,
    blocks: [
      {
        type: "bar",
        id: "pct_region",
        metrics: ["revenue"],
        by: "region",
        split: "channel",
        stack: "percent",
      },
      {
        type: "bar",
        id: "top2",
        metrics: ["revenue"],
        by: "region",
        split: "channel",
        stack: true,
        limit: 2,
      },
      { type: "bar", id: "multi", metrics: ["revenue", "refunds"], by: "region", stack: true },
      {
        type: "bar",
        id: "distinct_month",
        metrics: ["customers"],
        grain: "month",
        split: "region",
        stack: true,
      },
      {
        type: "area",
        id: "pct_area",
        metrics: ["revenue"],
        grain: "month",
        grains: ["month", "quarter"],
        split: "region",
        stack: "percent",
      },
      { type: "area", id: "plain_area", metrics: ["revenue"], grain: "month", split: "region" },
      {
        type: "bar",
        id: "net_pct",
        metrics: ["net"],
        by: "channel",
        split: "region",
        stack: "percent",
      },
    ],
  },
  filtered: {
    title: "Filtered",
    period: PERIOD,
    filters: [{ type: "select", id: "channel", column: "channel", default: "Marketplace" }],
    blocks: [
      {
        type: "bar",
        id: "pct_filtered",
        metrics: ["revenue"],
        by: "region",
        split: "channel",
        stack: "percent",
      },
    ],
  },
};

const CONFIG = {
  ...PROJECT_DEFAULTS,
  name: "Stacks",
  timezone: NY,
  sources: { orders: { type: "csv", path: "data/orders.csv" } },
};

let oracle: Oracle;
let project: Awaited<ReturnType<typeof writeProject>>;
let stacked: Awaited<ReturnType<typeof run>>;
let csv: string;
const LOCAL = `(ordered_at AT TIME ZONE '${NY}')`;
const WINDOW = `${LOCAL} >= TIMESTAMP '2026-01-01' AND ${LOCAL} < TIMESTAMP '2026-07-01'`;

function block<T>(data: DashboardData | undefined, id: string): T {
  const found = data?.blocks.find((b) => b.id === id);
  if (found === undefined) throw new Error(`no block ${id}`);
  return found as T;
}

/** The oracle's value for a key, with SQL NULL groups keyed as null. */
async function grouped(sql: string, keys: string[]): Promise<Map<string, number | null>> {
  const rows = await oracle.rows(sql);
  return new Map(
    rows.map((r) => [JSON.stringify(keys.map((k) => r[k] ?? null)), r.v as number | null]),
  );
}

const key = (...parts: unknown[]) => JSON.stringify(parts);

function close(actual: Value | undefined, expected: number | null | undefined): void {
  if (expected === null || expected === undefined) {
    expect(actual ?? null).toBe(null);
    return;
  }
  expect(actual).not.toBe(null);
  expect(Math.abs((actual as number) - expected)).toBeLessThanOrEqual(
    1e-9 * Math.max(1, Math.abs(expected)),
  );
}

beforeAll(async () => {
  oracle = await Oracle.open();
  project = await writeProject({
    "hatchmark.json": CONFIG,
    "data/orders.csv": orders(),
    ...Object.fromEntries(Object.entries(METRICS).map(([n, m]) => [`metrics/${n}.json`, m])),
    ...Object.fromEntries(Object.entries(DASHBOARDS).map(([n, d]) => [`dashboards/${n}.json`, d])),
  });
  csv = path.join(project.root, "data/orders.csv");
  stacked = await run(project.root, project.project, "stacked");
});
afterAll(async () => {
  oracle.close();
  await removeProjects();
});

describe("stacked blocks against a SQL oracle", () => {
  it("checks cleanly except the stacked distinct count (HM4060)", () => {
    expect(project.diagnostics).toEqual([]);
    expect(checkReferences(project.project).map((d) => [d.code, d.pointer])).toEqual([
      ["HM4060", "/blocks/3/metrics/0"],
    ]);
    expect(stacked.diagnostics.map((d) => d.code)).toEqual(["HM4061"]);
    expect(stacked.diagnostics[0]?.pointer).toBe("/blocks/6/stack");
  });

  it("recomputes each region's total from rows and divides every segment by it", async () => {
    const b = block<BarData>(stacked.data, "pct_region");
    expect(b.percent).toBe(true);
    expect(b.stack).toBe(true);
    const totals = await grouped(
      `SELECT region, CAST(sum(amount) FILTER (WHERE status = 'paid') AS DOUBLE) AS v
       FROM read_csv('${csv}') WHERE ${WINDOW} GROUP BY region`,
      ["region"],
    );
    const parts = await grouped(
      `SELECT region, channel, CAST(sum(amount) FILTER (WHERE status = 'paid') AS DOUBLE) AS v
       FROM read_csv('${csv}') WHERE ${WINDOW} GROUP BY region, channel`,
      ["region", "channel"],
    );
    if (b.axis.kind !== "category") throw new Error("category axis expected");
    expect(new Set(b.axis.categories)).toEqual(
      new Set([...totals.keys()].map((k) => JSON.parse(k)[0])),
    );
    b.axis.categories.forEach((region, i) => {
      const total = totals.get(key(region)) ?? null;
      close(b.totals?.[i], total);
      let shares = 0;
      for (const s of b.series) {
        const part = parts.get(key(region, s.splitValue ?? null)) ?? 0;
        close(s.values[i], part);
        close(s.share?.[i], total === null || total === 0 ? null : part / total);
        shares += s.share?.[i] ?? 0;
      }
      expect(Math.abs(shares - 1)).toBeLessThan(1e-9);
    });
  });

  it("keeps totals for the categories a limit shows, each over every channel", async () => {
    const b = block<BarData>(stacked.data, "top2");
    const totals = await oracle.rows(
      `SELECT region, CAST(sum(amount) FILTER (WHERE status = 'paid') AS DOUBLE) AS v
       FROM read_csv('${csv}') WHERE ${WINDOW} GROUP BY region ORDER BY v DESC NULLS LAST, region LIMIT 2`,
    );
    if (b.axis.kind !== "category") throw new Error("category axis expected");
    expect(b.axis.categories).toEqual(totals.map((r) => r.region ?? null));
    for (const [i, r] of totals.entries()) close(b.totals?.[i], r.v as number);
    expect(b.omittedCategories).toBe(3);
  });

  it("totals several stacked metrics as their sum", async () => {
    const b = block<BarData>(stacked.data, "multi");
    const rows = await grouped(
      `SELECT region, CAST(coalesce(sum(amount) FILTER (WHERE status = 'paid'), 0) + coalesce(sum(refund), 0) AS DOUBLE) AS v
       FROM read_csv('${csv}') WHERE ${WINDOW} GROUP BY region`,
      ["region"],
    );
    if (b.axis.kind !== "category") throw new Error("category axis expected");
    for (const [i, region] of b.axis.categories.entries()) {
      close(b.totals?.[i], rows.get(key(region)));
    }
    expect(b.percent).toBeUndefined();
  });

  it("shows the real distinct count per month, not the sum of the regions", async () => {
    const b = block<BarData>(stacked.data, "distinct_month");
    const months = await grouped(
      `SELECT strftime(date_trunc('month', ${LOCAL}), '%Y-%m-%d') AS m,
         CAST(count(DISTINCT customer_id) FILTER (WHERE status = 'paid') AS DOUBLE) AS v
       FROM read_csv('${csv}') WHERE ${WINDOW} GROUP BY 1`,
      ["m"],
    );
    if (b.axis.kind !== "time") throw new Error("time axis expected");
    let below = 0;
    b.axis.buckets.forEach((m, i) => {
      close(b.totals?.[i], months.get(key(m)) ?? 0);
      const sum = b.series.reduce((acc, s) => acc + (s.values[i] ?? 0), 0);
      if ((b.totals?.[i] ?? 0) < sum) below++;
    });
    expect(below).toBeGreaterThan(0);
  });

  it("gives every grain of a 100% area its own totals and shares", async () => {
    const b = block<LineData>(stacked.data, "pct_area");
    expect(b.grains?.options.map((o) => o.key)).toEqual(["month", "quarter:01-01"]);
    for (const option of b.grains?.options ?? []) {
      const unit = option.key.split(":")[0];
      const totals = await grouped(
        `SELECT strftime(date_trunc('${unit}', ${LOCAL}), '%Y-%m-%d') AS m,
           CAST(sum(amount) FILTER (WHERE status = 'paid') AS DOUBLE) AS v
         FROM read_csv('${csv}') WHERE ${WINDOW} GROUP BY 1`,
        ["m"],
      );
      const parts = await grouped(
        `SELECT strftime(date_trunc('${unit}', ${LOCAL}), '%Y-%m-%d') AS m, region,
           CAST(sum(amount) FILTER (WHERE status = 'paid') AS DOUBLE) AS v
         FROM read_csv('${csv}') WHERE ${WINDOW} GROUP BY 1, 2`,
        ["m", "region"],
      );
      option.axis.buckets.forEach((m, i) => {
        const total = totals.get(key(m)) ?? 0;
        close(option.totals?.[i], total);
        for (const s of option.series) {
          close(
            s.share?.[i],
            total === 0 ? null : (parts.get(key(m, s.splitValue ?? null)) ?? 0) / total,
          );
        }
      });
    }
    expect(b.totals).toEqual(b.grains?.options.find((o) => o.key === "month")?.totals);
  });

  it("puts January 31 at 23:30 in New York in January", async () => {
    const b = block<LineData>(stacked.data, "pct_area");
    const jan = await oracle.rows(
      `SELECT CAST(sum(amount) FILTER (WHERE status = 'paid') AS DOUBLE) AS v FROM read_csv('${csv}')
       WHERE ${LOCAL} >= TIMESTAMP '2026-01-01' AND ${LOCAL} < TIMESTAMP '2026-02-01'`,
    );
    close(b.totals?.[0], jan[0]?.v as number);
  });

  it("leaves unstacked blocks without totals or shares, and their plan unchanged", () => {
    const b = block<LineData>(stacked.data, "plain_area");
    expect(b.totals).toBeUndefined();
    expect(b.series.every((s) => s.share === undefined)).toBe(true);
  });

  it("applies a select filter's default to totals and shares alike", async () => {
    const filtered = await run(project.root, project.project, "filtered");
    const b = block<BarData>(filtered.data, "pct_filtered");
    const totals = await grouped(
      `SELECT region, CAST(sum(amount) FILTER (WHERE status = 'paid') AS DOUBLE) AS v
       FROM read_csv('${csv}') WHERE ${WINDOW} AND channel = 'Marketplace' GROUP BY region`,
      ["region"],
    );
    if (b.axis.kind !== "category") throw new Error("category axis expected");
    b.axis.categories.forEach((region, i) => {
      close(b.totals?.[i], totals.get(key(region)));
      expect(b.series.map((s) => s.splitValue)).toEqual(["Marketplace"]);
      close(b.series[0]?.share?.[i], 1);
    });
  });
});
