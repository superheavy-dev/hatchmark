// Writes data/orders.csv for the global-sales example: a fictional online store selling worldwide,
// about 5,000 orders over the 24 months ending 2026-10-31. Deterministic: the same script always
// writes the same bytes. Run: node examples/global-sales/generate.mjs (from packages/hatchmark).
import { writeFileSync } from "node:fs";

let seed = 20261031;
function random() {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function pick(weighted) {
  const total = weighted.reduce((sum, [, w]) => sum + w, 0);
  let r = random() * total;
  for (const [value, w] of weighted) {
    r -= w;
    if (r < 0) return value;
  }
  return weighted.at(-1)[0];
}

function poisson(lambda) {
  const limit = Math.exp(-lambda);
  let k = 0;
  for (let p = random(); p > limit; p *= random()) k++;
  return k;
}

function normal() {
  return Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random());
}

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
].map(([country, region, weight]) => [{ country, region }, weight]);

const CHANNELS = [
  ["Organic search", 30],
  ["Paid search", 22],
  ["Direct", 14],
  ["Social", 14],
  ["Email", 12],
  ["Affiliate", 6],
  ["", 2],
];

const CATEGORIES = [
  [{ name: "Apparel", price: 65, refund: 0.07 }, 30],
  [{ name: "Home", price: 90, refund: 0.05 }, 22],
  [{ name: "Electronics", price: 180, refund: 0.09 }, 18],
  [{ name: "Beauty", price: 40, refund: 0.04 }, 18],
  [{ name: "Outdoor", price: 120, refund: 0.06 }, 12],
];

const SEASON = [0.85, 0.8, 0.9, 0.95, 1, 0.95, 0.9, 0.95, 1, 1.05, 1.35, 1.45];
const START = Date.UTC(2024, 10, 1);
const END = Date.UTC(2026, 9, 31);
const DAY = 86_400_000;
const pad = (n, width = 2) => String(n).padStart(width, "0");

const lines = ["order_id,ordered_at,customer_id,country,region,channel,category,status,amount"];
let id = 100_000;
let customers = 400;
for (let t = START; t <= END; t += DAY) {
  const date = new Date(t);
  const progress = (t - START) / (END - START);
  const weekend = [0, 6].includes(date.getUTCDay()) ? 1.1 : 1;
  const lambda = (5 + 3.5 * progress) * SEASON[date.getUTCMonth()] * weekend;
  const count = Math.max(t === END ? 1 : 0, poisson(lambda));
  const times = Array.from({ length: count }, () => 12 * 3600 + Math.floor(random() * 12 * 3600));
  for (const seconds of times.sort((a, b) => a - b)) {
    const at = new Date(t + seconds * 1000);
    const stamp = `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}T${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())}:${pad(at.getUTCSeconds())}Z`;
    customers += random() < 0.45 ? 1 : 0;
    const customer = random() < 0.45 ? customers : 1 + Math.floor(random() ** 1.6 * customers);
    const { country, region } = pick(COUNTRIES);
    const category = pick(CATEGORIES);
    const amount = Math.max(5, category.price * Math.exp(0.45 * normal() - 0.1));
    const status = random() < category.refund * (1.15 - 0.3 * progress) ? "refunded" : "paid";
    lines.push(
      [
        id++,
        stamp,
        `C${pad(customer, 5)}`,
        country,
        region,
        pick(CHANNELS),
        category.name,
        status,
        amount.toFixed(2),
      ].join(","),
    );
  }
}
writeFileSync(new URL("data/orders.csv", import.meta.url), `${lines.join("\n")}\n`);
console.log(`wrote ${lines.length - 1} orders`);
