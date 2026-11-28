import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const DATASET_START = Date.UTC(2024, 10, 1);
export const DATASET_END = Date.UTC(2026, 9, 31);
export const PERIOD_START = "2025-11-01";
export const PERIOD_END = "2026-11-01";
export const DEFAULT_ROWS = 500_000;
export const COLUMNS = [
  "order_id",
  "ordered_at",
  "customer_id",
  "country",
  "region",
  "channel",
  "category",
  "status",
  "amount",
] as const;

const DAY = 86_400_000;

const COUNTRIES = [
  ["United States", "Americas", 42],
  ["United Kingdom", "EMEA", 9],
  ["Canada", "Americas", 7],
  ["Germany", "EMEA", 6],
  ["Australia", "APAC", 5],
  ["France", "EMEA", 4],
  ["Japan", "APAC", 3],
  ["Brazil", "Americas", 3],
  ["Mexico", "Americas", 2.5],
  ["Netherlands", "EMEA", 2],
  ["Spain", "EMEA", 2],
  ["India", "APAC", 2],
  ["Italy", "EMEA", 1.5],
  ["Sweden", "EMEA", 1.5],
  ["Singapore", "APAC", 1.5],
  ["Ireland", "EMEA", 1],
  ["New Zealand", "APAC", 1],
  ["South Korea", "APAC", 1],
  ["United Arab Emirates", "EMEA", 1],
  ["South Africa", "EMEA", 0.8],
  ["Argentina", "Americas", 0.7],
] as const;

const CHANNELS = [
  ["Organic search", 30],
  ["Paid search", 22],
  ["Direct", 14],
  ["Social", 14],
  ["Email", 12],
  ["Affiliate", 6],
] as const;

const CATEGORIES = [
  ["Apparel", 65, 0.07, 30],
  ["Home", 90, 0.05, 22],
  ["Electronics", 180, 0.09, 18],
  ["Beauty", 40, 0.04, 18],
  ["Outdoor", 120, 0.06, 12],
] as const;

const SEASON = [0.85, 0.8, 0.9, 0.95, 1, 0.95, 0.9, 0.95, 1, 1.05, 1.35, 1.45];

export function mulberry32(seed: number): () => number {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function weightedPicker<T>(items: readonly T[], weight: (item: T) => number) {
  const cumulative: number[] = [];
  let total = 0;
  for (const item of items) {
    total += weight(item);
    cumulative.push(total);
  }
  return (r: number): T => {
    const target = r * total;
    const index = cumulative.findIndex((c) => target < c);
    return items[index === -1 ? items.length - 1 : index] as T;
  };
}

const pad = (n: number, width = 2): string => String(n).padStart(width, "0");

export function generateOrders(rows: number, seed = 20261128): string {
  const random = mulberry32(seed);
  const normal = () => Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random());
  const country = weightedPicker(COUNTRIES, (c) => c[2]);
  const channel = weightedPicker(CHANNELS, (c) => c[1]);
  const category = weightedPicker(CATEGORIES, (c) => c[3]);
  const days: number[] = [];
  for (let t = DATASET_START; t <= DATASET_END; t += DAY) days.push(t);
  const dayWeight = (t: number) => {
    const date = new Date(t);
    const progress = (t - DATASET_START) / (DATASET_END - DATASET_START);
    const weekend = date.getUTCDay() === 0 || date.getUTCDay() === 6 ? 1.1 : 1;
    return (1 + 0.7 * progress) * (SEASON[date.getUTCMonth()] ?? 1) * weekend;
  };
  const totalWeight = days.reduce((sum, t) => sum + dayWeight(t), 0);
  const lines: string[] = [COLUMNS.join(",")];
  const customerPool = Math.max(100, Math.round(rows / 4));
  let carry = 0;
  let id = 1_000_000;
  for (const t of days) {
    const exact = (rows * dayWeight(t)) / totalWeight + carry;
    const count = t === DATASET_END ? rows - (id - 1_000_000) : Math.floor(exact);
    carry = exact - count;
    const progress = (t - DATASET_START) / (DATASET_END - DATASET_START);
    const seconds = Array.from({ length: count }, () => Math.floor(random() * 86_400)).sort(
      (a, b) => a - b,
    );
    for (const second of seconds) {
      const at = new Date(t + second * 1000);
      const [countryName, region] = country(random());
      const [categoryName, price, refund] = category(random());
      const customer = 1 + Math.floor(random() ** 1.6 * customerPool);
      const amount = Math.max(5, price * Math.exp(0.45 * normal() - 0.1));
      const status = random() < refund * (1.15 - 0.3 * progress) ? "refunded" : "paid";
      lines.push(
        [
          id++,
          `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())} ${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())}:${pad(at.getUTCSeconds())}`,
          `C${pad(customer, 7)}`,
          countryName,
          region,
          channel(random())[0],
          categoryName,
          status,
          amount.toFixed(2),
        ].join(","),
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

export function writeOrders(path: string, rows: number): number {
  const csv = generateOrders(rows);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, csv);
  return csv.split("\n").length - 2;
}
