import { describe, expect, it } from "vitest";
import { SALES } from "../../gallery/variants.js";
import { formatValue, type NumberStyle, renderDashboardPage } from "../../src/render/index.js";

interface LocaleRules {
  decimal: string;
  group: RegExp;
  currency: RegExp;
  units: [string, number][];
  firstUnit: number;
}

const LOCALES: Record<string, LocaleRules> = {
  "en-US": {
    decimal: ".",
    group: /,/g,
    currency: /\$/g,
    units: [
      ["K", 1e3],
      ["M", 1e6],
      ["B", 1e9],
      ["T", 1e12],
    ],
    firstUnit: 1e3,
  },
  "en-GB": {
    decimal: ".",
    group: /,/g,
    currency: /US\$|\$/g,
    units: [
      ["bn", 1e9],
      ["tn", 1e12],
      ["k", 1e3],
      ["m", 1e6],
    ],
    firstUnit: 1e3,
  },
  "de-DE": {
    decimal: ",",
    group: /\./g,
    currency: /\$/g,
    units: [
      ["Mio.", 1e6],
      ["Mrd.", 1e9],
      ["Bio.", 1e12],
    ],
    firstUnit: 1e6,
  },
  "fr-FR": {
    decimal: ",",
    group: /[\u00a0\u202f]/g,
    currency: /\$US|\$/g,
    units: [
      ["Md", 1e9],
      ["Bn", 1e12],
      ["k", 1e3],
      ["M", 1e6],
    ],
    firstUnit: 1e3,
  },
  "es-ES": {
    decimal: ",",
    group: /\./g,
    currency: /US\$|\$/g,
    units: [
      ["mil M", 1e9],
      ["mil", 1e3],
      ["M", 1e6],
      ["B", 1e12],
    ],
    firstUnit: 1e3,
  },
  "ja-JP": {
    decimal: ".",
    group: /,/g,
    currency: /\$/g,
    units: [
      ["万", 1e4],
      ["億", 1e8],
      ["兆", 1e12],
    ],
    firstUnit: 1e4,
  },
  "ko-KR": {
    decimal: ".",
    group: /,/g,
    currency: /US\$|\$/g,
    units: [
      ["천", 1e3],
      ["만", 1e4],
      ["억", 1e8],
      ["조", 1e12],
    ],
    firstUnit: 1e3,
  },
};

type Format =
  | { type: "currency"; currency: "USD"; decimals?: number; compact?: boolean }
  | { type: "number"; decimals?: number; compact?: boolean };

const FORMATS: Format[] = [
  { type: "currency", currency: "USD" },
  { type: "currency", currency: "USD", decimals: 2 },
  { type: "currency", currency: "USD", compact: true },
  { type: "number" },
  { type: "number", decimals: 0 },
  { type: "number", compact: true },
];

const STYLES: NumberStyle[] = ["compact", "headline", "full"];

function read(text: string, rules: LocaleRules): { value: number; unit?: number } {
  let rest = text.replace(rules.currency, "").replace(/\s/g, " ");
  let unit: number | undefined;
  for (const [name, factor] of rules.units) {
    if (rest.includes(name)) {
      unit = factor;
      rest = rest.replace(name, "");
      break;
    }
  }
  const digits = rest
    .replace(rules.group, "")
    .replace(/[ \u00a0\u202f]/g, "")
    .replace("\u2212", "-")
    .replace(rules.decimal, ".");
  expect(digits, text).toMatch(/^-?\d+(\.\d+)?$/);
  return { value: Number(digits) * (unit ?? 1), ...(unit === undefined ? {} : { unit }) };
}

function normalDecimals(format: Format, value: number): number {
  if (format.decimals !== undefined) return format.decimals;
  if (format.type === "currency") return 0;
  return Number.isInteger(value) ? 0 : 1;
}

const roundTo = (value: number, decimals: number) =>
  (Math.sign(value) * Math.round(Math.abs(value) * 10 ** decimals)) / 10 ** decimals;

function values(firstUnit: number): number[] {
  const near = [firstUnit - 1, firstUnit - 0.5, firstUnit - 7.25, firstUnit + 1, firstUnit * 1.234];
  return [
    0.5,
    12.34,
    108.5,
    999,
    1001,
    1234.5,
    4283,
    9994,
    9999,
    10_001,
    99_999,
    257_123,
    999_499,
    999_999,
    1_234_567,
    98_765_432,
    ...near,
  ].flatMap((v) => [v, -v]);
}

describe("compact numbers never round without a unit", () => {
  for (const [locale, rules] of Object.entries(LOCALES)) {
    it(locale, () => {
      for (const format of FORMATS) {
        for (const style of STYLES) {
          for (const value of values(rules.firstUnit)) {
            const text = formatValue(value, { format }, locale, style);
            const label = `${locale} ${JSON.stringify(format)} ${style} ${value} -> ${text}`;
            const shown = read(text, rules);
            if (shown.unit === undefined) {
              expect(shown.value, label).toBe(roundTo(value, normalDecimals(format, value)));
            } else {
              expect(Math.abs(value), label).toBeGreaterThanOrEqual(rules.firstUnit * 0.995);
              expect(Math.abs(shown.value - value) / Math.abs(value), label).toBeLessThanOrEqual(
                0.005,
              );
            }
          }
        }
      }
    });
  }

  it("keeps the unit at each locale's first compact unit and the exact value just below it", () => {
    const usd = { format: { type: "currency", currency: "USD" } } as const;
    for (const [locale, rules] of Object.entries(LOCALES)) {
      expect(read(formatValue(rules.firstUnit, usd, locale, "compact"), rules).unit, locale).toBe(
        rules.firstUnit,
      );
      const justBelow = rules.firstUnit * 0.994 + 3;
      const below = formatValue(justBelow, usd, locale, "compact");
      expect(read(below, rules), locale).toEqual({ value: justBelow });
    }
    expect(formatValue(257_123, usd, "de-DE", "headline")).toBe("257.123\u00a0$");
    expect(formatValue(4283, usd, "de-DE", "compact")).toBe("4.283\u00a0$");
    expect(formatValue(5020, usd, "ja-JP", "compact")).toBe("$5,020");
    expect(formatValue(257_123, usd, "en-US", "headline")).toBe("$257K");
  });

  it("shows the exact value of every KPI and chart point on a de-DE page", () => {
    const data = structuredClone(SALES);
    data.locale = "de-DE";
    for (const metric of Object.values(data.metrics)) {
      if (metric.format.type === "currency") metric.format = { ...metric.format, compact: true };
    }
    const page = renderDashboardPage(data, { assets: { runtime: "hatchmark.js", fonts: {} } });
    const exact = (value: number, format: Format) =>
      new Intl.NumberFormat("de-DE", {
        ...(format.type === "currency" ? { style: "currency", currency: format.currency } : {}),
        minimumFractionDigits: normalDecimals(format, value),
        maximumFractionDigits: normalDecimals(format, value),
      })
        .format(value)
        .replace("-", "\u2212");
    const shown: { value: number; metric: string }[] = [];
    for (const block of data.blocks) {
      if (block.type === "kpi" && typeof block.value === "number") {
        shown.push({ value: block.value, metric: block.metric });
      }
      if ((block.type === "line" || block.type === "bar") && "series" in block) {
        for (const s of block.series) {
          for (const v of s.values)
            if (typeof v === "number") shown.push({ value: v, metric: s.metric });
        }
      }
    }
    expect(shown.length).toBeGreaterThan(20);
    for (const { value, metric } of shown) {
      const format = data.metrics[metric]?.format as Format | undefined;
      if (format === undefined || Math.abs(value) >= 999_500) continue;
      expect(page, `${metric} ${value}`).toContain(exact(value, format));
    }
  });
});
