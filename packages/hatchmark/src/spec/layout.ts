export const MIN_CHART_SPAN = 3;

// Mirrors CSS Grid auto-placement: an item that does not fit in what is left of a row starts the
// next row.
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
