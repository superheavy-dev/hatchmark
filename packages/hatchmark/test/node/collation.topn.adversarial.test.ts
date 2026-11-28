import { afterAll, describe, expect, it } from "vitest";
import type { PieData, TableData } from "../../src/compiler/index.js";
import { PROJECT_DEFAULTS } from "../../src/spec/index.js";
import { metric, Oracle, removeProjects, run, writeProject } from "./fixture.js";

afterAll(removeProjects);

const POOL = [
  "Österreich",
  "Osterreich",
  "O\u0308sterreich",
  "Zebra",
  "zebra",
  "Ärzte",
  "Arzte",
  "Ångström",
  "Item 2",
  "Item 02",
  "Item 10",
  "item 3",
  "İstanbul",
  "Istanbul",
  "istanbul",
  "ıgdır",
  "Iğdır",
  "東京",
  "とうきょう",
  "トウキョウ",
  "大阪",
  "おおさか",
  "ａｂｃ",
  "abc",
  "ABC",
  "1",
  "10",
  "2",
  "x1",
  "x10",
  "x9",
  "Øre",
  "Ære",
  "Ål",
  "ß",
  "ss",
  "ﬁ",
  "fi",
  "",
];
const LOCALES = ["en-US", "de-DE", "sv-SE", "ja-JP", "tr-TR"];
const SEEDS = process.env.HM_SWEEP === "full" ? 60 : 20;

function random(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const quote = (s: string) => (/[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s);
const codeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

async function build(locale: string, lines: string[], block: Record<string, unknown>) {
  const fixture = await writeProject({
    "hatchmark.yaml": {
      ...PROJECT_DEFAULTS,
      locale,
      name: "Sweep",
      sources: { orders: { type: "csv", path: "orders.csv", freshness: { through: "as_of" } } },
    },
    "orders.csv": `day,name,amount\n${lines.join("\n")}\n`,
    "metrics/amount.yaml": metric({
      table: "orders",
      time: "day",
      type: "aggregate",
      aggregate: "sum",
      column: "amount",
    }),
    "dashboards/probe.yaml": {
      title: "Probe",
      period: { asOf: "2026-02-28", range: "all_time", compare: "none" },
      blocks: [block],
    },
  });
  const { data, diagnostics } = await run(fixture.root, fixture.project, "probe");
  const result = data?.blocks[0];
  if (result === undefined) throw new Error(JSON.stringify(diagnostics));
  return { block: result, csv: `${fixture.root}/orders.csv` };
}

describe("Top-N on text keys in the project locale", () => {
  it("keeps SQL totals and Other, cuts only exact ties by collation, and ignores input order", async () => {
    const oracle = await Oracle.open();
    let ties = 0;
    try {
      for (let seed = 1; seed <= SEEDS; seed++) {
        const rand = random(seed);
        const locale = LOCALES[seed % LOCALES.length] as string;
        const keys = POOL.filter(() => rand() < 0.45);
        if (keys.length < 4) continue;
        const lines: string[] = [];
        for (const key of keys) {
          const parts = 1 + Math.floor(rand() * 3);
          const target = [10, 20, 30, 40][Math.floor(rand() * 4)] as number;
          for (let p = 0; p < parts; p++) {
            const amount = p === parts - 1 ? target - (parts - 1) * 2.5 : 2.5;
            lines.push(`2026-01-0${1 + p},${quote(key)},${amount}`);
          }
        }
        const limit = 1 + Math.floor(rand() * (keys.length - 1));
        const shuffled = [...lines].sort(() => rand() - 0.5);
        const spec = { type: "table", by: ["name"], metrics: ["amount"], limit, other: true };
        const built = await build(locale, lines, spec);
        const table = built.block as TableData;
        const again = (await build(locale, shuffled, spec)).block as TableData;
        expect(JSON.stringify(again.rows), `shuffled, seed ${seed}`).toBe(
          JSON.stringify(table.rows),
        );

        const source = `read_csv('${built.csv}', all_varchar=true)`;
        const groups = await oracle.rows(
          `SELECT name, sum(CAST(amount AS DOUBLE)) AS v FROM ${source} GROUP BY name`,
        );
        const [whole] = await oracle.rows(`SELECT sum(CAST(amount AS DOUBLE)) AS v FROM ${source}`);
        const total = whole?.v as number;
        const per = new Map(groups.map((r) => [r.name as string | null, r.v as number]));
        const kept = table.rows.filter((r) => r.kind !== "other");
        const other = table.rows.find((r) => r.kind === "other");
        expect(table.total?.values.amount, `total, seed ${seed}`).toBeCloseTo(total, 9);
        for (const r of kept) {
          expect(r.values.amount, `row ${String(r.keys[0])}`).toBe(
            per.get((r.keys[0] ?? null) as string | null),
          );
        }
        const keptSum = kept.reduce((s, r) => s + (r.values.amount as number), 0);
        if (per.size > limit) {
          expect(other?.count, `Other count, seed ${seed}`).toBe(per.size - limit);
          expect(other?.values.amount, `Other, seed ${seed}`).toBeCloseTo(total - keptSum, 9);
        }

        const cut = Math.min(...kept.map((r) => r.values.amount as number));
        const keptKeys = new Set(kept.map((r) => r.keys[0] ?? null));
        for (const [key, v] of per) {
          if (v > cut) expect(keptKeys.has(key), `above the cut: ${String(key)}`).toBe(true);
          if (v < cut) expect(keptKeys.has(key), `below the cut: ${String(key)}`).toBe(false);
        }
        const collator = new Intl.Collator(locale, { numeric: true });
        const tied = [...per].filter(([, v]) => v === cut).map(([k]) => k);
        const named = tied.filter((k): k is string => k !== null);
        const expected = [
          ...named.sort((x, y) => collator.compare(x, y) || codeUnit(x, y)),
          ...(tied.includes(null) ? [null] : []),
        ];
        const atCut = kept.filter((r) => r.values.amount === cut).map((r) => r.keys[0] ?? null);
        expect(atCut, `ties at the cut, seed ${seed}`).toEqual(expected.slice(0, atCut.length));
        if (per.size > limit && atCut.length < tied.length) ties++;

        const pieLimit = Math.min(limit, 12);
        const pie = (
          await build(locale, lines, { type: "pie", metric: "amount", by: "name", limit: pieLimit })
        ).block as PieData;
        const pieSum = pie.slices.reduce((s, x) => s + x.value, 0) + (pie.other?.value ?? 0);
        expect(pieSum, `pie whole, seed ${seed}`).toBeCloseTo(total, 9);
        expect(
          pie.slices.map((s) => s.key ?? null),
          `pie against table, seed ${seed}`,
        ).toEqual(kept.slice(0, pieLimit).map((r) => r.keys[0] ?? null));
      }
    } finally {
      oracle.close();
    }
    expect(ties).toBeGreaterThan(0);
  }, 600_000);
});
