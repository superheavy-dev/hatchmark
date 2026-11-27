import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";
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

export async function loadAt(root: string) {
  const { project, diagnostics } = await loadProject(nodeProjectHost(root));
  if (project === undefined) throw new Error(`no project in ${root}`);
  return { root, project, diagnostics };
}

export async function removeProjects(): Promise<void> {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
}

/** Runs a dashboard with a fresh DuckDB executor. */
export async function run(root: string, project: Project, dashboard: string) {
  const config = project.config.spec;
  if (config === undefined) throw new Error("invalid hatchmark.json");
  const executor = await createDuckDbExecutor({ root, config });
  try {
    return await runDashboard(project, dashboard, executor);
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
