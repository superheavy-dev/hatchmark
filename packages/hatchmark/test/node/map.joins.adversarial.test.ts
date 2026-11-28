import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { run as cli } from "../../src/cli/main.js";
import type { DashboardData, MapData } from "../../src/compiler/dashboard-data.js";
import { customRangeDashboard, type PeriodData } from "../../src/compiler/period-data.js";
import { PROJECT_DEFAULTS } from "../../src/spec/index.js";
import { Oracle, removeProjects, writeProject } from "./fixture.js";

const SWEEP = process.env.HM_SWEEP === "full";
const TZ = "America/New_York";
const DAY = 86_400_000;

type Status = "matched" | "not_drawn" | "ambiguous" | "unmatched";
type Truth = [raw: string | null, status: Status, id: string | null, weight: number][];

const US: Truth = [
  ...["CA", "ca", "California", "CALIFORNIA", "Califórnia", "06", "6", "Calif."].map(
    (r): Truth[number] => [r, "matched", "CA", 3],
  ),
  ...["TX", "Texas", "texas", "48", "US-TX"].map((r): Truth[number] => [r, "matched", "TX", 2]),
  ...["NY", "New York", "N.Y.", "36", "new york"].map((r): Truth[number] => [
    r,
    "matched",
    "NY",
    2,
  ]),
  ...["WA", "Washington", "53"].map((r): Truth[number] => [r, "matched", "WA", 1]),
  ...["DC", "District of Columbia", "Washington DC", "Washington, D.C.", "11"].map(
    (r): Truth[number] => [r, "matched", "DC", 1],
  ),
  ...["PR", "Puerto Rico", "72"].map((r): Truth[number] => [r, "matched", "PR", 1]),
  ...["MA", "Massachusetts", "Mass.", "25"].map((r): Truth[number] => [r, "matched", "MA", 1]),
  ...["FL", "Florida", "12"].map((r): Truth[number] => [r, "matched", "FL", 1]),
  ["Georgia", "matched", "GA", 1],
  ["GA", "matched", "GA", 1],
  ["GU", "not_drawn", "GU", 1],
  ["Guam", "not_drawn", "GU", 1],
  ["VI", "not_drawn", "VI", 1],
  ["66", "not_drawn", "GU", 1],
  ["Carolina", "ambiguous", null, 1],
  ["Dakota", "ambiguous", null, 1],
  ["Narnia", "unmatched", null, 1],
  ["Calfornia", "unmatched", null, 1],
  ["Nowhere", "unmatched", null, 1],
  [null, "unmatched", null, 1],
  [" -06 ", "unmatched", null, 1],
  ["-6", "unmatched", null, 1],
  ["+6", "unmatched", null, 1],
];
const SESSIONS_ONLY: Truth = [
  ["Ohio", "matched", "OH", 2],
  ["OH", "matched", "OH", 1],
  ["Atlantis", "unmatched", null, 2],
];
const WORLD: Truth = [
  ...["US", "USA", "840", "United States", "united states of america"].map((r): Truth[number] => [
    r,
    "matched",
    "USA",
    3,
  ]),
  ...["GB", "UK", "United Kingdom", "gbr", "826"].map((r): Truth[number] => [
    r,
    "matched",
    "GBR",
    2,
  ]),
  ...["Côte d'Ivoire", "COTE D'IVOIRE", "CI", "384"].map((r): Truth[number] => [
    r,
    "matched",
    "CIV",
    1,
  ]),
  ...["Türkiye", "Turkey", "TR"].map((r): Truth[number] => [r, "matched", "TUR", 1]),
  ...["Korea, Rep.", "South Korea", "KR", "410"].map((r): Truth[number] => [
    r,
    "matched",
    "KOR",
    1,
  ]),
  ...["France", "FR", "250"].map((r): Truth[number] => [r, "matched", "FRA", 1]),
  ...["Norway", "NO", "578"].map((r): Truth[number] => [r, "matched", "NOR", 1]),
  ...["Germany", "DE", "276"].map((r): Truth[number] => [r, "matched", "DEU", 1]),
  ["Brazil", "matched", "BRA", 1],
  ["Singapore", "not_drawn", "SGP", 1],
  ["SG", "not_drawn", "SGP", 1],
  ["Hong Kong", "not_drawn", "HKG", 1],
  ["Congo", "ambiguous", null, 1],
  ["Korea", "ambiguous", null, 1],
  ["Holland", "unmatched", null, 1],
  ["Atlantis", "unmatched", null, 1],
  [null, "unmatched", null, 1],
];
const FIPS: Truth = [
  ["6", "matched", "CA", 3],
  ["48", "matched", "TX", 2],
  ["36", "matched", "NY", 2],
  ["11", "matched", "DC", 1],
  ["72", "matched", "PR", 1],
  ["25", "matched", "MA", 1],
  ["66", "not_drawn", "GU", 1],
  ["99", "unmatched", null, 1],
  [null, "unmatched", null, 1],
];

const START = Date.parse("2026-09-20T00:00:00Z");
const H_ORDERS = Date.parse("2026-11-27T15:42:10Z");
const H_SESSIONS = Date.parse("2026-11-26T20:00:00Z");
const STORES_LAST = "2026-11-20";

function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = seeded(120);
const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)] as T;
const weighted = (t: Truth) => {
  const total = t.reduce((n, e) => n + e[3], 0);
  let x = rand() * total;
  for (const e of t) {
    x -= e[3];
    if (x < 0) return e[0];
  }
  return t[0]?.[0] ?? null;
};
const cell = (v: string | number | null) => {
  if (v === null) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};
const stamp = (t: number) => `${new Date(t).toISOString().slice(0, 19)}Z`;

function generate() {
  const n = SWEEP ? 40000 : 6000;
  const orders: string[] = ["order_id,ordered_at,state,country,channel,status,customer_id,amount"];
  let id = 1;
  const order = (t: number, state: string | null, customer?: string) => {
    const amount =
      rand() < 0.03 ? null : ((rand() < 0.03 ? -1 : 1) * (5 + rand() * 300)).toFixed(2);
    orders.push(
      [
        id++,
        stamp(t),
        state,
        weighted(WORLD),
        rand() < 0.05 ? null : pick(["web", "store", "partner"]),
        rand() < 0.15 ? "refunded" : "paid",
        customer ?? `C${String(Math.floor(rand() * 400)).padStart(4, "0")}`,
        amount,
      ]
        .map(cell)
        .join(","),
    );
  };
  for (let i = 0; i < n; i++) order(START + Math.floor(rand() * (H_ORDERS - START)), weighted(US));
  for (const [t, s] of [
    ["2026-10-28T03:59:59Z", "California"],
    ["2026-10-28T04:00:00Z", "06"],
    ["2026-11-27T04:59:59Z", "CA"],
    ["2026-11-27T05:00:00Z", "6"],
    ["2026-11-26T20:00:00Z", "Calif."],
    ["2026-11-26T20:00:01Z", "California"],
  ] as const)
    order(Date.parse(t), s, "C9999");
  order(H_ORDERS, "Texas");
  const sessions: string[] = ["session_id,started_at,state,channel"];
  const both: Truth = [...US, ...SESSIONS_ONLY];
  for (let i = 0; i < n * 2; i++) {
    const t = START + Math.floor(rand() * (H_SESSIONS - START));
    sessions.push(
      [id++, stamp(t), weighted(both), pick(["web", "store", "partner"])].map(cell).join(","),
    );
  }
  sessions.push([id++, stamp(H_SESSIONS), "CA", "web"].map(cell).join(","));
  const stores: string[] = ["store_id,opened,fips,sales"];
  const first = Date.parse("2026-09-20T00:00:00Z");
  const last = Date.parse(`${STORES_LAST}T00:00:00Z`);
  for (let i = 0; i < 400; i++) {
    const d = new Date(first + Math.floor(rand() * ((last - first) / DAY + 1)) * DAY)
      .toISOString()
      .slice(0, 10);
    stores.push([id++, d, weighted(FIPS), (rand() * 1000).toFixed(2)].map(cell).join(","));
  }
  stores.push([id++, STORES_LAST, "6", "10.00"].join(","));
  return {
    orders: `${orders.join("\n")}\n`,
    sessions: `${sessions.join("\n")}\n`,
    stores: `${stores.join("\n")}\n`,
  };
}

const paid = [{ column: "status", op: "eq", value: "paid" }];
const m = (spec: Record<string, unknown>) => ({
  label: "Metric",
  format: { type: "number" },
  better: "up",
  ...spec,
});
const METRICS: Record<string, Record<string, unknown>> = {
  revenue: m({
    type: "aggregate",
    table: "orders",
    time: "ordered_at",
    aggregate: "sum",
    column: "amount",
    filters: paid,
  }),
  orders: m({
    type: "aggregate",
    table: "orders",
    time: "ordered_at",
    aggregate: "count",
    filters: paid,
  }),
  customers: m({
    type: "aggregate",
    table: "orders",
    time: "ordered_at",
    aggregate: "count_distinct",
    column: "customer_id",
    filters: paid,
  }),
  largest: m({
    type: "aggregate",
    table: "orders",
    time: "ordered_at",
    aggregate: "max",
    column: "amount",
    filters: paid,
  }),
  sessions: m({ type: "aggregate", table: "sessions", time: "started_at", aggregate: "count" }),
  store_sales: m({
    type: "aggregate",
    table: "stores",
    time: "opened",
    aggregate: "sum",
    column: "sales",
  }),
  aov: m({ type: "ratio", numerator: "revenue", denominator: "orders" }),
  rpc: m({ type: "ratio", numerator: "revenue", denominator: "customers" }),
  conversion: m({ type: "ratio", numerator: "orders", denominator: "sessions" }),
};

const PAID = "x.status = 'paid'";
const LEAF: Record<string, { table: string; time: string; agg: string; additive: boolean }> = {
  revenue: {
    table: "orders",
    time: "ordered_at",
    agg: `coalesce(sum(x.amount::DOUBLE) FILTER (WHERE ${PAID}), 0)`,
    additive: true,
  },
  orders: {
    table: "orders",
    time: "ordered_at",
    agg: `count(*) FILTER (WHERE ${PAID})`,
    additive: true,
  },
  customers: {
    table: "orders",
    time: "ordered_at",
    agg: `count(DISTINCT x.customer_id) FILTER (WHERE ${PAID})`,
    additive: false,
  },
  largest: {
    table: "orders",
    time: "ordered_at",
    agg: `max(x.amount::DOUBLE) FILTER (WHERE ${PAID})`,
    additive: false,
  },
  sessions: { table: "sessions", time: "started_at", agg: "count(*)", additive: true },
  store_sales: {
    table: "stores",
    time: "opened",
    agg: "coalesce(sum(x.sales::DOUBLE), 0)",
    additive: true,
  },
};
const RATIO: Record<string, [string, string]> = {
  aov: ["revenue", "orders"],
  rpc: ["revenue", "customers"],
  conversion: ["orders", "sessions"],
};
const leaves = (metric: string) => RATIO[metric] ?? [metric];
const sourcesOf = (metric: string) => [
  ...new Set(leaves(metric).map((l) => (LEAF[l] as { table: string }).table)),
];

interface MapSpec {
  id: string;
  geo: "us-states" | "world-countries";
  column: string;
  value: string;
}
const US_MAPS: MapSpec[] = [
  "revenue",
  "orders",
  "customers",
  "largest",
  "aov",
  "rpc",
  "conversion",
].map((v) => ({
  id: `us_${v}`,
  geo: "us-states",
  column: "state",
  value: v,
}));
const MAPS: MapSpec[] = [
  ...US_MAPS,
  { id: "w_revenue", geo: "world-countries", column: "country", value: "revenue" },
  { id: "w_rpc", geo: "world-countries", column: "country", value: "rpc" },
  { id: "fips_sales", geo: "us-states", column: "fips", value: "store_sales" },
];
const block = (s: MapSpec) => ({
  type: "map",
  id: s.id,
  geo: s.geo,
  region: s.column,
  value: s.value,
});
const PERIOD = {
  type: "period",
  id: "period",
  options: [{ last: 7, unit: "day" }, { last: 30, unit: "day" }, { to_date: "month" }],
  default: { last: 30, unit: "day" },
};
interface Dash {
  title: string;
  channels?: string[];
  state?: string;
  maps: MapSpec[];
  spec: Record<string, unknown>;
}
const DASHBOARDS: Record<string, Dash> = {
  all: {
    title: "All maps",
    maps: MAPS,
    spec: {
      period: { asOf: "latest_data", range: "last_30_days", compare: "none" },
      filters: [PERIOD],
    },
  },
  web: {
    title: "Web and store, month to date",
    channels: ["web", "store"],
    maps: MAPS.filter((s) => s.column !== "fips"),
    spec: {
      period: { asOf: "latest_data", range: "month_to_date", compare: "none" },
      filters: [
        { ...PERIOD, default: { to_date: "month" } },
        {
          type: "select",
          id: "channel",
          column: "channel",
          multiple: true,
          default: ["web", "store"],
        },
      ],
    },
  },
  state: {
    title: "One spelling selected",
    state: "California",
    maps: US_MAPS.filter((s) => s.value !== "conversion"),
    spec: {
      period: { asOf: "latest_data", range: "last_30_days", compare: "none" },
      filters: [PERIOD, { type: "select", id: "state", column: "state", default: "California" }],
    },
  },
};

let root = "";
let db: Oracle;
let report: {
  diagnostics: { code: string; message: string; severity: string }[];
  maps?: unknown[];
};
let checkJson: { maps?: unknown[] };
const payloads: Record<string, PeriodData> = {};
const html: Record<string, string> = {};

const exec = async (args: string[]) => {
  let out = "";
  const code = await cli([...args, "--cwd", root], {
    stdout: (t) => {
      out += t;
    },
    stderr: () => {},
    cwd: root,
    env: {},
    stdoutIsTTY: false,
    isAgent: async () => false,
  });
  return { code, json: JSON.parse(out.trim().split("\n").pop() ?? "null") };
};

beforeAll(async () => {
  const data = generate();
  const files: Record<string, unknown> = {
    "hatchmark.yaml": {
      ...PROJECT_DEFAULTS,
      name: "Map joins",
      timezone: TZ,
      sources: {
        orders: { type: "csv", path: "orders.csv" },
        sessions: { type: "csv", path: "sessions.csv" },
        stores: { type: "csv", path: "stores.csv" },
      },
    },
    "orders.csv": data.orders,
    "sessions.csv": data.sessions,
    "stores.csv": data.stores,
  };
  for (const [name, spec] of Object.entries(METRICS)) files[`metrics/${name}.yaml`] = spec;
  for (const [name, d] of Object.entries(DASHBOARDS))
    files[`dashboards/${name}.yaml`] = {
      title: d.title,
      ...d.spec,
      blocks: d.maps.map(block),
    };
  root = (await writeProject(files)).root;
  const built = await exec(["build", "--json"]);
  report = built.json;
  if (built.code !== 0) throw new Error(JSON.stringify(report).slice(0, 4000));
  checkJson = (await exec(["check", "--json"])).json;
  for (const name of Object.keys(DASHBOARDS)) {
    const page = await readFile(path.join(root, "dist", name, "index.html"), "utf8");
    html[name] = page;
    const p = /<script type="application\/json" data-hm-periods>(.*?)<\/script>/s.exec(page);
    if (p) payloads[name] = JSON.parse(p[1] as string);
  }
  db = await Oracle.open();
  for (const t of ["orders", "sessions", "stores"])
    await db.run(
      "CREATE TABLE " +
        t +
        " AS SELECT * FROM read_csv('" +
        path.join(root, `${t}.csv`).replaceAll("'", "''") +
        "', all_varchar = true)",
    );
  await db.run("CREATE TABLE truth (geo VARCHAR, raw VARCHAR, status VARCHAR, id VARCHAR)");
  const rows = [
    ...[...US, ...SESSIONS_ONLY].map((e) => ["us", ...e]),
    ...WORLD.map((e) => ["world", ...e]),
    ...FIPS.map((e) => ["fips", ...e]),
  ];
  const lit = (v: unknown) => (v === null ? "NULL" : `'${String(v).replaceAll("'", "''")}'`);
  await db.run(
    "INSERT INTO truth VALUES " +
      rows.map((r) => `(${r.slice(0, 4).map(lit).join(", ")})`).join(", "),
  );
}, 300_000);

afterAll(async () => {
  db?.close();
  await removeProjects();
});

const truthGeo = (s: MapSpec) =>
  s.column === "fips" ? "fips" : s.geo === "us-states" ? "us" : "world";
const localDate = (t: number) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(t));
const addDays = (d: string, n: number) =>
  new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const HORIZON: Record<string, number> = {
  orders: H_ORDERS,
  sessions: H_SESSIONS,
  stores: Date.parse(`${addDays(STORES_LAST, 1)}T05:00:00Z`),
};
const AS_OF = localDate(H_ORDERS);

interface Win {
  start: string;
  end: string;
  cut?: number;
}
function expectedWindow(metric: string, range: { last?: number; to_date?: string }): Win {
  const h = Math.min(...sourcesOf(metric).map((s) => HORIZON[s] as number));
  const complete = localDate(h) < addDays(AS_OF, 1) ? localDate(h) : addDays(AS_OF, 1);
  if (range.to_date === "month") {
    const start = `${AS_OF.slice(0, 8)}01`;
    return sourcesOf(metric).includes("stores")
      ? { start, end: complete }
      : { start, end: addDays(AS_OF, 1), cut: h };
  }
  return { start: addDays(complete, -(range.last as number)), end: complete };
}

function where(s: MapSpec, leaf: string, w: Win, d: Dash): string {
  const { time } = LEAF[leaf] as { time: string };
  const local =
    leaf === "store_sales"
      ? `x.${time}::DATE`
      : `CAST(timezone('${TZ}', x.${time}::TIMESTAMPTZ) AS DATE)`;
  const parts = [`${local} >= DATE '${w.start}'`, `${local} < DATE '${w.end}'`];
  if (w.cut !== undefined)
    parts.push(`x.${time}::TIMESTAMPTZ <= TIMESTAMPTZ '${new Date(w.cut).toISOString()}'`);
  const table = (LEAF[leaf] as { table: string }).table;
  if (d.channels && table !== "stores")
    parts.push(`x.channel IN (${d.channels.map((c) => `'${c}'`).join(", ")})`);
  if (d.state && table !== "stores")
    parts.push(
      "x.state IN (SELECT raw FROM truth WHERE geo = 'us' AND status = 'matched' AND id = (SELECT id FROM truth WHERE geo = 'us' AND raw = '" +
        d.state +
        "'))",
    );
  void s;
  return parts.join(" AND ");
}

async function leafBy(s: MapSpec, leaf: string, w: Win, d: Dash) {
  const { table, agg } = LEAF[leaf] as { table: string; agg: string };
  const col = `x.${s.column}`;
  const rows = await db.rows(
    "SELECT t.id, " +
      agg +
      " AS v FROM " +
      table +
      " x JOIN truth t ON t.geo = '" +
      truthGeo(s) +
      "' AND t.raw IS NOT DISTINCT FROM " +
      col +
      " WHERE t.status = 'matched' AND " +
      where(s, leaf, w, d) +
      " GROUP BY ROLLUP (t.id)",
  );
  const by = new Map<string | null, number | null>();
  for (const r of rows) by.set((r.id as string | null) ?? null, r.v === null ? null : Number(r.v));
  return by;
}

interface Expected {
  regions: Map<string, number | null>;
  total: number | null;
  additive: boolean;
  match: Map<string | null, { rows: number; status: Status; id: string | null }>;
  allKeys: Map<string | null, { rows: number; status: Status; table: string }>;
}

async function expected(s: MapSpec, w: Win, d: Dash): Promise<Expected> {
  const [a, b] = leaves(s.value) as [string, string | undefined];
  const num = await leafBy(s, a, w, d);
  const den = b === undefined ? undefined : await leafBy(s, b, w, d);
  const ids = new Set([...num.keys(), ...(den?.keys() ?? [])]);
  const regions = new Map<string, number | null>();
  let total: number | null = null;
  for (const id of ids) {
    const n = num.get(id) ?? (den !== undefined && LEAF[a]?.agg.startsWith("count") ? 0 : null);
    let v = n;
    if (den !== undefined) {
      const dv = den.get(id) ?? null;
      v = n === null || dv === null || dv === 0 ? null : n / dv;
    }
    if (id === null) total = v;
    else regions.set(id, v);
  }
  const match = new Map<string | null, { rows: number; status: Status; id: string | null }>();
  const allKeys = new Map<string | null, { rows: number; status: Status; table: string }>();
  for (const table of sourcesOf(s.value)) {
    const leaf = leaves(s.value).find(
      (l) => (LEAF[l] as { table: string }).table === table,
    ) as string;
    const own = leaves(s.value)
      .filter((l) => (LEAF[l] as { table: string }).table === table)
      .map((l) => /FILTER \(WHERE ([^)]*)\)/.exec((LEAF[l] as { agg: string }).agg)?.[1] ?? "TRUE");
    const rows = await db.rows(
      "SELECT x." +
        s.column +
        " AS k, t.status, t.id, count(*) AS n FROM " +
        table +
        " x LEFT JOIN truth t ON t.geo = '" +
        truthGeo(s) +
        "' AND t.raw IS NOT DISTINCT FROM x." +
        s.column +
        " WHERE " +
        where(s, leaf, w, d) +
        " AND (" +
        own.join(" OR ") +
        ") GROUP BY ALL",
    );
    for (const r of rows) {
      const k = (r.k as string | null) ?? null;
      if (r.status === null) throw new Error(`no truth for ${String(k)}`);
      const entry = {
        rows: Number(r.n),
        status: r.status as Status,
        id: (r.id as string | null) ?? null,
      };
      const seen = match.get(k);
      match.set(k, { ...entry, rows: (seen?.rows ?? 0) + entry.rows });
      const prev = allKeys.get(k);
      allKeys.set(k, {
        rows: (prev?.rows ?? 0) + entry.rows,
        status: entry.status,
        table: prev ? `${prev.table}+${table}` : table,
      });
    }
  }
  return {
    regions,
    total,
    additive: b === undefined && (LEAF[a] as { additive: boolean }).additive,
    match,
    allKeys,
  };
}

const close = (a: number | null | undefined, b: number | null | undefined) =>
  (a ?? null) === null || (b ?? null) === null
    ? (a ?? null) === (b ?? null)
    : Math.abs((a as number) - (b as number)) <= 1e-9 * Math.max(1, Math.abs(b as number));

function compareNumbers(map: MapData, e: Expected): string[] {
  const out: string[] = [];
  const ids = map.regions.map((r) => r.id);
  if (new Set(ids).size !== ids.length) out.push(`duplicate region ids ${ids.join(",")}`);
  const got = new Map(map.regions.map((r) => [r.id, r]));
  for (const [id, v] of e.regions) {
    const g = got.get(id);
    if (g === undefined) {
      if (v !== null && v !== 0) out.push(`${id}: missing, oracle ${v}`);
      continue;
    }
    if (!close(g.value as number | null, v)) out.push(`${id}: value ${g.value} oracle ${v}`);
  }
  for (const id of got.keys())
    if (!e.regions.has(id)) out.push(`${id}: on the map, oracle has no matched drawn rows`);
  if (!close(map.total as number | null, e.total)) out.push(`total ${map.total} oracle ${e.total}`);
  if (map.additive !== e.additive) out.push(`additive ${map.additive} oracle ${e.additive}`);
  const values = map.regions.flatMap((r) =>
    typeof r.value === "number" ? [e.regions.get(r.id) ?? null] : [],
  );
  for (const r of map.regions) {
    const ov = e.regions.get(r.id) ?? null;
    if (typeof r.value !== "number") {
      if (r.rank !== undefined || r.share !== undefined || r.class !== undefined)
        out.push(`${r.id}: null value carries rank/share/class`);
      continue;
    }
    const rank =
      1 + values.filter((v) => v !== null && ov !== null && v > ov && !close(v, ov)).length;
    if (r.rank !== rank) out.push(`${r.id}: rank ${r.rank} oracle ${rank}`);
    if (e.additive && e.total !== null && e.total !== 0) {
      if (!close(r.share, (ov as number) / e.total))
        out.push(`${r.id}: share ${r.share} oracle ${(ov as number) / e.total}`);
    } else if (r.share !== undefined) out.push(`${r.id}: share on a non-additive metric`);
    const k = map.scale.breaks.filter((b) => (r.value as number) >= b).length;
    if (r.class !== k)
      out.push(`${r.id}: class ${r.class} for breaks ${map.scale.breaks.join("/")}`);
  }
  const order = map.regions.map((r) => r.id);
  const sorted = [...map.regions].sort(
    (a, b) =>
      (typeof a.value === "number" ? 0 : 1) - (typeof b.value === "number" ? 0 : 1) ||
      Number(b.value ?? 0) - Number(a.value ?? 0) ||
      (a.id < b.id ? -1 : 1),
  );
  if (sorted.map((r) => r.id).join() !== order.join())
    out.push(`regions not highest first: ${order.join(",")}`);
  return out;
}

function compareMatch(map: MapData, e: Expected): string[] {
  const out: string[] = [];
  const got = new Map(map.match.map((m) => [m.key === null ? null : String(m.key), m]));
  for (const [k, x] of e.match) {
    const g = got.get(k);
    if (g === undefined) {
      out.push(`${JSON.stringify(k)}: ${x.rows} rows not in the match report`);
      continue;
    }
    if (g.rows !== x.rows) out.push(`${JSON.stringify(k)}: rows ${g.rows} oracle ${x.rows}`);
    const want = x.status === "matched" ? x.id : null;
    if (g.region !== want)
      out.push(`${JSON.stringify(k)}: region ${g.region} oracle ${want} (${x.status})`);
  }
  for (const [k, g] of got)
    if (!e.match.has(k) && g.rows !== 0)
      out.push(`${JSON.stringify(k)}: reported with ${g.rows} rows, oracle has none`);
  return out;
}

function silentlyDropped(map: MapData, e: Expected): string[] {
  const reported = new Map(map.match.map((m) => [m.key === null ? null : String(m.key), m.rows]));
  return [...e.allKeys].flatMap(([k, x]) =>
    x.status !== "matched" && reported.get(k) !== x.rows
      ? [
          JSON.stringify(k) +
            " " +
            x.status +
            ": " +
            x.rows +
            " rows in " +
            x.table +
            ", report says " +
            (reported.has(k) ? `${reported.get(k)} rows` : "nothing"),
        ]
      : [],
  );
}

const maps = (data: DashboardData) =>
  new Map(data.blocks.filter((b): b is MapData => b.type === "map").map((b) => [b.id, b]));
const rangeOf = (key: string) =>
  key.includes("to_date") || (key.includes("month") && !key.includes("last"))
    ? { to_date: "month" }
    : { last: Number(/(\d+)/.exec(key)?.[1]) };

const presets = () =>
  Object.entries(DASHBOARDS).flatMap(([name, d]) =>
    Object.keys((payloads[name] as PeriodData | undefined)?.presets ?? {}).map((key) => ({
      name,
      d,
      key,
    })),
  );

describe("map numbers against an independent DuckDB oracle", () => {
  it("lists the presets it checks", () => {
    expect(presets().length).toBeGreaterThanOrEqual(9);
  });

  it("every preset: region values, total, ranks, shares and classes", async () => {
    const problems: string[] = [];
    for (const { name, d, key } of presets()) {
      const data = (payloads[name] as PeriodData).presets[key] as DashboardData;
      for (const s of d.maps) {
        const map = maps(data).get(s.id) as MapData;
        const w = expectedWindow(s.value, rangeOf(key));
        if (map.window?.start !== w.start || (w.cut === undefined && map.window?.end !== w.end))
          problems.push(
            name +
              "/" +
              key +
              "/" +
              s.id +
              ": window " +
              JSON.stringify(map.window) +
              " expected " +
              JSON.stringify(w),
          );
        const e = await expected(s, w, d);
        for (const p of compareNumbers(map, e)) problems.push(`${name}/${key}/${s.id}: ${p}`);
      }
    }
    expect(problems).toEqual([]);
  }, 120_000);

  it("every preset: the match report lists every value of every source with its rows", async () => {
    const problems: string[] = [];
    for (const { name, d, key } of presets()) {
      const data = (payloads[name] as PeriodData).presets[key] as DashboardData;
      for (const s of d.maps) {
        const e = await expected(s, expectedWindow(s.value, rangeOf(key)), d);
        for (const p of compareMatch(maps(data).get(s.id) as MapData, e))
          problems.push(`${name}/${key}/${s.id}: ${p}`);
      }
    }
    expect(problems).toEqual([]);
  }, 120_000);

  it("no source's rows leave a map without being reported (two-source ratios)", async () => {
    const problems: string[] = [];
    for (const { name, d, key } of presets()) {
      const data = (payloads[name] as PeriodData).presets[key] as DashboardData;
      for (const s of d.maps) {
        const e = await expected(s, expectedWindow(s.value, rangeOf(key)), d);
        for (const p of silentlyDropped(maps(data).get(s.id) as MapData, e))
          problems.push(`${name}/${key}/${s.id}: ${p}`);
      }
    }
    expect(problems).toEqual([]);
  }, 120_000);

  it("custom ranges recompute maps from day cubes like the oracle", async () => {
    const problems: string[] = [];
    const p = payloads.all as PeriodData;
    const span = p.custom?.span;
    expect(span).toBeDefined();
    const windows: Win[] = [
      { start: "2026-11-01", end: "2026-11-27" },
      { start: "2026-10-15", end: "2026-10-16" },
      { start: "2026-10-28", end: "2026-11-10" },
    ];
    for (let i = 0; i < (SWEEP ? 20 : 0); i++) {
      const a = addDays("2026-09-21", Math.floor(rand() * 60));
      windows.push({ start: a, end: addDays(a, 1 + Math.floor(rand() * 20)) });
    }
    for (const w of windows) {
      const data = customRangeDashboard(p.custom as NonNullable<PeriodData["custom"]>, p.filter, w);
      for (const s of (DASHBOARDS.all as Dash).maps) {
        const map = maps(data).get(s.id) as MapData;
        if (map === undefined) continue;
        const horizon = Math.min(...sourcesOf(s.value).map((x) => HORIZON[x] as number));
        const ew = { ...w, end: w.end < localDate(horizon) ? w.end : localDate(horizon) };
        const e = await expected(s, ew, DASHBOARDS.all as Dash);
        if (s.value === "customers" || s.value === "rpc") {
          if (map.regions.some((r) => r.value !== null))
            problems.push(`${w.start}..${w.end}/${s.id}: distinct count from day cubes`);
          continue;
        }
        for (const x of [...compareNumbers(map, e), ...compareMatch(map, e)])
          problems.push(`${w.start}..${w.end}/${s.id}: ${x}`);
      }
    }
    expect(problems).toEqual([]);
  }, 120_000);

  it("the bar list and the map show the same regions, values, ranks and colours, with no Top-N cut", () => {
    const problems: string[] = [];
    for (const [name, d] of Object.entries(DASHBOARDS)) {
      const presetKey = Object.keys((payloads[name] as PeriodData).presets).find((k) =>
        name === "web" ? k.includes("month") : k.includes("30"),
      ) as string;
      const data = (payloads[name] as PeriodData).presets[presetKey] as DashboardData;
      const page = html[name] as string;
      for (const s of d.maps) {
        const fig = new RegExp(
          `<figure class="hm-chart hm-map" data-hm-map="${s.id}">(.*?)</figure>`,
          "s",
        ).exec(page)?.[1];
        if (!fig) {
          problems.push(`${name}/${s.id}: no figure`);
          continue;
        }
        const json = JSON.parse(
          /<script type="application\/json">(.*?)<\/script>/s.exec(fig)?.[1] ?? "{}",
        ) as {
          regions: Record<string, { v?: string; k?: string }>;
        };
        const list = [
          ...fig.matchAll(
            /<li data-hm-r="([^"]+)"><span class="hm-ml-k">([^<]*)<\/span><span class="hm-ml-n"[^>]*>[^<]*<\/span><span class="hm-ml-bar">(?:<i class="hm-bg-([^" ]+)"[^>]*><\/i>)?<\/span>/g,
          ),
        ].map((x) => ({ id: x[1] as string, rank: x[2] as string, color: x[3] }));
        const paths = new Map(
          [...fig.matchAll(/<path id="hm-[^"]+" d="[^"]*" data-hm-r="([^"]+)"([^>]*)\/>/g)].map(
            (x) => [x[1] as string, x[2] as string],
          ),
        );
        const shown = (maps(data).get(s.id) as MapData).regions;
        if (list.map((l) => l.id).join() !== shown.map((r) => r.id).join())
          problems.push(
            name +
              "/" +
              s.id +
              ": bar list " +
              list.map((l) => l.id).join() +
              " vs map data " +
              shown.map((r) => r.id).join(),
          );
        for (const l of list) {
          const r = shown.find((x) => x.id === l.id);
          if (String(r?.rank ?? "") !== l.rank)
            problems.push(`${name}/${s.id}/${l.id}: list rank ${l.rank} data ${r?.rank}`);
        }
        for (const l of list) {
          const p = paths.get(l.id) ?? "";
          const k = json.regions[l.id]?.k;
          if (k !== undefined && !k.startsWith(`#${l.rank} `))
            problems.push(`${name}/${s.id}/${l.id}: list rank ${l.rank} tooltip ${k}`);
          if (l.color !== undefined && !p.includes(l.color))
            problems.push(
              name +
                "/" +
                s.id +
                "/" +
                l.id +
                ": bar colour " +
                l.color +
                " not on its region (" +
                p.slice(0, 120) +
                ")",
            );
          if (l.color === undefined && !p.includes("hm-nodata"))
            problems.push(`${name}/${s.id}/${l.id}: no bar but region filled`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it("the note and the warnings count every row left off the default view", async () => {
    const problems: string[] = [];
    for (const [name, d] of Object.entries(DASHBOARDS)) {
      const page = html[name] as string;
      for (const s of d.maps) {
        const fig = new RegExp(`data-hm-map="${s.id}">(.*?)</figure>`, "s").exec(page)?.[1] ?? "";
        const note = /Not on the map: ([\d,]+) rows?/.exec(fig)?.[1];
        const range =
          (d.spec.period as { range: string }).range === "month_to_date"
            ? { to_date: "month" }
            : { last: 30 };
        const e = await expected(s, expectedWindow(s.value, range), d);
        const left = [...e.match.values()]
          .filter((x) => x.status !== "matched")
          .reduce((n, x) => n + x.rows, 0);
        if (Number((note ?? "0").replaceAll(",", "")) !== left)
          problems.push(`${name}/${s.id}: note ${note} oracle ${left}`);
        const diag = report.diagnostics.filter(
          (x) =>
            x.message.includes(`map "${s.id}"`) &&
            String((x as { file?: string }).file ?? "").endsWith(`${name}.yaml`),
        );
        const sum = (status: Status) =>
          [...e.match.values()].filter((x) => x.status === status).reduce((n, x) => n + x.rows, 0);
        for (const [code, status] of [
          ["HM5041", "unmatched"],
          ["HM5042", "ambiguous"],
          ["HM5043", "not_drawn"],
        ] as const) {
          const n = sum(status);
          const found = diag.filter((x) => x.code === code);
          if (n === 0 && found.length > 0) problems.push(`${name}/${s.id}: ${code} without rows`);
          if (n > 0 && found.length === 0)
            problems.push(`${name}/${s.id}: no ${code} for ${n} rows`);
          if (
            n > 0 &&
            code !== "HM5043" &&
            found.length > 0 &&
            !found.some((x) => x.message.includes(`${n} row`))
          )
            problems.push(
              name +
                "/" +
                s.id +
                ": " +
                code +
                " says " +
                found[0]?.message.slice(0, 80) +
                ", oracle " +
                n +
                " rows",
            );
          if (code === "HM5043" && found.length > 0) {
            const regions = new Set(
              [...e.match.values()].filter((x) => x.status === "not_drawn").map((x) => x.id),
            ).size;
            const says = found[0]?.message ?? "";
            if (!says.includes(regions === 1 ? "draw a region" : `draw ${regions} regions`))
              problems.push(
                name +
                  "/" +
                  s.id +
                  ": HM5043 says " +
                  says.slice(0, 120) +
                  ", oracle " +
                  regions +
                  " regions",
              );
          }
        }
      }
    }
    expect(problems).toEqual([]);
  }, 120_000);

  it("a select filter on the region column keeps every spelling of the selected region", () => {
    const one = (payloads.state as PeriodData).presets.last_30_days as DashboardData;
    const all = (payloads.all as PeriodData).presets.last_30_days as DashboardData;
    const ca = (d: DashboardData) =>
      (maps(d).get("us_revenue") as MapData).regions.find((r) => r.id === "CA")?.value;
    expect(ca(one)).toBeCloseTo(Number(ca(all)), 6);
  });

  it("HM5040 warns on additive maps only", () => {
    const warned = new Set([
      ...new Set(
        report.diagnostics.filter((x) => x.code === "HM5040").map((x) => x.message.split('"')[1]),
      ),
    ]);
    expect([...warned].sort()).toEqual(["orders", "revenue", "store_sales"]);
  });

  it("build --json and check --json carry the same match reports", () => {
    expect(report.maps?.length).toBeGreaterThan(0);
    expect(checkJson.maps).toEqual(report.maps);
  });
});
