import { createHash } from "node:crypto";
import {
  appendFile,
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { build as buildCommand } from "../../src/cli/commands/build.js";
import { run as cli } from "../../src/cli/main.js";
import {
  type ExecutionContext,
  type PlannedQuery,
  type QueryResult,
  runDashboard,
} from "../../src/compiler/index.js";
import { createCachedExecutor, createDuckDbExecutor } from "../../src/node/index.js";
import { PROJECT_DEFAULTS, type ProjectConfig } from "../../src/spec/index.js";
import { EXAMPLE, removeProjects } from "./fixture.js";

/**
 * The build cache (src/node/cache.ts). The oracle for every attack is the same build with
 * --no-cache, which runs every query in DuckDB and never reads or writes the cache: a cached build
 * must give the same bytes, file for file.
 */

const roots: string[] = [];
afterAll(async () => {
  await removeProjects();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function example(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "hatchmark-cache-"));
  roots.push(root);
  await cp(EXAMPLE, root, { recursive: true });
  await rm(path.join(root, "dist"), { recursive: true, force: true });
  await rm(path.join(root, ".hatchmark"), { recursive: true, force: true });
  return root;
}

interface Built {
  code: number;
  report: {
    ok: boolean;
    cache?: { enabled: boolean; hits: number; misses: number; written: number; reason?: string };
  };
  files: Record<string, string>;
}

async function cliJson(args: string[]): Promise<{ code: number; json: unknown }> {
  let stdout = "";
  const code = await cli([...args, "--json"], {
    stdout: (t) => {
      stdout += t;
    },
    stderr: () => {},
    cwd: "/",
    env: {},
    stdoutIsTTY: false,
    isAgent: async () => false,
  });
  return { code, json: JSON.parse(stdout.trim().split("\n").pop() ?? "null") };
}

/** Builds into out (a fresh directory each time) and returns every output file's SHA-256. */
async function build(root: string, cache: boolean): Promise<Built> {
  const out = path.join(root, `out-${crypto.randomUUID()}`);
  const { code, json } = await cliJson([
    "build",
    "--cwd",
    root,
    "--out",
    out,
    ...(cache ? [] : ["--no-cache"]),
  ]);
  const files: Record<string, string> = {};
  if (code === 0) {
    for (const entry of await readdir(out, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const file = path.join(entry.parentPath, entry.name);
      files[path.relative(out, file)] = createHash("sha256")
        .update(await readFile(file))
        .digest("hex");
    }
    await rm(out, { recursive: true, force: true });
  }
  return { code, report: json as Built["report"], files };
}

async function entries(root: string): Promise<string[]> {
  const dir = path.join(root, ".hatchmark", "cache", "v1");
  const out: string[] = [];
  for (const kind of ["q", "h"]) {
    for (const name of await readdir(path.join(dir, kind)).catch(() => [] as string[])) {
      out.push(path.join(dir, kind, name));
    }
  }
  return out.sort();
}

async function editJson(
  root: string,
  file: string,
  edit: (value: Record<string, any>) => Record<string, unknown>,
): Promise<void> {
  const at = path.join(root, file);
  await writeFile(at, JSON.stringify(edit(JSON.parse(await readFile(at, "utf8"))), null, 2));
}

/** The example's last order, the newest row. */
const LAST = "105194,2026-10-31T22:54:53Z,C00223,Netherlands,EMEA,Direct,Apparel,paid,66.41";

/** Rewrites one byte-for-byte equal-length value in orders.csv and restores the mtime. */
async function editInPlace(root: string, from: string, to: string): Promise<void> {
  expect(to.length).toBe(from.length);
  const file = path.join(root, "data", "orders.csv");
  await utimes(file, 1_790_000_000, 1_790_000_000);
  const before = await stat(file);
  const text = await readFile(file, "utf8");
  expect(text.includes(from)).toBe(true);
  await writeFile(file, text.replace(from, to));
  await utimes(file, 1_790_000_000, 1_790_000_000);
  const after = await stat(file);
  expect(after.size).toBe(before.size);
  expect(after.mtimeMs).toBe(before.mtimeMs);
}

describe("build cache", () => {
  it("gives byte-identical output cold, warm and with --no-cache, and reuses every query warm", async () => {
    const root = await example();
    const oracle = await build(root, false);
    expect(oracle.code).toBe(0);
    expect(oracle.report.cache).toBeUndefined();
    expect(await entries(root)).toEqual([]);

    const cold = await build(root, true);
    expect(cold.code).toBe(0);
    expect(cold.report.cache).toMatchObject({ enabled: true, hits: 0 });
    expect(cold.report.cache?.misses).toBeGreaterThan(10);
    expect(cold.files).toEqual(oracle.files);

    const warm = await build(root, true);
    expect(warm.report.cache).toMatchObject({
      hits: cold.report.cache?.misses,
      misses: 0,
      written: 0,
    });
    expect(warm.files).toEqual(oracle.files);
    expect((await entries(root)).every((f) => f.endsWith(".parquet"))).toBe(true);
  });

  it("invalidates on a changed byte even when the file keeps its size and modification time", async () => {
    const root = await example();
    const before = await build(root, true);
    await editInPlace(root, LAST, LAST.replace(",paid,", ",void,"));
    const oracle = await build(root, false);
    expect(oracle.files).not.toEqual(before.files);
    const after = await build(root, true);
    expect(after.report.cache?.hits).toBe(0);
    expect(after.files).toEqual(oracle.files);
    const again = await build(root, true);
    expect(again.report.cache?.misses).toBe(0);
    expect(again.files).toEqual(oracle.files);
  });

  it("recomputes only the queries a metric edit changes", async () => {
    const root = await example();
    const cold = await build(root, true);
    const file = path.join(root, "metrics", "refund_rate.json");
    const metric = JSON.parse(await readFile(file, "utf8"));
    metric.label = "Refunds (share of orders)";
    await writeFile(file, JSON.stringify(metric, null, 2));
    const labelled = await build(root, true);
    expect(labelled.report.cache?.misses).toBe(0);

    const revenue = path.join(root, "metrics", "revenue.json");
    const spec = JSON.parse(await readFile(revenue, "utf8"));
    spec.filters = [{ column: "status", op: "eq", value: "refunded" }];
    await writeFile(revenue, JSON.stringify(spec, null, 2));
    const oracle = await build(root, false);
    const edited = await build(root, true);
    expect(edited.report.cache?.misses).toBeGreaterThan(0);
    expect(edited.report.cache?.hits).toBeGreaterThan(0);
    expect((edited.report.cache?.hits ?? 0) + (edited.report.cache?.misses ?? 0)).toBe(
      cold.report.cache?.misses ?? 0,
    );
    expect(edited.files).toEqual(oracle.files);
  });

  it("invalidates on a reader option in hatchmark.json and on appended rows that move latest_data", async () => {
    const root = await example();
    await build(root, true);
    const config = path.join(root, "hatchmark.json");
    const project = JSON.parse(await readFile(config, "utf8"));
    project.timezone = "Europe/London";
    await writeFile(config, JSON.stringify(project, null, 2));
    const zoned = await build(root, true);
    expect(zoned.report.cache?.hits).toBe(0);
    expect(zoned.files).toEqual((await build(root, false)).files);

    await appendFile(
      path.join(root, "data", "orders.csv"),
      "999999,2026-11-03T10:00:00Z,C00001,Canada,Americas,Direct,Home,paid,10.00\n",
    );
    const appended = await build(root, true);
    expect(appended.report.cache?.hits).toBe(0);
    expect(appended.files).toEqual((await build(root, false)).files);
  });

  it("matches --no-cache after random same-size, same-mtime digit edits (HM_SWEEP=full for 40)", async () => {
    const root = await example();
    const file = path.join(root, "data", "orders.csv");
    let seed = 49;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    await build(root, true);
    const rounds = process.env.HM_SWEEP === "full" ? 40 : 3;
    for (let round = 0; round < rounds; round++) {
      const text = await readFile(file, "utf8");
      const lines = text.split("\n");
      const at = 1 + Math.floor(random() * (lines.length - 2));
      const line = lines[at] ?? "";
      const digits = [...line.matchAll(/\d/g)].map((m) => m.index);
      const pos = digits[Math.floor(random() * digits.length)] ?? 0;
      const digit = String((Number(line[pos]) + 1 + Math.floor(random() * 9)) % 10);
      lines[at] = line.slice(0, pos) + digit + line.slice(pos + 1);
      await utimes(file, 1_790_000_000, 1_790_000_000);
      await writeFile(file, lines.join("\n"));
      await utimes(file, 1_790_000_000, 1_790_000_000);
      const oracle = await build(root, false);
      const cached = await build(root, true);
      expect(cached.code, `round ${round}`).toBe(oracle.code);
      expect(cached.files, `round ${round}: line ${at} column ${pos}`).toEqual(oracle.files);
      if (cached.code === 0) expect(cached.report.cache?.hits).toBe(0);
    }
  });

  it("never caches raw SQL metrics, which can read the clock or files no key covers (HAT-52)", async () => {
    const root = await example();
    await writeFile(path.join(root, "data", "adjustment.csv"), "adjustment\n7\n");
    const file = path.join(root, "metrics", "orders.json");
    const { aggregate: _, column: __, ...metric } = JSON.parse(await readFile(file, "utf8"));
    const adjustment = path.join(root, "data", "adjustment.csv").replaceAll("'", "''");
    await writeFile(
      file,
      JSON.stringify({
        ...metric,
        type: "sql",
        additive: false,
        sql: `count(*) * 0 + (SELECT sum(adjustment) FROM read_csv_auto('${adjustment}'))`,
      }),
    );
    const cold = await build(root, true);
    expect(cold.code).toBe(0);
    await writeFile(path.join(root, "data", "adjustment.csv"), "adjustment\n9\n");
    const oracle = await build(root, false);
    expect(oracle.files).not.toEqual(cold.files);
    const warm = await build(root, true);
    expect(warm.files).toEqual(oracle.files);
    expect(warm.report.cache?.misses).toBeGreaterThan(0);
    expect(warm.report.cache?.hits).toBeGreaterThan(0);
  });

  it("still builds when the cache directory is read-only (HAT-52)", async () => {
    const root = await example();
    await build(root, true);
    const q = path.join(root, ".hatchmark", "cache", "v1", "q");
    await appendFile(
      path.join(root, "data", "orders.csv"),
      "999999,2026-11-03T10:00:00Z,C00001,Canada,Americas,Direct,Home,paid,10.00\n",
    );
    await chmod(q, 0o555);
    try {
      const oracle = await build(root, false);
      const cached = await build(root, true);
      expect(cached.code).toBe(0);
      expect(cached.files).toEqual(oracle.files);
    } finally {
      await chmod(q, 0o755);
    }
  });

  it("stores what DuckDB read even when the data changes and changes back mid-build (HAT-53 ABA)", async () => {
    const root = await example();
    const file = path.join(root, "data", "orders.csv");
    const original = await readFile(file, "utf8");
    const other = original.replaceAll(",paid,", ",void,");
    let swapped = false;
    const io = {
      stdout: () => {},
      stderr: () => {},
      cwd: "/",
      env: {},
      stdoutIsTTY: false,
      isAgent: async () => false,
    };
    const result = await buildCommand(
      { io, root, mode: "json", color: false, quiet: false },
      { out: path.join(root, "out-aba") },
      {
        runDashboard,
        createExecutor: async (options) => {
          const inner = await createDuckDbExecutor(options);
          return {
            ...inner,
            async execute(query, context) {
              if (!swapped) {
                swapped = true;
                await writeFile(file, other);
              }
              return inner.execute(query, context);
            },
            async close() {
              await writeFile(file, original);
              await inner.close();
            },
          };
        },
      },
    );
    expect(result.exitCode).toBe(0);
    expect(swapped).toBe(true);
    expect(await readFile(file, "utf8")).toBe(original);
    const warm = await build(root, true);
    expect(warm.report.cache?.misses).toBe(0);
    expect(warm.files).toEqual((await build(root, false)).files);
  });

  it("never writes or sweeps through a symbolic link anywhere under .hatchmark (HAT-53)", async () => {
    for (const under of ["cache/v1/q", "cache/v1/h", "cache/v1", "tmp"]) {
      const root = await example();
      const victim = await mkdtemp(path.join(tmpdir(), "hatchmark-cache-victim-"));
      roots.push(victim);
      await writeFile(path.join(victim, "precious.parquet"), "not a cache entry\n");
      const link = path.join(root, ".hatchmark", ...under.split("/"));
      await mkdir(path.dirname(link), { recursive: true });
      await symlink(victim, link);
      const oracle = await build(root, false);
      const linked = await build(root, true);
      expect(linked.report.cache, under).toMatchObject({ enabled: false });
      expect(linked.files).toEqual(oracle.files);
      expect(await readdir(victim), under).toEqual(["precious.parquet"]);
    }
  });

  const edits: [string, (root: string) => Promise<void>][] = [
    [
      "weekStart",
      (root) => editJson(root, "hatchmark.json", (c) => ({ ...c, weekStart: "monday" })),
    ],
    [
      "source timezone",
      (root) =>
        editJson(root, "hatchmark.json", (c) => {
          c.sources.orders.timezone = "Asia/Tokyo";
          return c;
        }),
    ],
    [
      "freshness lag",
      (root) =>
        editJson(root, "hatchmark.json", (c) => {
          c.sources.orders.freshness = { lag: { days: 40 } };
          return c;
        }),
    ],
    [
      "freshness through",
      (root) =>
        editJson(root, "hatchmark.json", (c) => {
          c.sources.orders.freshness = { through: "2025-06-30" };
          return c;
        }),
    ],
    [
      "csv delimiter",
      async (root) => {
        const file = path.join(root, "data", "orders.csv");
        await writeFile(file, (await readFile(file, "utf8")).replaceAll(",", ";"));
        await editJson(root, "hatchmark.json", (c) => {
          c.sources.orders.delimiter = ";";
          return c;
        });
      },
    ],
    [
      "data symlink retargeted",
      async (root) => {
        const file = path.join(root, "data", "orders.csv");
        const text = await readFile(file, "utf8");
        await writeFile(path.join(root, "data", "b.csv"), text.replaceAll(",paid,", ",void,"));
        await rm(file);
        await symlink("b.csv", file);
      },
    ],
  ];
  it.each(edits)("matches --no-cache after a change to %s (HAT-53 harness)", async (_, edit) => {
    const root = await example();
    const file = path.join(root, "data", "orders.csv");
    await writeFile(path.join(root, "data", "a.csv"), await readFile(file));
    await rm(file);
    await symlink("a.csv", file);
    await build(root, true);
    await edit(root);
    const cached = await build(root, true);
    expect(cached.code).toBe(0);
    expect(cached.report.cache?.hits).toBe(0);
    expect(cached.files).toEqual((await build(root, false)).files);
  });

  it("builds and explains when .hatchmark/tmp is inaccessible (HAT-52)", async () => {
    const root = await example();
    const tmp = path.join(root, ".hatchmark", "tmp");
    await mkdir(tmp, { recursive: true });
    await chmod(tmp, 0o000);
    try {
      const oracle = await build(root, false);
      const cached = await build(root, true);
      expect(cached.code).toBe(0);
      expect(cached.files).toEqual(oracle.files);
      const explained = await cliJson([
        "explain",
        "--cwd",
        root,
        "--dashboard",
        "sales",
        "--block",
        "revenue",
      ]);
      expect(explained.code).toBe(0);
    } finally {
      await chmod(tmp, 0o755);
    }
  });

  const blocked = [".hatchmark", "cache", "cache/v1", "cache/v1/q", "cache/v1/h", "tmp"].flatMap(
    (under) => [0o000, 0o555].map((mode) => [under, mode] as const),
  );
  it.each(blocked)(
    "with .hatchmark/%s at mode %o, build and explain succeed and match --no-cache (best effort)",
    async (under, mode) => {
      const root = await example();
      await build(root, true);
      await appendFile(
        path.join(root, "data", "orders.csv"),
        "999999,2026-11-03T10:00:00Z,C00001,Canada,Americas,Direct,Home,paid,10.00\n",
      );
      const dir = path.join(
        root,
        ...(under === ".hatchmark" ? [under] : [".hatchmark", ...under.split("/")]),
      );
      await mkdir(dir, { recursive: true });
      await chmod(dir, mode);
      try {
        const oracle = await build(root, false);
        const cached = await build(root, true);
        expect(cached.code).toBe(0);
        expect(cached.files).toEqual(oracle.files);
        expect(cached.report.cache?.enabled).toBe(false);
        expect(cached.report.cache?.reason).toBeTruthy();
        const explained = await cliJson([
          "explain",
          "--cwd",
          root,
          "--dashboard",
          "sales",
          "--block",
          "revenue",
        ]);
        expect(explained.code).toBe(0);
        if (mode === 0o000 && under !== "tmp") {
          const queries = (explained.json as { queries: { cache?: { status: string } }[] }).queries;
          for (const q of queries) expect(q.cache?.status).toBe("off");
        }
      } finally {
        await chmod(dir, 0o755);
      }
    },
  );

  const extra = [".hatchmark", "cache", "cache/v1", "cache/v1/q", "cache/v1/h", "tmp"].flatMap(
    (under) => (["0300", "file"] as const).map((how) => [under, how] as const),
  );
  it.each(extra)(
    "with .hatchmark/%s as %s, build and explain succeed and match --no-cache (HAT-53 perms.mjs)",
    async (under, how) => {
      const root = await example();
      await build(root, true);
      await appendFile(
        path.join(root, "data", "orders.csv"),
        "999999,2026-11-03T10:00:00Z,C00001,Canada,Americas,Direct,Home,paid,10.00\n",
      );
      const dir = path.join(
        root,
        ...(under === ".hatchmark" ? [under] : [".hatchmark", ...under.split("/")]),
      );
      await mkdir(dir, { recursive: true });
      if (how === "file") {
        await rm(dir, { recursive: true, force: true });
        await writeFile(dir, "x");
      } else {
        await chmod(dir, 0o300);
      }
      try {
        const oracle = await build(root, false);
        const cached = await build(root, true);
        expect(cached.code).toBe(0);
        expect(cached.files).toEqual(oracle.files);
        expect(cached.report.cache?.enabled).toBe(false);
        const explained = await cliJson([
          "explain",
          "--cwd",
          root,
          "--dashboard",
          "sales",
          "--block",
          "revenue",
        ]);
        expect(explained.code).toBe(0);
      } finally {
        if (how !== "file") await chmod(dir, 0o755);
      }
    },
  );

  it.each(["q", "h"])(
    "with one %s entry file at mode 000, build and explain succeed and match --no-cache (HAT-53 perms.mjs)",
    async (kind) => {
      const root = await example();
      await build(root, true);
      const dir = path.join(root, ".hatchmark", "cache", "v1", kind);
      const entry = path.join(dir, (await readdir(dir)).find((n) => n.endsWith(".parquet")) ?? "");
      await chmod(entry, 0o000);
      try {
        const oracle = await build(root, false);
        const cached = await build(root, true);
        expect(cached.code).toBe(0);
        expect(cached.files).toEqual(oracle.files);
        const explained = await cliJson([
          "explain",
          "--cwd",
          root,
          "--dashboard",
          "sales",
          "--block",
          "revenue",
        ]);
        expect(explained.code).toBe(0);
      } finally {
        await chmod(entry, 0o644).catch(() => {});
      }
    },
  );

  it.each([0o000, 0o555])(
    "with an empty .hatchmark at mode %o, a first build succeeds and matches --no-cache",
    async (mode) => {
      const root = await example();
      const dir = path.join(root, ".hatchmark");
      await mkdir(dir);
      await chmod(dir, mode);
      try {
        const oracle = await build(root, false);
        const cached = await build(root, true);
        expect(cached.code).toBe(0);
        expect(cached.files).toEqual(oracle.files);
        expect(cached.report.cache?.enabled).toBe(false);
      } finally {
        await chmod(dir, 0o755);
      }
    },
  );

  it("treats corrupted, truncated and swapped entries as misses and rewrites them", async () => {
    const root = await example();
    const oracle = await build(root, false);
    await build(root, true);
    const files = (await entries(root)).filter((f) => f.includes(`${path.sep}q${path.sep}`));
    expect(files.length).toBeGreaterThan(3);
    const [a, b, c, d] = files as [string, string, string, string];
    await writeFile(a, "not parquet");
    const bytes = await readFile(b);
    await writeFile(b, bytes.subarray(0, Math.floor(bytes.length / 2)));
    const cBytes = await readFile(c);
    await writeFile(c, await readFile(d));
    await writeFile(d, cBytes);
    const rebuilt = await build(root, true);
    expect(rebuilt.report.cache?.misses).toBe(4);
    expect(rebuilt.files).toEqual(oracle.files);
    const healed = await build(root, true);
    expect(healed.report.cache?.misses).toBe(0);
    expect(healed.files).toEqual(oracle.files);
  });

  it("keeps only the last build's entries", async () => {
    const root = await example();
    await build(root, true);
    const first = await entries(root);
    await editInPlace(root, LAST, LAST.replace(",paid,", ",lost,"));
    await build(root, true);
    const second = await entries(root);
    expect(second.length).toBe(first.length);
    expect(second.filter((f) => first.includes(f))).toEqual([]);
  });

  it("turns itself off when .hatchmark is a symbolic link, and still builds the same output", async () => {
    const root = await example();
    const elsewhere = await mkdtemp(path.join(tmpdir(), "hatchmark-cache-elsewhere-"));
    roots.push(elsewhere);
    await symlink(elsewhere, path.join(root, ".hatchmark"));
    const oracle = await build(root, false);
    const linked = await build(root, true);
    expect(linked.report.cache).toMatchObject({ enabled: false, hits: 0 });
    expect(linked.report.cache?.reason).toContain(".hatchmark");
    expect(linked.files).toEqual(oracle.files);
    expect(await readdir(elsewhere)).toEqual([]);
  });

  it("explain shows a miss, then a hit after build, then stale with the changed file", async () => {
    const root = await example();
    const explain = async () => {
      const { code, json } = await cliJson([
        "explain",
        "--cwd",
        root,
        "--dashboard",
        "sales",
        "--block",
        "revenue",
      ]);
      expect(code).toBe(0);
      return (json as { queries: { cache?: Record<string, unknown> }[] }).queries.map(
        (q) => q.cache,
      );
    };
    expect((await explain()).every((c) => c?.status === "miss")).toBe(true);
    expect(await entries(root)).toEqual([]);
    await build(root, true);
    const hits = await explain();
    expect(hits.length).toBeGreaterThan(0);
    for (const c of hits) {
      expect(c).toMatchObject({
        status: "hit",
        data: [{ source: "orders", file: "data/orders.csv" }],
      });
      expect(typeof c?.stored_at).toBe("string");
    }
    await editInPlace(root, LAST, LAST.replace(",paid,", ",gone,"));
    for (const c of await explain()) {
      expect(c).toMatchObject({
        status: "stale",
        changed: ["data"],
        changed_files: ["data/orders.csv"],
      });
    }
  });
});

describe("cached executor", () => {
  const config: ProjectConfig = {
    ...PROJECT_DEFAULTS,
    name: "t",
    sources: { t: { type: "csv", path: "data/t.csv" } },
  } as unknown as ProjectConfig;
  const query = {
    id: "q_test",
    source: "t",
    input: { type: "csv", path: "data/t.csv" },
    measures: [],
  } as unknown as PlannedQuery;
  const context = {
    asOf: "2026-10-31",
    timezone: "UTC",
    anchors: {},
    bindings: {},
  } as unknown as ExecutionContext;

  async function project(): Promise<string> {
    const root = await mkdtemp(path.join(tmpdir(), "hatchmark-cache-unit-"));
    roots.push(root);
    await mkdir(path.join(root, "data"));
    await writeFile(path.join(root, "data", "t.csv"), "a\n1\n");
    return root;
  }

  const fake = (result: QueryResult, onExecute?: () => Promise<void>) => ({
    execute: async () => {
      await onExecute?.();
      return structuredClone(result);
    },
    horizon: async () => ({ latest: "2026-10-31", date: true, naive: false }),
    close: async () => {},
  });

  const roundTrip = async (root: string, result: QueryResult): Promise<QueryResult> => {
    const writer = await createCachedExecutor({
      root,
      config,
      createInner: async () => fake(result),
    });
    await writer.execute(query, context);
    await writer.close();
    const reader = await createCachedExecutor({
      root,
      config,
      createInner: async () => fake({ columns: [], rows: [] }),
    });
    const back = await reader.execute(query, context);
    expect(reader.stats().hits).toBe(1);
    await reader.close();
    return back;
  };

  it("round-trips every value the executor returns exactly, key order included", async () => {
    const root = await project();
    const result: QueryResult = {
      columns: [
        { name: "s", type: "string" },
        { name: "n", type: "number" },
        { name: "b", type: "boolean" },
        { name: "mixed", type: "number" },
        { name: "nulls", type: "null" },
        { name: "odd", type: "string" },
        { name: "x__sum", type: "number" },
      ],
      rows: [
        ["", -0, true, 1, null, "\ud800 lone", 5e-324],
        [null, 1.7976931348623157e308, false, "12345678901234567890", null, "a\u0000b", 0.1 + 0.2],
        ["日本 \u{1F600}", -1e-300, null, null, null, null, null],
        ["x", 9007199254740991, true, 2.5, null, "ok", -123.456],
      ],
      groupingSet: [0, 1, 2, 2],
      imprecise: [{ column: "x", maxAbs: 1.5e16 }],
      large: [{ metric: "x", maxAbs: 2e13 }],
    };
    const back = await roundTrip(root, result);
    expect(JSON.stringify(back)).toBe(JSON.stringify(result));
    expect(Object.keys(back)).toEqual(Object.keys(result));
    back.rows.forEach((row, r) => {
      row.forEach((value, i) => {
        expect(Object.is(value, result.rows[r]?.[i])).toBe(true);
      });
    });
  });

  it("round-trips an empty result and one without grouping sets", async () => {
    const root = await project();
    const empty: QueryResult = { columns: [{ name: "v", type: "number" }], rows: [] };
    expect(await roundTrip(root, empty)).toEqual(empty);
    const root2 = await project();
    const none: QueryResult = { columns: [], rows: [[]] };
    expect(await roundTrip(root2, none)).toEqual(none);
  });

  it("computes from a snapshot, so an edit and its undo during the build store nothing wrong (HAT-53 ABA)", async () => {
    const root = await project();
    const file = path.join(root, "data", "t.csv");
    const value = async (at: string) =>
      Number((await readFile(path.join(at, "data", "t.csv"), "utf8")).split("\n")[1]);
    const executor = await createCachedExecutor({
      root,
      config,
      createInner: async (at) => ({
        execute: async () => {
          await writeFile(file, "a\n2\n");
          const v = await value(at);
          await writeFile(file, "a\n1\n");
          return { columns: [{ name: "v", type: "number" }], rows: [[v]] };
        },
        horizon: async () => ({ date: true, naive: false }),
        close: async () => {},
      }),
    });
    expect((await executor.execute(query, context)).rows).toEqual([[1]]);
    await executor.close();
    expect(await readdir(path.join(root, ".hatchmark", "tmp"))).toEqual([]);
    const reader = await createCachedExecutor({
      root,
      config,
      createInner: async () => fake({ columns: [], rows: [] }),
    });
    expect((await reader.execute(query, context)).rows).toEqual([[1]]);
    expect(reader.stats().hits).toBe(1);
    await reader.close();
  });

  it("keys on the execution context: another as-of date is a miss", async () => {
    const root = await project();
    const result: QueryResult = { columns: [{ name: "v", type: "number" }], rows: [[1]] };
    await roundTrip(root, result);
    const executor = await createCachedExecutor({
      root,
      config,
      createInner: async () => fake(result),
    });
    await executor.execute(query, { ...context, asOf: "2026-11-01" });
    await executor.execute(query, { ...context, bindings: { region: ["EMEA"] } });
    expect(executor.stats()).toMatchObject({ hits: 0, misses: 2 });
    await executor.close();
  });

  it("refuses to serve a plan made for another hatchmark.json", async () => {
    const root = await project();
    const result: QueryResult = { columns: [{ name: "v", type: "number" }], rows: [[1]] };
    await roundTrip(root, result);
    const other = { ...query, input: { type: "csv", path: "data/t.csv", delimiter: ";" } };
    const executor = await createCachedExecutor({
      root,
      config,
      createInner: async () => fake(result),
    });
    await executor.execute(other as PlannedQuery, context);
    expect(executor.stats()).toMatchObject({ hits: 0, misses: 1 });
    await executor.close();
  });
});
