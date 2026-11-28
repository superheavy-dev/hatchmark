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

  it("reads tiny thresholds apart", () => {
    const labels = breakLabels(
      { ...block, scale: { ...block.scale, breaks: [0.00000001, 0.00000002, 0.00000003] } },
      ctx,
    );
    expect(new Set(labels).size).toBe(3);
  });

  it.each([
    { type: "number" },
    { type: "currency", currency: "USD" },
    { type: "percent" },
    { type: "number", compact: true },
  ] as const)("never gives adjacent classes the same label (%o)", (format) => {
    let seed = 7;
    const rand = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    const metrics = { ...data.metrics, [block.metric]: { ...data.metrics[block.metric], format } };
    const at = { ...ctx, data: { ...data, metrics } } as RenderContext;
    for (let trial = 0; trial < 400; trial++) {
      const base = (rand() - 0.3) * 10 ** Math.floor(rand() * 40 - 25);
      const step = Math.abs(base || 1) * 10 ** -Math.floor(rand() * 16) * (0.5 + rand());
      const raw = Array.from({ length: 2 + Math.floor(rand() * 5) }, (_, i) => base + i * step);
      const breaks = raw.filter((b, i) => i === 0 || b > (raw[i - 1] as number));
      const labels = breakLabels({ ...block, scale: { ...block.scale, breaks } }, at);
      for (let i = 1; i < labels.length; i++)
        expect(labels[i], `${breaks.join(", ")}`).not.toBe(labels[i - 1]);
    }
  });
});
