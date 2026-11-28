import type { GeographyId } from "../spec/units.js";
import type { Geography } from "./types.js";
import { US_STATES } from "./us-states.js";
import { WORLD_COUNTRIES } from "./world-countries.js";

export * from "./aliases.js";
export type * from "./types.js";

/** Every geography's boundaries, by id. */
export const GEOGRAPHY_DATA: Record<GeographyId, Geography> = {
  "us-states": US_STATES,
  "world-countries": WORLD_COUNTRIES,
};

/** The geographies a dashboard's map blocks draw, by id. */
export function usedGeographies(
  blocks: readonly { type: string; geo?: GeographyId }[],
): Partial<Record<GeographyId, Geography>> {
  const out: Partial<Record<GeographyId, Geography>> = {};
  for (const b of blocks)
    if (b.type === "map" && b.geo !== undefined) out[b.geo] = GEOGRAPHY_DATA[b.geo];
  return out;
}

/**
 * A classic script that registers a geography for the period engine, which redraws maps from
 * boundaries the page loads on demand rather than carrying them in the engine itself.
 */
export function geographyScript(geography: Geography): string {
  return `(self.hatchmarkGeo=self.hatchmarkGeo||{})[${JSON.stringify(geography.id)}]=${JSON.stringify(geography)};\n`;
}
