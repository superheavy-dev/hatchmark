import { regionName } from "./aliases.js";
import type { Geography, GeoRegion } from "./types.js";

export type TileShape = "square" | "hex";

const GRID: Record<string, [column: number, row: number]> = {
  AK: [0, 0],
  ME: [11, 0],
  VT: [10, 1],
  NH: [11, 1],
  WA: [1, 2],
  ID: [2, 2],
  MT: [3, 2],
  ND: [4, 2],
  MN: [5, 2],
  IL: [6, 2],
  WI: [7, 2],
  MI: [8, 2],
  NY: [9, 2],
  RI: [10, 2],
  MA: [11, 2],
  OR: [1, 3],
  NV: [2, 3],
  WY: [3, 3],
  SD: [4, 3],
  IA: [5, 3],
  IN: [6, 3],
  OH: [7, 3],
  PA: [8, 3],
  NJ: [9, 3],
  CT: [10, 3],
  CA: [1, 4],
  UT: [2, 4],
  CO: [3, 4],
  NE: [4, 4],
  MO: [5, 4],
  KY: [6, 4],
  WV: [7, 4],
  VA: [8, 4],
  MD: [9, 4],
  DE: [10, 4],
  AZ: [2, 5],
  NM: [3, 5],
  KS: [4, 5],
  AR: [5, 5],
  TN: [6, 5],
  NC: [7, 5],
  SC: [8, 5],
  DC: [9, 5],
  OK: [4, 6],
  LA: [5, 6],
  MS: [6, 6],
  AL: [7, 6],
  GA: [8, 6],
  HI: [0, 7],
  TX: [4, 7],
  FL: [8, 7],
  PR: [10, 7],
};

const PITCH = 10;
const GAP = 0.6;
const HEX_ROW = PITCH * (Math.sqrt(3) / 2);
const round = (n: number) => Math.round(n * 100) / 100;

function tile(shape: TileShape, column: number, row: number): Pick<GeoRegion, "d" | "label"> {
  if (shape === "square") {
    const x = column * PITCH + GAP / 2;
    const y = row * PITCH + GAP / 2;
    const s = PITCH - GAP;
    return {
      d: `M${round(x)},${round(y)}h${round(s)}v${round(s)}h${round(-s)}Z`,
      label: [round(x + s / 2), round(y + s / 2)],
    };
  }
  const cx = column * PITCH + PITCH / 2 + (row % 2 === 1 ? PITCH / 2 : 0);
  const cy = row * HEX_ROW + PITCH / Math.sqrt(3);
  const r = (PITCH - GAP) / Math.sqrt(3);
  const points = [90, 150, 210, 270, 330, 30].map((deg) => {
    const a = (deg * Math.PI) / 180;
    return `${round(cx + r * Math.cos(a))},${round(cy - r * Math.sin(a))}`;
  });
  return { d: `M${points.join("L")}Z`, label: [round(cx), round(cy)] };
}

const cache = new Map<TileShape, Geography>();

/**
 * The US as a grid of equal tiles, one per state, DC and Puerto Rico, arranged roughly as they lie
 * on the map: square tiles in a 12 by 8 grid, or pointy-top hexagons with every other row shifted
 * by half a tile. Every region gets the same area, so small states read as clearly as large ones.
 */
export function tileGeography(shape: TileShape): Geography {
  const known = cache.get(shape);
  if (known !== undefined) return known;
  const regions = Object.entries(GRID)
    .map(([id, [column, row]]): GeoRegion => {
      const { d, label } = tile(shape, column, row);
      return { id, name: regionName("us-states", id) ?? id, d, label, area: PITCH * PITCH };
    })
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  const rows = Math.max(...Object.values(GRID).map(([, row]) => row)) + 1;
  const geography: Geography = {
    id: "us-states",
    version: `tiles-${shape}`,
    source: "Hatchmark",
    projection: shape === "square" ? "square tile grid" : "hex tile grid",
    width: 12 * PITCH + (shape === "hex" ? PITCH / 2 : 0),
    height:
      shape === "square" ? rows * PITCH : round((rows - 1) * HEX_ROW + (2 * PITCH) / Math.sqrt(3)),
    regions,
    insets: [],
    notDrawn: [],
    labels: "inside",
  };
  cache.set(shape, geography);
  return geography;
}
