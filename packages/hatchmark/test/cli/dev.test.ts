import { mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dev } from "../../src/cli/commands/dev.js";
import type { CommandContext } from "../../src/cli/io.js";
import { run } from "../../src/cli/main.js";
import { type DevServer, startDevServer } from "../../src/dev/server.js";
import { copyProject, EXAMPLE } from "../node/fixture.js";

interface HmrMessage {
  type: string;
  event?: string;
  data?: {
    dashboard?: string;
    cards?: { index: number; kpi?: number; html: string }[];
    periods?: string;
    overlay?: string;
    diagnostics?: { code: string }[];
  };
}

const copyExample = () => copyProject(EXAMPLE, "hatchmark-dev-");

/** A client on Vite's HMR websocket, the connection the dev client in the page uses. */
async function connect(server: DevServer) {
  const url = new URL(server.url);
  const socket = new WebSocket(`ws://${url.host}/?token=${server.token}`, "vite-hmr");
  const messages: HmrMessage[] = [];
  const waiters: (() => void)[] = [];
  socket.addEventListener("message", (event) => {
    messages.push(JSON.parse(String(event.data)) as HmrMessage);
    for (const wake of waiters.splice(0)) wake();
  });
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve);
    socket.addEventListener("error", reject);
  });
  return {
    messages,
    clear: () => messages.splice(0),
    /** The first custom event with this name, waiting for it when needed. */
    async next(name: string, timeout = 15_000, dashboard?: string): Promise<HmrMessage> {
      const end = Date.now() + timeout;
      for (;;) {
        const found = messages.find(
          (m) =>
            m.type === "custom" &&
            m.event === name &&
            (dashboard === undefined || m.data?.dashboard === dashboard),
        );
        if (found) return found;
        if (Date.now() > end) {
          throw new Error(
            `no ${name} event; got ${JSON.stringify(messages.map((m) => m.event ?? m.type))}`,
          );
        }
        await new Promise<void>((resolve) => {
          waiters.push(resolve);
          setTimeout(resolve, 200);
        });
      }
    },
    close: () => socket.close(),
  };
}

describe("hatchmark dev", { timeout: 30_000 }, () => {
  let dir: string;
  let server: DevServer;
  let hmr: Awaited<ReturnType<typeof connect>>;
  const logs: string[] = [];
  const edit = async (file: string, change: (text: string) => string) => {
    const at = path.join(dir, file);
    await writeFile(at, change(await readFile(at, "utf8")));
  };
  const custom = () => hmr.messages.filter((m) => m.type === "custom").map((m) => m.event);

  beforeAll(async () => {
    dir = await copyExample();
    const started = await startDevServer({
      root: dir,
      port: 0,
      host: "127.0.0.1",
      log: (t) => logs.push(t),
    });
    if ("report" in started) throw new Error(JSON.stringify(started.report));
    server = started.server;
    hmr = await connect(server);
  }, 60_000);

  afterAll(async () => {
    hmr?.close();
    await server?.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("serves every dashboard as hatchmark build writes it, plus the dev client", async () => {
    const out = path.join(dir, "built");
    expect(
      await run(["build", "--cwd", dir, "--out", "built", "--no-cache", "--json"], quietIO),
    ).toBe(0);
    const index = await fetch(new URL("/", server.url));
    expect(index.status).toBe(200);
    const indexHtml = await index.text();
    expect(indexHtml).toContain('href="./sales/"');
    for (const name of ["sales", "trends"]) {
      const response = await fetch(new URL(`/${name}/`, server.url));
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain('<script type="module" src="/@vite/client"></script>');
      const built = await readFile(path.join(out, name, "index.html"), "utf8");
      const stripped = html.replace(
        /<script type="application\/json" id="hm-dev">.*?<\/script>.*?(?=<\/head>)/s,
        "",
      );
      expect(stripped).toBe(built);
    }
    const redirect = await fetch(new URL("/sales", server.url), { redirect: "manual" });
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get("location")).toBe("/sales/");
    const runtime = (await readdir(path.join(out, "_hatchmark"))).find((f) => f.endsWith(".js"));
    const asset = await fetch(new URL(`/_hatchmark/${runtime}`, server.url));
    expect(asset.status).toBe(200);
    expect(await asset.text()).toBe(
      await readFile(path.join(out, "_hatchmark", `${runtime}`), "utf8"),
    );
    const client = await fetch(new URL("/@id/virtual:hatchmark-dev-client", server.url));
    expect(client.status).toBe(200);
    const code = await client.text();
    expect(code).toContain("hatchmark:update");
    expect(code).toContain("createHotContext");
    const data = await fetch(new URL("/data/orders.csv", server.url));
    expect(data.status).not.toBe(200);
    await rm(out, { recursive: true, force: true });
    expect((await readdir(dir)).sort()).toEqual([
      "dashboards",
      "data",
      "generate.ts",
      "hatchmark.json",
      "metrics",
    ]);
  });

  it("pushes only the card whose title changed", async () => {
    hmr.clear();
    await edit("dashboards/sales.json", (t) =>
      t.replace('"Revenue by channel"', '"Revenue by sales channel"'),
    );
    const update = await hmr.next("hatchmark:update");
    expect(update.data?.dashboard).toBe("sales");
    expect(update.data?.cards).toHaveLength(1);
    expect(update.data?.cards?.[0]?.index).toBe(2);
    expect(update.data?.cards?.[0]?.html).toContain("Revenue by sales channel");
    await server.idle();
    expect(custom()).toEqual(["hatchmark:update"]);
  });

  it("picks up a second save that lands right after the first is rebuilt", async () => {
    for (const [first, second] of [
      ["Revenue by channel, draft", "Revenue by channel, final"],
      ["Revenue by channel, draft two", "Revenue by sales channel"],
    ]) {
      hmr.clear();
      await edit("dashboards/sales.json", (t) =>
        t.replace(/"Revenue by (?:sales )?channel[^"]*"/, `"${first}"`),
      );
      await hmr.next("hatchmark:update");
      hmr.clear();
      await edit("dashboards/sales.json", (t) => t.replace(`"${first}"`, `"${second}"`));
      const update = await hmr.next("hatchmark:update");
      expect(update.data?.cards?.[0]?.html).toContain(second);
      expect(await (await fetch(new URL("/sales/", server.url))).text()).toContain(second);
    }
  });

  it("pushes the KPIs and cards that show a metric whose label changed", async () => {
    hmr.clear();
    await edit("metrics/orders.json", (t) =>
      t.replace('"label": "Orders"', '"label": "Paid orders"'),
    );
    await hmr.next("hatchmark:update");
    await server.idle();
    const updates = hmr.messages.filter((m) => m.event === "hatchmark:update");
    expect(custom().every((e) => e === "hatchmark:update")).toBe(true);
    const sales = updates.find((m) => m.data?.dashboard === "sales")?.data?.cards ?? [];
    expect(sales.find((c) => c.index === 0)?.kpi).toBe(1);
    expect(sales.find((c) => c.index === 0)?.html).toContain("Paid orders");
    expect(sales.map((c) => c.index).sort()).toEqual([0, 3]);
  });

  it("re-runs the dashboards that read a data file when it changes, period data included", async () => {
    hmr.clear();
    await edit("data/orders.csv", (t) => {
      const lines = t.trimEnd().split("\n");
      const at = lines.findLastIndex((l) => l.includes(",paid,"));
      const cells = (lines[at] ?? "").split(",");
      cells[cells.length - 1] = "250000.00";
      lines[at] = cells.join(",");
      return `${lines.join("\n")}\n`;
    });
    const update = await hmr.next("hatchmark:update", 15_000, "sales");
    const explorer = await hmr.next("hatchmark:update", 15_000, "explorer");
    expect(JSON.parse(explorer.data?.periods ?? "{}").presets).toBeDefined();
    await server.idle();
    expect(custom().every((e) => e === "hatchmark:update")).toBe(true);
    const sales = hmr.messages.find(
      (m) => m.event === "hatchmark:update" && m.data?.dashboard === "sales",
    );
    expect(update).toBeDefined();
    expect(sales?.data?.cards?.some((c) => c.index === 1)).toBe(true);
  });

  it("re-runs every dashboard that reads a data file shared by several sources", async () => {
    await edit("hatchmark.json", (t) =>
      t.replace(
        '"path": "data/orders.csv"\n    }',
        '"path": "data/orders.csv"\n    },\n    "orders_alias": { "type": "csv", "path": "data/orders.csv" }',
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    await server.idle();
    hmr.clear();
    await edit("data/orders.csv", (t) => {
      const lines = t.trimEnd().split("\n");
      const at = lines.findLastIndex((l) => l.includes(",paid,"));
      const cells = (lines[at] ?? "").split(",");
      cells[cells.length - 1] = "350000.00";
      lines[at] = cells.join(",");
      return `${lines.join("\n")}\n`;
    });
    await hmr.next("hatchmark:update");
    await server.idle();
    const sales = hmr.messages.find(
      (m) => m.event === "hatchmark:update" && m.data?.dashboard === "sales",
    );
    expect(sales?.data?.cards?.some((c) => c.index === 1)).toBe(true);
  });

  it("shows check errors with their code, and clears them on the next good build", async () => {
    const good = await readFile(path.join(dir, "dashboards/sales.json"), "utf8");
    hmr.clear();
    await edit("dashboards/sales.json", (t) =>
      t.replace('"metric": "orders"', '"metric": "orderz"'),
    );
    const error = await hmr.next("hatchmark:error");
    expect(error.data?.diagnostics?.map((d) => d.code)).toContain("HM2003");
    expect(error.data?.overlay).toContain('id="hm-dev-overlay"');
    expect(error.data?.overlay).toMatch(/<span class="hm-dx-error">error\[HM2003\]<\/span>/);
    const page = await (await fetch(new URL("/sales/", server.url))).text();
    expect(page).toContain('id="hm-dev-overlay"');
    expect(logs.join("")).toContain("error[HM2003]");
    hmr.clear();
    await writeFile(path.join(dir, "dashboards/sales.json"), good);
    await hmr.next("hatchmark:ok");
    const after = await (await fetch(new URL("/sales/", server.url))).text();
    expect(after).not.toContain('id="hm-dev-overlay"');
  });

  it("shows JSON syntax errors", async () => {
    const good = await readFile(path.join(dir, "metrics/revenue.json"), "utf8");
    hmr.clear();
    await writeFile(path.join(dir, "metrics/revenue.json"), good.replace('"label"', "label"));
    const error = await hmr.next("hatchmark:error");
    expect(error.data?.diagnostics?.map((d) => d.code)).toContain("HM1002");
    hmr.clear();
    await writeFile(path.join(dir, "metrics/revenue.json"), good);
    await hmr.next("hatchmark:ok");
  });

  it("reloads the page on a structural change", async () => {
    hmr.clear();
    await edit("dashboards/sales.json", (t) =>
      t.replace('"span": 8', '"span": 6').replace(/"span": 4\n/, '"span": 6\n'),
    );
    const reload = await hmr.next("hatchmark:reload");
    expect(reload.data?.dashboard).toBe("sales");
    hmr.clear();
    await edit("dashboards/sales.json", (t) =>
      t.replace('"title": "Global sales"', '"title": "Worldwide sales"'),
    );
    expect((await hmr.next("hatchmark:reload")).data?.dashboard).toBe("sales");
    await server.idle();
    expect(custom()).toContain("hatchmark:reload");
    expect(custom()).not.toContain("hatchmark:update");
  });

  it("reloads the open pages of a removed dashboard and the index", async () => {
    hmr.clear();
    await rename(
      path.join(dir, "dashboards/trends.json"),
      path.join(dir, "dashboards/renamed.json"),
    );
    await server.idle();
    await expect
      .poll(() =>
        hmr.messages.filter((m) => m.event === "hatchmark:reload").map((m) => m.data?.dashboard),
      )
      .toEqual(expect.arrayContaining(["trends", "/"]));
    expect((await fetch(new URL("/trends/", server.url))).status).toBe(404);
    expect(await (await fetch(new URL("/", server.url))).text()).toContain('href="./renamed/"');
  });

  it("reloads an open index page when the project name changes", async () => {
    hmr.clear();
    await edit("hatchmark.json", (t) =>
      t.replace('"name": "Global Sales"', '"name": "Global Sales EU"'),
    );
    await expect
      .poll(
        () =>
          hmr.messages.filter((m) => m.event === "hatchmark:reload").map((m) => m.data?.dashboard),
        {
          timeout: 15_000,
        },
      )
      .toContain("/");
    expect(await (await fetch(new URL("/", server.url))).text()).toContain("Global Sales EU");
  });
});

const quietIO = {
  stdout: () => {},
  stderr: () => {},
  cwd: "/",
  env: {},
  stdoutIsTTY: false,
  isAgent: async () => false,
};

describe("hatchmark dev command", () => {
  it("prints one JSON line with the URL when ready, then nothing more on stdout", async () => {
    const dir = await copyExample();
    const stdout: string[] = [];
    const ctx: CommandContext = {
      io: { ...quietIO, stdout: (t) => stdout.push(t) },
      root: dir,
      mode: "json",
      color: false,
      quiet: false,
    };
    let fetched = "";
    const result = await dev(
      ctx,
      { port: "0", host: "127.0.0.1", open: false },
      {
        start: startDevServer,
        stopped: async () => {
          const ready = JSON.parse(stdout[0] ?? "{}") as { url: string };
          fetched = await (await fetch(ready.url)).text();
        },
      },
    );
    expect(result).toMatchObject({ exitCode: 0, printed: true });
    expect(stdout).toHaveLength(1);
    expect(JSON.parse(stdout[0] ?? "")).toMatchObject({ format_version: "1", ok: true });
    expect(fetched).toContain("Dashboards");
    await rm(dir, { recursive: true, force: true });
  }, 60_000);

  it("gives HM0006 and exit 3 when an explicit --port is taken", async () => {
    const dir = await copyExample();
    const first = await startDevServer({ root: dir, port: 0, host: "127.0.0.1", log: () => {} });
    if ("report" in first) throw new Error("no project");
    try {
      const port = new URL(first.server.url).port;
      const out: string[] = [];
      const err: string[] = [];
      const io = {
        ...quietIO,
        stdout: (t: string) => out.push(t),
        stderr: (t: string) => err.push(t),
      };
      const code = await run(
        ["dev", "--cwd", dir, "--port", port, "--host", "127.0.0.1", "--json"],
        io,
      );
      expect(code).toBe(3);
      expect(out).toHaveLength(1);
      expect(JSON.parse(out[0] ?? "").diagnostics[0]).toMatchObject({ code: "HM0006" });
      expect(err.join("")).not.toContain("internal error");
    } finally {
      await first.server.close();
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("rejects a bad port and a directory without hatchmark.json", async () => {
    const out: string[] = [];
    const io = { ...quietIO, stdout: (t: string) => out.push(t) };
    expect(await run(["dev", "--port", "nope", "--json"], io)).toBe(2);
    expect(JSON.parse(out[0] ?? "").diagnostics[0].code).toBe("HM0002");
    const empty = await mkdtemp(path.join(tmpdir(), "hatchmark-dev-empty-"));
    out.length = 0;
    expect(await run(["dev", "--cwd", empty, "--json"], io)).toBe(2);
    expect(JSON.parse(out[0] ?? "").ok).toBe(false);
    await rm(empty, { recursive: true, force: true });
  });

  it("lists dev in the help", async () => {
    const out: string[] = [];
    expect(await run(["--help", "--json"], { ...quietIO, stdout: (t) => out.push(t) })).toBe(0);
    expect(JSON.parse(out[0] ?? "").commands.map((c: { name: string }) => c.name)).toContain("dev");
  });
});

describe("hatchmark build output", () => {
  it("contains no Vite code, no HMR client and no dev hooks beyond the runtime's mount", async () => {
    const dir = await copyExample();
    expect(await run(["build", "--cwd", dir, "--json"], quietIO)).toBe(0);
    const out = path.join(dir, "dist");
    const files = (await readdir(out, { recursive: true, withFileTypes: true }))
      .filter((e) => e.isFile() && /\.(?:html|js|json|txt)$/.test(e.name))
      .map((e) => path.join(e.parentPath, e.name));
    expect(files.length).toBeGreaterThan(3);
    for (const file of files) {
      const text = await readFile(file, "utf8");
      expect(text, file).not.toMatch(/vite|import\.meta|__hmr|hmr|hm-dev|hatchmark:|dev-client/i);
    }
    const runtime = files.find((f) => /[/\\]hatchmark\.[0-9a-f]+\.js$/.test(f)) ?? "";
    expect(await readFile(runtime, "utf8")).toContain("window.hatchmark={mount:");
    await rm(dir, { recursive: true, force: true });
  }, 60_000);
});
