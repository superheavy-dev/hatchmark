import { readFile } from "node:fs/promises";
import path from "node:path";

export async function packageRoot(from: string, name = "hatchmark"): Promise<string> {
  for (let dir = from; ; dir = path.dirname(dir)) {
    const manifest = await readFile(path.join(dir, "package.json"), "utf8").then(
      (text) => JSON.parse(text) as { name?: unknown },
      () => undefined,
    );
    if (manifest?.name === name) return dir;
    if (path.dirname(dir) === dir) throw new Error(`no ${name} package.json above ${from}`);
  }
}
