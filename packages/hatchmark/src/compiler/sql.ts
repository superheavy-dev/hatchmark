import { matchRegion, notDrawnIds, regionKeySql } from "../geo/aliases.js";
import {
  type Filter,
  type GeographyId,
  keyComparison,
  parseTemporal,
  sameColumn,
  WEEKDAYS,
} from "../spec/index.js";
import { canonicalJson } from "./hash.js";
import { segmentValues, selectValues } from "./params.js";
import type {
  ExecutionContext,
  MeasureComponent,
  PlannedQuery,
  SnapshotEvaluation,
} from "./plan.js";
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

function snapshotKey(source: SqlSource, name: string, timezone: string, sql: Sql): string {
  const { name: actual, type } = column(source, name);
  if (type === "DATE") return quote(actual);
  if (type === "TIMESTAMP_NS") {
    const q = quote(actual);
    return `(epoch_ns(${q}) - (epoch_us(CAST(${q} AS TIMESTAMP)) - epoch_us(${instant(source, actual, timezone, sql)})) * 1000)`;
  }
  if (isTimestamp(type)) return instant(source, actual, timezone, sql);
  throw new Error(
    `time column "${actual}" of source "${source.name}" has type ${type}; it needs DATE or TIMESTAMP`,
  );
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

function sameRegion(
  source: SqlSource,
  name: string,
  geo: GeographyId,
  values: (string | number | boolean)[],
  context: ExecutionContext,
  sql: Sql,
): string {
  const ids = new Set<string>();
  const raw: (string | number | boolean)[] = [];
  for (const value of values) {
    const match = matchRegion(geo, value);
    if (match.kind === "matched" || match.kind === "not_drawn") ids.add(match.id);
    else raw.push(value);
  }
  const key = regionKeySql(geo, quote(column(source, name).name));
  const parts = [
    ...(ids.size > 0 ? [`${key} IN (${[...ids].map((id) => sql.bind(id)).join(", ")})`] : []),
    ...(raw.length > 0 ? [anyEqual(source, name, raw, context, sql)] : []),
  ];
  return `(${parts.join(" OR ")})`;
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
  if (dimension.kind === "time" && dimension.filters !== undefined) {
    const { filters, ...plain } = dimension;
    const bucket = dimensionSql(source, plain, context, sql);
    const when = filters.map((f) => filterSql(source, f, context, sql));
    return when.length === 0 ? bucket : `CASE WHEN ${when.join(" AND ")} THEN ${bucket} END`;
  }
  if (dimension.kind === "snapshot") {
    const key = snapshotKey(source, dimension.column, context.timezone, sql);
    const { type } = column(source, dimension.column);
    if (type === "DATE") return `CAST(${key} AS VARCHAR)`;
    if (type !== "TIMESTAMP_NS")
      return `strftime(timezone('UTC', ${key}), '%Y-%m-%dT%H:%M:%S.%fZ')`;
    const rest = `((${key} % 1000) + 1000) % 1000`;
    return `strftime(make_timestamp((${key} - ${rest}) // 1000), '%Y-%m-%dT%H:%M:%S.%f') || lpad(CAST(${rest} AS VARCHAR), 3, '0') || 'Z'`;
  }
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
  if (dimension.kind === "region") return regionKeySql(dimension.geo, q);
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
  const windowOn = (column: string | undefined): string[] => {
    if (column === undefined || !(bounds.kind === "bounded" || bounds.end !== undefined)) return [];
    const [start, end] = [bounds.kind === "bounded" ? bounds.start : undefined, bounds.end];
    const local = [start, end].some((v) => v !== undefined && !v.endsWith("Z"))
      ? localTime(source, column, context.timezone, sql)
      : "";
    const compare = (value: string, op: string) =>
      value.endsWith("Z")
        ? `${instant(source, column, context.timezone, sql)} ${op} CAST(${sql.bind(value)} AS TIMESTAMPTZ)`
        : `${local} ${op} CAST(${sql.bind(value)} AS DATE)`;
    return [
      ...(start === undefined ? [] : [compare(start, ">=")]),
      ...(end === undefined ? [] : [compare(end, "<")]),
    ];
  };
  const perSet = query.measures.some((m) => m.components.some((c) => c.anyOf !== undefined));
  const windowed = perSet ? [] : windowOn(query.window.column);
  if (query.evaluation === undefined) where.push(...windowed);
  for (const param of query.params) {
    if (param.kind === "segment") {
      const on = segmentValues(param, context.bindings);
      for (const segment of param.segments) {
        if (!on.includes(segment.name)) continue;
        for (const filter of segment.filters) where.push(filterSql(source, filter, context, sql));
      }
      continue;
    }
    if (param.kind !== "select") continue;
    const values = selectValues(param, context.bindings);
    if (values.length === 0) continue;
    where.push(
      param.geo === undefined
        ? anyEqual(source, param.column, values, context, sql)
        : sameRegion(source, param.column, param.geo, values, context, sql),
    );
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
  const measureSql = components.map((c) => {
    const inWhere = shared !== undefined;
    const filters = inWhere ? [] : c.filters.map((f) => filterSql(source, f, context, sql));
    const any = (c.anyOf ?? []).map((set) => {
      const parts = [
        ...windowOn(set.time),
        ...set.filters.map((f) => filterSql(source, f, context, sql)),
      ];
      return parts.length > 0 ? `(${parts.join(" AND ")})` : "TRUE";
    });
    if (any.length > 0) filters.push(`(${any.join(" OR ")})`);
    const clause = filters.length > 0 ? ` FILTER (WHERE ${filters.join(" AND ")})` : "";
    const aggregate = `${aggregateSql(c, source)}${clause}`;
    return c.aggregate === "sum" ? `coalesce(${aggregate}, 0)` : aggregate;
  });

  const dimRefs = query.dimensions.map((_, i) => free(`hm_d${i}`));
  const dims = query.dimensions.map(
    (d, i) => `, ${dimensionSql(source, d, context, sql)} AS ${dimRefs[i]}`,
  );
  query.dimensions.forEach((d, i) => {
    if (d.kind !== "region" || d.unmatched === "keep") return;
    const hidden = notDrawnIds(d.geo).map((id) => `'${id}'`);
    where.push(
      hidden.length === 0
        ? `${dimRefs[i]} IS NOT NULL`
        : `${dimRefs[i]} NOT IN (${hidden.join(", ")})`,
    );
  });
  if (query.evaluation !== undefined) {
    return snapshotQuery({
      source,
      query,
      evaluation: query.evaluation,
      context,
      sql,
      tag,
      windowed,
      where,
      dims,
      dimRefs,
      components,
      measureSql,
      key: free("hm_s"),
    });
  }
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

function floatSumOf(source: SqlSource, c: MeasureComponent | undefined): boolean {
  return c?.aggregate === "sum" && c.column !== undefined && isFloat(column(source, c.column).type);
}

function snapshotQuery(input: {
  source: SqlSource;
  query: PlannedQuery;
  evaluation: SnapshotEvaluation;
  context: ExecutionContext;
  sql: Sql;
  tag: number | undefined;
  windowed: string[];
  where: string[];
  dims: string[];
  dimRefs: string[];
  components: MeasureComponent[];
  measureSql: string[];
  key: string;
}): BuiltQuery {
  const { source, query, evaluation, context, sql, tag, where, dimRefs, components, key } = input;
  const rows = '"hm_rows"';
  const filtered = where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "";
  const keyExpr = snapshotKey(source, evaluation.column, context.timezone, sql);
  const ctes = [
    `${rows} AS (SELECT *${input.dims.join("")}, ${keyExpr} AS ${key} FROM ${source.relation} WHERE ${[
      ...input.windowed,
      `${keyExpr} IS NOT NULL`,
    ].join(" AND ")})`,
  ];
  const values = components.map((_, j) => `"hm_c${j}"`);
  const width = query.dimensions.length;
  const sets = query.groupingSets.map((set, i) => {
    const inSet = [...set].sort((a, b) => a - b);
    const buckets = inSet.filter((d) => {
      const kind = query.dimensions[d]?.kind;
      return kind === "time" || kind === "snapshot";
    });
    const groups = inSet.filter((d) => !buckets.includes(d));
    const refs = (ds: number[]) => ds.map((d) => dimRefs[d] as string);
    const same = (a: string, b: string, ds: number[]) =>
      refs(ds).map((r) => `${a}.${r} IS NOT DISTINCT FROM ${b}.${r}`);
    const by = (ds: string[]) => (ds.length > 0 ? ` GROUP BY ${ds.join(", ")}` : "");
    const pickOne =
      evaluation.pick === "last" ? "max" : evaluation.pick === "first" ? "min" : undefined;
    const k = `"hm_k${i}"`;
    const g = `"hm_g${i}"`;
    const v = `"hm_v${i}"`;
    ctes.push(
      pickOne === undefined
        ? `${k} AS (SELECT DISTINCT ${[...refs(buckets), key].join(", ")} FROM ${rows})`
        : `${k} AS (SELECT ${[...refs(buckets), `${pickOne}(${key}) AS ${key}`].join(", ")} FROM ${rows}${by(refs(buckets))} HAVING count(*) > 0)`,
    );
    const grid =
      groups.length === 0 || !buckets.some((d) => query.dimensions[d]?.kind === "snapshot");
    if (grid) {
      ctes.push(
        groups.length === 0
          ? `${g} AS (SELECT 1 AS "hm_one")`
          : `${g} AS (SELECT DISTINCT ${refs(groups).join(", ")} FROM ${rows}${filtered})`,
      );
    }
    const inner = [...refs(buckets), key, ...refs(groups)];
    ctes.push(
      `${v} AS (SELECT ${[...inner, ...input.measureSql.map((m, j) => `${m} AS ${values[j]}`)].join(", ")} FROM ${rows}${filtered} GROUP BY ${inner.join(", ")})`,
    );
    const onBucket = [...same("k", "v", buckets), `k.${key} = v.${key}`];
    const from = grid
      ? `${k} AS k CROSS JOIN ${g} AS g LEFT JOIN ${v} AS v ON ${[...onBucket, ...same("g", "v", groups)].join(" AND ")}`
      : `${k} AS k JOIN ${v} AS v ON ${onBucket.join(" AND ")}`;
    const groupSide = grid ? "g" : "v";
    const outer = components.map((c, j) => {
      const empty =
        c.aggregate === "sum" || c.aggregate === "count" || c.aggregate === "count_distinct";
      const value = empty ? `coalesce(v.${values[j]}, 0)` : `v.${values[j]}`;
      switch (evaluation.pick) {
        case "avg":
          return `fsum(CAST(${value} AS DOUBLE) ORDER BY k.${key}) / count(${value})`;
        case "min":
          return `min(${value})`;
        default:
          return `max(${value})`;
      }
    });
    const mask = query.dimensions.reduce(
      (m, _, d) => (set.includes(d) ? m : m | (1 << (width - 1 - d))),
      0,
    );
    const select = [
      ...query.dimensions.map((_, d) => {
        const ref = dimRefs[d] as string;
        if (buckets.includes(d)) return `k.${ref} AS ${ref}`;
        if (groups.includes(d)) return `${groupSide}.${ref} AS ${ref}`;
        return `NULL AS ${ref}`;
      }),
      ...outer.map((o, j) => `${o} AS ${values[j]}`),
      ...(width > 0 ? [`${mask} AS "hm_grouping"`] : []),
    ];
    const keys = [
      ...buckets.map((d) => `k.${dimRefs[d]}`),
      ...groups.map((d) => `${groupSide}.${dimRefs[d]}`),
    ];
    return `SELECT ${select.join(", ")} FROM ${from}${keys.length > 0 ? ` GROUP BY ${keys.join(", ")}` : ""}`;
  });
  ctes.push(`"hm_out" AS (${sets.join(" UNION ALL ")})`);
  const grouped = width > 0;
  const shown = query.measures.flatMap((m) => {
    const at = (id: string) => values[components.findIndex((c) => c.id === id)];
    const { combine } = m;
    if (combine.op === "identity") {
      return floatSumOf(
        source,
        components.find((c) => c.id === combine.component),
      )
        ? [{ m, e: at(combine.component) }]
        : [];
    }
    if (
      !floatSumOf(
        source,
        components.find((c) => c.id === combine.numerator),
      )
    )
      return [];
    return [{ m, e: `(${at(combine.numerator)}) / nullif(${at(combine.denominator)}, 0)` }];
  });
  const select = [
    ...(tag === undefined ? [] : [String(tag)]),
    ...dimRefs,
    ...values,
    ...(grouped ? ['"hm_grouping"'] : []),
    ...shown.map(({ e }) => `max(CASE WHEN isfinite(${e}) THEN abs(${e}) END) OVER ()`),
  ];
  const groupingAt = dimRefs.length + values.length;
  const from = grouped
    ? '"hm_out"'
    : `(SELECT ${values.map((c) => `max(${c}) AS ${c}`).join(", ")} FROM "hm_out") AS "hm_out"`;
  const text = [
    `WITH ${ctes.join(",\n")}`,
    `SELECT ${select.join(", ")}`,
    `FROM ${from}`,
    ...(grouped && tag === undefined
      ? [`ORDER BY ${['"hm_grouping"', ...dimRefs.map((d) => `${d} ASC NULLS LAST`)].join(", ")}`]
      : []),
  ].join("\n");
  return {
    text,
    params: sql.values(),
    components,
    groupingAt,
    large: shown.map(({ m }) => m.metric),
    serial: false,
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
