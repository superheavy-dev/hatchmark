/** Line, area and bar charts are drawn at least this many of the 12 grid columns wide. */
export const MIN_CHART_SPAN = 3;

/**
 * Whether each grid item sits alone in its row of the 12-column grid: items fill a row left to right,
 * and one that does not fit in what is left of the row starts the next one, as the grid places them.
 */
export function aloneInRow(spans: readonly number[]): boolean[] {
  const rows: number[][] = [];
  let used = 12;
  spans.forEach((span, index) => {
    const width = Math.min(12, Math.max(1, span));
    if (used + width > 12) {
      rows.push([]);
      used = 0;
    }
    rows[rows.length - 1]?.push(index);
    used += width;
  });
  const alone = spans.map(() => false);
  for (const row of rows) if (row.length === 1) alone[row[0] as number] = true;
  return alone;
}
