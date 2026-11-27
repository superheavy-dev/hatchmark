import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { copyProject } from "./fixture.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await chmod(path.join(dir, ".hatchmark"), 0o755).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

it("copies a project without walking its build cache, which a concurrent build may be rewriting, or its build output", async () => {
  const from = await mkdtemp(path.join(tmpdir(), "hatchmark-fixture-"));
  dirs.push(from);
  await mkdir(path.join(from, "data", "dist"), { recursive: true });
  await writeFile(path.join(from, "hatchmark.json"), "{}");
  await writeFile(path.join(from, "data", "dist", "kept.csv"), "a\n1\n");
  await mkdir(path.join(from, "dist"));
  await writeFile(path.join(from, "dist", "index.html"), "");
  await mkdir(path.join(from, ".hatchmark", "cache", "v1", "q"), { recursive: true });
  await writeFile(path.join(from, ".hatchmark", "cache", "v1", "q", "q_1.parquet.tmp"), "");
  await chmod(path.join(from, ".hatchmark"), 0o000);

  const copy = await copyProject(from, "hatchmark-fixture-copy-");
  dirs.push(copy);
  expect((await readdir(copy, { recursive: true })).sort()).toEqual([
    "data",
    path.join("data", "dist"),
    path.join("data", "dist", "kept.csv"),
    "hatchmark.json",
  ]);
});
