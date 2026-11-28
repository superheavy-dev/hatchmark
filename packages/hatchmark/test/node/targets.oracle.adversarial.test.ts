import { mkdir } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  assemble,
  type BarData,
  type BlockTarget,
  type DashboardData,
  executionContext,
  explainDefaults,
  type KpiData,
  type LineData,
  planDashboard,
  type QueryResult,
  queryBounds,
  type Series,
} from "../../src/compiler/index.js";
import { createDuckDbExecutor } from "../../src/node/index.js";
import { checkReferences, PROJECT_DEFAULTS } from "../../src/spec/index.js";
import { loadAt, metric, Oracle, removeProjects, writeProject } from "./fixture.js";

vi.setConfig({ testTimeout: 1_800_000, hookTimeout: 120_000 });

const FULL = process.env.HM_SWEEP === "full";
const CASES = Number(process.env.HM_ORACLE_CASES ?? (FULL ? 600 : 60));
const SEED0 = Number(process.env.HM_ORACLE_SEED ?? 7001);
const ONLY = process.env.HM_ORACLE_ONLY;

type Unit = "day" | "week" | "month" | "quarter" | "year";
interface Cal {
  week: number;
  m0: number;
  d0: number;
}
const DAY_MS = 86_400_000;
const UNITS: Unit[] = ["day", "week", "month", "quarter", "year"];
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const REGIONS = ["Americas", "EMEA", "APAC"];
const CHANNELS = ["online", "retail"];
const TZS = [
  "UTC",
  "America/New_York",
  "America/Los_Angeles",
  "Europe/London",
  "Asia/Seoul",
  "Australia/Adelaide",
  "America/Havana",
  "Australia/Sydney",
];

const dn = (s: string) => Math.round(Date.parse(`${s.slice(0, 10)}T00:00:00Z`) / DAY_MS);
const ds = (n: number) => new Date(n * DAY_MS).toISOString().slice(0, 10);
const fromYmd = (y: number, m0: number, d: number) => Math.round(Date.UTC(y, m0, d) / DAY_MS);
function ymd(n: number): [number, number, number] {
  const d = new Date(n * DAY_MS);
  return [d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()];
}
const dow = (n: number) => ((n % 7) + 7 + 4) % 7;

function startOf(n: number, unit: Unit, cal: Cal): number {
  if (unit === "day") return n;
  if (unit === "week") return n - ((dow(n) - cal.week + 7) % 7);
  const [y, m] = ymd(n);
  if (unit === "month") return fromYmd(y, m, 1);
  const step = unit === "quarter" ? 3 : 12;
  let c = y * 12 + m;
  c -= (((c - cal.m0) % step) + step) % step;
  let cand = fromYmd(Math.floor(c / 12), c % 12, cal.d0);
  if (cand > n) {
    c -= step;
    cand = fromYmd(Math.floor(c / 12), c % 12, cal.d0);
  }
  return cand;
}
function nextOf(s: number, unit: Unit): number {
  if (unit === "day") return s + 1;
  if (unit === "week") return s + 7;
  const [y, m, d] = ymd(s);
  return fromYmd(y, m + (unit === "month" ? 1 : unit === "quarter" ? 3 : 12), d);
}

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x9e3779b9) >>> 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
    return ((z ^ (z >>> 16)) >>> 0) / 4294967296;
  };
}

const wallMs = (text: string) => Date.parse(`${text.slice(0, 23).replace(" ", "T")}Z`);

interface Gen {
  seed: number;
  tz: string;
  cal: Cal;
  anchors: { week: string; quarter: string; year: string };
  kind: "flow" | "point";
  additive: boolean;
  tUnit: Unit;
  prorateSpec?: "days" | "none";
  prorate: "days" | "none";
  path: "linear" | "compound";
  inline: boolean;
  cols: string[];
  rows: { day: string; region: string | null; channel: string | null; amt: number }[];
  bRows?: { day: string; amt: number }[];
  range: unknown;
  rangeKind: "to_date" | "last" | "complete" | "explicit";
  rangeUnit?: Unit;
  fixed?: string;
  select?: { def: string[] | undefined; multiple: boolean };
  segment?: { def: string[] };
  declared?: string[];
  grain: Unit;
  grain2?: Unit;
  barGrain: Unit;
  clip: boolean;
}

let db: Oracle;
beforeAll(async () => {
  db = await Oracle.open();
});
afterAll(async () => {
  db?.close();
  await removeProjects();
});

const q = (s: string) => `'${s.replaceAll("'", "''")}'`;

function generate(seed: number) {
  const r = rng(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;
  const maybe = (p: number) => r() < p;
  const tz = pick(TZS);
  const week = pick(WEEKDAYS);
  const yearAnchor = pick(["01-01", "02-01", "04-01", "07-01", "10-15", "12-01"]);
  const cal: Cal = {
    week: WEEKDAYS.indexOf(week),
    m0: Number(yearAnchor.slice(0, 2)) - 1,
    d0: Number(yearAnchor.slice(3)),
  };
  const kind = maybe(0.3) ? "point" : "flow";
  const additive = kind === "point" ? true : maybe(0.8);
  const tUnit = pick<Unit>(["day", "week", "month", "month", "month", "quarter", "year"]);
  const prorateSpec = additive
    ? pick([undefined, "days", "none"] as const)
    : pick([undefined, "none"] as const);
  const inline = maybe(0.4);
  const cols = inline ? [] : pick([["region", "channel"], ["region"], ["channel"], []]);
  const endDay = dn("2026-11-26") + Math.floor(r() * 300) - 60;
  const midnight = maybe(0.15);
  const endWall =
    ds(endDay) +
    (midnight
      ? " 00:00:00"
      : " " +
        String(Math.floor(r() * 24))
          .padStart(2, "0")
          .replace(/^02$/, "03") +
        ":" +
        String(Math.floor(r() * 60)).padStart(2, "0") +
        ":00");
  const rows: Gen["rows"] = [];
  const gaps = maybe(0.4);
  const negative = kind === "point" && maybe(0.2);
  const buckets: number[] = [];
  for (let b = startOf(endDay - 800, tUnit, cal); b < endDay + 500; b = nextOf(b, tUnit))
    buckets.push(b);
  const missing = new Set<number>();
  if (gaps) for (let i = 0; i < 2; i++) missing.add(Math.floor(r() * buckets.length));
  const near = buckets.findIndex((b) => b > endDay);
  const zero = negative ? Math.max(0, near - 1 - Math.floor(r() * 4)) : -1;
  buckets.forEach((b, i) => {
    if (missing.has(i)) return;
    const total =
      i === zero ? pick([0, -250]) : 50 + Math.floor(r() * 5000) + (maybe(0.3) ? 0.5 : 0);
    const len = nextOf(b, tUnit) - b;
    const parts = inline ? (maybe(0.15) ? 2 : 1) : maybe(0.5) ? 1 : 3;
    for (let k = 0; k < parts; k++) {
      const day = maybe(0.25) ? ds(b + Math.floor(r() * len)) : ds(b);
      rows.push({
        day,
        region: cols.includes("region") ? pick(REGIONS) : null,
        channel: cols.includes("channel") ? pick(CHANNELS) : null,
        amt: Math.round((total / parts) * 100) / 100,
      });
    }
  });
  const bDefines = maybe(0.5);
  const bRows: Gen["bRows"] = [];
  if (bDefines) {
    for (let m = startOf(endDay - 500, "month", cal); m < endDay + 200; m = nextOf(m, "month")) {
      if (!maybe(0.05)) bRows.push({ day: ds(m), amt: 10 + Math.floor(r() * 90) });
    }
  }
  const fixed = maybe(0.3) ? ds(endDay - Math.floor(r() * 44) + 3) : undefined;
  const RANGES: unknown[] = [
    "month_to_date",
    "quarter_to_date",
    "year_to_date",
    { to_date: "week" },
    "last_7_days",
    "last_30_days",
    "last_90_days",
    "last_12_months",
    { last: 2, unit: "quarter" },
    { last: 3, unit: "week" },
    "last_complete_month",
    "last_complete_quarter",
    "last_complete_year",
    "explicit",
  ];
  let range = pick(RANGES);
  if (range === "explicit") {
    const s = endDay - 20 - Math.floor(r() * 140);
    range = { start: ds(s), end: ds(s + 1 + Math.floor(r() * 120)) };
  }
  const named: Record<string, unknown> = {
    month_to_date: { to_date: "month" },
    quarter_to_date: { to_date: "quarter" },
    year_to_date: { to_date: "year" },
    last_7_days: { last: 7, unit: "day" },
    last_30_days: { last: 30, unit: "day" },
    last_90_days: { last: 90, unit: "day" },
    last_12_months: { last: 12, unit: "month" },
    last_complete_month: { last_complete: "month" },
    last_complete_quarter: { last_complete: "quarter" },
    last_complete_year: { last_complete: "year" },
  };
  const spec = (typeof range === "string" ? named[range] : range) as Record<string, unknown>;
  const rangeKind =
    "to_date" in spec
      ? "to_date"
      : "last" in spec
        ? "last"
        : "last_complete" in spec
          ? "complete"
          : "explicit";
  const rangeUnit = (spec.to_date ?? spec.last_complete ?? spec.unit) as Unit | undefined;
  const short =
    rangeKind === "to_date"
      ? rangeUnit === "week" || rangeUnit === "month"
      : rangeKind === "last" &&
        (rangeUnit === "day" || rangeUnit === "week") &&
        Number(spec.last) <= 30;
  const grains: Unit[] = short ? ["day", "week", "month"] : ["week", "month", "quarter", "year"];
  const grain = pick(grains);
  const grain2 = maybe(0.3) ? pick(grains.filter((g) => g !== grain)) : undefined;
  const barGrain = pick(grains);
  const select = maybe(0.35)
    ? (() => {
        const multiple = maybe(0.5);
        const def = maybe(0.2)
          ? undefined
          : multiple
            ? [REGIONS[0] as string, pick(REGIONS.slice(1))]
            : [pick(REGIONS)];
        return { def, multiple };
      })()
    : undefined;
  const segment = maybe(0.35)
    ? { def: pick([[], ["online"], ["large"], ["online", "large"]]) }
    : undefined;
  const declared = maybe(0.25) ? pick([["online"], ["large"], ["online", "large"]]) : undefined;
  const g: Gen = {
    seed,
    tz,
    cal,
    anchors: { week, quarter: yearAnchor, year: yearAnchor },
    kind,
    additive,
    tUnit,
    ...(prorateSpec ? { prorateSpec } : {}),
    prorate: prorateSpec ?? (additive ? "days" : "none"),
    path: pick(["linear", "compound"] as const),
    inline,
    cols,
    rows,
    ...(bDefines ? { bRows } : {}),
    range,
    rangeKind,
    ...(rangeUnit ? { rangeUnit } : {}),
    ...(fixed ? { fixed } : {}),
    ...(select ? { select } : {}),
    ...(segment ? { segment } : {}),
    ...(declared ? { declared } : {}),
    grain,
    ...(grain2 ? { grain2 } : {}),
    barGrain,
    clip: maybe(0.3),
  };
  const orders: string[] = [];
  const n = 80 + Math.floor(r() * 150);
  for (let i = 0; i < n; i++) {
    const wall =
      i === 0
        ? endWall
        : ds(endDay - 1 - Math.floor(r() * 420)) +
          " " +
          String(Math.floor(r() * 24))
            .padStart(2, "0")
            .replace(/^02$/, "04") +
          ":30:00";
    orders.push(
      "(timezone(" +
        q(tz) +
        ", TIMESTAMP " +
        q(wall) +
        "), " +
        q(pick(REGIONS)) +
        ", " +
        q(pick(CHANNELS)) +
        ", " +
        Math.floor(r() * 200) +
        ", " +
        (Math.floor(r() * 25000) / 100).toFixed(2) +
        ")",
    );
  }
  return { g, orders, bDefines };
}

function projectFiles(g: Gen) {
  const metricName = g.additive ? "revenue" : "average";
  const target: Record<string, unknown> = {
    id: "t",
    label: "Plan",
    grain: g.tUnit,
    ...(g.inline
      ? {
          values: Object.fromEntries(
            Object.entries(
              g.rows.reduce<Record<string, number>>((acc, row) => {
                acc[row.day] = (acc[row.day] ?? 0) + row.amt;
                return acc;
              }, {}),
            ),
          ),
        }
      : { table: "plan", date: "day", value: "plan_amount" }),
    ...(g.prorateSpec ? { prorate: g.prorateSpec } : {}),
    ...(g.declared ? { segments: g.declared } : {}),
  };
  const filters: unknown[] = [];
  if (g.select) {
    filters.push({
      type: "select",
      id: "region",
      column: "region",
      ...(g.select.multiple ? { multiple: true } : {}),
      ...(g.select.def === undefined
        ? {}
        : { default: g.select.multiple ? g.select.def : g.select.def[0] }),
    });
  }
  if (g.segment)
    filters.push({
      type: "segment",
      id: "seg",
      segments: ["online", "large"],
      default: g.segment.def,
    });
  const line: Record<string, unknown> = {
    type: "line",
    id: "l",
    metrics: [metricName],
    grain: g.grain,
    target: "t",
    ...(g.clip ? { edges: "clip" } : {}),
  };
  if (g.grain2) line.grains = [g.grain, g.grain2];
  return {
    metricName,
    files: {
      "hatchmark.yaml": {
        ...PROJECT_DEFAULTS,
        name: "targets-oracle",
        timezone: g.tz,
        anchors: g.anchors,
        sources: {
          orders: { type: "parquet", path: "data/orders.parquet" },
          plan: { type: "csv", path: "data/plan.csv" },
        },
      },
      "data/plan.csv":
        [
          ["day", ...g.cols, "plan_amount"].join(","),
          ...(g.inline
            ? []
            : g.rows.map((row) =>
                [
                  row.day,
                  ...g.cols.map((c) => (c === "region" ? row.region : row.channel)),
                  row.amt,
                ].join(","),
              )),
        ].join("\n") + (g.inline ? "\n2000-01-01,0" : ""),
      "segments/online.yaml": {
        label: "Online",
        filters: [{ column: "channel", op: "eq", value: "online" }],
      },
      "segments/large.yaml": {
        label: "Large",
        filters: [{ column: "size", op: "gte", value: 100 }],
      },
      [`metrics/${metricName}.yaml`]: metric({
        type: "aggregate",
        table: "orders",
        aggregate: g.additive ? "sum" : "avg",
        column: "amount",
        time: "ordered_at",
        targets: [target],
      }),
      "metrics/order_count.yaml": metric({
        type: "aggregate",
        table: "orders",
        aggregate: "count",
        time: "ordered_at",
        ...(g.bRows
          ? {
              targets: [
                {
                  id: "t",
                  grain: "month",
                  values: Object.fromEntries(g.bRows.map((row) => [row.day, row.amt])),
                },
              ],
            }
          : {}),
      }),
      "dashboards/d.yaml": {
        title: "D",
        period: { asOf: g.fixed ?? "latest_data", range: g.range, compare: "none" },
        ...(filters.length > 0 ? { filters } : {}),
        blocks: [
          { type: "kpi", id: "k", metric: metricName, target: "t" },
          line,
          { type: "bar", id: "r", metrics: [metricName], by: "region", target: "t" },
          { type: "bar", id: "ch", metrics: [metricName], by: "channel", target: "t" },
          {
            type: "bar",
            id: "s",
            metrics: [metricName],
            grain: g.barGrain,
            split: "region",
            target: "t",
          },
          {
            type: "line",
            id: "m",
            metrics: ["order_count", metricName],
            grain: g.grain,
            target: "t",
          },
        ],
      },
    },
  };
}

async function build(seed: number) {
  const { g, orders } = generate(seed);
  const { metricName, files } = projectFiles(g);
  const { root } = await writeProject(files);
  await mkdir(path.join(root, "data"), { recursive: true });
  await db.run("DROP TABLE IF EXISTS o");
  await db.run(
    "CREATE TABLE o (ordered_at TIMESTAMPTZ, region VARCHAR, channel VARCHAR, size INTEGER, amount DOUBLE)",
  );
  await db.run(`INSERT INTO o VALUES ${orders.join(", ")}`);
  await db.run(`COPY o TO ${q(path.join(root, "data", "orders.parquet"))} (FORMAT parquet)`);
  const { project, diagnostics: loaded } = await loadAt(root);
  if (project.config.spec === undefined)
    throw new Error(
      "seed " +
        seed +
        " config: " +
        JSON.stringify(loaded.map((d) => `${d.code} ${d.message}`)) +
        JSON.stringify(
          Object.fromEntries(Object.entries(project.config).filter(([key]) => key !== "document")),
        ).slice(0, 2500),
    );
  const planned = planDashboard(project, "d");
  const plan = planned.plan;
  if (plan === undefined)
    throw new Error(
      "seed " +
        seed +
        " no plan: " +
        JSON.stringify(planned.diagnostics.map((d) => `${d.code} ${d.message}`)),
    );
  if (g.kind === "point") {
    for (const block of plan.blocks) {
      const t = block.targets?.[metricName];
      if (t === undefined) continue;
      t.kind = "point";
      t.path = g.path;
      delete t.additive;
      delete t.prorate;
    }
  }
  const config = project.config.spec;
  if (config === undefined) throw new Error("no config");
  const executor = await createDuckDbExecutor({ root, config });
  try {
    const resolved = await executionContext(project, plan, executor);
    const context = resolved.context;
    if (context === undefined) throw new Error(JSON.stringify(resolved.diagnostics));
    const results = new Map<string, QueryResult>();
    for (const query of plan.queries) {
      if (queryBounds(query, context) === undefined) continue;
      results.set(query.id, await executor.execute(query, context));
    }
    const out = assemble(project, plan, results, context);
    return {
      g,
      metricName,
      project,
      data: out.data as DashboardData,
      codes: new Set(out.diagnostics.map((d) => d.code)),
      diagnostics: out.diagnostics,
    };
  } finally {
    await executor.close();
  }
}

interface Want {
  value: number | null;
  prorated: boolean;
}

class Flow {
  private spans: { id: number; k: string; s: number; e: number }[] = [];
  private keys = new Map<
    string,
    { src: string; pred: string; additive: boolean; prorate: "days" | "none" }
  >();
  key(k: string, src: string, pred: string, additive: boolean, prorate: "days" | "none") {
    this.keys.set(k, { src, pred, additive, prorate });
    return k;
  }
  ask(k: string, s: number, e: number): number {
    this.spans.push({ id: this.spans.length, k, s, e });
    return this.spans.length - 1;
  }
  async solve(g: Gen): Promise<{ flows: Want[]; points: Map<string, { e: number; v: number }[]> }> {
    await db.run("DROP TABLE IF EXISTS p");
    await db.run(
      "CREATE TABLE p (src VARCHAR, day DATE, region VARCHAR, channel VARCHAR, amt DOUBLE)",
    );
    const vals = [
      ...g.rows.map(
        (row) =>
          "('main', DATE " +
          q(row.day) +
          ", " +
          (row.region ? q(row.region) : "NULL") +
          ", " +
          (row.channel ? q(row.channel) : "NULL") +
          ", " +
          row.amt +
          ")",
      ),
      ...(g.bRows ?? []).map((row) => `('b', DATE ${q(row.day)}, NULL, NULL, ${row.amt})`),
    ];
    if (vals.length > 0) await db.run(`INSERT INTO p VALUES ${vals.join(", ")}`);
    await db.run("DROP TABLE IF EXISTS tb");
    await db.run("CREATE TABLE tb (src VARCHAR, s DATE, e DATE)");
    const tb: string[] = [];
    const lo = dn("2023-01-01");
    const hi = dn("2029-12-31");
    for (const [src, unit] of [
      ["main", g.tUnit],
      ["b", "month"],
    ] as const) {
      for (let b = startOf(lo, unit, g.cal); b < hi; b = nextOf(b, unit))
        tb.push(`(${q(src)}, DATE ${q(ds(b))}, DATE ${q(ds(nextOf(b, unit)))})`);
    }
    for (let i = 0; i < tb.length; i += 5000)
      await db.run(`INSERT INTO tb VALUES ${tb.slice(i, i + 5000).join(", ")}`);
    const tv = [...this.keys.entries()].map(
      ([k, { src, pred }]) =>
        "SELECT " +
        q(k) +
        " AS k, tb.src, tb.s, tb.e, sum(p.amt) AS v FROM tb JOIN p ON p.src = tb.src AND p.day >= tb.s AND p.day < tb.e WHERE tb.src = " +
        q(src) +
        " AND (" +
        pred +
        ") GROUP BY tb.src, tb.s, tb.e",
    );
    await db.run("DROP TABLE IF EXISTS tv");
    await db.run(
      "CREATE TABLE tv AS " +
        (tv.length > 0
          ? tv.join(" UNION ALL ")
          : "SELECT NULL::VARCHAR k, NULL::VARCHAR src, NULL::DATE s, NULL::DATE e, NULL::DOUBLE v WHERE false"),
    );
    const points = new Map<string, { e: number; v: number }[]>();
    for (const row of await db.rows(
      "SELECT k, strftime(e, '%Y-%m-%d') AS e, v FROM tv ORDER BY k, e",
    )) {
      const list = points.get(String(row.k)) ?? [];
      list.push({ e: dn(String(row.e)), v: Number(row.v) });
      points.set(String(row.k), list);
    }
    await db.run("DROP TABLE IF EXISTS sp");
    await db.run("CREATE TABLE sp (id INTEGER, k VARCHAR, src VARCHAR, s DATE, e DATE)");
    const sp = this.spans.map(
      (x) =>
        "(" +
        x.id +
        ", " +
        q(x.k) +
        ", " +
        q(this.keys.get(x.k)?.src ?? "main") +
        ", DATE " +
        q(ds(x.s)) +
        ", DATE " +
        q(ds(Math.max(x.e, x.s))) +
        ")",
    );
    for (let i = 0; i < sp.length; i += 5000)
      await db.run(`INSERT INTO sp VALUES ${sp.slice(i, i + 5000).join(", ")}`);
    const rows = await db.rows(
      "WITH daily AS (SELECT k, s, e, d::DATE AS day, v / datediff('day', s, e) AS rate FROM tv, generate_series(s, e - INTERVAL 1 DAY, INTERVAL 1 DAY) AS g(d)), " +
        "hit AS (SELECT sp.id, count(daily.day) AS n, sum(daily.rate) AS total FROM sp LEFT JOIN daily ON daily.k = sp.k AND daily.day >= sp.s AND daily.day < sp.e GROUP BY sp.id) " +
        "SELECT sp.id, datediff('day', sp.s, sp.e) AS len, hit.n, hit.total, " +
        "(SELECT count(*) FROM tb WHERE tb.src = sp.src AND tb.s = sp.s) AS s_on, " +
        "(SELECT count(*) FROM tb WHERE tb.src = sp.src AND tb.e = sp.e) AS e_on, " +
        "(SELECT count(*) FROM tb WHERE tb.src = sp.src AND tb.s < sp.e AND tb.e > sp.s) AS touched " +
        "FROM sp JOIN hit USING (id) ORDER BY sp.id",
    );
    const flows = rows.map((row): Want => {
      const meta = this.keys.get(this.spans[Number(row.id)]?.k ?? "") ?? {
        additive: g.additive,
        prorate: g.prorate,
      };
      const len = Number(row.len);
      if (len <= 0 || Number(row.n) !== len) return { value: null, prorated: false };
      const aligned = Number(row.s_on) === 1 && Number(row.e_on) === 1;
      if (!meta.additive && !(aligned && Number(row.touched) === 1))
        return { value: null, prorated: false };
      if (!aligned && meta.prorate === "none") return { value: null, prorated: false };
      return { value: Number(row.total), prorated: !aligned };
    });
    return { flows, points };
  }
}

function pointAt(
  list: { e: number; v: number }[] | undefined,
  at: number,
  path: "linear" | "compound",
): number | null {
  if (list === undefined || list.length === 0) return null;
  const pts = list.map((p) => ({ t: p.e * DAY_MS, v: p.v }));
  let lo = 0;
  let hi = pts.length - 1;
  const first = pts[0] as { t: number; v: number };
  const last = pts[hi] as { t: number; v: number };
  if (at < first.t || at > last.t) return null;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if ((pts[mid] as { t: number }).t <= at) lo = mid;
    else hi = mid;
  }
  const a = pts[lo] as { t: number; v: number };
  const b = pts[hi] as { t: number; v: number };
  const exact = pts.findIndex((p) => p.t === at);
  if (exact >= 0) return (pts[exact] as { t: number; v: number }).v;
  const f = (at - a.t) / (b.t - a.t);
  if (path === "linear") return a.v * (1 - f) + b.v * f;
  if (!(a.v > 0 && b.v > 0)) return null;
  return a.v * (b.v / a.v) ** f;
}

const stats = {
  values: 0,
  nulls: 0,
  paces: 0,
  points: 0,
  hidden: {} as Record<string, number>,
  prorated: 0,
};
function close(got: unknown, want: number | null | undefined): boolean {
  if (Number.isNaN(want)) return true;
  if (want === null || want === undefined) {
    stats.nulls++;
    return got === null || got === undefined;
  }
  stats.values++;
  return typeof got === "number" && Math.abs(got - want) <= 1e-7 * Math.max(1, Math.abs(want));
}

async function oracle(built: Awaited<ReturnType<typeof build>>): Promise<string[]> {
  const { g, data, codes, metricName, project, diagnostics } = built;
  const errors: string[] = [];
  const fail = (what: string, got: unknown, want: unknown) =>
    errors.push(`${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  const hasCol = (c: string) => !g.inline && g.cols.includes(c);
  const selectOn = g.select?.def !== undefined && g.select.def.length > 0;
  const segOn = g.segment?.def ?? [];
  const segCol = (s: string) => (s === "online" ? "channel" : "size");
  const filterHidden = selectOn && !hasCol("region");
  const segHidden = segOn.some((s) => (g.declared ? !g.declared.includes(s) : !hasCol(segCol(s))));
  const hiddenWhy: string[] = [
    ...(filterHidden ? ["filter"] : []),
    ...(segHidden ? ["segment"] : []),
  ];
  const preds: string[] = ["true"];
  if (selectOn && hasCol("region"))
    preds.push(`region IN (${(g.select?.def ?? []).map(q).join(", ")})`);
  if (!g.declared && segOn.includes("online") && hasCol("channel"))
    preds.push("channel = 'online'");
  const base = preds.join(" AND ");
  const flow = new Flow();
  const mainKey = flow.key("main", "main", base, g.additive, g.prorate);
  const dimKey = (col: "region" | "channel", v: unknown) =>
    flow.key(
      `${col}=${String(v)}`,
      "main",
      `${base} AND ${col} = ${q(String(v))}`,
      g.additive,
      g.prorate,
    );
  const bOwner = g.bRows !== undefined;
  const bKey = flow.key("b", "b", "true", true, "days");
  const bHidden = selectOn || segOn.length > 0;

  const tr = await db.rows(
    "SELECT epoch_ms(max(ordered_at)) AS t, strftime(timezone(" +
      q(g.tz) +
      ", max(ordered_at)), '%Y-%m-%d %H:%M:%S.%f') AS w FROM o",
  );
  const wallParts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: g.tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(new Date(Number(tr[0]?.t)))
      .map((p) => [p.type, p.value]),
  );
  const nodeWall =
    wallParts.year +
    "-" +
    wallParts.month +
    "-" +
    wallParts.day +
    " " +
    wallParts.hour +
    ":" +
    wallParts.minute +
    ":" +
    wallParts.second;
  const maxWall = wallMs(nodeWall);
  if (process.env.HM_ORACLE_DEBUG) {
    const through = data.horizons.find((h) => h.source === "orders")?.through ?? "";
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-US", {
        timeZone: g.tz,
        hourCycle: "h23",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
        .formatToParts(new Date(Date.parse(through.replace(/(\.\d{3})\d*Z$/, "$1Z"))))
        .map((p) => [p.type, p.value]),
    );
    console.log(
      "DEBUG",
      g.seed,
      "duckdb wall",
      tr[0]?.w,
      "through",
      through,
      "node wall",
      parts.year +
        "-" +
        parts.month +
        "-" +
        parts.day +
        " " +
        parts.hour +
        ":" +
        parts.minute +
        ":" +
        parts.second,
    );
  }
  const asOfDay = g.fixed ? dn(g.fixed) : dn(nodeWall);
  const horizon = Math.min(
    maxWall + 0.001,
    g.fixed ? (dn(g.fixed) + 1) * DAY_MS : Number.POSITIVE_INFINITY,
  );

  const k = data.blocks.find((b) => b.id === "k") as KpiData;
  const cur = k.current;
  let period: { s: number; e: number } | undefined;
  if (g.rangeKind === "to_date" && g.rangeUnit) {
    const s = startOf(asOfDay, g.rangeUnit, g.cal);
    period = { s, e: nextOf(s, g.rangeUnit) };
  } else if (g.rangeKind === "complete" && g.rangeUnit) {
    let s = startOf(asOfDay, g.rangeUnit, g.cal);
    if (nextOf(s, g.rangeUnit) !== asOfDay + 1) s = startOf(s - 1, g.rangeUnit, g.cal);
    period = { s, e: nextOf(s, g.rangeUnit) };
  } else if (g.rangeKind === "explicit") {
    const x = g.range as { start: string; end: string };
    period = { s: dn(x.start), e: dn(x.end) };
  } else if (cur) {
    period = { s: dn(cur.start), e: dn(cur.end) };
  }
  if (
    period &&
    g.rangeKind !== "last" &&
    data.period.current &&
    dn(data.period.current.start) !== period.s
  ) {
    fail("HARNESS period start", data.period.current, ds(period.s));
  }
  const windowEnd = cur
    ? cur.endAt === undefined
      ? dn(cur.end) * DAY_MS
      : wallMs(cur.endAt)
    : undefined;
  const pending: (() => void)[] = [];
  const proratedB = new Set<string>();
  const missingB = new Set<string>();
  let current = "";
  const tag = (id: string, fn: () => void) => () => {
    current = id;
    fn();
  };
  const noPace = !g.additive;
  const windowAsk = (key: string) => {
    if (!period || windowEnd === undefined)
      return () => ({
        value: null as number | null,
        pace: undefined as number | undefined,
        prorated: false,
      });
    if (g.kind === "point")
      return () => ({
        value: pointAt(points.get(key), windowEnd, g.path),
        pace: undefined,
        prorated: false,
      });
    const id = flow.ask(key, period.s, period.e);
    const p = period;
    return () => {
      const full = flows[id] as Want;
      if (full.value === null) return { value: null, pace: undefined, prorated: false };
      const stop = p.e * DAY_MS;
      if (windowEnd >= stop || (noPace && key !== "b"))
        return { value: full.value, pace: undefined, prorated: full.prorated };
      return {
        value: full.value,
        pace: (full.value * (windowEnd - p.s * DAY_MS)) / (stop - p.s * DAY_MS),
        prorated: full.prorated,
      };
    };
  };
  const unitOf = (u: Unit) => u;
  const seriesAsk = (key: string, buckets: string[], unit: Unit, clipFrom?: string) => {
    const asks = buckets.map((b, i) => {
      const s = dn(b);
      const e = nextOf(s, unit);
      if (g.kind === "point" && key !== "b") {
        const read = s * DAY_MS < horizon && horizon < e * DAY_MS ? horizon : e * DAY_MS;
        return () => ({
          value: pointAt(points.get(key), read, g.path),
          pace: null as number | null,
          prorated: false,
        });
      }
      const id = flow.ask(key, s, e);
      return () => {
        const f = flows[id] as Want;
        const from =
          i === 0 && clipFrom !== undefined && dn(clipFrom) > s
            ? dn(clipFrom) * DAY_MS
            : s * DAY_MS;
        const to = Math.min(horizon, e * DAY_MS);
        const partial = from < horizon && (from > s * DAY_MS || to < e * DAY_MS);
        return {
          value: f.value,
          pace:
            partial && f.value !== null && !(noPace && key !== "b")
              ? (f.value * (to - from)) / ((e - s) * DAY_MS)
              : null,
          prorated: f.prorated,
        };
      };
    });
    return () => asks.map((a) => a());
  };
  const compareSeries = (
    what: string,
    got: Series["target"] | BlockTarget | undefined,
    want: { value: number | null; pace: number | null; prorated: boolean }[],
  ) => {
    want.forEach((w, i) => {
      if (w.value === null) missingB.add(current);
      if (w.prorated) proratedB.add(current);
      if (!close(got?.values?.[i], w.value)) fail(`${what} value[${i}]`, got?.values?.[i], w.value);
      if (!close(got?.pace?.[i] ?? null, w.pace))
        fail(`${what} pace[${i}]`, got?.pace?.[i], w.pace);
    });
    if ((got?.values?.length ?? 0) !== want.length)
      fail(`${what} length`, got?.values?.length, want.length);
  };
  const expectHidden = (what: string, got: string | undefined, grain?: Unit) => {
    const why =
      hiddenWhy.length > 0
        ? hiddenWhy
        : grain !== undefined &&
            g.kind === "flow" &&
            g.prorate === "none" &&
            UNITS.indexOf(grain) < UNITS.indexOf(g.tUnit)
          ? ["grain"]
          : [];
    if (why.length === 0) {
      if (got !== undefined) fail(`${what} hidden`, got, undefined);
      return false;
    }
    if (!why.includes(String(got))) fail(`${what} hidden`, got, why);
    stats.hidden[String(got)] = (stats.hidden[String(got)] ?? 0) + 1;
    return true;
  };

  let points = new Map<string, { e: number; v: number }[]>();
  let flows: Want[] = [];

  if (!expectHidden("kpi", k.target?.hidden)) {
    const w = windowAsk(mainKey);
    pending.push(
      tag("k", () => {
        const want = w();
        if (want.value === null) missingB.add(current);
        if (want.prorated) proratedB.add(current);
        if (!close(k.target?.value, want.value)) fail("kpi value", k.target?.value, want.value);
        if (!close(k.target?.pace, want.pace)) fail("kpi pace", k.target?.pace, want.pace);
        const d = want.pace ?? want.value;
        const att = k.value === null || d === null || d === 0 ? null : (k.value as number) / d;
        if (!close(k.target?.attainment, att)) fail("kpi attainment", k.target?.attainment, att);
      }),
    );
  }

  const l = data.blocks.find((b) => b.id === "l") as LineData;
  const lineCheck = (
    label: string,
    axis: LineData["axis"],
    series: Series[],
    target: BlockTarget | undefined,
    unit: Unit,
  ) => {
    if (target?.metric !== metricName) fail(`${label} owner`, target?.metric, metricName);
    if (expectHidden(label, target?.hidden, unit)) return;
    const w = seriesAsk(mainKey, axis.buckets, unit, g.clip ? axis.window.start : undefined);
    pending.push(tag("l", () => compareSeries(label, series[0]?.target, w())));
  };
  lineCheck("line", l.axis, l.series, l.target, unitOf(g.grain));
  for (const option of l.grains?.options ?? []) {
    const unit = option.axis.grain as Unit;
    if (unit === g.grain) continue;
    lineCheck(`line@${unit}`, option.axis, option.series, option.target, unit);
  }

  for (const [id, col] of [
    ["r", "region"],
    ["ch", "channel"],
  ] as const) {
    const bar = data.blocks.find((b) => b.id === id) as BarData;
    if (expectHidden(`bar ${id}`, bar.target?.hidden)) continue;
    if (bar.axis.kind !== "category") continue;
    if (hasCol(col)) {
      const asks = bar.axis.categories.map((c) => windowAsk(dimKey(col, c)));
      pending.push(
        tag(id, () => {
          asks.forEach((a, i) => {
            const want = a();
            if (want.value === null) missingB.add(current);
            if (want.prorated) proratedB.add(current);
            const got = bar.series[0]?.target;
            if (!close(got?.values[i], want.value))
              fail(`bar ${id} value[${i}]`, got?.values[i], want.value);
            if (!close(got?.pace?.[i] ?? null, want.pace ?? null))
              fail(`bar ${id} pace[${i}]`, got?.pace?.[i], want.pace);
          });
          if (bar.target?.window !== undefined)
            fail(`bar ${id} window`, bar.target.window, undefined);
        }),
      );
    } else {
      const a = windowAsk(mainKey);
      pending.push(
        tag(id, () => {
          const want = a();
          if (want.value === null) missingB.add(current);
          if (want.prorated) proratedB.add(current);
          if (!close(bar.target?.window?.value, want.value))
            fail(`bar ${id} window`, bar.target?.window, want);
          if (!close(bar.target?.window?.pace, want.pace))
            fail(`bar ${id} window pace`, bar.target?.window, want);
          if (bar.series.some((s) => s.target !== undefined))
            fail(`bar ${id} series target`, "present", undefined);
        }),
      );
    }
  }

  const s = data.blocks.find((b) => b.id === "s") as BarData;
  if (!expectHidden("split", s.target?.hidden, g.barGrain) && s.axis.kind === "time") {
    const total = seriesAsk(mainKey, s.axis.buckets, g.barGrain);
    const per = s.series.map((one) =>
      hasCol("region")
        ? seriesAsk(
            dimKey("region", one.splitValue),
            (s.axis as LineData["axis"]).buckets,
            g.barGrain,
          )
        : undefined,
    );
    pending.push(
      tag("s", () => {
        compareSeries("split total", s.target, total());
        s.series.forEach((one, i) => {
          const w = per[i];
          if (w === undefined) {
            if (one.target !== undefined) fail(`split ${one.label} target`, one.target, undefined);
          } else compareSeries(`split ${one.label}`, one.target, w());
        });
      }),
    );
  }

  const m = data.blocks.find((b) => b.id === "m") as LineData;
  const owner = bOwner ? "order_count" : metricName;
  if (m.target?.metric !== owner) fail("multi owner", m.target?.metric, owner);
  const mHidden = bOwner ? (bHidden ? ["filter", "segment"] : []) : undefined;
  if (mHidden !== undefined && mHidden.length > 0) {
    if (!mHidden.includes(String(m.target?.hidden)))
      fail("multi hidden", m.target?.hidden, mHidden);
  } else if (mHidden !== undefined) {
    if (m.target?.hidden !== undefined) fail("multi hidden", m.target?.hidden, undefined);
    else {
      const w = seriesAsk(bKey, (m.axis as LineData["axis"]).buckets, g.grain);
      pending.push(
        tag("m", () => {
          const ownerSeries = m.series.find((x) => x.metric === "order_count");
          compareSeries("multi", ownerSeries?.target, w());
          for (const x of m.series)
            if (x.metric !== "order_count" && x.target)
              fail("multi non-owner target", x.metric, undefined);
        }),
      );
    }
  } else if (!expectHidden("multi", m.target?.hidden, g.grain)) {
    const w = seriesAsk(mainKey, m.axis.buckets, g.grain);
    pending.push(
      tag("m", () => {
        compareSeries("multi", m.series.find((x) => x.metric === metricName)?.target, w());
        for (const x of m.series)
          if (x.metric !== metricName && x.target)
            fail("multi non-owner target", x.metric, undefined);
      }),
    );
  }

  const solved = await flow.solve(g);
  flows = solved.flows;
  points = solved.points;
  for (const p of pending) p();

  if (proratedB.size > 0) stats.prorated++;
  if (g.kind === "point") stats.points++;
  stats.paces += JSON.stringify(data).split('"pace"').length - 1;
  const INDEX: Record<string, number> = { k: 0, l: 1, r: 2, ch: 3, s: 4, m: 5 };
  const at = (code: string, id: string) =>
    diagnostics.some((d) => d.code === code && d.pointer === `/blocks/${INDEX[id]}/target`);
  for (const id of proratedB) if (!at("HM4022", id)) fail(`HM4022 on ${id}`, [...codes], "HM4022");
  for (const id of missingB) if (!at("HM4020", id)) fail(`HM4020 on ${id}`, [...codes], "HM4020");
  void codes;

  const refs = checkReferences(project).filter(
    (d) => d.code === "HM4021" && d.pointer === "/blocks/0/target",
  );
  const staticSelect = g.select !== undefined && !hasCol("region");
  const staticSeg =
    g.segment !== undefined &&
    ["online", "large"].some((x) => (g.declared ? !g.declared.includes(x) : !hasCol(segCol(x))));
  const wantRefs = (staticSelect ? 1 : 0) + (staticSeg ? 1 : 0);
  if (refs.length !== wantRefs)
    fail(
      "HM4021 static",
      refs.map((d) => d.message),
      wantRefs,
    );
  if (g.kind === "flow") {
    const notes = explainDefaults(project).filter(
      (d) =>
        d.code === "HM4040" &&
        d.pointer === "/targets/0" &&
        d.file === `metrics/${metricName}.yaml`,
    );
    const wantNote = g.additive && g.prorateSpec === undefined ? 1 : 0;
    if (notes.length !== wantNote)
      fail(
        "HM4040",
        notes.map((d) => d.message),
        wantNote,
      );
  }
  return errors;
}

function describeCase(g: Gen) {
  const { rows, bRows, ...rest } = g;
  return JSON.stringify({ ...rest, rows: rows.length, bRows: bRows?.length });
}

describe("targets against a separately written oracle", () => {
  it(`sweeps ${CASES} seeded projects`, async () => {
    const failures: string[] = [];
    const seeds = ONLY
      ? ONLY.split(",").map(Number)
      : Array.from({ length: CASES }, (_, i) => SEED0 + i);
    for (const seed of seeds) {
      const built = await build(seed);
      const errors = await oracle(built);
      if (errors.length > 0)
        failures.push(
          `seed ${seed} ${describeCase(built.g)}\n  ${errors.slice(0, 6).join("\n  ")}`,
        );
      if (failures.length >= 12) break;
    }
    console.log(JSON.stringify(stats));
    if (failures.length > 0) console.log(`FAILURES\n${failures.join("\n")}`);
    expect(failures).toEqual([]);
  });
});
