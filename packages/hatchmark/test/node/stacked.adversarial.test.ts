// Adopted from the HAT-58 adversarial review of hatchmark#22 (stacked and 100% stacked bar and area):
// harness.mjs. A hostile orders table (signed amounts, null groups, a category in one month only, parts
// that cancel to a zero total, a position with only negative parts, New York boundary rows) runs
// through the real engine and renderer; totals, parts, shares, tooltips and the screen-reader table
// are checked against plain SQL on the oracle's own DuckDB connection.
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DashboardData, Value } from "../../src/compiler/dashboard-data.js";
import { renderFragment } from "../../src/render/page.js";
import { checkReferences } from "../../src/spec/index.js";
import { Oracle, removeProjects, run, writeProject } from "./fixture.js";

type Key = string | number | boolean | null;
interface StackSeries {
  label: string;
  splitValue?: Key;
  values: Value[];
  share?: Value[];
}
interface Option {
  key: string;
  axis: { buckets: string[] };
  series: StackSeries[];
  totals?: Value[];
}
interface Stack {
  id: string;
  percent?: boolean;
  axis: { categories?: Key[]; buckets?: string[] };
  series: StackSeries[];
  totals?: Value[];
  grains?: { options: Option[] };
}

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const pad = (n: number) => String(n).padStart(2, "0");

function ordersCsv(): string {
  const rand = rng(58);
  const regions = ["North America", "Europe", "Asia-Pacific", "Latin America", ""];
  const channels = ["Online store", "Marketplace", "Retail partners", ""];
  const lines = ["order_id,ordered_at,region,channel,status,amount,customer_id"];
  let id = 0;
  for (let i = 0; i < 900; i++) {
    const m = 1 + Math.floor(rand() * 6);
    const d = 1 + Math.floor(rand() * 28);
    const h = Math.floor(rand() * 24);
    const status = rand() < 0.12 ? "refund" : "paid";
    const amount = (20 + rand() * 180) * (status === "refund" ? -1 : 1);
    lines.push(
      [
        id++,
        `2026-${pad(m)}-${pad(d)}T${pad(h)}:10:00Z`,
        regions[Math.floor(rand() * 5)],
        channels[Math.floor(rand() * 4)],
        status,
        amount.toFixed(2),
        `c${Math.floor(rand() * 70)}`,
      ].join(","),
    );
  }
  const extra: [string, string, string, string, string, string][] = [
    ["2026-03-10T12:00:00Z", "Antarctica", "Online store", "paid", "75.00", "c900"],
    ["2026-04-10T12:00:00Z", "Zeroland", "Online store", "paid", "100.00", "c901"],
    ["2026-04-11T12:00:00Z", "Zeroland", "Marketplace", "refund", "-100.00", "c901"],
    ["2026-05-10T12:00:00Z", "Allneg", "Online store", "refund", "-50.00", "c902"],
    ["2026-05-11T12:00:00Z", "Allneg", "Marketplace", "refund", "-30.00", "c903"],
    ["2026-02-01T04:30:00Z", "Europe", "Marketplace", "paid", "500.00", "c1"],
    ["2026-06-16T03:59:00Z", "Europe", "Online store", "paid", "321.00", "c2"],
    ["2026-06-16T04:01:00Z", "Europe", "Online store", "paid", "999.00", "c3"],
  ];
  for (const row of extra) lines.push([id++, ...row].join(","));
  return `${lines.join("\n")}\n`;
}

function balancesCsv(): string {
  const lines = ["snap_date,region,account_id,balance"];
  for (let m = 1; m <= 6; m++) {
    const days = new Date(Date.UTC(2026, m, 0)).getUTCDate();
    for (let d = 1; d <= days; d++) {
      const date = `2026-${pad(m)}-${pad(d)}`;
      const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
      for (const [region, accounts] of [
        ["North America", 3],
        ["Europe", 2],
        ["Asia-Pacific", 2],
      ] as const) {
        if (region === "Europe" && d > 28) continue;
        if (region === "Asia-Pacific" && (dow === 0 || dow === 6)) continue;
        for (let a = 0; a < accounts; a++) {
          lines.push(
            [date, region, region.slice(0, 2) + a, (1000 + m * 10 + d + a * 100).toFixed(2)].join(
              ",",
            ),
          );
        }
      }
    }
  }
  return `${lines.join("\n")}\n`;
}

const usd = { type: "currency", currency: "USD" };
const num = { type: "number" };
const M = (label: string, body: object, format: object = usd) => ({
  label,
  format,
  better: "up",
  ...body,
});
const O = (label: string, body: object, format?: object) =>
  M(label, { type: "aggregate", table: "orders", time: "ordered_at", ...body }, format);
const B = (label: string, body: object) =>
  M(label, {
    type: "aggregate",
    table: "balances",
    time: "snap_date",
    aggregate: "sum",
    column: "balance",
    ...body,
  });
const paid = [{ column: "status", op: "eq", value: "paid" }];
const METRICS = {
  revenue: O("Revenue", { aggregate: "sum", column: "amount", filters: paid }),
  net: O("Net", { aggregate: "sum", column: "amount" }),
  orders: O("Orders", { aggregate: "count" }, num),
  refunds_n: O(
    "Refunds",
    { aggregate: "count", filters: [{ column: "status", op: "eq", value: "refund" }] },
    num,
  ),
  customers: O("Customers", { aggregate: "count_distinct", column: "customer_id" }, num),
  aov: O("AOV", { aggregate: "avg", column: "amount" }),
  median_amt: O("Median", { aggregate: "median", column: "amount" }),
  max_amt: O("Max", { aggregate: "max", column: "amount" }),
  refund_rate: M(
    "Refund rate",
    { type: "ratio", numerator: "refunds_n", denominator: "orders" },
    { type: "percent" },
  ),
  plus_const: M("Rev + 1000", { type: "formula", expr: "revenue + 1000" }),
  linear: M("Rev minus net", { type: "formula", expr: "revenue - net" }),
  sql_na: M("SQL non-additive", {
    type: "sql",
    table: "orders",
    time: "ordered_at",
    sql: "max(amount)",
    additive: false,
  }),
  eur: O(
    "EUR revenue",
    { aggregate: "sum", column: "amount" },
    { type: "currency", currency: "EUR" },
  ),
  bal_last: B("Balance (last)", { over_time: "last" }),
  bal_entity: B("Balance (last per account)", { over_time: "last", entity: "account_id" }),
  bal_avg: B("Balance (avg)", { over_time: "avg" }),
  bal_max: B("Balance (max)", { over_time: "max" }),
};

const YTD = { asOf: "2026-06-30", range: "year_to_date", compare: "none" };
const MAIN = [
  {
    type: "bar",
    id: "net_pct",
    metrics: ["net"],
    by: "region",
    split: "channel",
    stack: "percent",
  },
  {
    type: "bar",
    id: "rev_pct_month",
    metrics: ["revenue"],
    grain: "month",
    split: "region",
    stack: "percent",
  },
  {
    type: "bar",
    id: "orders_stack",
    metrics: ["orders"],
    by: "region",
    split: "channel",
    stack: true,
  },
  { type: "bar", id: "multi_pct", metrics: ["revenue", "net"], by: "region", stack: "percent" },
  {
    type: "area",
    id: "rev_area_pct",
    metrics: ["revenue"],
    grain: "month",
    grains: ["week", "month", "quarter"],
    split: "channel",
    stack: "percent",
  },
  {
    type: "area",
    id: "cust_area",
    metrics: ["customers"],
    grain: "month",
    split: "region",
    stack: true,
  },
  {
    type: "bar",
    id: "rev_h_top3",
    metrics: ["revenue"],
    by: "channel",
    split: "region",
    stack: true,
    orientation: "horizontal",
    limit: 3,
  },
  {
    type: "bar",
    id: "rev_bar_grains",
    metrics: ["revenue"],
    grain: "month",
    grains: ["month", "quarter"],
    split: "region",
    stack: "percent",
  },
];
const NONADD = [
  "customers",
  "aov",
  "median_amt",
  "max_amt",
  "refund_rate",
  "plus_const",
  "sql_na",
  "bal_max",
];
const CHECKS = [
  ...NONADD.map((m) => ({
    type: "bar",
    id: `p_${m}`,
    metrics: [m],
    by: "region",
    split: "channel",
    stack: "percent",
  })),
  ...NONADD.map((m) => ({
    type: "area",
    id: `s_${m}`,
    metrics: [m],
    grain: "month",
    split: "channel",
    stack: true,
  })),
  { type: "bar", id: "units_cur", metrics: ["revenue", "eur"], by: "region", stack: true },
  { type: "bar", id: "units_num", metrics: ["revenue", "orders"], by: "region", stack: true },
  {
    type: "bar",
    id: "units_num_pct",
    metrics: ["revenue", "orders"],
    by: "region",
    stack: "percent",
  },
  { type: "bar", id: "units_cur_pct", metrics: ["revenue", "eur"], by: "region", stack: "percent" },
  { type: "area", id: "mixed_pct", metrics: ["revenue", "aov"], grain: "month", stack: "percent" },
  {
    type: "bar",
    id: "lin_pct",
    metrics: ["linear"],
    by: "region",
    split: "channel",
    stack: "percent",
  },
];

const DASHBOARDS = {
  main: { title: "Main", period: YTD, blocks: MAIN },
  balances: {
    title: "Balances",
    period: YTD,
    blocks: ["bal_last", "bal_entity", "bal_avg"].map((m) => ({
      type: "bar",
      id: `${m}_pct`,
      metrics: [m],
      grain: "month",
      split: "region",
      stack: "percent",
    })),
  },
  grainfilter: {
    title: "Grain filter",
    period: { asOf: "2026-06-30", range: "year_to_date", compare: "previous_year" },
    filters: [
      { type: "grain", id: "grain", options: ["week", "month", "quarter"], default: "quarter" },
    ],
    blocks: [
      {
        type: "area",
        id: "gf_area",
        metrics: ["revenue"],
        grain: "month",
        grains: ["week", "month", "quarter"],
        split: "region",
        stack: "percent",
      },
      {
        type: "bar",
        id: "gf_bar",
        metrics: ["orders"],
        grain: "month",
        grains: ["week", "month", "quarter"],
        split: "channel",
        stack: true,
      },
    ],
  },
  partial: {
    title: "Partial",
    period: { asOf: "2026-06-15", range: "year_to_date", compare: "none" },
    blocks: [
      {
        type: "bar",
        id: "partial_pct",
        metrics: ["revenue"],
        grain: "month",
        split: "region",
        stack: "percent",
      },
    ],
  },
  filtered: {
    title: "Filtered",
    period: YTD,
    filters: [
      {
        type: "select",
        id: "reg",
        column: "region",
        multiple: true,
        default: ["Europe", "Asia-Pacific"],
      },
    ],
    blocks: [
      {
        type: "bar",
        id: "f_pct",
        metrics: ["revenue"],
        by: "channel",
        split: "region",
        stack: "percent",
      },
    ],
  },
  checks: { title: "Checks", period: YTD, blocks: CHECKS },
};

const CONFIG = {
  version: 1,
  name: "Stacks",
  dataDir: "data",
  metricsDir: "metrics",
  dashboardsDir: "dashboards",
  outDir: "dist",
  locale: "en-US",
  currency: "USD",
  timezone: "America/New_York",
  weekStart: "sunday",
  theme: "default",
  telemetry: false,
  sources: {
    orders: { type: "csv", path: "data/orders.csv" },
    balances: { type: "csv", path: "data/balances.csv" },
  },
};

const LOCAL = "(ts AT TIME ZONE 'America/New_York')";
const win = (end: string) => `${LOCAL} >= TIMESTAMP '2026-01-01' AND ${LOCAL} < TIMESTAMP '${end}'`;
const bucket = (unit: string) =>
  unit === "week"
    ? `strftime(CAST(${LOCAL} AS DATE) - CAST(dayofweek(${LOCAL}) AS INTEGER), '%Y-%m-%d')`
    : `strftime(date_trunc('${unit}', ${LOCAL}), '%Y-%m-%d')`;
const K = (...parts: unknown[]) => JSON.stringify(parts.map((p) => p ?? null));
const close = (a: Value | undefined, e: Value | undefined) =>
  e === null || e === undefined
    ? a === null || a === undefined
    : typeof a === "number" &&
      Math.abs(a - (e as number)) <= 1e-9 * Math.max(1, Math.abs(e as number));

let oracle: Oracle;
let project: Awaited<ReturnType<typeof writeProject>>;
let main: Awaited<ReturnType<typeof run>>;

async function grouped(sql: string, keys: string[]): Promise<Map<string, number | null>> {
  const out = new Map<string, number | null>();
  for (const r of await oracle.rows(sql)) {
    out.set(K(...keys.map((k) => r[k] ?? null)), r.v === null ? null : Number(r.v));
  }
  return out;
}

function block(data: DashboardData | undefined, id: string): Stack {
  const found = data?.blocks.find((b) => b.id === id);
  if (found === undefined) throw new Error(`no block ${id}`);
  return found as unknown as Stack;
}

/** Totals, parts and shares of a stacked block against oracle maps keyed by [position(, split)]. */
function compare(
  b: { series: StackSeries[]; totals?: Value[]; percent?: boolean },
  positions: Key[],
  totals: Map<string, number | null>,
  parts: Map<string, number | null>,
  opts: { share?: boolean; sumsToOne?: boolean; noFill?: boolean } = {},
): string[] {
  const bad: string[] = [];
  positions.forEach((p, i) => {
    const t = totals.get(K(p)) ?? null;
    if (!close(b.totals?.[i], t)) bad.push(`total ${p}: engine ${b.totals?.[i]} oracle ${t}`);
    let shares = 0;
    let any = false;
    for (const s of b.series) {
      const v = parts.get(K(p, s.splitValue ?? null)) ?? (t === null || opts.noFill ? null : 0);
      if (!close(s.values[i], v))
        bad.push(`part ${p}/${s.label}: engine ${s.values[i]} oracle ${v}`);
      const share = v === null || t === null || t === 0 ? null : v / t;
      if ((b.percent || opts.share) && !close(s.share?.[i] ?? null, share)) {
        bad.push(`share ${p}/${s.label}: engine ${s.share?.[i]} oracle ${share}`);
      }
      const got = s.share?.[i];
      if (typeof got === "number") {
        shares += got;
        any = true;
      }
    }
    if (opts.sumsToOne && any && Math.abs(shares - 1) > 1e-9)
      bad.push(`shares at ${p} sum to ${shares}`);
  });
  return bad;
}

const number = (text: string | undefined) => {
  const t = String(text ?? "")
    .replace(/\u2212/g, "-")
    .replace(/[^0-9.-]/g, "");
  return t === "" || t === "-" ? null : Number(t);
};
const decimals = (text: string | undefined) =>
  (String(text ?? "").split(".")[1] ?? "").replace(/[^0-9]/g, "").length;
const matches = (text: string | undefined, v: Value | undefined, scale = 1) => {
  const n = number(text);
  if (v === null || v === undefined) return n === null;
  return n !== null && Math.abs(n - v * scale) <= 0.5 * 10 ** -decimals(text) + 1e-9;
};

function runtimeOf(
  html: string,
  id: string,
): { series: { pct?: string[] }[]; total?: string[] } | undefined {
  const m = html.match(
    new RegExp(`data-hm-chart="${id}"><script type="application/json">(.*?)</script>`),
  );
  return m ? JSON.parse((m[1] as string).replace(/\\u003c/g, "<")) : undefined;
}

/** Tooltip pct and Total text against shares and totals, within display rounding. */
function tooltip(
  html: string,
  id: string,
  series: StackSeries[],
  totals: Value[] | undefined,
): string[] {
  const rt = runtimeOf(html, id);
  if (!rt) return [`${id}: no runtime JSON`];
  const bad: string[] = [];
  series.forEach((s, k) => {
    const pct = rt.series[k]?.pct;
    if (!pct) {
      bad.push(`${id} ${s.label}: no pct`);
      return;
    }
    (s.share ?? []).forEach((v, i) => {
      if (!matches(pct[i], v, 100)) bad.push(`${id} ${s.label}[${i}]: ${pct[i]} vs ${v}`);
    });
  });
  (totals ?? []).forEach((v, i) => {
    if (!matches(rt.total?.[i], v)) bad.push(`${id} total[${i}]: ${rt.total?.[i]} vs ${v}`);
  });
  return bad;
}

/** The screen-reader table's last column against the engine totals, row by row. */
function table(html: string, id: string, series: StackSeries[], totals: Value[]): string[] {
  const fig = html.split(`data-hm-chart="${id}"`)[1]?.split("</figure>")[0] ?? "";
  const rows = (fig.split("<tbody>")[1]?.split("</tbody>")[0] ?? "")
    .split("</tr>")
    .filter((x) => x.includes("<td>"));
  if (rows.length !== totals.length) return [`${id}: ${rows.length} rows vs ${totals.length}`];
  const bad: string[] = [];
  rows.forEach((tr, i) => {
    const cells = [...tr.matchAll(/<td>(.*?)<\/td>/g)].map((m) => m[1]);
    if (cells.length !== series.length + 1) bad.push(`${id} row ${i}: ${cells.length} cells`);
    if (!matches(cells.at(-1), totals[i]))
      bad.push(`${id} row ${i}: Total ${cells.at(-1)} vs ${totals[i]}`);
  });
  return bad;
}

beforeAll(async () => {
  oracle = await Oracle.open();
  project = await writeProject({
    "hatchmark.json": CONFIG,
    "data/orders.csv": ordersCsv(),
    "data/balances.csv": balancesCsv(),
    ...Object.fromEntries(Object.entries(METRICS).map(([n, m]) => [`metrics/${n}.json`, m])),
    ...Object.fromEntries(Object.entries(DASHBOARDS).map(([n, d]) => [`dashboards/${n}.json`, d])),
  });
  const orders = path.join(project.root, "data/orders.csv");
  await oracle.rows(
    `CREATE TABLE o AS SELECT order_id, CAST(ordered_at AS TIMESTAMPTZ) AS ts, NULLIF(region, '') AS region, NULLIF(channel, '') AS channel, status, CAST(amount AS DOUBLE) AS amount, customer_id FROM read_csv('${orders}', all_varchar = true)`,
  );
  main = await run(project.root, project.project, "main");
});
afterAll(async () => {
  oracle.close();
  await removeProjects();
});

const at = (blocks: { id: string }[], id: string) =>
  `/blocks/${blocks.findIndex((b) => b.id === id)}`;

describe("stacked charts against a SQL oracle (HAT-58 harness)", () => {
  it("check: non-additive metrics, mixed units and a linear formula", () => {
    expect(project.diagnostics).toEqual([]);
    const diags = checkReferences(project.project).filter((d) => d.file?.endsWith("checks.json"));
    const codes = (id: string) =>
      diags.filter((d) => d.pointer?.startsWith(`${at(CHECKS, id)}/`)).map((d) => d.code);
    for (const m of NONADD) {
      expect(codes(`p_${m}`), `100% stack of ${m}`).toContain("HM4001");
      expect(codes(`s_${m}`), `plain split stack of ${m}`).toContain("HM4060");
    }
    for (const id of ["units_cur", "units_num", "units_num_pct", "units_cur_pct"]) {
      const found = diags.filter((d) => d.pointer?.startsWith(`${at(CHECKS, id)}/`));
      expect(
        found.map((d) => [d.code, d.severity]),
        id,
      ).toContainEqual(["HM4062", "error"]);
    }
    expect(codes("mixed_pct")).toContain("HM4001");
    expect(codes("lin_pct")).toEqual([]);
  });

  it("builds main with HM4061 on the signed 100% stack only", () => {
    expect(main.data).toBeDefined();
    const diags = main.diagnostics.map((d) => `${d.code} ${d.pointer}`);
    expect(diags).toContain(`HM4061 ${at(MAIN, "net_pct")}/stack`);
    expect(diags.some((d) => d.startsWith(`HM4061 ${at(MAIN, "rev_pct_month")}`))).toBe(false);
  });

  it("net_pct: signed parts, a zero total, an all-negative total and null groups", async () => {
    const b = block(main.data, "net_pct");
    const pos = b.axis.categories ?? [];
    const t = await grouped(
      `SELECT region, sum(amount) AS v FROM o WHERE ${win("2026-07-01")} GROUP BY ALL`,
      ["region"],
    );
    const p = await grouped(
      `SELECT region, channel, sum(amount) AS v FROM o WHERE ${win("2026-07-01")} GROUP BY ALL`,
      ["region", "channel"],
    );
    expect(new Set(pos.map((x) => K(x)))).toEqual(new Set(t.keys()));
    expect(compare(b, pos, t, p)).toEqual([]);
    const zero = pos.indexOf("Zeroland");
    expect(b.series.map((s) => s.share?.[zero])).toEqual(b.series.map(() => null));
  });

  it("rev_pct_month: a category in one month only and null regions; shares sum to 1", async () => {
    const b = block(main.data, "rev_pct_month");
    const t = await grouped(
      `SELECT ${bucket("month")} AS m, sum(amount) FILTER (WHERE status = 'paid') AS v FROM o WHERE ${win("2026-07-01")} GROUP BY ALL`,
      ["m"],
    );
    const p = await grouped(
      `SELECT ${bucket("month")} AS m, region, sum(amount) AS v FROM o WHERE ${win("2026-07-01")} AND status = 'paid' GROUP BY ALL`,
      ["m", "region"],
    );
    expect(compare(b, b.axis.buckets ?? [], t, p, { sumsToOne: true })).toEqual([]);
  });

  it("orders_stack: a count stack with null groups", async () => {
    const b = block(main.data, "orders_stack");
    const t = await grouped(
      `SELECT region, count(*) AS v FROM o WHERE ${win("2026-07-01")} GROUP BY ALL`,
      ["region"],
    );
    const p = await grouped(
      `SELECT region, channel, count(*) AS v FROM o WHERE ${win("2026-07-01")} GROUP BY ALL`,
      ["region", "channel"],
    );
    expect(compare(b, b.axis.categories ?? [], t, p, { share: true, sumsToOne: true })).toEqual([]);
  });

  it("multi_pct: several metrics total as their sum", async () => {
    const b = block(main.data, "multi_pct");
    const rows = await oracle.rows(
      `SELECT region, sum(amount) FILTER (WHERE status = 'paid') AS rev, sum(amount) AS net FROM o WHERE ${win("2026-07-01")} GROUP BY ALL`,
    );
    const by = new Map(rows.map((x) => [K(x.region), x]));
    (b.axis.categories ?? []).forEach((c, i) => {
      const x = by.get(K(c));
      const rev = x ? Number(x.rev ?? 0) : null;
      const net = x ? Number(x.net ?? 0) : null;
      const total = rev === null && net === null ? null : (rev ?? 0) + (net ?? 0);
      expect(close(b.totals?.[i], total), `${c} total`).toBe(true);
      expect(
        close(b.series[0]?.share?.[i], rev === null || !total ? null : rev / total),
        `${c} share`,
      ).toBe(true);
    });
  });

  it("rev_area_pct and rev_bar_grains: every grain's own totals and shares (Sunday weeks)", async () => {
    for (const [id, split] of [
      ["rev_area_pct", "channel"],
      ["rev_bar_grains", "region"],
    ] as const) {
      for (const o of block(main.data, id).grains?.options ?? []) {
        const unit = o.key.split(":")[0] as string;
        const t = await grouped(
          `SELECT ${bucket(unit)} AS m, sum(amount) FILTER (WHERE status = 'paid') AS v FROM o WHERE ${win("2026-07-01")} GROUP BY ALL`,
          ["m"],
        );
        const p = await grouped(
          `SELECT ${bucket(unit)} AS m, ${split}, sum(amount) AS v FROM o WHERE ${win("2026-07-01")} AND status = 'paid' GROUP BY ALL`,
          ["m", split],
        );
        expect(
          compare({ ...o, percent: true }, o.axis.buckets, t, p, { sumsToOne: true }),
          `${id} ${o.key}`,
        ).toEqual([]);
      }
    }
  });

  it("cust_area: a distinct-count stack's total is count(DISTINCT) per month, not the segment sum", async () => {
    const b = block(main.data, "cust_area");
    const t = await grouped(
      `SELECT ${bucket("month")} AS m, count(DISTINCT customer_id) AS v FROM o WHERE ${win("2026-07-01")} GROUP BY ALL`,
      ["m"],
    );
    const p = await grouped(
      `SELECT ${bucket("month")} AS m, region, count(DISTINCT customer_id) AS v FROM o WHERE ${win("2026-07-01")} GROUP BY ALL`,
      ["m", "region"],
    );
    expect(compare(b, b.axis.buckets ?? [], t, p, { noFill: true })).toEqual([]);
  });

  it("rev_h_top3: limit keeps the top positions, each with its full total", async () => {
    const b = block(main.data, "rev_h_top3");
    const top = await oracle.rows(
      `SELECT channel, sum(amount) FILTER (WHERE status = 'paid') AS v FROM o WHERE ${win("2026-07-01")} GROUP BY ALL ORDER BY v DESC NULLS LAST, channel NULLS LAST LIMIT 3`,
    );
    expect(b.axis.categories).toEqual(top.map((r) => r.channel ?? null));
    top.forEach((r, i) => {
      expect(close(b.totals?.[i], Number(r.v))).toBe(true);
    });
  });

  it("balances: 100% stacks of point-in-time sums are left out (HM4023) or add up to 100%", async () => {
    const result = await run(project.root, project.project, "balances");
    const left = new Set(
      result.diagnostics.filter((d) => d.code === "HM4023").map((d) => d.pointer),
    );
    DASHBOARDS.balances.blocks.forEach((spec, i) => {
      const b = result.data?.blocks.find((x) => x.id === spec.id) as unknown as Stack | undefined;
      if (b === undefined) {
        expect(
          [...left].some((p) => p?.startsWith(`/blocks/${i}`)),
          spec.id,
        ).toBe(true);
        return;
      }
      (b.axis.buckets ?? []).forEach((m, j) => {
        const sum = b.series.reduce((a, s) => a + ((s.share?.[j] as number | null) ?? 0), 0);
        expect(Math.abs(sum - 1), `${spec.id} ${m}`).toBeLessThan(1e-9);
      });
    });
  });

  it("partial period: asOf Jun 15 keeps the 23:59 New York row and drops the next one", async () => {
    const result = await run(project.root, project.project, "partial");
    const b = block(result.data, "partial_pct");
    const t = await grouped(
      `SELECT ${bucket("month")} AS m, sum(amount) FILTER (WHERE status = 'paid') AS v FROM o WHERE ${win("2026-06-16")} GROUP BY ALL`,
      ["m"],
    );
    const p = await grouped(
      `SELECT ${bucket("month")} AS m, region, sum(amount) AS v FROM o WHERE ${win("2026-06-16")} AND status = 'paid' GROUP BY ALL`,
      ["m", "region"],
    );
    expect(compare(b, b.axis.buckets ?? [], t, p, { sumsToOne: true })).toEqual([]);
  });

  it("a multi-select default on the split column", async () => {
    const result = await run(project.root, project.project, "filtered");
    const b = block(result.data, "f_pct");
    const where = `${win("2026-07-01")} AND region IN ('Europe', 'Asia-Pacific')`;
    const t = await grouped(
      `SELECT channel, sum(amount) FILTER (WHERE status = 'paid') AS v FROM o WHERE ${where} GROUP BY ALL`,
      ["channel"],
    );
    const p = await grouped(
      `SELECT channel, region, sum(amount) AS v FROM o WHERE ${where} AND status = 'paid' GROUP BY ALL`,
      ["channel", "region"],
    );
    expect(compare(b, b.axis.categories ?? [], t, p, { sumsToOne: true })).toEqual([]);
  });

  it("tooltips and the screen-reader table show the engine's shares and totals, every grain panel included", () => {
    const data = main.data as DashboardData;
    const html = renderFragment(data);
    const bad: string[] = [];
    for (const id of ["net_pct", "rev_pct_month", "orders_stack", "multi_pct", "rev_h_top3"]) {
      const b = block(data, id);
      bad.push(
        ...tooltip(html, id, b.series, b.totals),
        ...table(html, id, b.series, b.totals ?? []),
      );
    }
    for (const id of ["rev_area_pct", "rev_bar_grains"]) {
      for (const o of block(data, id).grains?.options ?? []) {
        const panel = `${id}-${o.key.replace(":", "-")}`;
        bad.push(
          ...tooltip(html, panel, o.series, o.totals),
          ...table(html, panel, o.series, o.totals ?? []),
        );
      }
    }
    expect(bad).toEqual([]);
  });

  it("a dashboard grain filter with compare previous_year: each grain's totals, shares and tooltips", async () => {
    const result = await run(project.root, project.project, "grainfilter");
    const html = renderFragment(result.data as DashboardData);
    for (const [id, split, agg, extra] of [
      ["gf_area", "region", "sum(amount)", " AND status = 'paid'"],
      ["gf_bar", "channel", "count(*)", ""],
    ] as const) {
      const options = block(result.data, id).grains?.options ?? [];
      expect(options.map((o) => o.key.split(":")[0])).toEqual(["week", "month", "quarter"]);
      for (const o of options) {
        const unit = o.key.split(":")[0] as string;
        const t = await grouped(
          `SELECT ${bucket(unit)} AS m, ${agg} AS v FROM o WHERE ${win("2026-07-01")}${extra} GROUP BY ALL`,
          ["m"],
        );
        const p = await grouped(
          `SELECT ${bucket(unit)} AS m, ${split}, ${agg} AS v FROM o WHERE ${win("2026-07-01")}${extra} GROUP BY ALL`,
          ["m", split],
        );
        expect(
          compare({ ...o, percent: true }, o.axis.buckets, t, p, { sumsToOne: true }),
          `${id} ${o.key}`,
        ).toEqual([]);
        expect(tooltip(html, `${id}-${o.key.replace(":", "-")}`, o.series, o.totals)).toEqual([]);
      }
    }
  });
});
