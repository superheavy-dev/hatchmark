/**
 * Text keys in the order each locale's collation gives them, written out by hand: German and
 * English sort accented letters with their base letter, Swedish sorts Å, Ä and Ö after Z; case
 * breaks ties lowercase first, and digits compare as numbers ("Item 2" before "Item 10").
 */
export const NAMES: [string, number][] = [
  ["Zebra", 140],
  ["Item 10", 130],
  ["Österreich", 120],
  ["apple", 110],
  ["Aaron", 100],
  ["Ärzte", 90],
  ["Oslo", 80],
  ["Éclair", 70],
  ["Zambia", 60],
  ["Item 2", 50],
  ["Ångström", 40],
  ["eclair", 30],
  ["Apple", 20],
  ["item 3", 10],
];

export const EN = [
  "Aaron",
  "Ångström",
  "apple",
  "Apple",
  "Ärzte",
  "eclair",
  "Éclair",
  "Item 2",
  "item 3",
  "Item 10",
  "Oslo",
  "Österreich",
  "Zambia",
  "Zebra",
];

export const SV = [
  "Aaron",
  "apple",
  "Apple",
  "eclair",
  "Éclair",
  "Item 2",
  "item 3",
  "Item 10",
  "Oslo",
  "Zambia",
  "Zebra",
  "Ångström",
  "Ärzte",
  "Österreich",
];

export const EXPECTED: Record<string, string[]> = { "en-US": EN, "de-DE": EN, "sv-SE": SV };

export const csv = (rows: [string, number][]) =>
  `day,name,amount\n${rows.map(([name, amount]) => `2026-01-05,${name},${amount}`).join("\n")}\n`;
