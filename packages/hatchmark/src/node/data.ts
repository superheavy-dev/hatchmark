import path from "node:path";
import {
  type DuckDBConnection,
  DuckDBInstance,
  type DuckDBResultReader,
  DuckDBTypeId,
  StatementType,
} from "@duckdb/node-api";
import { quote } from "../compiler/index.js";
import { type FileSource, normalizePath, type ProjectConfig } from "../spec/index.js";
import { type LoadedSource, loadSource } from "./duckdb.js";

export type ColumnKind = "time" | "number" | "boolean" | "text" | "other";
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface ColumnSummary {
  name: string;
  type: string;
  kind: ColumnKind;
  nulls: number;
  distinct: number;
  min?: JsonValue;
  max?: JsonValue;
}

export interface SourceDescription {
  row_count: number;
  columns: ColumnSummary[];
  sample: { columns: string[]; rows: JsonValue[][] };
}

export interface QueryResultRows {
  columns: { name: string; type: string }[];
  rows: JsonValue[][];
  truncated: boolean;
}

export class SourceReadError extends Error {}
export class QueryRejected extends Error {}

export function columnKind(type: string): ColumnKind {
  if (/^(DATE|TIMESTAMP)/.test(type)) return "time";
  if (/^(U?(TINY|SMALL|BIG|HUGE)?INT(EGER)?|FLOAT|DOUBLE|REAL|DECIMAL)/.test(type)) return "number";
  if (type === "BOOLEAN") return "boolean";
  if (type === "VARCHAR") return "text";
  return "other";
}

const INTEGERS = new Set<DuckDBTypeId>([
  DuckDBTypeId.BIGINT,
  DuckDBTypeId.UBIGINT,
  DuckDBTypeId.HUGEINT,
  DuckDBTypeId.UHUGEINT,
]);

function toNumber(value: JsonValue, integer: boolean): JsonValue {
  if (typeof value !== "string") return value;
  const n = Number(value);
  if (integer) return Number.isSafeInteger(n) ? n : value;
  return Number.isFinite(n) && Math.abs(n) < 1e15 ? n : value;
}

function jsonRows(reader: DuckDBResultReader, limit = Number.POSITIVE_INFINITY): JsonValue[][] {
  const types = reader.columnTypes();
  return (reader.getRowsJson() as JsonValue[][]).slice(0, limit).map((row) =>
    row.map((value, i) => {
      const id = types[i]?.typeId;
      if (id === undefined) return value;
      if (INTEGERS.has(id)) return toNumber(value, true);
      if (id === DuckDBTypeId.DECIMAL) return toNumber(value, false);
      return value;
    }),
  );
}

/**
 * A read-only view of a project's file sources for exploring data: each source is loaded once,
 * with the reader options build uses, into a table named after the source. The session time zone
 * is UTC. Once the sources a query reads are loaded, file system access is switched off and the
 * configuration locked, so a query can read only those tables.
 */
export async function openDataSession(options: { root: string; config: ProjectConfig }) {
  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();
  await connection.run("SET TimeZone = 'UTC'");
  await connection.run("SET preserve_insertion_order = true");
  const loaded = new Map<string, LoadedSource>();

  const load = async (name: string): Promise<LoadedSource> => {
    const existing = loaded.get(name);
    if (existing) return existing;
    const source = options.config.sources[name] as FileSource;
    const file = path.join(options.root, ...normalizePath(source.path).split("/"));
    try {
      const table = await loadSource(connection, name, source, file);
      loaded.set(name, table);
      return table;
    } catch (error) {
      throw new SourceReadError((error as Error).message);
    }
  };

  return {
    async describe(name: string, sampleRows: number): Promise<SourceDescription> {
      const { relation, columns } = await load(name);
      const stats = columns.flatMap((c, i) => {
        const id = quote(c.name);
        const ranged = ["time", "number"].includes(columnKind(c.type));
        return [
          `count(${id}) AS "c${i}"`,
          `count(DISTINCT ${id}) AS "d${i}"`,
          ...(ranged ? [`min(${id}) AS "min${i}"`, `max(${id}) AS "max${i}"`] : []),
        ];
      });
      const reader = await connection.runAndReadAll(
        `SELECT count(*) AS "rows"${stats.map((s) => `, ${s}`).join("")} FROM ${relation}`,
      );
      const names = reader.columnNames();
      const [row = []] = jsonRows(reader);
      const at = (key: string): JsonValue => row[names.indexOf(key)] ?? null;
      const rowCount = Number(at("rows"));
      const sample = await connection.runAndReadAll(
        `SELECT * EXCLUDE ("__hm_ord") FROM ${relation} ORDER BY "__hm_ord" LIMIT ${Math.max(0, Math.floor(sampleRows))}`,
      );
      return {
        row_count: rowCount,
        columns: columns.map((c, i) => {
          const kind = columnKind(c.type);
          const ranged = kind === "time" || kind === "number";
          return {
            name: c.name,
            type: c.type,
            kind,
            nulls: rowCount - Number(at(`c${i}`)),
            distinct: Number(at(`d${i}`)),
            ...(ranged ? { min: at(`min${i}`), max: at(`max${i}`) } : {}),
          };
        }),
        sample: { columns: sample.columnNames(), rows: jsonRows(sample) },
      };
    },

    async query(sql: string, sources: readonly string[], limit: number): Promise<QueryResultRows> {
      for (const name of sources) {
        const { relation } = await load(name);
        await connection.run(
          `CREATE TEMP VIEW ${quote(name)} AS SELECT * EXCLUDE ("__hm_ord") FROM ${relation} ORDER BY "__hm_ord"`,
        );
      }
      await lock(connection);
      if (sql.replace(/[\s;]/g, "") === "") throw new QueryRejected("the query is empty");
      const extracted = await connection.extractStatements(sql).catch((error: Error) => {
        throw new Error(error.message.replace(/^Failed to extract statements: /, ""));
      });
      if (extracted.count !== 1) {
        throw new QueryRejected(
          extracted.count === 0
            ? "the query is empty"
            : `the query has ${extracted.count} statements`,
        );
      }
      const prepared = await extracted.prepare(0).catch((error: Error) => {
        throw permission(error);
      });
      if (prepared.statementType !== StatementType.SELECT) {
        throw new QueryRejected("the query is not a SELECT statement");
      }
      const reader = await prepared.streamAndReadUntil(limit + 1).catch((error: Error) => {
        throw permission(error);
      });
      const types = reader.columnTypes();
      return {
        columns: reader.columnNames().map((name, i) => ({ name, type: String(types[i]) })),
        rows: jsonRows(reader, limit),
        truncated: reader.currentRowCount > limit,
      };
    },

    async close(): Promise<void> {
      connection.closeSync();
      instance.closeSync();
    },
  };
}

function permission(error: Error): Error {
  return error.message.startsWith("Permission Error")
    ? new QueryRejected("the query reads or writes files outside the project's sources")
    : error;
}

async function lock(connection: DuckDBConnection): Promise<void> {
  await connection.run("SET enable_external_access = false");
  await connection.run("SET lock_configuration = true");
}

export type DataSession = Awaited<ReturnType<typeof openDataSession>>;
