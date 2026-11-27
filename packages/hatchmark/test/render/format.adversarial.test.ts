import { describe, expect, it } from "vitest";
import { formatTicks, formatValue, type NumberStyle } from "../../src/render/index.js";

const FULL = process.env.HM_SWEEP === "full";
const NBSP = "\u00a0";
const NNBSP = "\u202f";
const MINUS = "\u2212";

type Format =
  | { type: "currency"; currency: string; decimals?: number; compact?: boolean }
  | { type: "number"; decimals?: number; compact?: boolean }
  | { type: "percent"; decimals?: number };

interface Rules {
  dec: string;
  grp: string;
  minGroup: 1 | 2;
  units: [string, number][];
  cur: Record<string, [string, string]>;
  pct: string;
}

const L: Record<string, Rules> = {
  "en-US": {
    dec: ".",
    grp: ",",
    minGroup: 1,
    units: [
      ["K", 1e3],
      ["M", 1e6],
      ["B", 1e9],
      ["T", 1e12],
    ],
    cur: { USD: ["$", ""], EUR: ["€", ""] },
    pct: "%",
  },
  "en-GB": {
    dec: ".",
    grp: ",",
    minGroup: 1,
    units: [
      ["k", 1e3],
      ["m", 1e6],
      ["bn", 1e9],
      ["tn", 1e12],
    ],
    cur: { USD: ["US$", ""], GBP: ["£", ""] },
    pct: "%",
  },
  "de-DE": {
    dec: ",",
    grp: ".",
    minGroup: 1,
    units: [
      ["Mio.", 1e6],
      ["Mrd.", 1e9],
      ["Bio.", 1e12],
    ],
    cur: { USD: ["", `${NBSP}$`], EUR: ["", `${NBSP}€`] },
    pct: `${NBSP}%`,
  },
  "fr-FR": {
    dec: ",",
    grp: NNBSP,
    minGroup: 1,
    units: [
      ["k", 1e3],
      ["M", 1e6],
      ["Md", 1e9],
      ["Bn", 1e12],
    ],
    cur: { USD: ["", `${NBSP}$US`], EUR: ["", `${NBSP}€`] },
    pct: `${NBSP}%`,
  },
  "es-ES": {
    dec: ",",
    grp: ".",
    minGroup: 2,
    units: [
      ["mil", 1e3],
      ["M", 1e6],
      ["mil M", 1e9],
      ["B", 1e12],
    ],
    cur: { USD: ["", `${NBSP}US$`], EUR: ["", `${NBSP}€`] },
    pct: `${NBSP}%`,
  },
  "ja-JP": {
    dec: ".",
    grp: ",",
    minGroup: 1,
    units: [
      ["万", 1e4],
      ["億", 1e8],
      ["兆", 1e12],
    ],
    cur: { USD: ["$", ""], JPY: ["￥", ""] },
    pct: "%",
  },
  "ko-KR": {
    dec: ".",
    grp: ",",
    minGroup: 1,
    units: [
      ["천", 1e3],
      ["만", 1e4],
      ["억", 1e8],
      ["조", 1e12],
    ],
    cur: { USD: ["US$", ""], KRW: ["₩", ""] },
    pct: "%",
  },
};

interface Decimal {
  neg: boolean;
  digits: bigint;
  scale: number;
}

function toDecimal(value: number, shift = 0): Decimal {
  const [mantissa = "0", exponent] = Math.abs(value).toString().split("e");
  const [int = "0", frac = ""] = mantissa.split(".");
  return {
    neg: value < 0,
    digits: BigInt(int + frac),
    scale: frac.length - Number(exponent ?? 0) - shift,
  };
}

function roundHalfExpand({ neg, digits, scale }: Decimal, places: number) {
  if (scale <= places) return { neg, q: digits * 10n ** BigInt(places - scale), places };
  const div = 10n ** BigInt(scale - places);
  const q = digits / div + ((digits % div) * 2n >= div ? 1n : 0n);
  return { neg, q, places };
}

function group(int: string, rules: Rules): string {
  if (int.length < 4 || (rules.minGroup === 2 && int.length < 5)) return int;
  const out: string[] = [];
  for (let i = int.length; i > 0; i -= 3) out.unshift(int.slice(Math.max(0, i - 3), i));
  return out.join(rules.grp);
}

function digitsText(
  { neg, q, places }: { neg: boolean; q: bigint; places: number },
  rules: Rules,
  trimTo?: number,
): { num: string; signed: boolean } {
  const padded = q.toString().padStart(places + 1, "0");
  const int = padded.slice(0, padded.length - places);
  let frac = padded.slice(padded.length - places);
  if (trimTo !== undefined)
    while (frac.length > trimTo && frac.endsWith("0")) frac = frac.slice(0, -1);
  return { num: group(int, rules) + (frac ? rules.dec + frac : ""), signed: neg && q !== 0n };
}

function expected(value: number, format: Format, locale: string, style: NumberStyle): string {
  const rules = L[locale] as Rules;
  if (format.type === "percent") {
    const places = format.decimals ?? 1;
    const r = digitsText(
      roundHalfExpand(toDecimal(value, 2), places),
      rules,
      style === "axis" ? 0 : undefined,
    );
    return (r.signed ? MINUS : "") + r.num + rules.pct;
  }
  let places: number;
  let trim: number | undefined;
  if (style === "axis") {
    places = format.decimals ?? 1;
    trim = 0;
  } else if (format.decimals !== undefined) places = format.decimals;
  else if (format.type === "currency") places = 0;
  else {
    places = Number.isInteger(value) ? 0 : 1;
    trim = 0;
  }
  const r = digitsText(roundHalfExpand(toDecimal(value), places), rules, trim);
  const [pre, suf] =
    format.type === "currency" ? (rules.cur[format.currency] as [string, string]) : ["", ""];
  return (r.signed ? MINUS : "") + pre + r.num + suf;
}

interface Shown {
  neg: boolean;
  mantissa: number;
  step: number;
  unit: number;
}

function parseUnit(text: string, format: Format, locale: string): Shown | undefined {
  const rules = L[locale] as Rules;
  let rest = text;
  const neg = rest.startsWith(MINUS);
  if (neg) rest = rest.slice(1);
  if (format.type === "currency") {
    const [pre, suf] = rules.cur[format.currency] as [string, string];
    if (pre && rest.startsWith(pre)) rest = rest.slice(pre.length);
    const s = suf.trim();
    if (s && rest.endsWith(s)) rest = rest.slice(0, -s.length);
  }
  rest = rest.trim();
  const sci = /^(\d+)(?:[.,](\d+))?E(\u2212?)(\d+)$/.exec(rest);
  if (sci) {
    const fracLen = (sci[2] ?? "").length;
    const exp = Number(sci[4]) * (sci[3] ? -1 : 1);
    return {
      neg,
      mantissa: Number(`${sci[1]}.${sci[2] ?? "0"}`),
      step: 10 ** (exp - fracLen),
      unit: 10 ** exp,
    };
  }
  const esc = (s: string) => s.replace(/[.$]/g, "\\$&");
  for (const [name, factor] of [...rules.units].sort((a, b) => b[0].length - a[0].length)) {
    const m = new RegExp(
      `^([\\d${esc(rules.grp)}]+)(?:${esc(rules.dec)}(\\d+))?\\s*${esc(name).replace(" ", "\\s+")}$`,
      "u",
    ).exec(rest);
    if (!m) continue;
    const int = (m[1] ?? "").split(rules.grp).join("");
    const fracLen = (m[2] ?? "").length;
    const zeros = fracLen ? 0 : int.length - int.replace(/0+$/, "").length;
    return {
      neg,
      mantissa: Number(`${int}.${m[2] ?? "0"}`),
      step: factor * 10 ** (fracLen ? -fracLen : Math.min(zeros, int.length - 1)),
      unit: factor,
    };
  }
  return undefined;
}

function check(
  value: number,
  format: Format,
  locale: string,
  style: NumberStyle,
): string | undefined {
  const got = formatValue(value, { format } as Parameters<typeof formatValue>[1], locale, style);
  if (!Number.isFinite(value)) return got === "\u2014" ? undefined : got;
  const want = expected(value, format, locale, style);
  if (got === want) return undefined;
  const shown = format.type === "percent" ? undefined : parseUnit(got, format, locale);
  if (!shown) return `${got} (want ${want})`;
  if (shown.neg !== value < 0) return `${got}: sign`;
  const off = Math.abs(shown.mantissa - Math.abs(value) / shown.unit);
  const half = shown.step / shown.unit / 2;
  return off > half * (1 + 1e-9) + 1e-12 ? `${got}: off by more than half a step` : undefined;
}

function random(seed: number) {
  let s = seed;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

function values(count: number): number[] {
  const set = new Set([
    0,
    -0,
    0.5,
    -0.5,
    1.5,
    -1.5,
    2.5,
    -2.5,
    0.05,
    -0.05,
    0.005,
    1.005,
    -1.005,
    0.125,
    -0.125,
    108.5,
    -108.5,
    12.34,
    12.05,
    -12.05,
    999,
    999.4,
    999.5,
    -999.5,
    999.95,
    -999.95,
    999.995,
    1000,
    -1000,
    1001,
    1025,
    1075,
    1499.99,
    1500,
    4283,
    9994,
    9994.99,
    9995,
    9999,
    9999.5,
    -9999.5,
    9999.95,
    10000,
    10001,
    99999.5,
    99950,
    99949.99,
    999499,
    999499.5,
    999500,
    999999,
    999999.5,
    -999999.5,
    1e6,
    9999999.5,
    99999999.5,
    1e8 - 0.5,
    999.5e9,
    999.5e12,
    9.995e14,
    999999999999999,
    1e15,
    -1e15,
    1.234e15,
    9.995e15,
    1e21,
    Number.MAX_SAFE_INTEGER,
    1e-7,
    -1e-7,
    1e-10,
    0.0004,
    -0.0004,
    0.04,
    -0.04,
    0.4,
    -0.4,
    0.96,
    -0.96,
  ]);
  for (const f of [1e3, 1e4, 1e6, 1e8, 1e9, 1e12]) {
    for (const dx of [-0.5, -0.05, -1, -7.25, 0, 1, 0.5]) {
      for (const v of [f * 0.9995 + dx, f + dx, f * 0.995 + dx]) set.add(v).add(-v);
    }
  }
  const rand = random(0x9e3779b9);
  for (let i = 0; i < count; i++) {
    let v = (rand() < 0.5 ? -1 : 1) * 10 ** (rand() * 18 - 4);
    const k = Math.floor(rand() * 4);
    if (k === 1) v = Math.round(v);
    if (k === 2) v = Math.round(v * 100) / 100;
    if (k === 3) v = Math.floor(v) + 0.5;
    set.add(v);
  }
  return [...set, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];
}

function formats(locale: string): Format[] {
  const out: Format[] = [];
  for (const currency of Object.keys((L[locale] as Rules).cur)) {
    for (const decimals of [undefined, 0, 2]) {
      for (const compact of [undefined, true, false]) {
        out.push({
          type: "currency",
          currency,
          ...(decimals === undefined ? {} : { decimals }),
          ...(compact === undefined ? {} : { compact }),
        });
      }
    }
  }
  for (const decimals of [undefined, 0, 1, 2, 3]) {
    for (const compact of [undefined, true]) {
      out.push({
        type: "number",
        ...(decimals === undefined ? {} : { decimals }),
        ...(compact === undefined ? {} : { compact }),
      });
    }
  }
  for (const decimals of [undefined, 0, 1, 2])
    out.push({ type: "percent", ...(decimals === undefined ? {} : { decimals }) });
  return out;
}

const STYLES: NumberStyle[] = ["compact", "headline", "full", "axis"];

describe(`formatValue against an independent decimal oracle (HM_SWEEP=full for ${FULL ? "" : "more "}random values and 75 more locales)`, () => {
  const sample = values(FULL ? 400 : 40);
  for (const locale of Object.keys(L)) {
    it(`prints exact unit-less values and in-step units in ${locale}`, () => {
      const failures: string[] = [];
      for (const format of formats(locale)) {
        for (const style of STYLES) {
          for (const v of sample) {
            const bad = check(v, format, locale, style);
            if (bad !== undefined)
              failures.push(`${JSON.stringify(format)} ${style} ${v} -> ${bad}`);
          }
        }
      }
      expect(failures.slice(0, 10)).toEqual([]);
    });
  }

  it("labels axis ticks exactly and uniquely", () => {
    const sets = [
      [0, 250, 500, 750, 1000],
      [0, 2500, 5000, 7500, 10000],
      [1000, 1025, 1050, 1075, 1100],
      [0, 0.1, 0.2, 0.30000000000000004, 0.4],
      [-1000, -500, 0, 500, 1000],
      [0, 200000, 400000, 600000, 800000, 1000000],
      [995000, 997500, 1000000, 1002500],
      [0, 1.25, 2.5, 3.75, 5],
      [9000, 9500, 10000, 10500],
    ];
    const failures: string[] = [];
    for (const locale of Object.keys(L)) {
      for (const format of [
        { type: "currency", currency: "USD" },
        { type: "number" },
        { type: "number", decimals: 2 },
      ] as Format[]) {
        for (const ticks of sets) {
          const labels = formatTicks(
            ticks,
            { format } as Parameters<typeof formatTicks>[1],
            locale,
          );
          ticks.forEach((t, i) => {
            const label = labels[i] as string;
            const shown = parseUnit(label, format, locale);
            const exact = shown
              ? Math.abs((shown.neg ? -1 : 1) * shown.mantissa * shown.unit - t) <=
                1e-9 * Math.max(1, Math.abs(t))
              : label === expected(t, { ...format, decimals: 6 }, locale, "axis") ||
                label === expected(t, format, locale, "full");
            if (!exact) failures.push(`${locale} ${JSON.stringify(format)} ${t} -> ${label}`);
          });
          if (new Set(labels).size !== labels.length)
            failures.push(`${locale} duplicate ${labels.join(" | ")}`);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it.runIf(FULL)(
    "never prints a unit-less rounded value in 75 more locales",
    () => {
      const locales = [
        "en-IN",
        "en-AU",
        "en-CA",
        "de-CH",
        "de-AT",
        "fr-CA",
        "fr-CH",
        "es-MX",
        "es-419",
        "it-IT",
        "pt-BR",
        "pt-PT",
        "nl-NL",
        "sv-SE",
        "nb-NO",
        "da-DK",
        "fi-FI",
        "pl-PL",
        "cs-CZ",
        "sk-SK",
        "hu-HU",
        "ro-RO",
        "bg-BG",
        "el-GR",
        "tr-TR",
        "ru-RU",
        "uk-UA",
        "he-IL",
        "ar-EG",
        "ar-SA",
        "fa-IR",
        "ur-PK",
        "hi-IN",
        "bn-BD",
        "mr-IN",
        "ta-IN",
        "te-IN",
        "th-TH",
        "vi-VN",
        "id-ID",
        "ms-MY",
        "fil-PH",
        "zh-CN",
        "zh-TW",
        "zh-HK",
        "my-MM",
        "km-KH",
        "lo-LA",
        "ne-NP",
        "sw-KE",
        "am-ET",
        "hr-HR",
        "sr-RS",
        "sl-SI",
        "lt-LT",
        "lv-LV",
        "et-EE",
        "is-IS",
        "ga-IE",
        "ca-ES",
        "eu-ES",
        "gl-ES",
        "af-ZA",
        "zu-ZA",
        "kk-KZ",
        "uz-UZ",
        "az-AZ",
        "ka-GE",
        "hy-AM",
        "mn-MN",
        "si-LK",
        "pa-IN",
        "gu-IN",
        "kn-IN",
        "ml-IN",
      ];
      const formatsAll: Format[] = [
        { type: "currency", currency: "USD" },
        { type: "currency", currency: "EUR", decimals: 2 },
        { type: "number" },
        { type: "number", decimals: 2 },
      ];
      const failures: string[] = [];
      for (const locale of locales) {
        const digits = new Intl.NumberFormat(locale, { useGrouping: false })
          .format(9876543210)
          .split("")
          .reverse();
        const latin = (s: string) =>
          [...s].map((c) => (digits.includes(c) ? String(digits.indexOf(c)) : c)).join("");
        for (const format of formatsAll) {
          for (const style of ["compact", "headline", "axis"] as NumberStyle[]) {
            for (const v of values(160).filter(Number.isFinite)) {
              const got = formatValue(
                v,
                { format } as Parameters<typeof formatValue>[1],
                locale,
                style,
              );
              const places =
                style === "axis"
                  ? undefined
                  : (format.decimals ??
                    (format.type === "currency" ? 0 : Number.isInteger(v) ? 0 : 1));
              const full = new Intl.NumberFormat(locale, {
                signDisplay: "negative",
                ...(format.type === "currency"
                  ? { style: "currency", currency: format.currency }
                  : {}),
                ...(style === "axis"
                  ? { minimumFractionDigits: 0, maximumFractionDigits: format.decimals ?? 1 }
                  : {
                      minimumFractionDigits:
                        format.type === "number" && format.decimals === undefined ? 0 : places,
                      maximumFractionDigits: places,
                    }),
              })
                .format(v)
                .replaceAll("-", MINUS);
              if (got === full) continue;
              const pattern = /\d[\d\s\u00a0\u202f'’.,٬٫]*/u;
              if (latin(got).replace(pattern, "#") === latin(full).replace(pattern, "#")) {
                failures.push(
                  `${locale} ${JSON.stringify(format)} ${style} ${v} -> ${got}, full ${full}`,
                );
              }
            }
          }
        }
      }
      expect(failures.slice(0, 10)).toEqual([]);
    },
    300_000,
  );
});
