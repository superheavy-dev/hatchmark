import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, expect, it } from "vitest";
import { startDevServer } from "../../src/dev/server.js";
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
