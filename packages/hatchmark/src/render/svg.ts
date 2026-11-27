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
  return `<text x="${r(x)}" y="${r(y + options.size * BASELINE_FROM_CENTER)}" font-size="${options.size}"${weight}${anchor}${paint.attrs(options.color, undefined, options.className)}>${esc(content)}</text>`;
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
