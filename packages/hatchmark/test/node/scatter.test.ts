import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DashboardData, ScatterData, Value } from "../../src/compiler/index.js";
import { checkReferences, PROJECT_DEFAULTS } from "../../src/spec/index.js";
import { metric, Oracle, removeProjects, run, writeProject } from "./fixture.js";

/**
 * Scatter blocks against an independent SQL oracle: x, y and size per category equal a plain
 * GROUP BY, a ratio divides the group's sums (never averages row ratios), the null category is a
 * real point, categories without an x or y are counted and left out (HM4070), limit keeps the
 * largest points, a select filter's default applies, and past 500 points the cap warns (HM5022).
 */

const NY = "America/New_York";
const COUNTRIES = ["United States", "Germany", "Japan", "Brazil", "Canada", "Australia", ""];
const CHANNELS = ["Online store", "Marketplace", "Retail partners"];

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

/** Orders over Jan to Jun 2026, with a null country, refunds, and Iceland only ever refunded. */
function orders(): string {
  const rand = random(70);
  const lines = ["order_id,ordered_at,country,channel,status,amount,quantity,margin,customer_id"];
  for (let i = 0; i < 1400; i++) {
    const month = 1 + Math.floor(rand() * 6);
    const day = 1 + Math.floor(rand() * 28);
    const at = `2026-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T15:00:00Z`;
    const country = COUNTRIES[Math.floor(rand() * COUNTRIES.length)] as string;
    const channel = CHANNELS[Math.floor(rand() * CHANNELS.length)] as string;
    const status = rand() < 0.12 ? "refunded" : "paid";
    const amount = (15 + rand() * 260).toFixed(2);
    const quantity = 1 + Math.floor(rand() * 6);
    const margin = (country === "Brazil" ? -40 + rand() * 30 : rand() * 60).toFixed(2);
    lines.push(
      [
        i,
        at,
        country,
        channel,
        status,
        amount,
        quantity,
        margin,
        `c${Math.floor(rand() * 640)}`,
      ].join(","),
    );
  }
  lines.push("9000,2026-03-02T15:00:00Z,Iceland,Marketplace,refunded,120.00,2,10,c1");
  lines.push("9001,2026-04-02T15:00:00Z,Iceland,Online store,refunded,80.00,1,5,c2");
  // Dec 31 at 22:00 in New York: outside the year-to-date window.
  lines.push("9002,2026-01-01T03:00:00Z,Germany,Marketplace,paid,9999.00,1,0,c3");
  lines.push("9003,2026-06-30T23:00:00Z,Canada,Online store,paid,64.00,2,12,c4");
  return `${lines.join("\n")}\n`;
}

const paid = [{ column: "status", op: "eq", value: "paid" }];
const usd = { type: "currency", currency: "USD" };
const on = (body: Record<string, unknown>, format: unknown = usd) =>
  metric({ type: "aggregate", table: "orders", time: "ordered_at", ...body }, format);

const METRICS = {
  revenue: on({ label: "Revenue", aggregate: "sum", column: "amount", filters: paid }),
  paid_orders: on(
    { label: "Orders", aggregate: "count", column: "order_id", filters: paid },
    { type: "number" },
  ),
  items: on(
    { label: "Items", aggregate: "sum", column: "quantity", filters: paid },
    { type: "number" },
  ),
  margin: on({ label: "Margin", aggregate: "sum", column: "margin" }),
  price_per_item: metric(
    { label: "Price per item", type: "ratio", numerator: "revenue", denominator: "items" },
    usd,
  ),
};

const PERIOD = { asOf: "2026-06-30", range: "year_to_date", compare: "none" };
const block = (id: string, extra: Record<string, unknown> = {}) => ({
  type: "scatter",
  id,
  x: "paid_orders",
  y: "price_per_item",
  by: "country",
  size: "revenue",
  ...extra,
});
const DASHBOARDS = {
  scatter: {
    title: "Scatter",
    period: PERIOD,
    blocks: [
      block("countries"),
      block("top3", { limit: 3 }),
      block("dots", { size: undefined }),
      block("negative", { size: "margin" }),
    ],
  },
  filtered: {
    title: "Filtered",
    period: PERIOD,
    filters: [{ type: "select", id: "channel", column: "channel", default: "Marketplace" }],
    blocks: [block("filtered")],
  },
  customers: {
    title: "Customers",
    period: PERIOD,
    blocks: [block("customers", { by: "customer_id", size: undefined, x: "items", y: "revenue" })],
  },
};

const CONFIG = {
  ...PROJECT_DEFAULTS,
  name: "Scatter",
  timezone: NY,
  sources: { orders: { type: "csv", path: "data/orders.csv" } },
};

let oracle: Oracle;
let project: Awaited<ReturnType<typeof writeProject>>;
let result: Awaited<ReturnType<typeof run>>;
let csv: string;
const LOCAL = `(ordered_at AT TIME ZONE '${NY}')`;
/** A scatter reads whole local days through the last complete one: the midnight at or before the data's horizon. */
let WINDOW: string;
let lastDay: string;

function scatter(data: DashboardData | undefined, id: string): ScatterData {
  const found = data?.blocks.find((b) => b.id === id);
  if (found?.type !== "scatter") throw new Error(`no scatter block ${id}`);
  return found;
}

interface Row {
  key: string | null;
  orders: number;
  revenue: number | null;
  items: number | null;
  margin: number | null;
  rowRatio: number | null;
}

/** The oracle's numbers per category, from one plain GROUP BY. */
async function perCountry(where = ""): Promise<Row[]> {
  const rows = await oracle.rows(
    `SELECT country AS key,
       CAST(count(order_id) FILTER (WHERE status = 'paid') AS DOUBLE) AS orders,
       CAST(sum(amount) FILTER (WHERE status = 'paid') AS DOUBLE) AS revenue,
       CAST(sum(quantity) FILTER (WHERE status = 'paid') AS DOUBLE) AS items,
       CAST(sum(margin) AS DOUBLE) AS margin,
       CAST(avg(amount / quantity) FILTER (WHERE status = 'paid') AS DOUBLE) AS rowRatio
     FROM read_csv('${csv}') WHERE ${WINDOW} ${where} GROUP BY country`,
  );
  return rows as unknown as Row[];
}

const ratio = (row: Row) =>
  row.revenue === null || row.items === null || row.items === 0 ? null : row.revenue / row.items;

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

/** The expected order: size descending (else y descending), then y descending, then key, nulls last. */
function expectedOrder(
  rows: { key: string | null; y: number; size: number | null }[],
): (string | null)[] {
  const desc = (a: number | null, b: number | null) =>
    a === b ? 0 : a === null ? 1 : b === null ? -1 : b - a;
  return [...rows]
    .sort(
      (a, b) =>
        desc(a.size, b.size) ||
        desc(a.y, b.y) ||
        (a.key === b.key ? 0 : a.key === null ? 1 : b.key === null ? -1 : a.key < b.key ? -1 : 1),
    )
    .map((r) => r.key);
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
  const [end] = await oracle.rows(
    `SELECT strftime(least(date_trunc('day', max(${LOCAL})), TIMESTAMP '2026-07-01'), '%Y-%m-%d %H:%M:%S') AS d FROM read_csv('${csv}')`,
  );
  lastDay = String(end?.d).slice(0, 10);
  WINDOW = `${LOCAL} >= TIMESTAMP '2026-01-01' AND ${LOCAL} < TIMESTAMP '${end?.d}'`;
  result = await run(project.root, project.project, "scatter");
});
afterAll(async () => {
  oracle.close();
  await removeProjects();
});

describe("scatter blocks against a SQL oracle", () => {
  it("checks cleanly, and warns at build about Iceland and Brazil's negative margin", () => {
    expect(project.diagnostics).toEqual([]);
    expect(checkReferences(project.project)).toEqual([]);
    expect(result.diagnostics.map((d) => [d.code, d.pointer])).toEqual([
      ["HM4070", "/blocks/0"],
      ["HM4070", "/blocks/1"],
      ["HM4070", "/blocks/2"],
      ["HM4070", "/blocks/3"],
      ["HM4071", "/blocks/3/size"],
    ]);
    expect(result.diagnostics[0]?.message).toBe(
      'block "countries" leaves out 1 of 8 categories, whose x or y has no value',
    );
  });

  it("gives each country the x, y and size of a plain GROUP BY, the null country included", async () => {
    const b = scatter(result.data, "countries");
    const rows = await perCountry();
    const placed = rows.filter((r) => ratio(r) !== null);
    expect(b.points.map((p) => p.key).sort()).toEqual(placed.map((r) => r.key).sort());
    expect(b.points.some((p) => p.key === null && p.label === "(empty)")).toBe(true);
    for (const p of b.points) {
      const row = rows.find((r) => r.key === p.key) as Row;
      close(p.x, row.orders);
      close(p.y, ratio(row));
      close(p.size, row.revenue);
    }
    expect(b.points.map((p) => p.key)).toEqual(
      expectedOrder(placed.map((r) => ({ key: r.key, y: ratio(r) as number, size: r.revenue }))),
    );
    expect(b.omittedPoints).toBe(1);
    expect(b.omittedCategories).toBeUndefined();
    expect(b.window).toEqual({ start: "2026-01-01", end: lastDay });
  });

  it("divides each country's sums for a ratio, which differs from averaging row ratios", async () => {
    const b = scatter(result.data, "countries");
    const rows = await perCountry();
    let differs = 0;
    for (const p of b.points) {
      const row = rows.find((r) => r.key === p.key) as Row;
      close(p.y, ratio(row));
      if (Math.abs((p.y as number) - (row.rowRatio as number)) > 0.01) differs++;
    }
    expect(differs).toBeGreaterThan(0);
  });

  it("keeps the three largest points with limit and counts the rest", async () => {
    const b = scatter(result.data, "top3");
    const all = scatter(result.data, "countries");
    expect(b.points).toEqual(all.points.slice(0, 3));
    expect(b.omittedCategories).toBe(all.points.length - 3);
    const top = await oracle.rows(
      `SELECT country FROM read_csv('${csv}') WHERE ${WINDOW} AND status = 'paid'
       GROUP BY country ORDER BY sum(amount) DESC LIMIT 3`,
    );
    expect(b.points.map((p) => p.key)).toEqual(top.map((r) => r.country ?? null));
  });

  it("orders dots without size by y, and draws negative sizes with a warning", async () => {
    const dots = scatter(result.data, "dots");
    expect(dots.size).toBeUndefined();
    expect(dots.points.every((p) => p.size === undefined)).toBe(true);
    const ys = dots.points.map((p) => p.y as number);
    expect(ys).toEqual([...ys].sort((a, b) => b - a));
    const negative = scatter(result.data, "negative");
    const rows = await perCountry();
    const brazil = negative.points.find((p) => p.key === "Brazil");
    close(brazil?.size, rows.find((r) => r.key === "Brazil")?.margin);
    expect(brazil?.size).toBeLessThan(0);
  });

  it("applies a select filter's default to every axis", async () => {
    const filtered = await run(project.root, project.project, "filtered");
    const b = scatter(filtered.data, "filtered");
    const rows = await perCountry("AND channel = 'Marketplace'");
    const placed = rows.filter((r) => ratio(r) !== null);
    expect(b.points.map((p) => p.key).sort()).toEqual(placed.map((r) => r.key).sort());
    for (const p of b.points) {
      const row = rows.find((r) => r.key === p.key) as Row;
      close(p.x, row.orders);
      close(p.y, ratio(row));
      close(p.size, row.revenue);
    }
  });

  it("caps a block at 500 points without a limit and says how many it left out (HM5022)", async () => {
    const customers = await run(project.root, project.project, "customers");
    const b = scatter(customers.data, "customers");
    // A customer with only refunded orders has revenue and items 0 (sums of no rows), so a point.
    const rows = await oracle.rows(
      `SELECT customer_id,
         CAST(coalesce(sum(quantity) FILTER (WHERE status = 'paid'), 0) AS DOUBLE) AS items,
         CAST(coalesce(sum(amount) FILTER (WHERE status = 'paid'), 0) AS DOUBLE) AS revenue
       FROM read_csv('${csv}') WHERE ${WINDOW} GROUP BY customer_id
       ORDER BY revenue DESC, customer_id`,
    );
    const placed = rows.length;
    expect(rows.some((r) => r.revenue === 0)).toBe(true);
    expect(placed).toBeGreaterThan(500);
    expect(b.points).toHaveLength(500);
    expect(b.points.map((p) => p.key)).toEqual(rows.slice(0, 500).map((r) => r.customer_id));
    rows.slice(0, 500).forEach((r, i) => {
      close(b.points[i]?.x, r.items as number);
      close(b.points[i]?.y, r.revenue as number);
    });
    expect(b.omittedCategories).toBe(placed - 500);
    expect(b.omittedPoints).toBeUndefined();
    const cap = customers.diagnostics.find((d) => d.code === "HM5022");
    expect(cap?.pointer).toBe("/blocks/0/by");
    expect(cap?.message).toBe(
      `block "customers" has ${placed} points; the 500 largest are drawn and ${placed - 500} left out`,
    );
    const ys = b.points.map((p) => p.y as number);
    expect(ys).toEqual([...ys].sort((a, b) => b - a));
  });
});
