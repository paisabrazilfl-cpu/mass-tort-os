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
  const tokens = normalize(s).split(" ").filter(Boolean);
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
  if (na === "" && nb === "") return 1;

  const raw = similarityNormalized(na, nb);
  const stripped = similarityNormalized(normalizeNameNormalized(na), normalizeNameNormalized(nb));
  return Math.max(raw, stripped);
}

/**
 * Strip title and credential tokens from an ALREADY-normalized string.
 */
function normalizeNameNormalized(na: string): string {
  const tokens = na.split(" ").filter(Boolean);
  return tokens
    .filter((t) => !TITLE_TOKENS.has(t) && !CREDENTIAL_TOKENS.has(t))
    .join(" ");
}

/**
 * Standard Levenshtein distance (edit distance).
 * Optimized implementation:
 *  - Uses Int32Array to reduce GC pressure.
 *  - Swaps strings so the shorter string is used for the array dimension.
 *  - Single-vector implementation to minimize memory overhead.
 *  - Inline min calls for performance.
 */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length < b.length) {
    const tmp = a;
    a = b;
    b = tmp;
  }
  const n = a.length;
  const m = b.length;
  if (m === 0) return n;

  const v = new Int32Array(m + 1);
  for (let j = 0; j <= m; j++) v[j] = j;

  for (let i = 1; i <= n; i++) {
    let prev = v[0];
    v[0] = i;
    const charA = a.charCodeAt(i - 1);
    for (let j = 1; j <= m; j++) {
      const temp = v[j];
      if (charA === b.charCodeAt(j - 1)) {
        v[j] = prev;
      } else {
        // v[j-1] is (i, j-1) - insertion
        // v[j] is (i-1, j) - deletion
        // prev is (i-1, j-1) - substitution
        let min = v[j - 1];
        if (v[j] < min) min = v[j];
        if (prev < min) min = prev;
        v[j] = min + 1;
      }
      prev = temp;
    }
  }
  return v[m];
}

// 0..1 similarity ratio after normalization. 1.0 = identical, 0.0 = totally different.
// `1 - distance / max(len)` is the standard ratio derivation; produces equivalent
// decisions to Python's difflib.SequenceMatcher.ratio() at the thresholds we use
// here (>=0.7 identity, >=0.8 city, etc.).
export function similarity(a: string | null | undefined, b: string | null | undefined): number {
  return similarityNormalized(normalize(a), normalize(b));
}

/**
 * Similarity ratio for strings that are already normalized.
 * Internal helper to avoid redundant normalization in similarityName.
 */
function similarityNormalized(na: string, nb: string): number {
  if (na === "" && nb === "") return 1;
  if (na === "" || nb === "") return 0;
  const maxLen = Math.max(na.length, nb.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(na, nb) / maxLen;
}
