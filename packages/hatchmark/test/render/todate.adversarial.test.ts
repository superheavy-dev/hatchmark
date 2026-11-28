import { afterEach, describe, expect, it } from "vitest";
import { timeOf } from "../../src/render/partial.js";

const saved = process.env.TZ;
afterEach(() => {
  process.env.TZ = saved;
});

describe("the in-progress time is the project's wall time on any build machine", () => {
  for (const tz of ["UTC", "Pacific/Kiritimati", "Pacific/Pago_Pago", "Asia/Kathmandu"]) {
    it("under TZ=" + tz, () => {
      process.env.TZ = tz;
      expect(timeOf("2026-11-26T14:03:00.000001", "en-US")).toMatch(/^2:03[\s\u202f]PM$/u);
      expect(timeOf("2026-11-01T00:30:00.000000", "en-US")).toMatch(/^12:30[\s\u202f]AM$/u);
    });
  }
});
