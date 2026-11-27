import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { packageRoot } from "../../src/cli/commands/doctor.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const dirs: string[] = [];
afterAll(() => Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))));

async function layout(files: Record<string, unknown>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "hatchmark-root-"));
  dirs.push(root);
  for (const [file, json] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), JSON.stringify(json));
  }
  return root;
}

describe("doctor's package root", () => {
  it("finds the package from the source tree", async () => {
    const commands = path.resolve(HERE, "../../src/cli/commands");
    expect(await packageRoot(commands)).toBe(path.resolve(HERE, "../.."));
  });

  it("finds the package from a built dist, past a nested package.json", async () => {
    const root = await layout({
      "package.json": { name: "hatchmark" },
      "dist/package.json": { type: "module" },
      "dist/cli/commands/.keep": {},
    });
    expect(await packageRoot(path.join(root, "dist/cli/commands"))).toBe(root);
  });

  it("finds the installed package inside a project's node_modules, not the project", async () => {
    const root = await layout({
      "package.json": { name: "my-dashboards" },
      "node_modules/hatchmark/package.json": { name: "hatchmark" },
      "node_modules/hatchmark/dist/cli/commands/.keep": {},
    });
    expect(await packageRoot(path.join(root, "node_modules/hatchmark/dist/cli/commands"))).toBe(
      path.join(root, "node_modules/hatchmark"),
    );
  });

  it("throws when no hatchmark package.json is above the start", async () => {
    const root = await layout({ "package.json": { name: "other" }, "a/b/.keep": {} });
    await expect(packageRoot(path.join(root, "a/b"))).rejects.toThrow("no hatchmark package.json");
  });
});
