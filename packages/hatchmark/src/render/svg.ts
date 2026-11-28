import type { FontWeight } from "./measure.js";
import type { ColorKey, Paint } from "./theme.js";

/** Escapes text for HTML and SVG content and attribute values. */
export function esc(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * The lang for text that is wholly a value formatted in locale, so screen readers read it in that
 * language; none for English, which the page's own lang already says.
 */
export function valueLang(locale: string): string | undefined {
  return new Intl.Locale(locale).language === "en" ? undefined : locale;
}

/** valueLang as an attribute, or nothing. */
export function langAttr(locale: string): string {
  const lang = valueLang(locale);
  return lang === undefined ? "" : ` lang="${esc(lang)}"`;
}

/** JSON for a script element: "<" escaped so the data can never close the element. */
export function scriptJson(value: unknown): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

/** Rounds a coordinate to 0.1 px, without "-0", so output is byte-stable. */
export function r(value: number): number {
  const rounded = Math.round(value * 10) / 10;
  return rounded === 0 ? 0 : rounded;
}

/**
 * Baseline offset below a line's vertical centre, as a fraction of the font size: half of
 * (ascent - descent) of IBM Plex Sans (1025 and 275 units). Emitting the baseline directly instead of
 * dominant-baseline keeps text in the same place in browsers and rasterisers.
 */
export const BASELINE_FROM_CENTER = 0.375;

export interface TextOptions {
  size: number;
  weight?: FontWeight;
  anchor?: "start" | "middle" | "end";
  color: ColorKey;
  className?: string;
  /** Full text for a native tooltip, when content is shortened. */
  title?: string;
  /** The locale the content is formatted in, when all of it is a formatted value. */
  lang?: string;
}

/** An SVG text element vertically centred on y. */
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
