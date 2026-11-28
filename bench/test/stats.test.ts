import { describe, expect, it } from "vitest";
import { summarize } from "../src/stats.ts";

describe("summarize", () => {
  it("returns the median and quartiles with linear interpolation", () => {
    expect(summarize([5, 1, 3, 2, 4])).toEqual({ n: 5, median: 3, p25: 2, p75: 4, min: 1, max: 5 });
    expect(summarize([1, 2, 3, 4])).toEqual({
      n: 4,
      median: 2.5,
      p25: 1.75,
      p75: 3.25,
      min: 1,
      max: 4,
    });
  });

  it("ignores missing values and returns null when nothing is left", () => {
    expect(summarize([null, 7, undefined, Number.NaN])?.median).toBe(7);
    expect(summarize([null, undefined])).toBeNull();
  });
});
