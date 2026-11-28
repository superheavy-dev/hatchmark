import { describe, expect, it } from "vitest";
import {
  ambiguousRegionAliases,
  type GeoId,
  matchRegion,
  normalizeRegionKey,
  notDrawnIds,
  regionAliases,
  regionName,
} from "../../src/geo/aliases.js";
import { US_STATE_ENTRIES } from "../../src/geo/aliases-us.js";
import { WORLD_ALIASES } from "../../src/geo/aliases-world.js";
import { US_STATES } from "../../src/geo/us-states.js";
import { WORLD_COUNTRY_ENTRIES } from "../../src/geo/world-codes.js";
import { WORLD_COUNTRIES } from "../../src/geo/world-countries.js";

const GEOGRAPHIES = { "us-states": US_STATES, "world-countries": WORLD_COUNTRIES } as const;

const idOf = (geo: GeoId, raw: string | number) => {
  const m = matchRegion(geo, raw);
  return m.kind === "matched" || m.kind === "not_drawn" ? m.id : m.kind;
};

describe("normalizeRegionKey", () => {
  it.each([
    ["  Côte d’Ivoire ", "cote d ivoire"],
    ["CÔTE-D'IVOIRE", "cote d ivoire"],
    ["Bosnia & Herzegovina", "bosnia and herzegovina"],
    ["Wash. D.C.", "wash d c"],
    ["006", "6"],
    ["0", "0"],
    ["000", "0"],
    ["06.0", "6"],
    ["6.5", "6 5"],
    ["Straße", "strasse"],
    ["Łódź", "lodz"],
    ["Ｆｒａｎｃｅ", "france"],
    ["ﬁnland", "finland"],
    ["İstanbul", "istanbul"],
  ])("%j → %j", (raw, key) => {
    expect(normalizeRegionKey(raw)).toBe(key);
  });

  it("reads numbers and booleans through their string form", () => {
    expect(normalizeRegionKey(6)).toBe("6");
    expect(normalizeRegionKey(840)).toBe("840");
    expect(normalizeRegionKey(true)).toBe("true");
  });

  it("keeps negative whole numbers out of every code", () => {
    for (const raw of ["-6", "-06", "-6.0", -6, -840])
      expect(
        matchRegion(raw === -840 ? "world-countries" : "us-states", raw).kind,
        String(raw),
      ).toBe("unmatched");
  });
});

describe.each(["us-states", "world-countries"] as const)("aliases of %s", (geo) => {
  const geography = GEOGRAPHIES[geo];

  it("reach every drawn region by its id and its name", () => {
    for (const region of geography.regions) {
      expect(matchRegion(geo, region.id)).toMatchObject({ kind: "matched", id: region.id });
      expect(idOf(geo, region.name)).toBe(region.id);
      expect(idOf(geo, region.name.toUpperCase())).toBe(region.id);
      expect(regionName(geo, region.id)).toBe(region.name);
    }
  });

  it("report every not-drawn region as not drawn, with its name", () => {
    expect(notDrawnIds(geo)).toEqual(geography.notDrawn.map((n) => n.id));
    for (const { id, name } of geography.notDrawn) {
      expect(matchRegion(geo, id)).toEqual({ kind: "not_drawn", id, name });
      expect(matchRegion(geo, name)).toEqual({ kind: "not_drawn", id, name });
      expect(regionName(geo, id)).toBe(name);
    }
  });

  it("map each normalized alias to one id, and keep ambiguous ones out", () => {
    const aliases = regionAliases(geo);
    expect(new Set(aliases.map(([key]) => key)).size).toBe(aliases.length);
    const ids = new Set([...geography.regions.map((r) => r.id), ...notDrawnIds(geo)]);
    for (const [key, id] of aliases) {
      expect(ids.has(id), key).toBe(true);
      expect(normalizeRegionKey(key)).toBe(key);
    }
    for (const [key, candidates] of ambiguousRegionAliases(geo)) {
      expect(aliases.some(([k]) => k === key)).toBe(false);
      expect(matchRegion(geo, key)).toEqual({ kind: "ambiguous", candidates: [...candidates] });
      expect(candidates.length).toBeGreaterThan(1);
    }
  });

  it("match null and empty input to nothing", () => {
    expect(matchRegion(geo, null)).toEqual({ kind: "unmatched", suggestions: [] });
    expect(matchRegion(geo, "")).toEqual({ kind: "unmatched", suggestions: [] });
    expect(matchRegion(geo, " - ")).toEqual({ kind: "unmatched", suggestions: [] });
  });
});

describe("us-states aliases", () => {
  it("cover USPS, FIPS with and without the zero, ISO 3166-2 and names", () => {
    for (const s of US_STATE_ENTRIES) {
      expect(matchRegion("us-states", s.usps)).toMatchObject({ id: s.usps });
      expect(matchRegion("us-states", s.fips)).toMatchObject({ id: s.usps });
      expect(matchRegion("us-states", Number(s.fips))).toMatchObject({ id: s.usps });
      expect(matchRegion("us-states", `US-${s.usps}`)).toMatchObject({ id: s.usps });
      for (const alias of s.aliases) expect(idOf("us-states", alias), alias).toBe(s.usps);
    }
    expect(matchRegion("us-states", "ca")).toEqual({ kind: "matched", id: "CA", by: "usps" });
    expect(matchRegion("us-states", "06")).toEqual({ kind: "matched", id: "CA", by: "fips" });
    expect(matchRegion("us-states", 6)).toEqual({ kind: "matched", id: "CA", by: "fips" });
    expect(matchRegion("us-states", "6.0")).toEqual({ kind: "matched", id: "CA", by: "fips" });
    expect(matchRegion("us-states", "us-ca")).toEqual({
      kind: "matched",
      id: "CA",
      by: "iso3166-2",
    });
    expect(matchRegion("us-states", "California")).toEqual({
      kind: "matched",
      id: "CA",
      by: "name",
    });
  });

  it.each([
    ["Calif.", "CA"],
    ["Mass.", "MA"],
    ["Wash. D.C.", "DC"],
    ["Washington DC", "DC"],
    ["Washington, D.C.", "DC"],
    ["District of Columbia", "DC"],
    ["D.C.", "DC"],
    ["DC", "DC"],
    ["11", "DC"],
    ["Washington", "WA"],
    ["Wash.", "WA"],
    ["N.Y.", "NY"],
    ["W.Va.", "WV"],
    ["Puerto Rico", "PR"],
    ["72", "PR"],
    ["US-PR", "PR"],
  ])("%j → %s", (raw, id) => {
    expect(matchRegion("us-states", raw)).toMatchObject({ kind: "matched", id });
  });

  it.each([
    ["Guam", "GU"],
    ["66", "GU"],
    ["U.S. Virgin Islands", "VI"],
    ["Virgin Islands", "VI"],
    ["78", "VI"],
    ["American Samoa", "AS"],
    ["60", "AS"],
    ["Northern Mariana Islands", "MP"],
    ["CNMI", "MP"],
    ["69", "MP"],
  ])("%j is the territory %s, not drawn", (raw, id) => {
    expect(matchRegion("us-states", raw)).toMatchObject({ kind: "not_drawn", id });
  });

  it("keeps half names ambiguous", () => {
    expect(matchRegion("us-states", "Carolina")).toEqual({
      kind: "ambiguous",
      candidates: ["NC", "SC"],
    });
    expect(matchRegion("us-states", "Dakota")).toEqual({
      kind: "ambiguous",
      candidates: ["ND", "SD"],
    });
  });

  it("suggests the closest state for a typo", () => {
    expect(matchRegion("us-states", "Calfornia")).toEqual({
      kind: "unmatched",
      suggestions: ["CA"],
    });
    expect(matchRegion("us-states", "Nwe York")).toEqual({
      kind: "unmatched",
      suggestions: ["NY"],
    });
    expect(matchRegion("us-states", "Atlantis")).toEqual({ kind: "unmatched", suggestions: [] });
  });
});

describe("world-countries aliases", () => {
  it("cover ISO alpha-2, alpha-3 and numeric codes, with and without leading zeros", () => {
    for (const c of WORLD_COUNTRY_ENTRIES) {
      expect(idOf("world-countries", c.id)).toBe(c.id);
      if (c.iso2) expect(matchRegion("world-countries", c.iso2)).toMatchObject({ id: c.id });
      if (c.numeric) {
        expect(matchRegion("world-countries", c.numeric)).toMatchObject({ id: c.id });
        expect(matchRegion("world-countries", Number(c.numeric))).toMatchObject({ id: c.id });
      }
    }
    expect(matchRegion("world-countries", "US")).toEqual({
      kind: "matched",
      id: "USA",
      by: "iso2",
    });
    expect(matchRegion("world-countries", "usa")).toEqual({
      kind: "matched",
      id: "USA",
      by: "iso3",
    });
    expect(matchRegion("world-countries", "840")).toEqual({
      kind: "matched",
      id: "USA",
      by: "numeric",
    });
    expect(matchRegion("world-countries", "004")).toEqual({
      kind: "matched",
      id: "AFG",
      by: "numeric",
    });
    expect(matchRegion("world-countries", 4)).toEqual({
      kind: "matched",
      id: "AFG",
      by: "numeric",
    });
    expect(matchRegion("world-countries", "FR")).toMatchObject({ id: "FRA" });
    expect(matchRegion("world-countries", "NO")).toMatchObject({ id: "NOR" });
    expect(matchRegion("world-countries", "250")).toMatchObject({ id: "FRA" });
  });

  it("reaches every hand-written alias", () => {
    for (const [id, aliases] of Object.entries(WORLD_ALIASES)) {
      for (const alias of aliases) expect(idOf("world-countries", alias), alias).toBe(id);
    }
  });

  it.each([
    ["USA", "USA"],
    ["U.S.", "USA"],
    ["United States of America", "USA"],
    ["UK", "GBR"],
    ["Great Britain", "GBR"],
    ["Britain", "GBR"],
    ["Russia", "RUS"],
    ["Russian Federation", "RUS"],
    ["South Korea", "KOR"],
    ["Korea, Rep.", "KOR"],
    ["Republic of Korea", "KOR"],
    ["North Korea", "PRK"],
    ["Korea, Dem. People's Rep.", "PRK"],
    ["Czech Republic", "CZE"],
    ["Czechia", "CZE"],
    ["Turkey", "TUR"],
    ["Türkiye", "TUR"],
    ["Ivory Coast", "CIV"],
    ["Côte d'Ivoire", "CIV"],
    ["Cote d'Ivoire", "CIV"],
    ["Eswatini", "SWZ"],
    ["Swaziland", "SWZ"],
    ["Burma", "MMR"],
    ["Myanmar", "MMR"],
    ["North Macedonia", "MKD"],
    ["Macedonia", "MKD"],
    ["Cabo Verde", "CPV"],
    ["Cape Verde", "CPV"],
    ["Vatican", "VAT"],
    ["Holy See", "VAT"],
    ["Iran, Islamic Rep.", "IRN"],
    ["Egypt, Arab Rep.", "EGY"],
    ["Venezuela, RB", "VEN"],
    ["Yemen, Rep.", "YEM"],
    ["Lao PDR", "LAO"],
    ["Laos", "LAO"],
    ["Viet Nam", "VNM"],
    ["Vietnam", "VNM"],
    ["Syria", "SYR"],
    ["Syrian Arab Republic", "SYR"],
    ["Taiwan", "TWN"],
    ["Taiwan, China", "TWN"],
    ["Hong Kong SAR, China", "HKG"],
    ["Kyrgyz Republic", "KGZ"],
    ["Slovak Republic", "SVK"],
    ["Gambia, The", "GMB"],
    ["Bahamas, The", "BHS"],
    ["Micronesia, Fed. Sts.", "FSM"],
    ["Brunei Darussalam", "BRN"],
    ["Tanzania", "TZA"],
    ["Bolivia", "BOL"],
    ["Moldova", "MDA"],
    ["Palestine", "PSE"],
    ["West Bank and Gaza", "PSE"],
    ["DRC", "COD"],
    ["DR Congo", "COD"],
    ["Congo, Dem. Rep.", "COD"],
    ["Congo, Rep.", "COG"],
    ["Republic of the Congo", "COG"],
    ["East Timor", "TLS"],
    ["Timor-Leste", "TLS"],
    ["UAE", "ARE"],
    ["Netherlands", "NLD"],
    ["Western Sahara", "ESH"],
    ["South Sudan", "SSD"],
    ["Sudan", "SDN"],
    ["Guinea", "GIN"],
    ["Singapore", "SGP"],
    ["Malta", "MLT"],
    ["Andorra", "AND"],
    ["Bahrain", "BHR"],
    ["Antarctica", "ATA"],
  ])("%j → %s", (raw, id) => {
    expect(idOf("world-countries", raw)).toBe(id);
  });

  it.each([
    ["Kosovo", "KOS"],
    ["XK", "KOS"],
    ["XKX", "KOS"],
    ["KOS", "KOS"],
    ["Northern Cyprus", "CYN"],
    ["N. Cyprus", "CYN"],
    ["Turkish Republic of Northern Cyprus", "CYN"],
    ["CYN", "CYN"],
    ["Somaliland", "SOL"],
    ["SOL", "SOL"],
  ])("%j → %s, drawn without an ISO code", (raw, id) => {
    expect(matchRegion("world-countries", raw)).toMatchObject({ kind: "matched", id });
  });

  it("does not match the Netherlands by Holland", () => {
    expect(matchRegion("world-countries", "Holland").kind).toBe("unmatched");
  });

  it("lists Antarctica and the countries too small for 1:110m as not drawn", () => {
    for (const id of ["ATA", "SGP", "MLT", "AND", "HKG", "BHR", "GUM", "VIR", "REU"]) {
      expect(notDrawnIds("world-countries")).toContain(id);
      expect(matchRegion("world-countries", id).kind).toBe("not_drawn");
    }
  });

  it("keeps ambiguous names unmapped", () => {
    expect([...ambiguousRegionAliases("world-countries")]).toEqual([
      ["congo", ["COD", "COG"]],
      ["korea", ["KOR", "PRK"]],
      ["virgin islands", ["VGB", "VIR"]],
    ]);
    expect(matchRegion("world-countries", "CONGO")).toEqual({
      kind: "ambiguous",
      candidates: ["COD", "COG"],
    });
  });

  it("suggests the closest country for a typo", () => {
    expect(matchRegion("world-countries", "Germny")).toEqual({
      kind: "unmatched",
      suggestions: ["DEU"],
    });
    expect(matchRegion("world-countries", "Untied States")).toMatchObject({
      suggestions: ["USA"],
    });
  });
});
