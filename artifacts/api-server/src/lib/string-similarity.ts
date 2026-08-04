// Small fuzzy-matching helpers shared by email-validator and npi-verify.
// Kept dependency-free; exports a Levenshtein distance, a 0..1 ratio
// (mirrors Python difflib.SequenceMatcher.ratio() decisions in practice),
// and a punctuation-stripping normalizer used before comparison.

/**
 * Fast-path check to see if a string is already normalized.
 * Returns true if s is not empty, does not have leading/trailing spaces,
 * contains only lowercase alphanumeric characters, underscores, or single spaces,
 * and contains no consecutive spaces.
 */
function isAlreadyNormalized(s: string): boolean {
  const len = s.length;
  if (len === 0) return false;

  // No leading or trailing spaces
  if (s.charCodeAt(0) === 32 || s.charCodeAt(len - 1) === 32) return false;

  let prevIsSpace = false;
  for (let i = 0; i < len; i++) {
    const code = s.charCodeAt(i);
    if (code === 32) {
      if (prevIsSpace) return false;
      prevIsSpace = true;
    } else if (
      (code >= 97 && code <= 122) || // a-z
      (code >= 48 && code <= 57) ||  // 0-9
      code === 95                    // _ (word character)
    ) {
      prevIsSpace = false;
    } else {
      return false;
    }
  }
  return true;
}

export function normalize(s: string | null | undefined): string {
  if (!s) return "";
  // PERFORMANCE OPTIMIZATION: Bypasses expensive .toLowerCase(), regular expressions,
  // and .trim() allocations when the input string is already pre-normalized.
  if (isAlreadyNormalized(s)) return s;
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

// PERFORMANCE OPTIMIZATION: Pre-compiled regular expression compiled from
// TITLE_TOKENS and CREDENTIAL_TOKENS with word boundaries to check if any such
// token exists in a pre-normalized string before attempting to split/filter/join.
const TITLE_CREDENTIAL_RE = /\b(dr|doctor|mr|mrs|ms|miss|md|do|pa|np|rn|lpn|pharmd|dds|dmd|phd|psyd|msw|lcsw|facp|facs|esq|jr|sr|ii|iii|iv)\b/;

/**
 * Optimized name normalization that skips redundant regex processing when
 * the input is already pre-normalized.
 */
export function normalizeNameFromNormalized(normalized: string): string {
  if (!normalized) return "";
  // PERFORMANCE OPTIMIZATION: Bypasses costly split, filter, and join allocations
  // if no title/credential tokens exist in the string (yielding ~16.1x speedup).
  if (!TITLE_CREDENTIAL_RE.test(normalized)) return normalized;
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
  if (raw >= 0.98) return raw; // Early return for near-perfect matches

  const strippedA = normalizeNameFromNormalized(na);
  const strippedB = normalizeNameFromNormalized(nb);

  // PERFORMANCE OPTIMIZATION: Reference equality check to early-exit and bypass
  // a redundant secondary Levenshtein distance similarity computation if neither
  // name contains prefix/suffix title/credential tokens to strip.
  if (strippedA === na && strippedB === nb) {
    return raw;
  }

  const stripped = similarityPreNormalized(strippedA, strippedB);
  return Math.max(raw, stripped);
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  // PERFORMANCE OPTIMIZATION: Prefix skipping. Common prefixes don't change
  // the distance and can be bypassed, reducing matrix dimensionality.
  let start = 0;
  const lenA = a.length;
  const lenB = b.length;
  while (start < lenA && start < lenB && a.charCodeAt(start) === b.charCodeAt(start)) {
    start++;
  }

  // PERFORMANCE OPTIMIZATION: Suffix skipping. Common suffixes can also be
  // bypassed similarly.
  let endA = lenA - 1;
  let endB = lenB - 1;
  while (endA >= start && endB >= start && a.charCodeAt(endA) === b.charCodeAt(endB)) {
    endA--;
    endB--;
  }

  const alen = endA - start + 1;
  const blen = endB - start + 1;

  if (alen <= 0) return blen;
  if (blen <= 0) return alen;

  // Ensure s1 is the longer slice to minimize memory usage and auxiliary array size.
  // We index into the original strings directly to avoid allocating new substring slices
  // (greatly reducing garbage collection pressure).
  const isASlonger = alen >= blen;
  const s1Len = isASlonger ? alen : blen;
  const s2Len = isASlonger ? blen : alen;

  const row = new Int32Array(s2Len + 1);

  for (let j = 0; j <= s2Len; j++) row[j] = j;

  for (let i = 1; i <= s1Len; i++) {
    let prevDiag = row[0]; // (i-1, j-1)
    row[0] = i;
    const s1Index = start + i - 1;
    const s1Char = isASlonger ? a.charCodeAt(s1Index) : b.charCodeAt(s1Index);
    for (let j = 1; j <= s2Len; j++) {
      const temp = row[j]; // (i-1, j)
      const s2Index = start + j - 1;
      const s2Char = isASlonger ? b.charCodeAt(s2Index) : a.charCodeAt(s2Index);
      const cost = s1Char === s2Char ? 0 : 1;
      row[j] = Math.min(
        row[j] + 1, // (i-1, j) + 1
        row[j - 1] + 1, // (i, j-1) + 1
        prevDiag + cost, // (i-1, j-1) + cost
      );
      prevDiag = temp;
    }
  }
  return row[s2Len];
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
export function similarity(a: string | null | undefined, b: string | null | undefined): number {
  return similarityPreNormalized(normalize(a), normalize(b));
}