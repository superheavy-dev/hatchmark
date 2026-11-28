import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DashboardData, ScatterData } from "../../src/compiler/dashboard-data.js";
import type { Diagnostic } from "../../src/diagnostics/diagnostic.js";
import { renderFragment } from "../../src/render/page.js";
import { checkReferences } from "../../src/spec/index.js";
import { Oracle, removeProjects, run, writeProject } from "./fixture.js";

type Key = string | number | boolean | null;
type Built = Awaited<ReturnType<typeof run>>;
type Block = { type: string; id: string; [k: string]: unknown };
interface ScatterBlock extends Block {
  x: string;
  y: string;
  by: string;
  size?: string;
  limit?: number;
}

const FULL = process.env.HM_SWEEP === "full";

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}
const pad = (n: number) => String(n).padStart(2, "0");
const COUNTRIES = [
  "United States",
  "Germany",
  "Japan",
  "Brazil",
  "Canada",
  "Australia",
  "India",
  "Mexico",
  "France",
  "United Kingdom",
  "Côte d'Ivoire",
  "Czechia",
  "",
];
const CHANNELS = ["Online store", "Marketplace", "Retail partners", ""];
const iso = (t: number) => `${new Date(t).toISOString().slice(0, 19)}Z`;

function data(): Record<string, string> {
  const rand = rng(62);
  const ord = [
    "order_id,ordered_at,country,channel,status,amount,quantity,customer_id,cohort,acct500,acct501",
  ];
  let id = 0;
  const push = (
    at: string,
    country: string,
    channel: string,
    status: string,
    amount: string,
    quantity: string,
    customer: string,
    cohort: number,
  ) => {
    ord.push(
      [id, at, country, channel, status, amount, quantity, customer, cohort]
        .concat(`a${id % 500}`, `b${id % 501}`)
        .join(","),
    );
    id++;
  };
  for (let i = 0; i < 2600; i++) {
    const m = 1 + Math.floor(rand() * 6);
    const d = 1 + Math.floor(rand() * 27);
    const h = Math.floor(rand() * 24);
    const status = rand() < 0.12 ? "refund" : "paid";
    const amt =
      rand() < 0.03 ? "" : ((10 + rand() * 250) * (status === "refund" ? -1 : 1)).toFixed(2);
    const qty = rand() < 0.03 ? "" : String(1 + Math.floor(rand() * 6));
    const at = `2026-${pad(m)}-${pad(d)}T${pad(h)}:${pad(Math.floor(rand() * 60))}:00Z`;
    const country = COUNTRIES[Math.floor(rand() * COUNTRIES.length)] ?? "";
    const channel = CHANNELS[Math.floor(rand() * CHANNELS.length)] ?? "";
    const customer = `c${Math.floor(rand() * 720)}`;
    push(at, country, channel, status, amt, qty, customer, 1 + Math.floor(rand() * 12));
  }
  push("2026-03-02T15:00:00Z", "Iceland", "Marketplace", "refund", "-120.00", "2", "c9001", 3);
  push("2026-04-02T15:00:00Z", "Iceland", "Online store", "refund", "-80.00", "1", "c9002", 3);
  push("2026-04-10T12:00:00Z", "Zeroland", "Online store", "paid", "100.00", "1", "c9003", 4);
  push("2026-04-11T12:00:00Z", "Zeroland", "Marketplace", "refund", "-100.00", "1", "c9003", 4);
  push("2026-02-10T12:00:00Z", "Nullonly", "Marketplace", "paid", "", "", "c9004", 5);
  push("2026-02-11T12:00:00Z", "Nullonly", "Marketplace", "paid", "", "", "c9005", 5);
  for (const t of ["TieD", "TieB", "TieC", "TieA"]) {
    push("2026-05-03T12:00:00Z", t, "Marketplace", "paid", "50.00", "2", `c${t}`, 6);
    push("2026-05-04T12:00:00Z", t, "Marketplace", "paid", "50.00", "2", `c${t}`, 6);
  }
  push("2026-01-01T05:00:00Z", "Edgeland", "Online store", "paid", "1.00", "1", "c9100", 7);
  push("2026-06-28T03:59:00Z", "Edgeland", "Online store", "paid", "2.00", "1", "c9101", 7);
  push("2026-01-01T04:59:00Z", "Edgeland", "Online store", "paid", "1000.00", "1", "c9102", 7);
  push("2026-06-28T04:01:00Z", "Edgeland", "Online store", "paid", "20000.00", "1", "c9103", 7);
  push("2026-06-28T18:03:00Z", "Edgeland", "Online store", "paid", "300000.00", "1", "c9104", 7);

  const ses = ["session_date,country,sessions"];
  for (let d = 0; d < 105; d++) {
    const date = new Date(Date.UTC(2026, 0, 1) + d * 86400e3).toISOString().slice(0, 10);
    for (const c of [...COUNTRIES.slice(0, 8), "", "Sessiononly", "Iceland"])
      ses.push(`${date},${c},${20 + Math.floor(rand() * 400)}`);
  }
  ses.push("2026-04-15,Edgeland,7");
  const sto = ["sold_at,country,amount"];
  for (let i = 0; i < 400; i++) {
    const day = Math.floor(rand() * 120);
    const at = iso(Date.UTC(2026, 0, 1, 14) + day * 86400e3 + Math.floor(rand() * 8) * 3600e3);
    sto.push(`${at},${COUNTRIES[Math.floor(rand() * 6)]},${(5 + rand() * 90).toFixed(2)}`);
  }
  sto.push("2026-05-01T03:59:59Z,Edgeland,3.00", "2026-05-01T04:00:00Z,Edgeland,4000.00");
  const kio = ["sold_at,country,amount"];
  for (let i = 0; i < 300; i++) {
    const at = iso(Date.UTC(2026, 0, 1, 15) + Math.floor(rand() * 151) * 86400e3);
    kio.push(`${at},${COUNTRIES[Math.floor(rand() * 6)]},${(5 + rand() * 60).toFixed(2)}`);
  }
  kio.push("2026-06-01T14:00:00Z,Edgeland,11.00");

  const csv = (lines: string[]) => `${lines.join("\n")}\n`;
  return {
    "data/orders.csv": csv(ord),
    "data/sessions.csv": csv(ses),
    "data/store.csv": csv(sto),
    "data/kiosk.csv": csv(kio),
  };
}

const CONFIG = {
  version: 1,
  name: "Scatter attack",
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
  sources: Object.fromEntries(
    ["orders", "sessions", "store", "kiosk"].map((s) => [
      s,
      { type: "csv", path: `data/${s}.csv` },
    ]),
  ),
};
const usd = { type: "currency", currency: "USD" };
const num = { type: "number" };
const pct = { type: "percent" };
const M = (label: string, body: Record<string, unknown>, format: unknown = usd) => ({
  label,
  format,
  better: "up",
  ...body,
});
const O = (label: string, body: Record<string, unknown>, format?: unknown) =>
  M(label, { type: "aggregate", table: "orders", time: "ordered_at", ...body }, format);
const Agg = (label: string, table: string, aggregate: string, column?: string, format?: unknown) =>
  M(
    label,
    {
      type: "aggregate",
      table,
      time: table === "sessions" ? "session_date" : "sold_at",
      ...(column ? { column } : {}),
      aggregate,
    },
    format,
  );
const paid = [{ column: "status", op: "eq", value: "paid" }];
const METRICS: Record<string, unknown> = {
  revenue: O("Revenue", { aggregate: "sum", column: "amount", filters: paid }),
  net: O("Net", { aggregate: "sum", column: "amount" }),
  paid_orders: O("Paid orders", { aggregate: "count", column: "order_id", filters: paid }, num),
  orders_all: O("Orders", { aggregate: "count" }, num),
  refunds_n: O(
    "Refunds",
    { aggregate: "count", filters: [{ column: "status", op: "eq", value: "refund" }] },
    num,
  ),
  items: O("Items", { aggregate: "sum", column: "quantity", filters: paid }, num),
  customers: O("Customers", { aggregate: "count_distinct", column: "customer_id" }, num),
  paid_customers: O(
    "Paying customers",
    { aggregate: "count_distinct", column: "customer_id", filters: paid },
    num,
  ),
  avg_amount: O("Avg amount", { aggregate: "avg", column: "amount" }),
  median_amount: O("Median amount", { aggregate: "median", column: "amount" }),
  max_amount: O("Max amount", { aggregate: "max", column: "amount" }),
  aov: M("AOV", { type: "ratio", numerator: "revenue", denominator: "paid_orders" }),
  price_per_item: M("Price per item", {
    type: "ratio",
    numerator: "revenue",
    denominator: "items",
  }),
  refund_rate: M(
    "Refund rate",
    { type: "ratio", numerator: "refunds_n", denominator: "orders_all" },
    pct,
  ),
  spread: M("Spread", {
    type: "sql",
    table: "orders",
    time: "ordered_at",
    sql: "max(amount) - min(amount)",
    additive: false,
  }),
  sessions: Agg("Sessions", "sessions", "sum", "sessions", num),
  conversion: M(
    "Conversion",
    { type: "ratio", numerator: "paid_orders", denominator: "sessions" },
    pct,
  ),
  store_sales: Agg("Store sales", "store", "sum", "amount"),
  store_tx: Agg("Store transactions", "store", "count", undefined, num),
  kiosk_sales: Agg("Kiosk sales", "kiosk", "sum", "amount"),
  kiosk_tx: Agg("Kiosk transactions", "kiosk", "count", undefined, num),
};

const YTD = { asOf: "2026-06-30", range: "year_to_date", compare: "none" };
const S = (id: string, x: string, y: string, by: string, extra = {}): ScatterBlock => ({
  type: "scatter",
  id,
  x,
  y,
  by,
  ...extra,
});
const MAIN: ScatterBlock[] = [
  S("basic", "paid_orders", "aov", "country", { size: "revenue" }),
  S("nonadd", "customers", "median_amount", "country", { size: "avg_amount" }),
  S("ratios", "refund_rate", "price_per_item", "country", { size: "net" }),
  S("negative", "net", "avg_amount", "country"),
  S("zero_axes", "revenue", "paid_orders", "country", { size: "refunds_n" }),
  S("sqlna", "spread", "max_amount", "channel", { size: "orders_all" }),
  S("dots", "orders_all", "net", "country"),
  S("limit1", "paid_orders", "aov", "country", { size: "revenue", limit: 1 }),
  S("limit5", "paid_orders", "net", "country", { size: "revenue", limit: 5 }),
  S("paidcust", "paid_customers", "net", "country"),
  S("cohort", "orders_all", "aov", "cohort", { size: "net" }),
  S("acct500", "orders_all", "net", "acct500"),
  S("acct501", "orders_all", "net", "acct501"),
  S("mixed_sources", "sessions", "revenue", "country", { size: "paid_orders" }),
  S("conversion", "sessions", "conversion", "country"),
  S("store_mid", "store_tx", "store_sales", "country"),
  S("paid_only", "revenue", "paid_orders", "country"),
  S("distinct_vs_sessions", "customers", "sessions", "country"),
  ...(FULL
    ? [
        S("customers_cap", "orders_all", "net", "customer_id", { size: "revenue" }),
        S("customers_500", "orders_all", "net", "customer_id", { size: "revenue", limit: 500 }),
      ]
    : []),
];
const TIES = [
  S("ties", "paid_orders", "aov", "country", { size: "revenue", limit: 2 }),
  S("ties_dots", "paid_orders", "aov", "country", { limit: 3 }),
];
const TIE_KEYS = ["TieD", "TieB", "Zeroland", "TieC", "TieA"];
const BYCOL = ["United States", "Germany", "Iceland"];
const sel = (id: string, column: string, value: unknown) => ({
  type: "select",
  id,
  column,
  ...(Array.isArray(value) ? { multiple: true } : {}),
  default: value,
});
const CHANNEL = [
  S("f_basic", "paid_orders", "aov", "country", { size: "revenue" }),
  S("f_nonadd", "customers", "median_amount", "country", { size: "avg_amount" }),
];
const GRAIN = [
  {
    type: "line",
    id: "trend",
    metrics: ["revenue"],
    grain: "month",
    grains: ["week", "month", "quarter"],
  },
  S("g_basic", "paid_orders", "aov", "country", { size: "revenue" }),
];
const LATEST = [
  S("l_basic", "paid_orders", "aov", "country", { size: "revenue" }),
  S("l_mixed", "sessions", "revenue", "country"),
];
const COMMON = [
  S("c_basic", "paid_orders", "aov", "country", { size: "revenue" }),
  S("c_mixed", "sessions", "revenue", "country"),
];
const MTD_SCATTERS = [
  S("m_store", "store_tx", "store_sales", "country"),
  S("m_kiosk", "kiosk_tx", "kiosk_sales", "country"),
  S("m_mixed", "kiosk_tx", "revenue", "country"),
  S("m_sessions", "sessions", "revenue", "country", { size: "paid_orders" }),
];
const MTD = [
  ...MTD_SCATTERS,
  { type: "pie", id: "m_pie_kiosk", metric: "kiosk_sales", by: "country" },
  { type: "table", id: "m_table_kiosk", metrics: ["kiosk_tx", "kiosk_sales"], by: ["country"] },
];
const CHECKS = [
  S("same_xy", "revenue", "revenue", "country"),
  S("size_x", "revenue", "aov", "country", { size: "revenue" }),
  S("size_y", "revenue", "aov", "country", { size: "aov" }),
  S("clean", "revenue", "aov", "country", { size: "paid_orders" }),
  S("unknown_size", "revenue", "aov", "country", { size: "nope" }),
  S("narrow", "revenue", "aov", "country", { span: 2 }),
];
const DASHBOARDS: Record<string, unknown> = {
  main: { title: "Main", period: YTD, blocks: MAIN },
  ties: { title: "Ties", period: YTD, filters: [sel("c", "country", TIE_KEYS)], blocks: TIES },
  channel: {
    title: "Channel",
    period: YTD,
    filters: [sel("ch", "channel", "Marketplace")],
    blocks: CHANNEL,
  },
  channel_mixed: {
    title: "Channel mixed",
    period: YTD,
    filters: [sel("ch", "channel", "Marketplace")],
    blocks: [S("f_mixed", "sessions", "revenue", "country")],
  },
  bycol: {
    title: "By column filter",
    period: YTD,
    filters: [sel("c", "country", BYCOL)],
    blocks: [S("b_basic", "paid_orders", "aov", "country", { size: "revenue" })],
  },
  grain: {
    title: "Grain",
    period: { ...YTD, compare: "previous_year" },
    filters: [
      { type: "grain", id: "g", options: ["week", "month", "quarter"], default: "quarter" },
    ],
    blocks: GRAIN,
  },
  period: {
    title: "Period",
    period: YTD,
    filters: [
      {
        type: "period",
        id: "p",
        options: ["year_to_date", "last_30_days"],
        default: "last_30_days",
      },
    ],
    blocks: [S("p_basic", "paid_orders", "aov", "country", { size: "revenue" })],
  },
  latest: {
    title: "Latest",
    period: { asOf: "latest_data", range: "year_to_date", compare: "none" },
    blocks: LATEST,
  },
  common: {
    title: "Common",
    period: { asOf: "latest_common_data", range: "year_to_date", compare: "none" },
    blocks: COMMON,
  },
  mtd: {
    title: "Month to date",
    period: { asOf: "2026-06-30", range: "month_to_date", compare: "none" },
    blocks: MTD,
  },
  checks: { title: "Checks", period: YTD, blocks: CHECKS },
};

type Table = "o" | "s" | "st" | "k";
interface Leaf {
  t: Table;
  agg: string;
  f?: string;
  add: boolean;
  sum?: boolean;
  sqlFilter?: boolean;
}
type Def = Leaf | { ratio: [string, string] };
const PAID = "status = 'paid'";
const MDEF: Record<string, Def> = {
  revenue: { t: "o", agg: "sum(amount)", f: PAID, add: true, sum: true },
  net: { t: "o", agg: "sum(amount)", add: true, sum: true },
  paid_orders: { t: "o", agg: "count(order_id)", f: PAID, add: true },
  orders_all: { t: "o", agg: "count(*)", add: true },
  refunds_n: { t: "o", agg: "count(*)", f: "status = 'refund'", add: true },
  items: { t: "o", agg: "sum(quantity)", f: PAID, add: true, sum: true },
  customers: { t: "o", agg: "count(DISTINCT customer_id)", add: false },
  paid_customers: {
    t: "o",
    agg: "count(DISTINCT customer_id)",
    f: PAID,
    add: false,
    sqlFilter: true,
  },
  avg_amount: { t: "o", agg: "avg(amount)", add: false },
  median_amount: { t: "o", agg: "median(CAST(amount AS DOUBLE))", add: false },
  max_amount: { t: "o", agg: "max(amount)", add: false },
  spread: { t: "o", agg: "(max(amount) - min(amount))", add: false },
  sessions: { t: "s", agg: "sum(sessions)", add: true, sum: true },
  store_sales: { t: "st", agg: "sum(amount)", add: true, sum: true },
  kiosk_sales: { t: "k", agg: "sum(amount)", add: true, sum: true },
  kiosk_tx: { t: "k", agg: "count(*)", add: true },
  store_tx: { t: "st", agg: "count(*)", add: true },
  aov: { ratio: ["revenue", "paid_orders"] },
  price_per_item: { ratio: ["revenue", "items"] },
  refund_rate: { ratio: ["refunds_n", "orders_all"] },
  conversion: { ratio: ["paid_orders", "sessions"] },
};
const defOf = (m: string): Def => {
  const d = MDEF[m];
  if (d === undefined) throw new Error(`no oracle definition for ${m}`);
  return d;
};
const tablesOf = (m: string): Table[] => {
  const d = defOf(m);
  return "ratio" in d ? d.ratio.flatMap(tablesOf) : [d.t];
};
const LOCAL_OF: Record<Table, string> = {
  o: "(ts AT TIME ZONE 'America/New_York')",
  s: "CAST(d AS TIMESTAMP)",
  st: "(ts AT TIME ZONE 'America/New_York')",
  k: "(ts AT TIME ZONE 'America/New_York')",
};
const minDate = (...d: string[]) => [...d].sort()[0] ?? "";
const addDays = (d: string, n: number) =>
  new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400e3).toISOString().slice(0, 10);

interface Period {
  start: (end: string) => string;
  asOfNext: string;
  toDate: boolean;
}
interface Window {
  start: string;
  end: string;
  endAt?: string;
}
interface Expected {
  window: Window;
  points: { key: Key; x: number | null; y: number | null; size?: number | null }[];
  omittedPoints: number;
  omittedCategories: number;
}

let oracle: Oracle;
let project: Awaited<ReturnType<typeof writeProject>>;
let H: Record<Table, string>;
let main: Built;

async function perKey(
  m: string,
  by: string,
  w: Window,
  filters: Partial<Record<Table, string>>,
): Promise<Map<string, number | null>> {
  const def = defOf(m);
  if ("ratio" in def) {
    const [n, d] = def.ratio;
    const a = await perKey(n, by, w, filters);
    const b = await perKey(d, by, w, filters);
    const zero = (x: string) => {
      const dx = defOf(x);
      return !("ratio" in dx) && dx.add ? 0 : null;
    };
    const out = new Map<string, number | null>();
    for (const k of new Set([...a.keys(), ...b.keys()])) {
      const nv = a.has(k) ? (a.get(k) ?? null) : zero(n);
      const dv = b.has(k) ? (b.get(k) ?? null) : zero(d);
      out.set(k, nv === null || dv === null || dv === 0 ? null : nv / dv);
    }
    return out;
  }
  const local = LOCAL_OF[def.t];
  const base = filters[def.t] ?? "TRUE";
  const f = base + (def.f ? ` AND ${def.f}` : "");
  const value = def.f ? def.agg.replace(/\)$/, `) FILTER (WHERE ${f})`) : def.agg;
  const out = new Map<string, number | null>();
  for (const r of await oracle.rows(
    `SELECT ${by} AS k, count(*) FILTER (WHERE ${f}) AS n, ${value} AS v FROM ${def.t} WHERE ${local} >= TIMESTAMP '${w.start}' AND ${local} < TIMESTAMP '${w.endAt ?? w.end}' AND ${base} GROUP BY 1`,
  )) {
    const v =
      Number(r.n) === 0
        ? def.add
          ? 0
          : def.sqlFilter
            ? Number(r.v)
            : null
        : r.v === null
          ? def.sum
            ? 0
            : null
          : Number(r.v);
    out.set(JSON.stringify(r.k ?? null), v);
  }
  return out;
}

const desc = (a: number | null | undefined, b: number | null | undefined) =>
  a === b ? 0 : a === null || a === undefined ? 1 : b === null || b === undefined ? -1 : b - a;
const folded = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
const keyOrder = (a: Key, b: Key) =>
  a === b
    ? 0
    : a === null
      ? 1
      : b === null
        ? -1
        : typeof a !== typeof b
          ? typeof a < typeof b
            ? -1
            : 1
          : typeof a === "string" && typeof b === "string" && folded(a) !== folded(b)
            ? folded(a) < folded(b)
              ? -1
              : 1
            : a < b
              ? -1
              : 1;

function windowOf(period: Period, horizon: string): Window {
  const lastDay = minDate(horizon.slice(0, 10), period.asOfNext);
  const start = period.start(lastDay);
  if (!period.toDate || horizon >= period.asOfNext) return { start, end: lastDay };
  if (horizon <= start) return { start, end: start };
  if (horizon.endsWith(" 00:00:00.000000")) return { start, end: horizon.slice(0, 10) };
  return { start, end: addDays(horizon.slice(0, 10), 1), endAt: horizon.replace(" ", "T") };
}

async function expected(
  block: ScatterBlock,
  period: Period,
  filters: Partial<Record<Table, string>> = {},
): Promise<Expected> {
  const ms = [...new Set([block.x, block.y, ...(block.size ? [block.size] : [])])];
  const window = windowOf(period, minDate(...ms.flatMap(tablesOf).map((t) => H[t])));
  if (window.start >= window.end)
    return { window, points: [], omittedPoints: 0, omittedCategories: 0 };
  const vals = new Map<string, Map<string, number | null>>();
  for (const m of ms) vals.set(m, await perKey(m, block.by, window, filters));
  const keys = new Set<string>();
  for (const v of vals.values()) for (const k of v.keys()) keys.add(k);
  const fill = (m: string, k: string) => {
    const v = vals.get(m)?.get(k);
    if (v !== undefined) return v;
    const d = defOf(m);
    return !("ratio" in d) && d.add ? 0 : null;
  };
  const all = [...keys].map((k) => ({
    key: JSON.parse(k) as Key,
    x: fill(block.x, k),
    y: fill(block.y, k),
    ...(block.size ? { size: fill(block.size, k) } : {}),
  }));
  const placed = all.filter((p) => p.x !== null && p.y !== null);
  placed.sort(
    (a, b) => desc(block.size ? a.size : a.y, block.size ? b.size : b.y) || keyOrder(a.key, b.key),
  );
  const limit = block.limit ?? 500;
  return {
    window,
    points: placed.slice(0, limit),
    omittedPoints: all.length - placed.length,
    omittedCategories: placed.length - Math.min(limit, placed.length),
  };
}
const ytd = (asOfNext: string): Period => ({
  start: () => "2026-01-01",
  asOfNext,
  toDate: true,
});

const close = (a: unknown, e: number | null | undefined, tol = 1e-9) =>
  e === null || e === undefined
    ? a === null || a === undefined
    : typeof a === "number" && Math.abs(a - e) <= tol * Math.max(1, Math.abs(e));
const fmt = (p: { key: Key; x: unknown; y: unknown; size?: unknown }) =>
  `${JSON.stringify(p.key)}(${[p.x, p.y, p.size].map((v) => (typeof v === "number" ? +v.toFixed(4) : v)).join(",")})`;
const blockOf = (d: DashboardData | undefined, id: string) =>
  d?.blocks.find((b) => b.id === id) as ScatterData | undefined;
const diagsAt = (res: Built, blocks: { id: string }[], id: string) => {
  const p = `/blocks/${blocks.findIndex((b) => b.id === id)}`;
  return res.diagnostics.filter((d) => d.pointer === p || d.pointer?.startsWith(`${p}/`));
};

function compare(
  got: ScatterData | undefined,
  exp: Expected,
  diags: Diagnostic[],
  expectCap: boolean,
): string[] {
  if (got === undefined) return ["block missing from DashboardData"];
  const bad: string[] = [];
  const same = (i: number) => {
    const p = got.points[i];
    const e = exp.points[i];
    return (
      p !== undefined &&
      e !== undefined &&
      JSON.stringify(p.key) === JSON.stringify(e.key) &&
      close(p.x, e.x) &&
      close(p.y, e.y) &&
      (e.size === undefined ? p.size === undefined : close(p.size, e.size))
    );
  };
  if (got.points.length !== exp.points.length || !got.points.every((_, i) => same(i))) {
    let j = 0;
    while (same(j)) j++;
    const g = got.points[j];
    const e = exp.points[j];
    bad.push(
      `points n=${got.points.length} vs ${exp.points.length}; first diff at ${j}: engine ${g ? fmt(g) : "-"} sql ${e ? fmt(e) : "-"}`,
    );
  }
  if ((got.omittedPoints ?? 0) !== exp.omittedPoints)
    bad.push(`omittedPoints ${got.omittedPoints ?? 0} vs ${exp.omittedPoints}`);
  if ((got.omittedCategories ?? 0) !== exp.omittedCategories)
    bad.push(`omittedCategories ${got.omittedCategories ?? 0} vs ${exp.omittedCategories}`);
  if (exp.points.length > 0 && JSON.stringify(got.window) !== JSON.stringify(exp.window))
    bad.push(`window ${JSON.stringify(got.window)} vs ${JSON.stringify(exp.window)}`);
  const codes = diags.map((d) => d.code);
  if (codes.includes("HM4070") !== exp.omittedPoints > 0) bad.push(`HM4070 ${codes}`);
  const negSize = exp.points.some((p) => typeof p.size === "number" && p.size < 0);
  if (codes.includes("HM4071") !== negSize) bad.push(`HM4071 ${codes}`);
  if (codes.includes("HM5022") !== expectCap) bad.push(`HM5022 ${codes}`);
  const msg = diags.find((d) => d.code === "HM5022")?.message;
  if (expectCap && !msg?.includes(` ${exp.omittedCategories} left out`))
    bad.push(`HM5022 message ${msg}`);
  return bad;
}

async function checkCase(
  name: string,
  blocks: { id: string; type: string }[],
  period: Period,
  filters: Partial<Record<Table, string>> = {},
  res?: Built,
): Promise<{ res: Built; bad: Record<string, string[]> }> {
  const built = res ?? (await run(project.root, project.project, name));
  const bad: Record<string, string[]> = {};
  for (const b of blocks) {
    if (b.type !== "scatter") continue;
    const block = b as ScatterBlock;
    const exp = await expected(block, period, filters);
    const cap = block.limit === undefined && exp.omittedCategories > 0;
    const problems = compare(blockOf(built.data, b.id), exp, diagsAt(built, blocks, b.id), cap);
    if (problems.length > 0) bad[b.id] = problems;
  }
  return { res: built, bad };
}

function sectionOf(html: string, id: string): string | undefined {
  const at = html.indexOf(`aria-labelledby="hm-${id}-t"`);
  if (at < 0) return undefined;
  return html.slice(html.lastIndexOf("<section", at), html.indexOf("</section>", at));
}
function renderProblems(d: DashboardData): string[] {
  const html = renderFragment(d);
  const bad: string[] = [];
  for (const blk of d.blocks.filter((b): b is ScatterData => b.type === "scatter")) {
    const part = sectionOf(html, blk.id);
    if (part === undefined) {
      bad.push(`${blk.id}: no section`);
      continue;
    }
    const n = blk.points.length;
    const sub = /<p>(.*?)<\/p>/.exec(part)?.[1] ?? "";
    if (n === 0) {
      if (!/No data|no complete day/i.test(part)) bad.push(`${blk.id}: empty scatter says ${sub}`);
      continue;
    }
    const json = JSON.parse(
      /<script type="application\/json">(.*?)<\/script>/s.exec(part)?.[1] ?? "null",
    );
    const byLabel = new Map(blk.points.map((p) => [p.label, p]));
    const drawn = ((json?.headers ?? []) as string[]).map((h) => byLabel.get(h));
    const series = (json?.series ?? []) as { v: unknown[] }[];
    const tipOk =
      drawn.length === n &&
      drawn.every((p) => p !== undefined) &&
      (series[0]?.v ?? []).every((v, i) => v === drawn[i]?.x) &&
      (series[1]?.v ?? []).every((v, i) => v === drawn[i]?.y) &&
      (blk.size === undefined
        ? series.length === 2
        : (series[2]?.v ?? []).every((v, i) => v === drawn[i]?.size)) &&
      drawn.every((p, i) => i === 0 || Number(drawn[i - 1]?.x) <= Number(p?.x));
    if (!tipOk) {
      bad.push(`${blk.id}: tooltip JSON is not DashboardData left to right`);
      continue;
    }
    const ths = [...part.matchAll(/<th scope="row">(.*?)<\/th>/g)].map((m) =>
      (m[1] ?? "").replaceAll("&#39;", "'").replaceAll("&amp;", "&"),
    );
    if (ths.length !== n) bad.push(`${blk.id}: hidden table has ${ths.length} rows vs ${n}`);
    const svgs = [...part.matchAll(/<svg[^>]*data-hm-plot="([^"]+)"[^>]*data-hm-pts="([^"]*)"/g)];
    if (svgs.length === 0) bad.push(`${blk.id}: no plot`);
    for (const [, plot = "", ptsAttr = ""] of FULL ? svgs : svgs.slice(0, 1)) {
      const [x0 = 0, y0 = 0, x1 = 0, y1 = 0] = plot.split(",").map(Number);
      const tag = `${blk.id} @${Math.round(x1)}px`;
      const pts = ptsAttr
        .split(",")
        .filter(Boolean)
        .map((t) => {
          const [cx = 0, cy = 0, r = 0] = t.trim().split(/\s+/).map(Number);
          return { cx, cy, r };
        });
      if (pts.length !== n) {
        bad.push(`${tag}: ${pts.length} drawn points vs ${n}`);
        continue;
      }
      if (
        !pts.every(
          (p) => p.cx >= x0 - 0.5 && p.cx <= x1 + 0.5 && p.cy >= y0 - 0.5 && p.cy <= y1 + 0.5,
        )
      )
        bad.push(`${tag}: a point outside the plot`);
      const linear = (key: "x" | "y", c: "cx" | "cy") => {
        const vals = drawn.map((p) => Number(p?.[key]));
        const lo = vals.indexOf(Math.min(...vals));
        const hi = vals.indexOf(Math.max(...vals));
        const at = (i: number) => pts[i]?.[c] ?? Number.NaN;
        if (vals[lo] === vals[hi]) return pts.every((p) => Math.abs(p[c] - at(0)) < 0.2);
        const slope = (at(hi) - at(lo)) / (Number(vals[hi]) - Number(vals[lo]));
        return (
          pts.every(
            (p, i) =>
              Math.abs(p[c] - (at(lo) + slope * (Number(vals[i]) - Number(vals[lo])))) <= 0.15,
          ) && (c === "cx" ? slope > 0 : slope < 0)
        );
      };
      if (!linear("x", "cx")) bad.push(`${tag}: cx not linear and increasing in x`);
      if (!linear("y", "cy")) bad.push(`${tag}: cy not linear and decreasing in y`);
      if (blk.size !== undefined) {
        const sizes = drawn.map((p) => (typeof p?.size === "number" ? p.size : null));
        const max = Math.max(0, ...sizes.map((s) => s ?? 0));
        const rmax = Math.max(...pts.map((p) => p.r));
        const rmin = Math.min(...pts.map((p) => p.r));
        const radiusOk = sizes.every((s, i) => {
          const r = pts[i]?.r ?? Number.NaN;
          if (s === null || s <= 0 || max <= 0) return Math.abs(r - rmin) < 0.06;
          return Math.abs(r - Math.max(rmin, rmax * Math.sqrt(s / max))) <= 0.06;
        });
        if (!radiusOk) bad.push(`${tag}: radius not sqrt of size (r ${rmin}..${rmax})`);
      }
    }
    if (blk.omittedCategories && !sub.includes(`top ${n} of ${n + blk.omittedCategories}`))
      bad.push(`${blk.id}: subtitle "${sub}" lacks top N of M`);
    if (blk.omittedPoints && !sub.includes(`${blk.omittedPoints} without data`))
      bad.push(`${blk.id}: subtitle "${sub}" lacks K without data`);
  }
  return bad;
}

const inList = (keys: string[]) => `country IN (${keys.map((k) => `'${k}'`).join(", ")})`;

beforeAll(async () => {
  oracle = await Oracle.open();
  project = await writeProject({
    "hatchmark.yaml": CONFIG,
    ...data(),
    ...Object.fromEntries(Object.entries(METRICS).map(([n, m]) => [`metrics/${n}.yaml`, m])),
    ...Object.fromEntries(Object.entries(DASHBOARDS).map(([n, d]) => [`dashboards/${n}.yaml`, d])),
  });
  const csv = (f: string) =>
    `read_csv('${path.join(project.root, "data", f).replaceAll("'", "''")}', all_varchar = true)`;
  await oracle.run(
    `CREATE TABLE o AS SELECT CAST(order_id AS INTEGER) AS order_id, CAST(ordered_at AS TIMESTAMPTZ) AS ts, NULLIF(country, '') AS country, NULLIF(channel, '') AS channel, status, CAST(NULLIF(amount, '') AS DECIMAL(18,2)) AS amount, CAST(NULLIF(quantity, '') AS BIGINT) AS quantity, customer_id, CAST(cohort AS BIGINT) AS cohort, acct500, acct501 FROM ${csv("orders.csv")}`,
  );
  await oracle.run(
    `CREATE TABLE s AS SELECT CAST(session_date AS DATE) AS d, NULLIF(country, '') AS country, CAST(sessions AS BIGINT) AS sessions FROM ${csv("sessions.csv")}`,
  );
  for (const [t, f] of [
    ["k", "kiosk.csv"],
    ["st", "store.csv"],
  ] as const)
    await oracle.run(
      `CREATE TABLE ${t} AS SELECT CAST(sold_at AS TIMESTAMPTZ) AS ts, NULLIF(country, '') AS country, CAST(amount AS DECIMAL(18,2)) AS amount FROM ${csv(f)}`,
    );
  const after = (t: string) =>
    `strftime((SELECT max(ts) + INTERVAL 1 MICROSECOND FROM ${t}) AT TIME ZONE 'America/New_York', '%Y-%m-%d %H:%M:%S.%f')`;
  const [h] = await oracle.rows(
    `SELECT ${after("o")} AS o, strftime(CAST((SELECT max(d) FROM s) + 1 AS TIMESTAMP), '%Y-%m-%d %H:%M:%S.%f') AS s, ${after("st")} AS st, ${after("k")} AS k`,
  );
  H = { o: String(h?.o), s: String(h?.s), st: String(h?.st), k: String(h?.k) };
  main = await run(project.root, project.project, "main");
}, 120_000);
afterAll(async () => {
  oracle.close();
  await removeProjects();
});

describe("scatter against a SQL oracle", () => {
  it("the oracle's hand-computed horizons match the data", () => {
    expect(H).toEqual({
      o: "2026-06-28 14:03:00.000001",
      s: "2026-04-16 00:00:00.000000",
      st: "2026-05-01 00:00:00.000001",
      k: "2026-06-01 10:00:00.000001",
    });
  });

  it("check: HM5020 for x = y, HM5021 for size = x or y, an unknown size is an error, span 2 is HM2024", () => {
    const diags = [...project.diagnostics, ...checkReferences(project.project)].filter((d) =>
      d.file?.endsWith("checks.yaml"),
    );
    const codes = (id: string) => {
      const p = `/blocks/${CHECKS.findIndex((b) => b.id === id)}`;
      return diags
        .filter((d) => d.pointer === p || d.pointer?.startsWith(`${p}/`))
        .map((d) => `${d.code}:${d.severity}`);
    };
    expect(codes("same_xy")).toContain("HM5020:warning");
    expect(codes("size_x")).toContain("HM5021:warning");
    expect(codes("size_y")).toContain("HM5021:warning");
    expect(codes("clean")).toEqual([]);
    expect(codes("unknown_size").some((c) => c.endsWith(":error"))).toBe(true);
    expect(codes("narrow").some((c) => c.startsWith("HM2024"))).toBe(true);
  });

  it("main: every scatter's points, order, limit, cap, window and warnings match SQL", async () => {
    expect(main.data).toBeDefined();
    const { bad } = await checkCase("main", MAIN, ytd("2026-07-01"), {}, main);
    expect(bad).toEqual({});
  });

  it("main: window edges, today's partial day, a ratio of sums, refunds-only, the null group, a newest value at midnight", () => {
    const basic = blockOf(main.data, "basic");
    const pt = (b: ScatterData | undefined, k: Key) => b?.points.find((p) => p.key === k);
    expect(pt(basic, "Edgeland")?.size).toBe(320003);
    expect(basic?.window).toEqual({
      start: "2026-01-01",
      end: "2026-06-29",
      endAt: "2026-06-28T14:03:00.000001",
    });
    const us = pt(basic, "United States");
    expect(Math.abs(Number(us?.y) - Number(us?.size) / Number(us?.x))).toBeLessThan(1e-9);
    expect(pt(basic, "Iceland")).toBeUndefined();
    expect(basic?.omittedPoints ?? 0).toBeGreaterThanOrEqual(1);
    expect(pt(basic, null)?.label).toBe("(empty)");
    expect(pt(blockOf(main.data, "store_mid"), "Edgeland")?.y).toBe(4003);
    expect(blockOf(main.data, "store_mid")?.window).toEqual({
      start: "2026-01-01",
      end: "2026-05-02",
      endAt: "2026-05-01T00:00:00.000001",
    });
    expect(blockOf(main.data, "mixed_sources")?.window).toEqual({
      start: "2026-01-01",
      end: "2026-04-16",
    });
  });

  it("ties: equal sizes break by key before the limit, with or without size", async () => {
    const filter = inList(TIE_KEYS);
    const { res, bad } = await checkCase("ties", TIES, ytd("2026-07-01"), { o: filter, s: filter });
    expect(bad).toEqual({});
    expect(blockOf(res.data, "ties")?.points.map((p) => p.key)).toEqual(["TieA", "TieB"]);
  });

  it("filters: a select on another column, a multi-select on the by column, and HM2013", async () => {
    expect(
      (await checkCase("channel", CHANNEL, ytd("2026-07-01"), { o: "channel = 'Marketplace'" }))
        .bad,
    ).toEqual({});
    const filter = inList(BYCOL);
    const bycol = await checkCase(
      "bycol",
      [S("b_basic", "paid_orders", "aov", "country", { size: "revenue" })],
      ytd("2026-07-01"),
      { o: filter, s: filter, st: filter },
    );
    expect(bycol.bad).toEqual({});
    const mixed = await run(project.root, project.project, "channel_mixed");
    expect(mixed.diagnostics.some((d) => d.code === "HM2013" && d.severity === "error")).toBe(true);
  });

  it("a grain filter with compare previous_year leaves the scatter unchanged", async () => {
    const { res, bad } = await checkCase("grain", GRAIN, ytd("2026-07-01"));
    expect(bad).toEqual({});
    expect(blockOf(res.data, "g_basic")?.points).toEqual(blockOf(main.data, "basic")?.points);
  });

  it("periods: a last_30_days period filter default, latest_data and latest_common_data", async () => {
    const last30: Period = {
      start: (end) => addDays(end, -30),
      asOfNext: "2026-07-01",
      toDate: false,
    };
    expect(
      (
        await checkCase(
          "period",
          [S("p_basic", "paid_orders", "aov", "country", { size: "revenue" })],
          last30,
        )
      ).bad,
    ).toEqual({});
    expect((await checkCase("latest", LATEST, ytd("2026-06-29"))).bad).toEqual({});
    expect((await checkCase("common", COMMON, ytd("2026-04-16"))).bad).toEqual({});
  });

  it("month to date in June: sources that end before June empty the scatter (HM4013); one that has only today's partial day plots it", async () => {
    const mtd: Period = { start: () => "2026-06-01", asOfNext: "2026-07-01", toDate: true };
    const { res, bad } = await checkCase("mtd", MTD, mtd);
    expect(bad).toEqual({});
    for (const id of ["m_kiosk", "m_mixed"]) {
      const blk = blockOf(res.data, id);
      expect(blk?.window, id).toEqual({
        start: "2026-06-01",
        end: "2026-06-02",
        endAt: "2026-06-01T10:00:00.000001",
      });
      expect(blk?.empty, id).toBeUndefined();
      expect(blk?.points.find((p) => p.key === "Edgeland")?.x, id).toBe(1);
    }
    expect(blockOf(res.data, "m_kiosk")?.points.map((p) => [p.key, p.y])).toEqual([
      ["Edgeland", 11],
    ]);
    for (const id of ["m_store", "m_sessions"]) {
      const blk = blockOf(res.data, id);
      expect(blk?.points, id).toEqual([]);
      expect(blk?.window, id).toBeUndefined();
      expect(blk?.empty, id).toBe("no_data");
      expect(
        diagsAt(res, MTD, id).map((d) => d.code),
        id,
      ).toContain("HM4013");
    }
    expect(res.diagnostics.map((d) => d.code)).not.toContain("HM4024");
    if (res.data === undefined) throw new Error("mtd did not build");
    expect(renderProblems(res.data)).toEqual([]);
    const html = renderFragment(res.data);
    for (const id of ["m_store", "m_sessions"])
      expect(sectionOf(html, id), id).toContain("No data in this period");
  });

  it("the renderer: tooltip JSON, hidden table, linear axes, sqrt radius and the subtitle counts", () => {
    if (main.data === undefined) throw new Error("main did not build");
    expect(renderProblems(main.data)).toEqual([]);
  });
});
