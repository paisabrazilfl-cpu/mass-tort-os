// Small fuzzy-matching helpers shared by email-validator and npi-verify.
// Kept dependency-free; exports a Levenshtein distance, a 0..1 ratio
// (mirrors Python difflib.SequenceMatcher.ratio() decisions in practice),
// and a punctuation-stripping normalizer used before comparison.

export function normalize(s: string | null | undefined): string {
  if (!s) return "";
  return s
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Title and credential tokens that should NOT contribute to person-name
// similarity. "Dr. John Smith MD" and "John Smith" are the same person; the
// raw normalize() above would penalize them ~40%. Used by name comparisons
// in npi-verify so "Dr. Micah Edwin, MD" matches "Micah Edwin" cleanly.
const TITLE_TOKENS = new Set(["dr", "doctor", "mr", "mrs", "ms", "miss"]);
const CREDENTIAL_TOKENS = new Set([
  "md",
  "do",
  "pa",
  "np",
  "rn",
  "lpn",
  "pharmd",
  "dds",
  "dmd",
  "phd",
  "psyd",
  "msw",
  "lcsw",
  "facp",
  "facs",
  "esq",
  "jr",
  "sr",
  "ii",
  "iii",
  "iv",
]);

// Strip title and credential tokens AFTER applying normalize(), so that
// name similarity reflects the actual person name. Returns "" when the
// input collapses to only stripped tokens.
export function normalizeName(s: string | null | undefined): string {
  return normalizeNameFromNormalized(normalize(s));
}

/**
 * Internal helper to strip credentials from an ALREADY-normalized string.
 * Reduces regex-heavy re-normalization in similarityName wrappers.
 */
export function normalizeNameFromNormalized(normalized: string): string {
  if (!normalized) return "";
  const tokens = normalized.split(" ").filter(Boolean);
  return tokens
    .filter((t) => !TITLE_TOKENS.has(t) && !CREDENTIAL_TOKENS.has(t))
    .join(" ");
}

// Convenience: similarity that also tries the title-stripped variant and
// returns whichever is HIGHER. Strictly additive — can never lower a
// previously-passing score; existing thresholds keep their meaning.
export function similarityName(
  a: string | null | undefined,
  b: string | null | undefined,
): number {
  const na = normalize(a);
  const nb = normalize(b);

  // Path 1: Raw similarity
  const raw = similarityPreNormalized(na, nb);
  if (raw >= 0.99) return raw; // Early return for near-exact matches

  // Path 2: Stripped similarity
  const sa = normalizeNameFromNormalized(na);
  const sb = normalizeNameFromNormalized(nb);

  // Only run stripped comparison if it's actually different from raw
  if (sa === na && sb === nb) return raw;

  const stripped = similarityPreNormalized(sa, sb);
  return Math.max(raw, stripped);
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  // Swap to ensure 'b' is the shorter string, minimizing space to O(min(N, M))
  if (a.length < b.length) {
    [a, b] = [b, a];
  }

  const n = a.length;
  const m = b.length;
  const v = new Int32Array(m + 1);

  for (let j = 0; j <= m; j++) {
    v[j] = j;
  }

  for (let i = 1; i <= n; i++) {
    let prevDiag = v[0];
    v[0] = i;
    for (let j = 1; j <= m; j++) {
      const prevDiagTemp = v[j];
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      v[j] = Math.min(v[j] + 1, v[j - 1] + 1, prevDiag + cost);
      prevDiag = prevDiagTemp;
    }
  }

  return v[m];
}

// 0..1 similarity ratio after normalization. 1.0 = identical, 0.0 = totally different.
// `1 - distance / max(len)` is the standard ratio derivation; produces equivalent
// decisions to Python's difflib.SequenceMatcher.ratio() at the thresholds we use
// here (>=0.7 identity, >=0.8 city, etc.).
export function similarity(
  a: string | null | undefined,
  b: string | null | undefined,
): number {
  return similarityPreNormalized(normalize(a), normalize(b));
}

/**
 * Internal similarity logic that skips the normalize() step.
 * Used to avoid redundant normalization in similarityName().
 */
export function similarityPreNormalized(na: string, nb: string): number {
  if (na === nb) return 1;
  if (na === "" || nb === "") return 0;
  const maxLen = Math.max(na.length, nb.length);
  return 1 - levenshtein(na, nb) / maxLen;
}
