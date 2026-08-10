// Small fuzzy-matching helpers shared by email-validator and npi-verify.
// Kept dependency-free; exports a Levenshtein distance, a 0..1 ratio
// (mirrors Python difflib.SequenceMatcher.ratio() decisions in practice),
// and a punctuation-stripping normalizer used before comparison.

function isNormalized(s: string): boolean {
  const len = s.length;
  if (len === 0) return true;
  // Cannot start or end with a space
  if (s.charCodeAt(0) === 32 || s.charCodeAt(len - 1) === 32) return false;

  for (let i = 0; i < len; i++) {
    const code = s.charCodeAt(i);
    // Lowercase a-z
    if (code >= 97 && code <= 122) {
      continue;
    }
    // Digits 0-9
    if (code >= 48 && code <= 57) {
      continue;
    }
    // Underscore _ is matched by \w
    if (code === 95) {
      continue;
    }
    // Space
    if (code === 32) {
      // No consecutive spaces (we already checked start and end, so we can check if previous is space)
      if (s.charCodeAt(i - 1) === 32) return false;
      continue;
    }
    // Any other character is not normalized
    return false;
  }
  return true;
}

export function normalize(s: string | null | undefined): string {
  if (!s) return "";
  if (isNormalized(s)) return s;
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

// Combined case-insensitive regex compiled once for title and credential word boundaries to skip splits
const TITLE_CREDENTIAL_RE = /\b(dr|doctor|mr|mrs|ms|miss|md|do|pa|np|rn|lpn|pharmd|dds|dmd|phd|psyd|msw|lcsw|facp|facs|esq|jr|sr|ii|iii|iv)\b/i;

/**
 * Optimized name normalization that skips redundant regex processing when
 * the input is already pre-normalized.
 */
export function normalizeNameFromNormalized(normalized: string): string {
  if (!normalized) return "";
  if (!TITLE_CREDENTIAL_RE.test(normalized)) {
    return normalized;
  }
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
 * Optimized similarityName on ALREADY normalized strings.
 * Skips redundant name normalizations, and skips the second Levenshtein calculation
 * entirely if neither name contains any title/credential tokens.
 */
export function similarityNamePreNormalized(na: string, nb: string): number {
  const raw = similarityPreNormalized(na, nb);
  if (raw >= 0.98) return raw; // Early return for near-perfect matches

  // Check if either string has any title/credential tokens.
  // If neither does, stripped variant is identical to raw, so Math.max(raw, raw) is raw.
  if (!TITLE_CREDENTIAL_RE.test(na) && !TITLE_CREDENTIAL_RE.test(nb)) {
    return raw;
  }

  const stripped = similarityPreNormalized(
    normalizeNameFromNormalized(na),
    normalizeNameFromNormalized(nb),
  );
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

  // Ensure b is the shorter string to minimize memory usage and auxiliary array size
  let s1 = a;
  let s2 = b;
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
export function similarity(a: string | null | undefined, b: string | null | undefined): number {
  return similarityPreNormalized(normalize(a), normalize(b));
}
