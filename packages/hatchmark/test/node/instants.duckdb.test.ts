import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { formatInstant, fromLocal, parseInstant } from "../../src/compiler/instants.js";
import { Oracle } from "./fixture.js";

let oracle: Oracle;
beforeAll(async () => {
  oracle = await Oracle.open();
});
afterAll(() => oracle.close());

const ZONES = [
  "America/New_York",
  "Australia/Sydney",
  "Europe/London",
  "America/Santiago",
  "Pacific/Auckland",
  "Pacific/Chatham",
  "Antarctica/McMurdo",
  "Australia/Lord_Howe",
];

describe("fromLocal reads a local wall time the way DuckDB reads a naive timestamp", () => {
  it.each(ZONES)(
    "agrees with DuckDB every quarter hour of 2026's transition days in %s",
    async (zone) => {
      const walls: string[] = [];
      for (let day = Date.UTC(2026, 0, 1); day < Date.UTC(2027, 0, 1); day += 86_400_000) {
        const date = new Date(day).toISOString().slice(0, 10);
        const offsets = new Set(
          [0, 12, 23].map(
            (h) =>
              new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "longOffset" })
                .formatToParts(new Date(day + h * 3_600_000))
                .find((p) => p.type === "timeZoneName")?.value,
          ),
        );
        if (offsets.size === 1) continue;
        const next = new Date(day + 86_400_000).toISOString().slice(0, 10);
        for (const local of [date, next]) {
          for (let q = 0; q < 96; q++) {
            const hh = String(Math.floor(q / 4)).padStart(2, "0");
            const mm = String((q % 4) * 15).padStart(2, "0");
            walls.push(`${local}T${hh}:${mm}:00`);
          }
        }
      }
      expect(walls.length).toBeGreaterThan(0);
      const rows = await oracle.rows(
        `SELECT w, epoch_us(timezone('${zone}', CAST(w AS TIMESTAMP))) AS us FROM (VALUES ${walls
          .map((w) => `('${w}')`)
          .join(",")}) t(w) ORDER BY w`,
      );
      const mismatches = rows
        .map((r) => [r.w as string, formatInstant(BigInt(r.us as number))])
        .filter(([w, duck]) => formatInstant(fromLocal(parseInstant(w as string), zone)) !== duck);
      expect(mismatches).toEqual([]);
    },
  );
});
