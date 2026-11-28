import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  customRangeDashboard,
  type DashboardData,
  type KpiData,
  type PeriodData,
  type SegmentData,
  type TableData,
} from "../../src/compiler/index.js";
import { PROJECT_DEFAULTS } from "../../src/spec/index.js";
import { buildProject, metric, Oracle, removeProjects, writeProject } from "./fixture.js";

const FULL = process.env.HM_SWEEP === "full";
const CASES = Number(process.env.HM_TOGGLE_CASES ?? (FULL ? 120 : 12));
const SEED0 = Number(process.env.HM_TOGGLE_SEED ?? 1);

function rng(seed: number): () => number {
  let s = (seed * 2654435761) >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Filter = Record<string, unknown>;
const POOL: Record<string, { filters: Filter[]; sql: string }> = {
  americas: {
    filters: [{ column: "region", op: "eq", value: "Americas" }],
    sql: "region = 'Americas'",
  },
  not_emea: {
    filters: [{ column: "region", op: "neq", value: "EMEA" }],
    sql: "region IS DISTINCT FROM 'EMEA'",
  },
  big: { filters: [{ column: "amount", op: "gte", value: 100 }], sql: "amount >= 100" },
  mid: {
    filters: [{ column: "amount", op: "between", from: 50, to: 150 }],
    sql: "(amount >= 50 AND amount <= 150)",
  },
  paid_media: {
    filters: [{ column: "channel", op: "in", values: ["Paid search", "Social"] }],
    sql: "channel IN ('Paid search', 'Social')",
  },
  not_free: {
    filters: [{ column: "tier", op: "not_in", values: ["free"] }],
    sql: "(tier IS NULL OR tier <> 'free')",
  },
  known: { filters: [{ column: "customer", op: "not_null" }], sql: "customer IS NOT NULL" },
  guest: { filters: [{ column: "customer", op: "is_null" }], sql: "customer IS NULL" },
  nowhere: {
    filters: [{ column: "region", op: "eq", value: "Antarctica" }],
    sql: "region = 'Antarctica'",
  },
  settled: { filters: [{ column: "status", op: "eq", value: "paid" }], sql: "status = 'paid'" },
  small_intl: {
    filters: [
      { column: "region", op: "in", values: ["EMEA", "APAC"] },
      { column: "amount", op: "lt", value: 80 },
    ],
    sql: "(region IN ('EMEA', 'APAC') AND amount < 80)",
  },
};
const NAMES = Object.keys(POOL);

const PRESETS: unknown[] = [
  { last: 30, unit: "day" },
  { last: 7, unit: "day" },
  { to_date: "month" },
  { to_date: "year" },
  { last_complete: "month" },
  "last_12_months",
];

const METRICS = [
  "revenue",
  "orders",
  "refunded",
  "refund_rate",
  "customers",
  "aov",
  "med",
  "top",
  "all_rev",
  "seg_rev",
  "share",
];
const FOLDABLE = ["revenue", "orders", "aov", "refund_rate", "top"];

interface Case {
  seed: number;
  root: string;
  tz: string;
  local: string;
  toggles: string[];
  defaults: string[];
  metricSegment: string;
  select: string;
  hasPeriod: boolean;
  custom: boolean;
  label: string;
}

let oracle: Oracle;
beforeAll(async () => {
  oracle = await Oracle.open();
});
afterAll(async () => {
  oracle?.close();
  await removeProjects();
});

const quote = (s: string) => "'" + s.replaceAll("'", "''") + "'";

async function makeCase(seed: number, now: number): Promise<Case> {
  const random = rng(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(random() * xs.length)] as T;
  const maybe = (p: number) => random() < p;
  const count = 1 + Math.floor(random() * 4);
  const toggles: string[] = [];
  while (toggles.length < count) {
    const n = pick(NAMES);
    if (!toggles.includes(n)) toggles.push(n);
  }
  const defaults = maybe(0.5) ? toggles.filter(() => maybe(0.4)) : [];
  const metricSegment = maybe(0.5) ? pick(toggles) : pick(NAMES);
  const tz = pick(["UTC", "America/New_York", "America/Los_Angeles", "Asia/Seoul"]);
  const local = "(ordered_at AT TIME ZONE " + quote(tz) + ")";
  const regions = maybe(0.3) ? ["Americas", "EMEA", "APAC"].filter(() => maybe(0.6)) : [];
  const select = regions.length > 0 ? "region IN (" + regions.map(quote).join(", ") + ")" : "TRUE";
  const hasPeriod = maybe(0.75);
  const custom = hasPeriod && maybe(0.7);
  const options = PRESETS.filter(() => maybe(0.5));
  if (options.length === 0) options.push(pick(PRESETS));
  const filters: unknown[] = [
    ...(regions.length > 0
      ? [{ type: "select", id: "region", column: "region", multiple: true, default: regions }]
      : []),
    ...(hasPeriod
      ? [{ type: "period", id: "period", options, default: pick(options), custom }]
      : []),
    {
      type: "segment",
      id: "audience",
      label: "Audience",
      segments: toggles,
      ...(defaults.length > 0 ? { default: defaults } : {}),
    },
  ];
  if (maybe(0.5)) filters.reverse();
  const base = { type: "aggregate", table: "orders", time: "ordered_at" };
  const metrics: Record<string, unknown> = {
    revenue: metric(
      {
        ...base,
        aggregate: "sum",
        column: "amount",
        filters: [{ column: "status", op: "eq", value: "paid" }],
      },
      { type: "currency" },
    ),
    orders: metric({ ...base, aggregate: "count" }),
    refunded: metric({
      ...base,
      aggregate: "count",
      filters: [{ column: "status", op: "eq", value: "refunded" }],
    }),
    refund_rate: metric(
      { type: "ratio", numerator: "refunded", denominator: "orders" },
      { type: "percent" },
    ),
    customers: metric({ ...base, aggregate: "count_distinct", column: "customer" }),
    aov: metric({ ...base, aggregate: "avg", column: "amount" }, { type: "currency" }),
    med: metric({ ...base, aggregate: "median", column: "amount" }, { type: "currency" }),
    top: metric({ ...base, aggregate: "max", column: "amount" }, { type: "currency" }),
    seg_rev: metric(
      { ...base, aggregate: "sum", column: "amount", segments: [metricSegment] },
      { type: "currency" },
    ),
    all_rev: metric({ ...base, aggregate: "sum", column: "amount" }, { type: "currency" }),
    share: metric(
      { type: "ratio", numerator: "seg_rev", denominator: "all_rev" },
      { type: "percent" },
    ),
  };
  const files: Record<string, unknown> = {
    "hatchmark.yaml": {
      ...PROJECT_DEFAULTS,
      name: "toggle-oracle",
      timezone: tz,
      sources: { orders: { type: "parquet", path: "data/orders.parquet" } },
    },
    ...Object.fromEntries(
      NAMES.map((n) => [
        "segments/" + n + ".yaml",
        { label: n.replaceAll("_", " "), filters: POOL[n]?.filters },
      ]),
    ),
    ...Object.fromEntries(Object.entries(metrics).map(([n, m]) => ["metrics/" + n + ".yaml", m])),
    "dashboards/d.yaml": {
      title: "D",
      period: { asOf: "latest_data", range: "last_12_months", compare: "previous_period" },
      filters,
      blocks: [
        ...METRICS.map((m) => ({ type: "kpi", id: "k_" + m, metric: m })),
        { type: "table", id: "by_region", by: ["region"], metrics: METRICS },
        {
          type: "table",
          id: "by_channel",
          by: ["channel"],
          metrics: FOLDABLE,
          sort: { by: "revenue", order: "desc" },
          limit: 2,
          other: true,
        },
      ],
    },
  };
  const { root } = await writeProject(files);
  await mkdir(path.join(root, "data"), { recursive: true });
  const n = 60 + Math.floor(random() * 140);
  const rows: string[] = [];
  const dayMs = 86_400_000;
  for (let i = 0; i < n; i++) {
    const recent = i < 4;
    const ago = recent ? random() * 6 * 3600_000 : random() * 430 * dayMs;
    const at = new Date(now - ago - 1000).toISOString();
    const amount = maybe(0.05) ? "NULL" : (Math.floor(random() * 25000) / 100).toFixed(2);
    const customer = maybe(0.12) ? "NULL" : quote("c" + Math.floor(random() * 30));
    rows.push(
      "(TIMESTAMPTZ " +
        quote(at) +
        ", " +
        pick(["'Americas'", "'EMEA'", "'APAC'", "NULL"]) +
        ", " +
        quote(pick(["Paid search", "Social", "Organic", "Email", "Affiliate"])) +
        ", " +
        pick(["'gold'", "'silver'", "'free'", "NULL"]) +
        ", " +
        quote(pick(["paid", "paid", "refunded", "pending"])) +
        ", " +
        amount +
        ", " +
        customer +
        ")",
    );
  }
  await oracle.run("DROP TABLE IF EXISTS o");
  await oracle.run(
    "CREATE TABLE o (ordered_at TIMESTAMPTZ, region VARCHAR, channel VARCHAR, tier VARCHAR, status VARCHAR, amount DOUBLE, customer VARCHAR)",
  );
  await oracle.run("INSERT INTO o VALUES " + rows.join(", "));
  await oracle.run(
    "COPY o TO " + quote(path.join(root, "data", "orders.parquet")) + " (FORMAT parquet)",
  );
  return {
    seed,
    root,
    tz,
    local,
    toggles,
    defaults,
    metricSegment,
    select,
    hasPeriod,
    custom,
    label: JSON.stringify({ seed, tz, toggles, defaults, metricSegment, select, options, custom }),
  };
}

const near = (a: unknown, b: number | null) =>
  b === null
    ? a === null || a === undefined
    : typeof a === "number" && Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b));
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

function windowSql(c: Case, span: { start: string; end: string; endAt?: string }): string {
  const parts = [
    c.local + " >= CAST(" + quote(span.start) + " AS DATE)",
    c.local + " < CAST(" + quote(span.end) + " AS DATE)",
  ];
  if (span.endAt) parts.push(c.local + " <= CAST(" + quote(span.endAt) + " AS TIMESTAMP)");
  return parts.join(" AND ");
}

function rowSql(c: Case, on: string[]): string {
  return [c.select, ...on.map((s) => POOL[s]?.sql ?? "FALSE")].join(" AND ");
}

async function oracleRows(
  c: Case,
  where: string,
  groupBy?: string,
): Promise<Record<string, unknown>[]> {
  const seg = POOL[c.metricSegment]?.sql ?? "FALSE";
  return oracle.rows(
    "SELECT " +
      (groupBy ? groupBy + " AS g, " : "") +
      "coalesce(sum(amount) FILTER (WHERE status = 'paid'), 0) AS revenue, count(*) AS orders, " +
      "count(*) FILTER (WHERE status = 'refunded') AS refunded, count(DISTINCT customer) AS customers, " +
      "avg(amount) AS aov, median(amount) AS med, max(amount) AS top, " +
      "coalesce(sum(amount) FILTER (WHERE " +
      seg +
      "), 0) AS seg_rev, coalesce(sum(amount), 0) AS all_rev " +
      "FROM o WHERE " +
      where +
      (groupBy ? " GROUP BY " + groupBy : ""),
  );
}

function expected(r: Record<string, unknown> | undefined): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const k of [
    "revenue",
    "orders",
    "refunded",
    "customers",
    "aov",
    "med",
    "top",
    "seg_rev",
    "all_rev",
  ])
    out[k] = num(r?.[k]);
  for (const k of ["revenue", "orders", "refunded", "customers", "seg_rev", "all_rev"])
    out[k] = out[k] ?? 0;
  out.refund_rate = out.orders === 0 ? null : (out.refunded ?? 0) / (out.orders ?? 1);
  out.share = out.all_rev === 0 ? null : (out.seg_rev ?? 0) / (out.all_rev ?? 1);
  return out;
}

const find = <T>(data: DashboardData, id: string) =>
  data.blocks.find((b) => b.id === id) as T | undefined;

async function compare(
  c: Case,
  data: DashboardData,
  on: string[],
  where: string,
  label: string,
  partialMetrics = false,
): Promise<string[]> {
  const problems: string[] = [];
  const p = (s: string) => problems.push(label + ": " + s);
  if (JSON.stringify(data.segmentFilter?.selected) !== JSON.stringify(on))
    p(
      "segmentFilter.selected " +
        JSON.stringify(data.segmentFilter?.selected) +
        " != " +
        JSON.stringify(on),
    );
  const filt = rowSql(c, on);
  const grand = expected((await oracleRows(c, where + " AND " + filt))[0]);
  const skip = (k: KpiData | undefined) => partialMetrics && k?.presetOnly === true;
  for (const m of METRICS) {
    const k = find<KpiData>(data, "k_" + m);
    if (k === undefined) {
      p("no kpi " + m);
      continue;
    }
    if (skip(k)) {
      if (k.value !== null) p("presetOnly kpi " + m + " has value " + k.value);
      continue;
    }
    if (!near(k.value, grand[m] ?? null)) p("kpi " + m + " " + k.value + " != " + grand[m]);
    if (k.previous && k.previousValue !== undefined) {
      const prev = expected((await oracleRows(c, windowSql(c, k.previous) + " AND " + filt))[0]);
      if (!near(k.previousValue, prev[m] ?? null))
        p("kpi " + m + " previous " + k.previousValue + " != " + prev[m]);
    }
  }
  const region = find<TableData>(data, "by_region");
  const groups = await oracleRows(c, where + " AND " + filt, "region");
  const real = (region?.rows ?? []).filter((r) => r.kind === undefined);
  if (real.length !== groups.length) p("by_region rows " + real.length + " != " + groups.length);
  for (const row of real) {
    const g = groups.find((x) => (x.g ?? null) === row.keys[0]);
    if (g === undefined) {
      p("by_region extra group " + String(row.keys[0]));
      continue;
    }
    const want = expected(g);
    for (const m of METRICS) {
      if (partialMetrics && row.values[m] === null && ["customers", "med"].includes(m)) continue;
      if (!near(row.values[m], want[m] ?? null))
        p("by_region " + String(row.keys[0]) + " " + m + " " + row.values[m] + " != " + want[m]);
    }
  }
  for (const m of METRICS) {
    const v = region?.total?.values[m];
    if (partialMetrics && v === null && ["customers", "med"].includes(m)) continue;
    if (region?.total && !near(v, grand[m] ?? null))
      p("by_region total " + m + " " + v + " != " + grand[m]);
  }
  const channel = find<TableData>(data, "by_channel");
  const chans = (await oracleRows(c, where + " AND " + filt, "channel")).sort(
    (x, y) => Number(y.revenue) - Number(x.revenue) || (String(x.g) < String(y.g) ? -1 : 1),
  );
  const tie = chans.length > 2 && Number(chans[1]?.revenue) === Number(chans[2]?.revenue);
  const shownRows = (channel?.rows ?? []).filter((r) => r.kind === undefined);
  if (shownRows.length !== Math.min(2, chans.length)) p("by_channel rows " + shownRows.length);
  if (!tie) {
    for (const [i, want] of chans.slice(0, 2).entries()) {
      const row = shownRows[i];
      if (row === undefined || row.keys[0] !== want.g) {
        p("by_channel row " + i + " " + String(row?.keys[0]) + " != " + String(want.g));
        continue;
      }
      const e = expected(want);
      for (const m of FOLDABLE)
        if (!near(row.values[m], e[m] ?? null))
          p("by_channel " + String(want.g) + " " + m + " " + row.values[m] + " != " + e[m]);
    }
    const rest = chans.slice(2);
    const other = channel?.rows.find((r) => r.kind === "other");
    if (rest.length === 0 && other) p("by_channel Other with nothing folded");
    if (rest.length > 0) {
      const list = rest.map((r) => quote(String(r.g))).join(", ");
      const e = expected(
        (await oracleRows(c, where + " AND " + filt + " AND channel IN (" + list + ")"))[0],
      );
      if (!other) p("by_channel Other missing");
      else
        for (const m of FOLDABLE)
          if (!near(other.values[m], e[m] ?? null))
            p("by_channel Other " + m + " " + other.values[m] + " != " + e[m]);
    }
  }
  for (const m of FOLDABLE) {
    const v = channel?.total?.values[m];
    if (channel?.total && !near(v, grand[m] ?? null))
      p("by_channel total " + m + " " + v + " != " + grand[m]);
  }
  return problems;
}

function embedded<T>(html: string, attr: string): T | undefined {
  const m = html.match(
    new RegExp('<script type="application/json" ' + attr + "[^>]*>(.*?)</script>", "s"),
  );
  return m ? (JSON.parse(m[1] ?? "null") as T) : undefined;
}

const spanOf = (d: DashboardData) => find<KpiData>(d, "k_orders")?.current;
const keyOf = (on: string[], order: string[]) => order.filter((n) => on.includes(n)).join(",");

function combos(order: string[]): string[][] {
  return Array.from({ length: 2 ** order.length }, (_, mask) =>
    order.filter((_, i) => (mask & (1 << i)) !== 0),
  );
}

function shift(day: string, n: number): string {
  const d = new Date(day + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function days(a: string, b: string): number {
  return Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86_400_000);
}

async function checkCase(seed: number): Promise<string[]> {
  const c = await makeCase(seed, Date.now());
  const problems: string[] = [];
  const { code, report } = await buildProject(c.root);
  if (code !== 0) return ["build failed " + JSON.stringify(report).slice(0, 600)];
  if (process.env.HM_TOGGLE_DEBUG)
    console.log(JSON.stringify((report as { diagnostics: unknown[] }).diagnostics).slice(0, 1500));
  const html = await readFile(path.join(c.root, "dist", "d", "index.html"), "utf8");
  const seg = embedded<SegmentData>(html, "data-hm-segments");
  if (seg === undefined) return ["no data-hm-segments"];
  if (seg.filter !== "audience") problems.push("filter id " + seg.filter);
  const want = combos(c.toggles)
    .map((on) => keyOf(on, c.toggles))
    .sort();
  const got = Object.keys(seg.states).sort();
  if (JSON.stringify(got) !== JSON.stringify(want))
    problems.push("keys " + JSON.stringify(got) + " != " + JSON.stringify(want));
  const defaultKey = keyOf(c.defaults, c.toggles);
  const pagePeriods = embedded<PeriodData>(html, "data-hm-periods");
  const defaultState = seg.states[defaultKey];
  if (c.hasPeriod) {
    if (JSON.stringify(pagePeriods) !== JSON.stringify(defaultState?.periods))
      problems.push("page data-hm-periods differs from the default combination's periods");
  }
  for (const b of c.toggles) {
    const pressed = new RegExp('aria-pressed="(true|false)" data-hm-segment="' + b + '"').exec(
      html,
    )?.[1];
    if (pressed !== String(c.defaults.includes(b)))
      problems.push("button " + b + " pressed=" + pressed);
  }
  const refSpans = new Map<string, string>();
  const ref = (key: string, d: DashboardData) => {
    const k = find<KpiData>(d, "k_orders");
    const s = JSON.stringify([k?.current, k?.previous]);
    const was = refSpans.get(key);
    if (was === undefined) refSpans.set(key, s);
    else if (was !== s)
      problems.push("window of " + key + " depends on the combination: " + s + " vs " + was);
  };
  for (const [key, state] of Object.entries(seg.states)) {
    const on = state.selected;
    if (keyOf(on, c.toggles) !== key)
      problems.push("state " + key + " selected " + JSON.stringify(on));
    const span = spanOf(state.data);
    if (!span) {
      problems.push(key + ": no window");
      continue;
    }
    ref("page", state.data);
    problems.push(...(await compare(c, state.data, on, windowSql(c, span), "[" + key + "] page")));
    if (!c.hasPeriod) {
      if (state.periods !== undefined) problems.push(key + ": periods without a period filter");
      continue;
    }
    if (!state.periods) {
      problems.push(key + ": no periods");
      continue;
    }
    for (const [preset, data] of Object.entries(state.periods.presets)) {
      const s = spanOf(data);
      if (!s) continue;
      ref(preset, data);
      problems.push(...(await compare(c, data, on, windowSql(c, s), "[" + key + "] " + preset)));
    }
    const custom = state.periods.custom;
    if (c.custom !== (custom !== undefined))
      problems.push("SPAN " + key + ": custom data " + (custom ? "present" : "missing"));
    const pageSpan = defaultState?.periods?.custom?.span;
    if (custom && pageSpan && JSON.stringify(custom.span) !== JSON.stringify(pageSpan))
      problems.push(
        "SPAN " +
          key +
          ": custom span " +
          JSON.stringify(custom.span) +
          " != page " +
          JSON.stringify(pageSpan),
      );
    if (custom) {
      const { start, end } = custom.span;
      const total = days(start, end);
      const random = rng(seed * 31 + total);
      const a = Math.floor(random() * total);
      const b = a + 1 + Math.floor(random() * (total - a));
      const ranges = [
        { start: shift(start, a), end: shift(start, b) },
        { start: shift(end, -1), end },
        { start: shift(end, -3), end: shift(end, -1) },
        { start, end },
      ];
      for (const range of ranges) {
        const d = customRangeDashboard(custom, "period", range);
        const label = "[" + key + "] custom " + range.start + ".." + range.end;
        ref("custom " + range.start + ".." + range.end, d);
        const s = spanOf(d);
        const k = find<KpiData>(d, "k_orders");
        if (!s || s.start !== range.start || s.end > range.end) {
          problems.push(label + ": window " + JSON.stringify(s));
          continue;
        }
        if (k?.empty) {
          for (const m of METRICS)
            if (find<KpiData>(d, "k_" + m)?.value !== null)
              problems.push(label + ": empty window shows " + m);
          continue;
        }
        problems.push(...(await compare(c, d, on, windowSql(c, s), label, true)));
      }
    }
  }
  return problems.map((p) => c.label + " " + p);
}

describe("segment toggle against a SQL oracle over raw rows", () => {
  it("every combination, preset and custom range matches", async () => {
    const all: string[] = [];
    for (let i = 0; i < CASES; i++) all.push(...(await checkCase(SEED0 + i)));
    expect(all.slice(0, 30)).toEqual([]);
  }, 1_200_000);
});

describe("segment toggle edges", () => {
  const twoSources = async (blocks: unknown[], toggles: string[]) => {
    const base = { type: "aggregate", time: "at" };
    const { root } = await writeProject({
      "hatchmark.yaml": {
        ...PROJECT_DEFAULTS,
        name: "two-sources",
        sources: {
          orders: { type: "parquet", path: "data/orders.parquet" },
          sessions: { type: "parquet", path: "data/sessions.parquet" },
        },
      },
      "segments/americas.yaml": {
        label: "Americas",
        filters: [{ column: "region", op: "eq", value: "Americas" }],
      },
      "segments/big.yaml": { label: "Big", filters: [{ column: "amount", op: "gte", value: 100 }] },
      "segments/members.yaml": {
        label: "Members",
        filters: [{ column: "region", op: "in_table", table: "orders", key: "region" }],
      },
      "metrics/orders.yaml": metric({ ...base, table: "orders", aggregate: "count" }),
      "metrics/sessions.yaml": metric({ ...base, table: "sessions", aggregate: "count" }),
      "metrics/conversion.yaml": metric(
        { type: "ratio", numerator: "orders", denominator: "sessions" },
        { type: "percent" },
      ),
      "dashboards/d.yaml": {
        title: "D",
        period: {
          asOf: "2026-03-31",
          range: { start: "2026-01-01", end: "2026-03-31" },
          compare: "none",
        },
        filters: [{ type: "segment", id: "audience", segments: toggles }],
        blocks,
      },
    });
    await mkdir(path.join(root, "data"), { recursive: true });
    await oracle.run(
      "CREATE OR REPLACE TABLE so AS SELECT DATE '2026-01-01' + to_days(i % 85) AS at, ['Americas','EMEA','APAC'][1 + i % 3] AS region, ((i * 37) % 250)::DOUBLE AS amount FROM range(0, 300) t(i)",
    );
    await oracle.run(
      "CREATE OR REPLACE TABLE ss AS SELECT DATE '2026-01-01' + to_days(i % 85) AS at, ['Americas','EMEA','APAC','LATAM'][1 + i % 4] AS region FROM range(0, 700) t(i)",
    );
    await oracle.run(
      "COPY so TO " + quote(path.join(root, "data", "orders.parquet")) + " (FORMAT parquet)",
    );
    await oracle.run(
      "COPY ss TO " + quote(path.join(root, "data", "sessions.parquet")) + " (FORMAT parquet)",
    );
    return root;
  };

  it("applies each segment only to the sources that have its columns, in every combination", async () => {
    const root = await twoSources(
      [
        { type: "kpi", id: "orders", metric: "orders" },
        { type: "kpi", id: "sessions", metric: "sessions" },
      ],
      ["americas", "big"],
    );
    const { code, report } = await buildProject(root);
    expect(code, JSON.stringify(report)).toBe(0);
    expect(
      (report as { diagnostics: { severity: string }[] }).diagnostics.filter(
        (d) => d.severity === "error",
      ),
    ).toEqual([]);
    const html = await readFile(path.join(root, "dist", "d", "index.html"), "utf8");
    const seg = embedded<SegmentData>(html, "data-hm-segments");
    for (const [key, state] of Object.entries(seg?.states ?? {})) {
      const on = state.selected;
      const ow = [
        "TRUE",
        ...(on.includes("americas") ? ["region = 'Americas'"] : []),
        ...(on.includes("big") ? ["amount >= 100"] : []),
      ];
      const sw = ["TRUE", ...(on.includes("americas") ? ["region = 'Americas'"] : [])];
      const span = (id: string) => {
        const w = find<KpiData>(state.data, id)?.current;
        return w ? '"at" >= DATE ' + quote(w.start) + ' AND "at" < DATE ' + quote(w.end) : "TRUE";
      };
      const [o] = await oracle.rows(
        "SELECT count(*) AS n FROM so WHERE " + span("orders") + " AND " + ow.join(" AND "),
      );
      const [s] = await oracle.rows(
        "SELECT count(*) AS n FROM ss WHERE " + span("sessions") + " AND " + sw.join(" AND "),
      );
      expect(
        find<KpiData>(state.data, "orders")?.value,
        key + " orders " + JSON.stringify(find<KpiData>(state.data, "orders")),
      ).toBe(o?.n);
      expect(find<KpiData>(state.data, "sessions")?.value, key + " sessions").toBe(s?.n);
    }
  });

  it("rejects a block whose sources a toggle segment only partly binds", async () => {
    const root = await twoSources(
      [{ type: "kpi", id: "conversion", metric: "conversion" }],
      ["americas", "big"],
    );
    const { code, report } = await buildProject(root);
    const codes = (report as { diagnostics: { code: string; severity: string }[] }).diagnostics.map(
      (d) => d.code + ":" + d.severity,
    );
    expect(code).not.toBe(0);
    expect(codes).toContain("HM2013:error");
  });

  it("leaves blocks out with HM4023 for a toggle segment with in_table, and still builds", async () => {
    const root = await twoSources(
      [{ type: "kpi", id: "orders", metric: "orders" }],
      ["americas", "members"],
    );
    const { code, report } = await buildProject(root);
    const diags = (report as { diagnostics: { code: string; severity: string }[] }).diagnostics;
    expect(code, JSON.stringify(diags)).toBe(0);
    expect(diags.map((d) => d.code + ":" + d.severity)).toContain("HM4023:warning");
  });
});
