import { afterAll, describe, expect, it } from "vitest";
import { explainDefaults, type LineData } from "../../src/compiler/index.js";
import { PROJECT_DEFAULTS } from "../../src/spec/index.js";
import { metric, removeProjects, run, writeProject } from "./fixture.js";

afterAll(removeProjects);

const DAYS: string[] = [];
for (let t = Date.UTC(2024, 0, 1, 12); t <= Date.UTC(2026, 11, 31, 12); t += 86_400_000) {
  DAYS.push(new Date(t).toISOString());
}

const GRAINS: unknown[] = [
  { unit: "week", anchor: "monday" },
  { unit: "week", anchor: "sunday" },
  "month",
  "quarter",
  { unit: "year", anchor: "07-01" },
];
const AS_OF = ["2026-11-27", "2026-03-01", "2026-01-01", "2026-07-15"];
const RANGES: unknown[] = [
  "last_30_days",
  "last_90_days",
  "year_to_date",
  "last_12_months",
  { last: 10, unit: "week" },
];

const day = (date: string, weekday: boolean) =>
  new Date(`${date}T00:00:00Z`)
    .toLocaleDateString("en-US", {
      ...(weekday ? { weekday: "short" } : {}),
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    })
    .replace(",", "");

describe("the edges note names the window the engine compiles (HM4040)", () => {
  it.each(AS_OF.flatMap((asOf) => RANGES.map((range) => [asOf, range] as const)))(
    "as of %s, %j",
    async (asOf, range) => {
      const fixture = await writeProject({
        "hatchmark.yaml": {
          ...PROJECT_DEFAULTS,
          name: "Defaults",
          timezone: "UTC",
          sources: { orders: { type: "csv", path: "orders.csv" } },
        },
        "orders.csv": `at,v\n${DAYS.map((d) => `${d},1`).join("\n")}\n`,
        "metrics/orders.yaml": metric({
          type: "aggregate",
          table: "orders",
          aggregate: "sum",
          column: "v",
          time: "at",
        }),
        "dashboards/d.yaml": {
          title: "D",
          period: { asOf, range, compare: "none" },
          blocks: GRAINS.flatMap((grain, i) => [
            { type: "line", id: `s${i}`, metrics: ["orders"], grain },
            { type: "line", id: `c${i}`, metrics: ["orders"], grain, edges: "clip" },
          ]),
        },
      });
      const notes = explainDefaults(fixture.project).filter((d) =>
        d.message.startsWith("uses edges"),
      );
      const { data } = await run(fixture.root, fixture.project, "d");
      const axis = (id: string) => {
        const a = (data?.blocks.find((b) => b.id === id) as LineData).axis;
        if (a.kind !== "time") throw new Error("expected a time axis");
        return a;
      };
      expect(notes.map((d) => d.pointer)).toEqual(GRAINS.map((_, i) => `/blocks/${2 * i}/grain`));
      GRAINS.forEach((grain, i) => {
        const first = axis(`s${i}`).buckets[0] as string;
        const start = axis(`c${i}`).window.start;
        const unit = typeof grain === "string" ? grain : (grain as { unit: string }).unit;
        const message = notes[i]?.message;
        if (first < start) {
          expect(message, `block s${i}`).toBe(
            `uses edges "snap": the first ${unit} starts on ${day(first, unit === "week")}, before the range starts on ${day(start, false)}`,
          );
        } else {
          expect(first, `block s${i}`).toBe(start);
          expect(message, `block s${i}`).toBe(
            `uses edges "snap": the first ${unit} starts at the start of the ${unit} that holds the range start`,
          );
        }
      });
    },
  );
});
