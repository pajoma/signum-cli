/**
 * Shared small string utilities. Extracted from `metadata.ts` so the same edit-distance
 * algorithm backs both type-name suggestions (AC-63.4) and flag-name suggestions
 * (QA finding: a typo'd flag was previously silently ignored) — one implementation, not two
 * that can quietly drift apart.
 */

/** Levenshtein distance. */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  const prev: number[] = Array.from({ length: b.length + 1 }, (_, i) => i);
  const cur: number[] = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min((cur[j - 1] ?? 0) + 1, (prev[j] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = cur[j] ?? 0;
  }
  return prev[b.length] ?? 0;
}

/** Nearest candidate to `target` by edit distance, within a tolerance scaled to length. */
export function nearest(target: string, candidates: Iterable<string>, maxDistanceFloor = 2): string | undefined {
  let best: { name: string; score: number } | undefined;
  for (const candidate of candidates) {
    if (candidate === target) continue;
    const score = editDistance(target, candidate);
    const tolerance = Math.max(maxDistanceFloor, Math.floor(candidate.length / 3));
    if (score > tolerance) continue;
    if (best === undefined || score < best.score) best = { name: candidate, score };
  }
  return best?.name;
}
