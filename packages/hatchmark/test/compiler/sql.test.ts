import { describe, expect, it } from "vitest";
import type { PlannedQuery } from "../../src/compiler/index.js";
import { printSql, querySql, type SqlSource, sqlType } from "../../src/compiler/index.js";

describe("printSql", () => {
  it("inlines each parameter as a literal, and only parameters it has", () => {
    const params: Record<string, string | number | boolean> = {
      hm_p1: "O'Brien",
      hm_p2: true,
      hm_p3: -2,
    };
    for (let i = 4; i <= 10; i++) params[`hm_p${i}`] = i;
    const text =
      "a = $hm_p1 AND b = $hm_p2 AND c > $hm_p3 AND d = $hm_p10 AND e = $hm_p4 AND f = $other";
    expect(printSql({ text, params })).toBe(
      "a = 'O''Brien' AND b = TRUE AND c > (-2) AND d = 10 AND e = 4 AND f = $other",
    );
  });

  it("prints each number as a literal of the type it is bound as", () => {
    const values = [3, -2, 0.1, 3e10, 1e21, -0.5, Number.NaN, -Infinity];
    expect(values.map(sqlType)).toEqual([
      "INTEGER",
      "INTEGER",
      "DOUBLE",
      "BIGINT",
      "DOUBLE",
      "DOUBLE",
      "DOUBLE",
      "DOUBLE",
    ]);
    const params = Object.fromEntries(values.map((v, i) => [`hm_p${i + 1}`, v]));
    const text = values.map((_, i) => `$hm_p${i + 1}`).join(", ");
    expect(printSql({ text, params })).toBe(
      "3, (-2), CAST(0.1 AS DOUBLE), CAST(30000000000 AS BIGINT), CAST(1e+21 AS DOUBLE), CAST(-0.5 AS DOUBLE), CAST(NULL AS DOUBLE), CAST(NULL AS DOUBLE)",
    );
  });

  it("prints a NUL in a string with chr(0)", () => {
    expect(printSql({ text: "$hm_p1", params: { hm_p1: "a\0b'c" } })).toBe(
      "('a' || chr(0) || 'b''c')",
    );
  });

  it("leaves quoted identifiers, string literals and comments as they are", () => {
    const text =
      'SELECT "$hm_p1", "a""$hm_p1" FROM t WHERE x = \'$hm_p1\' AND y = $hm_p1 -- it\'s $hm_p1\nAND z = $hm_p1 /* $hm_p1 */';
    expect(printSql({ text, params: { hm_p1: 7 } })).toBe(
      'SELECT "$hm_p1", "a""$hm_p1" FROM t WHERE x = \'$hm_p1\' AND y = 7 -- it\'s $hm_p1\nAND z = 7 /* $hm_p1 */',
    );
  });
});

describe("querySql", () => {
  const source: SqlSource = {
    name: "orders",
    relation: '"__hm_source_orders"',
    columns: [
      { name: "ordered_at", type: "TIMESTAMP WITH TIME ZONE" },
      { name: "amount", type: "DOUBLE" },
      { name: "status", type: "VARCHAR" },
    ],
  };
  const query = {
    id: "q",
    source: "orders",
    input: { type: "csv", path: "data/orders.csv" },
    window: { range: "last_12_months", shift: "none", column: "ordered_at" },
    dimensions: [{ kind: "time", column: "ordered_at", grain: { unit: "month" } }],
    groupingSets: [[0]],
    measures: [
      {
        metric: "revenue",
        components: [
          {
            id: "revenue",
            aggregate: "sum",
            column: "amount",
            filters: [{ column: "status", op: "eq", value: "paid" }],
          },
        ],
        combine: { op: "identity", component: "revenue" },
      },
    ],
    params: [],
  } as unknown as PlannedQuery;
  const context = {
    asOf: "2026-10-31",
    timezone: "America/New_York",
    anchors: { week: "monday", quarter: "01-01", year: "01-01" },
    bindings: {},
  } as const;

  it("binds every value and reports the result layout", () => {
    const built = querySql(source, query, context);
    expect(Object.values(built.params)).toEqual([
      "America/New_York",
      "2025-11-01",
      "2026-11-01",
      "paid",
      "America/New_York",
    ]);
    expect(built.text).not.toMatch(/'paid'|2025-11-01|America/);
    expect(built).toMatchObject({ groupingAt: 2, large: ["revenue"], serial: false });
    expect(printSql(built)).toContain(
      "WHERE timezone('America/New_York', \"ordered_at\") >= CAST('2025-11-01' AS DATE)",
    );
  });
});
