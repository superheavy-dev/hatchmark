import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import {
  access,
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DuckDBInstance } from "@duckdb/node-api";
import {
  canonicalJson,
  type DashboardExecutor,
  type ExecutionContext,
  type PlannedQuery,
  type QueryResult,
  readsRawSql,
  type SqlExecutor,
  type TimeColumn,
} from "../compiler/index.js";
import { isDatabaseSource, normalizePath, type ProjectConfig } from "../spec/index.js";
import { VERSION } from "../version.js";
import { createDatabaseStore, type DatabaseStore } from "./database.js";

const readSources = (query: PlannedQuery): string[] => [
  query.source,
  ...Object.keys(query.tables ?? {}),
];

const CACHE_FORMAT = 1;

export const CACHE_DIR = ".hatchmark/cache";

/** The files a key covers, as stored in an entry and shown by explain. */
export interface DataFile {
  source: string;
  /** Project-relative POSIX path. */
  file: string;
  bytes: number;
  sha256: string;
  /** For a database source: when its local copy was fetched, ISO 8601 UTC. */
  fetched_at?: string;
}

/** What explain shows for one query. */
export interface CacheProbe {
  status: "hit" | "miss" | "stale" | "off";
  /** When the entry used (hit) or the older entry (stale) was written, ISO 8601 UTC. */
  stored_at?: string;
  /** For stale: what differs from the older entry. */
  changed?: ("data" | "engine" | "context")[];
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

const KIND_DIR = {
  query: `cache/v${CACHE_FORMAT}/q`,
  horizon: `cache/v${CACHE_FORMAT}/h`,
} as const;

const CACHE_DIRS = [KIND_DIR.query, KIND_DIR.horizon, "tmp"];

async function unsafeDir(root: string, under: string, writing = true): Promise<string | undefined> {
  let at = root;
  for (const part of [".hatchmark", ...under.split("/")]) {
    at = path.join(at, part);
    let info: Awaited<ReturnType<typeof lstat>>;
    try {
      info = await lstat(at);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return undefined;
      return `${path.relative(root, at)} cannot be read (${code ?? String(error)})`;
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      return `${path.relative(root, at)} is not a real directory`;
    }
    const needed = constants.R_OK | constants.X_OK | (writing ? constants.W_OK : 0);
    if (
      !(await access(at, needed).then(
        () => true,
        () => false,
      ))
    ) {
      return `${path.relative(root, at)} is not ${writing ? "readable and writable" : "readable"}`;
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
 * root is the project directory; config the project's hatchmark.yaml.
 */
export async function createCachedExecutor(options: {
  root: string;
  config: ProjectConfig;
  /** Makes the executor, rooted at the project or at a snapshot of its data files. */
  createInner(root: string, databases: DatabaseStore | undefined): Promise<InnerExecutor>;
  readOnly?: boolean;
  /** Where database sources' rows come from; a store of its own over process.env when absent. */
  databases?: DatabaseStore;
  sweep?: boolean;
}): Promise<CachedExecutor> {
  const { root, config } = options;
  const stats: CacheStats = { enabled: true, dir: CACHE_DIR, hits: 0, misses: 0, written: 0 };
  const turnOff = (reason: string) => {
    if (!stats.enabled) return;
    stats.enabled = false;
    stats.reason = reason;
  };
  const failure = (doing: string, error: unknown) =>
    `${doing} failed (${(error as NodeJS.ErrnoException).code ?? (error instanceof Error ? error.message : String(error))})`;
  for (const under of CACHE_DIRS) {
    if (options.readOnly && under === "tmp") continue;
    const unsafe = await unsafeDir(root, under, !options.readOnly);
    if (unsafe !== undefined) turnOff(unsafe);
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

  const lazy = <T>(make: () => Promise<T>) => {
    let made: Promise<T> | undefined;
    return { get: () => (made ??= make()), made: () => made };
  };
  const snapshotting = stats.enabled && !options.readOnly;
  const snapshot = path.join(root, ".hatchmark", "tmp", randomUUID());
  let snapshotted = false;
  const ownStore =
    options.databases === undefined &&
    Object.values(config.sources).some((s) => isDatabaseSource(s))
      ? createDatabaseStore({ root, env: process.env, readOnly: options.readOnly === true })
      : undefined;
  const databases = options.databases ?? ownStore;
  const projectExecutor = lazy(() => options.createInner(root, databases));
  const snapshotExecutor = lazy(() => options.createInner(snapshot, databases));

  const fingerprints = new Map<string, Promise<DataFile>>();
  const fingerprint = (source: string, file: string): Promise<DataFile> => {
    let found = fingerprints.get(file);
    if (found === undefined) {
      found = (async () => {
        if (file.startsWith("../") || path.posix.isAbsolute(file)) {
          throw new Error(`${file} is outside the project`);
        }
        const original = path.join(root, ...file.split("/"));
        if (!snapshotting) return { source, file, ...(await hashFile(original)) };
        await stat(original);
        const copy = path.join(snapshot, ...file.split("/"));
        try {
          snapshotted = true;
          await mkdir(path.dirname(copy), { recursive: true });
          await copyFile(original, copy, constants.COPYFILE_FICLONE | constants.COPYFILE_EXCL);
          return { source, file, ...(await hashFile(copy)) };
        } catch (error) {
          turnOff(failure(`copying ${file} into .hatchmark/tmp`, error));
          throw error;
        }
      })();
      fingerprints.set(file, found);
    }
    return found;
  };
  const dataFiles = async (sources: string[]): Promise<DataFile[] | undefined> => {
    const files = sources.every(
      (s) => config.sources[s] !== undefined && config.sources[s].type !== "lookup",
    );
    const names = files ? sources : Object.keys(config.sources).sort();
    try {
      const out: DataFile[] = [];
      for (const name of names) {
        const s = config.sources[name];
        if (s === undefined || s.type === "lookup") continue;
        if (isDatabaseSource(s)) {
          if (databases === undefined) return undefined;
          const copy = await databases.copy(name, s);
          out.push({ ...(await fingerprint(name, copy.file)), fetched_at: copy.stored_at });
          continue;
        }
        out.push(await fingerprint(name, normalizePath(s.path)));
      }
      return out;
    } catch {
      return undefined;
    }
  };

  const keyParts = async (
    kind: KeyParts["kind"],
    sources: string[],
    subject: unknown,
    context: unknown,
  ): Promise<KeyParts | undefined> => {
    const data = await dataFiles(sources);
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

  const entryDir = (kind: KeyParts["kind"]) =>
    path.join(root, ".hatchmark", ...KIND_DIR[kind].split("/"));
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
      const unsafe = await unsafeDir(root, KIND_DIR[entry.kind]);
      if (unsafe !== undefined) {
        turnOff(unsafe);
        return;
      }
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

  const explained = new Map<string, { query: PlannedQuery; context: ExecutionContext }>();
  const plannedInput = (query: PlannedQuery) =>
    [[query.source, query.input] as const, ...Object.entries(query.tables ?? {})].every(
      ([name, input]) => {
        const configured = config.sources[name];
        return configured !== undefined && canonicalJson(configured) === canonicalJson(input);
      },
    );

  const horizonId = (column: TimeColumn) => `h_${sha256(canonicalJson(column)).slice(0, 16)}`;

  return {
    async execute(query, context) {
      const parts =
        plannedInput(query) && !readsRawSql(query)
          ? await keyParts("query", readSources(query), query, context)
          : undefined;
      if (parts === undefined || !stats.enabled) {
        stats.misses++;
        const copied = snapshotting && (await dataFiles(readSources(query))) !== undefined;
        return (await (copied ? snapshotExecutor : projectExecutor).get()).execute(query, context);
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
      const result = await (snapshotting ? snapshotExecutor : projectExecutor)
        .get()
        .then((executor) => executor.execute(query, context));
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
    async executeMany(query, contexts) {
      const run = async (executor: InnerExecutor, batch: ExecutionContext[]) => {
        if (executor.executeMany !== undefined) return executor.executeMany(query, batch);
        const out: QueryResult[] = [];
        for (const context of batch) out.push(await executor.execute(query, context));
        return out;
      };
      const cacheable = plannedInput(query) && !readsRawSql(query);
      const keys = await Promise.all(
        contexts.map(async (context) => {
          const parts = cacheable
            ? await keyParts("query", readSources(query), query, context)
            : undefined;
          return parts === undefined || !stats.enabled
            ? undefined
            : { parts, key: sha256(canonicalJson(parts)) };
        }),
      );
      const results: (QueryResult | undefined)[] = [];
      const uncached: number[] = [];
      const missed: number[] = [];
      for (const [i, entry] of keys.entries()) {
        if (entry === undefined) {
          uncached.push(i);
          continue;
        }
        const hit = await read("query", query.id, entry.key);
        if (hit === undefined) {
          missed.push(i);
          continue;
        }
        stats.hits++;
        const { columns, ...rest } = hit.header.meta as unknown as Omit<
          QueryResult,
          "rows" | "groupingSet"
        >;
        results[i] = {
          columns,
          rows: hit.rows,
          ...(hit.grouping !== undefined ? { groupingSet: hit.grouping } : {}),
          ...rest,
        };
      }
      if (uncached.length > 0) {
        stats.misses += uncached.length;
        const copied = snapshotting && (await dataFiles(readSources(query))) !== undefined;
        const executor = await (copied ? snapshotExecutor : projectExecutor).get();
        const ran = await run(
          executor,
          uncached.map((i) => contexts[i] as ExecutionContext),
        );
        uncached.forEach((i, n) => {
          results[i] = ran[n];
        });
      }
      if (missed.length > 0) {
        stats.misses += missed.length;
        const executor = await (snapshotting ? snapshotExecutor : projectExecutor).get();
        const ran = await run(
          executor,
          missed.map((i) => contexts[i] as ExecutionContext),
        );
        missed.forEach((i, n) => {
          const result = ran[n] as QueryResult;
          results[i] = result;
          const entry = keys[i] as { parts: KeyParts; key: string };
          const { rows, groupingSet, ...meta } = result;
          pending.push({
            kind: "query",
            id: query.id,
            key: entry.key,
            parts: entry.parts,
            meta,
            rows,
            ...(groupingSet !== undefined ? { grouping: groupingSet } : {}),
          });
        });
      }
      return results as QueryResult[];
    },
    async horizon(column) {
      const source = config.sources[column.source];
      const parts = await keyParts("horizon", [column.source], { column, source }, null);
      if (parts === undefined || !stats.enabled) {
        return (await projectExecutor.get()).horizon(column);
      }
      const key = sha256(canonicalJson(parts));
      const id = horizonId(column);
      const hit = await read("horizon", id, key);
      if (hit !== undefined) {
        return hit.header.meta as unknown as Awaited<ReturnType<DashboardExecutor["horizon"]>>;
      }
      const result = await (snapshotting ? snapshotExecutor : projectExecutor)
        .get()
        .then((executor) => executor.horizon(column));
      pending.push({ kind: "horizon", id, key, parts, meta: { ...result }, rows: [] });
      return result;
    },
    async sql(query, context) {
      const executor = await projectExecutor.get();
      if (executor.sql === undefined) throw new Error("this executor cannot print SQL");
      explained.set(query.id, { query, context });
      return executor.sql(query, context);
    },
    async probe(queryId) {
      const seen = explained.get(queryId);
      if (seen === undefined) return undefined;
      const { query, context } = seen;
      if (!stats.enabled)
        return { status: "off", ...(stats.reason ? { reason: stats.reason } : {}) };
      if (readsRawSql(query)) {
        return {
          status: "off",
          reason: "raw SQL metrics are never cached; this query always runs",
        };
      }
      const parts = await keyParts("query", readSources(query), query, context);
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
        for (const entry of pending) {
          if (options.readOnly || !stats.enabled) break;
          await write(entry).catch((error) => turnOff(failure("writing a cache entry", error)));
        }
        for (const kind of ["query", "horizon"] as const) {
          if (options.readOnly || !options.sweep || !stats.enabled) break;
          const unsafe = await unsafeDir(root, KIND_DIR[kind]);
          if (unsafe !== undefined) {
            turnOff(unsafe);
            break;
          }
          const target = entryDir(kind);
          try {
            for (const name of await readdir(target).catch((error) => {
              if ((error as NodeJS.ErrnoException).code === "ENOENT") return [] as string[];
              throw error;
            })) {
              const file = path.join(target, name);
              if (name.endsWith(".parquet") && !used.has(file)) await rm(file, { force: true });
            }
          } catch (error) {
            turnOff(failure("removing unused cache entries", error));
          }
        }
      } finally {
        connection.closeSync();
        instance.closeSync();
        for (const executor of [projectExecutor.made(), snapshotExecutor.made()]) {
          if (executor !== undefined) await (await executor).close();
        }
        await ownStore?.close();
        if (snapshotted) await rm(snapshot, { recursive: true, force: true }).catch(() => {});
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
