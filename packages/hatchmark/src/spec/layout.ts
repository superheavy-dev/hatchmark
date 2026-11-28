export const MIN_CHART_SPAN = 3;

/** Card height presets, shortest first. The theme sets each one's pixels for desktop and phone. */
export const HEIGHT_PRESETS = ["compact", "default", "tall"] as const;
export type HeightPreset = (typeof HEIGHT_PRESETS)[number];

export function tallestPreset(presets: readonly (HeightPreset | undefined)[]): HeightPreset {
  return HEIGHT_PRESETS[
    Math.max(...presets.map((p) => HEIGHT_PRESETS.indexOf(p ?? "default")))
  ] as HeightPreset;
}

const CHART_TYPES = new Set(["line", "area", "bar", "pie", "donut", "scatter"]);

/** What layout reads from a block: its type, its span as written and its height preset. */
export interface LayoutBlock {
  type: string;
  span?: number | undefined;
  height?: HeightPreset | undefined;
}

/**
 * One child of the dashboard grid: consecutive KPIs share a strip, a chart or a table is a card.
 * Blocks of types that are not built (bar_list, text) take no place.
 */
export interface LayoutItem {
  kind: "strip" | "chart" | "table";
  /** Indexes of the blocks it shows, in order. */
  blocks: number[];
  /** Columns it takes: a strip sums its KPIs (at most 12), a chart takes at least MIN_CHART_SPAN. */
  span: number;
  /** Index of its grid row in a 12-column layout. */
  row: number;
  /** True when no other item shares its grid row. */
  alone: boolean;
  /**
   * The preset it is drawn at in a 12-column layout. A strip takes its tallest KPI's preset. A chart
   * takes the tallest preset of the charts in its row, so cards side by side end level; tables keep
   * their own.
   */
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
