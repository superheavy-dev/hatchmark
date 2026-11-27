import { describe, expect, it } from "vitest";
import { formatInstant, fromLocal, parseInstant, toLocal } from "../../src/compiler/instants.js";

const local = (wall: string, timezone: string) =>
  formatInstant(fromLocal(parseInstant(wall), timezone));

describe("fromLocal across daylight saving changes", () => {
  it.each([
    ["America/New_York", "2026-03-08T01:30:00", "2026-03-08T06:30:00.000000Z"],
    ["America/New_York", "2026-03-08T02:00:00", "2026-03-08T07:00:00.000000Z"],
    ["America/New_York", "2026-03-08T02:30:00", "2026-03-08T07:30:00.000000Z"],
    ["America/New_York", "2026-03-08T03:00:00", "2026-03-08T07:00:00.000000Z"],
    ["Australia/Sydney", "2026-10-04T01:30:00", "2026-10-03T15:30:00.000000Z"],
    ["Australia/Sydney", "2026-10-04T02:30:00", "2026-10-03T16:30:00.000000Z"],
    ["Australia/Sydney", "2026-10-04T03:00:00", "2026-10-03T16:00:00.000000Z"],
  ])(
    "reads %s %s, in or around the spring-forward gap, with the offset before the change",
    (zone, wall, expected) => {
      expect(local(wall, zone)).toBe(expected);
    },
  );

  it.each([
    ["America/New_York", "2026-11-01T00:30:00", "2026-11-01T04:30:00.000000Z"],
    ["America/New_York", "2026-11-01T01:00:00", "2026-11-01T05:00:00.000000Z"],
    ["America/New_York", "2026-11-01T01:30:00", "2026-11-01T05:30:00.000000Z"],
    ["America/New_York", "2026-11-01T02:00:00", "2026-11-01T07:00:00.000000Z"],
    ["Australia/Sydney", "2026-04-05T01:30:00", "2026-04-04T14:30:00.000000Z"],
    ["Australia/Sydney", "2026-04-05T02:30:00", "2026-04-04T15:30:00.000000Z"],
    ["Australia/Sydney", "2026-04-05T03:00:00", "2026-04-04T17:00:00.000000Z"],
  ])(
    "reads %s %s, in or around the fall-back overlap, as its first occurrence",
    (zone, wall, expected) => {
      expect(local(wall, zone)).toBe(expected);
    },
  );

  it.each(["America/New_York", "Australia/Sydney"])(
    "round-trips every quarter hour of 2026 in %s that the zone's clocks show",
    (zone) => {
      const start = parseInstant("2026-01-01T00:00:00Z");
      const step = 15n * 60n * 1_000_000n;
      for (let us = start; us < start + 365n * 86_400_000_000n; us += step) {
        const wall = toLocal(us, zone);
        expect(toLocal(fromLocal(wall, zone), zone)).toBe(wall);
      }
    },
  );
});
