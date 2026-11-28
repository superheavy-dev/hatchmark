import { mkdir } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  assemble,
  type BarData,
  type DashboardData,
  executionContext,
  type KpiData,
  type LineData,
  planDashboard,
  type QueryResult,
  queryBounds,
  type Series,
} from "../../src/compiler/index.js";
import { createDuckDbExecutor } from "../../src/node/index.js";
import { PROJECT_DEFAULTS } from "../../src/spec/index.js";
import { metric, Oracle, removeProjects, writeProject } from "./fixture.js";

vi.setConfig({ testTimeout: 600_000, hookTimeout: 120_000 });

const FULL = process.env.HM_SWEEP === "full";
const CASES = Number(process.env.HM_TARGET_CASES ?? (FULL ? 400 : 40));
const SEED0 = Number(process.env.HM_TARGET_SEED ?? 1);

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

type Unit = "day" | "week" | "month" | "quarter" | "year";
type G = { unit: Unit; anchor?: string };
const DAY = 86_400_000;
const RANK: Record<Unit, number> = { day: 0, week: 1, month: 2, quarter: 3, year: 4 };
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const REGIONS = ["Americas", "EMEA", "APAC"];

const ms = (date: string) => Date.parse(`${date}T00:00:00Z`);
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
function plusMonths(date: string, n: number): string {
  const t = new Date(ms(date));
  t.setUTCMonth(t.getUTCMonth() + n);
  return iso(t.getTime());
}
function startOf(date: string, g: G): string {
  if (g.unit === "day") return date;
  if (g.unit === "month") return `${date.slice(0, 8)}01`;
  if (g.unit === "week") {
    const back = (new Date(ms(date)).getUTCDay() - WEEKDAYS.indexOf(g.anchor ?? "") + 7) % 7;
    return iso(ms(date) - back * DAY);
  }
  const step = g.unit === "quarter" ? 3 : 12;
  let s = `${date.slice(0, 4)}-${g.anchor}`;
  while (s > date) s = plusMonths(s, -12);
  while (plusMonths(s, step) <= date) s = plusMonths(s, step);
  return s;
}
function endOf(start: string, g: G): string {
  if (g.unit === "day") return iso(ms(start) + DAY);
  if (g.unit === "week") return iso(ms(start) + 7 * DAY);
  return plusMonths(start, g.unit === "month" ? 1 : g.unit === "quarter" ? 3 : 12);
}

interface Spec {
  grain: G;
  additive: boolean;
  prorate: "days" | "none";
  kind: "flow" | "point";
  path: "linear" | "compound";
}

function flowOracle(
  values: Map<string, number>,
  t: Spec,
  s: string,
  e: string,
): { value: number | null; prorated: boolean } {
  if (s >= e) return { value: null, prorated: false };
  const list: string[] = [];
  for (let b = startOf(s, t.grain); b < e; b = endOf(b, t.grain)) list.push(b);
  if (!t.additive && list.length !== 1) return { value: null, prorated: false };
  let sum = 0;
  let prorated = false;
  for (const b of list) {
    const v = values.get(b);
    if (v === undefined) return { value: null, prorated: false };
    const be = endOf(b, t.grain);
    const lo = b > s ? b : s;
    const hi = be < e ? be : e;
    if (lo === b && hi === be) {
      sum += v;
    } else {
      if (!t.additive || t.prorate !== "days") return { value: null, prorated: false };
      sum += (v * (ms(hi) - ms(lo))) / (ms(be) - ms(b));
      prorated = true;
    }
  }
  return { value: sum, prorated };
}

function pointOracle(values: Map<string, number>, t: Spec, at: number): number | null {
  const pts = [...values.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([b, v]) => ({ at: ms(endOf(b, t.grain)), v }));
  const first = pts[0];
  const last = pts[pts.length - 1];
  if (first === undefined || last === undefined || at < first.at || at > last.at) return null;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[i + 1];
    if (p === undefined) break;
    if (at === p.at) return p.v;
    if (q === undefined || at > q.at) continue;
    const f = (at - p.at) / (q.at - p.at);
    if (t.path === "linear") return p.v + (q.v - p.v) * f;
    return p.v > 0 && q.v > 0 ? p.v * Math.exp(Math.log(q.v / p.v) * f) : null;
  }
  return null;
}

function wallMs(instant: string, tz: string): number {
  const t = Date.parse(instant.replace(/(\.\d{3})\d*Z$/, "$1Z"));
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(new Date(t))
      .map((p) => [p.type, p.value]),
  );
  return (
    Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
      Number(parts.second),
    ) +
    (t % 1000)
  );
}

const wall = (text: string) => Date.parse(`${text.slice(0, 23)}Z`);

const RANGES: unknown[] = [
  "month_to_date",
  "quarter_to_date",
  "year_to_date",
  "last_30_days",
  "last_90_days",
  "last_12_months",
  "last_complete_month",
  "last_complete_quarter",
  { last: 3, unit: "week" },
  "explicit",
];

interface Case {
  label: string;
  tz: string;
  spec: Spec;
  inline: boolean;
  rows: { date: string; region: string; value: number | null }[];
  range: unknown;
  rangeKind: "to_date" | "last" | "written";
  fixed?: string;
  select?: string;
  grain: Unit;
  barGrain: Unit;
  clip: boolean;
  anchors: { week: string; quarter: string; year: string };
}

let oracle: Oracle;
beforeAll(async () => {
  oracle = await Oracle.open();
});
afterAll(async () => {
  oracle?.close();
  await removeProjects();
});

const quote = (s: string) => `'${s.replaceAll("'", "''")}'`;

async function makeCase(seed: number) {
  const random = rng(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(random() * xs.length)] as T;
  const maybe = (p: number) => random() < p;
  const tz = pick([
    "UTC",
    "America/New_York",
    "Asia/Seoul",
    "America/Los_Angeles",
    "America/Havana",
  ]);
  const yearAnchor = pick(["01-01", "02-01", "04-01", "07-01", "10-15"]);
  const anchors = {
    week: pick(["monday", "sunday", "wednesday"]),
    quarter: yearAnchor,
    year: yearAnchor,
  };
  const unitOf = (u: Unit): G =>
    u === "week"
      ? { unit: u, anchor: anchors.week }
      : u === "quarter" || u === "year"
        ? { unit: u, anchor: yearAnchor }
        : { unit: u };
  const additive = maybe(0.85);
  const targetUnit = pick<Unit>(["day", "week", "month", "month", "quarter", "year"]);
  const prorateSpec = additive
    ? pick([undefined, "days", "none"] as const)
    : pick([undefined, "none"] as const);
  const kind = maybe(0.3) ? "point" : "flow";
  const spec: Spec = {
    grain: unitOf(targetUnit),
    additive,
    prorate: prorateSpec ?? (additive ? "days" : "none"),
    kind,
    path: pick(["linear", "compound"] as const),
  };
  const end = Date.UTC(2026, 10, 26, 14, 3) + Math.floor(random() * 200) * DAY;
  const lastDay = iso(end);
  const fixed = maybe(0.3) ? iso(end - Math.floor(random() * 40) * DAY - DAY) : undefined;
  const inline = maybe(0.5);
  const gaps = maybe(0.5);
  const missing = new Set<number>();
  const buckets: string[] = [];
  for (
    let b = startOf(iso(end - 800 * DAY), spec.grain);
    b < iso(end + 400 * DAY);
    b = endOf(b, spec.grain)
  ) {
    buckets.push(b);
  }
  if (gaps) for (let k = 0; k < 2; k++) missing.add(Math.floor(random() * buckets.length));
  const rows: Case["rows"] = [];
  buckets.forEach((b, i) => {
    if (missing.has(i)) return;
    const total = 100 + Math.floor(random() * 9900) + (maybe(0.3) ? 0.25 : 0);
    if (inline) {
      rows.push({ date: b, region: "", value: total });
      return;
    }
    const share = [random(), random(), random()];
    const sum = share.reduce((a, c) => a + c, 0);
    const bucketDays = (ms(endOf(b, spec.grain)) - ms(b)) / DAY;
    const blank = maybe(0.04);
    REGIONS.forEach((region, r) => {
      const value =
        blank || maybe(0.05) ? null : Math.round(((total * (share[r] ?? 0)) / sum) * 100) / 100;
      const date = maybe(0.2) ? iso(ms(b) + Math.floor(random() * bucketDays) * DAY) : b;
      rows.push({ date, region, value });
    });
  });
  let range = pick(RANGES);
  if (range === "explicit") {
    const start = iso(end - Math.floor(random() * 120) * DAY - 20 * DAY);
    range = { start, end: iso(ms(start) + (1 + Math.floor(random() * 90)) * DAY) };
  }
  const rangeKind =
    typeof range === "string" && range.endsWith("_to_date")
      ? "to_date"
      : (typeof range === "string" &&
            range.startsWith("last_") &&
            !range.startsWith("last_complete")) ||
          (typeof range === "object" && range !== null && "last" in range)
        ? "last"
        : "written";
  const shortRange =
    range === "month_to_date" ||
    range === "last_30_days" ||
    (typeof range === "object" && range !== null && "last" in range);
  const grains: Unit[] = shortRange
    ? ["day", "week", "month"]
    : ["week", "month", "quarter", "year"];
  const select = maybe(0.3) ? pick(REGIONS) : undefined;
  const metricName = additive ? "revenue" : "average";
  const target = {
    id: "t",
    label: "Plan",
    grain: targetUnit,
    ...(inline
      ? { values: Object.fromEntries(rows.map((r) => [r.date, r.value])) }
      : { table: "plan", date: "day", value: "amount" }),
    ...(prorateSpec === undefined ? {} : { prorate: prorateSpec }),
  };
  const grain = pick(grains);
  const barGrain = pick(grains);
  const clip = maybe(0.3);
  const files: Record<string, unknown> = {
    "hatchmark.yaml": {
      ...PROJECT_DEFAULTS,
      name: "targets-oracle",
      timezone: tz,
      anchors,
      sources: {
        orders: { type: "parquet", path: "data/orders.parquet" },
        plan: { type: "csv", path: "data/plan.csv" },
      },
    },
    "data/plan.csv": [
      "day,region,amount",
      ...rows.filter(() => !inline).map((r) => `${r.date},${r.region},${r.value ?? ""}`),
    ].join("\n"),
    [`metrics/${metricName}.yaml`]: metric({
      type: "aggregate",
      table: "orders",
      aggregate: additive ? "sum" : "avg",
      column: "amount",
      time: "ordered_at",
      targets: [target],
    }),
    "dashboards/d.yaml": {
      title: "D",
      period: { asOf: fixed ?? "latest_data", range, compare: "none" },
      ...(select
        ? { filters: [{ type: "select", id: "region", column: "region", default: select }] }
        : {}),
      blocks: [
        { type: "kpi", id: "k", metric: metricName, target: "t" },
        {
          type: "line",
          id: "l",
          metrics: [metricName],
          grain,
          ...(clip ? { edges: "clip" } : {}),
          target: "t",
        },
        { type: "bar", id: "c", metrics: [metricName], by: "region", target: "t" },
        {
          type: "bar",
          id: "s",
          metrics: [metricName],
          grain: barGrain,
          split: "region",
          target: "t",
        },
      ],
    },
  };
  const { root, project } = await writeProject(files);
  await mkdir(path.join(root, "data"), { recursive: true });
  const orders: string[] = [];
  const n = 80 + Math.floor(random() * 120);
  for (let i = 0; i < n; i++) {
    const at = i === 0 ? end : end - Math.floor(random() * 420 * DAY) - 1000;
    orders.push(
      "(TIMESTAMPTZ " +
        quote(new Date(at).toISOString()) +
        ", " +
        quote(pick(REGIONS)) +
        ", " +
        (Math.floor(random() * 25000) / 100).toFixed(2) +
        ")",
    );
  }
  await oracle.run("DROP TABLE IF EXISTS o");
  await oracle.run("CREATE TABLE o (ordered_at TIMESTAMPTZ, region VARCHAR, amount DOUBLE)");
  await oracle.run(`INSERT INTO o VALUES ${orders.join(", ")}`);
  await oracle.run(
    `COPY o TO ${quote(path.join(root, "data", "orders.parquet"))} (FORMAT parquet)`,
  );
  const c: Case = {
    label: JSON.stringify({
      seed,
      tz,
      spec,
      inline,
      gaps,
      range,
      fixed,
      select,
      grain,
      barGrain,
      clip,
      anchors,
      lastDay,
    }),
    tz,
    spec,
    inline,
    rows,
    range,
    rangeKind,
    ...(fixed ? { fixed } : {}),
    ...(select ? { select } : {}),
    grain,
    barGrain,
    clip,
    anchors,
  };
  return { c, root, project };
}

async function runCase(seed: number) {
  const { c, root, project } = await makeCase(seed);
  const config = project.config.spec;
  if (config === undefined) throw new Error("no config");
  const planned = planDashboard(project, "d");
  const plan = planned.plan;
  if (plan === undefined) throw new Error(JSON.stringify(planned.diagnostics));
  if (c.spec.kind === "point") {
    for (const block of plan.blocks) {
      for (const t of Object.values(block.targets ?? {})) {
        t.kind = "point";
        t.path = c.spec.path;
        delete t.additive;
        delete t.prorate;
      }
    }
  }
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
    return { c, data: out.data as DashboardData, diagnostics: out.diagnostics };
  } finally {
    await executor.close();
  }
}

const close = (a: unknown, b: number | null | undefined) =>
  b === null || b === undefined
    ? a === null || a === undefined
    : typeof a === "number" && Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b));

function check(seed: number, c: Case, data: DashboardData, codes: Set<string>): string[] {
  const errors: string[] = [];
  const fail = (what: string, got: unknown, want: unknown) =>
    errors.push(`${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  const values = (region?: string) => {
    const out = new Map<string, number>();
    for (const r of c.rows) {
      if (c.select && !c.inline && r.region !== c.select) continue;
      if (region !== undefined && !c.inline && r.region !== region) continue;
      if (r.value === null) continue;
      const b = startOf(r.date, c.spec.grain);
      out.set(b, (out.get(b) ?? 0) + r.value);
    }
    return out;
  };
  const through = data.horizons.find((h) => h.source === "orders")?.through ?? "";
  const horizon = Math.min(
    wallMs(through, c.tz),
    c.fixed === undefined ? Number.POSITIVE_INFINITY : ms(c.fixed) + DAY,
  );
  const hiddenFilter = c.select !== undefined && c.inline;
  let prorated = false;
  let missing = false;

  const k = data.blocks.find((b) => b.id === "k") as KpiData;
  const windowTarget = (vals: Map<string, number>) => {
    const span = k.current;
    if (span === undefined) return { value: null as number | null };
    const endAt = span.endAt === undefined ? ms(span.end) : wall(span.endAt);
    if (c.spec.kind === "point") return { value: pointOracle(vals, c.spec, endAt) };
    const period =
      c.rangeKind === "to_date"
        ? {
            start: data.period.current?.start ?? "",
            end: endOf(
              data.period.current?.start ?? "",
              (() => {
                const unit = (c.range as string).replace("_to_date", "") as Unit;
                return unit === "quarter" || unit === "year"
                  ? { unit, anchor: c.anchors.year }
                  : { unit };
              })(),
            ),
          }
        : c.rangeKind === "last"
          ? { start: span.start, end: span.end }
          : { start: data.period.current?.start ?? "", end: data.period.current?.end ?? "" };
    const full = flowOracle(vals, c.spec, period.start, period.end);
    prorated ||= full.prorated;
    if (full.value === null) return { value: null };
    const stop = ms(period.end);
    if (endAt >= stop || !c.spec.additive) return { value: full.value };
    const start = ms(period.start);
    return { value: full.value, pace: (full.value * (endAt - start)) / (stop - start) };
  };

  if (hiddenFilter) {
    if (k.target?.hidden !== "filter") fail("kpi hidden", k.target, "filter");
  } else {
    const want = windowTarget(values());
    if (want.value === null) missing = true;
    if (!close(k.target?.value, want.value)) fail("kpi value", k.target, want);
    if (!close(k.target?.pace, want.pace)) fail("kpi pace", k.target, want);
    const divisor = want.pace ?? want.value;
    const attainment =
      k.value === null || divisor === null || divisor === 0 ? null : k.value / divisor;
    if (!close(k.target?.attainment, attainment))
      fail("kpi attainment", k.target?.attainment, attainment);
  }

  const seriesWant = (axis: string[], g: G, vals: Map<string, number>, clipFrom?: string) => {
    const out = axis.map((b, i) => {
      const s = ms(b);
      const e = ms(endOf(b, g));
      if (c.spec.kind === "point") {
        return {
          value: pointOracle(vals, c.spec, s < horizon && horizon < e ? horizon : e),
          pace: null,
        };
      }
      const f = flowOracle(vals, c.spec, b, endOf(b, g));
      prorated ||= f.prorated;
      const from = i === 0 && clipFrom !== undefined && ms(clipFrom) > s ? ms(clipFrom) : s;
      const to = Math.min(horizon, e);
      const partial = from < horizon && (from > s || to < e);
      return {
        value: f.value,
        pace:
          partial && f.value !== null && c.spec.additive ? (f.value * (to - from)) / (e - s) : null,
      };
    });
    if (out.some((o) => o.value === null)) missing = true;
    return out;
  };
  const sameSeries = (
    what: string,
    got: Series["target"],
    want: { value: number | null; pace: number | null }[],
  ) => {
    want.forEach((w, i) => {
      if (!close(got?.values[i], w.value)) fail(`${what} value[${i}]`, got?.values[i], w.value);
      if (!close(got?.pace?.[i] ?? null, w.pace))
        fail(`${what} pace[${i}]`, got?.pace?.[i], w.pace);
    });
    if ((got?.values.length ?? 0) !== want.length)
      fail(`${what} length`, got?.values.length, want.length);
  };
  const hiddenGrain = (unit: Unit) =>
    c.spec.kind === "flow" && c.spec.prorate === "none" && RANK[unit] < RANK[c.spec.grain.unit];
  const gOf = (unit: Unit): G =>
    unit === "week"
      ? { unit, anchor: c.anchors.week }
      : unit === "quarter" || unit === "year"
        ? { unit, anchor: c.anchors.year }
        : { unit };

  const l = data.blocks.find((b) => b.id === "l") as LineData;
  const lHidden = hiddenFilter ? "filter" : hiddenGrain(c.grain) ? "grain" : undefined;
  if (lHidden !== undefined) {
    if (l.target?.hidden !== lHidden) fail("line hidden", l.target, lHidden);
  } else {
    sameSeries(
      "line",
      l.series[0]?.target,
      seriesWant(l.axis.buckets, gOf(c.grain), values(), c.clip ? l.axis.window.start : undefined),
    );
  }

  const bar = data.blocks.find((b) => b.id === "c") as BarData;
  if (hiddenFilter) {
    if (bar.target?.hidden !== "filter") fail("bar hidden", bar.target, "filter");
  } else if (c.inline) {
    const want = windowTarget(values());
    if (!close(bar.target?.window?.value, want.value)) fail("bar window", bar.target, want);
    if (!close(bar.target?.window?.pace, want.pace)) fail("bar window pace", bar.target, want);
  } else if (bar.axis.kind === "category") {
    bar.axis.categories.forEach((region, i) => {
      const want = windowTarget(values(String(region)));
      if (want.value === null) missing = true;
      if (!close(bar.series[0]?.target?.values[i], want.value))
        fail(`bar ${region}`, bar.series[0]?.target, want);
      if (!close(bar.series[0]?.target?.pace?.[i] ?? null, want.pace ?? null))
        fail(`bar pace ${region}`, bar.series[0]?.target, want);
    });
  }

  const s = data.blocks.find((b) => b.id === "s") as BarData;
  const sHidden = hiddenFilter ? "filter" : hiddenGrain(c.barGrain) ? "grain" : undefined;
  if (sHidden !== undefined) {
    if (s.target?.hidden !== sHidden) fail("split hidden", s.target, sHidden);
  } else if (s.axis.kind === "time") {
    const buckets = s.axis.buckets;
    const total = seriesWant(buckets, gOf(c.barGrain), values());
    sameSeries(
      "split total",
      { values: s.target?.values ?? [], ...(s.target?.pace ? { pace: s.target.pace } : {}) },
      total,
    );
    for (const one of s.series) {
      if (c.inline) {
        if (one.target !== undefined) fail(`split series ${one.label}`, one.target, undefined);
        continue;
      }
      sameSeries(
        `split ${one.label}`,
        one.target,
        seriesWant(buckets, gOf(c.barGrain), values(String(one.splitValue))),
      );
    }
  }

  if (prorated && !hiddenFilter && !codes.has("HM4022")) fail("HM4022", [...codes], "HM4022");
  if (missing && !codes.has("HM4020")) fail("HM4020", [...codes], "HM4020");
  return errors.map((e) => `seed ${seed} ${c.label}\n  ${e}`);
}

describe("targets against an independent oracle", () => {
  it(`sweeps ${CASES} seeded projects`, async () => {
    const failures: string[] = [];
    for (let seed = SEED0; seed < SEED0 + CASES; seed++) {
      const { c, data, diagnostics } = await runCase(seed);
      failures.push(...check(seed, c, data, new Set(diagnostics.map((d) => d.code))));
      if (failures.length > 20) break;
    }
    expect(failures.slice(0, 20)).toEqual([]);
  });
});
