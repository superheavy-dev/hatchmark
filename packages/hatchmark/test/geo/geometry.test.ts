import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import type { Geography, GeoRegion } from "../../src/geo/types.js";
import { US_STATES } from "../../src/geo/us-states.js";
import { WORLD_COUNTRIES } from "../../src/geo/world-countries.js";

type Point = [number, number];

function rings(d: string): Point[][] {
  const tokens = d.match(/[MmLlZz]|-?(?:\d+\.?\d*|\.\d+)/g) ?? [];
  const out: Point[][] = [];
  let command = "";
  let start: Point = [0, 0];
  let current: Point = [0, 0];
  let ring: Point[] = [];
  for (let i = 0; i < tokens.length; ) {
    const token = tokens[i] as string;
    if (/[A-Za-z]/.test(token)) {
      command = token;
      i++;
      if (command === "z" || command === "Z") {
        out.push(ring);
        current = start;
      }
      continue;
    }
    const x = Number(token);
    const y = Number(tokens[i + 1]);
    i += 2;
    const relative = command === "m" || command === "l";
    current = relative ? [current[0] + x, current[1] + y] : [x, y];
    if (command === "M" || command === "m") {
      start = current;
      ring = [current];
      command = command === "m" ? "l" : "L";
    } else ring.push(current);
  }
  return out;
}

function inside([x, y]: Point, polygon: Point[][]): boolean {
  let result = false;
  for (const ring of polygon) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i] as Point;
      const [xj, yj] = ring[j] as Point;
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) result = !result;
    }
  }
  return result;
}

const bbox = (points: Point[]) => ({
  x0: Math.min(...points.map((p) => p[0])),
  y0: Math.min(...points.map((p) => p[1])),
  x1: Math.max(...points.map((p) => p[0])),
  y1: Math.max(...points.map((p) => p[1])),
});

describe.each([
  ["us-states.ts", US_STATES],
  ["world-countries.ts", WORLD_COUNTRIES],
] as [string, Geography][])("%s", (file, geography) => {
  const parsed = new Map(geography.regions.map((r) => [r.id, rings(r.d)]));

  it("has unique ids in sorted order and sorted not-drawn ids", () => {
    const ids = geography.regions.map((r) => r.id);
    expect(ids).toEqual([...new Set(ids)].sort());
    const notDrawn = geography.notDrawn.map((n) => n.id);
    expect(notDrawn).toEqual([...new Set(notDrawn)].sort());
    expect(ids.filter((id) => notDrawn.includes(id))).toEqual([]);
  });

  it("draws every region with finite coordinates inside the viewBox", () => {
    for (const region of geography.regions) {
      const points = (parsed.get(region.id) ?? []).flat();
      expect(points.length, region.id).toBeGreaterThan(3);
      expect(
        points.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y)),
        region.id,
      ).toBe(true);
      const box = bbox(points);
      expect(box.x0, region.id).toBeGreaterThanOrEqual(0);
      expect(box.y0, region.id).toBeGreaterThanOrEqual(0);
      expect(box.x1, region.id).toBeLessThanOrEqual(geography.width);
      expect(box.y1, region.id).toBeLessThanOrEqual(geography.height);
      expect(region.area, region.id).toBeGreaterThan(0);
    }
  });

  it("puts every label point inside its region", () => {
    for (const region of geography.regions) {
      const polygon = parsed.get(region.id) ?? [];
      const box = bbox(polygon.flat());
      const [x, y] = region.label;
      expect(x >= box.x0 && x <= box.x1 && y >= box.y0 && y <= box.y1, region.id).toBe(true);
      expect(inside(region.label, polygon), region.id).toBe(true);
    }
  });

  it("stays within 40 KB gzipped", () => {
    const source = readFileSync(new URL(`../../src/geo/${file}`, import.meta.url));
    expect(gzipSync(source, { level: 9 }).length).toBeLessThanOrEqual(40 * 1024);
  });
});

describe("us-states geography", () => {
  const byId = new Map(US_STATES.regions.map((r) => [r.id, r]));
  const points = (r: GeoRegion) => rings(r.d).flat();

  it("draws the 50 states, DC and Puerto Rico, and lists the other territories", () => {
    expect(US_STATES.regions).toHaveLength(52);
    expect(byId.has("DC")).toBe(true);
    expect(byId.has("PR")).toBe(true);
    expect(US_STATES.notDrawn.map((n) => n.id)).toEqual(["AS", "GU", "MP", "VI"]);
  });

  it("draws Alaska, Hawaii and Puerto Rico inside their inset frames, clear of the main map", () => {
    expect(US_STATES.insets.map((i) => i.id)).toEqual(["AK", "HI", "PR"]);
    const main = US_STATES.regions.filter((r) => r.inset === undefined).flatMap(points);
    for (const frame of US_STATES.insets) {
      const region = byId.get(frame.id) as GeoRegion;
      expect(region.inset).toBe(frame.id);
      const box = bbox(points(region));
      expect(box.x0).toBeGreaterThan(frame.x);
      expect(box.y0).toBeGreaterThan(frame.y);
      expect(box.x1).toBeLessThan(frame.x + frame.width);
      expect(box.y1).toBeLessThan(frame.y + frame.height);
      expect(frame.y + frame.height).toBeLessThanOrEqual(US_STATES.height);
      const clash = main.filter(
        ([x, y]) =>
          x >= frame.x && x <= frame.x + frame.width && y >= frame.y && y <= frame.y + frame.height,
      );
      expect(clash, frame.id).toEqual([]);
    }
  });

  it("places the small Northeast labels in a column right of the map, without overlap", () => {
    const small = ["CT", "DC", "DE", "MA", "MD", "NH", "NJ", "RI", "VT"];
    expect(US_STATES.regions.filter((r) => r.leader).map((r) => r.id)).toEqual(small);
    const right = Math.max(
      ...US_STATES.regions
        .filter((r) => !r.inset)
        .flatMap(points)
        .map((p) => p[0]),
    );
    const leaders = small.map((id) => byId.get(id)?.leader as { x: number; y: number });
    const ys = leaders.map((l) => l.y).sort((a, b) => a - b);
    for (const leader of leaders) {
      expect(leader.x).toBeGreaterThan(right);
      expect(US_STATES.width - leader.x).toBeGreaterThanOrEqual(60);
      expect(leader.y).toBeGreaterThan(0);
      expect(leader.y).toBeLessThan(US_STATES.height);
    }
    expect(new Set(leaders.map((l) => l.x)).size).toBe(1);
    for (let i = 1; i < ys.length; i++)
      expect((ys[i] as number) - (ys[i - 1] as number)).toBeGreaterThanOrEqual(18);
  });
});

describe("world-countries geography", () => {
  it("leaves out Antarctica and lists it as not drawn", () => {
    expect(WORLD_COUNTRIES.regions.some((r) => r.id === "ATA")).toBe(false);
    expect(WORLD_COUNTRIES.notDrawn).toContainEqual({ id: "ATA", name: "Antarctica" });
    expect(WORLD_COUNTRIES.insets).toEqual([]);
  });

  it("draws Kosovo, Northern Cyprus and Somaliland under their Natural Earth codes", () => {
    const ids = WORLD_COUNTRIES.regions.map((r) => r.id);
    expect(ids).toEqual(
      expect.arrayContaining(["KOS", "CYN", "SOL", "FRA", "NOR", "ESH", "PSE", "TWN"]),
    );
  });

  it("is about 975 wide with the southern ocean cropped", () => {
    expect(WORLD_COUNTRIES.width).toBe(975);
    expect(WORLD_COUNTRIES.height).toBeLessThan(475);
  });
});
