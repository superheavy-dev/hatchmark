import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { run as cli } from "../../src/cli/main.js";
import type { MapData } from "../../src/compiler/dashboard-data.js";
import { PROJECT_DEFAULTS } from "../../src/spec/index.js";
import { metric, Oracle, removeProjects, run, writeProject } from "./fixture.js";

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const SPELLINGS: Record<string, string[]> = {
  CA: ["CA", "California", "california", "06", "6", "Calif."],
  TX: ["TX", "Texas", "tx", "48"],
  NY: ["NY", "New York", "new york", "36"],
  WA: ["WA", "Washington", "53"],
  DC: ["DC", "District of Columbia", "Washington DC", "11"],
  PR: ["PR", "Puerto Rico", "72"],
};
const NOT_DRAWN = ["GU", "Guam", "VI"];
const UNMATCHED = ["Narnia", "Atlantis", "-06", "-6.0", " -06 ", "+6"];
const WINDOW = "d BETWEEN DATE '2026-06-01' AND DATE '2026-06-30'";

const pad = (n: number) => String(n).padStart(2, "0");

function csv(): string {
  const rand = rng(115);
  const keys = [...Object.values(SPELLINGS).flat(), ...NOT_DRAWN, ...UNMATCHED, ""];
  const lines = ["d,state,amount,customer"];
  for (let i = 0; i < 1200; i++) {
    const month = rand() < 0.15 ? 5 : 6;
    const day = 1 + Math.floor(rand() * 30);
    const key = keys[Math.floor(rand() * keys.length)] as string;
    const amount = (Math.round(rand() * 400) / 4).toFixed(2);
    lines.push(`2026-${pad(month)}-${pad(day)},${key},${amount},c${Math.floor(rand() * 60)}`);
  }
  return lines.join("\n");
}

const ORACLE_KEYS = Object.entries(SPELLINGS)
  .flatMap(([id, keys]) => keys.map((k) => `('${k}', '${id}')`))
  .join(",");

const ORACLE: [string, string][] = [
  ["sum", "SUM(amount)"],
  ["distinct", "COUNT(DISTINCT customer)"],
  ["ratio", "SUM(amount) / COUNT(DISTINCT customer)"],
];

describe("map numbers against plain SQL", () => {
  let db: Oracle | undefined;
  let maps: Record<string, MapData> = {};

  const rows = (sql: string) => (db as Oracle).rows(sql);

  beforeAll(async () => {
    const file = csv();
    const { root, project } = await writeProject({
      "hatchmark.yaml": {
        ...PROJECT_DEFAULTS,
        name: "Maps",
        sources: { s: { type: "csv", path: "s.csv" } },
      },
      "s.csv": file,
      "metrics/revenue.yaml": metric({
        type: "aggregate",
        table: "s",
        time: "d",
        aggregate: "sum",
        column: "amount",
      }),
      "metrics/customers.yaml": metric({
        type: "aggregate",
        table: "s",
        time: "d",
        aggregate: "count_distinct",
        column: "customer",
      }),
      "metrics/rpc.yaml": metric({ type: "ratio", numerator: "revenue", denominator: "customers" }),
      "dashboards/m.yaml": {
        title: "Maps",
        period: { asOf: "2026-06-30", range: "month_to_date", compare: "none" },
        blocks: [
          { type: "map", id: "sum", geo: "us-states", region: "state", value: "revenue" },
          { type: "map", id: "ratio", geo: "us-states", region: "state", value: "rpc" },
          { type: "map", id: "distinct", geo: "us-states", region: "state", value: "customers" },
        ],
      },
    });
    const out = await run(root, project, "m");
    if (out.data === undefined) throw new Error(JSON.stringify(out.diagnostics));
    maps = Object.fromEntries(
      out.data.blocks.filter((b): b is MapData => b.type === "map").map((b) => [b.id, b]),
    );
    db = await Oracle.open();
    const values = file
      .split("\n")
      .slice(1)
      .map((l) => {
        const [d, state, amount, customer] = l.split(",");
        const key = state === "" ? "NULL" : `'${state}'`;
        return `(DATE '${d}', ${key}, ${amount}, '${customer}')`;
      });
    await db.run("CREATE TABLE s (d DATE, state VARCHAR, amount DOUBLE, customer VARCHAR)");
    await db.run(`INSERT INTO s VALUES ${values.join(",")}`);
    await db.run("CREATE TABLE k (key VARCHAR, id VARCHAR)");
    await db.run(`INSERT INTO k VALUES ${ORACLE_KEYS}`);
    await db.run(
      `CREATE VIEW m AS SELECT s.*, k.id FROM s JOIN k ON s.state = k.key WHERE ${WINDOW}`,
    );
  });

  afterAll(async () => {
    db?.close();
    await removeProjects();
  });

  it.each(ORACLE)(
    "%s: every region is computed once over all of its spellings",
    async (id, expr) => {
      const map = maps[id] as MapData;
      const expected = Object.fromEntries(
        (await rows(`SELECT id, ${expr} AS v FROM m GROUP BY id`)).map((r) => [r.id, Number(r.v)]),
      );
      expect(map.regions.map((r) => r.id).sort()).toEqual(Object.keys(expected).sort());
      for (const r of map.regions)
        expect(Number(r.value), r.id).toBeCloseTo(expected[r.id] as number, 9);
    },
  );

  it.each(ORACLE)("%s: the total covers matched, drawn rows only", async (id, expr) => {
    const [total] = await rows(`SELECT ${expr} AS v FROM m`);
    expect(Number((maps[id] as MapData).total)).toBeCloseTo(Number(total?.v), 9);
  });

  it("a distinct count is not the sum of its regions and has no shares", () => {
    const map = maps.distinct as MapData;
    const summed = map.regions.reduce((t, r) => t + Number(r.value), 0);
    expect(Number(map.total)).toBeLessThan(summed);
    expect(map.additive).toBe(false);
    expect(map.regions.every((r) => r.share === undefined)).toBe(true);
  });

  it("shares of an additive metric add up to one", () => {
    const map = maps.sum as MapData;
    expect(map.additive).toBe(true);
    expect(map.regions.reduce((t, r) => t + (r.share ?? 0), 0)).toBeCloseTo(1, 9);
  });

  it("ranks run from the highest value, ties sharing a rank", () => {
    const regions = (maps.sum as MapData).regions;
    for (const r of regions)
      expect(r.rank, r.id).toBe(
        regions.filter((o) => Number(o.value) > Number(r.value)).length + 1,
      );
  });

  it("regions without rows and regions the map does not draw are not reported", () => {
    const ids = new Set((maps.sum as MapData).regions.map((r) => r.id));
    for (const id of ["FL", "GU", "VI"]) expect(ids.has(id), id).toBe(false);
  });

  it("the match report lists every value in the window with its rows and region", async () => {
    const map = maps.sum as MapData;
    const counts = await rows(`SELECT state, COUNT(*) AS n FROM s WHERE ${WINDOW} GROUP BY state`);
    const reported = new Map(map.match.map((m) => [m.key === null ? null : String(m.key), m]));
    expect(reported.size).toBe(counts.length);
    for (const c of counts) {
      const key = c.state === null ? null : String(c.state);
      const m = reported.get(key);
      expect(m?.rows, String(key)).toBe(c.n);
      const id = Object.entries(SPELLINGS).find(([, keys]) => keys.includes(String(key)))?.[0];
      expect(m?.region, String(key)).toBe(id ?? null);
    }
  });
});

describe("map match report across sources", () => {
  afterAll(removeProjects);

  it("counts the rows of every source a ratio reads", async () => {
    const { root, project } = await writeProject({
      "hatchmark.yaml": {
        ...PROJECT_DEFAULTS,
        name: "Sources",
        sources: {
          orders: { type: "csv", path: "orders.csv" },
          visits: { type: "csv", path: "visits.csv" },
        },
      },
      "orders.csv": ["d,state", "2026-06-02,CA", "2026-06-03,California", "2026-06-04,TX"].join(
        "\n",
      ),
      "visits.csv": [
        "d,state,n",
        "2026-06-02,CA,10",
        "2026-06-03,Atlantis,4",
        "2026-06-04,Atlantis,6",
        "2026-06-04,TX,8",
      ].join("\n"),
      "metrics/orders.yaml": metric({
        type: "aggregate",
        table: "orders",
        time: "d",
        aggregate: "count",
      }),
      "metrics/visits.yaml": metric({
        type: "aggregate",
        table: "visits",
        time: "d",
        aggregate: "sum",
        column: "n",
      }),
      "metrics/conversion.yaml": metric({
        type: "ratio",
        numerator: "orders",
        denominator: "visits",
      }),
      "dashboards/m.yaml": {
        title: "Sources",
        period: { asOf: "2026-06-30", range: "month_to_date", compare: "none" },
        blocks: [{ type: "map", id: "c", geo: "us-states", region: "state", value: "conversion" }],
      },
    });
    const out = await run(root, project, "m");
    const map = out.data?.blocks[0] as MapData;
    const rows = Object.fromEntries(map.match.map((m) => [String(m.key), [m.rows, m.region]]));
    expect(rows).toEqual({
      CA: [2, "CA"],
      California: [1, "CA"],
      TX: [2, "TX"],
      Atlantis: [2, null],
    });
  });
});

describe("map match report for filtered and same-source metrics", () => {
  afterAll(removeProjects);

  it("counts each source row once, after the metric's own filters", async () => {
    const { root, project } = await writeProject({
      "hatchmark.yaml": {
        ...PROJECT_DEFAULTS,
        name: "Shapes",
        sources: { o: { type: "csv", path: "o.csv" } },
      },
      "o.csv": [
        "d,shipped,state,amount,status",
        "2026-06-02,2026-06-02,CA,10,paid",
        "2026-06-03,2026-06-03,California,20,refunded",
        "2026-06-04,2026-06-04,CA,5,paid",
        "2026-06-05,2026-06-05,TX,7,paid",
        "2026-06-06,2026-06-06,Atlantis,3,refunded",
        "2026-06-07,2026-06-07,Atlantis,4,paid",
      ].join("\n"),
      "metrics/net.yaml": metric({
        type: "sql",
        table: "o",
        time: "d",
        sql: "sum(amount)",
        additive: true,
        filters: [{ column: "status", op: "eq", value: "paid" }],
      }),
      "metrics/placed.yaml": metric({
        type: "aggregate",
        table: "o",
        time: "d",
        aggregate: "count",
      }),
      "metrics/shipped.yaml": metric({
        type: "aggregate",
        table: "o",
        time: "shipped",
        aggregate: "count",
      }),
      "metrics/ship_rate.yaml": metric({
        type: "ratio",
        numerator: "shipped",
        denominator: "placed",
      }),
      "dashboards/m.yaml": {
        title: "Shapes",
        period: { asOf: "2026-06-30", range: "month_to_date", compare: "none" },
        blocks: [
          { type: "map", id: "net", geo: "us-states", region: "state", value: "net" },
          { type: "map", id: "rate", geo: "us-states", region: "state", value: "ship_rate" },
        ],
      },
    });
    const maps = ((await run(root, project, "m")).data?.blocks ?? []) as MapData[];
    const rows = (i: number) =>
      Object.fromEntries(
        (maps[i] as MapData).match.map((m) => [String(m.key), [m.rows, m.region]]),
      );
    expect(rows(0)).toEqual({ CA: [2, "CA"], TX: [1, "TX"], Atlantis: [1, null] });
    expect(rows(1)).toEqual({
      CA: [2, "CA"],
      California: [1, "CA"],
      TX: [1, "TX"],
      Atlantis: [2, null],
    });
    let stdout = "";
    const code = await cli(["check", "--json", "--cwd", root], {
      stdout: (t) => {
        stdout += t;
      },
      stderr: () => {},
      cwd: root,
      env: {},
      stdoutIsTTY: false,
      isAgent: async () => false,
    });
    const report = JSON.parse(stdout) as { diagnostics: { code: string; severity: string }[] };
    expect(report.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(code).toBe(0);
  });
});

describe("map ranks, classes and region filters", () => {
  afterAll(removeProjects);

  const project = (filters: unknown[] = []) =>
    writeProject({
      "hatchmark.yaml": {
        ...PROJECT_DEFAULTS,
        name: "Ties",
        sources: { s: { type: "csv", path: "s.csv" } },
      },
      "s.csv": [
        "d,state",
        "2026-06-02,TX",
        "2026-06-03,Texas",
        "2026-06-04,48",
        "2026-06-02,CA",
        "2026-06-03,California",
        "2026-06-02,NY",
        "2026-06-05,36",
        "2026-06-06,WA",
      ].join("\n"),
      "metrics/orders.yaml": metric({
        type: "aggregate",
        table: "s",
        time: "d",
        aggregate: "count",
      }),
      "dashboards/m.yaml": {
        title: "Ties",
        period: { asOf: "2026-06-30", range: "month_to_date", compare: "none" },
        filters,
        blocks: [
          {
            type: "map",
            id: "m",
            geo: "us-states",
            region: "state",
            value: "orders",
            scale: { type: "threshold", breaks: [2, 3] },
          },
        ],
      },
    });
  const regions = async (filters?: unknown[]) => {
    const { root, project: p } = await project(filters);
    const map = (await run(root, p, "m")).data?.blocks[0] as MapData;
    return Object.fromEntries(map.regions.map((r) => [r.id, [r.value, r.rank, r.class]]));
  };

  it("tied regions share a rank and the next rank skips, and a value on a break takes the class above", async () => {
    expect(await regions()).toEqual({
      TX: [3, 1, 2],
      CA: [2, 2, 1],
      NY: [2, 2, 1],
      WA: [1, 4, 0],
    });
  });

  it("a select filter on the region column keeps every spelling of the picked region", async () => {
    const filter = { type: "select", id: "state", column: "state", multiple: true };
    expect(await regions([{ ...filter, default: ["Texas", "New York"] }])).toEqual({
      TX: [3, 1, 2],
      NY: [2, 2, 1],
    });
    expect(await regions([{ ...filter, default: ["Narnia"] }])).toEqual({});
  });

  it("matches a region filter exactly when maps of two geographies share its column, in any block order", async () => {
    const us = { type: "map", id: "us", geo: "us-states", region: "state", value: "orders" };
    const world = {
      type: "map",
      id: "world",
      geo: "world-countries",
      region: "state",
      value: "orders",
    };
    const read = async (blocks: unknown[]) => {
      const { root, project: p } = await writeProject({
        "hatchmark.yaml": {
          ...PROJECT_DEFAULTS,
          name: "Mixed",
          sources: { s: { type: "csv", path: "s.csv" } },
        },
        "s.csv": ["d,state", "2026-06-02,CA", "2026-06-03,California", "2026-06-04,Canada"].join(
          "\n",
        ),
        "metrics/orders.yaml": metric({
          type: "aggregate",
          table: "s",
          time: "d",
          aggregate: "count",
        }),
        "dashboards/m.yaml": {
          title: "Mixed",
          period: { asOf: "2026-06-30", range: "month_to_date", compare: "none" },
          filters: [{ type: "select", id: "state", column: "state", default: "CA" }],
          blocks,
        },
      });
      const maps = ((await run(root, p, "m")).data?.blocks ?? []) as MapData[];
      return Object.fromEntries(maps.map((b) => [b.id, b.regions.map((r) => [r.id, r.value])]));
    };
    const expected = { us: [["CA", 1]], world: [["CAN", 1]] };
    expect(await read([us, world])).toEqual(expected);
    expect(await read([world, us])).toEqual(expected);
  });
});

describe("hatchmark check on a map block", () => {
  afterAll(removeProjects);

  it("reports why a map could not be read instead of passing", async () => {
    const { root } = await writeProject({
      "hatchmark.yaml": {
        ...PROJECT_DEFAULTS,
        name: "Check",
        sources: { s: { type: "csv", path: "s.csv" } },
      },
      "s.csv": ["d,state,amount", "2026-06-02,CA,10"].join("\n"),
      "metrics/revenue.yaml": metric({
        type: "aggregate",
        table: "s",
        time: "d",
        aggregate: "sum",
        column: "amount",
      }),
      "dashboards/wrong.yaml": {
        title: "Wrong",
        period: { asOf: "2026-06-30", range: "month_to_date", compare: "none" },
        blocks: [
          { type: "map", id: "m", geo: "us-states", region: "state_typo", value: "revenue" },
        ],
      },
    });
    let stdout = "";
    const code = await cli(["check", "dashboards/wrong.yaml", "--json", "--cwd", root], {
      stdout: (t) => {
        stdout += t;
      },
      stderr: () => {},
      cwd: root,
      env: {},
      stdoutIsTTY: false,
      isAgent: async () => false,
    });
    const report = JSON.parse(stdout) as { ok: boolean; diagnostics: { severity: string }[] };
    expect(code).not.toBe(0);
    expect(report.ok).toBe(false);
    expect(report.diagnostics.some((d) => d.severity === "error")).toBe(true);
  });
});
