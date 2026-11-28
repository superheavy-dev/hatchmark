import { describe, expect, it } from "vitest";
import { GALLERY } from "../../gallery/variants.js";
import type { MapData } from "../../src/compiler/dashboard-data.js";
import { cssPaint, DEFAULT_THEME, type RenderContext } from "../../src/render/index.js";
import { breakLabels } from "../../src/render/map.js";

const variant = GALLERY.find((v) => v.variant === "map-us-rate");
if (variant === undefined) throw new Error("map-us-rate gallery variant missing");
const { data } = variant;
const block = data.blocks[0] as MapData;
const ctx: RenderContext = { data, theme: DEFAULT_THEME, paint: cssPaint };

describe("map legend", () => {
  it("keeps the compact break labels when they already differ", () => {
    const labels = breakLabels(
      { ...block, scale: { ...block.scale, breaks: [80, 100, 120] } },
      ctx,
    );
    expect(labels).toEqual(["$80.00", "$100.00", "$120.00"]);
  });

  it("adds decimals until breaks that round alike read apart", () => {
    const labels = breakLabels(
      { ...block, scale: { ...block.scale, breaks: [100, 100.001, 100.002] } },
      ctx,
    );
    expect(new Set(labels).size).toBe(3);
    expect(labels).toEqual(["$100.000", "$100.001", "$100.002"]);
  });
});
