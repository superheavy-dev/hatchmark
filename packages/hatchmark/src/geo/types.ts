/** One drawable region of a geography, pre-projected into the geography's viewBox. */
export interface GeoRegion {
  /** us-states: USPS code ("CA"); world-countries: ISO 3166-1 alpha-3 ("USA"), or the Natural Earth ADM0_A3 code for regions without one (KOS, CYN, SOL). */
  id: string;
  /** English display name. */
  name: string;
  /** SVG path data in viewBox units, one subpath per ring; holes wind opposite to their outer ring. */
  d: string;
  /** A point inside the region's largest polygon, for a label or a leader-line anchor. */
  label: [number, number];
  /** Projected area in viewBox units squared. */
  area: number;
  /** The inset frame the region is drawn in, when it is not drawn on the main map. */
  inset?: "AK" | "HI" | "PR";
  /** Where the label of a region too small to label in place sits, outside the map. */
  leader?: { x: number; y: number };
}

/** A boxed inset frame of a composite projection. */
export interface GeoInset {
  id: "AK" | "HI" | "PR";
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A set of regions drawn together in one viewBox. */
export interface Geography {
  id: "us-states" | "world-countries";
  version: string;
  source: string;
  projection: string;
  width: number;
  height: number;
  /** Sorted by id. */
  regions: GeoRegion[];
  insets: GeoInset[];
  /** Regions that rows can name but this geography does not draw, sorted by id. */
  notDrawn: { id: string; name: string }[];
  /** "inside": every region is large enough to carry its id as a label at its label point. */
  labels?: "inside";
}
