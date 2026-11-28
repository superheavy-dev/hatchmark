import { dirname } from "node:path";
import type { BenchContext } from "./target.ts";
import { run, waitUntil } from "./util.ts";

export const NETWORK = "hatchmark-bench";
export const POSTGRES = "hatchmark-bench-postgres";
export const POSTGRES_IMAGE = "postgres:17";
export const POSTGRES_PORT = 55439;

const docker = (...args: string[]) => run("docker", args).trim();

export function containerRunning(name: string): boolean {
  try {
    return docker("inspect", "--format", "{{.State.Status}}", name) === "running";
  } catch {
    return false;
  }
}

export function removeContainer(name: string): void {
  try {
    docker("rm", "--force", name);
  } catch {}
}

export const SERVER_CONTAINERS = ["hatchmark-bench-metabase", "hatchmark-bench-superset"];

export function containerPaused(name: string): boolean {
  try {
    return docker("inspect", "--format", "{{.State.Status}}", name) === "paused";
  } catch {
    return false;
  }
}

export function pauseOthers(keep: string): () => void {
  if (containerPaused(keep)) docker("unpause", keep);
  const paused = SERVER_CONTAINERS.filter((name) => name !== keep && containerRunning(name));
  for (const name of paused) docker("pause", name);
  return () => {
    for (const name of paused) docker("unpause", name);
  };
}

export function ensureNetwork(): void {
  try {
    docker("network", "inspect", NETWORK);
  } catch {
    docker("network", "create", NETWORK);
  }
}

export function startContainer(name: string, args: string[]): void {
  ensureNetwork();
  if (containerRunning(name)) return;
  removeContainer(name);
  docker("run", "--detach", "--name", name, "--network", NETWORK, ...args);
}

export function psql(sql: string): string {
  return docker(
    "exec",
    POSTGRES,
    "psql",
    "-U",
    "bench",
    "-d",
    "bench",
    "-At",
    "-v",
    "ON_ERROR_STOP=1",
    "-c",
    sql,
  );
}

export async function startPostgres(ctx: BenchContext): Promise<void> {
  startContainer(POSTGRES, [
    "--env",
    "POSTGRES_USER=bench",
    "--env",
    "POSTGRES_PASSWORD=bench",
    "--env",
    "POSTGRES_DB=bench",
    "--volume",
    `${dirname(ctx.dataFile)}:/bench-data:ro`,
    "--publish",
    `127.0.0.1:${POSTGRES_PORT}:5432`,
    POSTGRES_IMAGE,
  ]);
  await waitUntil("postgres", async () => psql("select 1") === "1", 60_000);
  const exists = psql("select to_regclass('public.orders') is not null") === "t";
  if (exists && Number(psql("select count(*) from orders")) === ctx.rows) return;
  ctx.log(`postgres: loading ${ctx.rows} rows`);
  psql(`drop table if exists orders;
create table orders (
  order_id bigint primary key,
  ordered_at timestamp not null,
  customer_id text not null,
  country text not null,
  region text not null,
  channel text not null,
  category text not null,
  status text not null,
  amount numeric(12, 2) not null
);
copy orders from '/bench-data/orders.csv' with (format csv, header true);
analyze orders;`);
}
