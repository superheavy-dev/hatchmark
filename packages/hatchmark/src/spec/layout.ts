export const MIN_CHART_SPAN = 3;

export const HEIGHT_PRESETS = ["compact", "default", "tall"] as const;
export type HeightPreset = (typeof HEIGHT_PRESETS)[number];

export function tallestPreset(presets: readonly (HeightPreset | undefined)[]): HeightPreset {
  return HEIGHT_PRESETS[
    Math.max(...presets.map((p) => HEIGHT_PRESETS.indexOf(p ?? "default")))
  ] as HeightPreset;
}

const CHART_TYPES = new Set(["line", "area", "bar", "pie", "donut", "scatter", "map"]);

export interface LayoutBlock {
  type: string;
  span?: number | undefined;
  height?: HeightPreset | undefined;
}

export interface LayoutItem {
  kind: "strip" | "chart" | "table";
  blocks: number[];
  span: number;
  row: number;
  alone: boolean;
  height: HeightPreset;
}

export function layoutItems(blocks: readonly LayoutBlock[]): LayoutItem[] {
  const items: Omit<LayoutItem, "row" | "alone" | "height">[] = [];
  blocks.forEach((block, index) => {
    const last = items.at(-1);
    if (block.type === "kpi") {
      if (last?.kind === "strip") {
        last.blocks.push(index);
        last.span = Math.min(12, last.span + (block.span ?? 3));
      } else {
        items.push({ kind: "strip", blocks: [index], span: Math.min(12, block.span ?? 3) });
      }
    } else if (block.type === "table") {
      items.push({ kind: "table", blocks: [index], span: block.span ?? 12 });
    } else if (CHART_TYPES.has(block.type)) {
      items.push({
        kind: "chart",
        blocks: [index],
        span: Math.max(MIN_CHART_SPAN, block.span ?? 12),
      });
    }
  });
  const rows = gridRows(items.map((item) => item.span));
  const own = items.map((item) => tallestPreset(item.blocks.map((i) => blocks[i]?.height)));
  return items.map((item, i) => {
    const row = rows[i] as number;
    const mates = items.flatMap((_, j) => (rows[j] === row ? [j] : []));
    const charts = mates.filter((j) => items[j]?.kind === "chart");
    return {
      ...item,
      row,
      alone: mates.length === 1,
      height:
        item.kind === "chart" ? tallestPreset(charts.map((j) => own[j])) : (own[i] as HeightPreset),
    };
  });
}

// Mirrors CSS Grid auto-placement: an item that does not fit in what is left of a row starts the
// next row.
function gridRows(spans: readonly number[]): number[] {
  let row = -1;
  let used = 12;
  return spans.map((span) => {
    const width = Math.min(12, Math.max(1, span));
    if (used + width > 12) {
      row += 1;
      used = 0;
    }
    used += width;
    return row;
  });
}
