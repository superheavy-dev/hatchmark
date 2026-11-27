import type { TableData, TableRow } from "../src/compiler/dashboard-data.js";
import { OCT, round } from "./fixtures.js";

/**
 * Grouped tables on data other than region and country, for the narrow layouts: long product and
 * campaign names, a team with one person, three levels, numeric and date-like groups, and an empty
 * group value. Rows, subtotals, Other rows and totals are all sums of the same leaf parts.
 */

type Key = string | number | null;
interface Leaf {
  keys: Key[];
  revenue: number;
  orders: number;
}

const values = (parts: Leaf[]) => {
  const revenue = parts.reduce((a, p) => a + p.revenue, 0);
  const orders = parts.reduce((a, p) => a + p.orders, 0);
  return { revenue, orders, avg_order_value: orders === 0 ? null : revenue / orders };
};

const sameGroup = (a: Key[], b: Key[]) => a.every((k, i) => k === b[i]);

function grouped(
  id: string,
  title: string,
  by: [string, string][],
  leaves: Leaf[],
  options: { subtotals?: boolean; limit?: number } = {},
): TableData {
  const width = by.length;
  const total = values(leaves).revenue;
  const row = (keys: Key[], parts: Leaf[], extra: Partial<TableRow> = {}): TableRow => {
    const v = values(parts);
    return { keys, ...extra, values: v, share: { revenue: v.revenue / total } };
  };
  const pad = (keys: Key[]) => [
    ...keys,
    ...Array.from({ length: width - keys.length }, () => null),
  ];
  const cut = (parts: Leaf[], parent: Key[]): TableRow[] => {
    const sorted = [...parts].sort((a, b) => b.revenue - a.revenue);
    const shown = options.limit === undefined ? sorted : sorted.slice(0, options.limit);
    const rest = sorted.slice(shown.length);
    return [
      ...shown.map((p) => row(p.keys, [p])),
      ...(rest.length > 0 ? [row(pad(parent), rest, { kind: "other", count: rest.length })] : []),
    ];
  };
  const nest = (parts: Leaf[], parent: Key[]): TableRow[] => {
    const level = parent.length + 1;
    if (level === width) return cut(parts, parent);
    const groups: Key[][] = [];
    for (const p of parts) {
      const keys = p.keys.slice(0, level);
      if (!groups.some((g) => sameGroup(g, keys))) groups.push(keys);
    }
    return groups
      .map((keys) => ({ keys, parts: parts.filter((p) => sameGroup(keys, p.keys)) }))
      .sort((a, b) => values(b.parts).revenue - values(a.parts).revenue)
      .flatMap((g) => [
        row(pad(g.keys), g.parts, { kind: "subtotal", level, count: g.parts.length }),
        ...nest(g.parts, g.keys),
      ]);
  };
  return {
    type: "table",
    id,
    title,
    span: 12,
    by: by.map(([column, label]) => ({ column, label })),
    metrics: ["revenue", "orders", "avg_order_value"],
    percentOfTotal: ["revenue"],
    rows: options.subtotals ? nest(leaves, []) : cut(leaves, []),
    rowCount: leaves.length,
    total: { values: values(leaves), share: { revenue: 1 } },
    ...(options.subtotals ? { subtotals: true } : {}),
    sort: { by: "revenue", order: "desc" },
    window: OCT,
  };
}

/** Leaf parts from [keys, revenue, average order value]. */
const leaves = (rows: [Key[], number, number][]): Leaf[] =>
  rows.map(([keys, revenue, aov]) => ({ keys, revenue, orders: round(revenue / aov) }));

export const TABLE_GROUP_PRODUCTS = grouped(
  "group_products",
  "Tents lead October revenue, but two jackets outsell most of them",
  [
    ["category", "Category"],
    ["product", "Product"],
  ],
  leaves([
    [["Tents and shelters", "Ridgeline 2 ultralight backpacking tent with vestibule"], 96_400, 412],
    [["Tents and shelters", "Basecamp 6 family cabin tent with screened porch"], 61_250, 538],
    [["Tents and shelters", "Bivy sack, waterproof breathable, regular"], 12_900, 189],
    [["Outerwear", "Stormline 3-layer Gore-Tex shell jacket, men's"], 74_300, 329],
    [["Outerwear", "Stormline 3-layer Gore-Tex shell jacket, women's"], 70_150, 329],
    [["Outerwear", "Packable insulated hoodie"], 22_800, 149],
    [
      [
        "Climbing hardware, ropes, harnesses and protection",
        "Dynamic rope 9.5 mm × 70 m, dry-treated",
      ],
      18_600,
      239,
    ],
    [
      ["Climbing hardware, ropes, harnesses and protection", "Locking carabiner, set of 6"],
      7_450,
      59,
    ],
  ]),
);

export const TABLE_GROUP_CAMPAIGNS = grouped(
  "group_campaigns",
  "Paid search drives most revenue; the holiday preview campaign leads it",
  [
    ["channel", "Channel"],
    ["campaign", "Campaign"],
  ],
  leaves([
    [
      ["Paid search", "2026-Q4 Holiday gift guide preview — brand + generic, US & Canada"],
      88_200,
      96,
    ],
    [["Paid search", "Always-on competitor conquesting (broad match), all regions"], 41_700, 88],
    [["Paid search", "Retargeting: abandoned carts over $150, 30-day window"], 29_350, 131],
    [["Paid search", "New store openings, Denver and Austin metro"], 9_800, 74],
    [["Paid search", "Spring clearance (paused)"], 2_100, 52],
    [["Email", "VIP early access: Black Friday weekend, members with 3+ orders"], 64_900, 142],
    [["Email", "Win-back series, lapsed 180 days"], 18_250, 83],
    [["Social", "Creator collab — trail running capsule (Instagram Reels and TikTok)"], 23_400, 77],
    [["Social", "Lookalike prospecting, 1% US"], 11_100, 69],
  ]),
  { subtotals: true, limit: 3 },
);

export const TABLE_GROUP_TEAMS = grouped(
  "group_teams",
  "Enterprise sales closed the most; Partnerships is one person",
  [
    ["team", "Team"],
    ["owner", "Account owner"],
  ],
  leaves([
    [["Enterprise sales", "Maria Gonzalez"], 182_500, 12_166],
    [["Enterprise sales", "James O'Connor"], 141_000, 10_846],
    [["Enterprise sales", "Wei Zhang"], 96_300, 9_630],
    [["Mid-market", "Aisha Bello"], 88_750, 4_438],
    [["Mid-market", "Lukas Schneider"], 61_200, 4_080],
    [["Partnerships", "Priya Raman"], 74_900, 6_242],
  ]),
  { subtotals: true },
);

export const TABLE_GROUP_CITIES = grouped(
  "group_cities",
  "New York and Toronto lead their countries; Sydney is Australia's only store",
  [
    ["region", "Region"],
    ["country", "Country"],
    ["city", "City"],
  ],
  leaves([
    [["North America", "United States", "New York"], 142_300, 94],
    [["North America", "United States", "San Francisco"], 118_900, 101],
    [["North America", "United States", "Chicago"], 64_200, 88],
    [["North America", "Canada", "Toronto"], 58_400, 86],
    [["North America", "Canada", "Vancouver"], 37_100, 90],
    [["Europe", "United Kingdom", "London"], 96_800, 83],
    [["Europe", "United Kingdom", "Manchester"], 21_300, 77],
    [["Europe", "Germany", "Berlin"], 44_600, 89],
    [["Europe", "Germany", "Munich"], 39_900, 95],
    [["Asia-Pacific", "Australia", "Sydney"], 52_700, 95],
  ]),
  { subtotals: true },
);

export const TABLE_GROUP_YEARS = grouped(
  "group_years",
  "2026 is ahead of 2025 in every quarter so far",
  [
    ["year", "Year"],
    ["quarter", "Quarter"],
  ],
  leaves([
    [[2025, "Q1"], 1_120_400, 81],
    [[2025, "Q2"], 1_284_900, 83],
    [[2025, "Q3"], 1_356_100, 84],
    [[2025, "Q4"], 1_998_300, 88],
    [[2026, "Q1"], 1_241_700, 82],
    [[2026, "Q2"], 1_402_600, 84],
    [[2026, "Q3"], 1_517_800, 86],
  ]),
  { subtotals: true },
);

export const TABLE_GROUP_SEATS = grouped(
  "group_seats",
  "Most recurring revenue comes from 25- and 50-seat Business plans",
  [
    ["plan", "Plan tier"],
    ["seats", "Seat count"],
  ],
  leaves([
    [["Business", 50], 412_500, 8_250],
    [["Business", 25], 388_000, 4_125],
    [["Enterprise", 250], 296_000, 74_000],
    [["Team", 10], 184_800, 1_320],
    [["Business", 10], 121_500, 1_650],
    [["Team", 5], 96_600, 660],
    [["Enterprise", 1000], 88_000, 88_000],
    [["Starter", 1], 41_300, 118],
    [["Team", 1], 12_400, 132],
  ]),
);

export const TABLE_GROUP_EMPTY = grouped(
  "group_empty",
  "One in eight orders has no recorded channel",
  [
    ["channel", "Channel"],
    ["source", "Source"],
  ],
  leaves([
    [["Organic", "google.com"], 214_300, 86],
    [["Paid", "Google Ads"], 168_900, 91],
    [[null, "(direct)"], 121_400, 84],
    [["Organic", "bing.com"], 38_200, 88],
    [["Paid", "Meta"], 74_500, 79],
    [[null, null], 22_700, 81],
    [["Referral", "reddit.com"], 19_800, 92],
  ]),
);
