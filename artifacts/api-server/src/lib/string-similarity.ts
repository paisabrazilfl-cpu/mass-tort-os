// Small fuzzy-matching helpers shared by email-validator and npi-verify.
// Kept dependency-free; exports a Levenshtein distance, a 0..1 ratio
// (mirrors Python difflib.SequenceMatcher.ratio() decisions in practice),
// and a punctuation-stripping normalizer used before comparison.

function isNormalized(s: string): boolean {
  const len = s.length;
  if (len === 0) return true;
  // No leading or trailing spaces allowed
  if (s.charCodeAt(0) === 32 || s.charCodeAt(len - 1) === 32) return false;

  let lastWasSpace = false;
  for (let i = 0; i < len; i++) {
    const code = s.charCodeAt(i);
    if (code === 32) {
      if (lastWasSpace) return false;
      lastWasSpace = true;
    } else if (
      (code >= 97 && code <= 122) || // a-z
      (code >= 48 && code <= 57) || // 0-9
      code === 95 // _
    ) {
      lastWasSpace = false;
    } else {
      return false;
    }
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

// A compiled regular expression using word boundaries for matching any of
// the known title/credential tokens. Helps fast-path name comparisons.
const TITLE_CREDENTIAL_RE =
  /\b(dr|doctor|mr|mrs|ms|miss|md|do|pa|np|rn|lpn|pharmd|dds|dmd|phd|psyd|msw|lcsw|facp|facs|esq|jr|sr|ii|iii|iv)\b/;

/**
 * Optimized name normalization that skips redundant regex processing when
 * the input is already pre-normalized.
 */
export function normalizeNameFromNormalized(normalized: string): string {
  if (!normalized) return "";
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

  const stripped = similarityPreNormalized(
    normalizeNameFromNormalized(na),
    normalizeNameFromNormalized(nb),
  );
  return Math.max(raw, stripped);
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const lenA = a.length;
  const lenB = b.length;

  let start = 0;
  while (
    start < lenA &&
    start < lenB &&
    a.charCodeAt(start) === b.charCodeAt(start)
  ) {
    start++;
  }

  let endA = lenA - 1;
  let endB = lenB - 1;
  while (
    endA >= start &&
    endB >= start &&
    a.charCodeAt(endA) === b.charCodeAt(endB)
  ) {
    endA--;
    endB--;
  }

  const alen = endA - start + 1;
  const blen = endB - start + 1;

  if (alen === 0) return blen;
  if (blen === 0) return alen;

  // Ensure blen is the shorter remaining length to minimize memory usage and auxiliary array size
  let s1 = a;
  let s2 = b;
  let s1Len = alen;
  let s2Len = blen;
  if (s1Len < s2Len) {
    s1 = b;
    s2 = a;
    s1Len = blen;
    s2Len = alen;
  }

  const row = new Int32Array(s2Len + 1);
  for (let j = 0; j <= s2Len; j++) row[j] = j;

  for (let i = 1; i <= s1Len; i++) {
    let prevDiag = row[0]; // (i-1, j-1)
    row[0] = i;
    const charS1 = s1.charCodeAt(start + i - 1);
    for (let j = 1; j <= s2Len; j++) {
      const temp = row[j]; // (i-1, j)
      const cost = charS1 === s2.charCodeAt(start + j - 1) ? 0 : 1;
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
export function similarity(
  a: string | null | undefined,
  b: string | null | undefined,
): number {
  return similarityPreNormalized(normalize(a), normalize(b));
}
