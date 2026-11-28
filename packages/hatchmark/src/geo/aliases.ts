import { editDistance } from "../diagnostics/suggest.js";
import { US_AMBIGUOUS, US_NOT_DRAWN, US_STATE_ENTRIES } from "./aliases-us.js";
import { WORLD_ALIASES, WORLD_AMBIGUOUS } from "./aliases-world.js";
import { WORLD_COUNTRY_ENTRIES } from "./world-codes.js";

export type GeoId = "us-states" | "world-countries";

export type MatchBy = "iso2" | "iso3" | "numeric" | "usps" | "fips" | "iso3166-2" | "name";

export type RegionMatch =
  | { kind: "matched"; id: string; by: MatchBy }
  | { kind: "not_drawn"; id: string; name: string }
  | { kind: "ambiguous"; candidates: string[] }
  | { kind: "unmatched"; suggestions: string[] };

const MULTI_FOLD: readonly (readonly [string, string])[] = [
  ["ß", "ss"],
  ["ẞ", "ss"],
  ["æ", "ae"],
  ["Æ", "ae"],
  ["œ", "oe"],
  ["Œ", "oe"],
  ["þ", "th"],
  ["Þ", "th"],
  ["ŉ", "n"],
  ["ﬀ", "ff"],
  ["ﬁ", "fi"],
  ["ﬂ", "fl"],
  ["ﬃ", "ffi"],
  ["ﬄ", "ffl"],
  ["ﬅ", "st"],
  ["ﬆ", "st"],
];

const ASCII_LETTERS = "abcdefghijklmnopqrstuvwxyz";
const FULL_WIDTH = (start: number, to: string) =>
  [...to].map((c, i) => [String.fromCharCode(start + i), c] as const);

const UNKNOWN_MARKS: readonly (readonly [number, number])[] = [
  [0x897, 0x897],
  [0x1acf, 0x1add],
  [0x1ae0, 0x1aeb],
  [0x10d69, 0x10d6d],
  [0x10efa, 0x10efc],
  [0x113b8, 0x113c0],
  [0x113c2, 0x113c2],
  [0x113c5, 0x113c5],
  [0x113c7, 0x113ca],
  [0x113cc, 0x113d0],
  [0x113d2, 0x113d2],
  [0x113e1, 0x113e2],
  [0x11b60, 0x11b67],
  [0x11f5a, 0x11f5a],
  [0x1611e, 0x1612f],
  [0x1e5ee, 0x1e5ef],
  [0x1e6e3, 0x1e6e3],
  [0x1e6e6, 0x1e6e6],
  [0x1e6ee, 0x1e6ef],
  [0x1e6f5, 0x1e6f5],
];

const SINGLE_FOLD: readonly (readonly [string, string])[] = [
  ["ø", "o"],
  ["Ø", "o"],
  ["ł", "l"],
  ["Ł", "l"],
  ["đ", "d"],
  ["Đ", "d"],
  ["ð", "d"],
  ["Ð", "d"],
  ["ı", "i"],
  ["ħ", "h"],
  ["Ħ", "h"],
  ["ŀ", "l"],
  ["Ŀ", "l"],
  ["ĸ", "k"],
  ["ŧ", "t"],
  ["Ŧ", "t"],
  ["＆", "&"],
  ...FULL_WIDTH(0xff10, "0123456789"),
  ...FULL_WIDTH(0xff21, ASCII_LETTERS),
  ...FULL_WIDTH(0xff41, ASCII_LETTERS),
  ...UNKNOWN_MARKS.flatMap(([from, to]) =>
    Array.from({ length: to - from + 1 }, (_, i) => [String.fromCodePoint(from + i), " "] as const),
  ),
];

const FOLD = new Map<string, string>([...MULTI_FOLD, ...SINGLE_FOLD]);
const FOLD_PATTERN = new RegExp(`[${[...FOLD.keys()].join("")}]`, "gu");

/**
 * The key a raw region value is matched by. A whole number written with a zero fraction ("6.0")
 * reads as that integer, so DOUBLE columns match like integer ones. Then: a fixed fold table
 * (ß → ss, ø → o, ligatures, full-width forms; combining marks newer than DuckDB's Unicode
 * tables become a space, as DuckDB's strip_accents keeps them), NFD with combining marks removed, lowercase, "&" → " and ", every run of
 * characters other than [a-z0-9] → one space, trimmed; an all-digit key loses its leading zeros
 * ("006" → "6", "0" stays "0"). normalizeRegionKeySql computes the same key in DuckDB.
 */
export function normalizeRegionKey(raw: string | number | boolean): string {
  let s = String(raw).replace(/^([+-]?[0-9]+)\.0+$/, "$1");
  s = s.replace(FOLD_PATTERN, (c) => FOLD.get(c) ?? c);
  s = s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  return s.replace(/^0+([0-9]+)$/, "$1");
}

const literal = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** A DuckDB expression for normalizeRegionKey of a SQL expression of any type; NULL stays NULL. */
export function normalizeRegionKeySql(expr: string): string {
  let s = `regexp_replace(CAST((${expr}) AS VARCHAR), '^([+-]?[0-9]+)\\.0+$', '\\1')`;
  for (const [from, to] of MULTI_FOLD) s = `replace(${s}, ${literal(from)}, ${literal(to)})`;
  s = `translate(${s}, ${literal(SINGLE_FOLD.map(([f]) => f).join(""))}, ${literal(SINGLE_FOLD.map(([, t]) => t).join(""))})`;
  s = `trim(regexp_replace(replace(lower(strip_accents(${s})), '&', ' and '), '[^a-z0-9]+', ' ', 'g'))`;
  return `regexp_replace(${s}, '^0+([0-9]+)$', '\\1')`;
}

interface Alias {
  id: string;
  by: MatchBy;
}

interface AliasTable {
  aliases: Map<string, Alias>;
  ambiguous: Map<string, string[]>;
  names: Map<string, string>;
  notDrawn: string[];
}

interface Source {
  id: string;
  name: string;
  keys: [string, MatchBy][];
}

const PRIORITY: readonly MatchBy[] = [
  "usps",
  "iso2",
  "iso3",
  "numeric",
  "fips",
  "iso3166-2",
  "name",
];

function buildTable(
  sources: Source[],
  notDrawn: string[],
  handAmbiguous: Readonly<Record<string, readonly string[]>>,
): AliasTable {
  const found = new Map<string, Map<string, MatchBy>>();
  for (const { id, keys } of sources) {
    for (const [raw, by] of keys) {
      const key = normalizeRegionKey(raw);
      if (key === "") continue;
      const ids = found.get(key) ?? new Map<string, MatchBy>();
      const previous = ids.get(id);
      if (previous === undefined || PRIORITY.indexOf(by) < PRIORITY.indexOf(previous))
        ids.set(id, by);
      found.set(key, ids);
    }
  }
  const ambiguous = new Map<string, string[]>();
  for (const [raw, ids] of Object.entries(handAmbiguous)) {
    const key = normalizeRegionKey(raw);
    ambiguous.set(key, [...new Set([...ids, ...(found.get(key)?.keys() ?? [])])].sort());
  }
  const aliases = new Map<string, Alias>();
  for (const [key, ids] of [...found].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (ambiguous.has(key)) continue;
    const [first] = ids;
    if (ids.size > 1 || first === undefined) ambiguous.set(key, [...ids.keys()].sort());
    else aliases.set(key, { id: first[0], by: first[1] });
  }
  return {
    aliases,
    ambiguous,
    names: new Map(sources.map((s) => [s.id, s.name])),
    notDrawn: [...notDrawn].sort(),
  };
}

function usTable(): AliasTable {
  const sources = US_STATE_ENTRIES.map(
    (s): Source => ({
      id: s.usps,
      name: s.name,
      keys: [
        [s.usps, "usps"],
        [s.fips, "fips"],
        [`US-${s.usps}`, "iso3166-2"],
        [s.name, "name"],
        ...s.aliases.map((a): [string, MatchBy] => [a, "name"]),
      ],
    }),
  );
  return buildTable(sources, [...US_NOT_DRAWN], US_AMBIGUOUS);
}

function worldTable(): AliasTable {
  const sources = WORLD_COUNTRY_ENTRIES.map(
    (c): Source => ({
      id: c.id,
      name: c.name,
      keys: [
        [c.id, "iso3"],
        ...(c.iso2 === undefined ? [] : [[c.iso2, "iso2"] as [string, MatchBy]]),
        ...(c.numeric === undefined ? [] : [[c.numeric, "numeric"] as [string, MatchBy]]),
        [c.name, "name"],
        ...c.names.map((n): [string, MatchBy] => [n, "name"]),
        ...(WORLD_ALIASES[c.id] ?? []).map((n): [string, MatchBy] => [n, "name"]),
      ],
    }),
  );
  const notDrawn = WORLD_COUNTRY_ENTRIES.filter((c) => !c.drawn).map((c) => c.id);
  return buildTable(sources, notDrawn, WORLD_AMBIGUOUS);
}

const tables = new Map<GeoId, AliasTable>();

function table(geo: GeoId): AliasTable {
  let t = tables.get(geo);
  if (t === undefined) {
    t = geo === "us-states" ? usTable() : worldTable();
    tables.set(geo, t);
  }
  return t;
}

/** Every unambiguous normalized alias of a geography and the region id it names, sorted by alias. */
export function regionAliases(geo: GeoId): readonly (readonly [string, string])[] {
  return [...table(geo).aliases].map(([key, { id }]) => [key, id] as const);
}

/** Normalized aliases that name more than one region, with their candidate ids. */
export function ambiguousRegionAliases(geo: GeoId): ReadonlyMap<string, readonly string[]> {
  return table(geo).ambiguous;
}

/** The English display name of a drawn or not-drawn region id. */
export function regionName(geo: GeoId, id: string): string | undefined {
  return table(geo).names.get(id);
}

/** Ids that rows can name but the geography does not draw, sorted. */
export function notDrawnIds(geo: GeoId): readonly string[] {
  return table(geo).notDrawn;
}

const MAX_SUGGESTIONS = 3;

function suggest(t: AliasTable, key: string): string[] {
  if (key.length < 3) return [];
  const limit = Math.max(1, Math.floor(key.length / 3));
  const best = new Map<string, number>();
  for (const [alias, { id, by }] of t.aliases) {
    if (by !== "name" || Math.abs(alias.length - key.length) > limit) continue;
    const distance = editDistance(key, alias);
    if (distance <= limit && distance < (best.get(id) ?? Number.POSITIVE_INFINITY)) {
      best.set(id, distance);
    }
  }
  return [...best]
    .sort(([a, da], [b, db]) => da - db || (a < b ? -1 : 1))
    .slice(0, MAX_SUGGESTIONS)
    .map(([id]) => id);
}

/**
 * Matches a raw value against a geography's aliases, after normalizeRegionKey. An ambiguous alias
 * ("Congo", "Korea") never matches. Unmatched values carry up to three likely region ids, closest
 * first, from a typo-distance search over region names.
 */
export function matchRegion(geo: GeoId, raw: string | number | boolean | null): RegionMatch {
  if (raw === null) return { kind: "unmatched", suggestions: [] };
  const t = table(geo);
  const key = normalizeRegionKey(raw);
  const alias = t.aliases.get(key);
  if (alias !== undefined) {
    if (t.notDrawn.includes(alias.id)) {
      return { kind: "not_drawn", id: alias.id, name: t.names.get(alias.id) ?? alias.id };
    }
    return { kind: "matched", id: alias.id, by: alias.by };
  }
  const candidates = t.ambiguous.get(key);
  if (candidates !== undefined) return { kind: "ambiguous", candidates: [...candidates] };
  return { kind: "unmatched", suggestions: suggest(t, key) };
}

const sqlCache = new Map<GeoId, string>();

/**
 * A DuckDB expression that evaluates to the region id an expression of any type names, drawn or
 * not drawn, or NULL for NULL, unmatched and ambiguous values; it agrees with matchRegion.
 */
export function regionKeySql(geo: GeoId, expr: string): string {
  let map = sqlCache.get(geo);
  if (map === undefined) {
    map = `MAP {${regionAliases(geo)
      .map(([key, id]) => `${literal(key)}: ${literal(id)}`)
      .join(", ")}}`;
    sqlCache.set(geo, map);
  }
  return `map_extract_value(${map}, ${normalizeRegionKeySql(expr)})`;
}
