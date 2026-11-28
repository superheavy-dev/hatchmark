import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type DevServer, startDevServer } from "../../src/dev/server.js";
import { buildProject, copyProject, EXAMPLE } from "../node/fixture.js";
import { toYaml } from "../yaml.js";

interface Message {
  type: string;
  event?: string;
  data?: { dashboard?: string };
}

describe("hatchmark dev with a toggle-only key table", { timeout: 60_000 }, () => {
  let dir: string;
  let server: DevServer;
  let socket: WebSocket;
  const messages: Message[] = [];

  beforeAll(async () => {
    dir = await copyProject(EXAMPLE, "hatchmark-dev-keys-");
    const config = await readFile(path.join(dir, "hatchmark.yaml"), "utf8");
    await writeFile(
      path.join(dir, "hatchmark.yaml"),
      config.replace("sources:\n", "sources:\n  vips:\n    type: csv\n    path: data/vips.csv\n"),
    );
    await writeFile(path.join(dir, "data", "vips.csv"), "customer_id\nC00400\nC00316\n");
    await mkdir(path.join(dir, "segments"), { recursive: true });
    await writeFile(
      path.join(dir, "segments", "vip.yaml"),
      toYaml({
        label: "VIP",
        filters: [{ column: "customer_id", op: "in_table", table: "vips", key: "customer_id" }],
      }),
    );
    await writeFile(
      path.join(dir, "metrics", "vip_orders.yaml"),
      toYaml({
        label: "VIP orders",
        format: { type: "number" },
        better: "up",
        type: "aggregate",
        table: "orders",
        time: "ordered_at",
        aggregate: "count",
        filters: [{ column: "customer_id", op: "in_table", table: "vips", key: "customer_id" }],
      }),
    );
    const period = { asOf: "latest_data", range: "last_12_months", compare: "none" };
    await writeFile(
      path.join(dir, "dashboards", "toggled.yaml"),
      toYaml({
        title: "Toggled",
        period,
        filters: [{ type: "segment", id: "who", segments: ["vip"], default: ["vip"] }],
        blocks: [{ type: "kpi", metric: "orders" }],
      }),
    );
    await writeFile(
      path.join(dir, "dashboards", "metered.yaml"),
      toYaml({ title: "Metered", period, blocks: [{ type: "kpi", metric: "vip_orders" }] }),
    );
    const started = await startDevServer({ root: dir, port: 0, host: "127.0.0.1", log: () => {} });
    if ("report" in started) throw new Error(JSON.stringify(started.report));
    server = started.server;
    const url = new URL(server.url);
    socket = new WebSocket("ws://" + url.host + "/?token=" + server.token, "vite-hmr");
    socket.addEventListener("message", (e) => messages.push(JSON.parse(String(e.data)) as Message));
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve);
      socket.addEventListener("error", reject);
    });
    await server.idle();
  }, 60_000);

  afterAll(async () => {
    socket?.close();
    await server?.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("re-runs the dashboards whose key table changed", async () => {
    messages.splice(0);
    await writeFile(
      path.join(dir, "data", "vips.csv"),
      "customer_id\nC00017\nC00123\nC00250\nC00400\n",
    );
    const end = Date.now() + 15_000;
    const updated = () =>
      new Set(
        messages
          .filter((m) => m.event === "hatchmark:update" || m.event === "hatchmark:reload")
          .map((m) => m.data?.dashboard),
      );
    while (Date.now() < end && !(updated().has("toggled") && updated().has("metered")))
      await new Promise((r) => setTimeout(r, 250));
    await server.idle();
    const kpis = (html: string) =>
      [...html.matchAll(/class="hm-kpi-value[^"]*"[^>]*>([^<]*)</g)].map((m) => m[1]);
    const live = {
      toggled: kpis(await (await fetch(new URL("/toggled/", server.url))).text()),
      metered: kpis(await (await fetch(new URL("/metered/", server.url))).text()),
    };
    expect((await buildProject(dir)).code).toBe(0);
    const built = {
      toggled: kpis(await readFile(path.join(dir, "dist", "toggled", "index.html"), "utf8")),
      metered: kpis(await readFile(path.join(dir, "dist", "metered", "index.html"), "utf8")),
    };
    expect({ updated: [...updated()].sort(), live }).toEqual({
      updated: ["metered", "toggled"],
      live: built,
    });
  });
});
