import { describe, expect, it } from "vitest";
import { tileGeography } from "../../src/geo/index.js";
import { US_STATES } from "../../src/geo/us-states.js";

describe.each(["square", "hex"] as const)("%s tile grid", (shape) => {
  const tiles = tileGeography(shape);

  it("has one tile for every region the us-states map draws, with its name", () => {
    expect(tiles.regions.map((r) => [r.id, r.name])).toEqual(
      US_STATES.regions.map((r) => [r.id, r.name]),
    );
  });

  it("keeps every tile inside the viewBox and apart from every other", () => {
    for (const r of tiles.regions) {
      const points = [...r.d.matchAll(/(-?[\d.]+),(-?[\d.]+)/g)].map((m) => [
        Number(m[1]),
        Number(m[2]),
      ]);
      for (const [x, y] of points) {
        expect(x, r.id).toBeGreaterThanOrEqual(0);
        expect(y, r.id).toBeGreaterThanOrEqual(0);
        expect(x, r.id).toBeLessThanOrEqual(tiles.width);
        expect(y, r.id).toBeLessThanOrEqual(tiles.height);
      }
    }
    for (const a of tiles.regions)
      for (const b of tiles.regions) {
        if (a.id >= b.id) continue;
        const distance = Math.hypot(a.label[0] - b.label[0], a.label[1] - b.label[1]);
        expect(distance, `${a.id} ${b.id}`).toBeGreaterThan(9.9);
      }
  });
});
