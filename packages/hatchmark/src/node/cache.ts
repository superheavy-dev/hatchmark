import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readdir, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DuckDBInstance } from "@duckdb/node-api";
import {
  canonicalJson,
  type DashboardExecutor,
  type ExecutionContext,
  type PlannedQuery,
  type QueryResult,
  type SqlExecutor,
  type TimeColumn,
} from "../compiler/index.js";
import { normalizePath, type ProjectConfig } from "../spec/index.js";
import { VERSION } from "../version.js";

/**
 * The build cache: query results and source horizons stored as Parquet under .hatchmark/cache/, so
 * a build recomputes only what changed.
 *
 * Keys. An entry's key is the SHA-256 of the canonical JSON of everything that decides its value:
 * the cache format, the engine (the hatchmark version, the DuckDB library, and the bytes of every
 * module under compiler/, node/ and spec/, so a change to SQL generation or the executor
 * invalidates even in a source checkout), the whole PlannedQuery (its id is its slice of the plan
 * hash; its input carries the source's reader options), the ExecutionContext (as-of date, time
 * zone, anchors, bindings, measured horizons), and the data fingerprint: the size and SHA-256 of
 * every file the executor can read for the query. That is the query's own source when it is a
 * file source, and every file source of the project otherwise. File contents are hashed, never
 * trusted by size or modification time, so any changed byte invalidates.
 *
 * Writes. A miss runs the inner executor and keeps the result in memory. close() hashes every
 * file those results read again and writes only the entries whose files still have the
 * fingerprint they were keyed with, so a file that changed during the build is never stored under
 * its old fingerprint. Each entry is written to a fresh temporary name and renamed into place.
 * With sweep (hatchmark build, which runs every dashboard), close() then removes every entry the
 * build neither read nor wrote, so the cache holds exactly the last build's results.
 *
 * Reads. An entry is used only when its stored key equals the expected one and every row decodes;
 * anything else (truncated, corrupted, renamed, from another version) is a miss and is rewritten.
 * Values round-trip exactly: numbers as DOUBLE, strings as VARCHAR, booleans as BOOLEAN, and a
 * column of mixed or unusual values as JSON text. A cached build is byte-identical to an uncached
 * one (test/node/cache.test.ts).
 *
 * The cache is skipped (every query runs) when its directory or any directory above it inside the
 * project is a symbolic link, or a data file cannot be read.
 */

/** Bumped whenever the entry layout or the key changes. */
const CACHE_FORMAT = 1;

export const CACHE_DIR = ".hatchmark/cache";

/** The files a key covers, as stored in an entry and shown by explain. */
export interface DataFile {
  source: string;
  /** Project-relative POSIX path. */
  file: string;
  bytes: number;
  sha256: string;
}

/** What explain shows for one query. */
export interface CacheProbe {
  status: "hit" | "miss" | "stale" | "off";
  /** When the entry used (hit) or the older entry (stale) was written, ISO 8601 UTC. */
  stored_at?: string;
  /** For stale: what differs from the older entry. */
  changed?: ("data" | "engine" | "context" | "query")[];
  /** For stale with changed data: the files whose contents differ. */
  changed_files?: string[];
  /** The data files the key covers, with their current fingerprints. */
  data?: DataFile[];
  /** Why the cache is off, for status "off". */
  reason?: string;
}

export interface CacheStats {
  enabled: boolean;
  dir: string;
  hits: number;
  misses: number;
  written: number;
  reason?: string;
}

export type CachedExecutor = SqlExecutor & {
  close(): Promise<void>;
  stats(): CacheStats;
  /** The cache status of a query whose SQL explain printed, in the context it printed it. */
  probe(queryId: string): Promise<CacheProbe | undefined>;
};

interface Header {
  format: number;
  key: string;
  parts: KeyParts;
  stored_at: string;
  /** The result without rows and groupingSet (columns, imprecise, large, ...), or a horizon. */
  meta: Record<string, unknown>;
  storage: Storage[];
  rows: number;
  grouping: boolean;
}

interface KeyParts {
  format: number;
  engine: string;
  kind: "query" | "horizon";
  subject: string;
  context: string;
  data: DataFile[];
}

type Storage = "double" | "varchar" | "boolean" | "json";

type InnerExecutor = DashboardExecutor & { close(): Promise<void>; sql?: SqlExecutor["sql"] };

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** The engine fingerprint, once per process. */
let engineHash: Promise<string> | undefined;

async function engineFingerprint(duckdb: string): Promise<string> {
  engineHash ??= (async () => {
    const hash = createHash("sha256").update(`hatchmark ${VERSION}\n`);
    const base = new URL("../", import.meta.url);
    for (const dir of ["compiler", "node", "spec"]) {
      const root = fileURLToPath(new URL(`${dir}/`, base));
      const files = (await readdir(root, { recursive: true, withFileTypes: true }))
        .filter((e) => e.isFile())
        .map((e) => path.join(e.parentPath, e.name))
        .sort();
      for (const file of files) {
        hash.update(`${dir}/${path.relative(root, file).split(path.sep).join("/")}\n`);
        hash.update(await readFile(file));
      }
    }
    return hash.digest("hex");
  })();
  return sha256(`${await engineHash}\n${duckdb}`);
}

async function hashFile(file: string): Promise<{ bytes: number; sha256: string }> {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(file)) {
    hash.update(chunk as Buffer);
    bytes += (chunk as Buffer).length;
  }
  return { bytes, sha256: hash.digest("hex") };
}

/** Why the cache directory cannot be used, or undefined: every existing step must be a real directory. */
async function unsafeDir(root: string): Promise<string | undefined> {
  let at = root;
  for (const part of CACHE_DIR.split("/")) {
    at = path.join(at, part);
    const info = await lstat(at).catch(() => undefined);
    if (info === undefined) return undefined;
    if (info.isSymbolicLink() || !info.isDirectory()) {
      return `${path.relative(root, at)} is not a real directory, so the build cache is off`;
    }
  }
  return undefined;
}

function storageOf(values: unknown[]): Storage {
  let kind: Storage | undefined;
  for (const value of values) {
    if (value === null) continue;
    const next: Storage | undefined =
      typeof value === "number"
        ? "double"
        : typeof value === "boolean"
          ? "boolean"
          : typeof value === "string" && !/\p{Surrogate}/u.test(value)
            ? "varchar"
            : undefined;
    if (next === undefined || (kind !== undefined && kind !== next)) return "json";
    kind = next;
  }
  return kind ?? "varchar";
}

const SQL_TYPE: Record<Storage, string> = {
  double: "DOUBLE",
  varchar: "VARCHAR",
  boolean: "BOOLEAN",
  json: "VARCHAR",
};

/**
 * Wraps an executor with the build cache. readOnly (explain) reads entries but never writes.
 * root is the project directory; config the project's hatchmark.json.
 */
export async function createCachedExecutor(options: {
  root: string;
  config: ProjectConfig;
  inner: InnerExecutor;
  readOnly?: boolean;
  sweep?: boolean;
}): Promise<CachedExecutor> {
  const { root, config, inner } = options;
  const dir = path.join(root, ...CACHE_DIR.split("/"), `v${CACHE_FORMAT}`);
  const stats: CacheStats = { enabled: true, dir: CACHE_DIR, hits: 0, misses: 0, written: 0 };
  const off = await unsafeDir(root);
  if (off !== undefined) {
    stats.enabled = false;
    stats.reason = off;
  }
  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();
  await connection.run("SET TimeZone = 'UTC'");
  await connection.run("SET preserve_insertion_order = true");
  const version = (
    await connection.runAndReadAll("SELECT library_version, source_id FROM pragma_version()")
  )
    .getRows()[0]
    ?.map(String)
    .join(" ");
  const engine = await engineFingerprint(version ?? "unknown");

  const fingerprints = new Map<string, Promise<DataFile>>();
  const fingerprint = (source: string, file: string): Promise<DataFile> => {
    let found = fingerprints.get(file);
    if (found === undefined) {
      found = hashFile(path.join(root, ...file.split("/"))).then((h) => ({ source, file, ...h }));
      fingerprints.set(file, found);
    }
    return found;
  };
  /** The data files a query on this source can read, or undefined when one cannot be read. */
  const dataFiles = async (source: string): Promise<DataFile[] | undefined> => {
    const own = config.sources[source];
    const names =
      own !== undefined && own.type !== "lookup" ? [source] : Object.keys(config.sources).sort();
    try {
      const out: DataFile[] = [];
      for (const name of names) {
        const s = config.sources[name];
        if (s === undefined || s.type === "lookup") continue;
        out.push(await fingerprint(name, normalizePath(s.path)));
      }
      return out;
    } catch {
      return undefined;
    }
  };

  const keyParts = async (
    kind: KeyParts["kind"],
    source: string,
    subject: unknown,
    context: unknown,
  ): Promise<KeyParts | undefined> => {
    const data = await dataFiles(source);
    if (data === undefined) return undefined;
    return {
      format: CACHE_FORMAT,
      engine,
      kind,
      subject: sha256(canonicalJson(subject)),
      context: sha256(canonicalJson(context ?? null)),
      data,
    };
  };

  const entryDir = (kind: KeyParts["kind"]) => path.join(dir, kind === "query" ? "q" : "h");
  const entryName = (id: string, key: string) => `${id}.${key.slice(0, 32)}.parquet`;

  const readHeader = async (file: string): Promise<Header | undefined> => {
    try {
      const rows = (
        await connection.runAndReadAll(
          "SELECT decode(value) FROM parquet_kv_metadata($file) WHERE decode(key) = 'hatchmark'",
          { file },
        )
      ).getRows();
      const text = rows[0]?.[0];
      if (typeof text !== "string") return undefined;
      return JSON.parse(Buffer.from(text, "base64").toString("utf8")) as Header;
    } catch {
      return undefined;
    }
  };

  const read = async (
    kind: KeyParts["kind"],
    id: string,
    key: string,
  ): Promise<{ header: Header; rows: unknown[][]; grouping?: number[] } | undefined> => {
    if (!stats.enabled) return undefined;
    const file = path.join(entryDir(kind), entryName(id, key));
    used.add(file);
    const info = await lstat(file).catch(() => undefined);
    if (info === undefined || !info.isFile()) return undefined;
    const header = await readHeader(file);
    if (header?.format !== CACHE_FORMAT || header.key !== key) return undefined;
    try {
      const reader = await connection.runAndReadAll(
        "SELECT * FROM read_parquet($file) ORDER BY __hm_row",
        { file },
      );
      const all = reader.getRows();
      const width = header.storage.length;
      if (
        all.length !== header.rows ||
        reader.columnCount !== width + 1 + (header.grouping ? 1 : 0)
      ) {
        return undefined;
      }
      const grouping: number[] = [];
      const rows = all.map((row, r) => {
        if (Number(row[0]) !== r) throw new Error("rows out of order");
        if (header.grouping) grouping.push(Number(row[width + 1]));
        return header.storage.map((storage, i) => decode(storage, row[i + 1]));
      });
      return { header, rows, ...(header.grouping ? { grouping } : {}) };
    } catch {
      return undefined;
    }
  };

  /** Entry files this executor read or wrote, kept by sweep. */
  const used = new Set<string>();
  const pending: {
    kind: KeyParts["kind"];
    id: string;
    key: string;
    parts: KeyParts;
    meta: Record<string, unknown>;
    rows: unknown[][];
    grouping?: number[];
  }[] = [];

  const write = async (entry: (typeof pending)[number]) => {
    const target = entryDir(entry.kind);
    const width =
      entry.rows[0]?.length ?? (entry.meta.columns as unknown[] | undefined)?.length ?? 0;
    const storage = Array.from({ length: width }, (_, i) =>
      storageOf(entry.rows.map((row) => row[i])),
    );
    const header: Header = {
      format: CACHE_FORMAT,
      key: entry.key,
      parts: entry.parts,
      stored_at: new Date().toISOString(),
      meta: entry.meta,
      storage,
      rows: entry.rows.length,
      grouping: entry.grouping !== undefined,
    };
    const encoded = Buffer.from(JSON.stringify(header), "utf8").toString("base64");
    const table = `"__hm_cache_${randomUUID().replaceAll("-", "")}"`;
    const columns = [
      '"__hm_row" INTEGER',
      ...storage.map((s, i) => `"c${i}" ${SQL_TYPE[s]}`),
      ...(entry.grouping ? ['"__hm_grouping" INTEGER'] : []),
    ];
    await connection.run(`CREATE TEMP TABLE ${table} (${columns.join(", ")})`);
    try {
      const appender = await connection.createAppender(table.slice(1, -1));
      entry.rows.forEach((row, r) => {
        appender.appendInteger(r);
        storage.forEach((s, i) => {
          const value = row[i];
          if (value === null) appender.appendNull();
          else if (s === "json") appender.appendVarchar(JSON.stringify(value));
          else if (s === "double") appender.appendDouble(value as number);
          else if (s === "boolean") appender.appendBoolean(value as boolean);
          else appender.appendVarchar(value as string);
        });
        if (entry.grouping) appender.appendInteger(entry.grouping[r] ?? -1);
        appender.endRow();
      });
      appender.closeSync();
      await mkdir(target, { recursive: true });
      if ((await unsafeDir(root)) !== undefined) return;
      const final = path.join(target, entryName(entry.id, entry.key));
      const fresh = `${final}.${randomUUID()}.tmp`;
      await connection.run(
        `COPY ${table} TO '${fresh.replaceAll("'", "''")}' (FORMAT parquet, KV_METADATA {hatchmark: '${encoded}'})`,
      );
      await rename(fresh, final).catch(async (error) => {
        await rm(fresh, { force: true });
        throw error;
      });
      used.add(final);
      stats.written++;
    } finally {
      await connection.run(`DROP TABLE IF EXISTS ${table}`);
    }
  };

  /** Queries whose SQL explain asked for, with the context it used. */
  const explained = new Map<string, { query: PlannedQuery; context: ExecutionContext }>();
  const plannedInput = (query: PlannedQuery) => {
    const configured = config.sources[query.source];
    return configured !== undefined && canonicalJson(configured) === canonicalJson(query.input);
  };

  const horizonId = (column: TimeColumn) => `h_${sha256(canonicalJson(column)).slice(0, 16)}`;

  return {
    async execute(query, context) {
      const parts = plannedInput(query)
        ? await keyParts("query", query.source, query, context)
        : undefined;
      if (parts === undefined || !stats.enabled) {
        stats.misses++;
        return inner.execute(query, context);
      }
      const key = sha256(canonicalJson(parts));
      const hit = await read("query", query.id, key);
      if (hit !== undefined) {
        stats.hits++;
        const { columns, ...rest } = hit.header.meta as unknown as Omit<
          QueryResult,
          "rows" | "groupingSet"
        >;
        return {
          columns,
          rows: hit.rows,
          ...(hit.grouping !== undefined ? { groupingSet: hit.grouping } : {}),
          ...rest,
        };
      }
      stats.misses++;
      const result = await inner.execute(query, context);
      const { rows, groupingSet, ...meta } = result;
      pending.push({
        kind: "query",
        id: query.id,
        key,
        parts,
        meta,
        rows,
        ...(groupingSet !== undefined ? { grouping: groupingSet } : {}),
      });
      return result;
    },
    async horizon(column) {
      const source = config.sources[column.source];
      const parts = await keyParts("horizon", column.source, { column, source }, null);
      if (parts === undefined || !stats.enabled) return inner.horizon(column);
      const key = sha256(canonicalJson(parts));
      const id = horizonId(column);
      const hit = await read("horizon", id, key);
      if (hit !== undefined) {
        return hit.header.meta as unknown as Awaited<ReturnType<DashboardExecutor["horizon"]>>;
      }
      const result = await inner.horizon(column);
      pending.push({ kind: "horizon", id, key, parts, meta: { ...result }, rows: [] });
      return result;
    },
    async sql(query, context) {
      if (inner.sql === undefined) throw new Error("this executor cannot print SQL");
      explained.set(query.id, { query, context });
      return inner.sql(query, context);
    },
    async probe(queryId) {
      const seen = explained.get(queryId);
      if (seen === undefined) return undefined;
      const { query, context } = seen;
      if (!stats.enabled)
        return { status: "off", ...(stats.reason ? { reason: stats.reason } : {}) };
      const parts = await keyParts("query", query.source, query, context);
      if (parts === undefined) {
        return { status: "off", reason: "a data file of this query cannot be read" };
      }
      const key = sha256(canonicalJson(parts));
      const data = parts.data;
      const hit = await read("query", query.id, key);
      if (hit !== undefined) return { status: "hit", stored_at: hit.header.stored_at, data };
      const target = entryDir("query");
      const names = (await readdir(target).catch(() => [] as string[])).filter(
        (n) => n.startsWith(`${query.id}.`) && n.endsWith(".parquet"),
      );
      for (const name of names) {
        const older = await readHeader(path.join(target, name));
        if (older?.format !== CACHE_FORMAT) continue;
        const changed: NonNullable<CacheProbe["changed"]> = [];
        if (older.parts.engine !== parts.engine) changed.push("engine");
        if (older.parts.context !== parts.context) changed.push("context");
        if (older.parts.subject !== parts.subject) changed.push("query");
        const before = new Map(older.parts.data.map((d) => [d.file, d.sha256]));
        const files = data.filter((d) => before.get(d.file) !== d.sha256).map((d) => d.file);
        if (files.length > 0 || older.parts.data.length !== data.length) changed.unshift("data");
        return {
          status: "stale",
          stored_at: older.stored_at,
          changed,
          ...(files.length > 0 ? { changed_files: files } : {}),
          data,
        };
      }
      return { status: "miss", data };
    },
    stats: () => ({ ...stats }),
    async close() {
      try {
        if (!options.readOnly && stats.enabled && pending.length > 0) {
          const current = new Map<string, string | undefined>();
          for (const file of new Set(pending.flatMap((e) => e.parts.data.map((d) => d.file)))) {
            current.set(
              file,
              await hashFile(path.join(root, ...file.split("/"))).then(
                (h) => h.sha256,
                () => undefined,
              ),
            );
          }
          for (const entry of pending) {
            if (entry.parts.data.some((d) => current.get(d.file) !== d.sha256)) continue;
            await write(entry).catch(() => {});
          }
        }
        if (!options.readOnly && options.sweep && stats.enabled) {
          for (const kind of ["query", "horizon"] as const) {
            const target = entryDir(kind);
            for (const name of await readdir(target).catch(() => [] as string[])) {
              const file = path.join(target, name);
              if (name.endsWith(".parquet") && !used.has(file)) await rm(file, { force: true });
            }
          }
        }
      } finally {
        connection.closeSync();
        instance.closeSync();
        await inner.close();
      }
    },
  };
}

function decode(storage: Storage, value: unknown): unknown {
  if (value === null) return null;
  switch (storage) {
    case "double":
      if (typeof value !== "number") throw new Error("expected a number");
      return value;
    case "boolean":
      if (typeof value !== "boolean") throw new Error("expected a boolean");
      return value;
    case "varchar":
      if (typeof value !== "string") throw new Error("expected a string");
      return value;
    case "json":
      if (typeof value !== "string") throw new Error("expected JSON text");
      return JSON.parse(value);
  }
}
