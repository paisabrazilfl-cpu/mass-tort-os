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
 * Optimized name normalization that skips redundant regex processing when
 * the input is already pre-normalized.
 */
export function normalizeNameFromNormalized(normalized: string): string {
  if (!normalized) return "";
  const tokens = normalized.split(" ");
  return tokens
    .filter((t) => !TITLE_TOKENS.has(t) && !CREDENTIAL_TOKENS.has(t))
    .join(" ");
}

// Strip title and credential tokens AFTER applying normalize(), so that
// name similarity reflects the actual person name. Returns "" when the
// input collapses to only stripped tokens.
export function normalizeName(s: string | null | undefined): string {
  return normalizeNameFromNormalized(normalize(s));
}

/**
 * Convenience: similarity that also tries the title-stripped variant on already-normalized strings.
 */
export function similarityNamePreNormalized(na: string, nb: string): number {
  const raw = similarityPreNormalized(na, nb);
  if (raw >= 0.98) return raw; // Early return for near-perfect matches

  const strippedA = normalizeNameFromNormalized(na);
  const strippedB = normalizeNameFromNormalized(nb);

  // Fast-path: if neither name contains title/credential tokens, the stripped strings
  // will be identical to the pre-normalized strings. We can skip the second Levenshtein calculation!
  if (strippedA === na && strippedB === nb) {
    return raw;
  }

  const stripped = similarityPreNormalized(strippedA, strippedB);
  return Math.max(raw, stripped);
}

// Convenience: similarity that also tries the title-stripped variant and
// returns whichever is HIGHER. Strictly additive — can never lower a
// previously-passing score; existing thresholds keep their meaning.
export function similarityName(
  a: string | null | undefined,
  b: string | null | undefined,
): number {
  return similarityNamePreNormalized(normalize(a), normalize(b));
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let start = 0;
  const minLen = Math.min(a.length, b.length);
  while (start < minLen && a.charCodeAt(start) === b.charCodeAt(start)) {
    start++;
  }

  let end1 = a.length - 1;
  let end2 = b.length - 1;
  while (
    end1 >= start &&
    end2 >= start &&
    a.charCodeAt(end1) === b.charCodeAt(end2)
  ) {
    end1--;
    end2--;
  }

  if (end1 < start) return end2 - start + 1;
  if (end2 < start) return end1 - start + 1;

  // Slice only if we actually skipped prefixes or suffixes
  let s1 = start > 0 || end1 < a.length - 1 ? a.slice(start, end1 + 1) : a;
  let s2 = start > 0 || end2 < b.length - 1 ? b.slice(start, end2 + 1) : b;

  if (s1.length < s2.length) {
    [s1, s2] = [s2, s1];
  }

  const alen = s1.length;
  const blen = s2.length;
  const row = new Int32Array(blen + 1);

  for (let j = 0; j <= blen; j++) row[j] = j;

  for (let i = 1; i <= alen; i++) {
    let prevDiag = row[0]; // (i-1, j-1)
    row[0] = i;
    for (let j = 1; j <= blen; j++) {
      const temp = row[j]; // (i-1, j)
      const cost = s1.charCodeAt(i - 1) === s2.charCodeAt(j - 1) ? 0 : 1;
      row[j] = Math.min(
        row[j] + 1, // (i-1, j) + 1
        row[j - 1] + 1, // (i, j-1) + 1
        prevDiag + cost, // (i-1, j-1) + cost
      );
      prevDiag = temp;
    }
  }
  return row[blen];
}

/**
 * Internal helper: 0..1 similarity ratio between two ALREADY normalized strings.
 */
export function similarityPreNormalized(na: string, nb: string): number {
  if (na === nb) return 1;
  if (na === "" || nb === "") return 0;
  const maxLen = Math.max(na.length, nb.length);
  return 1 - levenshtein(na, nb) / maxLen;
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
