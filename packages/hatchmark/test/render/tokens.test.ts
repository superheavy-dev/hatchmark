import { describe, expect, test } from "vitest";
import tokens from "../../src/render/themes/default.json" with { type: "json" };

type Rgb = [number, number, number];
type Matrix = [Rgb, Rgb, Rgb];
type Mode = "light" | "dark";

const MACHADO: Record<string, Matrix> = {
  deutan: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
  ],
  protan: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  tritan: [
    [1.255528, -0.076749, -0.178779],
    [-0.078411, 0.930809, 0.147602],
    [0.004733, 0.691367, 0.3039],
  ],
};

const linear = (hex: string): Rgb => {
  const channel = (i: number) => {
    const v = Number.parseInt(hex.slice(1 + 2 * i, 3 + 2 * i), 16) / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return [channel(0), channel(1), channel(2)];
};

const apply = (m: Matrix, [r, g, b]: Rgb): Rgb =>
  m.map(([x, y, z]) => x * r + y * g + z * b) as Rgb;

const luminance = (hex: string) =>
  apply(
    [
      [0.2126, 0.7152, 0.0722],
      [0, 0, 0],
      [0, 0, 0],
    ],
    linear(hex),
  )[0];

const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};

const XYZ_D65: Matrix = [
  [0.4123907992659595, 0.357584339383878, 0.1804807884018343],
  [0.21263900587151036, 0.715168678767756, 0.07219231536073371],
  [0.01933081871559185, 0.11919477979462598, 0.9505321522496606],
];
const D65: Rgb = [0.3127 / 0.329, 1, (1 - 0.3127 - 0.329) / 0.329];

const lab = (rgb: Rgb): Rgb => {
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);
  const [x, y, z] = apply(XYZ_D65, rgb).map((v, i) => f(v / (D65[i] as number))) as Rgb;
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
};

const ciede2000 = ([L1, a1, b1]: Rgb, [L2, a2, b2]: Rgb) => {
  const rad = Math.PI / 180;
  const C1 = Math.hypot(a1, b1);
  const C2 = Math.hypot(a2, b2);
  const Cm = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cm ** 7 / (Cm ** 7 + 25 ** 7)));
  const ap1 = a1 * (1 + G);
  const ap2 = a2 * (1 + G);
  const Cp1 = Math.hypot(ap1, b1);
  const Cp2 = Math.hypot(ap2, b2);
  const hue = (b: number, a: number) => {
    const h = Math.atan2(b, a) / rad;
    return h < 0 ? h + 360 : h;
  };
  const hp1 = Cp1 === 0 ? 0 : hue(b1, ap1);
  const hp2 = Cp2 === 0 ? 0 : hue(b2, ap2);
  const dL = L2 - L1;
  const dC = Cp2 - Cp1;
  let dh = 0;
  if (Cp1 * Cp2 !== 0) {
    dh = hp2 - hp1;
    if (dh > 180) dh -= 360;
    else if (dh < -180) dh += 360;
  }
  const dH = 2 * Math.sqrt(Cp1 * Cp2) * Math.sin((dh / 2) * rad);
  const Lm = (L1 + L2) / 2;
  const Cpm = (Cp1 + Cp2) / 2;
  let hm = hp1 + hp2;
  if (Cp1 * Cp2 !== 0) {
    if (Math.abs(hp1 - hp2) > 180) hm += hp1 + hp2 < 360 ? 360 : -360;
    hm /= 2;
  }
  const T =
    1 -
    0.17 * Math.cos((hm - 30) * rad) +
    0.24 * Math.cos(2 * hm * rad) +
    0.32 * Math.cos((3 * hm + 6) * rad) -
    0.2 * Math.cos((4 * hm - 63) * rad);
  const SL = 1 + (0.015 * (Lm - 50) ** 2) / Math.sqrt(20 + (Lm - 50) ** 2);
  const SC = 1 + 0.045 * Cpm;
  const SH = 1 + 0.015 * Cpm * T;
  const RT =
    -2 *
    Math.sqrt(Cpm ** 7 / (Cpm ** 7 + 25 ** 7)) *
    Math.sin(60 * Math.exp(-(((hm - 275) / 25) ** 2)) * rad);
  return Math.sqrt((dL / SL) ** 2 + (dC / SC) ** 2 + (dH / SH) ** 2 + RT * (dC / SC) * (dH / SH));
};

const simulate = (m: Matrix) => (rgb: Rgb) =>
  apply(m, rgb).map((v) => Math.min(1, Math.max(0, v))) as Rgb;

const SIMULATIONS: Record<string, (rgb: Rgb) => Rgb> = {
  normal: (rgb) => rgb,
  deutan: simulate(MACHADO.deutan as Matrix),
  protan: simulate(MACHADO.protan as Matrix),
  tritan: simulate(MACHADO.tritan as Matrix),
};

type Pairs = Record<string, { min: number; pair: string }>;

function closest(hexes: string[], pairs: [number, number][]): Pairs {
  return Object.fromEntries(
    Object.entries(SIMULATIONS).map(([name, simulate]) => {
      const labs = hexes.map((h) => lab(simulate(linear(h))));
      let best = { min: Number.POSITIVE_INFINITY, pair: "" };
      for (const [i, j] of pairs) {
        const d = ciede2000(labs[i] as Rgb, labs[j] as Rgb);
        if (d < best.min) best = { min: d, pair: `c${i + 1}/c${j + 1}` };
      }
      return [name, { min: Math.round(best.min * 10) / 10, pair: best.pair }];
    }),
  );
}

const within = (n: number): [number, number][] =>
  Array.from({ length: n }, (_, i) =>
    Array.from({ length: n - i - 1 }, (_, k) => [i, i + k + 1] as [number, number]),
  ).flat();
const adjacent = (n: number): [number, number][] =>
  Array.from({ length: n - 1 }, (_, i) => [i, i + 1] as [number, number]);

const BAR = { first3: 12, first6: 8, all8: 8, adjacent: 8 } as const;

const SETS = [
  ["categorical", "seriesContrastVsCard", "categoricalCVD"],
  ["categoricalFill", "seriesFillContrastVsCard", "categoricalFillCVD"],
] as const;

describe.each(["light", "dark"] as const)("Default theme tokens, %s", (mode: Mode) => {
  const card = tokens.color[mode].card;
  const checks = tokens.checks[mode];

  describe.each(SETS)("%s", (set, contrastKey, cvdKey) => {
    const hexes = tokens.data[mode][set];

    test("has eight slots, one name each", () => {
      expect(hexes).toHaveLength(8);
      const names =
        set === "categorical" ? tokens.data.categoricalNames : tokens.data.categoricalFillNames;
      expect(names).toHaveLength(8);
    });

    test("every slot is at least 3:1 against the card, as recorded", () => {
      const measured = Object.fromEntries(
        hexes.map((h, i) => [`c${i + 1}`, Math.round(contrast(h, card) * 100) / 100]),
      );
      expect(measured).toEqual(checks[contrastKey]);
      for (const value of Object.values(measured)) expect(value).toBeGreaterThanOrEqual(3);
    });

    test("pairs stay apart under every colour-vision simulation, as recorded", () => {
      const measured = {
        first3: closest(hexes, within(3)),
        first6: closest(hexes, within(6)),
        all8: closest(hexes, within(8)),
        adjacent: closest(hexes, adjacent(8)),
      };
      expect(measured).toEqual(checks[cvdKey]);
      for (const [group, bar] of Object.entries(BAR))
        for (const { min } of Object.values(measured[group as keyof typeof measured]))
          expect(min, group).toBeGreaterThanOrEqual(bar);
    });
  });
});

type Family = (typeof tokens.data.groups.families)[number];
type Part = "stroke" | "fill";
const GROUP_BARS = { within: 10, across: 8, ungrouped: 8, context: 8 } as const;

function closestLabelled(
  hexes: { hex: string; label: string }[],
  pairs: [number, number][],
): Pairs {
  return Object.fromEntries(
    Object.entries(SIMULATIONS).map(([name, simulate]) => {
      const labs = hexes.map((h) => lab(simulate(linear(h.hex))));
      let best = { min: Number.POSITIVE_INFINITY, pair: "" };
      for (const [i, j] of pairs) {
        const d = ciede2000(labs[i] as Rgb, labs[j] as Rgb);
        if (d < best.min) best = { min: d, pair: `${hexes[i]?.label}/${hexes[j]?.label}` };
      }
      return [name, { min: Math.round(best.min * 10) / 10, pair: best.pair }];
    }),
  );
}

const cross = (a: number, b: number): [number, number][] =>
  Array.from({ length: a }, (_, i) =>
    Array.from({ length: b }, (_, j) => [i, a + j] as [number, number]),
  ).flat();

describe.each(["light", "dark"] as const)("Default theme group tokens, %s", (mode: Mode) => {
  const { families, steps } = tokens.data.groups;
  const checks = tokens.checks[mode];
  const surfaces = (mode === "light" ? ["card", "page"] : ["card", "cardAlt"]) as (
    | "card"
    | "page"
    | "cardAlt"
  )[];
  const labelled = (f: Family, part: Part) =>
    f[mode][part].map((hex, i) => ({ hex, label: `${f.id}${i + 1}` }));

  test("every family has the same number of steps, and step 1 is its first slot", () => {
    for (const f of families) {
      for (const part of ["stroke", "fill"] as const) expect(f[mode][part]).toHaveLength(steps);
      const slot = (f.slots[0] as number) - 1;
      expect(f[mode].stroke[0]).toBe(tokens.data[mode].categorical[slot]);
      expect(f[mode].fill[0]).toBe(tokens.data[mode].categoricalFill[slot]);
    }
    expect(new Set(families.flatMap((f) => f.slots)).size).toBe(
      families.flatMap((f) => f.slots).length,
    );
  });

  test("every step is at least 3:1 against the surfaces, as recorded", () => {
    const measured = Object.fromEntries(
      surfaces.map((s) => [
        s,
        Object.fromEntries(
          families.map((f) => [
            f.id,
            Object.fromEntries(
              (["stroke", "fill"] as const).map((part) => [
                part,
                f[mode][part].map(
                  (h) => Math.round(contrast(h, tokens.color[mode][s]) * 100) / 100,
                ),
              ]),
            ),
          ]),
        ),
      ]),
    );
    expect(measured).toEqual(checks.groupContrastVsCard);
    for (const v of Object.values(measured).flatMap((s) =>
      Object.values(s).flatMap((f) => Object.values(f).flat()),
    ))
      expect(v).toBeGreaterThanOrEqual(3);
  });

  test("steps stay apart within a family, across families, from ungrouped slots and from context, as recorded", () => {
    const parts = ["stroke", "fill"] as const;
    const slotHexes = (part: Part) =>
      tokens.data[mode][part === "stroke" ? "categorical" : "categoricalFill"];
    const measured = {
      bars: checks.groupCVD.bars,
      withinFamily: Object.fromEntries(
        parts.map((part) => [
          part,
          Object.fromEntries(
            families.map((f) => [
              f.id,
              {
                adjacent: closestLabelled(labelled(f, part), adjacent(steps)),
                all: closestLabelled(labelled(f, part), within(steps)),
              },
            ]),
          ),
        ]),
      ),
      acrossFamilies: Object.fromEntries(
        parts.map((part) => {
          const all = families.flatMap((f) => labelled(f, part));
          const pairs = within(all.length).filter(
            ([i, j]) => Math.floor(i / steps) !== Math.floor(j / steps),
          );
          return [part, closestLabelled(all, pairs)];
        }),
      ),
      vsUngrouped: Object.fromEntries(
        parts.map((part) => [
          part,
          Object.fromEntries(
            families.map((f) => {
              const others = slotHexes(part)
                .map((hex, i) => ({ hex, label: `c${i + 1}` }))
                .filter((_, i) => !f.slots.includes(i + 1));
              return [
                f.id,
                closestLabelled([...labelled(f, part), ...others], cross(steps, others.length)),
              ];
            }),
          ),
        ]),
      ),
      vsContext: Object.fromEntries(
        parts.map((part) => [
          part,
          Object.fromEntries(
            families.map((f) => [
              f.id,
              closestLabelled(
                [...labelled(f, part), { hex: tokens.color[mode].context, label: "context" }],
                cross(steps, 1),
              ),
            ]),
          ),
        ]),
      ),
    };
    expect(measured).toEqual(checks.groupCVD);
    const mins = (o: unknown): number[] =>
      typeof o === "object" && o !== null
        ? "min" in o
          ? [(o as { min: number }).min]
          : Object.values(o).flatMap(mins)
        : [];
    for (const v of mins(measured.withinFamily))
      expect(v).toBeGreaterThanOrEqual(GROUP_BARS.within);
    for (const v of mins(measured.acrossFamilies))
      expect(v).toBeGreaterThanOrEqual(GROUP_BARS.across);
    for (const v of mins(measured.vsUngrouped))
      expect(v).toBeGreaterThanOrEqual(GROUP_BARS.ungrouped);
    for (const v of mins(measured.vsContext)) expect(v).toBeGreaterThanOrEqual(GROUP_BARS.context);
  });
});
