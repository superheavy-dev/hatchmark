import { describe, expect, it } from "vitest";
import { COLUMNS, generateOrders } from "../src/dataset.ts";

describe("generateOrders", () => {
  const csv = generateOrders(2000);
  const lines = csv.trimEnd().split("\n");

  it("writes exactly the requested rows under the header", () => {
    expect(lines[0]).toBe(COLUMNS.join(","));
    expect(lines).toHaveLength(2001);
  });

  it("is byte-identical across runs", () => {
    expect(generateOrders(2000)).toBe(csv);
  });

  it("spans Nov 2024 to Oct 2026 in UTC and covers every region and status", () => {
    const rows = lines.slice(1).map((line) => line.split(","));
    const times = rows.map((row) => row[1] ?? "").sort();
    expect(times[0]?.startsWith("2024-11-01")).toBe(true);
    expect(times.at(-1)?.startsWith("2026-10-31")).toBe(true);
    expect(new Set(rows.map((row) => row[4]))).toEqual(new Set(["Americas", "EMEA", "APAC"]));
    expect(new Set(rows.map((row) => row[7]))).toEqual(new Set(["paid", "refunded"]));
  });
});
