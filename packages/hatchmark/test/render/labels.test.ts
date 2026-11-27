import { describe, expect, it } from "vitest";
import { stackLabels, thinTicks } from "../../src/render/index.js";

describe("stackLabels", () => {
  it("keeps labels at their targets when they do not overlap", () => {
    expect(stackLabels([20, 60, 100], 16, 2, 0, 200)).toEqual([20, 60, 100]);
  });

  it("separates overlapping labels by height plus a 2 px gap around their mean, in bounds", () => {
    const centres = stackLabels([100, 101, 102], 16, 2, 0, 200);
    expect(centres).toEqual([83, 101, 119]);
    const edge = stackLabels([198, 199], 16, 2, 0, 200);
    expect(edge).toEqual([174, 192]);
    const sorted = stackLabels([50, 10, 48], 16, 2, 0, 200);
    expect(sorted[1]).toBeLessThan(sorted[2] as number);
    expect((sorted[0] as number) - (sorted[2] as number)).toBeGreaterThanOrEqual(18);
  });

  it("is a pure function of its input", () => {
    const input = [120, 118, 40, 41, 42, 300];
    expect(stackLabels(input, 16, 2, 0, 280)).toEqual(stackLabels([...input], 16, 2, 0, 280));
  });
});

describe("thinTicks", () => {
  it("picks the smallest step whose labels keep the minimum gap", () => {
    const candidates = Array.from({ length: 12 }, (_, i) => ({
      pos: 20 + i * 30,
      width: 40,
      phase: i,
    }));
    const kept = thinTicks(candidates, [1, 2, 3, 4, 6], 8, 0, 400);
    expect(kept.map((k) => k.index)).toEqual([0, 2, 4, 6, 8, 10]);
  });
});
