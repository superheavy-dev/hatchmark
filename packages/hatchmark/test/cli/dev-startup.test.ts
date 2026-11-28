import { EventEmitter } from "node:events";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { dev } from "../../src/cli/commands/dev.js";
import { startDevServer, waitForWatcher } from "../../src/dev/server.js";
import { copyProject, EXAMPLE } from "../node/fixture.js";

const dirs: string[] = [];
afterAll(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

it("sees an edit made right after startup, even when the initial file scan is slow", async () => {
  const dir = await copyProject(EXAMPLE, "hatchmark-dev-startup-");
  dirs.push(dir);
  for (let d = 0; d < 200; d++) {
    const sub = path.join(dir, "notes", String(d));
    await mkdir(sub, { recursive: true });
    await Promise.all(
      Array.from({ length: 50 }, (_, i) => writeFile(path.join(sub, `${i}.txt`), "x")),
    );
  }
  const good = await readFile(path.join(dir, "hatchmark.yaml"), "utf8");
  const errors: string[] = [];
  const started = await startDevServer({
    root: dir,
    port: 0,
    host: "127.0.0.1",
    log: () => {},
    onEvent: (e) => {
      if (e.event === "hatchmark:error") errors.push(...e.data.diagnostics.map((d) => d.code));
    },
  });
  if ("report" in started) throw new Error(JSON.stringify(started.report));
  try {
    await writeFile(
      path.join(dir, "hatchmark.yaml"),
      good.replace("telemetry: false", 'telemetry: "no"'),
    );
    await expect.poll(() => errors, { timeout: 8_000 }).toContain("HM3003");
  } finally {
    await started.server.close();
  }
}, 60_000);

describe("waiting for the file watcher", () => {
  it("resolves on ready and removes its listeners", async () => {
    const watcher = new EventEmitter();
    const waiting = waitForWatcher(watcher, 5_000);
    watcher.emit("ready");
    await expect(waiting).resolves.toBeUndefined();
    expect(watcher.listenerCount("ready") + watcher.listenerCount("error")).toBe(0);
  });

  it("resolves at once for a watcher that is already ready", async () => {
    const watcher = Object.assign(new EventEmitter(), { _readyEmitted: true });
    await expect(waitForWatcher(watcher, 5_000)).resolves.toBeUndefined();
    expect(watcher.listenerCount("ready")).toBe(0);
  });

  it("rejects with the first scan error when ready never comes, and removes its listeners", async () => {
    const watcher = new EventEmitter();
    const waiting = waitForWatcher(watcher, 20);
    watcher.emit(
      "error",
      Object.assign(new Error("EIO: i/o error, scandir 'notes'"), { code: "EIO" }),
    );
    watcher.emit("error", new Error("a later error"));
    await expect(waiting).rejects.toMatchObject({
      code: "EWATCH",
      message:
        "the file watcher did not finish scanning the project within 0.02 s: EIO: i/o error, scandir 'notes'",
    });
    expect(watcher.listenerCount("ready") + watcher.listenerCount("error")).toBe(0);
  });

  it("makes hatchmark dev fail with HM0007 and exit 3 instead of hanging", async () => {
    const out: string[] = [];
    const result = await dev(
      {
        io: {
          stdout: (t) => out.push(t),
          stderr: () => {},
          cwd: "/",
          env: {},
          stdoutIsTTY: false,
          isAgent: async () => false,
        },
        root: ".",
        mode: "json",
        color: false,
        quiet: false,
      },
      { open: false },
      {
        start: async () => {
          await waitForWatcher(new EventEmitter(), 20);
          throw new Error("unreachable");
        },
        stopped: async () => {},
      },
    );
    expect(result).toMatchObject({ exitCode: 3 });
    expect(JSON.stringify(result)).toContain("HM0007");
    expect(out).toEqual([]);
  });
});
