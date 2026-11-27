// Bundles the engine core for a worker and runs it in workerd (Cloudflare's open-source runtime)
// through Miniflare, as a smoke test that the modules it reaches use only web-standard APIs; the
// core-purity unit test scans every core module statically. Exits non-zero on failure.
import assert from "node:assert/strict";
import { build } from "esbuild";
import { Miniflare } from "miniflare";

const bundle = await build({
  entryPoints: [new URL("../packages/hatchmark/test/workerd/worker.ts", import.meta.url).pathname],
  bundle: true,
  format: "esm",
  platform: "neutral",
  mainFields: ["module", "main"],
  target: "es2023",
  write: false,
  logLevel: "error",
});

const mf = new Miniflare({
  modules: true,
  script: bundle.outputFiles[0].text,
  compatibilityDate: "2026-07-01",
});
try {
  const response = await mf.dispatchFetch("http://localhost/");
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.report.format_version, "1");
  assert.equal(body.report.error_count, 1);
  assert.equal(body.report.diagnostics[0].code, "HM2003");
  assert.deepEqual(body.report.diagnostics[0].range.start, { line: 3, column: 40 });
  assert.match(body.human, /did you mean "revenue"\?/);
  assert.deepEqual(body.columns, ["ordered_at", "region", "amount"]);
  assert.match(body.schemaTitle, /dashboard/);
  assert.deepEqual(body.params, []);
  assert.deepEqual(body.window, { kind: "bounded", start: "2026-09-01", end: "2026-10-01" });
  assert.equal(body.planHash, "b677a470c9588ffe57c77a8397b6c26fe280e46a11c07ef3220140b947f8c3b1");
  console.log("workerd smoke test passed:", body.report.diagnostics[0].message);
} finally {
  await mf.dispose();
}
