/** Optimal string alignment distance: Levenshtein plus adjacent transpositions. */
export function editDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const d: number[][] = Array.from({ length: rows }, (_, i) =>
    Array.from({ length: cols }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  const at = (i: number, j: number): number => d[i]?.[j] ?? 0;
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min(at(i - 1, j) + 1, at(i, j - 1) + 1, at(i - 1, j - 1) + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        best = Math.min(best, at(i - 2, j - 2) + 1);
      }
      (d[i] as number[])[j] = best;
    }
  }
  return at(a.length, b.length);
}

/**
 * The closest candidate to a misspelled name, or undefined when nothing is close enough to be a
 * likely typo. Case-only differences always match. Ties resolve to the alphabetically first
 * candidate, so the suggestion is stable.
 */
export function closestMatch(input: string, candidates: readonly string[]): string | undefined {
  const lower = input.toLowerCase();
  const caseMatch = [...candidates].sort().find((c) => c.toLowerCase() === lower);
  if (caseMatch !== undefined) return caseMatch;
  const limit = Math.max(1, Math.floor(input.length / 3));
  let best: string | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of [...candidates].sort()) {
    const distance = editDistance(lower, candidate.toLowerCase());
    if (distance <= limit && distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}
