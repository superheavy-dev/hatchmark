import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DashboardData, PieData } from "../../src/compiler/index.js";
import { checkReferences, PROJECT_DEFAULTS } from "../../src/spec/index.js";
import { metric, Oracle, removeProjects, run, writeProject } from "./fixture.js";

const NY = "America/New_York";
const COUNTRIES = [
  "United States",
  "United Kingdom",
  "Canada",
  "Germany",
  "Australia",
  "France",
  "Japan",
  "Mexico",
  "Netherlands",
  "Brazil",
  "",
];

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function orders(): string {
  const rand = random(1127);
  const lines = ["order_id,ordered_at,country,channel,status,amount,refund,customer_id"];
  for (let i = 0; i < 800; i++) {
    const day = 1 + Math.floor(rand() * 30);
    const at = `2026-06-${String(day).padStart(2, "0")}T${String(Math.floor(rand() * 24)).padStart(2, "0")}:00:00Z`;
    const pick = Math.floor(rand() ** 2 * COUNTRIES.length);
    const country = COUNTRIES[pick] as string;
    const channel = rand() < 0.6 ? "Online store" : rand() < 0.7 ? "Marketplace" : "Wholesale";
    const status = rand() < 0.1 ? "refunded" : "paid";
    const amount = (15 + rand() * 200).toFixed(2);
    const refund =
      channel === "Wholesale" ? (300 + rand() * 100).toFixed(2) : rand() < 0.1 ? "20" : "0";
    lines.push(
      `${i},${at},${country},${channel},${status},${amount},${refund},c${Math.floor(rand() * 120)}`,
    );
  }
  lines.push("9000,2026-06-30T16:00:00Z,Canada,Online store,paid,90.00,0,c1");
  return `${lines.join("\n")}\n`;
}

const paid = [{ column: "status", op: "eq", value: "paid" }];
const usd = { type: "currency", currency: "USD" };
const METRICS = {
  revenue: metric(
    {
      label: "Revenue",
      type: "aggregate",
      table: "orders",
      time: "ordered_at",
      aggregate: "sum",
      column: "amount",
      filters: paid,
    },
    usd,
  ),
  net: metric(
    {
      label: "Net revenue",
      type: "sql",
      table: "orders",
      time: "ordered_at",
      sql: "sum(amount) - sum(refund)",
      additive: true,
    },
    usd,
  ),
  customers: metric({
    label: "Customers",
    type: "aggregate",
    table: "orders",
    time: "ordered_at",
    aggregate: "count_distinct",
    column: "customer_id",
  }),
};

const PERIOD = { asOf: "2026-06-30", range: "month_to_date", compare: "none" };
const DASHBOARDS = {
  pies: {
    title: "Pies",
    period: PERIOD,
    blocks: [
      { type: "pie", id: "countries", metric: "revenue", by: "country" },
      { type: "donut", id: "top3", metric: "revenue", by: "country", limit: 3 },
      { type: "pie", id: "net_channels", metric: "net", by: "channel" },
      { type: "donut", id: "all", metric: "revenue", by: "country", limit: 12 },
    ],
  },
  filtered: {
    title: "Filtered",
    period: PERIOD,
    filters: [{ type: "select", id: "channel", column: "channel", default: "Marketplace" }],
    blocks: [{ type: "pie", id: "marketplace", metric: "revenue", by: "country" }],
  },
  wrong: {
    title: "Wrong",
    period: PERIOD,
    blocks: [{ type: "pie", id: "distinct", metric: "customers", by: "country", limit: 9 }],
  },
};

const CONFIG = {
  ...PROJECT_DEFAULTS,
  name: "Pies",
  timezone: NY,
  sources: { orders: { type: "csv", path: "data/orders.csv" } },
};

let oracle: Oracle;
let project: Awaited<ReturnType<typeof writeProject>>;
let pies: Awaited<ReturnType<typeof run>>;
let csv: string;
const LOCAL = `(ordered_at AT TIME ZONE '${NY}')`;
let WINDOW: string;

function block(data: DashboardData | undefined, id: string): PieData {
  const found = data?.blocks.find((b) => b.id === id);
  if (found === undefined) throw new Error(`no block ${id}`);
  return found as PieData;
}

function close(actual: number | null | undefined, expected: number | null | undefined): void {
  if (expected === null || expected === undefined) {
    expect(actual ?? null).toBe(null);
    return;
  }
  expect(Math.abs((actual ?? Number.NaN) - expected)).toBeLessThanOrEqual(
    1e-9 * Math.max(1, Math.abs(expected)),
  );
}

async function ranked(sql: string): Promise<{ key: string | null; v: number | null }[]> {
  const rows = await oracle.rows(sql);
  return rows.map((r) => ({
    key: (r.k as string | null) ?? null,
    v: (r.v as number | null) ?? null,
  }));
}

beforeAll(async () => {
  oracle = await Oracle.open();
  project = await writeProject({
    "hatchmark.yaml": CONFIG,
    "data/orders.csv": orders(),
    ...Object.fromEntries(Object.entries(METRICS).map(([n, m]) => [`metrics/${n}.yaml`, m])),
    ...Object.fromEntries(Object.entries(DASHBOARDS).map(([n, d]) => [`dashboards/${n}.yaml`, d])),
  });
  csv = path.join(project.root, "data/orders.csv");
  const [end] = await oracle.rows(
    `SELECT strftime(least(date_trunc('day', max(${LOCAL})), TIMESTAMP '2026-07-01'), '%Y-%m-%d %H:%M:%S') AS d FROM read_csv('${csv}')`,
  );
  WINDOW = `${LOCAL} >= TIMESTAMP '2026-06-01' AND ${LOCAL} < TIMESTAMP '${end?.d}'`;
  pies = await run(project.root, project.project, "pies");
});
afterAll(async () => {
  oracle.close();
  await removeProjects();
});

describe("pie and donut blocks against a SQL oracle", () => {
  it("checks: HM4001 for a distinct count, HM5010 for 9 and 12 slices", () => {
    expect(project.diagnostics).toEqual([]);
    expect(checkReferences(project.project).map((d) => [d.code, d.file, d.pointer])).toEqual([
      ["HM5010", "dashboards/pies.yaml", "/blocks/3/limit"],
      ["HM4001", "dashboards/wrong.yaml", "/blocks/0/metric"],
      ["HM5010", "dashboards/wrong.yaml", "/blocks/0/limit"],
    ]);
  });

  it("takes the 5 largest countries, sums the rest into Other and divides by the positive whole", async () => {
    const b = block(pies.data, "countries");
    const rows = await ranked(
      `SELECT country AS k, CAST(sum(amount) FILTER (WHERE status = 'paid') AS DOUBLE) AS v
       FROM read_csv('${csv}') WHERE ${WINDOW} GROUP BY country
       ORDER BY v DESC NULLS LAST, k NULLS LAST`,
    );
    const positive = rows.filter((r) => r.v !== null && r.v > 0) as {
      key: string | null;
      v: number;
    }[];
    const whole = positive.reduce((s, r) => s + r.v, 0);
    expect(b.slices.map((s) => s.key)).toEqual(positive.slice(0, 5).map((r) => r.key));
    b.slices.forEach((s, i) => {
      close(s.value, positive[i]?.v);
      close(s.share, (positive[i]?.v ?? 0) / whole);
    });
    const rest = positive.slice(5);
    expect(b.other?.count).toBe(rest.length);
    close(
      b.other?.value,
      rest.reduce((s, r) => s + r.v, 0),
    );
    close(b.whole, whole);
    const total = await oracle.rows(
      `SELECT CAST(sum(amount) FILTER (WHERE status = 'paid') AS DOUBLE) AS v FROM read_csv('${csv}') WHERE ${WINDOW}`,
    );
    close(b.total, total[0]?.v as number);
    close(b.total, whole);
    const shares = b.slices.reduce((s, x) => s + x.share, 0) + (b.other?.share ?? 0);
    expect(Math.abs(shares - 1)).toBeLessThan(1e-9);
  });

  it('keeps the null country as a real "(empty)" category', () => {
    const b = block(pies.data, "all");
    const empty = b.slices.find((s) => s.key === null);
    expect(empty?.label).toBe("(empty)");
    expect(b.other).toBeUndefined();
  });

  it("respects limit", () => {
    const b = block(pies.data, "top3");
    expect(b.type).toBe("donut");
    expect(b.slices).toHaveLength(3);
    expect(b.other?.count).toBe(block(pies.data, "all").slices.length - 3);
  });

  it("leaves negative categories out, states the real total and warns once (HM4061)", async () => {
    const b = block(pies.data, "net_channels");
    const rows = await ranked(
      `SELECT channel AS k, CAST(sum(amount) - sum(refund) AS DOUBLE) AS v
       FROM read_csv('${csv}') WHERE ${WINDOW} GROUP BY channel ORDER BY v DESC`,
    );
    const negative = rows.filter((r) => (r.v ?? 0) < 0);
    expect(negative.map((r) => r.key)).toEqual(["Wholesale"]);
    expect(b.excluded?.negative.map((n) => n.key)).toEqual(["Wholesale"]);
    close(b.excluded?.negative[0]?.value, negative[0]?.v);
    const positive = rows.filter((r) => (r.v ?? 0) > 0);
    close(
      b.whole,
      positive.reduce((s, r) => s + (r.v ?? 0), 0),
    );
    close(
      b.total,
      rows.reduce((s, r) => s + (r.v ?? 0), 0),
    );
    const countries = block(pies.data, "countries");
    const top3 = block(pies.data, "top3");
    expect((countries.other?.value ?? 0) > (countries.slices[0]?.value ?? 0)).toBe(true);
    expect((top3.other?.value ?? 0) > (top3.slices[0]?.value ?? 0)).toBe(true);
    expect(pies.diagnostics.map((d) => [d.code, d.pointer])).toEqual([
      ["HM5011", "/blocks/0/by"],
      ["HM5011", "/blocks/1/limit"],
      ["HM4061", "/blocks/2/metric"],
    ]);
  });

  it("applies a select filter's default to slices and total", async () => {
    const filtered = await run(project.root, project.project, "filtered");
    const b = block(filtered.data, "marketplace");
    const total = await oracle.rows(
      `SELECT CAST(sum(amount) FILTER (WHERE status = 'paid') AS DOUBLE) AS v FROM read_csv('${csv}')
       WHERE ${WINDOW} AND channel = 'Marketplace'`,
    );
    close(b.total, total[0]?.v as number);
    const top = await ranked(
      `SELECT country AS k, CAST(sum(amount) FILTER (WHERE status = 'paid') AS DOUBLE) AS v
       FROM read_csv('${csv}') WHERE ${WINDOW} AND channel = 'Marketplace' GROUP BY country
       ORDER BY v DESC NULLS LAST, k NULLS LAST LIMIT 1`,
    );
    expect(b.slices[0]?.key).toBe(top[0]?.key);
    close(b.slices[0]?.value, top[0]?.v);
  });

  it("warns when Other outweighs every slice shown (HM5011)", async () => {
    const one = await writeProject({
      "hatchmark.yaml": CONFIG,
      "data/orders.csv": orders(),
      "metrics/revenue.yaml": METRICS.revenue,
      "dashboards/tiny.yaml": {
        title: "Tiny",
        period: PERIOD,
        blocks: [{ type: "pie", id: "one", metric: "revenue", by: "country", limit: 1 }],
      },
    });
    const result = await run(one.root, one.project, "tiny");
    const b = block(result.data, "one");
    const otherBigger = (b.other?.value ?? 0) > (b.slices[0]?.value ?? 0);
    expect(result.diagnostics.map((d) => d.code)).toEqual(otherBigger ? ["HM5011"] : []);
    expect(otherBigger).toBe(true);
  });
});
