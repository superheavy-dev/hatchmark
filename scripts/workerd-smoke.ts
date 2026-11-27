// Bundles the engine core for a worker and runs it in workerd (Cloudflare's open-source runtime)
// through Miniflare, as a smoke test that the modules it reaches (renderer included, which renders
// the sample dashboard page there) use only web-standard APIs; the
// core-purity unit test scans every core module statically. Exits non-zero on failure.
import assert from "node:assert/strict";
import { build } from "esbuild";
import { Miniflare } from "miniflare";

interface SmokeResult {
  sql: string;
  report: {
    format_version: string;
    error_count: number;
    diagnostics: [{ code: string; message: string; range: { start: unknown } }];
  };
  kpi: { value: unknown; current: unknown };
  human: string;
  columns: string[];
  schemaTitle: string;
  params: unknown[];
  window: unknown;
  planHash: string;
  page: string;
  svg: string;
  width: number;
}

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

const script = bundle.outputFiles?.[0]?.text;
assert.ok(script, "esbuild produced no output");

const mf = new Miniflare({
  modules: true,
  script,
  compatibilityDate: "2026-07-01",
});
try {
  const response = await mf.dispatchFetch("http://localhost/");
  const body = (await response.json()) as SmokeResult;
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
  assert.equal(body.kpi.value, 10);
  assert.equal(
    body.sql,
    'SELECT coalesce(sum("amount"), 0)\nFROM (SELECT * FROM "__hm_source_orders") AS "hm_rows"\nWHERE "ordered_at" >= CAST(\'2026-10-01\' AS DATE) AND "ordered_at" < CAST(\'2026-11-01\' AS DATE)',
  );
  assert.deepEqual(body.kpi.current, { start: "2026-10-01", end: "2026-11-01" });
  assert.equal(body.planHash, "7d575f995275f3d6263a0c2a3aab5f19358e47ea5bab49b986fef1daa02f136d");
  assert.match(body.page, /^<!doctype html>/);
  assert.match(body.page, /<h1>Sales overview<\/h1>/);
  assert.match(body.page, /Data through Oct 31, 2026/);
  assert.ok((body.page.match(/<svg /g) ?? []).length >= 14);
  assert.match(
    body.svg,
    /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" font-family="IBM Plex Sans/,
  );
  assert.match(body.svg, /stroke="#87c0ff"/);
  assert.ok(body.width > 40 && body.width < 50, `text width ${body.width}`);
  console.log(
    "workerd smoke test passed:",
    body.report.diagnostics[0].message,
    `| dashboard page ${body.page.length} bytes rendered in workerd`,
  );
} finally {
  await mf.dispose();
}
