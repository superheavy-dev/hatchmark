import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJson, planHash, type QueryPlan, sha256Hex } from "../../src/compiler/index.js";
import { DEFAULT_ANCHORS } from "../../src/spec/index.js";

const PLAN: QueryPlan = {
  version: 2,
  dashboard: "sales",
  period: { asOf: "latest_data", range: "last_complete_month", compare: "previous_period" },
  timezone: "America/New_York",
  anchors: { ...DEFAULT_ANCHORS, week: "monday" },
  params: [
    {
      id: "region",
      kind: "select",
      column: "region",
      operator: "in",
      multiple: false,
      default: ["West"],
      sources: ["orders"],
    },
  ],
  blocks: [
    {
      blockId: "revenue",
      pointer: "/blocks/0",
      queryIds: ["q1"],
      measures: { revenue: { op: "ref", queryId: "q1", metric: "revenue" } },
    },
  ],
  queries: [
    {
      id: "q1",
      source: "orders",
      input: { type: "csv", path: "data/orders.csv" },
      measures: [
        {
          metric: "revenue",
          components: [
            {
              id: "revenue__sum",
              aggregate: "sum",
              column: "amount",
              filters: [],
              reaggregate: "sum",
            },
          ],
          combine: { op: "identity", component: "revenue__sum" },
        },
      ],
      dimensions: [],
      groupingSets: [[]],
      window: { range: "last_complete_month", shift: "none", column: "ordered_at" },
      params: [
        {
          id: "region",
          kind: "select",
          source: "orders",
          column: "region",
          operator: "in",
          multiple: false,
          default: ["West"],
        },
      ],
    },
  ],
  materialization: { q1: { kind: "grouped", filterColumns: ["region"] } },
};

function reverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .reverse()
      .map(([k, v]) => [k, reverseKeys(v)]),
  );
}

describe("sha256Hex", () => {
  it("matches node:crypto on ASCII, multibyte text and every padding boundary", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    const samples = ["São Paulo — 東京 👩‍💻", "x".repeat(1000)];
    for (let n = 0; n < 130; n++) samples.push("a".repeat(n));
    for (const text of samples) {
      expect(sha256Hex(text)).toBe(createHash("sha256").update(text, "utf8").digest("hex"));
    }
  });
});

describe("planHash", () => {
  it("is the same across runs and runtimes (golden value)", () => {
    expect(planHash(PLAN)).toBe(GOLDEN);
  });

  it("ignores key order, undefined properties and the sign of zero", () => {
    expect(planHash(reverseKeys(PLAN) as QueryPlan)).toBe(planHash(PLAN));
    expect(planHash({ ...PLAN, extra: undefined } as QueryPlan)).toBe(planHash(PLAN));
    expect(canonicalJson({ b: [-0, 1.5], a: "é" })).toBe('{"a":"é","b":[0,1.5]}');
  });

  it("changes when a filter is retargeted, its default changes, or the version changes", () => {
    const retarget = structuredClone(PLAN);
    const param = retarget.queries[0]?.params[0];
    if (param?.kind === "select") param.column = "state";
    const regionDefault = structuredClone(PLAN);
    const other = regionDefault.queries[0]?.params[0];
    if (other?.kind === "select") other.default = ["East"];
    const hashes = [
      planHash(PLAN),
      planHash(retarget),
      planHash(regionDefault),
      planHash({ ...PLAN, version: 1 } as unknown as QueryPlan),
      planHash({ ...PLAN, timezone: "UTC" }),
    ];
    expect(new Set(hashes).size).toBe(hashes.length);
  });

  it("keeps array order and string bytes, and rejects values JSON cannot carry exactly", () => {
    expect(canonicalJson([[0, 1], [0]])).not.toBe(canonicalJson([[0], [0, 1]]));
    expect(canonicalJson("e\u0301")).not.toBe(canonicalJson("\u00e9"));
    expect(() => canonicalJson({ n: Number.NaN })).toThrow(TypeError);
    expect(() => canonicalJson({ n: Number.POSITIVE_INFINITY })).toThrow(TypeError);
    expect(() => canonicalJson({ d: new Date(0) })).toThrow(TypeError);
    expect(() => canonicalJson({ b: 1n })).toThrow(TypeError);
  });
});

const GOLDEN = "aca2eb6445581fedd641d731894529430d52610ca3b9690f49f00b4ca98b4714";
