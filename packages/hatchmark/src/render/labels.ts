export function stackLabels(
  targets: readonly number[],
  height: number,
  gap: number,
  top: number,
  bottom: number,
): number[] {
  const order = targets.map((t, i) => ({ t, i })).sort((a, b) => a.t - b.t || a.i - b.i);
  const span = (n: number) => n * height + (n - 1) * gap;
  const place = (group: { items: { t: number; i: number }[] }) => {
    const mean = group.items.reduce((sum, item) => sum + item.t, 0) / group.items.length;
    const size = span(group.items.length);
    const start = Math.max(top, Math.min(bottom - size, mean - size / 2));
    return { items: group.items, start, end: start + size };
  };
  const groups = order.map((item) => place({ items: [item] }));
  let merged = true;
  while (merged) {
    merged = false;
    for (let k = 1; k < groups.length; k++) {
      const a = groups[k - 1] as (typeof groups)[number];
      const b = groups[k] as (typeof groups)[number];
      if (a.end + gap > b.start) {
        groups.splice(k - 1, 2, place({ items: [...a.items, ...b.items] }));
        merged = true;
        break;
      }
    }
  }
  const centres: number[] = new Array(targets.length);
  for (const group of groups) {
    group.items.forEach((item, k) => {
      centres[item.i] = group.start + k * (height + gap) + height / 2;
    });
  }
  return centres;
}

export interface TickCandidate {
  pos: number;
  width: number;
  phase: number;
}

export function thinTicks(
  candidates: readonly TickCandidate[],
  steps: readonly number[],
  gap: number,
  minX: number,
  maxX: number,
  width: (index: number, kept: number[]) => number = (i) => candidates[i]?.width ?? 0,
): { index: number; centre: number }[] {
  for (const step of steps) {
    const kept = candidates
      .map((_, i) => i)
      .filter((i) => (candidates[i]?.phase ?? 0) % step === 0);
    if (kept.length === 0) continue;
    const placed = kept.map((i) => {
      const w = width(i, kept);
      const pos = candidates[i]?.pos ?? 0;
      const centre = Math.max(minX + w / 2, Math.min(maxX - w / 2, pos));
      return { index: i, centre, w };
    });
    const fits = placed.every(
      (p, k) =>
        p.w <= maxX - minX &&
        (k === 0 ||
          (placed[k - 1] as (typeof placed)[number]).centre + (placed[k - 1]?.w ?? 0) / 2 + gap <=
            p.centre - p.w / 2),
    );
    if (fits) return placed.map(({ index, centre }) => ({ index, centre }));
  }
  const first = candidates[0];
  if (!first) return [];
  const w = width(0, [0]);
  if (w > maxX - minX) return [];
  return [{ index: 0, centre: Math.max(minX + w / 2, Math.min(maxX - w / 2, first.pos)) }];
}
