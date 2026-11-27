import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TableData, TableRow, Value } from "../../src/compiler/index.js";
import { buildProject, metric, Oracle, removeProjects, run, writeProject } from "./fixture.js";

type Key = string | number | boolean | null;
type Values = Record<string, Value>;
type Source = "orders" | "visits" | "legacy";
interface Expected {
  keys: Key[];
  values: Values;
  kind?: "other" | "subtotal";
  count?: number;
  level?: number;
  share?: Values;
}
interface Table {
  by: string[];
  metrics: string[];
  limit: number;
  other: true;
  subtotals?: true;
  percentOfTotal?: string[];
  sort?: { by: string; order: "asc" | "desc" };
}

const TZ = "America/New_York";
const START = "2026-10-01";
const END = "2026-11-01";

let seed = 4;
const rnd = () => {
  seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
  return seed / 2 ** 32;
};
const pick = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)] as T;
const pad = (n: number) => String(n).padStart(2, "0");
const at = (day: string, hh = 12, mm = 0) => `${day}T${pad(hh)}:${pad(mm)}:00-04:00`;
const dayOf = (d: number) => (d <= 30 ? `2026-09-${pad(d)}` : `2026-10-${pad(d - 30)}`);
const COUNTRIES: [string, string][] = [
  ["Americas", "United States"],
  ["Americas", "Canada"],
  ["Americas", "Mexico"],
  ["Europe", "United Kingdom"],
  ["Europe", "Germany"],
  ["Europe", "France"],
  ["Asia", "Japan"],
  ["Asia", "India"],
  ["", ""],
];
const ORDERS: (string | number)[][] = [["ordered_at", "region", "country", "customer", "amount"]];
for (let i = 0; i < 260; i++) {
  const [region, country] = pick(COUNTRIES);
  const date = dayOf(20 + Math.floor(rnd() * 31));
  const hh = date === "2026-10-20" ? Math.floor(rnd() * 12) : Math.floor(rnd() * 24);
  const amount = rnd() < 0.05 ? "" : ((rnd() < 0.12 ? -1 : 1) * Math.round(rnd() * 20000)) / 100;
  ORDERS.push([
    at(date, hh, Math.floor(rnd() * 60)),
    region,
    country,
    `c${Math.floor(rnd() * 25)}`,
    amount,
  ]);
}
ORDERS.push([at("2026-10-01", 0, 0), "Europe", "Germany", "c1", 1000]);
ORDERS.push([at("2026-09-30", 23, 59), "Europe", "Germany", "c1", 5000]);
ORDERS.push([at("2026-10-19", 23, 59), "Asia", "Japan", "c2", 777]);
ORDERS.push([at("2026-10-20", 11, 0), "Asia", "Japan", "c2", 9999]);
ORDERS.push([at("2026-10-20", 12, 0), "Americas", "Canada", "c3", 4444]);
const VISITS: (string | number)[][] = [["visited_at", "region", "country", "visits"]];
for (const [region, country] of [...COUNTRIES, ["Asia", "Korea"]] as [string, string][]) {
  if (country === "Mexico") continue;
  for (let d = 25; d <= 56; d++) {
    const date = dayOf(d);
    VISITS.push([
      at(date, date === "2026-10-26" ? 12 : 9),
      region,
      country,
      10 + Math.floor(rnd() * 300),
    ]);
  }
}
const LEGACY: (string | number)[][] = [
  ["seen_at", "region", "country", "amount"],
  [at("2026-09-01"), "Americas", "United States", 50],
  [at("2026-09-15"), "Europe", "France", 70],
];
const csv = (rows: (string | number)[][]) => `${rows.map((r) => r.join(",")).join("\n")}\n`;
const TIME: Record<Source, string> = {
  orders: "ordered_at",
  visits: "visited_at",
  legacy: "seen_at",
};

const LEAF: Record<string, [Record<string, unknown>, string, Source]> = {
  revenue: [{ aggregate: "sum", column: "amount" }, "COALESCE(SUM(amount), 0)", "orders"],
  orders: [{ aggregate: "count" }, "COUNT(*)", "orders"],
  aov: [{ aggregate: "avg", column: "amount" }, "AVG(amount)", "orders"],
  smallest: [{ aggregate: "min", column: "amount" }, "MIN(amount)", "orders"],
  customers: [
    { aggregate: "count_distinct", column: "customer" },
    "COUNT(DISTINCT customer)",
    "orders",
  ],
  visits: [{ aggregate: "sum", column: "visits" }, "COALESCE(SUM(visits), 0)", "visits"],
  legacy_sum: [{ aggregate: "sum", column: "amount" }, "COALESCE(SUM(amount), 0)", "legacy"],
};
const RATIO: Record<string, [string, string]> = {
  per_visit: ["revenue", "visits"],
  per_legacy: ["revenue", "legacy_sum"],
};
const UNFOLDABLE = new Set(["customers"]);
const TABLES: Record<string, Table> = {
  w_top: {
    by: ["country"],
    metrics: ["revenue", "orders", "aov", "smallest", "customers", "visits", "per_visit"],
    limit: 3,
    other: true,
    percentOfTotal: ["revenue", "visits"],
  },
  w_sub: {
    by: ["region", "country"],
    metrics: ["revenue", "aov", "visits", "per_visit"],
    limit: 1,
    other: true,
    subtotals: true,
    percentOfTotal: ["visits"],
  },
  w_empty_mix: {
    by: ["region", "country"],
    metrics: ["revenue", "legacy_sum", "per_legacy", "visits"],
    limit: 1,
    other: true,
    subtotals: true,
  },
  w_empty_only: { by: ["country"], metrics: ["legacy_sum", "per_legacy"], limit: 2, other: true },
  w_visits_first: {
    by: ["country"],
    metrics: ["visits", "revenue"],
    limit: 4,
    other: true,
    sort: { by: "visits", order: "asc" },
  },
};

let oracle: Oracle;
let data = new Map<string, TableData>();
const built: { ok?: boolean; diagnostics: { code: string }[] } = { diagnostics: [] };
const horizon = {} as Record<Source, string>;

beforeAll(async () => {
  const metrics: Record<string, unknown> = {};
  for (const [name, [def, , source]] of Object.entries(LEAF))
    metrics[`metrics/${name}.json`] = metric({
      label: name,
      type: "aggregate",
      table: source,
      time: TIME[source],
      ...def,
    });
  for (const [name, [numerator, denominator]] of Object.entries(RATIO))
    metrics[`metrics/${name}.json`] = metric({
      label: name,
      type: "ratio",
      numerator,
      denominator,
    });
  const fixture = await writeProject({
    "hatchmark.json": {
      version: 1,
      name: "table windows",
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
      sources: {
        orders: { type: "csv", path: "data/orders.csv" },
        visits: { type: "csv", path: "data/visits.csv" },
        legacy: { type: "csv", path: "data/legacy.csv" },
      },
    },
    "data/orders.csv": csv(ORDERS),
    "data/visits.csv": csv(VISITS),
    "data/legacy.csv": csv(LEGACY),
    ...metrics,
    "dashboards/w.json": {
      title: "W",
      period: {
        asOf: "latest_data",
        range: { start: START, end: END },
        compare: "previous_period",
      },
      blocks: Object.entries(TABLES).map(([id, t]) => ({ id, type: "table", title: id, ...t })),
    },
  });
  Object.assign(built, (await buildProject(fixture.root)).report);
  const result = await run(fixture.root, fixture.project, "w");
  data = new Map(
    (result.data?.blocks ?? [])
      .filter((b) => b.type === "table")
      .map((b) => [b.id, b as TableData]),
  );
  oracle = await Oracle.open();
  for (const [source, time] of Object.entries(TIME) as [Source, string][]) {
    await oracle.run(
      `CREATE TABLE ${source} AS SELECT * EXCLUDE (${time}), timezone('${TZ}', CAST(${time} AS TIMESTAMPTZ)) AS local_ts FROM read_csv('${fixture.root}/data/${source}.csv', types = {'region': 'VARCHAR', 'country': 'VARCHAR', '${time}': 'VARCHAR'})`,
    );
    const [r] = await oracle.rows(
      `SELECT strftime(date_trunc('day', max(local_ts)), '%Y-%m-%d %H:%M:%S') AS h FROM ${source}`,
    );
    horizon[source] = String(r?.h);
  }
}, 120_000);

afterAll(async () => {
  oracle?.close();
  await removeProjects();
});

const div = (a: Value, b: Value): Value => (a === null || b === null || b === 0 ? null : a / b);
const lit = (k: Key) => (k === null ? "NULL" : `'${String(k).replaceAll("'", "''")}'`);
const sourcesOf = (n: string): Source[] => {
  const ratio = RATIO[n];
  return ratio ? ratio.flatMap(sourcesOf) : [LEAF[n]?.[2] as Source];
};
const windowEnd = (n: string): string | null => {
  const end = [`${END} 00:00:00`, ...sourcesOf(n).map((s) => horizon[s])].sort()[0] ?? "";
  return end <= `${START} 00:00:00` ? null : end;
};

async function leafValue(leaf: string, end: string, by: string[], groups: Key[][] | null) {
  const [, sql, source] = LEAF[leaf] ?? [];
  const conds = [`local_ts >= TIMESTAMP '${START} 00:00:00'`, `local_ts < TIMESTAMP '${end}'`];
  const match = (g: Key[]) =>
    g.map((k, i) => `${by[i]} IS NOT DISTINCT FROM ${lit(k)}`).join(" AND ");
  if (groups !== null)
    conds.push(
      groups.length === 0 ? "FALSE" : `(${groups.map((g) => `(${match(g)})`).join(" OR ")})`,
    );
  const [r] = await oracle.rows(`SELECT ${sql} AS v FROM ${source} WHERE ${conds.join(" AND ")}`);
  return r?.v === null || r?.v === undefined ? null : Number(r.v);
}

async function valuesOver(t: Table, by: string[], groups: Key[][] | null): Promise<Values> {
  const out: Values = {};
  for (const n of t.metrics) {
    const end = windowEnd(n);
    const value = async (x: string): Promise<Value> => {
      const ratio = RATIO[x];
      if (end === null) return null;
      return ratio
        ? div(await value(ratio[0]), await value(ratio[1]))
        : leafValue(x, end, by, groups);
    };
    out[n] = await value(n);
  }
  return out;
}

const RANK = { boolean: 0, number: 1, string: 2 } as const;
const rank = (k: Key) => RANK[typeof k as keyof typeof RANK];
const compareKey = (a: Key, b: Key) => {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  if (typeof a !== typeof b) return rank(a) - rank(b);
  return a < b ? -1 : 1;
};
const compareKeys = (a: Key[], b: Key[]) => {
  for (let i = 0; i < a.length; i++) {
    const c = compareKey(a[i] ?? null, b[i] ?? null);
    if (c) return c;
  }
  return 0;
};
const compareValue = (a: Value, b: Value, order: "asc" | "desc") => {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return order === "asc" ? a - b : b - a;
};

async function expected(t: Table) {
  const sort = t.sort ?? { by: t.metrics[0] ?? "", order: "desc" as const };
  const order = (a: Expected, b: Expected) =>
    compareValue(a.values[sort.by] ?? null, b.values[sort.by] ?? null, sort.order) ||
    compareKeys(a.keys, b.keys);
  const seen = new Map<string, Key[]>();
  for (const n of t.metrics) {
    const end = windowEnd(n);
    if (end === null) continue;
    for (const source of new Set(sourcesOf(n))) {
      const rows = await oracle.rows(
        `SELECT DISTINCT ${t.by.join(", ")} FROM ${source} WHERE local_ts >= TIMESTAMP '${START} 00:00:00' AND local_ts < TIMESTAMP '${end}'`,
      );
      for (const r of rows) {
        const keys = t.by.map((c) => (r[c] ?? null) as Key);
        seen.set(JSON.stringify(keys), keys);
      }
    }
  }
  const leaves: Expected[] = [];
  for (const keys of seen.values())
    leaves.push({ keys, values: await valuesOver(t, t.by, [keys]) });
  const total = await valuesOver(t, t.by, null);
  const cut = async (members: Expected[], parent: Key[]): Promise<Expected[]> => {
    members.sort(order);
    if (members.length <= t.limit) return members;
    const rest = members.slice(t.limit);
    const values = await valuesOver(
      t,
      t.by,
      rest.map((r) => r.keys),
    );
    for (const n of t.metrics) if (UNFOLDABLE.has(n)) values[n] = null;
    return [
      ...members.slice(0, t.limit),
      {
        keys: [...parent, ...t.by.slice(parent.length).map(() => null)],
        kind: "other",
        count: rest.length,
        values,
      },
    ];
  };
  const nest = async (members: Expected[], parent: Key[]): Promise<Expected[]> => {
    const level = parent.length + 1;
    if (level === t.by.length) return cut(members, parent);
    const groups = new Map<string, { keys: Key[]; members: Expected[] }>();
    for (const r of members) {
      const keys = r.keys.slice(0, level);
      const group = groups.get(JSON.stringify(keys)) ?? { keys, members: [] };
      group.members.push(r);
      groups.set(JSON.stringify(keys), group);
    }
    const list: { keys: Key[]; members: Expected[]; subtotal: Expected }[] = [];
    for (const g of groups.values())
      list.push({
        ...g,
        subtotal: {
          keys: [...g.keys, ...t.by.slice(level).map(() => null)],
          kind: "subtotal",
          level,
          values: await valuesOver(t, t.by.slice(0, level), [g.keys]),
        },
      });
    list.sort((a, b) => order(a.subtotal, b.subtotal));
    const out: Expected[] = [];
    for (const g of list) out.push(g.subtotal, ...(await nest(g.members, g.keys)));
    return out;
  };
  const rows = t.subtotals ? await nest(leaves, []) : await cut(leaves, []);
  const percent = t.percentOfTotal ?? [];
  if (percent.length > 0)
    for (const r of rows)
      r.share = Object.fromEntries(
        percent.map((p) => [p, div(r.values[p] ?? null, total[p] ?? null)]),
      );
  return {
    rows,
    total,
    rowCount: leaves.length,
    allEmpty: t.metrics.every((n) => windowEnd(n) === null),
  };
}

const close = (a: Value, b: Value) =>
  a === null || b === null
    ? a === b
    : Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));

function compare(
  id: string,
  want: Awaited<ReturnType<typeof expected>>,
  got: TableData | undefined,
) {
  if (got === undefined) return [`${id}: block missing`];
  const failures: string[] = [];
  if (want.allEmpty && got.empty === undefined)
    failures.push(`${id}: every metric is empty, empty unset`);
  if (got.rows.length !== want.rows.length)
    failures.push(`${id}: ${got.rows.length} rows, oracle ${want.rows.length}`);
  if (got.rowCount !== want.rowCount)
    failures.push(`${id}: rowCount ${got.rowCount}, oracle ${want.rowCount}`);
  want.rows.forEach((e, i) => {
    const a: TableRow | undefined = got.rows[i];
    const label = `${id} row ${i} ${JSON.stringify(e.keys)} ${e.kind ?? ""}`;
    if (!a) return;
    if (JSON.stringify(a.keys) !== JSON.stringify(e.keys) || a.kind !== e.kind) {
      failures.push(`${label}: got ${JSON.stringify(a.keys)} ${a.kind ?? ""}`);
      return;
    }
    if (e.kind === "other" && a.count !== e.count) failures.push(`${label}: count ${a.count}`);
    if (e.kind === "subtotal" && a.level !== e.level) failures.push(`${label}: level ${a.level}`);
    for (const [k, v] of Object.entries(e.values))
      if (!close(a.values[k] ?? null, v))
        failures.push(`${label} ${k}: got ${a.values[k]}, oracle ${v}`);
    for (const [k, v] of Object.entries(e.share ?? {}))
      if (!close(a.share?.[k] ?? null, v))
        failures.push(`${label} share ${k}: got ${a.share?.[k]}`);
  });
  if (got.total)
    for (const [k, v] of Object.entries(want.total))
      if (!close(got.total.values[k] ?? null, v))
        failures.push(`${id} total ${k}: got ${got.total.values[k]}, oracle ${v}`);
  return failures;
}

describe("tables at each measure's horizon against a raw-row oracle", () => {
  it("builds, with each source's horizon where the fixture puts it", () => {
    expect(built.ok).toBe(true);
    expect(horizon).toEqual({
      orders: "2026-10-20 00:00:00",
      visits: "2026-10-26 00:00:00",
      legacy: "2026-09-15 00:00:00",
    });
  });

  for (const [id, table] of Object.entries(TABLES)) {
    it(`${id} matches the oracle`, async () => {
      expect(compare(id, await expected(table), data.get(id))).toEqual([]);
    });
  }

  it("marks the all-empty table no_data with no rows", () => {
    const table = data.get("w_empty_only");
    expect(table?.empty).toBe("no_data");
    expect(table?.rows).toEqual([]);
  });
});
