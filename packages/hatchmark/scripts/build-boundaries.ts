// Generates src/geo/us-states.ts, src/geo/world-countries.ts and src/geo/world-codes.ts from pinned
// public-domain boundary files: U.S. Census Bureau cartographic boundaries via us-atlas, and
// Natural Earth admin 0 countries. Downloads are cached in HATCHMARK_GEO_CACHE (default: a
// directory under the system temp dir) and checked against their SHA-256. Run: pnpm gen:boundaries
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import {
  type ExtendedFeature,
  type GeoProjection,
  geoConicEqualArea,
  geoEqualEarth,
  geoPath,
} from "d3-geo";
import { feature } from "topojson-client";
import type * as UsAliases from "../src/geo/aliases-us.js";
import type { Geography, GeoInset, GeoRegion } from "../src/geo/types.js";

const { US_NOT_DRAWN, US_STATE_ENTRIES }: typeof UsAliases = await import(
  new URL("../src/geo/aliases-us.ts", import.meta.url).href
);

const NE_COMMIT = "f1890d9f152c896d250a77557a5751a93d494776";
const NE_BASE = `https://raw.githubusercontent.com/nvkelso/natural-earth-vector/${NE_COMMIT}/geojson`;
const SOURCES = {
  usAtlas: {
    file: "us-atlas-3.0.1-states-10m.json",
    url: "https://cdn.jsdelivr.net/npm/us-atlas@3.0.1/states-10m.json",
    sha256: "d76b391ccfa8bff601d51e3e3da5d43a89fa46cd5caca72ce731b383be5596d0",
  },
  ne110: {
    file: "natural-earth-5.1.2-ne_110m_admin_0_countries.geojson",
    url: `${NE_BASE}/ne_110m_admin_0_countries.geojson`,
    sha256: "6866c877d39cba9c357620878839b336d569f8c662d3cfab4cb1dbe2d39c977f",
  },
  ne10: {
    file: "natural-earth-5.1.2-ne_10m_admin_0_countries.geojson",
    url: `${NE_BASE}/ne_10m_admin_0_countries.geojson`,
    sha256: "239eec57ac17f100a11e2536cffc56752c318b50ae765b0918ff7aab4ce8f255",
  },
};

const CACHE = process.env.HATCHMARK_GEO_CACHE ?? join(tmpdir(), "hatchmark-geo-cache");
const OUT = new URL("../src/geo/", import.meta.url);
const BUDGET = 40 * 1024;

type Source = (typeof SOURCES)[keyof typeof SOURCES];

async function load(source: Source): Promise<unknown> {
  mkdirSync(CACHE, { recursive: true });
  const file = join(CACHE, source.file);
  if (!existsSync(file)) {
    const response = await fetch(source.url);
    if (!response.ok) throw new Error(`${source.url}: HTTP ${response.status}`);
    writeFileSync(file, new Uint8Array(await response.arrayBuffer()));
  }
  const bytes = readFileSync(file);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== source.sha256) {
    throw new Error(`${file}: sha256 ${sha256}, expected ${source.sha256}`);
  }
  return JSON.parse(bytes.toString("utf8"));
}

type Point = [number, number];
type Props = Record<string, string | number | null>;
type Shape = ExtendedFeature;

interface Input {
  id: string;
  name: string;
  shape: Shape;
  projection: GeoProjection;
  inset?: GeoInset["id"];
}

interface Ring {
  region: string;
  points: Point[];
}

function projectRings(shape: Shape, projection: GeoProjection): Point[][] {
  const rings: Point[][] = [];
  let ring: Point[] = [];
  const context = {
    beginPath() {},
    moveTo(x: number, y: number) {
      ring = [];
      rings.push(ring);
      ring.push([Math.round(x * 10), Math.round(y * 10)]);
    },
    lineTo(x: number, y: number) {
      ring.push([Math.round(x * 10), Math.round(y * 10)]);
    },
    closePath() {},
    arc() {},
  };
  geoPath(projection, context)(shape);
  return rings
    .map((r) => {
      const deduped = r.filter((p, i) => {
        const q = r[i - 1];
        return q === undefined || q[0] !== p[0] || q[1] !== p[1];
      });
      const first = deduped[0];
      const last = deduped[deduped.length - 1];
      if (first && last && deduped.length > 1 && first[0] === last[0] && first[1] === last[1]) {
        deduped.pop();
      }
      return deduped;
    })
    .filter((r) => r.length >= 3);
}

const key = (p: Point) => `${p[0]},${p[1]}`;

function triangle(a: Point, b: Point, c: Point): number {
  return Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2;
}

function signedArea(points: Point[]): number {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i] as Point;
    const b = points[(i + 1) % points.length] as Point;
    sum += a[0] * b[1] - b[0] * a[1];
  }
  return sum / 2;
}

interface Entry {
  area: number;
  key: string;
  index: number;
  version: number;
}

const before = (a: Entry, b: Entry) => a.area < b.area || (a.area === b.area && a.key < b.key);

class Heap {
  items: Entry[] = [];
  push(e: Entry) {
    const items = this.items;
    items.push(e);
    let i = items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!before(items[i] as Entry, items[parent] as Entry)) break;
      [items[i], items[parent]] = [items[parent] as Entry, items[i] as Entry];
      i = parent;
    }
  }
  pop(): Entry | undefined {
    const items = this.items;
    const top = items[0];
    const last = items.pop();
    if (items.length > 0 && last) {
      items[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < items.length && before(items[l] as Entry, items[m] as Entry)) m = l;
        if (r < items.length && before(items[r] as Entry, items[m] as Entry)) m = r;
        if (m === i) break;
        [items[i], items[m]] = [items[m] as Entry, items[i] as Entry];
        i = m;
      }
    }
    return top;
  }
}

function visvalingam(points: Point[], pinned: boolean[], tolerance: number): Point[] {
  const n = points.length;
  const prev = points.map((_, i) => (i - 1 + n) % n);
  const next = points.map((_, i) => (i + 1) % n);
  const area = new Array<number>(n).fill(0);
  const version = new Array<number>(n).fill(0);
  const removed = new Array<boolean>(n).fill(false);
  const heap = new Heap();
  const at = (i: number) => points[i] as Point;
  const enqueue = (i: number, floor: number) => {
    if (pinned[i]) return;
    area[i] = Math.max(floor, triangle(at(prev[i] as number), at(i), at(next[i] as number)));
    version[i] = (version[i] as number) + 1;
    heap.push({
      area: area[i] as number,
      key: key(at(i)),
      index: i,
      version: version[i] as number,
    });
  };
  for (let i = 0; i < n; i++) enqueue(i, 0);
  let left = n;
  for (;;) {
    const e = heap.pop();
    if (e === undefined || e.area >= tolerance || left <= 4) break;
    if (removed[e.index] || e.version !== version[e.index]) continue;
    removed[e.index] = true;
    left--;
    const p = prev[e.index] as number;
    const q = next[e.index] as number;
    next[p] = q;
    prev[q] = p;
    enqueue(p, e.area);
    enqueue(q, e.area);
  }
  return points.filter((_, i) => !removed[i]);
}

function simplify(rings: Ring[], tolerance: number): Ring[] {
  const owners = new Map<string, Set<number>>();
  rings.forEach((ring, r) => {
    for (const p of ring.points) {
      const k = key(p);
      const set = owners.get(k) ?? new Set<number>();
      set.add(r);
      owners.set(k, set);
    }
  });
  const signature = (p: Point) => [...(owners.get(key(p)) ?? [])].sort((a, b) => a - b).join(" ");
  return rings.map((ring) => {
    const n = ring.points.length;
    const pinned = ring.points.map((p, i) => {
      if ((owners.get(key(p))?.size ?? 0) < 2) return false;
      const own = signature(p);
      return (
        signature(ring.points[(i - 1 + n) % n] as Point) !== own ||
        signature(ring.points[(i + 1) % n] as Point) !== own
      );
    });
    return { region: ring.region, points: visvalingam(ring.points, pinned, tolerance) };
  });
}

function insideRing(x: number, y: number, ring: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i] as Point;
    const [xj, yj] = ring[j] as Point;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function segmentDistance(x: number, y: number, a: Point, b: Point): number {
  let [px, py] = a;
  let dx = b[0] - px;
  let dy = b[1] - py;
  if (dx !== 0 || dy !== 0) {
    const t = Math.max(0, Math.min(1, ((x - px) * dx + (y - py) * dy) / (dx * dx + dy * dy)));
    px += dx * t;
    py += dy * t;
  }
  dx = x - px;
  dy = y - py;
  return Math.hypot(dx, dy);
}

function polygonDistance(x: number, y: number, polygon: Point[][]): number {
  let inside = false;
  let min = Number.POSITIVE_INFINITY;
  for (const ring of polygon) {
    if (insideRing(x, y, ring)) inside = !inside;
    for (let i = 0; i < ring.length; i++) {
      min = Math.min(
        min,
        segmentDistance(x, y, ring[i] as Point, ring[(i + 1) % ring.length] as Point),
      );
    }
  }
  return inside ? min : -min;
}

function poleOfInaccessibility(polygon: Point[][], precision: number): Point {
  const outer = polygon[0] as Point[];
  const xs = outer.map((p) => p[0]);
  const ys = outer.map((p) => p[1]);
  const x0 = Math.min(...xs);
  const y0 = Math.min(...ys);
  const size = Math.min(Math.max(...xs) - x0, Math.max(...ys) - y0);
  const cell = (x: number, y: number, h: number) => {
    const d = polygonDistance(x, y, polygon);
    return { x, y, h, d, max: d + h * Math.SQRT2 };
  };
  let best = cell(outer[0]?.[0] ?? 0, outer[0]?.[1] ?? 0, 0);
  if (size <= 0) return [best.x, best.y];
  const queue: ReturnType<typeof cell>[] = [];
  const h = size / 2;
  for (let x = x0; x < Math.max(...xs); x += size) {
    for (let y = y0; y < Math.max(...ys); y += size) queue.push(cell(x + h, y + h, h));
  }
  while (queue.length > 0) {
    let top = 0;
    for (let i = 1; i < queue.length; i++)
      if ((queue[i]?.max ?? 0) > (queue[top]?.max ?? 0)) top = i;
    const c = queue.splice(top, 1)[0] as ReturnType<typeof cell>;
    if (c.d > best.d) best = c;
    if (c.max - best.d <= precision) continue;
    const q = c.h / 2;
    queue.push(cell(c.x - q, c.y - q, q), cell(c.x + q, c.y - q, q));
    queue.push(cell(c.x - q, c.y + q, q), cell(c.x + q, c.y + q, q));
  }
  return [best.x, best.y];
}

const tenths = (n: number) => {
  const s = (Math.abs(n) / 10).toString();
  return (n < 0 ? "-" : "") + (s.startsWith("0.") ? s.slice(1) : s);
};

function numbers(values: number[]): string {
  let out = "";
  for (const v of values) {
    const s = tenths(v);
    out += out === "" || s.startsWith("-") ? s : ` ${s}`;
  }
  return out;
}

function pathData(rings: Point[][]): string {
  let out = "";
  let start: Point | undefined;
  for (const ring of rings) {
    const first = ring[0] as Point;
    out +=
      start === undefined
        ? `M${numbers(first)}`
        : `m${numbers([first[0] - start[0], first[1] - start[1]])}`;
    const deltas: number[] = [];
    for (let i = 1; i < ring.length; i++) {
      const p = ring[i] as Point;
      const q = ring[i - 1] as Point;
      deltas.push(p[0] - q[0], p[1] - q[1]);
    }
    out += `l${numbers(deltas)}z`;
    start = first;
  }
  return out;
}

interface Built {
  region: GeoRegion;
  rings: Point[][];
  largest: Point[][];
}

function build(inputs: Input[], tolerance: number, minArea: number): Built[] {
  const rings: Ring[] = inputs.flatMap((input) =>
    projectRings(input.shape, input.projection).map((points) => ({ region: input.id, points })),
  );
  const simplified = simplify(rings, tolerance * 100);
  return inputs.map((input) => {
    const own = simplified
      .filter((r) => r.region === input.id && r.points.length >= 3)
      .map((r) => ({ points: r.points, area: signedArea(r.points) }))
      .filter((r) => r.area !== 0);
    const largest = own.reduce((a, b) => (Math.abs(b.area) > Math.abs(a.area) ? b : a));
    const sign = Math.sign(largest.area);
    const kept = own.filter((r) => r === largest || Math.abs(r.area) >= minArea * 100);
    const outers = kept.filter((r) => Math.sign(r.area) === sign);
    const holes = kept.filter((r) => Math.sign(r.area) !== sign);
    const holesOf = (outer: (typeof kept)[number]) =>
      holes.filter((h) => {
        const [x, y] = h.points[0] as Point;
        const containing = outers
          .filter((o) => insideRing(x, y, o.points))
          .sort((a, b) => Math.abs(a.area) - Math.abs(b.area))[0];
        return containing === outer;
      });
    const polygon = [largest.points, ...holesOf(largest).map((h) => h.points)];
    const label = poleOfInaccessibility(polygon, 2).map((v) => Math.round(v)) as Point;
    if (polygonDistance(label[0], label[1], polygon) <= 0) {
      throw new Error(`${input.id}: label point falls outside the shape`);
    }
    const area = kept.reduce((sum, r) => sum + r.area * sign, 0) / 100;
    const ordered = [...outers.flatMap((o) => [o, ...holesOf(o)])];
    const region: GeoRegion = {
      id: input.id,
      name: input.name,
      d: pathData(ordered.map((r) => r.points)),
      label: [label[0] / 10, label[1] / 10],
      area: Math.round(area * 10) / 10,
    };
    if (input.inset) region.inset = input.inset;
    return { region, rings: ordered.map((r) => r.points), largest: polygon };
  });
}

function bounds(points: Point[]): [number, number, number, number] {
  const xs = points.map((p) => p[0] / 10);
  const ys = points.map((p) => p[1] / 10);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

const W = 975;
const US_H = 610;
const MARGIN = 10;
const MAP_RIGHT = 868;
const INSET_PAD = 6;
const INSET_GAP = 10;
const LEADER_GAP = 21;
const SMALL_STATES = ["VT", "NH", "MA", "RI", "CT", "NJ", "DE", "MD", "DC"];

function usGeography(topology: unknown): Geography {
  const topo = topology as Parameters<typeof feature>[0] & {
    objects: Record<string, Parameters<typeof feature>[1]>;
  };
  const states = topo.objects.states;
  if (states === undefined) throw new Error("us-atlas: no states object");
  const collection = feature(topo, states) as unknown as { features: (Shape & { id?: string })[] };
  const byFips = new Map(US_STATE_ENTRIES.map((s) => [s.fips, s]));
  const found = new Set(collection.features.map((f) => String(f.id)));
  const missing = US_STATE_ENTRIES.filter((s) => !found.has(s.fips)).map((s) => s.usps);
  const unknown = [...found].filter((f) => !byFips.has(f));
  if (missing.length > 0 || unknown.length > 0) {
    throw new Error(`us-atlas: missing ${missing.join(",")}, unknown FIPS ${unknown.join(",")}`);
  }
  const shape = (usps: string) => {
    const fips = US_STATE_ENTRIES.find((s) => s.usps === usps)?.fips;
    return collection.features.find((f) => String(f.id) === fips) as Shape;
  };
  const drawn = US_STATE_ENTRIES.filter((s) => !US_NOT_DRAWN.includes(s.usps));
  const insetIds = new Set(["AK", "HI", "PR"]);
  const mainland = drawn.filter((s) => !insetIds.has(s.usps)).map((s) => shape(s.usps));

  const lower48 = geoConicEqualArea()
    .parallels([29.5, 45.5])
    .rotate([96, 0])
    .center([-0.6, 38.7])
    .precision(0)
    .fitExtent(
      [
        [MARGIN, MARGIN],
        [MAP_RIGHT, US_H - MARGIN],
      ],
      { type: "FeatureCollection", features: mainland },
    );
  const scale = lower48.scale();
  const insetProjections: Record<GeoInset["id"], GeoProjection> = {
    AK: geoConicEqualArea()
      .rotate([154, 0])
      .center([-2, 58.5])
      .parallels([55, 65])
      .scale(scale * 0.3),
    HI: geoConicEqualArea().rotate([157, 0]).center([-3, 19.9]).parallels([8, 18]).scale(scale),
    PR: geoConicEqualArea()
      .rotate([66, 0])
      .center([0, 18])
      .parallels([8, 18])
      .scale(scale * 1.25),
  };
  const insets: GeoInset[] = [];
  let left = MARGIN;
  for (const id of ["AK", "HI", "PR"] as const) {
    const projection = insetProjections[id].precision(0).translate([0, 0]);
    const [[x0, y0], [x1, y1]] = geoPath(projection).bounds(shape(id));
    const width = Math.ceil(x1 - x0 + 2 * INSET_PAD);
    const height = Math.ceil(y1 - y0 + 2 * INSET_PAD);
    const top = US_H - MARGIN - height;
    projection.translate([left + INSET_PAD - x0, top + INSET_PAD - y0]);
    insets.push({ id, x: left, y: top, width, height });
    left += width + INSET_GAP;
  }

  const inputs: Input[] = drawn.map((s) => {
    const inset = insetIds.has(s.usps) ? (s.usps as GeoInset["id"]) : undefined;
    const input: Input = {
      id: s.usps,
      name: s.name,
      shape: shape(s.usps),
      projection: inset ? insetProjections[inset] : lower48,
    };
    if (inset) input.inset = inset;
    return input;
  });
  const built = build(inputs, 0.6, 1.5);

  const mainPoints = built
    .filter((b) => b.region.inset === undefined)
    .flatMap((b) => b.rings.flat());
  for (const inset of insets) {
    const clash = mainPoints.find(
      ([x, y]) =>
        x / 10 >= inset.x - 2 &&
        x / 10 <= inset.x + inset.width + 2 &&
        y / 10 >= inset.y - 2 &&
        y / 10 <= inset.y + inset.height + 2,
    );
    if (clash)
      throw new Error(
        `inset ${inset.id} overlaps the main map at ${clash[0] / 10},${clash[1] / 10}`,
      );
    const region = built.find((b) => b.region.id === inset.id) as Built;
    const [bx0, by0, bx1, by1] = bounds(region.rings.flat());
    if (
      bx0 < inset.x ||
      by0 < inset.y ||
      bx1 > inset.x + inset.width ||
      by1 > inset.y + inset.height
    ) {
      throw new Error(`inset ${inset.id} does not enclose its region`);
    }
  }

  const right = Math.max(...mainPoints.map((p) => p[0] / 10));
  const column = Math.ceil(right + 14);
  if (W - column < 60) throw new Error(`leader column at x=${column} leaves too little room`);
  const small = SMALL_STATES.map(
    (id) => built.find((b) => b.region.id === id)?.region as GeoRegion,
  ).sort((a, b) => a.label[1] - b.label[1]);
  const ys = small.map((r) => r.label[1]);
  for (let i = 1; i < ys.length; i++)
    ys[i] = Math.max(ys[i] as number, (ys[i - 1] as number) + LEADER_GAP);
  const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
  const shift = mean(small.map((r) => r.label[1])) - mean(ys);
  small.forEach((r, i) => {
    r.leader = { x: column, y: Math.round((ys[i] as number) + shift) };
  });

  return {
    id: "us-states",
    version: "us-atlas@3.0.1+hm1",
    source:
      "U.S. Census Bureau cartographic boundary files (public domain), via us-atlas 3.0.1 states-10m",
    projection: "Albers USA composite (Alaska, Hawaii, Puerto Rico insets)",
    width: W,
    height: US_H,
    regions: built.map((b) => b.region).sort((a, b) => (a.id < b.id ? -1 : 1)),
    insets,
    notDrawn: US_STATE_ENTRIES.filter((s) => US_NOT_DRAWN.includes(s.usps))
      .map((s) => ({ id: s.usps, name: s.name }))
      .sort((a, b) => (a.id < b.id ? -1 : 1)),
  };
}

const NAME_OVERRIDES: Record<string, string> = {
  BRN: "Brunei",
  CPV: "Cabo Verde",
  CZE: "Czechia",
  FLK: "Falkland Islands",
  FRO: "Faroe Islands",
  FSM: "Micronesia",
  HMD: "Heard Island and McDonald Islands",
  KOR: "South Korea",
  LAO: "Laos",
  PRK: "North Korea",
  RUS: "Russia",
  SGS: "South Georgia and the South Sandwich Islands",
  SWZ: "Eswatini",
  WLF: "Wallis and Futuna",
};

const NE_NAME_FIELDS = [
  "NAME",
  "NAME_LONG",
  "ADMIN",
  "FORMAL_EN",
  "NAME_SORT",
  "BRK_NAME",
  "NAME_ALT",
  "NAME_EN",
];

const ISO_NOT_IN_NATURAL_EARTH: Country[] = [
  {
    id: "BES",
    name: "Bonaire, Sint Eustatius and Saba",
    drawn: false,
    iso2: "BQ",
    numeric: "535",
    names: ["Caribbean Netherlands"],
  },
  { id: "BVT", name: "Bouvet Island", drawn: false, iso2: "BV", numeric: "074", names: [] },
  {
    id: "CCK",
    name: "Cocos (Keeling) Islands",
    drawn: false,
    iso2: "CC",
    numeric: "166",
    names: [],
  },
  { id: "CXR", name: "Christmas Island", drawn: false, iso2: "CX", numeric: "162", names: [] },
  { id: "GLP", name: "Guadeloupe", drawn: false, iso2: "GP", numeric: "312", names: [] },
  { id: "GUF", name: "French Guiana", drawn: false, iso2: "GF", numeric: "254", names: [] },
  { id: "MTQ", name: "Martinique", drawn: false, iso2: "MQ", numeric: "474", names: [] },
  { id: "MYT", name: "Mayotte", drawn: false, iso2: "YT", numeric: "175", names: [] },
  { id: "REU", name: "Réunion", drawn: false, iso2: "RE", numeric: "638", names: [] },
  {
    id: "SJM",
    name: "Svalbard and Jan Mayen",
    drawn: false,
    iso2: "SJ",
    numeric: "744",
    names: [],
  },
  { id: "TKL", name: "Tokelau", drawn: false, iso2: "TK", numeric: "772", names: [] },
];

interface Country {
  id: string;
  name: string;
  drawn: boolean;
  iso2?: string;
  numeric?: string;
  names: string[];
}

const code = (p: Props, field: string) => {
  for (const f of [field, `${field}_EH`]) {
    const v = p[f];
    if (v !== null && v !== undefined && String(v) !== "-99") return String(v);
  }
  return undefined;
};
const countryId = (p: Props) => code(p, "ISO_A3") ?? String(p.ADM0_A3);

function country(p: Props, drawn: boolean): Country {
  const id = countryId(p);
  const name = NAME_OVERRIDES[id] ?? String(p.NAME_LONG);
  const names = [
    ...new Set(
      NE_NAME_FIELDS.map((f) => p[f]).filter((v): v is string => typeof v === "string" && v !== ""),
    ),
  ].filter((n) => n !== name);
  const c: Country = { id, name, drawn, names };
  const iso2 = code(p, "ISO_A2");
  const numeric = code(p, "ISO_N3");
  if (iso2) c.iso2 = iso2;
  if (numeric) c.numeric = numeric;
  return c;
}

interface NaturalEarth {
  features: (Shape & { properties: Props })[];
}

function worldGeography(
  ne110: NaturalEarth,
  ne10: NaturalEarth,
): { geography: Geography; countries: Country[] } {
  const drawnFeatures = ne110.features.filter((f) => countryId(f.properties) !== "ATA");
  const projection = geoEqualEarth().precision(0);
  projection.fitWidth(W - 2 * MARGIN, { type: "FeatureCollection", features: drawnFeatures });
  const [[x0, y0], [, y1]] = geoPath(projection).bounds({
    type: "FeatureCollection",
    features: drawnFeatures,
  });
  const [tx, ty] = projection.translate();
  projection.translate([tx + MARGIN - x0, ty + MARGIN - y0]);
  const height = Math.ceil(y1 - y0 + 2 * MARGIN);
  const inputs: Input[] = drawnFeatures.map((f) => {
    const c = country(f.properties, true);
    return { id: c.id, name: c.name, shape: f, projection };
  });
  const built = build(inputs, 0.5, 1);
  const countries = ne110.features.map((f) =>
    country(f.properties, countryId(f.properties) !== "ATA"),
  );
  const seen = new Set(countries.map((c) => c.id));
  for (const f of ne10.features) {
    const id = countryId(f.properties);
    if (seen.has(id) || code(f.properties, "ISO_A2") === undefined) continue;
    seen.add(id);
    countries.push(country(f.properties, false));
  }
  for (const c of ISO_NOT_IN_NATURAL_EARTH) {
    if (seen.has(c.id))
      throw new Error(`${c.id} is in Natural Earth now; drop it from the extra ISO list`);
    countries.push(c);
  }
  countries.sort((a, b) => (a.id < b.id ? -1 : 1));
  return {
    countries,
    geography: {
      id: "world-countries",
      version: "natural-earth@5.1.2+hm1",
      source: "Natural Earth 1:110m admin 0 countries 5.1.2 (public domain)",
      projection: "Equal Earth",
      width: W,
      height,
      regions: built.map((b) => b.region).sort((a, b) => (a.id < b.id ? -1 : 1)),
      insets: [],
      notDrawn: countries.filter((c) => !c.drawn).map((c) => ({ id: c.id, name: c.name })),
    },
  };
}

const HEADER = (from: string) => [
  `// Generated by scripts/build-boundaries.ts from ${from}.`,
  "// Do not edit; run pnpm gen:boundaries.",
  "",
];

function geographyModule(name: string, from: string, g: Geography): string {
  const region = (r: GeoRegion) => {
    const fields = [
      `id: ${JSON.stringify(r.id)}`,
      `name: ${JSON.stringify(r.name)}`,
      ...(r.inset ? [`inset: ${JSON.stringify(r.inset)}`] : []),
      `area: ${r.area}`,
      `label: [${r.label[0]}, ${r.label[1]}]`,
      ...(r.leader ? [`leader: { x: ${r.leader.x}, y: ${r.leader.y} }`] : []),
      `d: ${JSON.stringify(r.d)}`,
    ];
    return `    { ${fields.join(", ")} },`;
  };
  return [
    ...HEADER(from),
    'import type { Geography } from "./types.js";',
    "",
    `export const ${name}: Geography = {`,
    `  id: ${JSON.stringify(g.id)},`,
    `  version: ${JSON.stringify(g.version)},`,
    `  source: ${JSON.stringify(g.source)},`,
    `  projection: ${JSON.stringify(g.projection)},`,
    `  width: ${g.width},`,
    `  height: ${g.height},`,
    `  insets: ${JSON.stringify(g.insets)},`,
    `  notDrawn: [${g.notDrawn.map((n) => JSON.stringify(n)).join(", ")}],`,
    "  regions: [",
    ...g.regions.map(region),
    "  ],",
    "};",
    "",
  ].join("\n");
}

function codesModule(countries: Country[]): string {
  return [
    ...HEADER("Natural Earth 5.1.2 admin 0 countries (1:110m and 1:10m attributes, public domain)"),
    "export interface WorldCountryEntry {",
    "  id: string;",
    "  name: string;",
    "  drawn: boolean;",
    "  iso2?: string;",
    "  numeric?: string;",
    "  names: readonly string[];",
    "}",
    "",
    "export const WORLD_COUNTRY_ENTRIES: readonly WorldCountryEntry[] = [",
    ...countries.map((c) => `  ${JSON.stringify(c)},`),
    "];",
    "",
  ].join("\n");
}

function write(file: string, text: string): void {
  writeFileSync(new URL(file, OUT), text);
  const raw = Buffer.byteLength(text);
  const gz = gzipSync(text, { level: 9 }).length;
  console.log(`${file}: ${(raw / 1024).toFixed(1)} KB, ${(gz / 1024).toFixed(1)} KB gzipped`);
  if (file !== "world-codes.ts" && gz > BUDGET)
    throw new Error(`${file} is over the ${BUDGET / 1024} KB gzip budget`);
}

const [usTopology, ne110, ne10] = await Promise.all([
  load(SOURCES.usAtlas),
  load(SOURCES.ne110) as Promise<NaturalEarth>,
  load(SOURCES.ne10) as Promise<NaturalEarth>,
]);
const us = usGeography(usTopology);
const world = worldGeography(ne110, ne10);
write(
  "us-states.ts",
  geographyModule("US_STATES", "us-atlas 3.0.1 states-10m (U.S. Census Bureau, public domain)", us),
);
write(
  "world-countries.ts",
  geographyModule(
    "WORLD_COUNTRIES",
    "Natural Earth 5.1.2 1:110m admin 0 countries (public domain)",
    world.geography,
  ),
);
write("world-codes.ts", codesModule(world.countries));
