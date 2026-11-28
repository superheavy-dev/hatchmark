import { open, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { ProjectHost } from "../spec/index.js";
import { createDatabaseStore, type DatabaseStore } from "./database.js";

/**
 * The Node.js ProjectHost: reads files under root, reads the columns of Parquet and JSON sources
 * with DuckDB (loaded only when a project has such a source), and the columns of database sources
 * with the connection strings in env.
 */
export function nodeProjectHost(
  root: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): ProjectHost {
  const resolve = (file: string): string => path.join(root, ...file.split("/"));
  let databases: DatabaseStore | undefined;
  return {
    label: root,
    readText: (file) => readFile(resolve(file), "utf8").catch(() => undefined),
    async listFiles(dir) {
      const entries = await readdir(resolve(dir), { withFileTypes: true }).catch(() => []);
      return entries.filter((e) => e.isFile()).map((e) => e.name);
    },
    isFile: (file) =>
      stat(resolve(file)).then(
        (s) => s.isFile(),
        () => false,
      ),
    async readHead(file, bytes) {
      const handle = await open(resolve(file), "r").catch(() => undefined);
      if (handle === undefined) return undefined;
      try {
        const buffer = new Uint8Array(bytes + 1);
        const { bytesRead } = await handle.read(buffer, 0, bytes + 1, 0);
        const complete = bytesRead <= bytes;
        return {
          text: new TextDecoder().decode(buffer.subarray(0, Math.min(bytesRead, bytes))),
          complete,
        };
      } finally {
        await handle.close();
      }
    },
    async columns(file, source) {
      const { describeColumns } = await import("./duckdb.js");
      return describeColumns(resolve(file), source);
    },
    async columnTypes(file, source) {
      const { describeColumnTypes } = await import("./duckdb.js");
      return describeColumnTypes(resolve(file), source);
    },
    database(name, source) {
      databases ??= createDatabaseStore({ root, env });
      return databases.describe(name, source);
    },
  };
}
