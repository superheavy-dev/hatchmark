import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { type DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { run as cli } from "../../src/cli/main.js";
import { printSql, type SqlValue, sqlType } from "../../src/compiler/index.js";
import { boundParams } from "../../src/node/duckdb.js";
import { toYaml } from "../yaml.js";
import { removeProjects, writeProject } from "./fixture.js";

afterAll(removeProjects);

const serialize = (rows: unknown) =>
  JSON.stringify(rows, (_, v) =>
    typeof v === "bigint"
      ? `${v.toString()}n`
      : typeof v === "number" && !Number.isFinite(v)
        ? String(v)
        : v,
  );

async function connect(timezone: string): Promise<DuckDBConnection> {
  const connection = await (await DuckDBInstance.create(":memory:")).connect();
  await connection.run(`SET TimeZone = '${timezone}'`);
  return connection;
}

async function rows(connection: DuckDBConnection, text: string, params?: Record<string, SqlValue>) {
  try {
    const bound = params && boundParams(params);
    return serialize((await connection.runAndReadAll(text, bound?.values, bound?.types)).getRows());
  } catch (e) {
    return `error: ${String((e as Error).message).split("\n")[0]}`;
  }
}

describe("printSql literals run like the bound parameters", () => {
  let connection: DuckDBConnection;
  beforeAll(async () => {
    connection = await connect("UTC");
  });
  afterAll(() => connection.closeSync());

  it.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
    ["-0", -0],
    ["1e21", 1e21],
    ["1e19, past int64", 1e19],
    ["-1e19", -1e19],
    ["5e-324", 5e-324],
    ["2^31", 2 ** 31],
    ["2^53", 2 ** 53],
    ["2^53 + 4", 2 ** 53 + 4],
    ["2^63", 2 ** 63],
    ["1.7e38", 1.7e38],
    ["0.1 + 0.2", 0.1 + 0.2],
    ["MAX_SAFE_INTEGER + 2", Number.MAX_SAFE_INTEGER + 2],
    ["a quote", "O'Brien"],
    ["injection text", "x' OR '1'='1"],
    ["a backslash and quote", "a\\b'"],
    ["unicode with combining marks", "Côte d’Ivoire 🇨🇮 ﷽ e\u0301"],
    ["a newline", "a\nb"],
    ["NUL", "a\u0000b"],
    ["$hm_p text", "$hm_p1 $hm_p2"],
    ["true", true],
    ["false", false],
  ] as [string, SqlValue][])("%s", async (_, value) => {
    const bound = await rows(connection, "SELECT $hm_p1 AS v", { hm_p1: value });
    const printed = await rows(
      connection,
      `${printSql({ text: "SELECT $hm_p1", params: { hm_p1: value } })} AS v`,
    );
    expect(bound).not.toMatch(/^error/);
    expect(printed).toBe(bound);
  });

  it("binds whole numbers as INTEGER, BIGINT or HUGEINT by magnitude, and fractions as DOUBLE", () => {
    const types = Object.fromEntries(
      Object.entries({
        a: -0,
        b: 2 ** 31 - 1,
        c: 2 ** 31,
        d: 2 ** 53,
        e: 2 ** 63,
        f: -1e19,
        g: 0.5,
        h: 1e21,
      }).map(([k, v]) => [k, sqlType(v)]),
    );
    expect(types).toEqual({
      a: "INTEGER",
      b: "INTEGER",
      c: "BIGINT",
      d: "BIGINT",
      e: "HUGEINT",
      f: "HUGEINT",
      g: "DOUBLE",
      h: "HUGEINT",
    });
  });

  it.each([
    ["2^127", 2 ** 127],
    ["1e300", 1e300],
  ])(
    "refuses a whole number past HUGEINT (%s) instead of printing or binding it wrong",
    (_, value) => {
      expect(() => printSql({ text: "SELECT $hm_p1", params: { hm_p1: value } })).toThrow(
        RangeError,
      );
      expect(() => boundParams({ hm_p1: value })).toThrow(RangeError);
    },
  );

  it("leaves $hm_p1 inside a quoted identifier alone", async () => {
    const text = 'SELECT "cost$hm_p1" + $hm_p1 AS v FROM (SELECT 1 AS "cost$hm_p1")';
    const printed = printSql({ text, params: { hm_p1: 2 } });
    expect(printed).toBe('SELECT "cost$hm_p1" + 2 AS v FROM (SELECT 1 AS "cost$hm_p1")');
    expect(await rows(connection, printed)).toBe(await rows(connection, text, { hm_p1: 2 }));
  });
});

const statuses = [
  "paid",
  "O'Brien",
  "x' OR '1'='1",
  "Côte d’Ivoire 🇨🇮",
  "a\\b",
  "",
  'q"uote',
  "$hm_p1",
];
const regions = ["Île-de-France", "Texas", "Ontario", "", "São Paulo"];
const offsets = ["-05:00", "+09:00", "Z", "+05:30", "-04:00"];
const csvCell = (s: string) => (/[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s);
function hostileCsv(): string {
  let csv = 'id,ts,day,naive,Order Status,"a""b",région,amount,qty,flag,cost$hm_p1,customer,big\n';
  for (let i = 0; i < 400; i++) {
    const at = new Date(Date.UTC(2025, 0, 1) + i * 37.3 * 3600e3).toISOString().slice(0, 19);
    const amount = [1.005, 2.5, 0.1, 0.30000000000000004, -1.5, 1e15 + 0.5, 3][i % 7];
    csv += `${[
      i,
      at + offsets[i % 5],
      at.slice(0, 10),
      at.replace("T", " "),
      csvCell(statuses[i % statuses.length] as string),
      csvCell(['q"uote', "plain"][i % 2] as string),
      csvCell(regions[i % regions.length] as string),
      amount,
      i % 5,
      i % 3 === 0,
      (i % 4) / 2,
      `C${i % 23}`,
      i % 9 === 0 ? "" : String(BigInt(i) * 1000000000000n),
    ].join(",")}\n`;
  }
  return csv;
}

const base = { format: { type: "number" }, better: "up", label: "M" };
const agg = (extra: Record<string, unknown>) => ({
  ...base,
  type: "aggregate",
  table: "events",
  time: "ts",
  ...extra,
});
const F = (column: string, op: string, rest: Record<string, unknown> = {}) => ({
  column,
  op,
  ...rest,
});
const sqlMetric = (sql: string) => ({
  ...base,
  type: "sql",
  table: "events",
  additive: true,
  time: "ts",
  sql,
});
const METRICS: Record<string, unknown> = {
  k_count: agg({ aggregate: "count" }),
  k_count_col: agg({ aggregate: "count", column: "big" }),
  k_count_distinct: agg({ aggregate: "count_distinct", column: "customer" }),
  k_sum_double: agg({ aggregate: "sum", column: "amount" }),
  k_sum_int: agg({ aggregate: "sum", column: "qty" }),
  k_sum_bigint: agg({ aggregate: "sum", column: "big" }),
  k_avg_double: agg({ aggregate: "avg", column: "amount" }),
  k_avg_int: agg({ aggregate: "avg", column: "qty" }),
  k_min: agg({ aggregate: "min", column: "amount" }),
  k_max: agg({ aggregate: "max", column: "amount" }),
  k_median: agg({ aggregate: "median", column: "amount" }),
  k_time_date: agg({ aggregate: "count", time: "day" }),
  k_time_naive: agg({ aggregate: "count", time: "naive" }),
  k_timeless: { ...base, type: "aggregate", table: "events", aggregate: "sum", column: "qty" },
  k_sql: sqlMetric("sum(amount) FILTER (WHERE \"Order Status\" <> 'paid')"),
  k_sql_filtered: {
    ...sqlMetric("max(amount) - min(amount)"),
    additive: false,
    filters: [F("Order Status", "neq", { value: "O'Brien" })],
  },
  f_bigint_2p53: agg({
    aggregate: "count",
    filters: [F("big", "eq", { value: 9007199254740992 })],
  }),
  f_bigint_safe: agg({
    aggregate: "count",
    filters: [F("big", "eq", { value: 9007199254740991 })],
  }),
  k_ratio: { ...base, type: "ratio", numerator: "k_sum_double", denominator: "k_count" },
  k_formula: { ...base, type: "formula", expr: "k_sum_double + k_count * 0.5" },
  k_per_entity: {
    ...base,
    type: "per_entity",
    of: "k_last_entity",
    key: "customer",
    prior: { months: 12 },
  },
  k_last_entity: agg({ aggregate: "sum", column: "amount", over_time: "last", entity: "customer" }),
  k_trailing: agg({ aggregate: "sum", column: "amount", trailing: { days: 30 } }),
  k_active: {
    ...base,
    type: "aggregate",
    table: "events",
    aggregate: "count",
    active: { from: "ts", to: "null" },
  },
  k_value: agg({ aggregate: "sum", value: "amount * qty" }),
  f_quote: agg({ aggregate: "count", filters: [F("Order Status", "eq", { value: "O'Brien" })] }),
  f_inject: agg({
    aggregate: "count",
    filters: [F("Order Status", "eq", { value: "x' OR '1'='1" })],
  }),
  f_unicode: agg({
    aggregate: "count",
    filters: [F("Order Status", "in", { values: ["Côte d’Ivoire 🇨🇮", "paid"] })],
  }),
  f_backslash: agg({ aggregate: "count", filters: [F("Order Status", "eq", { value: "a\\b" })] }),
  f_dollar_value: agg({
    aggregate: "count",
    filters: [F("Order Status", "eq", { value: "$hm_p1" })],
  }),
  f_not_in: agg({
    aggregate: "count",
    filters: [F("Order Status", "not_in", { values: ["paid", ""] })],
  }),
  f_neq: agg({ aggregate: "count", filters: [F("Order Status", "neq", { value: "paid" })] }),
  f_is_null: agg({ aggregate: "count", filters: [F("Order Status", "is_null")] }),
  f_not_null: agg({ aggregate: "count", filters: [F("région", "not_null")] }),
  f_gt_frac: agg({ aggregate: "count", filters: [F("qty", "gt", { value: 2.5 })] }),
  f_eq_double: agg({ aggregate: "count", filters: [F("amount", "eq", { value: 1.005 })] }),
  f_eq_float_noise: agg({
    aggregate: "count",
    filters: [F("amount", "eq", { value: 0.30000000000000004 })],
  }),
  f_negative: agg({ aggregate: "count", filters: [F("amount", "gte", { value: -1.5 })] }),
  f_lte_neg_zero: agg({ aggregate: "count", filters: [F("qty", "lte", { value: -0 })] }),
  f_huge: agg({ aggregate: "count", filters: [F("amount", "lt", { value: 1e19 })] }),
  f_big_int_col: agg({
    aggregate: "count",
    filters: [F("big", "gte", { value: 2 ** 53 })],
  }),
  f_tiny: agg({ aggregate: "count", filters: [F("amount", "gt", { value: 5e-324 })] }),
  f_bool: agg({ aggregate: "count", filters: [F("flag", "eq", { value: true })] }),
  f_bool_string: agg({ aggregate: "count", filters: [F("flag", "eq", { value: "true" })] }),
  f_num_on_text: agg({ aggregate: "count", filters: [F("Order Status", "eq", { value: 5 })] }),
  f_between_days: agg({
    aggregate: "count",
    filters: [F("ts", "between", { from: "2026-01-01", to: "2026-01-31" })],
  }),
  f_instant: agg({
    aggregate: "count",
    filters: [F("ts", "gte", { value: "2025-06-15T23:00:00-05:00" })],
  }),
  f_local_dst_gap: agg({
    aggregate: "count",
    filters: [F("naive", "lt", { value: "2025-03-09T02:30:00" })],
  }),
  f_day_on_date: agg({
    aggregate: "count",
    filters: [F("day", "in", { values: ["2025-01-02", "2025-06-30"] })],
  }),
  f_quoted_col: agg({ aggregate: "count", filters: [F('a"b', "eq", { value: 'q"uote' })] }),
  f_dollar_col: agg({
    aggregate: "sum",
    column: "cost$hm_p1",
    filters: [F("cost$hm_p1", "gt", { value: 0.4 })],
  }),
  f_unicode_col: agg({
    aggregate: "count",
    filters: [F("région", "eq", { value: "Île-de-France" })],
  }),
  f_many: agg({
    aggregate: "sum",
    column: "amount",
    filters: Array.from({ length: 12 }, (_, i) => F("qty", "neq", { value: 100 + i })),
  }),
  f_nul: agg({ aggregate: "count", filters: [F("Order Status", "neq", { value: "a\u0000b" })] }),
  hm1: agg({ aggregate: "count" }),
};
const DASHBOARD = {
  title: "Hostile",
  period: { asOf: "latest_data", range: "last_12_months", compare: "previous_period" },
  filters: [
    {
      type: "select",
      id: "status",
      column: "Order Status",
      multiple: true,
      default: ["O'Brien", "x' OR '1'='1", "$hm_p1"],
    },
    { type: "select", id: "region", column: "région", default: "Île-de-France" },
    { type: "grain", id: "grain", options: ["week", "month", "quarter"], default: "month" },
  ],
  blocks: [
    { type: "kpi", id: "kpi_sum", metric: "k_sum_double", sparkline: true },
    { type: "kpi", id: "kpi_ratio", metric: "k_ratio" },
    {
      type: "line",
      id: "line_grains",
      metrics: ["k_sum_double"],
      grain: "month",
      grains: ["week", "month", "quarter"],
      split: "Order Status",
    },
    {
      type: "line",
      id: "line_anchor",
      metrics: ["k_count"],
      grain: { unit: "quarter", anchor: "02-01" },
    },
    {
      type: "bar",
      id: "bar_week_anchor",
      metrics: ["k_count"],
      grain: { unit: "week", anchor: "wednesday" },
    },
    { type: "bar", id: "bar_split_quoted", metrics: ["f_quote"], by: 'a"b' },
    {
      type: "table",
      id: "table_unicode",
      by: ["région"],
      metrics: ["k_count", "k_sum_int", "k_avg_double"],
    },
    { type: "kpi", id: "kpi_sql", metric: "k_sql_filtered" },
  ],
};

type Printed = { id: string; source: string; sql: string; params: Record<string, SqlValue> };

describe("a hostile project's printed SQL runs like its bound SQL", () => {
  let root: string;
  const hatchmark = async (...argv: string[]) => {
    let stdout = "";
    const code = await cli([...argv, "--cwd", root], {
      stdout: (t) => {
        stdout += t;
      },
      stderr: () => {},
      cwd: root,
      env: { NO_COLOR: "1" },
      stdoutIsTTY: false,
      isAgent: async () => false,
    });
    return { code, stdout };
  };

  beforeAll(async () => {
    const files: Record<string, unknown> = {
      "hatchmark.yaml": {
        version: 1,
        name: "Hostile",
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
        sources: { events: { type: "csv", path: "data/events.csv" } },
      },
      "data/events.csv": hostileCsv(),
      "dashboards/hostile.yaml": DASHBOARD,
    };
    for (const [name, m] of Object.entries(METRICS)) files[`metrics/${name}.yaml`] = m;
    ({ root } = await writeProject(files));
  });

  it("check passes, and every query from explain --json and check --sql --json returns the same rows bound and printed, also under session TimeZone Asia/Seoul; only the number compared with a text column fails, the same way both ways", {
    timeout: 60_000,
  }, async () => {
    const check = await hatchmark("check", "--json");
    expect(check.code).toBe(0);

    const queries: (Printed & { where: string })[] = [];
    for (const name of Object.keys(METRICS).sort()) {
      const json = await hatchmark("explain", name, "--json");
      expect(json.code, name).toBe(0);
      const explained = JSON.parse(json.stdout).queries as Printed[];
      const human = await hatchmark("explain", name, "--format", "human");
      const rendered = explained
        .map(
          (q) =>
            `-- query ${q.id} on source "${q.source}"\n${printSql({ text: q.sql, params: q.params })};`,
        )
        .join("\n\n");
      expect(human.stdout, name).toContain(rendered);
      for (const q of explained) queries.push({ where: `explain ${name}`, ...q });
    }
    const sqlCheck = await hatchmark("check", "--sql", "--json");
    expect(sqlCheck.code).toBe(0);
    const blocks = JSON.parse(sqlCheck.stdout).sql as {
      dashboard: string;
      block: string;
      queries: Printed[];
    }[];
    expect(blocks).toHaveLength(DASHBOARD.blocks.length);
    for (const b of blocks)
      for (const q of b.queries) queries.push({ where: `check --sql ${b.block}`, ...q });
    expect(queries.length).toBeGreaterThan(50);

    const load = async (timezone: string) => {
      const connection = await connect(timezone);
      await connection.run("SET preserve_insertion_order = true");
      const file = path.join(root, "data/events.csv").replaceAll("'", "''");
      await connection.run(
        'CREATE TEMP TABLE "__hm_source_events" AS SELECT *, row_number() OVER () AS "__hm_ord" FROM read_csv(\'' +
          file +
          "', delim = ',', header = true, quote = '\"', escape = '\"', sample_size = -1)",
      );
      return connection;
    };
    const utc = await load("UTC");
    const seoul = await load("Asia/Seoul");
    try {
      const differ: unknown[] = [];
      const failing = new Set<string>();
      for (const q of queries) {
        const printed = printSql({ text: q.sql, params: q.params });
        const bound = await rows(utc, q.sql, q.params);
        const literal = await rows(utc, printed);
        const literalSeoul = await rows(seoul, printed);
        if (bound.startsWith("error")) failing.add(q.where);
        if (literal !== bound || literalSeoul !== literal) {
          differ.push({
            where: q.where,
            id: q.id,
            bound: bound.slice(0, 160),
            literal: literal.slice(0, 160),
            seoul: literalSeoul.slice(0, 160),
          });
        }
        expect(JSON.parse(JSON.stringify(q.params))).toEqual(q.params);
      }
      expect(differ.slice(0, 3)).toEqual([]);
      expect([...failing]).toEqual(["explain f_num_on_text"]);
    } finally {
      utc.closeSync();
      seoul.closeSync();
    }
  });

  it("explain --dashboard --block prints a block's queries and fails cleanly on an unknown block", async () => {
    for (const block of ["kpi_sum", "line_grains", "bar_split_quoted"]) {
      const r = await hatchmark("explain", "--dashboard", "hostile", "--block", block, "--json");
      expect(r.code, block).toBe(0);
      expect(JSON.parse(r.stdout).queries.length, block).toBeGreaterThan(0);
    }
    const unknown = await hatchmark(
      "explain",
      "--dashboard",
      "hostile",
      "--block",
      "nope",
      "--json",
    );
    expect(unknown.code).toBe(2);
    expect(JSON.parse(unknown.stdout).diagnostics.map((d: { code: string }) => d.code)).toEqual([
      "HM0002",
    ]);
  });

  it.each([
    ["plain", "count(*) FILTER (WHERE \"Order Status\" <> '$hm_p1')"],
    ["upper case", "count(*) FILTER (WHERE \"Order Status\" <> '$HM_P1')"],
    ["dollar quoted", 'count(*) FILTER (WHERE "Order Status" <> $$hm_p1$)'],
    ["E string", "count(*) FILTER (WHERE \"Order Status\" <> E'it\\'s $hm_p1')"],
    ["in an identifier", 'sum("cost$Hm_P1")'],
    ["bare", "sum(amount) * $hm_p1"],
    ["prefix only, in a comment", "count(*) -- $hm_p"],
  ])(
    "check rejects the reserved $hm_p prefix in a sql metric (%s), and explain refuses to run",
    async (_, sql) => {
      const file = path.join(root, "metrics/r_reserved.yaml");
      await writeFile(file, toYaml(sqlMetric(sql)));
      try {
        const check = await hatchmark("check", "--json");
        expect(check.code).not.toBe(0);
        const hits = (
          JSON.parse(check.stdout).diagnostics as { code: string; file?: string }[]
        ).filter((d) => d.file === "metrics/r_reserved.yaml");
        expect(hits.map((d) => d.code)).toEqual(["HM3005"]);
        expect((await hatchmark("explain", "k_count", "--json")).code).not.toBe(0);
      } finally {
        await rm(file);
      }
    },
  );

  it("check accepts sql that only looks like the reserved prefix", async () => {
    const file = path.join(root, "metrics/r_ok.yaml");
    await writeFile(
      file,
      toYaml(sqlMetric("count(*) FILTER (WHERE \"Order Status\" <> 'hm_p1 $hm $1')")),
    );
    try {
      expect((await hatchmark("check", "--json")).code).toBe(0);
    } finally {
      await rm(file);
    }
  });

  it("check rejects a spec number that parses to Infinity (1e400)", async () => {
    const file = path.join(root, "metrics/f_inf.yaml");
    await writeFile(
      file,
      toYaml(agg({ aggregate: "count", filters: [F("amount", "lt", { value: 0 })] })).replace(
        "value: 0\n",
        "value: 1e400\n",
      ),
    );
    try {
      const check = await hatchmark("check", "--json");
      expect(check.code).not.toBe(0);
      expect(check.stdout).toContain("f_inf.yaml");
    } finally {
      await rm(file);
    }
  });
});
