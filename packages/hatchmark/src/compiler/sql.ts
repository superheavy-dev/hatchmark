import { type Filter, keyComparison, parseTemporal, sameColumn, WEEKDAYS } from "../spec/index.js";
import { canonicalJson } from "./hash.js";
import { selectValues } from "./params.js";
import type { ExecutionContext, MeasureComponent, PlannedQuery } from "./plan.js";
import { queryBounds } from "./windows.js";

/** A value bound to a $name parameter. */
export type SqlValue = string | number | boolean;

/** SQL text and the values of its $name parameters. */
export interface BuiltSql {
  text: string;
  params: Record<string, SqlValue>;
}

/** A source as the SQL reads it: the relation holding its rows and its columns with DuckDB types. */
export interface SqlSource {
  name: string;
  relation: string;
  columns: { name: string; type: string }[];
  /** Time zone of timestamps without an offset (the source's "timezone"); UTC when absent. */
  timezone?: string;
  /** The sources the query's in_table and not_in_table filters read, by name. */
  tables?: Readonly<Record<string, SqlSource>>;
}

/** A query's SQL and the layout of its result row. */
export interface BuiltQuery extends BuiltSql {
  /** The measure components, in result column order after the dimensions. */
  components: MeasureComponent[];
  /** Index of the GROUPING() column when the query has dimensions; window columns follow it. */
  groupingAt: number;
  /** Metrics whose largest finite magnitude the query returns, one column each after GROUPING(). */
  large: string[];
  /** True when a raw SQL metric is in the query, which then runs on one thread. */
  serial: boolean;
}

/** The row's place in its source: file paths in UTF-8 byte order, then the row in its file. */
export const ORDINAL = '"__hm_ord"';

export function quote(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

/** Collects bound parameters; each value gets its own $name, so SQL can be assembled in any order. */
export class Sql {
  private readonly bound: Record<string, SqlValue> = {};
  private count = 0;

  bind(value: SqlValue): string {
    this.count += 1;
    const name = `hm_p${this.count}`;
    this.bound[name] = value;
    return `$${name}`;
  }

  values(): Record<string, SqlValue> {
    return { ...this.bound };
  }
}

export function column(source: SqlSource, name: string): { name: string; type: string } {
  const found = source.columns.find((c) => sameColumn(c.name, name));
  if (found === undefined) throw new Error(`source "${source.name}" has no column "${name}"`);
  return found;
}

export const isTimestamp = (type: string) => type.startsWith("TIMESTAMP");

function localTime(source: SqlSource, name: string, timezone: string, sql: Sql): string {
  const { name: actual, type } = column(source, name);
  const q = quote(actual);
  if (type === "DATE") return q;
  if (type === "TIMESTAMP WITH TIME ZONE") return `timezone(${sql.bind(timezone)}, ${q})`;
  if (isTimestamp(type)) {
    return `timezone(${sql.bind(timezone)}, timezone(${naiveZone(source, sql)}, CAST(${q} AS TIMESTAMP)))`;
  }
  throw new Error(
    `time column "${actual}" of source "${source.name}" has type ${type}; it needs DATE or TIMESTAMP`,
  );
}

function instant(source: SqlSource, name: string, timezone: string, sql: Sql): string {
  const { name: actual, type } = column(source, name);
  const q = quote(actual);
  if (type === "TIMESTAMP WITH TIME ZONE") return q;
  if (type === "DATE") return `timezone(${sql.bind(timezone)}, CAST(${q} AS TIMESTAMP))`;
  return `timezone(${naiveZone(source, sql)}, CAST(${q} AS TIMESTAMP))`;
}

function naiveZone(source: SqlSource, sql: Sql): string {
  return source.timezone === undefined ? "'UTC'" : sql.bind(source.timezone);
}

function sides(
  source: SqlSource,
  name: string,
  value: string | number | boolean,
  context: ExecutionContext,
  sql: Sql,
): [string, string] {
  const { name: actual, type } = column(source, name);
  if (type !== "DATE" && !isTimestamp(type)) return [quote(actual), sql.bind(value)];
  const parsed = typeof value === "string" ? parseTemporal(value) : undefined;
  if (parsed === undefined) {
    throw new Error(
      `${JSON.stringify(value)} is not an ISO 8601 date or date-time, which column "${actual}" of source "${source.name}" needs (HM3009)`,
    );
  }
  if (parsed.kind === "date") {
    const day =
      type === "DATE"
        ? quote(actual)
        : `CAST(${localTime(source, actual, context.timezone, sql)} AS DATE)`;
    return [day, `CAST(${sql.bind(parsed.text)} AS DATE)`];
  }
  const right =
    parsed.kind === "instant"
      ? `CAST(${sql.bind(parsed.text)} AS TIMESTAMPTZ)`
      : `timezone(${sql.bind(context.timezone)}, CAST(${sql.bind(parsed.text)} AS TIMESTAMP))`;
  return [instant(source, actual, context.timezone, sql), right];
}

const OPERATORS = { eq: "=", gt: ">", gte: ">=", lt: "<", lte: "<=" } as const;

function anyEqual(
  source: SqlSource,
  name: string,
  values: (string | number | boolean)[],
  context: ExecutionContext,
  sql: Sql,
): string {
  return `(${values
    .map((v) => {
      const [left, right] = sides(source, name, v, context, sql);
      return `${left} = ${right}`;
    })
    .join(" OR ")})`;
}

function filterSql(source: SqlSource, filter: Filter, context: ExecutionContext, sql: Sql): string {
  const q = quote(column(source, filter.column).name);
  switch (filter.op) {
    case "is_null":
      return `${q} IS NULL`;
    case "not_null":
      return `${q} IS NOT NULL`;
    case "in":
      return anyEqual(source, filter.column, filter.values, context, sql);
    case "not_in":
      return `(${q} IS NULL OR NOT ${anyEqual(source, filter.column, filter.values, context, sql)})`;
    case "between": {
      const [left, from] = sides(source, filter.column, filter.from, context, sql);
      const [leftTo, to] = sides(source, filter.column, filter.to, context, sql);
      return `(${left} >= ${from} AND ${leftTo} <= ${to})`;
    }
    case "in_table":
    case "not_in_table": {
      const table = source.tables?.[filter.table];
      if (table === undefined) {
        throw new Error(`source "${filter.table}" of an ${filter.op} filter is not loaded`);
      }
      const own = column(source, filter.column);
      const theirs = column(table, filter.key);
      const comparison = keyComparison(own.type, theirs.type);
      if (comparison === undefined) {
        throw new Error(
          `${filter.op} compares column "${own.name}" (${own.type}) of source "${source.name}" with key "${theirs.name}" (${theirs.type}) of source "${table.name}"; the types must match (HM2029)`,
        );
      }
      const side = (ref: string) => (comparison === "same" ? ref : `CAST(${ref} AS HUGEINT)`);
      const match = `EXISTS (SELECT 1 FROM ${table.relation} AS "hm_keys" WHERE ${side(`"hm_keys".${quote(theirs.name)}`)} = ${side(`"hm_rows".${q}`)})`;
      return filter.op === "in_table" ? match : `NOT ${match}`;
    }
    case "neq": {
      const [left, right] = sides(source, filter.column, filter.value, context, sql);
      return `${left} IS DISTINCT FROM ${right}`;
    }
    default: {
      const [left, right] = sides(source, filter.column, filter.value, context, sql);
      return `${left} ${OPERATORS[filter.op]} ${right}`;
    }
  }
}

export const isFloat = (type: string | undefined) => type === "DOUBLE" || type === "FLOAT";

function aggregateSql(component: MeasureComponent, source: SqlSource): string {
  const found = component.column === undefined ? undefined : column(source, component.column);
  const target = found && quote(found.name);
  const needs = (): string => {
    if (target === undefined) throw new Error(`component "${component.id}" needs a column`);
    return target;
  };
  switch (component.aggregate) {
    case "sql":
      return `(${component.sql ?? "NULL"})`;
    case "count":
      return target === undefined ? "count(*)" : `count(${target})`;
    case "count_distinct":
      return `count(DISTINCT ${needs()})`;
    case "sum":
      return isFloat(found?.type) ? `fsum(${needs()} ORDER BY ${ORDINAL})` : `sum(${needs()})`;
    case "avg":
      return isFloat(found?.type)
        ? `fsum(${needs()} ORDER BY ${ORDINAL}) / count(${needs()})`
        : `avg(${needs()})`;
    default:
      return `${component.aggregate}(${needs()})`;
  }
}

const NUMERIC =
  /^(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT|UHUGEINT|FLOAT|DOUBLE)$/;

function dimensionSql(
  source: SqlSource,
  dimension: PlannedQuery["dimensions"][number],
  context: ExecutionContext,
  sql: Sql,
): string {
  if (dimension.kind === "time") {
    const local = `CAST(${localTime(source, dimension.column, context.timezone, sql)} AS DATE)`;
    const { grain } = dimension;
    if (!("anchor" in grain)) {
      return grain.unit === "day" ? local : `CAST(date_trunc('month', ${local}) AS DATE)`;
    }
    if (grain.unit === "week") {
      const isoDay = WEEKDAYS.indexOf(grain.anchor) + 1;
      return `(${local} - CAST((isodow(${local}) - ${sql.bind(isoDay)} + 7) % 7 AS INTEGER))`;
    }
    const months = sql.bind(Number(grain.anchor.slice(0, 2)) - 1);
    const days = sql.bind(Number(grain.anchor.slice(3)) - 1);
    const shifted = `${local} - to_months(${months}) - to_days(${days})`;
    return `CAST(date_trunc(${sql.bind(grain.unit)}, ${shifted}) + to_months(${months}) + to_days(${days}) AS DATE)`;
  }
  const { name, type } = column(source, dimension.column);
  const q = quote(name);
  if (type === "VARCHAR" || type === "BOOLEAN" || type === "DATE" || NUMERIC.test(type)) return q;
  if (type.startsWith("DECIMAL")) return `CAST(${q} AS DOUBLE)`;
  if (isTimestamp(type)) {
    return `strftime(${localTime(source, name, context.timezone, sql)}, '%Y-%m-%d %H:%M:%S')`;
  }
  return `CAST(${q} AS VARCHAR)`;
}

/** The SQL of one planned query over its source. */
export function querySql(
  source: SqlSource,
  query: PlannedQuery,
  context: ExecutionContext,
): BuiltQuery {
  return builtQuery(source, query, context, new Sql());
}

/**
 * One statement for a query over several contexts, such as the windows of a period filter's
 * presets: each context's SELECT as querySql builds it, tagged with the context's index as a first
 * column, rows ordered by that index and then as querySql orders them. The other fields describe a
 * row without the tag.
 */
export function batchQuerySql(
  source: SqlSource,
  query: PlannedQuery,
  contexts: ExecutionContext[],
): BuiltQuery {
  const sql = new Sql();
  const parts = contexts.map((context, tag) => builtQuery(source, query, context, sql, tag));
  const first = parts[0];
  if (first === undefined) throw new Error("a batch needs at least one context");
  const order =
    query.dimensions.length > 0
      ? [`${first.groupingAt + 2}`, ...query.dimensions.map((_, i) => `${i + 2} ASC NULLS LAST`)]
      : [];
  return {
    ...first,
    text: [
      `SELECT * FROM (${parts.map((part) => `(${part.text})`).join("\nUNION ALL\n")})`,
      `ORDER BY ${["1", ...order].join(", ")}`,
    ].join("\n"),
    params: sql.values(),
  };
}

function builtQuery(
  source: SqlSource,
  query: PlannedQuery,
  context: ExecutionContext,
  sql: Sql,
  tag?: number,
): BuiltQuery {
  if (query.orderBy !== undefined || query.limit !== undefined) {
    throw new Error(
      "orderBy and limit are applied by assembly; the DuckDB executor does not take them",
    );
  }
  const where: string[] = [];
  const bounds = queryBounds(query, context);
  if (bounds === undefined) {
    throw new Error(`range "${query.window.range}" has no "${query.window.shift}" window`);
  }
  if (
    query.window.column !== undefined &&
    (bounds.kind === "bounded" || bounds.end !== undefined)
  ) {
    const column = query.window.column;
    const [start, end] = [bounds.kind === "bounded" ? bounds.start : undefined, bounds.end];
    const local = [start, end].some((v) => v !== undefined && !v.endsWith("Z"))
      ? localTime(source, column, context.timezone, sql)
      : "";
    const compare = (value: string, op: string) =>
      value.endsWith("Z")
        ? `${instant(source, column, context.timezone, sql)} ${op} CAST(${sql.bind(value)} AS TIMESTAMPTZ)`
        : `${local} ${op} CAST(${sql.bind(value)} AS DATE)`;
    if (start !== undefined) where.push(compare(start, ">="));
    if (end !== undefined) where.push(compare(end, "<"));
  }
  for (const param of query.params) {
    if (param.kind !== "select") continue;
    const values = selectValues(param, context.bindings);
    if (values.length > 0) where.push(anyEqual(source, param.column, values, context, sql));
  }

  const components = query.measures.flatMap((m) => m.components);
  const filtered = components.filter((c) => c.aggregate === "sql" && c.filters.length > 0);
  const shared = filtered[0]?.filters;
  if (shared !== undefined) {
    if (components.some((c) => canonicalJson(c.filters) !== canonicalJson(shared))) {
      throw new Error("a sql metric with filters must be the only measure of its query");
    }
    for (const filter of shared) where.push(filterSql(source, filter, context, sql));
  }
  const taken = (alias: string) => source.columns.some((c) => sameColumn(c.name, alias));
  const free = (base: string) => {
    let alias = base;
    for (let n = 1; taken(alias); n++) alias = `${base}_${n}`;
    return quote(alias);
  };
  const counts = new Set(query.measures.flatMap((m) => (m.rows === undefined ? [] : [m.rows])));
  const measureSql = components.map((c) => {
    const inWhere = shared !== undefined;
    const filters = inWhere ? [] : c.filters.map((f) => filterSql(source, f, context, sql));
    const clause = filters.length > 0 ? ` FILTER (WHERE ${filters.join(" AND ")})` : "";
    if (counts.has(c.id)) {
      const summed = source.columns.find(
        (s) => c.column !== undefined && sameColumn(s.name, c.column),
      );
      const numeric =
        c.column === undefined ||
        (summed !== undefined && (NUMERIC.test(summed.type) || summed.type.startsWith("DECIMAL(")));
      return numeric ? `count(*)${clause}` : "NULL";
    }
    const aggregate = `${aggregateSql(c, source)}${clause}`;
    return c.aggregate === "sum" ? `coalesce(${aggregate}, 0)` : aggregate;
  });

  const dimRefs = query.dimensions.map((_, i) => free(`hm_d${i}`));
  const dims = query.dimensions.map(
    (d, i) => `, ${dimensionSql(source, d, context, sql)} AS ${dimRefs[i]}`,
  );
  const grouped = dimRefs.length > 0;
  const at = (id: string) => measureSql[components.findIndex((c) => c.id === id)];
  const floatSum = (id: string) => {
    const c = components.find((x) => x.id === id);
    return (
      c?.aggregate === "sum" && c.column !== undefined && isFloat(column(source, c.column).type)
    );
  };
  const shown = query.measures.flatMap((m) => {
    const { combine } = m;
    if (combine.op === "identity")
      return floatSum(combine.component) ? [{ m, e: at(combine.component) }] : [];
    if (!floatSum(combine.numerator)) return [];
    return [{ m, e: `(${at(combine.numerator)}) / nullif(${at(combine.denominator)}, 0)` }];
  });
  const select = [
    ...(tag === undefined ? [] : [String(tag)]),
    ...dimRefs,
    ...measureSql,
    ...(grouped ? [`GROUPING(${dimRefs.join(", ")})`] : []),
    ...shown.map(({ e }) => `max(CASE WHEN isfinite(${e}) THEN abs(${e}) END) OVER ()`),
  ];
  const groupingAt = dimRefs.length + measureSql.length;
  const from = `(SELECT *${dims.join("")} FROM ${source.relation}) AS "hm_rows"`;
  const text = [
    `SELECT ${select.join(", ")}`,
    `FROM ${from}`,
    ...(where.length > 0 ? [`WHERE ${where.join(" AND ")}`] : []),
    ...(grouped
      ? [
          `GROUP BY GROUPING SETS (${query.groupingSets
            .map((set) => `(${set.map((i) => dimRefs[i]).join(", ")})`)
            .join(", ")})`,
        ]
      : []),
    ...(grouped && tag === undefined
      ? [
          `ORDER BY ${[`${groupingAt + 1}`, ...dimRefs.map((d) => `${d} ASC NULLS LAST`)].join(", ")}`,
        ]
      : []),
  ].join("\n");
  return {
    text,
    params: sql.values(),
    components,
    groupingAt,
    large: shown.map(({ m }) => m.metric),
    serial: components.some((c) => c.aggregate === "sql"),
  };
}

/**
 * The SQL of a source horizon (RFC 0001 section 6.1): the latest value of a column over all rows,
 * with no filters. A DATE column gives "YYYY-MM-DD"; a timestamp gives its UTC instant
 * "YYYY-MM-DDTHH:MM:SS.ffffff", read in the source's timezone (else UTC) when it has no offset.
 * A column of another type with no values (a header-only CSV) is empty; with values it is an error.
 * naive is true for a timestamp column without an offset.
 */
export function horizonSql(
  source: SqlSource,
  name: string,
): BuiltSql & { date: boolean; naive: boolean } {
  const sql = new Sql();
  const { name: actual, type } = column(source, name);
  if (type !== "DATE" && !isTimestamp(type)) {
    const wrong = `time column "${actual}" of source "${source.name}" has type ${type}; it needs DATE or TIMESTAMP`;
    return {
      text: `SELECT CASE WHEN count(${quote(actual)}) = 0 THEN NULL ELSE error(${sql.bind(wrong)}) END FROM ${source.relation}`,
      params: sql.values(),
      date: false,
      naive: false,
    };
  }
  const value =
    type === "DATE"
      ? `CAST(max(${quote(actual)}) AS VARCHAR)`
      : `strftime(timezone('UTC', max(${instant(source, actual, "UTC", sql)})), '%Y-%m-%dT%H:%M:%S.%f')`;
  return {
    text: `SELECT ${value} FROM ${source.relation}`,
    params: sql.values(),
    date: type === "DATE",
    naive: isTimestamp(type) && type !== "TIMESTAMP WITH TIME ZONE",
  };
}

/** The SQL type a value is bound as; the executor binds each parameter with exactly this type. */
export function sqlType(
  value: SqlValue,
): "VARCHAR" | "BOOLEAN" | "INTEGER" | "BIGINT" | "HUGEINT" | "DOUBLE" {
  if (typeof value === "string") return "VARCHAR";
  if (typeof value === "boolean") return "BOOLEAN";
  if (!Number.isInteger(value)) return "DOUBLE";
  if (value >= -(2 ** 31) && value < 2 ** 31) return "INTEGER";
  if (value >= -(2 ** 63) && value < 2 ** 63) return "BIGINT";
  if (value >= -(2 ** 127) && value < 2 ** 127) return "HUGEINT";
  throw new RangeError(`the whole number ${value} is outside the HUGEINT range, ±2^127`);
}

function literal(value: SqlValue): string {
  const type = sqlType(value);
  if (type === "VARCHAR") {
    const parts = String(value)
      .split("\0")
      .map((part) => `'${part.replaceAll("'", "''")}'`);
    return parts.length > 1 ? `(${parts.join(" || chr(0) || ")})` : (parts[0] as string);
  }
  if (type === "BOOLEAN") return value ? "TRUE" : "FALSE";
  if (type === "INTEGER") return (value as number) < 0 ? `(${value})` : String(value);
  if (type === "BIGINT" || type === "HUGEINT") return `CAST(${BigInt(value as number)} AS ${type})`;
  return `CAST(${Number.isFinite(value) ? String(value) : `'${String(value)}'`} AS DOUBLE)`;
}

/**
 * The SQL with every $name parameter replaced by a literal of its value's sqlType, for reading.
 * Quoted identifiers, string literals and comments are copied as they are, so a column named
 * "$hm_p1" keeps its meaning. check rejects "$hm_p" anywhere in a sql metric (HM3005), so raw SQL
 * never holds text the printer would replace.
 */
export function printSql(built: BuiltSql): string {
  const { text, params } = built;
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i] as string;
    const comment = text.startsWith("--", i) ? "\n" : text.startsWith("/*", i) ? "*/" : undefined;
    if (comment !== undefined) {
      const end = text.indexOf(comment, i + 2);
      const stop = end < 0 ? text.length : end + comment.length;
      out += text.slice(i, stop);
      i = stop;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < text.length) {
        if (text[j] === ch) {
          if (text[j + 1] === ch) j += 2;
          else break;
        } else j += 1;
      }
      out += text.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    const name = ch === "$" ? /^hm_p\d+\b/.exec(text.slice(i + 1))?.[0] : undefined;
    if (name !== undefined && Object.hasOwn(params, name)) {
      out += literal(params[name] as SqlValue);
      i += name.length + 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}
