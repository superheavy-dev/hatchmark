import { open, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { ProjectHost } from "../spec/index.js";

/** The Node.js ProjectHost: reads files under root. */
export function nodeProjectHost(root: string): ProjectHost {
  const resolve = (file: string): string => path.join(root, ...file.split("/"));
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
        const buffer = new Uint8Array(bytes);
        const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
        return new TextDecoder().decode(buffer.subarray(0, bytesRead));
      } finally {
        await handle.close();
      }
    },
  };
}
