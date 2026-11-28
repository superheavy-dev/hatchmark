export interface Summary {
  n: number;
  median: number;
  p25: number;
  p75: number;
  min: number;
  max: number;
}

function quantile(sorted: number[], q: number): number {
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const a = sorted[lower] ?? Number.NaN;
  const b = sorted[upper] ?? Number.NaN;
  return a + (b - a) * (position - lower);
}

export function summarize(values: readonly (number | null | undefined)[]): Summary | null {
  const sorted = values
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v))
    .sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  return {
    n: sorted.length,
    median: quantile(sorted, 0.5),
    p25: quantile(sorted, 0.25),
    p75: quantile(sorted, 0.75),
    min: sorted[0] ?? Number.NaN,
    max: sorted.at(-1) ?? Number.NaN,
  };
}
