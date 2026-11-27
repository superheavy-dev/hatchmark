import { chmod, mkdir, mkdtemp, opendir, readdir, rm, writeFile } from "node:fs/promises";
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

it("removes its temporary directory when the copy fails", async () => {
  const prefix = `hatchmark-fixture-${crypto.randomUUID()}-`;
  await expect(copyProject(path.join(tmpdir(), `${prefix}missing`), prefix)).rejects.toThrow(
    /ENOENT/,
  );
  expect((await readdir(tmpdir())).filter((name) => name.startsWith(prefix))).toEqual([]);
});

it("keeps the copy's own error when removing a partial copy fails (HAT-84)", async () => {
  const from = await mkdtemp(path.join(tmpdir(), "hatchmark-fixture-"));
  dirs.push(from);
  const prefix = `hatchmark-fixture-${crypto.randomUUID()}-`;
  const left = async () => (await readdir(tmpdir())).filter((name) => name.startsWith(prefix));
  await mkdir(path.join(from, "one"));
  await mkdir(path.join(from, "two"));
  const listing = await opendir(from);
  const first = (await listing.read())?.name ?? "";
  const second = (await listing.read())?.name ?? "";
  await listing.close();
  await writeFile(path.join(from, first, "kept.txt"), "x");
  await chmod(path.join(from, first), 0o555);
  await chmod(path.join(from, second), 0o000);
  try {
    await expect(copyProject(from, prefix)).rejects.toMatchObject({
      code: "EACCES",
      syscall: "opendir",
      path: path.join(from, second),
    });
  } finally {
    await chmod(path.join(from, first), 0o755);
    await chmod(path.join(from, second), 0o755);
    for (const name of await left()) {
      await chmod(path.join(tmpdir(), name, first), 0o755).catch(() => {});
      await rm(path.join(tmpdir(), name), { recursive: true, force: true });
    }
  }
});
