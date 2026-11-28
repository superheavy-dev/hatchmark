import { afterAll, expect, test } from "vitest";
import { run as cli } from "../../src/cli/main.js";
import type { LineData } from "../../src/compiler/index.js";
import { PROJECT_DEFAULTS } from "../../src/spec/index.js";
import { metric, Oracle, removeProjects, run, writeProject } from "./fixture.js";

afterAll(removeProjects);

const rows = [
  ["2026-09-14T12:00:00Z", 1],
  ["2026-09-15T12:00:00Z", 2],
  ["2026-09-16T12:00:00Z", 4],
  ["2026-09-21T12:00:00Z", 8],
  ["2026-09-28T12:00:00Z", 16],
  ["2026-10-05T12:00:00Z", 32],
  ["2026-10-08T12:00:00Z", 64],
] as const;

async function build(
  range: "all_time" | { start: string; end: string },
  asOf: string,
  opts: Record<string, unknown>,
  data = rows.slice(),
) {
  const line = { type: "line", metrics: ["flow"], grain: "week" };
  const fixture = await writeProject({
    "hatchmark.yaml": {
      ...PROJECT_DEFAULTS,
      name: "Delta",
      timezone: "UTC",
      sources: { rows: { type: "csv", path: "rows.csv" } },
    },
    "dashboards/d.yaml": {
      title: "D",
      period: { range, asOf, compare: "none" },
      blocks: [
        { ...line, id: "mark", edges: opts.edges },
        { ...line, id: "changed", ...opts },
      ],
    },
    "metrics/flow.yaml": metric({
      type: "aggregate",
      table: "rows",
      aggregate: "sum",
      time: "ts",
      column: "v",
    }),
    "rows.csv": `ts,v\n${data.map(([ts, v]) => `${ts},${v}\n`).join("")}`,
  });
  const result = await run(fixture.root, fixture.project, "d");
  let out = "";
  const exit = await cli(["check", "--json", "--sql", "--cwd", fixture.root], {
    stdout: (s) => {
      out += s;
    },
    stderr: () => {},
    cwd: fixture.root,
    env: {},
    stdoutIsTTY: false,
    isAgent: async () => false,
  });
  expect(exit).toBe(0);
  return {
    blocks: result.data?.blocks as LineData[],
    runCodes: result.diagnostics.map((d) => d.code),
    checkCodes: (JSON.parse(out.trim()).diagnostics as { code: string }[]).map((d) => d.code),
  };
}

test("all-time show warns for a trailing partial flow bucket", async () => {
  const { blocks, runCodes, checkCodes } = await build("all_time", "2026-11-05", {
    incomplete: "show",
  });
  const series = blocks[0]?.series[0];
  const oracle = await Oracle.open();
  try {
    const [want] = await oracle.rows(
      `SELECT sum(v) AS v FROM (VALUES ${rows.map(([ts, v]) => `('${ts}'::TIMESTAMPTZ,${v})`).join(",")}) t(ts,v) WHERE ts >= '2026-10-05' AND ts <= '2026-10-08T12:00:00Z'`,
    );
    expect(series?.values[3]).toBe(want?.v);
  } finally {
    oracle.close();
  }
  expect(series?.partial).toEqual([
    { index: 3, elapsed: 0.5, days: 4, through: "2026-10-08T12:00:00" },
  ]);
  expect(blocks[1]?.series[0]?.values).toEqual(series?.values);
  expect(blocks[1]?.series[0]?.partial).toBeUndefined();
  expect.soft(runCodes).toContain("HM4014");
  expect.soft(checkCodes).toContain("HM4014");
});

test("clip-only partial is also the last bucket in a one-bucket flow series", async () => {
  const { blocks, runCodes, checkCodes } = await build(
    { start: "2026-09-16", end: "2026-09-21" },
    "2026-11-05",
    { edges: "clip", incomplete: "show" },
  );
  expect(blocks[0]?.axis.buckets).toEqual(["2026-09-14"]);
  expect(blocks[0]?.series[0]?.partial).toEqual([
    { index: 0, elapsed: 0.714285, edge: "start", days: 5 },
  ]);
  expect.soft(runCodes).toContain("HM4014");
  expect.soft(checkCodes).toContain("HM4014");
});

test("stale clip plus hide yields no bucket and an empty axis window", async () => {
  const { blocks } = await build(
    { start: "2026-09-16", end: "2026-11-05" },
    "2026-11-05",
    { edges: "clip", incomplete: "hide" },
    rows.slice(0, 2),
  );
  const b = blocks[1];
  expect.soft(b?.axis.buckets).toEqual([]);
  expect.soft(b?.axis.window.start).toBe(b?.axis.window.end);
});
