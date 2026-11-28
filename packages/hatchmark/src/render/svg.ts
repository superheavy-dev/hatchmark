import type { FontWeight } from "./measure.js";
import type { ColorKey, Paint } from "./theme.js";

export function esc(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function valueLang(locale: string): string | undefined {
  return new Intl.Locale(locale).language === "en" ? undefined : locale;
}

export function langAttr(locale: string): string {
  const lang = valueLang(locale);
  return lang === undefined ? "" : ` lang="${esc(lang)}"`;
}

/** JSON for a script element: "<" escaped so the data can never close the element. */
export function scriptJson(value: unknown): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

export function r(value: number): number {
  const rounded = Math.round(value * 10) / 10;
  return rounded === 0 ? 0 : rounded;
}

// IBM Plex Sans has ascent 1025 and descent 275 units. An explicit baseline renders the same in
// browsers and rasterisers, unlike dominant-baseline.
export const BASELINE_FROM_CENTER = 0.375;

export interface TextOptions {
  size: number;
  weight?: FontWeight;
  anchor?: "start" | "middle" | "end";
  color: ColorKey;
  className?: string;
  title?: string;
  lang?: string;
}

export function svgText(
  paint: Paint,
  x: number,
  y: number,
  content: string,
  options: TextOptions,
): string {
  const anchor =
    options.anchor && options.anchor !== "start" ? ` text-anchor="${options.anchor}"` : "";
  const weight = options.weight && options.weight !== 400 ? ` font-weight="${options.weight}"` : "";
  return `<text x="${r(x)}" y="${r(y + options.size * BASELINE_FROM_CENTER)}" font-size="${options.size}"${weight}${anchor}${options.lang === undefined ? "" : langAttr(options.lang)}${paint.attrs(options.color, undefined, options.className)}>${options.title === undefined ? "" : `<title>${esc(options.title)}</title>`}${esc(content)}</text>`;
}

export function svgLine(
  paint: Paint,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  stroke: ColorKey,
  extra = "",
): string {
  return `<line x1="${r(x1)}" y1="${r(y1)}" x2="${r(x2)}" y2="${r(y2)}"${paint.attrs(undefined, stroke)}${extra}/>`;
}
