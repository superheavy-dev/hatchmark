import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";
import { run as cli } from "../../src/cli/main.js";
import { runDashboard } from "../../src/compiler/index.js";
import { createDuckDbExecutor, nodeProjectHost } from "../../src/node/index.js";
import { loadProject, type Project } from "../../src/spec/index.js";

const roots: string[] = [];

/** Writes a project into a fresh temporary directory and loads it with the Node host. */
export async function writeProject(files: Record<string, unknown>): Promise<{
  root: string;
  project: Project;
  diagnostics: Awaited<ReturnType<typeof loadProject>>["diagnostics"];
}> {
  const root = await mkdtemp(path.join(tmpdir(), "hatchmark-duckdb-"));
  roots.push(root);
  for (const [file, content] of Object.entries(files)) {
    const target = path.join(root, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(
      target,
      typeof content === "string" ? content : JSON.stringify(content, null, 2),
    );
  }
  return loadAt(root);
}

export const EXAMPLE = fileURLToPath(new URL("../../examples/global-sales/", import.meta.url));

const LEFT_OUT = new Set([".hatchmark", "dist"]);

/**
 * Copies a project into a fresh temporary directory named after prefix, without its build cache or
 * build output, and returns the copy. The caller removes it.
 */
export async function copyProject(from: string, prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  await cp(from, root, {
    recursive: true,
    filter: (src) => !LEFT_OUT.has(path.relative(from, src).split(path.sep)[0] ?? ""),
  });
  return root;
}

/**
 * Copies examples/global-sales into a fresh temporary directory, with hatchmark.json merged with
 * config (undefined drops a key) and its dashboards replaced by the given ones.
 */
export async function writeExample(
  config: Record<string, unknown>,
  dashboards: Record<string, unknown>,
): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "hatchmark-example-"));
  roots.push(root);
  await cp(EXAMPLE, root, { recursive: true });
  await rm(path.join(root, "dashboards"), { recursive: true, force: true });
  await rm(path.join(root, "dist"), { recursive: true, force: true });
  await mkdir(path.join(root, "dashboards"));
  const base = JSON.parse(await readFile(path.join(EXAMPLE, "hatchmark.json"), "utf8"));
  await writeFile(path.join(root, "hatchmark.json"), JSON.stringify({ ...base, ...config }));
  for (const [name, d] of Object.entries(dashboards)) {
    await writeFile(path.join(root, "dashboards", `${name}.json`), JSON.stringify(d, null, 2));
  }
  return root;
}

/** Runs hatchmark build --json in process and returns its exit code and report. */
export async function buildProject(root: string): Promise<{ code: number; report: unknown }> {
  let stdout = "";
  const code = await cli(["build", "--json", "--cwd", root], {
    stdout: (t) => {
      stdout += t;
    },
    stderr: () => {},
    cwd: root,
    env: {},
    stdoutIsTTY: false,
    isAgent: async () => false,
  });
  return { code, report: JSON.parse(stdout.trim().split("\n").pop() ?? "null") };
}

export async function loadAt(root: string) {
  const { project, diagnostics } = await loadProject(nodeProjectHost(root));
  if (project === undefined) throw new Error(`no project in ${root}`);
  return { root, project, diagnostics };
}

export async function removeProjects(): Promise<void> {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
}

/** Runs a dashboard with a fresh DuckDB executor. */
export async function run(
  root: string,
  project: Project,
  dashboard: string,
  options: { threads?: number; now?: Date } = {},
) {
  const config = project.config.spec;
  if (config === undefined) throw new Error("invalid hatchmark.json");
  const { now, ...rest } = options;
  const executor = await createDuckDbExecutor({ root, config, ...rest });
  try {
    return await runDashboard(project, dashboard, executor, now);
  } finally {
    await executor.close();
  }
}

/**
 * The independent oracle: plain SQL written in the tests, run on its own DuckDB database, never
 * through the planner or the executor's SQL builder.
 */
export class Oracle {
  private constructor(private readonly connection: DuckDBConnection) {}

  static async open(): Promise<Oracle> {
    const connection = await (await DuckDBInstance.create(":memory:")).connect();
    await connection.run("SET TimeZone = 'UTC'");
    return new Oracle(connection);
  }

  async rows(sql: string): Promise<Record<string, unknown>[]> {
    const reader = await this.connection.runAndReadAll(sql);
    return reader
      .getRowObjects()
      .map((row) =>
        Object.fromEntries(
          Object.entries(row).map(([k, v]) => [k, typeof v === "bigint" ? Number(v) : v]),
        ),
      );
  }

  async run(sql: string): Promise<void> {
    await this.connection.run(sql);
  }

  close(): void {
    this.connection.closeSync();
  }
}

/** Metric file content with the boilerplate filled in. */
export function metric(body: Record<string, unknown>, format: unknown = { type: "number" }) {
  return { label: "Metric", format, better: "up", ...body };
}
