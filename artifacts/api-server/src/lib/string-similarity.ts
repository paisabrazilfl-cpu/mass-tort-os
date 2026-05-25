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

/**
 * Strips title and credential tokens from a PRE-NORMALIZED string.
 * This avoids re-running normalize() multiple times in similarityName().
 */
export function stripTokens(normalized: string): string {
  if (!normalized) return "";
  const tokens = normalized.split(" ").filter(Boolean);
  return tokens
    .filter((t) => !TITLE_TOKENS.has(t) && !CREDENTIAL_TOKENS.has(t))
    .join(" ");
}

// Strip title and credential tokens AFTER applying normalize(), so that
// name similarity reflects the actual person name. Returns "" when the
// input collapses to only stripped tokens.
export function normalizeName(s: string | null | undefined): string {
  return stripTokens(normalize(s));
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

  const raw = similarityPreNormalized(na, nb);
  if (raw >= 0.99) return raw; // Exact or near-exact match, skip stripped check

  const strippedA = stripTokens(na);
  const strippedB = stripTokens(nb);

  // If stripping didn't change anything, just return raw
  if (strippedA === na && strippedB === nb) return raw;

  const stripped = similarityPreNormalized(strippedA, strippedB);
  return Math.max(raw, stripped);
}

/**
 * Optimized Levenshtein distance using a single Int32Array and string length swapping.
 * Swapping ensures the buffer is as small as possible (min(a.len, b.len) + 1).
 */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length < b.length) {
    [a, b] = [b, a];
  }

  const aLen = a.length;
  const bLen = b.length;
  if (bLen === 0) return aLen;

  // Swapping strings above ensures b is always the shorter string,
  // so we only need bLen + 1 elements.
  const v = new Int32Array(bLen + 1);
  for (let j = 0; j <= bLen; j++) v[j] = j;

  for (let i = 0; i < aLen; i++) {
    let lastValue = i + 1;
    for (let j = 0; j < bLen; j++) {
      const cost = a.charCodeAt(i) === b.charCodeAt(j) ? 0 : 1;
      const newValue = Math.min(
        v[j + 1] + 1, // deletion
        lastValue + 1, // insertion
        v[j] + cost // substitution
      );
      v[j] = lastValue;
      lastValue = newValue;
    }
    v[bLen] = lastValue;
  }

  return v[bLen];
}

/**
 * Internal helper for 0..1 similarity ratio between two ALREADY NORMALIZED strings.
 */
export function similarityPreNormalized(na: string, nb: string): number {
  if (na === "" && nb === "") return 1;
  if (na === "" || nb === "") return 0;
  if (na === nb) return 1;

  const maxLen = Math.max(na.length, nb.length);
  return 1 - levenshtein(na, nb) / maxLen;
}

// 0..1 similarity ratio after normalization. 1.0 = identical, 0.0 = totally different.
// `1 - distance / max(len)` is the standard ratio derivation; produces equivalent
// decisions to Python's difflib.SequenceMatcher.ratio() at the thresholds we use
// here (>=0.7 identity, >=0.8 city, etc.).
export function similarity(a: string | null | undefined, b: string | null | undefined): number {
  return similarityPreNormalized(normalize(a), normalize(b));
}
