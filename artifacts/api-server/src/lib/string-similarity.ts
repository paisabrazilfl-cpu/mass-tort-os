// Small fuzzy-matching helpers shared by email-validator and npi-verify.
// Kept dependency-free; exports a Levenshtein distance, a 0..1 ratio
// (mirrors Python difflib.SequenceMatcher.ratio() decisions in practice),
// and a punctuation-stripping normalizer used before comparison.

// Fast-path helper to check if a string is already normalized (all lowercase, no punctuation,
// single spaces only, no leading/trailing spaces). Bypasses heavy regex and string manipulation.
function isNormalized(s: string): boolean {
  const len = s.length;
  if (len === 0) return false;
  if (s.charCodeAt(0) === 32 || s.charCodeAt(len - 1) === 32) return false;
  let lastWasSpace = false;
  for (let i = 0; i < len; i++) {
    const c = s.charCodeAt(i);
    // [a-z]
    if (c >= 97 && c <= 122) {
      lastWasSpace = false;
    } else if (c >= 48 && c <= 57) { // [0-9]
      lastWasSpace = false;
    } else if (c === 95) { // [_]
      lastWasSpace = false;
    } else if (c === 32) { // [ ]
      if (lastWasSpace) return false;
      lastWasSpace = true;
    } else {
      return false;
    }
  }
  return true;
}

export function normalize(s: string | null | undefined): string {
  if (!s) return "";
  if (isNormalized(s)) {
    return s;
  }
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

// Optimized pattern matching to check if a pre-normalized string contains any title or credential tokens.
// Since the input is already lowercased and stripped of special characters, we can check word boundaries
// extremely quickly and statically. This pre-compiled regex literal is fully compatible with the Cloudflare Worker
// static analyzer and has zero runtime overhead during module load.
const TITLE_CREDENTIAL_RE = /\b(?:dr|doctor|mr|mrs|ms|miss|md|do|pa|np|rn|lpn|pharmd|dds|dmd|phd|psyd|msw|lcsw|facp|facs|esq|jr|sr|ii|iii|iv)\b/;

/**
 * Optimized name normalization that skips redundant regex processing when
 * the input is already pre-normalized.
 */
export function normalizeNameFromNormalized(normalized: string): string {
  if (!normalized) return "";
  if (normalized.indexOf(" ") === -1) {
    if (TITLE_TOKENS.has(normalized) || CREDENTIAL_TOKENS.has(normalized)) {
      return "";
    }
    return normalized;
  }
  // If the normalized name does not contain any of the title or credential tokens,
  // we can immediately return it and skip expensive split/filter/join operations.
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
  if (strippedA === na && strippedB === nb) {
    return raw; // If neither contains title/credential tokens, bypass redundant second Levenshtein calculation
  }

  const stripped = similarityPreNormalized(strippedA, strippedB);
  return Math.max(raw, stripped);
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
