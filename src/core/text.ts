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

/**
 * Parse a Lite key, `TypeName;id` (e.g. `Order;42`). Lives in core, not in a command module:
 * both `get` (entity addressing) and the filter parser (bare Lite values) need it, and a core
 * module importing upward into `commands/` — as filter.ts previously did — is a layering
 * inversion (Brooks review M1). Returns undefined for anything not shaped like a Lite key.
 */
export function parseLiteKey(value: string): { type: string; id: string } | undefined {
  const idx = value.indexOf(";");
  if (idx <= 0 || idx === value.length - 1) return undefined;
  const type = value.slice(0, idx);
  const id = value.slice(idx + 1);
  if (type === "" || id === "" || type.includes("/")) return undefined;
  return { type, id };
}

/**
 * Canonical form of a target base URL, so `https://app/` and `https://app` are the same
 * target (Brooks review M2). Used for BOTH credential matching and the metadata cache key,
 * which must agree — otherwise you log in and the next command says "no credential." Lowercases
 * scheme+host, drops a default port, and strips a trailing slash. Falls back to a trimmed
 * trailing-slash-stripped string if the input does not parse as a URL.
 */
export function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    u.search = "";
    const isDefaultPort =
      (u.protocol === "http:" && u.port === "80") || (u.protocol === "https:" && u.port === "443");
    if (isDefaultPort) u.port = "";
    let out = u.toString();
    if (out.endsWith("/") && u.pathname === "/") out = out.slice(0, -1);
    return out;
  } catch {
    return url.trim().replace(/\/+$/, "");
  }
}
