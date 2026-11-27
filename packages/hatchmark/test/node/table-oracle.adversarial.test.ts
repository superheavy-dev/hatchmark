import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TableData, TableRow, Value } from "../../src/compiler/index.js";
import { buildProject, metric, Oracle, removeProjects, run, writeProject } from "./fixture.js";

type Key = string | number | boolean | null;
type Values = Record<string, Value>;
interface Expected {
  keys: Key[];
  values: Values;
  kind?: "other" | "subtotal";
  count?: number;
  level?: number;
  share?: Values;
}

let seed = 56;
const rnd = () => {
  seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
  return seed / 2 ** 32;
};
const pick = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)] as T;
const ORDERS: (string | number)[][] = [
  ["region", "country", "channel", "store", "customer", "amount", "qty", "price", "refunded"],
];
const add = (region: string, country: string, amounts: (number | null)[]) => {
  for (const amount of amounts) {
    const qty = 1 + Math.floor(rnd() * 5);
    const price = Math.round(rnd() * 9000) / 100;
    ORDERS.push([
      region,
      country,
      pick(["web", "store", "partner", ""]),
      pick([7, 42, 999, 1234, 20250]),
      `c${Math.floor(rnd() * 30)}`,
      amount ?? "",
      rnd() < 0.08 ? "" : qty,
      price,
      rnd() < 0.2 ? "true" : "false",
    ]);
  }
};
const randoms = (n: number, scale: number, neg = 0) =>
  Array.from({ length: n }, () => {
    const v = Math.round(rnd() * scale * 100) / 100;
    return rnd() < neg ? -v : rnd() < 0.05 ? null : v;
  });
add("Americas", "United States", randoms(60, 140, 0.1));
add("Americas", "Canada", randoms(25, 120, 0.15));
add("Americas", "Mexico", [125, -40, 40, null]);
add("Americas", "Brazil", randoms(9, 80, 0.3));
add("Americas", "Argentina", [-90, -35.5, 10]);
add("Europe", "United Kingdom", randoms(30, 110, 0.1));
add("Europe", "Germany", [100, 25]);
add("Europe", "France", [60, 65]);
add("Europe", "Spain", [125]);
add("Europe", "Italy", [null, null]);
add("Europe", "", [44, 12.5, -3]);
add("Asia", "Japan", randoms(14, 160, 0.05));
add("Asia", "India", randoms(11, 60, 0.2));
add("Asia", "Singapore", [125, 0]);
add("", "Norway", [7, 8]);
add("", "", [19.75]);
const VISITS: (string | number)[][] = [
  ["region", "country", "channel", "visits"],
  ["Americas", "United States", "web", 9100],
  ["Americas", "United States", "store", 1200],
  ["Americas", "Canada", "web", 2200],
  ["Americas", "Mexico", "web", 800],
  ["Europe", "United Kingdom", "web", 2600],
  ["Europe", "Germany", "store", 700],
  ["Europe", "France", "web", 650],
  ["Europe", "Spain", "web", 0],
  ["Europe", "Italy", "web", 300],
  ["Europe", "", "web", 90],
  ["Asia", "Japan", "web", 1400],
  ["Asia", "India", "partner", 500],
  ["Asia", "Singapore", "web", 210],
  ["Asia", "Korea", "web", 640],
];
const csv = (rows: (string | number)[][]) => `${rows.map((r) => r.join(",")).join("\n")}\n`;

const LEAF: Record<string, [Record<string, unknown>, string, "o" | "v"]> = {
  revenue: [
    { table: "orders", type: "aggregate", aggregate: "sum", column: "amount" },
    "COALESCE(SUM(amount), 0)",
    "o",
  ],
  orders: [{ table: "orders", type: "aggregate", aggregate: "count" }, "COUNT(*)", "o"],
  aov: [
    { table: "orders", type: "aggregate", aggregate: "avg", column: "amount" },
    "AVG(amount)",
    "o",
  ],
  biggest: [
    { table: "orders", type: "aggregate", aggregate: "max", column: "amount" },
    "MAX(amount)",
    "o",
  ],
  smallest: [
    { table: "orders", type: "aggregate", aggregate: "min", column: "amount" },
    "MIN(amount)",
    "o",
  ],
  refunds: [
    {
      table: "orders",
      type: "aggregate",
      aggregate: "count",
      filters: [{ column: "refunded", op: "eq", value: true }],
    },
    "COUNT(*) FILTER (WHERE refunded)",
    "o",
  ],
  customers: [
    { table: "orders", type: "aggregate", aggregate: "count_distinct", column: "customer" },
    "COUNT(DISTINCT customer)",
    "o",
  ],
  units: [
    { table: "orders", type: "aggregate", aggregate: "sum", column: "qty" },
    "COALESCE(SUM(qty), 0)",
    "o",
  ],
  avg_qty: [
    { table: "orders", type: "aggregate", aggregate: "avg", column: "qty" },
    "AVG(qty)",
    "o",
  ],
  line_total: [
    { table: "orders", type: "sql", additive: true, sql: "sum(price * qty)" },
    "CASE WHEN COUNT(*) = 0 THEN 0 ELSE SUM(price * qty) END",
    "o",
  ],
  web_total: [
    {
      table: "orders",
      type: "sql",
      additive: true,
      sql: "sum(amount)",
      filters: [{ column: "channel", op: "eq", value: "web" }],
    },
    "CASE WHEN COUNT(*) FILTER (WHERE channel = 'web') = 0 THEN 0 ELSE SUM(amount) FILTER (WHERE channel = 'web') END",
    "o",
  ],
  median_amount: [
    { table: "orders", type: "sql", additive: false, sql: "median(amount)" },
    "MEDIAN(amount)",
    "o",
  ],
  visits: [
    { table: "visits", type: "aggregate", aggregate: "sum", column: "visits" },
    "COALESCE(SUM(visits), 0)",
    "v",
  ],
};
const RATIO: Record<string, [string, string]> = {
  refund_rate: ["refunds", "orders"],
  weighted_price: ["line_total", "units"],
  ratio_of_avgs: ["aov", "avg_qty"],
  per_visit: ["revenue", "visits"],
  rate_per_visit: ["refund_rate", "visits"],
};
const UNFOLDABLE = new Set(["customers", "median_amount"]);

const ALL = [
  "revenue",
  "orders",
  "aov",
  "biggest",
  "smallest",
  "refund_rate",
  "customers",
  "median_amount",
  "weighted_price",
  "ratio_of_avgs",
  "web_total",
];
interface Table {
  by: string[];
  metrics: string[];
  limit?: number;
  other?: boolean;
  subtotals?: boolean;
  totals?: boolean;
  percentOfTotal?: string[];
  bars?: string[];
  sort?: { by: string; order: "asc" | "desc" };
}
const TABLES: Record<string, Table> = {
  top_default: {
    by: ["country"],
    metrics: ALL,
    limit: 5,
    other: true,
    percentOfTotal: ["revenue", "orders"],
  },
  top_aov_asc: {
    by: ["country"],
    metrics: ALL,
    limit: 4,
    other: true,
    sort: { by: "aov", order: "asc" },
  },
  top_smallest_asc: {
    by: ["country"],
    metrics: ["smallest", "biggest", "revenue"],
    limit: 3,
    other: true,
    sort: { by: "smallest", order: "asc" },
  },
  top_ratio_desc: {
    by: ["country"],
    metrics: ["refund_rate", "weighted_price", "ratio_of_avgs"],
    limit: 6,
    other: true,
    sort: { by: "refund_rate", order: "desc" },
  },
  ties_at_n: {
    by: ["country"],
    metrics: ["revenue", "orders"],
    limit: 6,
    other: true,
    percentOfTotal: ["revenue"],
  },
  key_desc: {
    by: ["country"],
    metrics: ["revenue", "aov"],
    limit: 4,
    other: true,
    sort: { by: "country", order: "desc" },
  },
  numeric_key: {
    by: ["store"],
    metrics: ["revenue", "orders"],
    limit: 4,
    other: true,
    sort: { by: "store", order: "asc" },
  },
  cross_source: {
    by: ["country"],
    metrics: ["revenue", "visits", "per_visit", "rate_per_visit"],
    limit: 4,
    other: true,
    percentOfTotal: ["visits"],
  },
  sub2: {
    by: ["region", "country"],
    metrics: ["revenue", "aov", "refund_rate", "customers", "smallest"],
    limit: 2,
    other: true,
    subtotals: true,
    percentOfTotal: ["revenue"],
  },
  sub2_asc: {
    by: ["region", "country"],
    metrics: ["revenue", "weighted_price"],
    limit: 1,
    other: true,
    subtotals: true,
    sort: { by: "weighted_price", order: "asc" },
  },
  sub3: {
    by: ["region", "country", "channel"],
    metrics: ["revenue", "orders", "aov"],
    limit: 1,
    other: true,
    subtotals: true,
    percentOfTotal: ["orders"],
  },
  sub2_cross: {
    by: ["region", "country"],
    metrics: ["revenue", "visits", "per_visit"],
    limit: 2,
    other: true,
    subtotals: true,
  },
  sub2_nolimit_key: {
    by: ["region", "channel"],
    metrics: ["revenue", "orders"],
    subtotals: true,
    sort: { by: "channel", order: "asc" },
  },
  sub2_no_other: {
    by: ["region", "country"],
    metrics: ["revenue"],
    limit: 1,
    subtotals: true,
    totals: false,
  },
  bars_neg: {
    by: ["country"],
    metrics: ["revenue", "smallest"],
    bars: ["revenue", "smallest"],
    limit: 8,
    other: true,
  },
};
const FILTER: Record<string, Key[]> = { region: ["Europe", "Asia"], channel: ["web"] };

let root = "";
let oracle: Oracle;
const html: Record<string, string> = {};
const data: Record<string, Map<string, TableData>> = {};
const built: { ok?: boolean; diagnostics: { code: string; pointer?: string }[] } = {
  diagnostics: [],
};

beforeAll(async () => {
  const metrics: Record<string, unknown> = {};
  for (const [name, [def]] of Object.entries(LEAF))
    metrics[`metrics/${name}.yaml`] = metric({ ...def, label: name });
  for (const [name, [numerator, denominator]] of Object.entries(RATIO))
    metrics[`metrics/${name}.yaml`] = metric({
      label: name,
      type: "ratio",
      numerator,
      denominator,
    });
  metrics["metrics/net.yaml"] = metric({
    label: "net",
    type: "formula",
    expr: "revenue - web_total",
  });
  const blocks = [
    ...Object.entries(TABLES).map(([id, t]) => ({ id, type: "table", title: id, ...t })),
    {
      id: "formula",
      type: "table",
      by: ["country"],
      metrics: ["revenue", "net"],
      limit: 3,
      other: true,
    },
  ];
  const period = { asOf: "2026-11-01", range: "all_time", compare: "previous_period" };
  const fixture = await writeProject({
    "hatchmark.yaml": {
      version: 1,
      name: "table oracle",
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
        visits: { type: "csv", path: "data/visits.csv" },
      },
    },
    "data/orders.csv": csv(ORDERS),
    "data/visits.csv": csv(VISITS),
    ...metrics,
    "dashboards/main.yaml": { title: "Main", period, blocks },
    "dashboards/filtered.yaml": {
      title: "Filtered",
      period,
      filters: [
        {
          type: "select",
          id: "region",
          column: "region",
          multiple: true,
          default: ["Europe", "Asia"],
        },
        { type: "select", id: "channel", column: "channel", default: "web" },
      ],
      blocks,
    },
  });
  root = fixture.root;
  const report = (await buildProject(root)).report as typeof built;
  Object.assign(built, report);
  for (const dash of ["main", "filtered"]) {
    const result = await run(root, fixture.project, dash);
    data[dash] = new Map(
      (result.data?.blocks ?? [])
        .filter((b) => b.type === "table")
        .map((b) => [b.id, b as TableData]),
    );
    html[dash] = await readFile(path.join(root, "dist", dash, "index.html"), "utf8");
  }
  oracle = await Oracle.open();
  const types = "types = {'region': 'VARCHAR', 'country': 'VARCHAR', 'channel': 'VARCHAR'}";
  await oracle.run(`CREATE TABLE o AS SELECT * FROM read_csv('${root}/data/orders.csv', ${types})`);
  await oracle.run(`CREATE TABLE v AS SELECT * FROM read_csv('${root}/data/visits.csv', ${types})`);
}, 120_000);

afterAll(async () => {
  oracle?.close();
  await removeProjects();
});

const num = (x: unknown): Value => (x === null || x === undefined ? null : Number(x));
const div = (a: Value, b: Value): Value => (a === null || b === null || b === 0 ? null : a / b);
const lit = (k: Key) =>
  k === null ? "NULL" : typeof k === "number" ? String(k) : `'${String(k).replaceAll("'", "''")}'`;
const columnsOf = (src: "o" | "v") => (src === "o" ? ORDERS[0] : VISITS[0]) as string[];
const where = (src: "o" | "v", filter: Record<string, Key[]> | undefined) =>
  Object.entries(filter ?? {})
    .filter(([c]) => columnsOf(src).includes(c))
    .map(([c, vals]) => `${c} IN (${vals.map(lit).join(", ")})`);

async function valuesOver(
  by: string[],
  groups: Key[][] | null,
  metrics: string[],
  filter: Record<string, Key[]> | undefined,
): Promise<Values> {
  const leaves = new Set<string>();
  const visit = (n: string): void => {
    const ratio = RATIO[n];
    if (ratio) ratio.forEach(visit);
    else leaves.add(n);
  };
  metrics.forEach(visit);
  const out: Values = {};
  for (const src of ["o", "v"] as const) {
    const names = [...leaves].filter((n) => LEAF[n]?.[2] === src);
    if (names.length === 0) continue;
    const conds = where(src, filter);
    if (groups !== null) {
      const match = (g: Key[]) =>
        by
          .slice(0, g.length)
          .map((c, i) => `${src}.${c} IS NOT DISTINCT FROM ${lit(g[i] ?? null)}`)
          .join(" AND ");
      conds.push(
        groups.length === 0 ? "FALSE" : `(${groups.map((g) => `(${match(g)})`).join(" OR ")})`,
      );
    }
    const select = names.map((n) => `${LEAF[n]?.[1]} AS "${n}"`).join(", ");
    const [r] = await oracle.rows(
      `SELECT ${select} FROM ${src}${conds.length ? ` WHERE ${conds.join(" AND ")}` : ""}`,
    );
    for (const n of names) out[n] = num(r?.[n]);
  }
  const value = (n: string): Value => {
    const ratio = RATIO[n];
    return ratio ? div(value(ratio[0]), value(ratio[1])) : (out[n] ?? null);
  };
  return Object.fromEntries(metrics.map((n) => [n, value(n)]));
}

const RANK = { boolean: 0, number: 1, string: 2 } as const;
const cmpKey = (a: Key, b: Key): number => {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  if (typeof a !== typeof b)
    return RANK[typeof a as keyof typeof RANK] - RANK[typeof b as keyof typeof RANK];
  if (typeof a === "number" && typeof b === "number") return a - b;
  return a < b ? -1 : 1;
};
const cmpKeyOrdered = (a: Key, b: Key, order: "asc" | "desc") =>
  a === b ? 0 : a === null ? 1 : b === null ? -1 : order === "asc" ? cmpKey(a, b) : cmpKey(b, a);
const cmpKeys = (a: Key[], b: Key[]) => {
  for (let i = 0; i < a.length; i++) {
    const c = cmpKey(a[i] ?? null, b[i] ?? null);
    if (c) return c;
  }
  return 0;
};
const cmpVal = (a: Value, b: Value, order: "asc" | "desc") =>
  a === b ? 0 : a === null ? 1 : b === null ? -1 : order === "asc" ? a - b : b - a;

async function expected(t: Table, filter: Record<string, Key[]> | undefined) {
  const sort = t.sort ?? { by: t.metrics[0] ?? "", order: "desc" as const };
  const keyCol = t.by.indexOf(sort.by);
  const order = (a: Expected, b: Expected) =>
    (keyCol >= 0
      ? cmpKeyOrdered(a.keys[keyCol] ?? null, b.keys[keyCol] ?? null, sort.order)
      : cmpVal(a.values[sort.by] ?? null, b.values[sort.by] ?? null, sort.order)) ||
    cmpKeys(a.keys, b.keys);
  const sources = new Set<"o" | "v">();
  const visit = (n: string): void => {
    const ratio = RATIO[n];
    if (ratio) ratio.forEach(visit);
    else if (LEAF[n]) sources.add(LEAF[n][2]);
  };
  t.metrics.forEach(visit);
  const seen = new Map<string, Key[]>();
  for (const s of sources) {
    const conds = where(s, filter);
    const rows = await oracle.rows(
      `SELECT DISTINCT ${t.by.join(", ")} FROM ${s}${conds.length ? ` WHERE ${conds.join(" AND ")}` : ""}`,
    );
    for (const r of rows) {
      const keys = t.by.map((c) => (r[c] ?? null) as Key);
      seen.set(JSON.stringify(keys), keys);
    }
  }
  const leaves: Expected[] = [];
  for (const keys of seen.values())
    leaves.push({ keys, values: await valuesOver(t.by, [keys], t.metrics, filter) });
  const total = await valuesOver(t.by, null, t.metrics, filter);
  const blank = (from: number) => t.by.slice(from).map(() => null);
  const cut = async (members: Expected[], parent: Key[]): Promise<Expected[]> => {
    members.sort(order);
    if (t.limit === undefined || members.length <= t.limit) return members;
    const rest = members.slice(t.limit);
    const shown = members.slice(0, t.limit);
    if (!t.other) return shown;
    const values = await valuesOver(
      t.by,
      rest.map((r) => r.keys),
      t.metrics,
      filter,
    );
    for (const name of t.metrics) if (UNFOLDABLE.has(name)) values[name] = null;
    return [
      ...shown,
      { keys: [...parent, ...blank(parent.length)], kind: "other", count: rest.length, values },
    ];
  };
  const nest = async (members: Expected[], parent: Key[]): Promise<Expected[]> => {
    const level = parent.length + 1;
    if (level === t.by.length) return cut(members, parent);
    const groups = new Map<string, { keys: Key[]; members: Expected[] }>();
    for (const r of members) {
      const keys = r.keys.slice(0, level);
      const id = JSON.stringify(keys);
      const group = groups.get(id) ?? { keys, members: [] };
      group.members.push(r);
      groups.set(id, group);
    }
    const list: { keys: Key[]; members: Expected[]; subtotal: Expected }[] = [];
    for (const g of groups.values()) {
      const values = await valuesOver(t.by, [g.keys], t.metrics, filter);
      list.push({
        ...g,
        subtotal: { keys: [...g.keys, ...blank(level)], kind: "subtotal", level, values },
      });
    }
    list.sort((a, b) => order(a.subtotal, b.subtotal));
    const out: Expected[] = [];
    for (const g of list) out.push(g.subtotal, ...(await nest(g.members, g.keys)));
    return out;
  };
  const rows = t.subtotals ? await nest(leaves, []) : await cut(leaves, []);
  for (const r of rows)
    if (t.percentOfTotal?.length)
      r.share = Object.fromEntries(
        t.percentOfTotal.map((p) => [p, div(r.values[p] ?? null, total[p] ?? null)]),
      );
  return { rows, total, rowCount: leaves.length };
}

const close = (a: Value, b: Value) =>
  a === null || b === null
    ? a === b
    : Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));

function compare(
  where: string,
  want: Awaited<ReturnType<typeof expected>>,
  got: TableData | undefined,
) {
  const failures: string[] = [];
  if (got === undefined) return [`${where}: block missing`];
  if (got.rows.length !== want.rows.length)
    failures.push(`${where}: ${got.rows.length} rows, oracle ${want.rows.length}`);
  if (got.rowCount !== want.rowCount)
    failures.push(`${where}: rowCount ${got.rowCount}, oracle ${want.rowCount}`);
  want.rows.forEach((e, i) => {
    const a: TableRow | undefined = got.rows[i];
    const label = `${where} row ${i} ${JSON.stringify(e.keys)} ${e.kind ?? ""}`;
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
        failures.push(`${where} total ${k}: got ${got.total.values[k]}, oracle ${v}`);
  return failures;
}

function htmlRows(page: string, id: string, width: number) {
  const section = page.split(`data-hm-csv="${id}"`)[1]?.split("</section>")[0] ?? "";
  const body = (section.split("<tbody>")[1] ?? "").split("</tbody>")[0] ?? "";
  return [...body.matchAll(/<tr[^>]*data-hm-kind="(\w+)"[^>]*>(.*?)<\/tr>/g)].map(
    ([, kind, cells]) => ({
      kind,
      values: [...(cells ?? "").matchAll(/data-v="([^"]*)"/g)].map((m) => m[1]).slice(width),
    }),
  );
}

describe("tables against a raw-row oracle", () => {
  it("builds, warning only where Other cannot fold and leaving the formula table out", () => {
    expect(built.ok).toBe(true);
    const codes = new Set(built.diagnostics.map((d) => d.code));
    expect([...codes].sort()).toEqual(["HM4023", "HM4063"]);
    expect(data.main?.has("formula")).toBe(false);
  });

  for (const dash of ["main", "filtered"] as const) {
    for (const [id, table] of Object.entries(TABLES)) {
      it(`${dash}/${id} matches the oracle, and its HTML carries the same values`, async () => {
        const got = data[dash]?.get(id);
        const want = await expected(table, dash === "filtered" ? FILTER : undefined);
        expect(compare(`${dash}/${id}`, want, got)).toEqual([]);
        const rows = htmlRows(html[dash] ?? "", id, table.by.length);
        expect(rows).toHaveLength(got?.rows.length ?? -1);
        rows.forEach((row, i) => {
          const r = got?.rows[i];
          const values = table.metrics.flatMap((m) => [
            r?.values[m],
            ...(table.percentOfTotal?.includes(m) ? [r?.share?.[m]] : []),
          ]);
          expect(row.kind).toBe(r?.kind ?? "row");
          expect(row.values).toEqual(values.map((v) => (typeof v === "number" ? String(v) : "")));
        });
      });
    }
  }

  it("rebuilds byte for byte", async () => {
    const again = await buildProject(root);
    expect((again.report as typeof built).ok).toBe(true);
    expect(await readFile(path.join(root, "dist", "main", "index.html"), "utf8")).toBe(html.main);
  });
});
