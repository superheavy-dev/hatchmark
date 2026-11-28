import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { run as cli } from "../../src/cli/main.js";
import type { DashboardData, MapData } from "../../src/compiler/dashboard-data.js";
import { customRangeDashboard, type PeriodData } from "../../src/compiler/period-data.js";
import { PROJECT_DEFAULTS } from "../../src/spec/index.js";
import { metric, Oracle, removeProjects, run, writeProject } from "./fixture.js";

type Status = "matched" | "not_drawn" | "unmatched";
const TRUTH: [string | null, Status, string | null][] = [
  ["CA", "matched", "CA"],
  ["California", "matched", "CA"],
  ["06", "matched", "CA"],
  ["6", "matched", "CA"],
  ["6.0", "matched", "CA"],
  [" 06 ", "matched", "CA"],
  ["06.0", "matched", "CA"],
  ["６", "unmatched", null],
  ["０６", "unmatched", null],
  ["\u00a06", "unmatched", null],
  ["TX", "matched", "TX"],
  ["Texas", "matched", "TX"],
  ["48", "matched", "TX"],
  ["Guam", "not_drawn", "GU"],
  ["-06", "unmatched", null],
  [" -6", "unmatched", null],
  ["-6", "unmatched", null],
  ["+6", "unmatched", null],
  ["+06", "unmatched", null],
  ["-6.0", "unmatched", null],
  ["- 6", "unmatched", null],
  ["+ 6", "unmatched", null],
  [" - 6 ", "unmatched", null],
  ["−6", "unmatched", null],
  ["−06", "unmatched", null],
  ["–6", "unmatched", null],
  ["(6)", "unmatched", null],
  ["6-", "unmatched", null],
  ["6 -", "unmatched", null],
  ["-48", "unmatched", null],
  ["Narnia", "unmatched", null],
  [null, "unmatched", null],
];
const FIPS: [number | null, Status, string | null][] = [
  [6, "matched", "CA"],
  [48, "matched", "TX"],
  [-6, "unmatched", null],
  [-48, "unmatched", null],
  [null, "unmatched", null],
];

let seed = 3;
const rand = () => {
  seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
  return seed / 2 ** 32;
};
const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)] as T;
const cell = (v: string | number | null) =>
  v === null ? "" : '"' + String(v).replaceAll('"', '""') + '"';
const day = (i: number) =>
  new Date(Date.parse("2026-10-01T00:00:00Z") + i * 86_400_000).toISOString().slice(0, 10);

function data() {
  const orders = ["ordered_at,shipped_at,state,status,customer,amount"];
  for (let i = 0; i < 3000; i++) {
    const d = Math.floor(rand() * 56);
    orders.push(
      [
        day(d) + "T12:00:00Z",
        rand() < 0.1 ? null : day(d + Math.floor(rand() * 12)) + "T15:00:00Z",
        pick(TRUTH)[0],
        rand() < 0.3 ? "refunded" : "paid",
        "C" + Math.floor(rand() * 80),
        (1 + rand() * 99).toFixed(2),
      ]
        .map(cell)
        .join(","),
    );
  }
  const sessions = ["started_at,state"];
  for (let i = 0; i < 4000; i++)
    sessions.push(
      [day(Math.floor(rand() * 56)) + "T12:00:00Z", pick(TRUTH)[0]].map(cell).join(","),
    );
  const stores = ["opened,fips,sales"];
  for (let i = 0; i < 300; i++)
    stores.push(
      [day(Math.floor(rand() * 56)), pick(FIPS)[0] ?? "", (rand() * 500).toFixed(2)].join(","),
    );
  return {
    orders: orders.join("\n") + "\n",
    sessions: sessions.join("\n") + "\n",
    stores: stores.join("\n") + "\n",
  };
}

const paid = [{ column: "status", op: "eq", value: "paid" }];
const refunded = [{ column: "status", op: "eq", value: "refunded" }];
const METRICS: Record<string, Record<string, unknown>> = {
  revenue: metric({
    type: "aggregate",
    table: "orders",
    time: "ordered_at",
    aggregate: "sum",
    column: "amount",
    filters: paid,
  }),
  paid_orders: metric({
    type: "aggregate",
    table: "orders",
    time: "ordered_at",
    aggregate: "count",
    filters: paid,
  }),
  refunds: metric({
    type: "aggregate",
    table: "orders",
    time: "ordered_at",
    aggregate: "count",
    filters: refunded,
  }),
  paid_sql: metric({
    type: "sql",
    table: "orders",
    time: "ordered_at",
    sql: "sum(amount)",
    additive: true,
    filters: paid,
  }),
  sessions: metric({
    type: "aggregate",
    table: "sessions",
    time: "started_at",
    aggregate: "count",
  }),
  shipped: metric({
    type: "aggregate",
    table: "orders",
    time: "shipped_at",
    aggregate: "count",
    filters: [{ column: "shipped_at", op: "not_null" }],
  }),
  ship_rate: metric({ type: "ratio", numerator: "shipped", denominator: "paid_orders" }),
  store_sales: metric({
    type: "aggregate",
    table: "stores",
    time: "opened",
    aggregate: "sum",
    column: "sales",
  }),
  aov: metric({ type: "ratio", numerator: "revenue", denominator: "paid_orders" }),
  refund_share: metric({ type: "ratio", numerator: "refunds", denominator: "paid_orders" }),
  conversion: metric({ type: "ratio", numerator: "paid_orders", denominator: "sessions" }),
};
const PAID = "x.status = 'paid'";
const REFUNDED = "x.status = 'refunded'";
const LEAF: Record<string, { table: string; agg: string; filter?: string; time?: string }> = {
  shipped: {
    table: "orders",
    agg: "count(*) FILTER (WHERE x.shipped_at IS NOT NULL)",
    filter: "x.shipped_at IS NOT NULL",
    time: "shipped_at",
  },
  revenue: {
    table: "orders",
    agg: "sum(x.amount::DOUBLE) FILTER (WHERE " + PAID + ")",
    filter: PAID,
  },
  paid_orders: { table: "orders", agg: "count(*) FILTER (WHERE " + PAID + ")", filter: PAID },
  refunds: { table: "orders", agg: "count(*) FILTER (WHERE " + REFUNDED + ")", filter: REFUNDED },
  paid_sql: {
    table: "orders",
    agg: "sum(x.amount::DOUBLE) FILTER (WHERE " + PAID + ")",
    filter: PAID,
  },
  sessions: { table: "sessions", agg: "count(*)" },
  store_sales: { table: "stores", agg: "sum(x.sales::DOUBLE)" },
};
const RATIO: Record<string, [string, string]> = {
  aov: ["revenue", "paid_orders"],
  refund_share: ["refunds", "paid_orders"],
  conversion: ["paid_orders", "sessions"],
  ship_rate: ["shipped", "paid_orders"],
};
const leaves = (m: string) => RATIO[m] ?? [m];
const TIME: Record<string, string> = {
  orders: "ordered_at",
  sessions: "started_at",
  stores: "opened",
};

interface MapSpec {
  id: string;
  geo: "us-states" | "world-countries";
  column: string;
  value: string;
}
const us = (value: string): MapSpec => ({
  id: "us_" + value,
  geo: "us-states",
  column: "state",
  value,
});
const SHAPES: MapSpec[] = [
  "revenue",
  "paid_sql",
  "refunds",
  "aov",
  "refund_share",
  "conversion",
  "ship_rate",
].map(us);
const FIPS_MAP: MapSpec = {
  id: "fips_sales",
  geo: "us-states",
  column: "fips",
  value: "store_sales",
};
const WORLD_ON_STATE: MapSpec = {
  id: "w_revenue",
  geo: "world-countries",
  column: "state",
  value: "revenue",
};
const block = (s: MapSpec) => ({
  type: "map",
  id: s.id,
  geo: s.geo,
  region: s.column,
  value: s.value,
});
const PERIOD = { asOf: "2026-11-20", range: "last_30_days", compare: "none" };
const SELECT = { type: "select", id: "state", column: "state", default: "California" };
const CUSTOM: MapSpec[] = [us("ship_rate"), us("revenue"), us("conversion"), us("refund_share")];
const DASHBOARDS: Record<string, { blocks: MapSpec[]; select?: boolean; period?: boolean }> = {
  custom: { blocks: CUSTOM, period: true },
  shapes: { blocks: [...SHAPES, FIPS_MAP] },
  same: { blocks: [us("revenue"), us("conversion")], select: true },
  mixed_a: { blocks: [us("revenue"), WORLD_ON_STATE], select: true },
  mixed_b: { blocks: [WORLD_ON_STATE, us("revenue")], select: true },
};
const WINDOW = { start: "2026-10-22", end: "2026-11-21" };

let db: Oracle;
let payload: PeriodData;
const out: Record<string, DashboardData> = {};
const diagnostics: Record<string, { code: string; message: string }[]> = {};

beforeAll(async () => {
  const d = data();
  const files: Record<string, unknown> = {
    "hatchmark.yaml": {
      ...PROJECT_DEFAULTS,
      name: "Map invariants",
      timezone: "UTC",
      sources: {
        orders: { type: "csv", path: "orders.csv" },
        sessions: { type: "csv", path: "sessions.csv" },
        stores: { type: "csv", path: "stores.csv" },
      },
    },
    "orders.csv": d.orders,
    "sessions.csv": d.sessions,
    "stores.csv": d.stores,
  };
  for (const [name, spec] of Object.entries(METRICS)) files["metrics/" + name + ".yaml"] = spec;
  for (const [name, x] of Object.entries(DASHBOARDS))
    files["dashboards/" + name + ".yaml"] = {
      title: name,
      period: PERIOD,
      ...(x.select ? { filters: [SELECT] } : {}),
      ...(x.period
        ? {
            filters: [
              {
                type: "period",
                id: "period",
                options: [{ last: 30, unit: "day" }],
                default: { last: 30, unit: "day" },
              },
            ],
          }
        : {}),
      blocks: x.blocks.map(block),
    };
  const { root, project } = await writeProject(files);
  for (const name of Object.keys(DASHBOARDS)) {
    const r = await run(root, project, name);
    if (r.data === undefined)
      throw new Error(name + ": " + JSON.stringify(r.diagnostics).slice(0, 2000));
    out[name] = r.data;
    diagnostics[name] = r.diagnostics;
  }
  let log = "";
  const code = await cli(["build", "--json", "--cwd", root], {
    stdout: (t) => {
      log += t;
    },
    stderr: (t) => {
      log += t;
    },
    cwd: root,
    env: {},
    stdoutIsTTY: false,
    isAgent: async () => false,
  });
  if (code !== 0) throw new Error(log.slice(0, 3000));
  const page = await readFile(root + "/dist/custom/index.html", "utf8");
  payload = JSON.parse(
    /<script type="application\/json" data-hm-periods>(.*?)<\/script>/s.exec(page)?.[1] ?? "null",
  );
  db = await Oracle.open();
  const path = (f: string) => (root + "/" + f).replaceAll("'", "''");
  for (const t of ["orders", "sessions", "stores"])
    await db.run(
      "CREATE TABLE " +
        t +
        " AS SELECT * FROM read_csv('" +
        path(t + ".csv") +
        "', all_varchar = true, strict_mode = false)",
    );
  await db.run("CREATE TABLE truth (geo VARCHAR, raw VARCHAR, status VARCHAR, id VARCHAR)");
  const lit = (v: unknown) => (v === null ? "NULL" : "'" + String(v).replaceAll("'", "''") + "'");
  const rows = [...TRUTH.map((t) => ["state", ...t]), ...FIPS.map((t) => ["fips", ...t])];
  await db.run(
    "INSERT INTO truth VALUES " + rows.map((r) => "(" + r.map(lit).join(", ") + ")").join(", "),
  );
}, 300_000);
afterAll(async () => {
  db?.close();
  await removeProjects();
});

const mapOf = (dash: string, id: string) =>
  out[dash]?.blocks.find((b): b is MapData => b.type === "map" && b.id === id) as MapData;
const inWindow = (table: string, time = TIME[table], win = WINDOW) => {
  const t = "x." + time;
  const d = table === "stores" ? t + "::DATE" : "CAST(" + t + "::TIMESTAMPTZ AS DATE)";
  return d + " >= DATE '" + win.start + "' AND " + d + " < DATE '" + win.end + "'";
};
const join = (s: MapSpec) =>
  "LEFT JOIN truth t ON t.geo = '" +
  (s.column === "fips" ? "fips" : "state") +
  "' AND t.raw IS NOT DISTINCT FROM x." +
  s.column;

async function regionValues(
  s: MapSpec,
  extra = "TRUE",
  win = WINDOW,
): Promise<Map<string, number | null>> {
  const parts = await Promise.all(
    leaves(s.value).map(async (leaf) => {
      const { table, agg, time } = LEAF[leaf] as { table: string; agg: string; time?: string };
      const rows = await db.rows(
        "SELECT t.id, " +
          agg +
          " AS v FROM " +
          table +
          " x " +
          join(s) +
          " WHERE t.status = 'matched' AND " +
          inWindow(table, time, win) +
          " AND " +
          extra +
          " GROUP BY t.id",
      );
      return new Map(rows.map((r) => [r.id as string, r.v === null ? null : Number(r.v)]));
    }),
  );
  const [num, den] = parts as [Map<string, number | null>, Map<string, number | null> | undefined];
  const ids = new Set([...num.keys(), ...(den?.keys() ?? [])]);
  return new Map(
    [...ids].map((id) => {
      const n =
        num.get(id) ??
        (den && LEAF[leaves(s.value)[0] as string]?.agg.startsWith("count") ? 0 : null);
      if (den === undefined) return [id, n];
      const dv = den.get(id) ?? 0;
      return [id, n === null || dv === 0 ? null : n / dv];
    }),
  );
}

async function reportRows(
  s: MapSpec,
  win = WINDOW,
): Promise<Map<string | null, { rows: number; status: Status }>> {
  const byTable = new Map<string, string[]>();
  for (const leaf of leaves(s.value)) {
    const { table, filter, time } = LEAF[leaf] as { table: string; filter?: string; time?: string };
    byTable.set(table, [
      ...(byTable.get(table) ?? []),
      "(" + (filter ?? "TRUE") + ") AND " + inWindow(table, time, win),
    ]);
  }
  const out = new Map<string | null, { rows: number; status: Status }>();
  for (const [table, filters] of byTable) {
    const rows = await db.rows(
      "SELECT x." +
        s.column +
        " AS k, t.status, count(*) AS n FROM " +
        table +
        " x " +
        join(s) +
        " WHERE (" +
        filters.map((f) => "(" + f + ")").join(" OR ") +
        ") GROUP BY ALL",
    );
    for (const r of rows) {
      const k = r.k === null ? null : String(r.k);
      out.set(k, { rows: (out.get(k)?.rows ?? 0) + Number(r.n), status: r.status as Status });
    }
  }
  return out;
}

const close = (a: unknown, b: number | null | undefined) =>
  a === null || a === undefined || b === null || b === undefined
    ? (a ?? null) === (b ?? null)
    : Math.abs(Number(a) - b) <= 1e-9 * Math.max(1, Math.abs(b));

describe("map invariants: region filters, per-source report rows, signed codes", () => {
  it("reads the window the oracle reads", () => {
    for (const s of SHAPES) expect(mapOf("shapes", s.id).window, s.id).toMatchObject(WINDOW);
  });

  it("every metric shape: region values equal the oracle, signed codes excluded", async () => {
    const problems: string[] = [];
    for (const s of [...SHAPES, FIPS_MAP]) {
      const want = await regionValues(s);
      const map = mapOf("shapes", s.id);
      for (const r of map.regions)
        if (!close(r.value, want.get(r.id)))
          problems.push(s.id + "/" + r.id + ": " + r.value + " oracle " + want.get(r.id));
      for (const id of want.keys())
        if (!map.regions.some((r) => r.id === id)) problems.push(s.id + "/" + id + ": missing");
    }
    expect(problems).toEqual([]);
  });

  it("every metric shape: report rows equal each source's rows after the metric's filters, once per source", async () => {
    const problems: string[] = [];
    for (const s of [...SHAPES, FIPS_MAP]) {
      const want = await reportRows(s);
      const map = mapOf("shapes", s.id);
      const got = new Map(map.match.map((m) => [m.key === null ? null : String(m.key), m]));
      for (const [k, w] of want) {
        const g = got.get(k);
        if ((g?.rows ?? 0) !== w.rows)
          problems.push(s.id + " " + JSON.stringify(k) + ": rows " + g?.rows + " oracle " + w.rows);
        if (w.status !== "matched" && g?.region != null)
          problems.push(
            s.id + " " + JSON.stringify(k) + ": joined " + g.region + ", oracle " + w.status,
          );
      }
      for (const [k, g] of got)
        if (!want.has(k) && g.rows !== 0)
          problems.push(s.id + " " + JSON.stringify(k) + ": " + g.rows + " rows, oracle none");
    }
    expect(problems).toEqual([]);
  });

  it("signed and padded negative codes never join a region", () => {
    const signed = TRUTH.filter(
      ([raw, status]) => raw !== null && status === "unmatched" && /[0-9]/.test(raw),
    ).map(([raw]) => raw as string);
    const joined = [...SHAPES, FIPS_MAP].flatMap((s) =>
      mapOf("shapes", s.id).match.flatMap((m) =>
        m.region !== null &&
        (signed.includes(String(m.key)) || (typeof m.key === "number" && m.key < 0))
          ? [s.id + " " + JSON.stringify(m.key) + " -> " + m.region]
          : [],
      ),
    );
    expect(joined).toEqual([]);
  });

  it("a region filter keeps every spelling when every map on the column shares a geo", async () => {
    const ca = await db.rows("SELECT raw FROM truth WHERE geo = 'state' AND id = 'CA'");
    const spellings =
      "x.state IN (" +
      ca.map((r) => "'" + String(r.raw).replaceAll("'", "''") + "'").join(", ") +
      ")";
    for (const s of [us("revenue"), us("conversion")]) {
      const want = await regionValues(s, spellings);
      const map = mapOf("same", s.id);
      expect(
        map.regions.map((r) => r.id),
        s.id,
      ).toEqual(["CA"]);
      expect(
        close(map.regions[0]?.value, want.get("CA")),
        s.id + ": " + map.regions[0]?.value + " vs " + want.get("CA"),
      ).toBe(true);
    }
  });

  it("maps of different geos on one column: the filter matches exactly, whatever the block order", async () => {
    const want = await regionValues(us("revenue"), "x.state = 'California'");
    for (const dash of ["mixed_a", "mixed_b"]) {
      const map = mapOf(dash, "us_revenue");
      expect(
        map.regions.map((r) => r.id),
        dash,
      ).toEqual(["CA"]);
      expect(
        close(map.regions[0]?.value, want.get("CA")),
        dash + ": " + map.regions[0]?.value + " vs " + want.get("CA"),
      ).toBe(true);
    }
    const a = mapOf("mixed_a", "w_revenue");
    const b = mapOf("mixed_b", "w_revenue");
    expect({ regions: b.regions, total: b.total, match: b.match }).toEqual({
      regions: a.regions,
      total: a.total,
      match: a.match,
    });
  });
  it("custom ranges keep each operand's own date window in values and report rows", async () => {
    const problems: string[] = [];
    const wins = [
      { start: "2026-10-22", end: "2026-11-21" },
      { start: "2026-10-25", end: "2026-11-05" },
      { start: "2026-11-10", end: "2026-11-11" },
      { start: "2026-11-01", end: "2026-11-21" },
    ];
    for (const win of wins) {
      const data = customRangeDashboard(
        payload.custom as NonNullable<PeriodData["custom"]>,
        payload.filter,
        win,
      );
      for (const s of CUSTOM) {
        const map = data.blocks.find(
          (b): b is MapData => b.type === "map" && b.id === s.id,
        ) as MapData;
        const want = await regionValues(s, "TRUE", win);
        for (const r of map.regions)
          if (!close(r.value, want.get(r.id)))
            problems.push(
              win.start + "/" + s.id + "/" + r.id + ": " + r.value + " oracle " + want.get(r.id),
            );
        for (const [id, v] of want)
          if (v !== null && !map.regions.some((r) => r.id === id))
            problems.push(win.start + "/" + s.id + "/" + id + ": missing");
        const rows = await reportRows(s, win);
        const got = new Map(map.match.map((m) => [m.key === null ? null : String(m.key), m.rows]));
        for (const [k, w] of rows)
          if ((got.get(k) ?? 0) !== w.rows)
            problems.push(
              win.start +
                "/" +
                s.id +
                " " +
                JSON.stringify(k) +
                ": rows " +
                got.get(k) +
                " oracle " +
                w.rows,
            );
        for (const [k, n] of got)
          if (!rows.has(k) && n !== 0)
            problems.push(
              win.start + "/" + s.id + " " + JSON.stringify(k) + ": " + n + " rows, oracle none",
            );
      }
    }
    expect(problems).toEqual([]);
  });
});
