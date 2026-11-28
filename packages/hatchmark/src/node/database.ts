import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";
import { canonicalJson, quote } from "../compiler/index.js";
import type { DatabaseSchema, DatabaseSource } from "../spec/index.js";

export const DATABASE_DIR = ".hatchmark/cache/v1/s";

const FORMAT = 1;

const CONNECT_TIMEOUT_MS = 30_000;

export type DatabaseCode =
  | "HM2015"
  | "HM2040"
  | "HM2041"
  | "HM2042"
  | "HM2043"
  | "HM2044"
  | "HM2045"
  | "HM2046";

/** A failure to reach or read a database, with its diagnostic code and a redacted message. */
export class DatabaseError extends Error {
  constructor(
    readonly code: DatabaseCode,
    message: string,
    readonly help?: string,
  ) {
    super(message);
  }
}

/** A Parquet copy of a database source's rows. */
export interface DatabaseCopy extends DatabaseSchema {
  /** Project-relative POSIX path of the copy. */
  file: string;
  stored_at: string;
}

interface Header {
  format: number;
  key: string;
  source: string;
  select: Select;
  stored_at: string;
  columns: { name: string; type: string }[];
  decimals: string[];
}

interface Select {
  type: DatabaseSource["type"];
  table?: string;
  query_sha256?: string;
}

export interface DatabaseStore {
  /** The copy of the source's rows, fetched when no copy is young enough. */
  copy(name: string, source: DatabaseSource): Promise<DatabaseCopy>;
  /**
   * The source's columns without fetching rows: from the database when its variable is set, else
   * from the newest local copy of the same table or query. Throws DatabaseError.
   */
  describe(name: string, source: DatabaseSource): Promise<DatabaseSchema>;
  close(): Promise<void>;
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

const selectOf = (source: DatabaseSource): Select => ({
  type: source.type,
  ...(source.table !== undefined ? { table: source.table } : {}),
  ...(source.query !== undefined ? { query_sha256: sha256(source.query) } : {}),
});

const maxAgeMs = (source: DatabaseSource): number | undefined => {
  const age = source.max_age;
  if (age === undefined) return undefined;
  if ("minutes" in age) return age.minutes * 60_000;
  if ("hours" in age) return age.hours * 3_600_000;
  return age.days * 86_400_000;
};

const PASSWORD_PARAM = /\b((?:password|passwd|pwd)\s*=\s*)('(?:[^'\\]|\\.)*'|\S+)/gi;

function urlPassword(connection: string): string | undefined {
  const scheme = /^[a-z][a-z0-9+.-]*:\/\//i.exec(connection);
  if (scheme === null) return undefined;
  const rest = connection.slice(scheme[0].length).split(/[?#]/)[0] ?? "";
  const at = rest.lastIndexOf("@");
  if (at < 0) return undefined;
  const colon = rest.slice(0, at).indexOf(":");
  return colon < 0 ? undefined : rest.slice(colon + 1, at);
}

function hasPassword(connection: string): boolean {
  if ((urlPassword(connection) ?? "") !== "") return true;
  return [...connection.matchAll(PASSWORD_PARAM)].some((m) => !/^(''|"")?$/.test(m[2] ?? ""));
}

/** The secret parts of a connection string: the whole string and any password in it. */
export function secretsOf(connection: string): string[] {
  const out = new Set<string>([connection]);
  const raw = urlPassword(connection);
  if (raw !== undefined) {
    out.add(raw);
    for (const piece of raw.split(/[@/]/)) if (piece.length >= 4) out.add(piece);
  }
  try {
    const url = new URL(connection);
    if (url.password !== "") {
      out.add(url.password);
      out.add(decodeURIComponent(url.password));
    }
    const param = url.searchParams.get("password");
    if (param) out.add(param);
  } catch {}
  for (const match of connection.matchAll(PASSWORD_PARAM)) {
    const value = match[2] ?? "";
    out.add(value);
    if (value.startsWith("'")) out.add(value.slice(1, -1).replace(/\\(.)/g, "$1"));
  }
  return [...out].filter((s) => s.length > 0).sort((a, b) => b.length - a.length);
}

/** Replaces the connection string and every password in a message with "***". */
export function redact(message: string, connection: string | undefined): string {
  let out = message;
  if (connection !== undefined) {
    for (const secret of secretsOf(connection)) out = out.split(secret).join("***");
  }
  return out.replace(/(\w+:\/\/[^:/@\s]*:)[^\s"']*@/g, "$1***@").replace(PASSWORD_PARAM, "$1***");
}

/** The database a connection string points at, without its password, for the copy's key. */
function identityOf(connection: string): string {
  try {
    const url = new URL(connection);
    url.password = "";
    url.searchParams.delete("password");
    return url.toString();
  } catch {
    return connection.replace(PASSWORD_PARAM, "").trim().split(/\s+/).sort().join(" ");
  }
}

const stringLiteral = (text: string) => `'${text.replaceAll("'", "''")}'`;

const backtick = (name: string) => `\`${name.replaceAll("`", "``")}\``;

const URL_FORM = /^[a-z][a-z0-9+.-]*:\/\//i;

const NO_PASSFILE = path.join(tmpdir(), `hatchmark-${randomUUID()}.pgpass`).replaceAll("\\", "/");

/**
 * libpq falls back to PGPASSWORD, a service file and ~/.pgpass, and DuckDB's mysql extension to
 * MYSQL_PWD, when the connection string has no password; an explicit empty password and a passfile
 * that does not exist turn those fallbacks off.
 */
function namedOnly(type: DatabaseSource["type"], connection: string): string {
  const missing = !hasPassword(connection);
  if (type === "mysql") return missing ? `${connection} password=''` : connection;
  if (URL_FORM.test(connection)) {
    const params = `${missing ? "password=&" : ""}passfile=${encodeURIComponent(NO_PASSFILE)}`;
    return `${connection}${connection.includes("?") ? "&" : "?"}${params}`;
  }
  return `${connection}${missing ? " password=''" : ""} passfile='${NO_PASSFILE}'`;
}

interface Relation {
  sql: string;
  schema?: string;
  table?: string;
}

const missingTable = (name: string, table: string) =>
  new DatabaseError(
    "HM2042",
    `table "${table}" of database source "${name}" is not in the database`,
    "check the table name and its schema, and that the database user may read it",
  );

async function relationOf(
  connection: DuckDBConnection,
  name: string,
  source: DatabaseSource,
): Promise<Relation> {
  if (source.query !== undefined) {
    const fn = source.type === "postgres" ? "postgres_query" : "mysql_query";
    // DuckDB's postgres extension trims the query and wraps it in COPY (...), so a trailing line
    // comment would swallow the closing parenthesis.
    return { sql: `${fn}('hm_db', ${stringLiteral(`${source.query}\n/**/`)})` };
  }
  const parts = (source.table ?? "").split(".");
  const table = parts.at(-1) ?? "";
  let schema = parts.length > 1 ? parts[0] : undefined;
  if (schema === undefined && source.type === "postgres") {
    const inner = `SELECT n.nspname::text FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE c.oid = to_regclass(quote_ident(${stringLiteral(table)}))`;
    const found = (
      await connection.runAndReadAll(
        `SELECT * FROM postgres_query('hm_db', ${stringLiteral(inner)})`,
      )
    ).getRows()[0]?.[0];
    if (typeof found !== "string") throw missingTable(name, source.table ?? table);
    schema = found;
  }
  return {
    sql: ["hm_db", ...(schema !== undefined ? [schema] : []), table]
      .map((p, i) => (i === 0 ? p : quote(p)))
      .join("."),
    ...(schema !== undefined ? { schema } : {}),
    table,
  };
}

function catalogQuery(source: DatabaseSource, relation: Relation): string | undefined {
  if (relation.table === undefined) return undefined;
  const table = stringLiteral(relation.table);
  const schema = relation.schema !== undefined ? stringLiteral(relation.schema) : undefined;
  if (source.type === "postgres") {
    const inner = `SELECT column_name::text, data_type::text, numeric_precision::int FROM information_schema.columns WHERE table_name = ${table} AND table_schema = ${schema ?? "current_schema()"}`;
    return `SELECT * FROM postgres_query('hm_db', ${stringLiteral(inner)})`;
  }
  const inner = `SELECT CAST(column_name AS CHAR), CAST(data_type AS CHAR), CAST(numeric_precision AS SIGNED) FROM information_schema.columns WHERE table_name = ${table} AND table_schema = ${schema ?? "DATABASE()"}`;
  return `SELECT * FROM mysql_query('hm_db', ${stringLiteral(inner)})`;
}

const TEXT_TYPES = /^(UUID|JSON|TIME|TIME WITH TIME ZONE|TIMETZ|BIT|ENUM\(.*\))$/;

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Opens one DuckDB session on the source's database. Connection problems become HM2040, HM2041
 * and HM2044, a missing table HM2042, anything else HM2015; every message is redacted.
 */
async function withDatabase<T>(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  source: DatabaseSource,
  use: (connection: DuckDBConnection) => Promise<T>,
): Promise<T> {
  const secret = env[source.env];
  if (secret === undefined || secret === "") {
    throw new DatabaseError(
      "HM2040",
      `the environment variable ${source.env} for database source "${name}" is not set`,
      `set ${source.env} to the connection string, such as ${source.type === "postgres" ? "postgresql://user:password@host:5432/db" : "host=db.example.com user=reader password=... database=shop"}`,
    );
  }
  if (/[@/]/.test(urlPassword(secret) ?? "")) {
    throw new DatabaseError(
      "HM2041",
      `the connection string in ${source.env} for database source "${name}" has an unencoded "@" or "/" in its password`,
      "percent-encode them in the password: @ as %40 and / as %2F",
    );
  }
  const fail = (code: DatabaseCode, text: string, help?: string): never => {
    throw new DatabaseError(code, redact(text, secret).trim(), help);
  };
  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();
  try {
    await connection.run("SET TimeZone = 'UTC'");
    try {
      await connection.run(`INSTALL ${source.type}`);
      await connection.run(`LOAD ${source.type}`);
    } catch (error) {
      fail(
        "HM2044",
        `cannot load DuckDB's ${source.type} extension for source "${name}": ${message(error)}`,
        `DuckDB downloads the ${source.type} extension once from extensions.duckdb.org; let this machine reach it`,
      );
    }
    if (source.type === "mysql") await connection.run("SET mysql_session_time_zone = '+00:00'");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        connection.interrupt();
        reject(new Error(`no answer within ${CONNECT_TIMEOUT_MS / 1000} s`));
      }, CONNECT_TIMEOUT_MS);
    });
    try {
      await Promise.race([
        connection.run(
          `ATTACH ${stringLiteral(namedOnly(source.type, secret))} AS hm_db (TYPE ${source.type}, READ_ONLY)`,
        ),
        timeout,
      ]);
    } catch (error) {
      fail(
        "HM2041",
        `cannot connect to the ${source.type} database of source "${name}" (${source.env}): ${message(error)}`,
        "check the host, port, user and password in the connection string, and that this machine can reach the database",
      );
    } finally {
      clearTimeout(timer);
    }
    try {
      return await use(connection);
    } catch (error) {
      if (error instanceof DatabaseError)
        throw new DatabaseError(error.code, redact(error.message, secret), error.help);
      const text = message(error);
      if (source.table !== undefined && /^Catalog Error: Table with name/.test(text)) {
        throw missingTable(name, source.table);
      }
      return fail("HM2015", `database source "${name}": ${text}`);
    }
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}

interface Described {
  columns: { name: string; type: string }[];
  decimals: string[];
  texts: string[];
  relation: Relation;
  select: string;
}

async function describeRemote(
  connection: DuckDBConnection,
  sourceName: string,
  source: DatabaseSource,
): Promise<Described> {
  const relation = await relationOf(connection, sourceName, source);
  const read = (await connection.runAndReadAll(`DESCRIBE SELECT * FROM ${relation.sql}`))
    .getRows()
    .map((row) => ({ name: String(row[0]), type: String(row[1]) }));
  const remote = new Map<string, string>();
  const catalog = catalogQuery(source, relation);
  if (catalog !== undefined) {
    for (const row of (await connection.runAndReadAll(catalog)).getRows()) {
      remote.set(String(row[0]), String(row[1]).toLowerCase());
    }
  }
  const decimals: string[] = [];
  const texts: string[] = [];
  const columns: { name: string; type: string }[] = [];
  const select: string[] = [];
  for (const { name, type } of read) {
    const declared = remote.get(name);
    const column = quote(name);
    const at = `column "${name}" of database source "${sourceName}"`;
    if ((declared === "numeric" || declared === "decimal") && type === "DOUBLE")
      decimals.push(name);
    const decimal = /^DECIMAL\((\d+),(\d+)\)$/.exec(type);
    const width = Number(decimal?.[1]);
    const scale = Number(decimal?.[2]);
    if (decimal !== null && scale > 38) {
      throw new DatabaseError(
        "HM2043",
        `${at} is a numeric with a negative scale, which DuckDB's postgres extension misreads`,
        `cast it in the source's query, such as SELECT ${name}::numeric(38,0) AS ${name}`,
      );
    }
    if (TEXT_TYPES.test(type)) {
      columns.push({ name, type: "VARCHAR" });
      select.push(`CAST(${column} AS VARCHAR) AS ${column}`);
    } else if (decimal !== null && scale > width) {
      columns.push({ name, type: `DECIMAL(${scale},${scale})` });
      select.push(`CAST(${column} AS DECIMAL(${scale},${scale})) AS ${column}`);
    } else if (source.type === "mysql" && declared === "timestamp" && type === "TIMESTAMP") {
      columns.push({ name, type: "TIMESTAMP WITH TIME ZONE" });
      select.push(`timezone('UTC', ${column}) AS ${column}`);
    } else if (
      source.type === "mysql" &&
      source.query !== undefined &&
      type === "TIMESTAMP" &&
      (source.timezone ?? "UTC") !== "UTC"
    ) {
      throw new DatabaseError(
        "HM2045",
        `${at} is a MySQL DATETIME or TIMESTAMP, and a query does not say which, so Hatchmark cannot tell a ${source.timezone} wall-clock time from an instant`,
        `read it with table:, which knows the column type, or convert it to UTC in the query, such as CONVERT_TZ(${name}, '${source.timezone}', '+00:00') for a DATETIME, and remove timezone from the source`,
      );
    } else {
      if (source.type === "mysql" && type === "VARCHAR") texts.push(name);
      columns.push({ name, type });
      select.push(column);
    }
  }
  return {
    columns,
    decimals,
    texts,
    relation,
    select: `SELECT ${select.length > 0 ? select.join(", ") : "*"} FROM ${relation.sql}`,
  };
}

async function checkCollation(
  connection: DuckDBConnection,
  name: string,
  source: DatabaseSource,
  described: Described,
): Promise<void> {
  if (described.texts.length === 0) return;
  const { schema, table } = described.relation;
  const from =
    source.query ??
    `SELECT * FROM ${[schema, table]
      .filter((p) => p !== undefined)
      .map(backtick)
      .join(".")}`;
  const counts = described.texts.map((c) => {
    const column = backtick(c);
    return `COUNT(DISTINCT ${column}), COUNT(DISTINCT CAST(${column} AS BINARY)), MAX(COLLATION(${column}))`;
  });
  const inner = `SELECT ${counts.join(", ")} FROM (\n${from}\n) AS hm_q`;
  const row =
    (
      await connection.runAndReadAll(`SELECT * FROM mysql_query('hm_db', ${stringLiteral(inner)})`)
    ).getRows()[0] ?? [];
  const colliding = described.texts.flatMap((c, i) => {
    const equal = Number(row[i * 3]);
    const distinct = Number(row[i * 3 + 1]);
    return equal === distinct
      ? []
      : [`"${c}" (${row[i * 3 + 2]}: ${equal} distinct values in MySQL, ${distinct} by bytes)`];
  });
  if (colliding.length === 0) return;
  throw new DatabaseError(
    "HM2046",
    `database source "${name}" has text that MySQL's collation treats as equal but whose bytes differ, in case, accents or trailing spaces, so grouping, distinct counts and filters would not match MySQL: ${colliding.join(", ")}`,
    "normalize the column in the source's query, such as SELECT LOWER(region) AS region, or make it case- and accent-sensitive, such as SELECT region COLLATE utf8mb4_0900_as_cs AS region",
  );
}

async function readHeader(file: string): Promise<Header | undefined> {
  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();
  try {
    const text = (
      await connection.runAndReadAll(
        "SELECT decode(value) FROM parquet_kv_metadata($file) WHERE decode(key) = 'hatchmark'",
        { file },
      )
    ).getRows()[0]?.[0];
    if (typeof text !== "string") return undefined;
    const header = JSON.parse(Buffer.from(text, "base64").toString("utf8")) as Header;
    return header.format === FORMAT ? header : undefined;
  } catch {
    return undefined;
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}

/** A store of database copies for one project directory. env holds the connection strings. */
export function createDatabaseStore(options: {
  root: string;
  env: Readonly<Record<string, string | undefined>>;
  /** Fetch into .hatchmark/tmp and remove the copies on close, leaving the cache as it was. */
  readOnly?: boolean;
  now?: () => Date;
}): DatabaseStore {
  const { root, env } = options;
  const now = options.now ?? (() => new Date());
  const fetched = new Map<string, Promise<DatabaseCopy>>();
  const temporary = `.hatchmark/tmp/db-${randomUUID()}`;
  let wroteTemporary = false;
  const dir = path.join(root, ...DATABASE_DIR.split("/"));
  const absolute = (relative: string) => path.join(root, ...relative.split("/"));

  const copiesOf = async (name: string) =>
    (await readdir(dir).catch(() => [] as string[])).filter(
      (n) => n.startsWith(`${name}.`) && n.endsWith(".parquet"),
    );

  const toCopy = (file: string, header: Header, origin: DatabaseCopy["origin"]): DatabaseCopy => ({
    file,
    stored_at: header.stored_at,
    columns: header.columns,
    decimals: header.decimals,
    origin,
  });

  const keyOf = (source: DatabaseSource) => {
    const secret = env[source.env];
    return sha256(
      canonicalJson({
        format: FORMAT,
        select: selectOf(source),
        database: secret === undefined ? null : identityOf(secret),
      }),
    );
  };

  const fetch = (name: string, source: DatabaseSource, key: string): Promise<DatabaseCopy> =>
    withDatabase(env, name, source, async (connection) => {
      const described = await describeRemote(connection, name, source);
      if (source.type === "mysql") await checkCollation(connection, name, source, described);
      const header: Header = {
        format: FORMAT,
        key,
        source: name,
        select: selectOf(source),
        stored_at: now().toISOString(),
        columns: described.columns,
        decimals: described.decimals,
      };
      const relative = options.readOnly
        ? `${temporary}/${name}.parquet`
        : `${DATABASE_DIR}/${name}.${key.slice(0, 32)}.parquet`;
      const final = absolute(relative);
      await mkdir(path.dirname(final), { recursive: true });
      if (options.readOnly) wroteTemporary = true;
      const fresh = `${final}.${randomUUID()}.tmp`;
      const encoded = Buffer.from(JSON.stringify(header), "utf8").toString("base64");
      try {
        await connection.run(
          `COPY (${described.select}) TO ${stringLiteral(fresh)} (FORMAT parquet, KV_METADATA {hatchmark: '${encoded}'})`,
        );
        await rename(fresh, final);
      } catch (error) {
        await rm(fresh, { force: true });
        throw error;
      }
      if (!options.readOnly) {
        for (const other of await copiesOf(name)) {
          const file = path.join(dir, other);
          if (file !== final) await rm(file, { force: true });
        }
      }
      return toCopy(relative, header, "database");
    });

  const reusable = async (
    name: string,
    source: DatabaseSource,
    key: string,
  ): Promise<DatabaseCopy | undefined> => {
    const limit = maxAgeMs(source);
    if (limit === undefined) return undefined;
    const relative = `${DATABASE_DIR}/${name}.${key.slice(0, 32)}.parquet`;
    const info = await stat(absolute(relative)).catch(() => undefined);
    if (!info?.isFile()) return undefined;
    const header = await readHeader(absolute(relative));
    if (header?.key !== key) return undefined;
    const age = now().getTime() - Date.parse(header.stored_at);
    return age >= 0 && age < limit ? toCopy(relative, header, "cached") : undefined;
  };

  return {
    copy(name, source) {
      const key = keyOf(source);
      const memo = `${name}\n${key}`;
      const limit = maxAgeMs(source);
      const existing = fetched.get(memo);
      const loading = (async () => {
        const previous = await existing?.catch(() => undefined);
        if (previous !== undefined) {
          const age = now().getTime() - Date.parse(previous.stored_at);
          if (limit === undefined || age < limit) return previous;
        }
        return (await reusable(name, source, key)) ?? fetch(name, source, key);
      })();
      fetched.set(memo, loading);
      return loading;
    },
    async describe(name, source) {
      const key = keyOf(source);
      const young = await reusable(name, source, key);
      if (young !== undefined) {
        fetched.set(`${name}\n${key}`, Promise.resolve(young));
        return young;
      }
      const secret = env[source.env];
      if (secret === undefined || secret === "") {
        const select = canonicalJson(selectOf(source));
        let newest: DatabaseCopy | undefined;
        for (const file of await copiesOf(name)) {
          const header = await readHeader(path.join(dir, file));
          if (header === undefined || canonicalJson(header.select) !== select) continue;
          if (newest === undefined || header.stored_at > newest.stored_at) {
            newest = toCopy(`${DATABASE_DIR}/${file}`, header, "copy");
          }
        }
        if (newest !== undefined) return newest;
      }
      return withDatabase(env, name, source, async (connection) => {
        const { columns, decimals } = await describeRemote(connection, name, source);
        return { columns, decimals, origin: "database" as const };
      });
    },
    async close() {
      if (wroteTemporary) await rm(absolute(temporary), { recursive: true, force: true });
    },
  };
}
