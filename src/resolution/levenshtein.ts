// Levenshtein distance — pure deterministic edit distance.
// Used by the fuzzy filer name resolver. Not exposed in any tool surface.

/**
 * Edit distance between two strings (insertions/deletions/substitutions).
 * Returns the minimum number of single-character edits to transform `a` to `b`.
 * Uses a single-row dynamic-programming buffer for O(min(|a|,|b|)) memory.
 */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  // Ensure b is the shorter string for memory.
  if (a.length < b.length) {
    const tmp = a;
    a = b;
    b = tmp;
  }
  const m = a.length;
  const n = b.length;
  let prev = new Array<number>(n + 1);
  let curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      const del = (prev[j] ?? 0) + 1;
      const ins = (curr[j - 1] ?? 0) + 1;
      const sub = (prev[j - 1] ?? 0) + cost;
      curr[j] = Math.min(del, ins, sub);
    }
    const swap = prev;
    prev = curr;
    curr = swap;
  }
  return prev[n] ?? 0;
}

/** Similarity in [0, 1]: 1 minus normalized edit distance. */
export function similarity(a: string, b: string): number {
  const max = Math.max(a.length, b.length);
  if (max === 0) return 1;
  return 1 - levenshtein(a, b) / max;
}
