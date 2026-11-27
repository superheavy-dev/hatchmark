import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { run as cli } from "../../src/cli/main.js";
import type { DashboardData, PieData } from "../../src/compiler/dashboard-data.js";
import type { Diagnostic } from "../../src/diagnostics/diagnostic.js";
import { renderFragment } from "../../src/render/page.js";
import { checkReferences } from "../../src/spec/index.js";
import { Oracle, removeProjects, run, writeProject } from "./fixture.js";

type Key = string | number | boolean | null;
type Built = Awaited<ReturnType<typeof run>>;

const FULL = process.env.HM_SWEEP === "full";
const TZ = "America/New_York";

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
  "United Kingdom",
  "Canada",
  "Germany",
  "Australia",
  "France",
  "Japan",
  "Mexico",
  "Netherlands",
  "Brazil",
  "India",
  "",
];
const CHANNELS = ["Online store", "Marketplace", "Retail partners", "Wholesale"];
const DEVICES = ["Desktop", "Mobile", "Tablet", "Smart TV", "Console", "Watch", "Car", "Kiosk"];

// Amounts are multiples of $0.25, so every sum is exact in a double and ties are real ties.
function data(): Record<string, string> {
  const rand = rng(60);
  const quarter = (lo: number, hi: number) =>
    (Math.round((lo + rand() * (hi - lo)) * 4) / 4).toFixed(2);
  const ord = [
    "order_id,ordered_at,country,channel,device,status,amount,customer_id,store_id,is_mobile",
  ];
  const push = (
    at: string,
    country: string,
    channel: string,
    device: string,
    status: string,
    amount: string,
  ) => {
    const customer = `c${Math.floor(rand() * 90)}`;
    const store = 1 + Math.floor(rand() * 9);
    const mobile = device === "Mobile" ? "true" : "false";
    ord.push(
      [ord.length - 1, at, country, channel, device, status, amount, customer, store, mobile].join(
        ",",
      ),
    );
  };
  for (let i = 0; i < 1800; i++) {
    const t =
      Date.UTC(2026, 0, 1) + Math.floor(rand() * (Date.UTC(2026, 10, 25) - Date.UTC(2026, 0, 1)));
    const at = `${new Date(t).toISOString().slice(0, 19)}Z`;
    const country = COUNTRIES[Math.floor(rand() ** 1.6 * COUNTRIES.length)] ?? "";
    const channel = CHANNELS[Math.floor(rand() ** 1.3 * CHANNELS.length)] ?? "";
    const device = DEVICES[Math.floor(rand() ** 2 * DEVICES.length)] ?? "";
    const refund = rand() < (channel === "Wholesale" ? 0.6 : 0.1);
    const amount = `${refund ? "-" : ""}${quarter(10, 250)}`;
    push(at, country, channel, device, refund ? "refunded" : "paid", amount);
  }
  push("2026-11-10T15:00:00Z", "Zeroland", "Online store", "Desktop", "paid", "120.00");
  push("2026-11-11T15:00:00Z", "Zeroland", "Online store", "Desktop", "refunded", "-120.00");
  push("2026-11-12T15:00:00Z", "Refundia", "Marketplace", "Desktop", "refunded", "-80.00");
  push("2026-11-12T16:00:00Z", "Refundia", "Marketplace", "Desktop", "refunded", "-45.50");
  push("2026-11-26T12:00:00Z", "Lateland", "Online store", "Desktop", "paid", "5000.00");
  push("2026-11-01T03:59:00Z", "Edgeland", "Online store", "Desktop", "paid", "1000.00");
  push("2026-11-01T04:00:00Z", "Edgeland", "Online store", "Desktop", "paid", "1.00");
  push("2026-11-01T05:30:00Z", "Edgeland", "Online store", "Desktop", "paid", "2.00");
  push("2026-11-01T06:30:00Z", "Edgeland", "Online store", "Desktop", "paid", "4.00");
  push("2026-11-26T04:59:00Z", "Edgeland", "Online store", "Desktop", "paid", "8.00");
  push("2026-11-26T05:00:00Z", "Edgeland", "Online store", "Desktop", "paid", "16.00");
  push("2026-11-26T19:03:00Z", "United States", "Online store", "Desktop", "paid", "33.25");

  const ret = ["returned_on,country,amount"];
  for (let i = 0; i < 400; i++) {
    const d = new Date(Date.UTC(2026, 0, 1) + Math.floor(rand() * 324) * 86400e3)
      .toISOString()
      .slice(0, 10);
    ret.push([d, COUNTRIES[Math.floor(rand() ** 1.4 * 11)], quarter(5, 60)].join(","));
  }
  ret.push("2026-11-20,Iceland,40.00", "2026-11-20,Canada,12.50");

  const ties = ["at,cat,amount"];
  for (const [cat, amount] of [
    ["Alpha", "50"],
    ["Bravo", "40"],
    ["Zulu", "30"],
    ["alpha", "30"],
    ["Charlie", "30"],
    ["", "30"],
    ["Delta", "10"],
    ["Echo", "0"],
    ["Foxtrot", "-5"],
  ])
    ties.push(`2026-11-05T15:00:00Z,${cat},${amount}`);
  ties.push("2026-11-26T19:03:00Z,Alpha,1");

  const early = [
    "at,cat,amount",
    "2026-10-30T15:00:00Z,Alpha,10",
    "2026-10-31T15:00:00Z,Bravo,20",
    "2026-11-01T14:00:00Z,Alpha,5",
  ];

  const bal = ["snap_date,region,account_id,balance"];
  for (let d = 1; d <= 25; d++)
    for (const [region, n, stop] of [
      ["North America", 3, 25],
      ["Europe", 2, 20],
      ["Asia-Pacific", 2, 24],
    ] as const) {
      if (d > stop) continue;
      for (let a = 0; a < n; a++) {
        const balance = (1000 + d * 10 + a * 100).toFixed(2);
        bal.push(`2026-11-${pad(d)},${region},${region.slice(0, 2)}${a},${balance}`);
      }
    }

  const csv = (lines: string[]) => `${lines.join("\n")}\n`;
  return {
    "data/orders.csv": csv(ord),
    "data/returns.csv": csv(ret),
    "data/ties.csv": csv(ties),
    "data/balances.csv": csv(bal),
    "data/early.csv": csv(early),
  };
}

const CONFIG = {
  version: 1,
  name: "Pies",
  dataDir: "data",
  metricsDir: "metrics",
  dashboardsDir: "dashboards",
  outDir: "dist",
  locale: "en-US",
  currency: "USD",
  timezone: TZ,
  weekStart: "sunday",
  theme: "default",
  telemetry: false,
  sources: Object.fromEntries(
    ["orders", "returns", "ties", "early", "balances"].map((s) => [
      s,
      { type: "csv", path: `data/${s}.csv` },
    ]),
  ),
};

const usd = { type: "currency", currency: "USD" };
const num = { type: "number" };
const M = (label: string, body: Record<string, unknown>, format: unknown = usd) => ({
  label,
  format,
  better: "up",
  ...body,
});
const O = (label: string, body: Record<string, unknown>, format?: unknown) =>
  M(label, { type: "aggregate", table: "orders", time: "ordered_at", ...body }, format);
const paid = [{ column: "status", op: "eq", value: "paid" }];
const METRICS: Record<string, unknown> = {
  revenue: O("Revenue", { aggregate: "sum", column: "amount", filters: paid }),
  net: O("Net revenue", { aggregate: "sum", column: "amount" }),
  orders: O("Orders", { aggregate: "count" }, num),
  refunds_n: O(
    "Refunds",
    { aggregate: "count", filters: [{ column: "status", op: "eq", value: "refunded" }] },
    num,
  ),
  sql_net: M("SQL net", {
    type: "sql",
    table: "orders",
    time: "ordered_at",
    sql: "sum(amount) FILTER (WHERE channel <> 'Wholesale')",
    additive: true,
  }),
  double_rev: M("Double revenue", { type: "formula", expr: "revenue * 2" }),
  returns_amt: M("Returns", {
    type: "aggregate",
    table: "returns",
    time: "returned_on",
    aggregate: "sum",
    column: "amount",
  }),
  rev_less_returns: M("Revenue less returns", { type: "formula", expr: "revenue - returns_amt" }),
  early_amt: M("Early amount", {
    type: "aggregate",
    table: "early",
    time: "at",
    aggregate: "sum",
    column: "amount",
  }),
  tie_amt: M("Tie amount", {
    type: "aggregate",
    table: "ties",
    time: "at",
    aggregate: "sum",
    column: "amount",
  }),
  customers: O("Customers", { aggregate: "count_distinct", column: "customer_id" }, num),
  aov: O("AOV", { aggregate: "avg", column: "amount" }),
  median_amt: O("Median", { aggregate: "median", column: "amount" }),
  max_amt: O("Max", { aggregate: "max", column: "amount" }),
  min_amt: O("Min", { aggregate: "min", column: "amount" }),
  refund_rate: M(
    "Refund rate",
    { type: "ratio", numerator: "refunds_n", denominator: "orders" },
    { type: "percent" },
  ),
  return_rate: M(
    "Return rate",
    { type: "ratio", numerator: "returns_amt", denominator: "revenue" },
    { type: "percent" },
  ),
  plus_const: M("Rev + 1000", { type: "formula", expr: "revenue + 1000" }),
  per_order: M("Revenue per order", { type: "formula", expr: "revenue / orders" }),
  sql_na: M("SQL max", {
    type: "sql",
    table: "orders",
    time: "ordered_at",
    sql: "max(amount)",
    additive: false,
  }),
  bal_max: M("Balance (max)", {
    type: "aggregate",
    table: "balances",
    time: "snap_date",
    aggregate: "sum",
    column: "balance",
    over_time: "max",
  }),
};

const MTD = { asOf: "latest_data", range: "month_to_date", compare: "previous_period" };
type Block = { type: string; id: string; [k: string]: unknown };
const P = (id: string, metric: string, by: string, extra = {}): Block => ({
  type: "pie",
  id,
  metric,
  by,
  ...extra,
});
const Dn = (id: string, metric: string, by: string, extra = {}): Block => ({
  type: "donut",
  id,
  metric,
  by,
  ...extra,
});
const MAIN = [
  P("rev_country", "revenue", "country"),
  Dn("rev_country_12", "revenue", "country", { limit: 12 }),
  P("net_country", "net", "country", { limit: 6 }),
  Dn("orders_channel", "orders", "channel"),
  P("refunds_country", "refunds_n", "country", { limit: 3 }),
  P("rev_store", "revenue", "store_id", { limit: 4 }),
  Dn("rev_mobile", "revenue", "is_mobile"),
  P("rev_device_6", "revenue", "device", { limit: 6 }),
  Dn("rev_top1", "revenue", "country", { limit: 1 }),
  P("sql_net_channel", "sql_net", "channel"),
  P("edge_status", "revenue", "status"),
];
const HORIZONS = [
  P("returns_country", "returns_amt", "country"),
  Dn("rev_less_returns", "rev_less_returns", "country", { limit: 6 }),
  P("rev_country_h", "revenue", "country"),
];
const RANGES = ["last_7_days", "all_time", "last_complete_month"].concat(
  FULL ? ["last_30_days", "year_to_date", "quarter_to_date"] : [],
);
const NONADD = [
  "customers",
  "aov",
  "median_amt",
  "max_amt",
  "min_amt",
  "refund_rate",
  "return_rate",
  "plus_const",
  "per_order",
  "sql_na",
  "bal_max",
];
const ADD = ["revenue", "net", "orders", "refunds_n", "sql_net", "double_rev", "rev_less_returns"];
const CHECKS = [
  ...NONADD.map((m) => P(`p_${m}`, m, "country")),
  ...NONADD.map((m) => Dn(`d_${m}`, m, "country")),
  ...ADD.map((m) => P(`ok_${m}`, m, "country")),
  P("lim6", "revenue", "country", { limit: 6 }),
  P("lim7", "revenue", "country", { limit: 7 }),
  Dn("lim12", "revenue", "country", { limit: 12 }),
];
const sel = (id: string, column: string, value: unknown, multiple = false) => ({
  type: "select",
  id,
  column,
  ...(multiple ? { multiple } : {}),
  default: value,
});
const DASHBOARDS: Record<string, unknown> = {
  main: { title: "Main", period: MTD, blocks: MAIN },
  grain: {
    title: "Grain",
    period: MTD,
    filters: [
      { type: "grain", id: "grain", options: ["week", "month", "quarter"], default: "quarter" },
    ],
    blocks: [
      ...MAIN,
      {
        type: "bar",
        id: "trend",
        metrics: ["revenue"],
        grain: "month",
        grains: ["week", "month", "quarter"],
      },
    ],
  },
  horizons: { title: "Horizons", period: MTD, blocks: HORIZONS },
  common: {
    title: "Common",
    period: { asOf: "latest_common_data", range: "month_to_date", compare: "none" },
    blocks: [P("c_rev", "revenue", "country"), P("c_returns", "returns_amt", "country")],
  },
  ...Object.fromEntries(
    RANGES.map((range) => [
      `r_${range}`,
      {
        title: range,
        period: { asOf: "latest_data", range, compare: "none" },
        blocks: [
          P("rev", "revenue", "country"),
          Dn("net", "net", "channel"),
          P("returns", "returns_amt", "country"),
        ],
      },
    ]),
  ),
  fixed: {
    title: "Fixed as-of",
    period: { asOf: "2026-11-15", range: "month_to_date", compare: "none" },
    blocks: [P("rev", "revenue", "country"), P("returns", "returns_amt", "country")],
  },
  filters: {
    title: "Filters",
    period: MTD,
    filters: [
      sel("ch", "channel", ["Online store", "Marketplace"], true),
      sel("dev", "device", "Desktop"),
    ],
    blocks: [
      P("f_country", "revenue", "country"),
      Dn("f_net", "net", "country"),
      P("f_returns", "returns_amt", "country"),
    ],
  },
  edges: {
    title: "Edges",
    period: MTD,
    filters: [sel("c", "country", "Edgeland")],
    blocks: [P("edges", "revenue", "channel")],
  },
  self: {
    title: "Filter on by",
    period: MTD,
    filters: [sel("c", "country", "Canada")],
    blocks: [P("self", "revenue", "country")],
  },
  nothing: {
    title: "No match",
    period: MTD,
    filters: [sel("c", "country", "Atlantis")],
    blocks: [Dn("none", "revenue", "country"), P("none_pie", "revenue", "country")],
  },
  allneg: {
    title: "All negative",
    period: MTD,
    filters: [sel("c", "country", "Refundia")],
    blocks: [Dn("allneg", "net", "channel")],
  },
  early: {
    title: "No complete day",
    period: MTD,
    blocks: [Dn("early", "early_amt", "cat"), P("early_pie", "early_amt", "cat")],
  },
  ties: {
    title: "Ties",
    period: MTD,
    blocks: [
      P("t3", "tie_amt", "cat", { limit: 3 }),
      P("t2", "tie_amt", "cat", { limit: 2 }),
      Dn("t5", "tie_amt", "cat", { limit: 5 }),
      P("t12", "tie_amt", "cat", { limit: 12 }),
    ],
  },
  checks: { title: "Checks", period: MTD, blocks: CHECKS },
};

type Window = [string, string];
const day = (s: string) => s.slice(0, 10);
const addDays = (d: string, n: number) =>
  new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400e3).toISOString().slice(0, 10);
const asOfOf = (h: string) => (h.endsWith("00:00:00") ? addDays(day(h), -1) : day(h));
function rangeWindow(range: string, asOf: string, end: string): Window {
  const cap = addDays(asOf, 1) < end ? addDays(asOf, 1) : end;
  const y = asOf.slice(0, 4);
  const m = asOf.slice(5, 7);
  const monthStart = `${y}-${m}-01`;
  switch (range) {
    case "month_to_date":
      return [monthStart, cap];
    case "quarter_to_date":
      return [`${y}-${pad(Math.floor((Number(m) - 1) / 3) * 3 + 1)}-01`, cap];
    case "year_to_date":
      return [`${y}-01-01`, cap];
    case "last_7_days":
      return [addDays(cap, -7), cap];
    case "last_30_days":
      return [addDays(cap, -30), cap];
    case "all_time":
      return ["0001-01-01", cap];
    case "last_complete_month": {
      const prev = new Date(Date.UTC(Number(y), Number(m) - 2, 1)).toISOString().slice(0, 10);
      return [prev, monthStart < cap ? monthStart : cap];
    }
  }
  throw new Error(range);
}
const LOCAL = (col: string) => `(${col} AT TIME ZONE '${TZ}')`;
const tsWin = ([s, e]: Window) =>
  `${LOCAL("ts")} >= TIMESTAMP '${s}' AND ${LOCAL("ts")} < TIMESTAMP '${e}'`;
const dWin = ([s, e]: Window) => `d >= DATE '${s}' AND d < DATE '${e}'`;

const TYPE_RANK: Record<string, number> = { boolean: 0, number: 1, string: 2 };
const byKey = (a: Key, b: Key): number => {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  const ra = TYPE_RANK[typeof a] ?? 3;
  const rb = TYPE_RANK[typeof b] ?? 3;
  if (ra !== rb) return ra - rb;
  return a < b ? -1 : 1;
};

interface Cat {
  key: Key;
  v: number;
}
interface OraclePie {
  slices: Cat[];
  rest: Cat[];
  otherV: number;
  whole: number;
  total: number | null;
  neg: Cat[];
  emptyCats: Key[];
  hm5011: boolean;
  hm4061: boolean;
}

let oracle: Oracle;
let project: Awaited<ReturnType<typeof writeProject>>;
let H: { orders: string; ties: string; returns: string };
let asOfLatest: string;
let main: Built;
const end = (src: keyof typeof H) => day(H[src]);

async function oraclePie(o: {
  table: string;
  value: string;
  by: string;
  where: string;
  limit?: number;
}): Promise<OraclePie> {
  const limit = o.limit ?? 5;
  const groups = await oracle.rows(
    `SELECT ${o.by} AS k, CAST(${o.value} AS DOUBLE) AS v FROM ${o.table} WHERE ${o.where} GROUP BY ALL`,
  );
  const [all] = await oracle.rows(
    `SELECT CAST(${o.value} AS DOUBLE) AS v FROM ${o.table} WHERE ${o.where}`,
  );
  const cats = groups.map((r) => ({ key: (r.k ?? null) as Key, v: r.v as number | null }));
  const valued = cats.filter((c): c is Cat => c.v !== null);
  const pos = valued.filter((c) => c.v > 0).sort((a, b) => b.v - a.v || byKey(a.key, b.key));
  const neg = valued.filter((c) => c.v < 0).sort((a, b) => a.v - b.v || byKey(a.key, b.key));
  const whole = pos.reduce((s, c) => s + c.v, 0);
  const slices = pos.slice(0, limit);
  const rest = pos.slice(limit);
  const otherV = rest.reduce((s, c) => s + c.v, 0);
  return {
    slices,
    rest,
    otherV,
    whole,
    total: (all?.v ?? null) as number | null,
    neg,
    emptyCats: cats.filter((c) => c.v === null || c.v === 0).map((c) => c.key),
    hm5011: rest.length > 0 && slices.every((s) => s.v < otherV),
    hm4061: neg.length > 0,
  };
}

const close = (a: unknown, e: number | null | undefined, tol = 1e-9) =>
  e === null || e === undefined
    ? a === null || a === undefined
    : typeof a === "number" && Math.abs(a - e) <= tol * Math.max(1, Math.abs(e));
const pieOf = (d: DashboardData | undefined, id: string) =>
  d?.blocks.find((b) => b.id === id) as PieData | undefined;
const at = (blocks: { id: string }[], id: string) =>
  `/blocks/${blocks.findIndex((b) => b.id === id)}`;

function comparePie(
  b: PieData | undefined,
  o: OraclePie,
  opts: { window?: Window; diags?: Diagnostic[]; pointer?: string; emptyStrict?: boolean } = {},
): string[] {
  if (b === undefined) return ["block missing from DashboardData"];
  const bad: string[] = [];
  const ks = (xs: { key: Key }[]) => JSON.stringify(xs.map((x) => x.key));
  if (ks(b.slices) !== ks(o.slices)) bad.push(`slice keys ${ks(b.slices)} vs ${ks(o.slices)}`);
  b.slices.forEach((s, i) => {
    const e = o.slices[i];
    if (e === undefined) return;
    if (!close(s.value, e.v)) bad.push(`${s.label} value ${s.value} vs ${e.v}`);
    if (!close(s.share, e.v / o.whole)) bad.push(`${s.label} share ${s.share} vs ${e.v / o.whole}`);
    if (s.label !== (e.key === null ? "(empty)" : String(e.key))) bad.push(`label ${s.label}`);
  });
  const otherOk =
    o.rest.length === 0
      ? b.other === undefined
      : b.other !== undefined &&
        b.other.count === o.rest.length &&
        close(b.other.value, o.otherV) &&
        close(b.other.share, o.otherV / o.whole);
  if (!otherOk)
    bad.push(`other ${JSON.stringify(b.other)} vs count ${o.rest.length} value ${o.otherV}`);
  if (!close(b.whole, o.whole)) bad.push(`whole ${b.whole} vs ${o.whole}`);
  if (!close(b.total, o.total)) bad.push(`total ${b.total} vs ${o.total}`);
  const negE = b.excluded?.negative ?? [];
  if (ks(negE) !== ks(o.neg) || negE.some((n, i) => !close(n.value, o.neg[i]?.v)))
    bad.push(`negatives ${JSON.stringify(negE)} vs ${JSON.stringify(o.neg)}`);
  if (opts.emptyStrict && (b.excluded?.empty ?? 0) !== o.emptyCats.length)
    bad.push(`empty ${b.excluded?.empty ?? 0} vs ${JSON.stringify(o.emptyCats)}`);
  if (o.whole > 0) {
    const sum = b.slices.reduce((s, x) => s + x.share, 0) + (b.other?.share ?? 0);
    if (Math.abs(sum - 1) > 1e-9) bad.push(`shares sum ${sum}`);
  }
  const w = opts.window;
  if (w && w[0] !== "0001-01-01" && !(b.window?.start === w[0] && b.window?.end === w[1]))
    bad.push(`window ${JSON.stringify(b.window)} vs [${w})`);
  if (opts.diags && opts.pointer !== undefined) {
    const here = opts.diags.filter((d) => d.pointer?.startsWith(`${opts.pointer}/`));
    const count = (c: string) => here.filter((d) => d.code === c).length;
    if (count("HM5011") > 0 !== o.hm5011) bad.push(`HM5011 ${count("HM5011")} vs ${o.hm5011}`);
    if (count("HM4061") > 0 !== o.hm4061) bad.push(`HM4061 ${count("HM4061")} vs ${o.hm4061}`);
    if (count("HM4061") > 1) bad.push("HM4061 more than once");
  }
  return bad;
}

const REV = "sum(amount) FILTER (WHERE status = 'paid')";
const dash = (name: string) => run(project.root, project.project, name);

async function cliCheck(file: string): Promise<Diagnostic[]> {
  let stdout = "";
  await cli(["check", file, "--json", "--cwd", project.root], {
    stdout: (t) => {
      stdout += t;
    },
    stderr: () => {},
    cwd: project.root,
    env: {},
    stdoutIsTTY: false,
    isAgent: async () => false,
  });
  return JSON.parse(stdout.trim().split("\n").pop() || "{}").diagnostics ?? [];
}

beforeAll(async () => {
  oracle = await Oracle.open();
  project = await writeProject({
    "hatchmark.json": CONFIG,
    ...data(),
    ...Object.fromEntries(Object.entries(METRICS).map(([n, m]) => [`metrics/${n}.json`, m])),
    ...Object.fromEntries(Object.entries(DASHBOARDS).map(([n, d]) => [`dashboards/${n}.json`, d])),
  });
  const csv = (f: string) =>
    `read_csv('${path.join(project.root, "data", f)}', all_varchar = true)`;
  await oracle.run(
    `CREATE TABLE o AS SELECT CAST(ordered_at AS TIMESTAMPTZ) AS ts, NULLIF(country, '') AS country, channel, device, status, CAST(amount AS DOUBLE) AS amount, customer_id, CAST(store_id AS INTEGER) AS store_id, CAST(is_mobile AS BOOLEAN) AS is_mobile FROM ${csv("orders.csv")}`,
  );
  await oracle.run(
    `CREATE TABLE rt AS SELECT CAST(returned_on AS DATE) AS d, NULLIF(country, '') AS country, CAST(amount AS DOUBLE) AS amount FROM ${csv("returns.csv")}`,
  );
  await oracle.run(
    `CREATE TABLE ti AS SELECT CAST("at" AS TIMESTAMPTZ) AS ts, NULLIF(cat, '') AS cat, CAST(amount AS DOUBLE) AS amount FROM ${csv("ties.csv")}`,
  );
  const [h] = await oracle.rows(
    `SELECT strftime(${LOCAL("(SELECT max(ts) FROM o)")}, '%Y-%m-%d %H:%M:%S') AS o, strftime(${LOCAL("(SELECT max(ts) FROM ti)")}, '%Y-%m-%d %H:%M:%S') AS t, strftime((SELECT max(d) FROM rt), '%Y-%m-%d') AS r`,
  );
  H = {
    orders: String(h?.o),
    ties: String(h?.t),
    returns: `${addDays(String(h?.r), 1)} 00:00:00`,
  };
  asOfLatest = asOfOf([H.orders, H.returns, H.ties].sort().at(-1) ?? "");
  main = await dash("main");
}, 60_000);
afterAll(async () => {
  oracle.close();
  await removeProjects();
});

describe("pie and donut against a SQL oracle", () => {
  it("the oracle's hand-computed horizons and as-of match the data", () => {
    expect(H).toEqual({
      orders: "2026-11-26 14:03:00",
      ties: "2026-11-26 14:03:00",
      returns: "2026-11-21 00:00:00",
    });
    expect(asOfLatest).toBe("2026-11-26");
  });

  it("schema: limit 13 and limit 0 are rejected (HM3005)", async () => {
    const file = path.join(project.root, "dashboards/schema.json");
    await writeFile(
      file,
      JSON.stringify({
        title: "Schema",
        period: MTD,
        blocks: [
          P("lim13", "revenue", "country", { limit: 13 }),
          P("lim0", "revenue", "country", { limit: 0 }),
        ],
      }),
    );
    try {
      const schema = (await cliCheck("dashboards/schema.json")).filter((d) => d.code === "HM3005");
      expect(schema.some((d) => d.pointer?.startsWith("/blocks/0"))).toBe(true);
      expect(schema.some((d) => d.pointer?.startsWith("/blocks/1"))).toBe(true);
    } finally {
      await rm(file);
    }
  });

  it("check: non-additive metrics are HM4001 errors, additive ones are clean, limits past 6 warn HM5010", () => {
    expect(project.diagnostics).toEqual([]);
    const diags = checkReferences(project.project).filter((d) => d.file?.endsWith("checks.json"));
    const of = (id: string) => {
      const p = at(CHECKS, id);
      return diags.filter((d) => d.pointer === p || d.pointer?.startsWith(`${p}/`));
    };
    const codes = (id: string) =>
      of(id).map((d) => `${d.code}:${d.severity}:${d.pointer?.replace(/^\/blocks\/\d+/, "")}`);
    for (const m of NONADD)
      for (const k of ["p_", "d_"]) expect(codes(k + m), k + m).toContain("HM4001:error:/metric");
    for (const m of ADD) expect(codes(`ok_${m}`), m).toEqual([]);
    expect(codes("lim6")).toEqual([]);
    const lim7 = of("lim7").filter((d) => d.code === "HM5010");
    expect(lim7).toHaveLength(1);
    expect(lim7[0]?.severity).toBe("warning");
    expect(lim7[0]?.pointer?.endsWith("/limit")).toBe(true);
    expect(JSON.stringify(lim7[0]?.fix ?? {})).toContain("6");
    expect(codes("lim12").some((c) => c.startsWith("HM5010:warning:/limit"))).toBe(true);
  });

  it("main (month to date): every pie matches SQL, with HM5011 and HM4061 exactly when SQL says", async () => {
    expect(main.data, JSON.stringify(main.diagnostics.map((d) => d.code))).toBeDefined();
    const W = rangeWindow("month_to_date", asOfLatest, end("orders"));
    expect(W).toEqual(["2026-11-01", "2026-11-26"]);
    const cases: [string, string, string, number][] = [
      ["rev_country", REV, "country", 5],
      ["rev_country_12", REV, "country", 12],
      ["net_country", "sum(amount)", "country", 6],
      ["orders_channel", "count(*)", "channel", 5],
      ["refunds_country", "count(*) FILTER (WHERE status = 'refunded')", "country", 3],
      ["rev_store", REV, "store_id", 4],
      ["rev_mobile", REV, "is_mobile", 5],
      ["rev_device_6", REV, "device", 6],
      ["rev_top1", REV, "country", 1],
      ["sql_net_channel", "sum(amount) FILTER (WHERE channel <> 'Wholesale')", "channel", 5],
      ["edge_status", REV, "status", 5],
    ];
    for (const [id, value, by, limit] of cases) {
      const o = await oraclePie({ table: "o", value, by, where: tsWin(W), limit });
      expect(
        comparePie(pieOf(main.data, id), o, {
          window: W,
          diags: main.diagnostics,
          pointer: at(MAIN, id),
        }),
        id,
      ).toEqual([]);
    }
  });

  it("main: Lateland is not a category, Refundia is a listed negative, Zeroland no slice, keys keep their types", () => {
    const wide = pieOf(main.data, "rev_country_12");
    const listed = [...(wide?.slices ?? []), ...(wide?.excluded?.negative ?? [])];
    expect(listed.map((s) => s.key)).not.toContain("Lateland");
    const net = pieOf(main.data, "net_country");
    expect(net?.excluded?.negative.map((x) => x.key)).toContain("Refundia");
    expect(net?.slices.map((s) => s.key)).not.toContain("Zeroland");
    const store = pieOf(main.data, "rev_store");
    expect(store?.slices.length).toBeGreaterThan(0);
    for (const s of store?.slices ?? []) {
      expect(typeof s.key).toBe("number");
      expect(s.label).toBe(String(s.key));
    }
    const mobile = pieOf(main.data, "rev_mobile");
    expect(mobile?.slices.length).toBeGreaterThan(0);
    for (const s of mobile?.slices ?? []) expect(typeof s.key).toBe("boolean");
  });

  it("a grain filter leaves every pie identical to the dashboard without it", async () => {
    const g = await dash("grain");
    expect(g.data).toBeDefined();
    const differ = MAIN.filter(
      (b) => JSON.stringify(pieOf(g.data, b.id)) !== JSON.stringify(pieOf(main.data, b.id)),
    ).map((b) => b.id);
    expect(differ).toEqual([]);
  });

  it("horizons: a date source ending Nov 20 and orders keep their own windows; latest_common_data", async () => {
    const h = await dash("horizons");
    const W = rangeWindow("month_to_date", asOfLatest, end("orders"));
    const WR = rangeWindow("month_to_date", asOfLatest, end("returns"));
    expect(WR).toEqual(["2026-11-01", "2026-11-21"]);
    expect(
      comparePie(
        pieOf(h.data, "returns_country"),
        await oraclePie({ table: "rt", value: "sum(amount)", by: "country", where: dWin(WR) }),
        { window: WR, diags: h.diagnostics, pointer: at(HORIZONS, "returns_country") },
      ),
    ).toEqual([]);
    expect(
      comparePie(
        pieOf(h.data, "rev_country_h"),
        await oraclePie({ table: "o", value: REV, by: "country", where: tsWin(W) }),
        { window: W },
      ),
    ).toEqual([]);
    const formula = pieOf(h.data, "rev_less_returns");
    if (formula !== undefined) {
      await oracle.run(
        `CREATE OR REPLACE TABLE rl AS SELECT k AS country, sum(v) AS v FROM (SELECT country AS k, coalesce(${REV}, 0) AS v FROM o WHERE ${tsWin(WR)} GROUP BY ALL UNION ALL SELECT country, -sum(amount) FROM rt WHERE ${dWin(WR)} GROUP BY ALL) GROUP BY ALL`,
      );
      expect(
        comparePie(
          formula,
          await oraclePie({ table: "rl", value: "sum(v)", by: "country", where: "true", limit: 6 }),
          { window: WR, diags: h.diagnostics, pointer: at(HORIZONS, "rev_less_returns") },
        ),
      ).toEqual([]);
    }
    const c = await dash("common");
    const ac = asOfOf([H.orders, H.returns].sort()[0] ?? "");
    const WC = rangeWindow("month_to_date", ac, end("orders"));
    expect(
      comparePie(
        pieOf(c.data, "c_rev"),
        await oraclePie({ table: "o", value: REV, by: "country", where: tsWin(WC) }),
        { window: WC },
      ),
    ).toEqual([]);
    const WCR = rangeWindow("month_to_date", ac, end("returns"));
    expect(
      comparePie(
        pieOf(c.data, "c_returns"),
        await oraclePie({ table: "rt", value: "sum(amount)", by: "country", where: dWin(WCR) }),
      ),
    ).toEqual([]);
  });

  it.each(RANGES)("range %s: a timestamp source and a date source", async (range) => {
    const d = await dash(`r_${range}`);
    const wo = rangeWindow(range, asOfLatest, end("orders"));
    const wr = rangeWindow(range, asOfLatest, end("returns"));
    expect(
      comparePie(
        pieOf(d.data, "rev"),
        await oraclePie({ table: "o", value: REV, by: "country", where: tsWin(wo) }),
        { window: wo },
      ),
    ).toEqual([]);
    expect(
      comparePie(
        pieOf(d.data, "net"),
        await oraclePie({ table: "o", value: "sum(amount)", by: "channel", where: tsWin(wo) }),
        { window: wo, diags: d.diagnostics, pointer: "/blocks/1" },
      ),
    ).toEqual([]);
    expect(
      comparePie(
        pieOf(d.data, "returns"),
        await oraclePie({ table: "rt", value: "sum(amount)", by: "country", where: dWin(wr) }),
        { window: wr },
      ),
    ).toEqual([]);
  });

  it("a fixed as-of (Nov 15) ends both sources Nov 15 inclusive", async () => {
    const d = await dash("fixed");
    const w = rangeWindow("month_to_date", "2026-11-15", end("orders"));
    expect(w).toEqual(["2026-11-01", "2026-11-16"]);
    expect(
      comparePie(
        pieOf(d.data, "rev"),
        await oraclePie({ table: "o", value: REV, by: "country", where: tsWin(w) }),
        { window: w },
      ),
    ).toEqual([]);
    expect(
      comparePie(
        pieOf(d.data, "returns"),
        await oraclePie({ table: "rt", value: "sum(amount)", by: "country", where: dWin(w) }),
        { window: w },
      ),
    ).toEqual([]);
  });

  it("filters: a multi-select plus a select, a filter on the by column, and one matching nothing", async () => {
    const W = tsWin(rangeWindow("month_to_date", asOfLatest, end("orders")));
    const f = await dash("filters");
    const fw = `${W} AND channel IN ('Online store', 'Marketplace') AND device = 'Desktop'`;
    expect(
      comparePie(
        pieOf(f.data, "f_country"),
        await oraclePie({ table: "o", value: REV, by: "country", where: fw }),
        { diags: f.diagnostics, pointer: "/blocks/0" },
      ),
    ).toEqual([]);
    expect(
      comparePie(
        pieOf(f.data, "f_net"),
        await oraclePie({ table: "o", value: "sum(amount)", by: "country", where: fw }),
        { diags: f.diagnostics, pointer: "/blocks/1" },
      ),
    ).toEqual([]);
    const s = await dash("self");
    const canada = `${W} AND country = 'Canada'`;
    expect(
      comparePie(
        pieOf(s.data, "self"),
        await oraclePie({ table: "o", value: REV, by: "country", where: canada }),
      ),
    ).toEqual([]);
    const n = pieOf((await dash("nothing")).data, "none");
    expect(n?.slices).toEqual([]);
    expect(n?.whole).toBe(0);
    expect(n?.total === null || n?.total === 0).toBe(true);
    expect(n?.other).toBeUndefined();
  });

  it("New York local-midnight and fall-back edges: 1 + 2 + 4 + 8 in, Oct 31 23:59 and Nov 26 00:00 out", async () => {
    const e = pieOf((await dash("edges")).data, "edges");
    expect({ total: e?.total, whole: e?.whole }).toEqual({ total: 15, whole: 15 });
  });

  it("an all-negative donut states its real total and never claims there is no data", async () => {
    const a = await dash("allneg");
    const W = tsWin(rangeWindow("month_to_date", asOfLatest, end("orders")));
    const o = await oraclePie({
      table: "o",
      value: "sum(amount)",
      by: "channel",
      where: `${W} AND country = 'Refundia'`,
    });
    expect(o.total).toBe(-125.5);
    expect(
      comparePie(pieOf(a.data, "allneg"), o, { diags: a.diagnostics, pointer: "/blocks/0" }),
    ).toEqual([]);
    if (a.data === undefined) throw new Error("allneg did not build");
    const html = renderFragment(a.data);
    expect(html).not.toMatch(/No net revenue in this period/);
    expect(html).not.toMatch(/chart of [^:]+: no data in this period/);
    expect(html.includes("−$126") || html.includes("−$125.50")).toBe(true);
  });

  it('HM4061 on a pie neither says the shares miss 100% nor suggests "stack": true', () => {
    const warning = main.diagnostics.find(
      (d) => d.code === "HM4061" && d.pointer === `${at(MAIN, "net_country")}/metric`,
    );
    expect(warning).toBeDefined();
    const net = pieOf(main.data, "net_country");
    const sum = (net?.slices ?? []).reduce((s, x) => s + x.share, 0) + (net?.other?.share ?? 0);
    expect(Math.abs(sum - 1)).toBeLessThan(1e-9);
    expect(warning?.message).not.toMatch(/do not add up to 100%/);
    expect(warning?.help ?? "").not.toMatch(/"stack"/);
  });

  it('no complete day: no slices, no Other, total null, no window, and no "No ... in this period"', async () => {
    const e = await dash("early");
    for (const id of ["early", "early_pie"]) {
      const b = pieOf(e.data, id);
      expect(b, id).toBeDefined();
      expect(b?.slices).toEqual([]);
      expect(b?.other).toBeUndefined();
      expect(b?.total).toBeNull();
      expect(b?.window).toBeUndefined();
      expect(b?.empty).toBe("no_complete_day");
    }
    if (e.data === undefined) throw new Error("early did not build");
    expect(renderFragment(e.data)).not.toMatch(/No early amount in this period/);
  });

  it("ties at the limit break by key (A-Z, then a-z, null last); empty categories are counted", async () => {
    const t = await dash("ties");
    const w = tsWin(rangeWindow("month_to_date", asOfLatest, end("ties")));
    for (const [id, limit, i] of [
      ["t3", 3, 0],
      ["t2", 2, 1],
      ["t5", 5, 2],
      ["t12", 12, 3],
    ] as const) {
      const o = await oraclePie({ table: "ti", value: "sum(amount)", by: "cat", where: w, limit });
      expect(
        comparePie(pieOf(t.data, id), o, {
          diags: t.diagnostics,
          pointer: `/blocks/${i}`,
          emptyStrict: true,
        }),
        id,
      ).toEqual([]);
    }
    expect(pieOf(t.data, "t3")?.slices.map((s) => s.label)).toEqual(["Alpha", "Bravo", "Charlie"]);
  });

  it("the renderer's runtime JSON (headers, values, percent text, hit-test cuts) matches DashboardData", () => {
    if (main.data === undefined) throw new Error("main did not build");
    const html = renderFragment(main.data);
    const runtimes = [
      ...html.matchAll(/data-hm-chart="([^"]+)"><script type="application\/json">(.*?)<\/script>/g),
    ].map((m) => JSON.parse((m[2] ?? "").replace(/\\u003c/g, "<")));
    const pies = runtimes.filter((rt) => rt.kind === "pie");
    const blocks = main.data.blocks.filter(
      (b): b is PieData => b.type === "pie" || b.type === "donut",
    );
    expect(pies).toHaveLength(blocks.length);
    const pct = (t: unknown) => Number(String(t).replace(/[^0-9.]/g, "")) / 100;
    const bad: string[] = [];
    pies.forEach((rt, k) => {
      const b = blocks[k] as PieData;
      const items: [string, number, number][] = b.slices.map((s) => [s.label, s.value, s.share]);
      if (b.other) items.push([`Other (${b.other.count} more)`, b.other.value, b.other.share]);
      if (JSON.stringify(rt.headers) !== JSON.stringify(items.map((i) => i[0])))
        bad.push(`${b.id} headers ${JSON.stringify(rt.headers)}`);
      let acc = 0;
      items.forEach(([, v, share], i) => {
        if (!close(rt.series[0].v[i], v)) bad.push(`${b.id} v[${i}]`);
        const p = rt.series[0].pct[i];
        const dp = (String(p).split(".")[1] ?? "").replace(/[^0-9]/g, "").length;
        if (Math.abs(pct(p) - share) > 0.5 * 10 ** -(dp + 2) + 1e-12)
          bad.push(`${b.id} pct ${p} vs ${share}`);
        acc += share;
        if (Math.abs(rt.cuts[i] - Math.min(1, acc)) > 1e-9) bad.push(`${b.id} cut ${i}`);
      });
      if (items.length > 0 && Math.abs(rt.cuts.at(-1) - 1) > 1e-9)
        bad.push(`${b.id} last cut ${rt.cuts.at(-1)}`);
    });
    expect(bad).toEqual([]);
  });
});
