import { FONT_METRICS, UNITS_PER_EM } from "./text-metrics.js";

export type FontWeight = 400 | 500 | 600;

export interface TextStyle {
  size: number;
  weight?: FontWeight;
}

interface Table {
  advances: Map<number, number>;
  kerning: Map<string, number>;
}

const tables = new Map<FontWeight, Table>();

function table(weight: FontWeight): Table {
  let found = tables.get(weight);
  if (found !== undefined) return found;
  const metrics = FONT_METRICS[weight];
  const advances = new Map<number, number>();
  for (let i = 0; i < metrics.advances.length; i += 2) {
    advances.set(metrics.advances[i] as number, metrics.advances[i + 1] as number);
  }
  const kerning = new Map<string, number>();
  for (const entry of metrics.kerning.split("\t")) {
    if (entry !== "") kerning.set(entry.slice(0, 2), Number(entry.slice(2)));
  }
  found = { advances, kerning };
  tables.set(weight, found);
  return found;
}

// Browsers draw code points outside the bundled subsets with a fallback font, so this is an
// estimate.
function fallbackAdvance(cp: number): number {
  if (cp >= 0x0300 && cp <= 0x036f) return 0;
  if (cp >= 0x1100 && (cp <= 0x115f || (cp >= 0x2e80 && cp <= 0xa4cf) || cp >= 0xac00)) {
    return UNITS_PER_EM;
  }
  return 560;
}

export function textWidth(text: string, style: TextStyle): number {
  const { advances, kerning } = table(style.weight ?? 400);
  let units = 0;
  let previous = "";
  for (const char of text) {
    const cp = char.codePointAt(0) as number;
    units += advances.get(cp) ?? fallbackAdvance(cp);
    if (previous !== "") units += kerning.get(previous + char) ?? 0;
    previous = char;
  }
  return (units * style.size) / UNITS_PER_EM;
}

export function truncateEnd(text: string, maxWidth: number, style: TextStyle): string {
  if (textWidth(text, style) <= maxWidth) return text;
  const chars = Array.from(text);
  let keep = chars.length - 1;
  const build = () => `${chars.slice(0, keep).join("").trimEnd()}\u2026`;
  while (keep > 1 && textWidth(build(), style) > maxWidth) keep--;
  const result = build();
  return textWidth(result, style) <= maxWidth ? result : "\u2026";
}

export function wrapLines(
  text: string,
  maxWidth: number,
  style: TextStyle,
  maxLines: number,
): { lines: string[]; cut: boolean } {
  const words = text.split(" ");
  const lines: string[] = [];
  while (words.length > 0 && lines.length < maxLines - 1) {
    let count = 1;
    while (
      count < words.length &&
      textWidth(words.slice(0, count + 1).join(" "), style) <= maxWidth
    ) {
      count++;
    }
    const line = words.slice(0, count).join(" ");
    if (textWidth(line, style) > maxWidth) break;
    lines.push(line);
    words.splice(0, count);
  }
  if (words.length === 0) return { lines, cut: false };
  const rest = words.join(" ");
  lines.push(truncateEnd(rest, maxWidth, style));
  return { lines, cut: textWidth(rest, style) > maxWidth };
}
