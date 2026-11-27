import path from "node:path";
import {
  type DuckDBConnection,
  DuckDBDateValue,
  DuckDBDecimalValue,
  DuckDBInstance,
  type DuckDBValue,
} from "@duckdb/node-api";
import {
  canonicalJson,
  type DashboardExecutor,
  type ExecutionContext,
  type MeasureComponent,
  type PlannedQuery,
  type QueryResult,
  queryBounds,
  selectValues,
  type TimeColumn,
} from "../compiler/index.js";
import {
  type Filter,
  normalizePath,
  type ProjectConfig,
  parseTemporal,
  type Source,
  sameColumn,
} from "../spec/index.js";

/**
 * The DuckDB executor (build mode): runs planned queries over the project's CSV, Parquet and JSON
 * files with DuckDB, in process.
 *
 * Reading files. Every reader option that DuckDB would otherwise sniff is set from the source
 * config: CSV uses the source's delimiter (default ","), header (default true), '"' as quote and
 * escape, and sample_size = -1, so column types are inferred from every row rather than the first
 * 20,480 (a late "N/A" cannot fail a column typed from the head). JSON reads format "array" or
 * "newline_delimited" as configured, records = true, sample_size = -1. Parquet carries its own
 * schema. CSV and JSON sources are parsed once per executor into temporary tables, so every query
 * of a build reads the same rows; Parquet is read in place.
 *
 * SQL. Every query is compiled from the PlannedQuery alone. Identifiers are double-quoted with
 * quotes doubled; every value (paths, filter values, window dates, the time zone, the bucket grain)
 * is a bound parameter. Only raw "sql" metrics are inlined, as the metric author wrote them.
 *
 * Time. The session time zone is UTC, so results never depend on the machine. A row's local time
 * is its time column in the project time zone: TIMESTAMP WITH TIME ZONE values are converted,
 * TIMESTAMP values without an offset are read as UTC and converted, DATE values are calendar dates
 * as they are. Windows compare the local time with the window's dates (start inclusive, end
 * exclusive); buckets truncate it, with weeks starting on weekStart.
 *
 * Filters. A value compared with a DATE or timestamp column must be strict ISO 8601 (parseTemporal;
 * check reports HM3009 for the metric's time column). A day (YYYY-MM-DD) compares the row's local
 * calendar date, so eq is the whole day and between "2026-01-01" and "2026-01-31" covers all of
 * January 31. A date-time with Z or an offset is that exact instant; without one it is wall-clock
 * time in the project time zone. Either way the value is normalized here and bound as a
 * parameter, and the comparison is between instants, so DuckDB never guesses a cast. neq keeps
 * rows whose column is null (IS DISTINCT FROM) and not_in keeps them too, because "not West"
 * includes rows whose region is unknown; eq, in, gt, gte, lt, lte and between never match null.
 *
 * Numbers. Integer and DECIMAL inputs aggregate exactly in DuckDB (HUGEINT, DECIMAL(38)) and are
 * converted to a JavaScript number once. FLOAT and DOUBLE inputs sum with fsum (Kahan-Babuska
 * compensated summation) ordered by a stable source-row ordinal, fsum(x ORDER BY ordinal), so
 * every run adds the same values in the same order whatever the thread count; avg = that sum /
 * count. Every floating result is then rounded to 15 significant digits, and nothing is truncated
 * to a fixed number of decimals. The ordinal is file order: for CSV and JSON the rowid of the
 * temporary table the file is loaded into (CREATE TABLE AS keeps the reader's row order because
 * preserve_insertion_order is on, and a fresh table numbers rows in insertion order); for Parquet
 * the reader's file_row_number. Accuracy is promised for values within ±1e15: a summed float
 * column whose largest magnitude is above that is reported in QueryResult.imprecise (HM4004).
 * Raw SQL metrics cannot be rewritten, so their queries run on one thread. A sum of no values is 0; a
 * non-finite result (a SQL metric dividing by zero) is null, an undefined value. Dimension values:
 * DECIMAL as numbers, integers as numbers when they are safe integers and as decimal strings
 * otherwise, dates as YYYY-MM-DD, timestamps as local "YYYY-MM-DD HH:MM:SS" text, other types as
 * text.
 *
 * Plans and config. Each query carries its source's file and reader options (PlannedQuery.input),
 * so they are part of its id and of the plan hash. The executor refuses a query whose input
 * differs from config's source of the same name: the plan was made for another hatchmark.json.
 */
export async function createDuckDbExecutor(options: {
  root: string;
  config: ProjectConfig;
  /** DuckDB worker threads; DuckDB's default (the machine's cores) when absent. */
  threads?: number;
}): Promise<DashboardExecutor & { close(): Promise<void> }> {
  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();
  await connection.run("SET TimeZone = 'UTC'");
  await connection.run("SET preserve_insertion_order = true");
  if (options.threads !== undefined) {
    await connection.run(`SET threads = ${Math.max(1, Math.floor(options.threads))}`);
  }
  const sources = new Map<string, Promise<LoadedSource>>();

  const load = (name: string): Promise<LoadedSource> => {
    const existing = sources.get(name);
    if (existing) return existing;
    const source = options.config.sources[name];
    if (source === undefined) return Promise.reject(new Error(`unknown source "${name}"`));
    const file = path.join(options.root, ...normalizePath(source.path).split("/"));
    const loading = loadSource(connection, name, source, file);
    sources.set(name, loading);
    return loading;
  };

  return {
    async execute(query, context) {
      const configured = options.config.sources[query.source];
      if (configured === undefined || canonicalJson(configured) !== canonicalJson(query.input)) {
        throw new Error(
          `source "${query.source}" in this plan differs from hatchmark.json; plan the dashboard again`,
        );
      }
      return execute(connection, await load(query.source), query, context);
    },
    async latestDate(columns: TimeColumn[], timezone: string) {
      let latest: string | undefined;
      for (const { source, column } of columns) {
        const loaded = await load(source);
        const sql = new Sql();
        const local = localTime(loaded, column, timezone, sql);
        const reader = await connection.runAndReadAll(
          `SELECT max(CAST(${local} AS DATE)) FROM ${loaded.relation}`,
          sql.values(loaded),
        );
        const value = reader.getRows()[0]?.[0];
        const date = value instanceof DuckDBDateValue ? value.toString() : undefined;
        if (date !== undefined && (latest === undefined || date > latest)) latest = date;
      }
      return latest;
    },
    async close() {
      connection.closeSync();
      instance.closeSync();
    },
  };
}

/**
 * The column names of a Parquet or JSON file as DuckDB reads it, for ProjectHost.columns. Opens a
 * short-lived in-memory database; undefined when the file cannot be read.
 */
export async function describeColumns(file: string, source: Source): Promise<string[] | undefined> {
  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();
  try {
    const { sql, values } = readerSql(source, file);
    const reader = await connection.runAndReadAll(`DESCRIBE SELECT * FROM ${sql}`, values);
    return reader
      .getRows()
      .map((row) => String(row[0]))
      .filter((name) => !(source.type === "parquet" && name === "file_row_number"));
  } catch {
    return undefined;
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}

interface LoadedSource {
  name: string;
  /** SQL for the rows: a temporary table, or a reader call with parameters. */
  relation: string;
  relationValues: Record<string, DuckDBValue>;
  /** A stable source-row ordinal in file order (see createDuckDbExecutor). */
  ordinal: string;
  columns: { name: string; type: string }[];
  /** Largest magnitude of each floating column, once per executor. */
  magnitudes: Map<string, Promise<number | null>>;
}

function quote(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function readerSql(
  source: Source,
  file: string,
): { sql: string; values: Record<string, DuckDBValue> } {
  switch (source.type) {
    case "csv":
      return {
        sql: "read_csv($hm_file, delim = $hm_delim, header = $hm_header, quote = '\"', escape = '\"', sample_size = -1)",
        values: {
          hm_file: file,
          hm_delim: source.delimiter ?? ",",
          hm_header: source.header ?? true,
        },
      };
    case "json":
      return {
        sql: "read_json($hm_file, format = $hm_format, records = true, sample_size = -1)",
        values: {
          hm_file: file,
          hm_format: source.format === "ndjson" ? "newline_delimited" : "array",
        },
      };
    case "parquet":
      return { sql: "read_parquet($hm_file, file_row_number = true)", values: { hm_file: file } };
  }
}

async function loadSource(
  connection: DuckDBConnection,
  name: string,
  source: Source,
  file: string,
): Promise<LoadedSource> {
  const reader = readerSql(source, file);
  let loaded: Omit<LoadedSource, "columns" | "magnitudes">;
  if (source.type === "parquet") {
    loaded = {
      name,
      relation: reader.sql,
      relationValues: reader.values,
      ordinal: "file_row_number",
    };
  } else {
    const table = quote(`hm_source_${name}`);
    await connection.run(
      `CREATE TEMP TABLE ${table} AS SELECT * FROM ${reader.sql}`,
      reader.values,
    );
    loaded = { name, relation: table, relationValues: {}, ordinal: "rowid" };
  }
  const described = await connection.runAndReadAll(
    `DESCRIBE SELECT * FROM ${loaded.relation}`,
    loaded.relationValues,
  );
  const columns = described
    .getRows()
    .map((row) => ({ name: String(row[0]), type: String(row[1]) }))
    .filter((c) => !(source.type === "parquet" && c.name === "file_row_number"));
  return { ...loaded, columns, magnitudes: new Map() };
}

/** Collects bound parameters; each value gets its own $name, so SQL can be assembled in any order. */
class Sql {
  private readonly bound: Record<string, DuckDBValue> = {};
  private count = 0;

  bind(value: DuckDBValue): string {
    this.count += 1;
    const name = `hm_p${this.count}`;
    this.bound[name] = value;
    return `$${name}`;
  }

  values(source: LoadedSource): Record<string, DuckDBValue> {
    return { ...source.relationValues, ...this.bound };
  }
}

function column(source: LoadedSource, name: string): { name: string; type: string } {
  const found = source.columns.find((c) => sameColumn(c.name, name));
  if (found === undefined) throw new Error(`source "${source.name}" has no column "${name}"`);
  return found;
}

const isTimestamp = (type: string) => type.startsWith("TIMESTAMP");

/** The column's value as local time in the time zone (see createDuckDbExecutor). */
function localTime(source: LoadedSource, name: string, timezone: string, sql: Sql): string {
  const { name: actual, type } = column(source, name);
  const q = quote(actual);
  if (type === "DATE") return q;
  if (type === "TIMESTAMP WITH TIME ZONE") return `timezone(${sql.bind(timezone)}, ${q})`;
  if (isTimestamp(type)) {
    return `timezone(${sql.bind(timezone)}, timezone('UTC', CAST(${q} AS TIMESTAMP)))`;
  }
  throw new Error(
    `time column "${actual}" of source "${source.name}" has type ${type}; it needs DATE or TIMESTAMP`,
  );
}

/** The column's value as an instant (TIMESTAMP WITH TIME ZONE), by the same rules as localTime. */
function instant(source: LoadedSource, name: string, timezone: string, sql: Sql): string {
  const { name: actual, type } = column(source, name);
  const q = quote(actual);
  if (type === "TIMESTAMP WITH TIME ZONE") return q;
  if (type === "DATE") return `timezone(${sql.bind(timezone)}, CAST(${q} AS TIMESTAMP))`;
  return `timezone('UTC', CAST(${q} AS TIMESTAMP))`;
}

/**
 * The two sides of comparing a column with one filter value. On a DATE or timestamp column the
 * value must be strict ISO 8601: a day compares the local date, a date-time compares instants.
 */
function sides(
  source: LoadedSource,
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
  source: LoadedSource,
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

function filterSql(
  source: LoadedSource,
  filter: Filter,
  context: ExecutionContext,
  sql: Sql,
): string {
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

const isFloat = (type: string | undefined) => type === "DOUBLE" || type === "FLOAT";

function aggregateSql(component: MeasureComponent, source: LoadedSource, ordinal: string): string {
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
      return isFloat(found?.type) ? `fsum(${needs()} ORDER BY ${ordinal})` : `sum(${needs()})`;
    case "avg":
      return isFloat(found?.type)
        ? `fsum(${needs()} ORDER BY ${ordinal}) / count(${needs()})`
        : `avg(${needs()})`;
    default:
      return `${component.aggregate}(${needs()})`;
  }
}

const NUMERIC =
  /^(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT|UHUGEINT|FLOAT|DOUBLE)$/;

function dimensionSql(
  source: LoadedSource,
  dimension: PlannedQuery["dimensions"][number],
  context: ExecutionContext,
  sql: Sql,
): string {
  if (dimension.kind === "time") {
    const local = `CAST(${localTime(source, dimension.column, context.timezone, sql)} AS DATE)`;
    if (dimension.grain === "day") return local;
    if (dimension.grain === "week" && context.weekStart === "sunday") {
      return `CAST(date_trunc('week', ${local} + 1) AS DATE) - 1`;
    }
    return `CAST(date_trunc(${sql.bind(dimension.grain)}, ${local}) AS DATE)`;
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

/** Rounds a floating result to 15 significant digits, the digits every summation order agrees on. */
function canonicalFloat(value: number): number | null {
  return Number.isFinite(value) ? Number(value.toPrecision(15)) : null;
}

/** A measure as a number: exact types converted once, floating ones canonicalized; else null. */
function measureValue(value: DuckDBValue, type: string): number | null {
  if (typeof value === "number") {
    return type === "DOUBLE" || type === "FLOAT" ? canonicalFloat(value) : value;
  }
  if (typeof value === "bigint") return Number(value);
  if (value instanceof DuckDBDecimalValue) return value.toDouble();
  return null;
}

function toValue(value: DuckDBValue): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") {
    const n = Number(value);
    return Number.isSafeInteger(n) ? n : value.toString();
  }
  if (value instanceof DuckDBDateValue) return value.toString();
  if (value instanceof DuckDBDecimalValue) return value.toDouble();
  return String(value);
}

function resultType(type: string): QueryResult["columns"][number]["type"] {
  if (type === "VARCHAR") return "string";
  if (type === "BOOLEAN") return "boolean";
  if (type === "DATE") return "date";
  if (isTimestamp(type)) return "timestamp";
  if (type === '"NULL"' || type === "NULL") return "null";
  return "number";
}

async function execute(
  connection: DuckDBConnection,
  source: LoadedSource,
  query: PlannedQuery,
  context: ExecutionContext,
): Promise<QueryResult> {
  if (query.orderBy !== undefined || query.limit !== undefined) {
    throw new Error(
      "orderBy and limit are applied by assembly; the DuckDB executor does not take them",
    );
  }
  const sql = new Sql();
  const where: string[] = [];
  const bounds = queryBounds(query, context);
  if (bounds === undefined) {
    throw new Error(`range "${query.window.range}" has no "${query.window.shift}" window`);
  }
  if (bounds.kind === "bounded" && query.window.column !== undefined) {
    const local = localTime(source, query.window.column, context.timezone, sql);
    where.push(`${local} >= CAST(${sql.bind(bounds.start)} AS DATE)`);
    where.push(`${local} < CAST(${sql.bind(bounds.end)} AS DATE)`);
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
  const ordinal = free("hm_row");
  const measureSql = components.map((c) => {
    const inWhere = shared !== undefined;
    const filters = inWhere ? [] : c.filters.map((f) => filterSql(source, f, context, sql));
    const clause = filters.length > 0 ? ` FILTER (WHERE ${filters.join(" AND ")})` : "";
    const aggregate = `${aggregateSql(c, source, ordinal)}${clause}`;
    return c.aggregate === "sum" ? `coalesce(${aggregate}, 0)` : aggregate;
  });

  const dimRefs = query.dimensions.map((_, i) => free(`hm_d${i}`));
  const dims = query.dimensions.map(
    (d, i) => `, ${dimensionSql(source, d, context, sql)} AS ${dimRefs[i]}`,
  );
  const grouped = dimRefs.length > 0;
  const select = [
    ...dimRefs,
    ...measureSql,
    ...(grouped ? [`GROUPING(${dimRefs.join(", ")})`] : []),
  ];
  const from = `(SELECT *, ${source.ordinal} AS ${ordinal}${dims.join("")} FROM ${source.relation}) AS "hm_rows"`;
  const text = [
    `SELECT ${select.join(", ")}`,
    `FROM ${from}`,
    ...(where.length > 0 ? [`WHERE ${where.join(" AND ")}`] : []),
    ...(grouped
      ? [
          `GROUP BY GROUPING SETS (${query.groupingSets
            .map((set) => `(${set.map((i) => dimRefs[i]).join(", ")})`)
            .join(", ")})`,
          `ORDER BY ${[`${select.length}`, ...dimRefs.map((d) => `${d} ASC NULLS LAST`)].join(", ")}`,
        ]
      : []),
  ].join("\n");

  const serial = components.some((c) => c.aggregate === "sql");
  const threads = serial
    ? (await connection.runAndReadAll("SELECT current_setting('threads')")).getRows()[0]?.[0]
    : undefined;
  if (serial) await connection.run("SET threads = 1");
  const reader = await connection
    .runAndReadAll(text, sql.values(source))
    .finally(() => (serial ? connection.run(`SET threads = ${Number(threads ?? 1)}`) : undefined));
  const types = reader.columnTypes().map(String);
  const imprecise = await impreciseColumns(connection, source, components);
  const dimCount = query.dimensions.length;
  const masks = new Map(
    query.groupingSets.map((set, i) => [
      query.dimensions.reduce(
        (mask, _, d) => (set.includes(d) ? mask : mask | (1 << (dimCount - 1 - d))),
        0,
      ),
      i,
    ]),
  );
  const groupingSet: number[] = [];
  const rows = reader.getRows().map((row) => {
    if (grouped) groupingSet.push(masks.get(Number(row[row.length - 1])) ?? -1);
    return row
      .slice(0, dimCount + components.length)
      .map((value, i) => (i < dimCount ? toValue(value) : measureValue(value, types[i] ?? "")));
  });
  return {
    columns: [
      ...query.dimensions.map((d, i) => ({
        name: d.column,
        type: d.kind === "time" ? ("date" as const) : resultType(types[i] ?? ""),
      })),
      ...components.map((c) => ({ name: c.id, type: "number" as const })),
    ],
    rows,
    ...(query.groupingSets.length > 1 ? { groupingSet } : {}),
    ...(imprecise.length > 0 ? { imprecise } : {}),
  };
}

/** The accuracy limit: floating sums are promised only for values within ±1e15. */
const FLOAT_ACCURACY_LIMIT = 1e15;

/** Summed floating columns of a query whose largest magnitude is above FLOAT_ACCURACY_LIMIT. */
async function impreciseColumns(
  connection: DuckDBConnection,
  source: LoadedSource,
  components: MeasureComponent[],
): Promise<{ column: string; maxAbs: number }[]> {
  const names = new Set<string>();
  for (const c of components) {
    if ((c.aggregate !== "sum" && c.aggregate !== "avg") || c.column === undefined) continue;
    const found = column(source, c.column);
    if (isFloat(found.type)) names.add(found.name);
  }
  const out: { column: string; maxAbs: number }[] = [];
  for (const name of [...names].sort()) {
    let magnitude = source.magnitudes.get(name);
    if (magnitude === undefined) {
      magnitude = connection
        .runAndReadAll(
          `SELECT max(abs(${quote(name)})) FROM ${source.relation}`,
          source.relationValues,
        )
        .then((r) => {
          const value = r.getRows()[0]?.[0];
          return typeof value === "number" ? value : null;
        });
      source.magnitudes.set(name, magnitude);
    }
    const maxAbs = await magnitude;
    if (maxAbs !== null && maxAbs > FLOAT_ACCURACY_LIMIT) out.push({ column: name, maxAbs });
  }
  return out;
}
