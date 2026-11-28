import { mkdir } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { KpiData, TableData } from "../../src/compiler/index.js";
import { PROJECT_DEFAULTS } from "../../src/spec/index.js";
import { loadAt, metric, Oracle, removeProjects, run, writeProject } from "./fixture.js";

const FULL = process.env.HM_SWEEP === "full";
const CASES = FULL ? 400 : 40;

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Pick = <T>(items: readonly T[]) => T;

const COLUMNS = { customer: "VARCHAR", customer_no: "BIGINT", score: "DOUBLE" } as const;
type Column = keyof typeof COLUMNS;
const KEY_TYPES = ["VARCHAR", "BIGINT", "INTEGER", "DOUBLE", "FLOAT", "DECIMAL(9,2)"] as const;
type KeyType = (typeof KEY_TYPES)[number];
const INTEGERS = new Set(["BIGINT", "INTEGER"]);
const REGIONS = ["emea", "amer", "apac", null] as const;

function cell(value: string | number | null): string {
  return value === null ? "" : String(value);
}

function orders(pick: Pick, random: () => number): string {
  const lines = ["ordered_at,customer,customer_no,score,region,status,amount"];
  const n = 5 + Math.floor(random() * 25);
  for (let i = 0; i < n; i++) {
    const day = String(1 + Math.floor(random() * 28)).padStart(2, "0");
    lines.push(
      [
        `2026-0${1 + Math.floor(random() * 3)}-${day}`,
        cell(pick(["c1", "c2", "c3", "1", "2", null])),
        cell(pick([1, 2, 3, 4, 16777216, 16777217, null])),
        cell(pick([0.5, 1, 1.5, 2, null])),
        cell(pick(REGIONS)),
        pick(["paid", "refunded"]),
        String(Math.round(random() * 100000) / 100),
      ].join(","),
    );
  }
  lines.push("2026-03-31,c9,9,9,emea,paid,1");
  return lines.join("\n");
}

function keys(type: KeyType, pick: Pick, random: () => number): (string | number | null)[] {
  const n = Math.floor(random() * 6);
  const values = (
    type === "VARCHAR"
      ? ["c1", "c2", "1", "2", "1.5", "0.5", "", null]
      : type === "BIGINT" || type === "INTEGER"
        ? [1, 2, 3, 16777216, null]
        : type === "FLOAT"
          ? [0.5, 1, 1.5, 16777216, null]
          : [0.5, 1, 1.5, 2, 3, null]
  ) as (string | number | null)[];
  return Array.from({ length: n }, () => pick(values));
}

interface Case {
  seed: number;
  column: Column;
  keyType: KeyType;
  op: "in_table" | "not_in_table";
  via: "segment" | "filter";
  paid: boolean;
  regions: string[];
}

function sqlLiteral(value: string | number | null, type: KeyType): string {
  if (value === null) return `CAST(NULL AS ${type})`;
  return typeof value === "string" ? `CAST('${value}' AS ${type})` : `CAST(${value} AS ${type})`;
}

let oracle: Oracle;
beforeAll(async () => {
  oracle = await Oracle.open();
});
afterAll(async () => {
  oracle?.close();
  await removeProjects();
});

async function check(c: Case, random: () => number, pick: Pick): Promise<string[]> {
  const data = orders(pick, random);
  const list = keys(c.keyType, pick, random);
  const filter = { column: c.column, op: c.op, table: "k", key: "key" };
  const status = { column: "status", op: "eq", value: "paid" };
  const own = c.via === "filter" ? [filter] : [];
  const base = {
    type: "aggregate",
    table: "orders",
    time: "ordered_at",
    ...(own.length + (c.paid ? 1 : 0) > 0
      ? { filters: [...own, ...(c.paid ? [status] : [])] }
      : {}),
    ...(c.via === "segment" ? { segments: ["s"] } : {}),
  };
  const metrics = {
    total: { ...base, aggregate: "sum", column: "amount" },
    rows: { ...base, aggregate: "count" },
    people: { ...base, aggregate: "count_distinct", column: "customer" },
    average: { ...base, aggregate: "avg", column: "amount" },
    all_amount: {
      type: "aggregate",
      table: "orders",
      aggregate: "sum",
      column: "amount",
      time: "ordered_at",
    },
    share: { type: "ratio", numerator: "total", denominator: "all_amount" },
  };
  const names = Object.keys(metrics);
  const { root } = await writeProject({
    "hatchmark.yaml": {
      ...PROJECT_DEFAULTS,
      name: "sweep",
      sources: {
        orders: { type: "csv", path: "data/orders.csv" },
        k: { type: "parquet", path: "data/k.parquet" },
      },
    },
    "data/orders.csv": data,
    "segments/s.yaml": { label: "S", filters: [filter] },
    ...Object.fromEntries(
      Object.entries(metrics).map(([n, m]) => [`metrics/${n}.yaml`, metric(m)]),
    ),
    "dashboards/d.yaml": {
      title: "D",
      period: { asOf: "2026-03-31", range: "all_time", compare: "none" },
      ...(c.regions.length > 0
        ? {
            filters: [
              {
                type: "select",
                id: "region",
                column: "region",
                multiple: true,
                default: c.regions,
              },
            ],
          }
        : {}),
      blocks: [
        ...names.map((n) => ({ type: "kpi", id: n, metric: n })),
        { type: "table", id: "t", by: ["region"], metrics: names },
      ],
    },
  });
  await mkdir(path.join(root, "data"), { recursive: true });
  await oracle.run("DROP TABLE IF EXISTS k");
  await oracle.run(`CREATE TABLE k (key ${c.keyType})`);
  for (const v of list) await oracle.run(`INSERT INTO k VALUES (${sqlLiteral(v, c.keyType)})`);
  await oracle.run(`COPY k TO '${path.join(root, "data", "k.parquet")}' (FORMAT parquet)`);
  await oracle.run("DROP TABLE IF EXISTS o");
  await oracle.run(
    `CREATE TABLE o AS SELECT * FROM read_csv('${path.join(root, "data", "orders.csv")}', sample_size = -1)`,
  );

  const { project } = await loadAt(root);
  const result = await run(root, project, "d");
  const problems: string[] = [];
  const label = JSON.stringify(c);
  const warnings = result.diagnostics.map((d) => d.code);
  const [described] = await oracle.rows(
    `SELECT data_type FROM information_schema.columns WHERE table_name = 'o' AND column_name = '${c.column}'`,
  );
  const type = String(described?.data_type);
  const compares = type === c.keyType || (INTEGERS.has(type) && INTEGERS.has(c.keyType));
  if (!compares) {
    const ok =
      result.data === undefined &&
      warnings.length > 0 &&
      warnings.every((code) => code === "HM2029");
    return ok ? [] : [`${label}: expected only HM2029, got ${warnings.join(", ") || "none"}`];
  }
  if (warnings.length > 0) return [`${label}: diagnostics ${warnings.join(", ")}`];

  const side = (x: string) => x;
  const member = `EXISTS (SELECT 1 FROM k WHERE k.key IS NOT NULL AND ${side("k.key")} = ${side(`o.${c.column}`)})`;
  const kept = c.op === "in_table" ? member : `(o.${c.column} IS NULL OR NOT ${member})`;
  const where = [kept, ...(c.paid ? ["o.status = 'paid'"] : [])].join(" AND ");
  const region =
    c.regions.length > 0 ? `o.region IN (${c.regions.map((r) => `'${r}'`).join(", ")})` : "TRUE";
  const rows = await oracle.rows(
    `SELECT o.region,
      coalesce(sum(amount) FILTER (WHERE ${where}), 0) AS total,
      count(*) FILTER (WHERE ${where}) AS rows,
      count(DISTINCT customer) FILTER (WHERE ${where}) AS people,
      avg(amount) FILTER (WHERE ${where}) AS average,
      coalesce(sum(amount), 0) AS all_amount,
      GROUPING(o.region) AS g
    FROM o WHERE ${region} GROUP BY ROLLUP (o.region)`,
  );
  const expected = (r: Record<string, unknown> | undefined): Record<string, number | null> => {
    const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));
    const total = n(r?.total) ?? 0;
    const all = n(r?.all_amount) ?? 0;
    return {
      total,
      rows: n(r?.rows) ?? 0,
      people: n(r?.people) ?? 0,
      average: n(r?.average),
      all_amount: all,
      share: all === 0 ? null : total / all,
    };
  };
  const near = (a: number | null | undefined, b: number | null) =>
    b === null
      ? a === null
      : typeof a === "number" && Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b));
  const blocks = result.data?.blocks ?? [];
  const grand = expected(rows.find((r) => r.g === 1));
  for (const n of names) {
    const kpi = blocks.find((b) => b.id === n) as KpiData | undefined;
    if (!near(kpi?.value, grand[n] ?? null)) {
      problems.push(`${label}: kpi ${n} ${kpi?.value} != ${grand[n]}`);
    }
  }
  const table = blocks.find((b) => b.id === "t") as TableData | undefined;
  const groups = rows.filter((r) => r.g === 0);
  if (table?.rows.length !== groups.length) {
    problems.push(`${label}: ${table?.rows.length} table rows != ${groups.length}`);
  }
  for (const row of table?.rows ?? []) {
    const want = expected(groups.find((r) => r.region === row.keys[0]));
    for (const n of names) {
      if (!near(row.values[n], want[n] ?? null)) {
        problems.push(`${label}: ${String(row.keys[0])} ${n} ${row.values[n]} != ${want[n]}`);
      }
    }
  }
  for (const n of names) {
    if (!near(table?.total?.values[n], grand[n] ?? null)) {
      problems.push(`${label}: total ${n} ${table?.total?.values[n]} != ${grand[n]}`);
    }
  }
  return problems;
}

describe("segments and in_table filters agree with an independent SQL oracle", {
  timeout: FULL ? 1_800_000 : 300_000,
}, () => {
  it(`over ${CASES} random projects: key types, nulls, duplicates, empty lists, select filters`, async () => {
    const problems: string[] = [];
    for (let seed = 1; seed <= CASES; seed++) {
      const random = rng(seed);
      const pick: Pick = (items) =>
        items[Math.floor(random() * items.length)] as (typeof items)[number];
      const c: Case = {
        seed,
        column: pick(Object.keys(COLUMNS) as Column[]),
        keyType: pick(KEY_TYPES),
        op: pick(["in_table", "not_in_table"] as const),
        via: pick(["segment", "filter"] as const),
        paid: random() < 0.4,
        regions: random() < 0.4 ? ["emea", "apac"].filter(() => random() < 0.7) : [],
      };
      problems.push(...(await check(c, random, pick)));
    }
    expect(problems.slice(0, 20)).toEqual([]);
  });
});
