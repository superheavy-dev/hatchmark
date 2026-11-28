import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { KpiData, MapData, SegmentData } from "../../src/compiler/index.js";
import { checkReferences, PROJECT_DEFAULTS } from "../../src/spec/index.js";
import { buildProject, loadAt, metric, Oracle, removeProjects, writeProject } from "./fixture.js";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

let oracle: Oracle;
beforeAll(async () => {
  oracle = await Oracle.open();
});
afterAll(async () => {
  oracle?.close();
  await removeProjects();
});

const quote = (s: string) => "'" + s.replaceAll("'", "''") + "'";
type Diag = { code: string; severity: string; pointer?: string; file?: string; message: string };
const inT = (column: string, table: string, key: string) => ({
  column,
  op: "in_table",
  table,
  key,
});
const notT = (column: string, table: string, key: string) => ({
  column,
  op: "not_in_table",
  table,
  key,
});
const PERIOD = {
  asOf: "2026-03-31",
  range: { start: "2026-01-01", end: "2026-03-31" },
  compare: "none",
};

interface Options {
  sessionsCustomer?: "VARCHAR" | "BIGINT";
  segments: Record<string, unknown[]>;
  dashboards: Record<string, { filters: unknown[]; blocks: unknown[] }>;
  extraSources?: Record<string, unknown>;
}

async function project(o: Options): Promise<string> {
  const base = { type: "aggregate", time: "at" };
  const { root } = await writeProject({
    "hatchmark.yaml": {
      ...PROJECT_DEFAULTS,
      name: "keys-edges",
      sources: {
        orders: { type: "parquet", path: "data/orders.parquet" },
        sessions: { type: "parquet", path: "data/sessions.parquet" },
        vips: { type: "parquet", path: "data/vips.parquet" },
        accounts: { type: "parquet", path: "data/accounts.parquet" },
        vipx: {
          type: "lookup",
          from: "vips",
          lookups: [{ table: "accounts", key: { no: "no" } }],
        },
        ...(o.extraSources ?? {}),
      },
    },
    ...Object.fromEntries(
      Object.entries(o.segments).map(([n, filters]) => [
        "segments/" + n + ".yaml",
        { label: n, filters },
      ]),
    ),
    "metrics/orders.yaml": metric({ ...base, table: "orders", aggregate: "count" }),
    "metrics/revenue.yaml": metric({
      ...base,
      table: "orders",
      aggregate: "sum",
      column: "amount",
    }),
    "metrics/sessions.yaml": metric({ ...base, table: "sessions", aggregate: "count" }),
    "metrics/conversion.yaml": metric(
      { type: "ratio", numerator: "orders", denominator: "sessions" },
      { type: "percent" },
    ),
    "metrics/vipx_count.yaml": metric({ type: "aggregate", table: "vipx", aggregate: "count" }),
    ...Object.fromEntries(
      Object.entries(o.dashboards).map(([n, d]) => [
        "dashboards/" + n + ".yaml",
        { title: n, period: PERIOD, filters: d.filters, blocks: d.blocks },
      ]),
    ),
  });
  await mkdir(path.join(root, "data"), { recursive: true });
  await oracle.run(
    "CREATE OR REPLACE TABLE eo AS SELECT DATE '2026-01-01' + to_days(i % 85) AS at, ['Americas','EMEA','APAC'][1 + i % 3] AS region, CASE WHEN i % 11 = 0 THEN NULL ELSE 'c' || (i % 17) END AS customer, ((i * 37) % 250)::DOUBLE AS amount, 'c' || (i % 5) AS referrer FROM range(0, 300) t(i)",
  );
  await oracle.run(
    "CREATE OR REPLACE TABLE es AS SELECT DATE '2026-01-01' + to_days(i % 85) AS at, ['Americas','EMEA','APAC','LATAM'][1 + i % 4] AS region, " +
      (o.sessionsCustomer === "BIGINT"
        ? "CAST(i % 23 AS BIGINT)"
        : "CASE WHEN i % 13 = 0 THEN NULL ELSE 'c' || (i % 23) END") +
      " AS customer, ['phone','desktop'][1 + i % 2] AS device FROM range(0, 700) t(i)",
  );
  await oracle.run(
    "CREATE OR REPLACE TABLE ev AS SELECT * FROM (VALUES ('c1', 1), ('c2', 2), ('c2', 2), (NULL, 3), ('c20', 4)) t(customer, no)",
  );
  await oracle.run(
    "CREATE OR REPLACE TABLE ea AS SELECT * FROM (VALUES (1, 'gold'), (2, 'silver')) t(no, tier)",
  );
  for (const [t, f] of [
    ["eo", "orders"],
    ["es", "sessions"],
    ["ev", "vips"],
    ["ea", "accounts"],
  ])
    await oracle.run(
      "COPY " + t + " TO " + quote(path.join(root, "data", f + ".parquet")) + " (FORMAT parquet)",
    );
  return root;
}

function embedded(html: string): SegmentData | undefined {
  const m = html.match(/<script type="application\/json" data-hm-segments[^>]*>(.*?)<\/script>/s);
  return m ? (JSON.parse(m[1] ?? "null") as SegmentData) : undefined;
}
const kpi = (state: { data: { blocks: unknown[] } }, id: string) =>
  (state.data.blocks as KpiData[]).find((b) => b.id === id);
const diags = (report: unknown) => (report as { diagnostics: Diag[] }).diagnostics;

const VIP = "(SELECT customer FROM ev WHERE customer IS NOT NULL)";
const spanOf = (state: { data: { blocks: unknown[] } }, id: string) => {
  const w = kpi(state, id)?.current;
  if (w === undefined) throw new Error("no window for " + id);
  return '"at" >= DATE ' + quote(w.start) + ' AND "at" < DATE ' + quote(w.end);
};

describe("in_table toggle edges", () => {
  it("toggle over two sources: each binds where its column exists, exact counts", async () => {
    const root = await project({
      segments: {
        vip: [inT("customer", "vips", "customer")],
        not_vip: [notT("customer", "vips", "customer")],
      },
      dashboards: {
        d: {
          filters: [{ type: "segment", id: "who", segments: ["vip", "not_vip"] }],
          blocks: [
            { type: "kpi", id: "orders", metric: "orders" },
            { type: "kpi", id: "sessions", metric: "sessions" },
            { type: "kpi", id: "conversion", metric: "conversion" },
          ],
        },
      },
    });
    const { code, report } = await buildProject(root);
    expect(code, JSON.stringify(diags(report))).toBe(0);
    const seg = embedded(await readFile(path.join(root, "dist", "d", "index.html"), "utf8"));
    expect(Object.keys(seg?.states ?? {}).sort()).toEqual(["", "not_vip", "vip", "vip,not_vip"]);
    for (const state of Object.values(seg?.states ?? {})) {
      const on = state.selected;
      const w: string[] = [];
      if (on.includes("vip")) w.push("customer IN " + VIP);
      if (on.includes("not_vip")) w.push("(customer IS NULL OR customer NOT IN " + VIP + ")");
      const where = ["TRUE", ...w].join(" AND ");
      const [o] = await oracle.rows(
        "SELECT count(*) AS n FROM eo WHERE " + spanOf(state, "orders") + " AND " + where,
      );
      const [s] = await oracle.rows(
        "SELECT count(*) AS n FROM es WHERE " + spanOf(state, "sessions") + " AND " + where,
      );
      expect(kpi(state, "orders")?.value, JSON.stringify(on) + " orders").toBe(o?.n);
      expect(kpi(state, "sessions")?.value, JSON.stringify(on) + " sessions").toBe(s?.n);
      const ratio = Number(s?.n ?? 0) === 0 ? null : Number(o?.n ?? 0) / Number(s?.n ?? 1);
      expect(kpi(state, "conversion")?.value, JSON.stringify(on) + " conversion").toBe(ratio);
    }
  });

  it("self key table reads every row of the source, not the windowed or filtered rows", async () => {
    const root = await project({
      segments: { referred: [inT("customer", "orders", "referrer")] },
      dashboards: {
        d: {
          filters: [
            { type: "select", id: "region", column: "region", default: "EMEA" },
            { type: "segment", id: "who", segments: ["referred"], default: ["referred"] },
          ],
          blocks: [{ type: "kpi", id: "orders", metric: "orders" }],
        },
      },
    });
    const { code, report } = await buildProject(root);
    expect(code, JSON.stringify(diags(report))).toBe(0);
    const seg = embedded(await readFile(path.join(root, "dist", "d", "index.html"), "utf8"));
    const [o] = await oracle.rows(
      "SELECT count(*) AS n FROM eo WHERE " +
        spanOf(seg?.states.referred as never, "orders") +
        " AND region = 'EMEA' AND customer IN (SELECT referrer FROM eo WHERE referrer IS NOT NULL)",
    );
    expect(kpi(seg?.states.referred as never, "orders")?.value).toBe(o?.n);
  });

  it("a rebuild after the key table changes shows the new keys", async () => {
    const root = await project({
      segments: { vip: [inT("customer", "vips", "customer")] },
      dashboards: {
        d: {
          filters: [{ type: "segment", id: "who", segments: ["vip"] }],
          blocks: [{ type: "kpi", id: "orders", metric: "orders" }],
        },
      },
    });
    expect((await buildProject(root)).code).toBe(0);
    await oracle.run(
      "CREATE OR REPLACE TABLE ev AS SELECT * FROM (VALUES ('c3', 9)) t(customer, no)",
    );
    await oracle.run(
      "COPY ev TO " + quote(path.join(root, "data", "vips.parquet")) + " (FORMAT parquet)",
    );
    expect((await buildProject(root)).code).toBe(0);
    const seg = embedded(await readFile(path.join(root, "dist", "d", "index.html"), "utf8"));
    const [o] = await oracle.rows(
      "SELECT count(*) AS n FROM eo WHERE " +
        spanOf(seg?.states.vip as never, "orders") +
        " AND customer = 'c3'",
    );
    expect(kpi(seg?.states.vip as never, "orders")?.value).toBe(o?.n);
  });

  it("a lookup key table removes only the blocks whose sources the toggle binds", async () => {
    const root = await project({
      segments: {
        vipx_device: [inT("device", "vipx", "customer")],
        vipx_planet: [inT("planet", "vipx", "customer")],
      },
      dashboards: {
        one_bound: {
          filters: [{ type: "segment", id: "who", segments: ["vipx_device"] }],
          blocks: [
            { type: "kpi", id: "orders", metric: "orders" },
            { type: "kpi", id: "sessions", metric: "sessions" },
          ],
        },
        unbound: {
          filters: [{ type: "segment", id: "who", segments: ["vipx_planet"] }],
          blocks: [
            { type: "kpi", id: "orders", metric: "orders" },
            { type: "kpi", id: "sessions", metric: "sessions" },
          ],
        },
      },
    });
    const { code, report } = await buildProject(root);
    const of = (name: string) =>
      diags(report)
        .filter((d) => d.file?.endsWith(name + ".yaml") && d.code !== "HM4010")
        .map((d) => [d.code, d.severity, d.pointer]);
    expect(
      { code, one: of("one_bound"), un: of("unbound") },
      JSON.stringify(diags(report)),
    ).toEqual({
      code: 0,
      one: [["HM4023", "warning", "/blocks/1"]],
      un: [["HM2030", "warning", "/filters/0/segments/0"]],
    });
    for (const name of ["one_bound", "unbound"]) {
      const seg = embedded(await readFile(path.join(root, "dist", name, "index.html"), "utf8"));
      expect(Object.keys(seg?.states ?? {}).sort(), name).toEqual([
        "",
        name === "one_bound" ? "vipx_device" : "vipx_planet",
      ]);
      for (const state of Object.values(seg?.states ?? {})) {
        const [o] = await oracle.rows(
          "SELECT count(*) AS n FROM eo WHERE " + spanOf(state, "orders"),
        );
        expect(kpi(state, "orders")?.value, name + " orders").toBe(o?.n);
        if (name === "unbound") {
          const [ss] = await oracle.rows(
            "SELECT count(*) AS n FROM es WHERE " + spanOf(state, "sessions"),
          );
          expect(kpi(state, "sessions")?.value, name + " sessions").toBe(ss?.n);
        } else expect(kpi(state, "sessions"), name + " sessions left out").toBeUndefined();
      }
    }
  });

  it("a metric segment whose key table is a lookup source is left out with HM4023", async () => {
    const root = await project({
      segments: { vipx: [inT("customer", "vipx", "customer")] },
      dashboards: { d: { filters: [], blocks: [{ type: "kpi", id: "x", metric: "vipx_orders" }] } },
    });
    await writeFile(
      path.join(root, "metrics", "vipx_orders.yaml"),
      JSON.stringify(
        metric({
          type: "aggregate",
          table: "orders",
          time: "at",
          aggregate: "count",
          segments: ["vipx"],
        }),
      ),
    );
    const { code, report } = await buildProject(root);
    expect(diags(report).map((d) => d.code)).toContain("HM4023");
    expect(code).toBe(0);
  });

  it("HM2029 names the second source when only it has the mismatched key type", async () => {
    const root = await project({
      sessionsCustomer: "BIGINT",
      segments: { vip: [inT("customer", "vips", "customer")] },
      dashboards: {
        d: {
          filters: [{ type: "segment", id: "who", segments: ["vip"] }],
          blocks: [
            { type: "kpi", id: "orders", metric: "orders" },
            { type: "kpi", id: "sessions", metric: "sessions" },
          ],
        },
      },
    });
    const { project: p } = await loadAt(root);
    const found = checkReferences(p).filter((d) => d.code === "HM2029");
    expect(found.map((d) => [d.pointer, d.message.includes('"sessions"')])).toEqual([
      ["/filters/0/segments/0", true],
    ]);
    const { code, report } = await buildProject(root);
    expect(code).not.toBe(0);
    expect(diags(report).map((d) => d.code)).toContain("HM2029");
  });

  it("integer keys of different widths compare exactly, big values included (no HM2029)", async () => {
    const root = await project({
      sessionsCustomer: "BIGINT",
      segments: {
        acct: [inT("customer", "accounts", "no")],
        not_acct: [notT("customer", "accounts", "no")],
      },
      dashboards: {
        d: {
          filters: [{ type: "segment", id: "who", segments: ["acct", "not_acct"] }],
          blocks: [{ type: "kpi", id: "sessions", metric: "sessions" }],
        },
      },
    });
    const { code, report } = await buildProject(root);
    expect(code, JSON.stringify(diags(report))).toBe(0);
    const seg = embedded(await readFile(path.join(root, "dist", "d", "index.html"), "utf8"));
    const acct = seg?.states.acct as never;
    const [a] = await oracle.rows(
      "SELECT count(*) AS n FROM es WHERE " +
        spanOf(acct, "sessions") +
        " AND customer IN (SELECT no FROM ea)",
    );
    const [n] = await oracle.rows(
      "SELECT count(*) AS n FROM es WHERE " +
        spanOf(acct, "sessions") +
        " AND customer NOT IN (SELECT no FROM ea)",
    );
    expect(kpi(seg?.states.acct as never, "sessions")?.value).toBe(a?.n);
    expect(kpi(seg?.states.not_acct as never, "sessions")?.value).toBe(n?.n);
  });

  it("HM2030: a select column only an unread source has, and a segment whose columns no single source has", async () => {
    const root = await project({
      segments: {
        split: [
          { column: "amount", op: "gte", value: 100 },
          { column: "device", op: "eq", value: "phone" },
        ],
        vip: [inT("customer", "vips", "customer")],
      },
      dashboards: {
        only_orders: {
          filters: [{ type: "select", id: "device", column: "device" }],
          blocks: [{ type: "kpi", id: "orders", metric: "orders" }],
        },
        both: {
          filters: [{ type: "segment", id: "who", segments: ["vip", "split"] }],
          blocks: [
            { type: "kpi", id: "orders", metric: "orders" },
            { type: "kpi", id: "sessions", metric: "sessions" },
          ],
        },
      },
    });
    const { project: p } = await loadAt(root);
    const found = checkReferences(p)
      .filter((d) => d.code === "HM2030")
      .map((d) => [d.file?.replace(/.*dashboards\//, ""), d.pointer, d.severity]);
    expect(found.sort()).toEqual([
      ["both.yaml", "/filters/0/segments/1", "warning"],
      ["only_orders.yaml", "/filters/0/column", "warning"],
    ]);
  });

  it("HM2030 stays quiet for columns a lookup source has, and for segments a source binds", async () => {
    const root = await project({
      segments: {
        vip: [inT("customer", "vips", "customer")],
        gold: [{ column: "accounts.tier", op: "eq", value: "gold" }],
      },
      dashboards: {
        lk: {
          filters: [
            { type: "select", id: "c", column: "customer" },
            { type: "select", id: "t", column: "accounts.tier" },
          ],
          blocks: [{ type: "kpi", id: "x", metric: "vipx_count" }],
        },
        ok: {
          filters: [
            { type: "select", id: "region", column: "REGION" },
            { type: "segment", id: "who", segments: ["vip"] },
          ],
          blocks: [{ type: "kpi", id: "orders", metric: "orders" }],
        },
      },
    });
    const { project: p } = await loadAt(root);
    expect(checkReferences(p).filter((d) => d.code === "HM2030")).toEqual([]);
  });

  it("a key column missing from the key table is an error, not a crash", async () => {
    const root = await project({
      segments: { bad: [inT("customer", "vips", "nope")] },
      dashboards: {
        d: {
          filters: [{ type: "segment", id: "who", segments: ["bad"] }],
          blocks: [{ type: "kpi", id: "orders", metric: "orders" }],
        },
      },
    });
    const { code, report } = await buildProject(root);
    expect(code).not.toBe(0);
    expect(diags(report).filter((d) => d.severity === "error").length).toBeGreaterThan(0);
  });

  it("a missing key table file is an error diagnostic, not a crash", async () => {
    const root = await project({
      extraSources: { gone: { type: "parquet", path: "data/gone.parquet" } },
      segments: { lost: [inT("customer", "gone", "customer")] },
      dashboards: {
        d: {
          filters: [{ type: "segment", id: "who", segments: ["lost"] }],
          blocks: [{ type: "kpi", id: "orders", metric: "orders" }],
        },
      },
    });
    const { code, report } = await buildProject(root);
    expect(code).not.toBe(0);
    expect(
      diags(report).filter((d) => d.severity === "error").length,
      JSON.stringify(diags(report)),
    ).toBeGreaterThan(0);
  });
  it("map regions and match rows follow in_table and not_in_table toggles", async () => {
    const { root } = await writeProject({
      "hatchmark.yaml": {
        ...PROJECT_DEFAULTS,
        name: "keys-map",
        sources: {
          orders: { type: "parquet", path: "data/orders.parquet" },
          keys: { type: "parquet", path: "data/keys.parquet" },
        },
      },
      "segments/vip.yaml": { label: "VIP", filters: [inT("customer", "keys", "customer")] },
      "segments/not_vip.yaml": {
        label: "Not VIP",
        filters: [notT("customer", "keys", "customer")],
      },
      "segments/big.yaml": { label: "Big", filters: [{ column: "amount", op: "gte", value: 50 }] },
      "metrics/revenue.yaml": metric({
        type: "aggregate",
        table: "orders",
        time: "at",
        aggregate: "sum",
        column: "amount",
      }),
      "dashboards/d.yaml": {
        title: "D",
        period: PERIOD,
        filters: [{ type: "segment", id: "who", segments: ["vip", "not_vip", "big"] }],
        blocks: [{ type: "map", id: "m", geo: "us-states", region: "state", value: "revenue" }],
      },
    });
    await mkdir(path.join(root, "data"), { recursive: true });
    await oracle.run(
      "CREATE OR REPLACE TABLE mo AS SELECT DATE '2026-01-01' + to_days(i % 80) AS at, ['CA','NY','TX','WA','ZZ',NULL][1 + i % 6] AS state, CASE WHEN i % 7 = 0 THEN NULL ELSE 'c' || (i % 13) END AS customer, ((i * 29) % 120)::DOUBLE AS amount FROM range(0, 240) t(i)",
    );
    await oracle.run(
      "CREATE OR REPLACE TABLE mk AS SELECT * FROM (VALUES ('c1'), ('c2'), ('c2'), (NULL), ('c9')) t(customer)",
    );
    await oracle.run(
      "COPY mo TO " + quote(path.join(root, "data", "orders.parquet")) + " (FORMAT parquet)",
    );
    await oracle.run(
      "COPY mk TO " + quote(path.join(root, "data", "keys.parquet")) + " (FORMAT parquet)",
    );
    const { code, report } = await buildProject(root);
    expect(code, JSON.stringify(diags(report))).toBe(0);
    const seg = embedded(await readFile(path.join(root, "dist", "d", "index.html"), "utf8"));
    const KEYS = "(SELECT customer FROM mk WHERE customer IS NOT NULL)";
    expect(Object.keys(seg?.states ?? {})).toHaveLength(8);
    for (const state of Object.values(seg?.states ?? {})) {
      const on = state.selected;
      const map = (state.data.blocks as MapData[]).find((b) => b.id === "m");
      if (map?.window === undefined) throw new Error("no map window");
      const where = [
        '"at" >= DATE ' + quote(map.window.start) + ' AND "at" < DATE ' + quote(map.window.end),
        ...(on.includes("vip") ? ["customer IN " + KEYS] : []),
        ...(on.includes("not_vip") ? ["(customer IS NULL OR customer NOT IN " + KEYS + ")"] : []),
        ...(on.includes("big") ? ["amount >= 50"] : []),
      ].join(" AND ");
      const regions = await oracle.rows(
        "SELECT state AS id, sum(amount) AS value FROM mo WHERE " +
          where +
          " AND state IN ('CA','NY','TX','WA') GROUP BY state ORDER BY state",
      );
      const matches = await oracle.rows(
        "SELECT state AS key, count(*) AS rows FROM mo WHERE " +
          where +
          " GROUP BY state ORDER BY state NULLS LAST",
      );
      const label = JSON.stringify(on);
      expect(
        [...(map.regions ?? [])]
          .map((r) => ({ id: r.id, value: r.value }))
          .sort((a, b) => (a.id < b.id ? -1 : 1)),
        label + " regions",
      ).toEqual(regions.map((r) => ({ id: r.id, value: r.value })));
      expect(
        [...(map.match ?? [])]
          .map((m) => ({ key: m.key, rows: m.rows }))
          .sort((a, b) =>
            a.key === null ? 1 : b.key === null ? -1 : String(a.key) < String(b.key) ? -1 : 1,
          ),
        label + " match",
      ).toEqual(matches.map((m) => ({ key: m.key ?? null, rows: m.rows })));
    }
  });
});
