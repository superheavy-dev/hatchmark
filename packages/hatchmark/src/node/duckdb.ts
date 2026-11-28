import path from "node:path";
import {
  BIGINT,
  BOOLEAN,
  DOUBLE,
  type DuckDBConnection,
  DuckDBDateValue,
  DuckDBDecimalValue,
  DuckDBInstance,
  type DuckDBType,
  type DuckDBValue,
  HUGEINT,
  INTEGER,
  VARCHAR,
} from "@duckdb/node-api";
import {
  type BuiltQuery,
  type BuiltSql,
  batchQuerySql,
  canonicalJson,
  column,
  type ExecutionContext,
  horizonSql,
  isFloat,
  isTimestamp,
  type MeasureComponent,
  ORDINAL,
  type PlannedQuery,
  type QueryResult,
  querySql,
  quote,
  readsRawSql,
  type SqlExecutor,
  type SqlSource,
  type SqlValue,
  sqlType,
  type TimeColumn,
} from "../compiler/index.js";
import {
  type FileSource,
  isDatabaseSource,
  normalizePath,
  type ProjectConfig,
  type TableSource,
} from "../spec/index.js";
import { createDatabaseStore, type DatabaseStore } from "./database.js";

/**
 * The DuckDB executor (build mode): runs planned queries over the project's CSV, Parquet and JSON
 * files with DuckDB, in process.
 *
 * Reading files. Every reader option that DuckDB would otherwise sniff is set from the source
 * config: CSV uses the source's delimiter (default ","), header (default true), '"' as quote and
 * escape, and sample_size = -1, so column types are inferred from every row rather than the first
 * 20,480 (a late "N/A" cannot fail a column typed from the head). JSON reads format "array" or
 * "newline_delimited" as configured, records = true, sample_size = -1. Parquet carries its own
 * schema. Every source, Parquet included, is loaded once per executor into a temporary table (see
 * loadSource), so every query of a build reads the same rows in the same order.
 *
 * SQL. Every query is compiled from the PlannedQuery alone, by querySql in the portable core. Identifiers are double-quoted with
 * quotes doubled; every value (paths, filter values, window dates, the time zone, the bucket grain)
 * is a bound parameter. Only raw "sql" metrics are inlined, as the metric author wrote them.
 *
 * Time. The session time zone is UTC, so results never depend on the machine. A row's local time
 * is its time column in the project time zone: TIMESTAMP WITH TIME ZONE values are converted,
 * TIMESTAMP values without an offset are read as UTC and converted, DATE values are calendar dates
 * as they are. Windows compare the local time with the window's dates (start inclusive, end
 * exclusive); buckets truncate it, at the grain's anchor.
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
 * compensated summation) ordered by the source table's own row ordinal, __hm_ord (file paths in
 * UTF-8 byte order, then the row's place in its file; see loadSource), so every run adds the same
 * values in the same order whatever the thread count; avg = that sum / count. The ordinal never
 * comes from a source column: names starting with __hm_ are reserved (HM2017). Every floating
 * result is then rounded to 15 significant digits, and nothing is truncated to a fixed number of
 * decimals. Accuracy is promised for values within ±1e15: a summed float column whose largest
 * finite magnitude is above that is reported in QueryResult.imprecise, and a displayed float sum
 * or average that reaches ±1e13, where 15 significant digits no longer hold cents, in
 * QueryResult.large, computed in SQL over every result row (both HM4004; NaN and ±Infinity are
 * left out). Raw SQL metrics cannot be rewritten, so their queries run on one thread. A sum of no values is 0; a
 * non-finite result (a SQL metric dividing by zero) is null, an undefined value. Dimension values:
 * DECIMAL as numbers, integers as numbers when they are safe integers and as decimal strings
 * otherwise, dates as YYYY-MM-DD, timestamps as local "YYYY-MM-DD HH:MM:SS" text, other types as
 * text.
 *
 * Plans and config. Each query carries its source's file and reader options (PlannedQuery.input),
 * so they are part of its id and of the plan hash. The executor refuses a query whose input
 * differs from config's source of the same name: the plan was made for another hatchmark.yaml.
 */
export async function createDuckDbExecutor(options: {
  root: string;
  config: ProjectConfig;
  /** DuckDB worker threads; DuckDB's default (the machine's cores) when absent. */
  threads?: number;
  /**
   * Where database sources' rows come from, shared with a build cache; a store of its own over
   * process.env when absent.
   */
  databases?: DatabaseStore;
}): Promise<SqlExecutor & { close(): Promise<void> }> {
  const ownStore =
    options.databases === undefined &&
    Object.values(options.config.sources).some((s) => isDatabaseSource(s))
      ? createDatabaseStore({ root: options.root, env: process.env })
      : undefined;
  const databases = options.databases ?? ownStore;
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
    if (source.type === "lookup") {
      return Promise.reject(new Error(`lookup source "${name}" is not evaluated yet`));
    }
    const loading = isDatabaseSource(source)
      ? (databases as DatabaseStore).copy(name, source).then((copy) =>
          loadSource(
            connection,
            name,
            {
              type: "parquet",
              path: copy.file,
              ...(source.timezone ? { timezone: source.timezone } : {}),
            },
            path.join(options.root, ...copy.file.split("/")),
          ),
        )
      : loadSource(
          connection,
          name,
          source,
          path.join(options.root, ...normalizePath(source.path).split("/")),
        );
    sources.set(name, loading);
    return loading;
  };

  const current = (name: string, input: TableSource): Promise<LoadedSource> => {
    const configured = options.config.sources[name];
    if (configured === undefined || canonicalJson(configured) !== canonicalJson(input)) {
      return Promise.reject(
        new Error(
          `source "${name}" in this plan differs from hatchmark.yaml; plan the dashboard again`,
        ),
      );
    }
    return load(name);
  };

  const planned = async (query: PlannedQuery): Promise<LoadedSource> => {
    const source = await current(query.source, query.input);
    if (query.tables === undefined) return source;
    const tables: Record<string, SqlSource> = {};
    for (const [name, input] of Object.entries(query.tables)) {
      tables[name] = await current(name, input);
    }
    return { ...source, tables };
  };

  return {
    async execute(query, context) {
      return execute(connection, await planned(query), query, context);
    },
    async executeMany(query, contexts) {
      if (contexts.length === 0) return [];
      return executeMany(connection, await planned(query), query, contexts);
    },
    async sql(query, context): Promise<BuiltSql> {
      const { text, params } = querySql(await planned(query), query, context);
      return { text, params };
    },
    async horizon({ source, column }: TimeColumn) {
      const { text, params, date, naive } = horizonSql(await load(source), column);
      const { values, types } = boundParams(params);
      const value = (await connection.runAndReadAll(text, values, types)).getRows()[0]?.[0];
      return { ...(typeof value === "string" ? { latest: value } : {}), date, naive };
    },
    async close() {
      connection.closeSync();
      instance.closeSync();
      await ownStore?.close();
    },
  };
}

export async function describeColumnTypes(
  file: string,
  source: FileSource,
): Promise<{ name: string; type: string }[] | undefined> {
  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();
  try {
    const { sql, values } = readerSql(source, [file], false);
    const reader = await connection.runAndReadAll(`DESCRIBE SELECT * FROM ${sql}`, values);
    return reader.getRows().map((row) => ({ name: String(row[0]), type: String(row[1]) }));
  } catch {
    return undefined;
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}

/**
 * The column names of a Parquet or JSON file as DuckDB reads it, for ProjectHost.columns. Opens a
 * short-lived in-memory database; undefined when the file cannot be read.
 */
export async function describeColumns(
  file: string,
  source: FileSource,
): Promise<string[] | undefined> {
  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();
  try {
    const { sql, values } = readerSql(source, [file], false);
    const reader = await connection.runAndReadAll(`DESCRIBE SELECT * FROM ${sql}`, values);
    return reader.getRows().map((row) => String(row[0]));
  } catch {
    return undefined;
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}

const TYPES = { VARCHAR, BOOLEAN, INTEGER, BIGINT, HUGEINT, DOUBLE };

// DuckDB binds HUGEINT parameters only from bigint.
export function boundParams(params: Record<string, SqlValue>): {
  values: Record<string, DuckDBValue>;
  types: Record<string, DuckDBType>;
} {
  const values: Record<string, DuckDBValue> = {};
  const types: Record<string, DuckDBType> = {};
  for (const [name, value] of Object.entries(params)) {
    const type = sqlType(value);
    values[name] = type === "BIGINT" || type === "HUGEINT" ? BigInt(value as number) : value;
    types[name] = TYPES[type];
  }
  return { values, types };
}

interface LoadedSource extends SqlSource {
  magnitudes: Map<string, Promise<number | null>>;
}

function readerSql(
  source: FileSource,
  files: string[],
  withFile: boolean,
): { sql: string; values: Record<string, DuckDBValue> } {
  const list = `[${files.map((_, i) => `$hm_f${i}`).join(", ")}]`;
  const values: Record<string, DuckDBValue> = Object.fromEntries(
    files.map((file, i) => [`hm_f${i}`, file]),
  );
  const file = withFile ? ", filename = '__hm_file'" : "";
  switch (source.type) {
    case "csv":
      return {
        sql: `read_csv(${list}, delim = $hm_delim, header = $hm_header, quote = '"', escape = '"', sample_size = -1${file})`,
        values: { ...values, hm_delim: source.delimiter ?? ",", hm_header: source.header ?? true },
      };
    case "json":
      return {
        sql: `read_json(${list}, format = $hm_format, records = true, sample_size = -1${file})`,
        values: {
          ...values,
          hm_format: source.format === "ndjson" ? "newline_delimited" : "array",
        },
      };
    case "parquet":
      return { sql: `read_parquet(${list}${file})`, values };
  }
}

const utf8Order = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));

// DuckDB's CREATE TABLE AS keeps each file's rows in order only with preserve_insertion_order,
// and a source column named rowid hides the table's rowid, so it is renamed for the load.
async function loadSource(
  connection: DuckDBConnection,
  name: string,
  source: FileSource,
  file: string,
): Promise<LoadedSource> {
  const listed = await connection.runAndReadAll("SELECT file FROM glob($hm_path)", {
    hm_path: file,
  });
  const files = listed
    .getRows()
    .map((row) => String(row[0]))
    .sort(utf8Order);
  const reader = readerSql(source, files.length > 0 ? files : [file], true);
  const described = await connection.runAndReadAll(
    `DESCRIBE SELECT * FROM ${reader.sql}`,
    reader.values,
  );
  const names = described.getRows().map((row) => String(row[0]));
  const reserved = names.find((n) => n !== "__hm_file" && n.toLowerCase().startsWith("__hm_"));
  if (reserved !== undefined) {
    throw new Error(
      `source "${name}" has a column "${reserved}"; names starting with __hm_ are reserved (HM2017)`,
    );
  }
  const rowid = names.find((n) => n.toLowerCase() === "rowid");
  const load = quote(`__hm_load_${name}`);
  const table = quote(`__hm_source_${name}`);
  await connection.run(
    `CREATE TEMP TABLE ${load} AS SELECT * ${rowid ? `RENAME (${quote(rowid)} AS "__hm_rowid") ` : ""}FROM ${reader.sql}`,
    reader.values,
  );
  const position = `list_position([${files.map((_, i) => `$hm_f${i}`).join(", ")}], "__hm_file")`;
  await connection.run(
    `CREATE TEMP TABLE ${table} AS SELECT * EXCLUDE ("__hm_file")${rowid ? ` RENAME ("__hm_rowid" AS ${quote(rowid)})` : ""}, row_number() OVER (ORDER BY ${files.length > 1 ? `${position}, ` : ""}rowid) AS ${ORDINAL} FROM ${load}`,
    files.length > 1 ? Object.fromEntries(files.map((f, i) => [`hm_f${i}`, f])) : {},
  );
  await connection.run(`DROP TABLE ${load}`);
  const columns = (await connection.runAndReadAll(`DESCRIBE SELECT * FROM ${table}`))
    .getRows()
    .map((row) => ({ name: String(row[0]), type: String(row[1]) }))
    .filter((c) => c.name !== "__hm_ord");
  return {
    name,
    relation: table,
    columns,
    ...(source.timezone !== undefined ? { timezone: source.timezone } : {}),
    magnitudes: new Map(),
  };
}

// DuckDB sums floats in a thread-dependent order; 15 significant digits are the ones every order
// agrees on.
function canonicalFloat(value: number): number | null {
  return Number.isFinite(value) ? Number(value.toPrecision(15)) : null;
}

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
  const built = querySql(source, query, context);
  const reader = await run(connection, built);
  return resultOf(
    query,
    built,
    reader.columnTypes().map(String),
    reader.getRows(),
    await impreciseColumns(connection, source, built.components),
  );
}

async function executeMany(
  connection: DuckDBConnection,
  source: LoadedSource,
  query: PlannedQuery,
  contexts: ExecutionContext[],
): Promise<QueryResult[]> {
  if (contexts.length < 2 || readsRawSql(query)) {
    const out: QueryResult[] = [];
    for (const context of contexts) out.push(await execute(connection, source, query, context));
    return out;
  }
  const built = batchQuerySql(source, query, contexts);
  const reader = await run(connection, built);
  const types = reader.columnTypes().map(String).slice(1);
  const byTag = contexts.map((): DuckDBValue[][] => []);
  for (const row of reader.getRows()) byTag[Number(row[0])]?.push(row.slice(1));
  const imprecise = await impreciseColumns(connection, source, built.components);
  return byTag.map((rows) => resultOf(query, built, types, rows, imprecise));
}

async function run(connection: DuckDBConnection, built: BuiltQuery) {
  const threads = built.serial
    ? (await connection.runAndReadAll("SELECT current_setting('threads')")).getRows()[0]?.[0]
    : undefined;
  if (built.serial) await connection.run("SET threads = 1");
  const bound = boundParams(built.params);
  return connection
    .runAndReadAll(built.text, bound.values, bound.types)
    .finally(() =>
      built.serial ? connection.run(`SET threads = ${Number(threads ?? 1)}`) : undefined,
    );
}

function resultOf(
  query: PlannedQuery,
  built: BuiltQuery,
  types: string[],
  all: DuckDBValue[][],
  imprecise: { column: string; maxAbs: number }[],
): QueryResult {
  const { components, groupingAt, large: shownMetrics } = built;
  const grouped = query.dimensions.length > 0;
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
  const rows = all.map((row) => {
    if (grouped) groupingSet.push(masks.get(Number(row[groupingAt])) ?? -1);
    return row
      .slice(0, dimCount + components.length)
      .map((value, i) => (i < dimCount ? toValue(value) : measureValue(value, types[i] ?? "")));
  });
  const windows = groupingAt + (grouped ? 1 : 0);
  const large = shownMetrics.flatMap((metric, i) => {
    const value = all[0]?.[windows + i];
    const maxAbs = typeof value === "number" ? canonicalFloat(value) : null;
    return maxAbs !== null && maxAbs >= FLOAT_CENTS_LIMIT ? [{ metric, maxAbs }] : [];
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
    ...(large.length > 0 ? { large } : {}),
  };
}

const FLOAT_ACCURACY_LIMIT = 1e15;

const FLOAT_CENTS_LIMIT = 1e13;

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
          `SELECT max(abs(${quote(name)})) FILTER (WHERE isfinite(${quote(name)})) FROM ${source.relation}`,
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
