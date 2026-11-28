import { type DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type GeoId,
  matchRegion,
  normalizeRegionKey,
  normalizeRegionKeySql,
  regionAliases,
  regionKeySql,
} from "../../src/geo/aliases.js";
import { US_AMBIGUOUS, US_STATE_ENTRIES } from "../../src/geo/aliases-us.js";
import { WORLD_ALIASES, WORLD_AMBIGUOUS } from "../../src/geo/aliases-world.js";
import { WORLD_COUNTRY_ENTRIES } from "../../src/geo/world-codes.js";

const GEOS: GeoId[] = ["us-states", "world-countries"];

const ODDITIES = [
  "",
  " ",
  "-",
  "&",
  "0",
  "00",
  "000",
  "06",
  "006",
  "06.0",
  "6.00",
  "6.",
  ".6",
  "-6",
  "+6",
  "6.5",
  "1e3",
  "ß",
  "Straße",
  "ẞ",
  "Øresund",
  "Łódź",
  "Æthelred",
  "Œuvre",
  "Đà Nẵng",
  "Þingvellir",
  "ı",
  "İstanbul",
  "ﬁnland",
  "Ｆｒａｎｃｅ",
  "ＵＳ－ＣＡ",
  "１２",
  "６",
  "\u00a0CA\u00a0",
  "C\u0301A",
  "a\u0897b",
  "a\u1acfb",
  "Côte d’Ivoire",
  "CÔTE D'IVOIRE",
  "Bosnia & Herzegovina",
  "Trinidad & Tobago",
  "St Kitts & Nevis",
  "Korea",
  "congo",
  "Virgin Islands",
  "Carolina",
  "N.Y.",
  "n y",
  "Washington, D.C.",
  "Wash. D.C.",
  "US-CA",
  "us_ca",
  "XK",
  "xkx",
  "Kosovo",
  "N. Cyprus",
  "Somaliland",
  "Antarctica",
  "Singapore",
  "Guam",
];

function rawAliases(geo: GeoId): string[] {
  if (geo === "us-states") {
    return [
      ...US_STATE_ENTRIES.flatMap((s) => [s.usps, s.fips, `US-${s.usps}`, s.name, ...s.aliases]),
      ...Object.keys(US_AMBIGUOUS),
    ];
  }
  return [
    ...WORLD_COUNTRY_ENTRIES.flatMap((c) => [
      c.id,
      c.name,
      ...c.names,
      ...(c.iso2 ? [c.iso2] : []),
      ...(c.numeric ? [c.numeric] : []),
    ]),
    ...Object.values(WORLD_ALIASES).flat(),
    ...Object.keys(WORLD_AMBIGUOUS),
  ];
}

function variants(raw: string): string[] {
  return [
    raw,
    raw.toUpperCase(),
    raw.toLowerCase(),
    `  ${raw}\t`,
    raw.replace(/ /g, " - "),
    `${raw}.`,
    `0${raw}`,
    raw.replace(/a/g, "á").replace(/o/g, "ø").replace(/e/g, "ë"),
  ];
}

const expectedId = (geo: GeoId, raw: string | number | boolean | null) => {
  const m = matchRegion(geo, raw);
  return m.kind === "matched" || m.kind === "not_drawn" ? m.id : null;
};

let connection: DuckDBConnection;

beforeAll(async () => {
  connection = await (await DuckDBInstance.create(":memory:")).connect();
});
afterAll(() => connection.closeSync());

async function loadStrings(values: (string | null)[]): Promise<void> {
  await connection.run("CREATE OR REPLACE TABLE strings (i INTEGER, v VARCHAR)");
  const appender = await connection.createAppender("strings");
  values.forEach((v, i) => {
    appender.appendInteger(i);
    if (v === null) appender.appendNull();
    else appender.appendVarchar(v);
    appender.endRow();
  });
  appender.closeSync();
}

describe("region key normalization in DuckDB", () => {
  it("gives every Unicode code point the key normalizeRegionKey gives it", async () => {
    const rows = (
      await connection.runAndReadAll(
        `SELECT i, ${normalizeRegionKeySql("'a' || chr(i::INTEGER) || 'b'")} FROM range(1, 1114112) t(i) WHERE i < 55296 OR i > 57343`,
      )
    ).getRows();
    expect(rows.length).toBe(1112063);
    const differences: string[] = [];
    for (const [i, key] of rows) {
      const ch = String.fromCodePoint(Number(i));
      const js = normalizeRegionKey(`a${ch}b`);
      if (js !== key) differences.push(`U+${Number(i).toString(16)} js=${js} sql=${key}`);
    }
    expect(differences).toEqual([]);
  }, 60_000);

  it("gives the unusual strings the same key", async () => {
    await loadStrings(ODDITIES);
    const rows = (
      await connection.runAndReadAll(
        `SELECT i, ${normalizeRegionKeySql("v")} FROM strings ORDER BY i`,
      )
    ).getRows();
    expect(rows.map(([, key]) => key)).toEqual(ODDITIES.map((v) => normalizeRegionKey(v)));
  });
});

describe.each(GEOS)("regionKeySql(%s) against matchRegion", (geo) => {
  it("returns the id matchRegion returns for every alias and its variants", async () => {
    const values = [...new Set([...rawAliases(geo).flatMap(variants), ...ODDITIES])];
    await loadStrings([...values, null]);
    const rows = (
      await connection.runAndReadAll(`SELECT i, ${regionKeySql(geo, "v")} FROM strings ORDER BY i`)
    ).getRows();
    const got = rows.map(([, id]) => id);
    const want = [...values.map((v) => expectedId(geo, v)), null];
    const mismatches = got.flatMap((id, i) =>
      id === want[i] ? [] : [`${JSON.stringify(values[i])}: sql=${id} js=${want[i]}`],
    );
    expect(mismatches).toEqual([]);
    expect(got.filter((id) => id !== null).length).toBeGreaterThan(values.length / 3);
  }, 60_000);

  it("matches every normalized alias to its id", async () => {
    const aliases = regionAliases(geo);
    await loadStrings(aliases.map(([key]) => key));
    const rows = (
      await connection.runAndReadAll(`SELECT ${regionKeySql(geo, "v")} FROM strings ORDER BY i`)
    ).getRows();
    expect(rows.map(([id]) => id)).toEqual(aliases.map(([, id]) => id));
  });

  it("reads numbers of every type as matchRegion reads the JavaScript number", async () => {
    const numbers = [...Array.from({ length: 1000 }, (_, i) => i), -6, -840, 1e15, 2 ** 53];
    const fractions = [0.5, 6.5, 6.25, 840.1, -0.5, 1e21, 1e-7];
    const types: [string, number[]][] = [
      ["INTEGER", numbers.filter((n) => Math.abs(n) < 2 ** 31)],
      ["BIGINT", numbers],
      ["HUGEINT", numbers],
      ["DOUBLE", [...numbers, ...fractions]],
      ["FLOAT", [0, 1, 6, 36, 72, 840, 6.5]],
      ["DECIMAL(9,2)", [0, 6, 72, 840, 6.5]],
      ["VARCHAR", numbers],
    ];
    for (const [type, values] of types) {
      const list = values.map((v) => `(CAST(${v} AS ${type}))`).join(", ");
      const rows = (
        await connection.runAndReadAll(
          `SELECT ${regionKeySql(geo, "v")} FROM (VALUES ${list}) t(v)`,
        )
      ).getRows();
      const mismatches = rows.flatMap(([id], i) => {
        const want = expectedId(geo, values[i] as number);
        return id === want ? [] : [`${type} ${values[i]}: sql=${id} js=${want}`];
      });
      expect(mismatches).toEqual([]);
    }
    const booleans = (
      await connection.runAndReadAll(
        `SELECT ${regionKeySql(geo, "v")} FROM (VALUES (true), (false), (NULL::BOOLEAN)) t(v)`,
      )
    ).getRows();
    expect(booleans.map(([id]) => id)).toEqual([
      expectedId(geo, true),
      expectedId(geo, false),
      null,
    ]);
  });

  it("keys 100,000 rows in seconds, not minutes", async () => {
    const aliases = regionAliases(geo).map(([key]) => key);
    await connection.run(
      `CREATE OR REPLACE TABLE big AS SELECT CASE WHEN i % 7 = 0 THEN 'no such region ' || i ELSE upper(list_extract(${`[${aliases.map((a) => `'${a}'`).join(", ")}]`}, (i % ${aliases.length}) + 1)) END AS v FROM range(100000) t(i)`,
    );
    const start = performance.now();
    const rows = (
      await connection.runAndReadAll(`SELECT count(${regionKeySql(geo, "v")}) FROM big`)
    ).getRows();
    const elapsed = performance.now() - start;
    expect(Number(rows[0]?.[0])).toBeGreaterThan(80000);
    expect(elapsed).toBeLessThan(5000);
  });
});
