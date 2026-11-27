import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { KpiData } from "../../src/compiler/index.js";
import { formatInstant, fromLocal, parseInstant } from "../../src/compiler/instants.js";
import { exactBound } from "../../src/compiler/windows.js";
import { PROJECT_DEFAULTS } from "../../src/spec/index.js";
import { metric, Oracle, removeProjects, run, writeProject } from "./fixture.js";

const FULL = process.env.HM_SWEEP === "full";

let oracle: Oracle;
beforeAll(async () => {
  oracle = await Oracle.open();
});
afterAll(async () => {
  oracle.close();
  await removeProjects();
});

const MIDNIGHT_ZONES: [string, number][] = [
  ["America/Havana", 2024],
  ["Atlantic/Azores", 2024],
  ["America/Santiago", 2024],
  ["America/Asuncion", 2024],
  ["Asia/Beirut", 2024],
  ["Asia/Gaza", 2024],
  ["America/Scoresbysund", 2024],
];

const instantOf = (bound: string, zone: string) =>
  bound.endsWith("Z") ? parseInstant(bound) : fromLocal(parseInstant(bound), zone);

describe("a window bound resolves once, to the instant UTC SQL gives it", () => {
  it.each(MIDNIGHT_ZONES)("every date and transition-day instant of %s, %i", async (zone, year) => {
    const dates: string[] = [];
    for (let t = Date.UTC(year, 0, 1); t < Date.UTC(year + 1, 0, 1); t += 86_400_000) {
      dates.push(new Date(t).toISOString().slice(0, 10));
    }
    const rows = await oracle.rows(
      `SELECT d, epoch_us(timezone('${zone}', CAST(d AS TIMESTAMP))) AS us FROM (VALUES ${dates
        .map((d) => `('${d}')`)
        .join(",")}) t(d) ORDER BY d`,
    );
    const wrong = rows.flatMap((r) => {
      const date = r.d as string;
      const once = exactBound(date, zone);
      const twice = exactBound(once, zone);
      const sql = formatInstant(BigInt(r.us as number));
      return twice === once && formatInstant(instantOf(once, zone)) === sql
        ? []
        : [[date, once, twice, sql]];
    });
    expect(wrong).toEqual([]);
    const instants = rows.flatMap((r) => {
      const us = BigInt(r.us as number);
      return [-90, -60, -30, 0, 30, 60, 90].map((m) => formatInstant(us + BigInt(m) * 60_000_000n));
    });
    expect(instants.filter((i) => exactBound(i, zone) !== i)).toEqual([]);
  });
});

const REPEATED: [string, string][] = [
  ["America/Havana", "2024-11-03"],
  ["Atlantic/Azores", "2024-10-27"],
];
const OFFSETS = FULL
  ? Array.from({ length: 25 }, (_, i) => (i - 6) * 10)
  : [-10, 0, 10, 30, 60, 70, 720];

describe("to-date KPIs at a repeated midnight match UTC SQL, with no value when the window is empty", () => {
  it.each(REPEATED)("%s around %s", async (zone, day) => {
    const [first] = await oracle.rows(
      `SELECT epoch_us(timezone('${zone}', TIMESTAMP '${day} 00:00:00') - INTERVAL 1 HOUR) AS us FROM range(1)`,
    );
    const firstMidnight = BigInt(first?.us as number);
    const wrong: unknown[] = [];
    const before = new Date(Date.parse(`${day}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
    for (const offset of OFFSETS) {
      const horizon = firstMidnight + BigInt(offset) * 60_000_000n;
      const data: bigint[] = [];
      for (let t = firstMidnight - 86_400_000_000n; t < horizon - 1n; t += 600_000_000n)
        data.push(t);
      data.push(horizon - 1n);
      const csv = `at,v\n${data.map((t) => `${formatInstant(t)},1`).join("\n")}\n`;
      for (const asOf of [before, day]) {
        for (const range of [{ to_date: "day" }, "year_to_date"]) {
          const fixture = await writeProject({
            "hatchmark.yaml": {
              ...PROJECT_DEFAULTS,
              name: "Midnights",
              timezone: zone,
              sources: { orders: { type: "csv", path: "orders.csv" } },
            },
            "orders.csv": csv,
            "metrics/orders.yaml": metric({
              type: "aggregate",
              table: "orders",
              aggregate: "sum",
              column: "v",
              time: "at",
            }),
            "dashboards/d.yaml": {
              title: "D",
              period: { asOf, range, compare: "none" },
              blocks: [{ type: "kpi", id: "orders", metric: "orders" }],
            },
          });
          const { data: built } = await run(fixture.root, fixture.project, "d");
          const kpi = built?.blocks.find((b) => b.id === "orders") as KpiData | undefined;
          const from = range === "year_to_date" ? `${day.slice(0, 4)}-01-01` : asOf;
          const [sql] = await oracle.rows(
            `WITH b AS (SELECT timezone('${zone}', CAST('${from}' AS TIMESTAMP)) AS s,
               least(timezone('${zone}', CAST('${asOf}' AS TIMESTAMP) + INTERVAL 1 DAY), make_timestamptz(${horizon})) AS e)
             SELECT CASE WHEN e <= s THEN NULL ELSE (SELECT count(*) FROM (VALUES ${data
               .map((t) => `(make_timestamptz(${t}))`)
               .join(",")}) r(ts) WHERE ts >= s AND ts < e) END AS v FROM b`,
          );
          const want = sql?.v === null || sql?.v === undefined ? null : Number(sql.v);
          if ((kpi === undefined ? "missing" : kpi.value) !== want)
            wrong.push([offset, asOf, range, kpi?.value, want]);
        }
      }
    }
    expect(wrong).toEqual([]);
  });
});
