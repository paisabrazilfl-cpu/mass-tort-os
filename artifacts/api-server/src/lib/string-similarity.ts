// Small fuzzy-matching helpers shared by email-validator and npi-verify.
// Kept dependency-free; exports a Levenshtein distance, a 0..1 ratio
// (mirrors Python difflib.SequenceMatcher.ratio() decisions in practice),
// and a punctuation-stripping normalizer used before comparison.

export function normalize(s: string | null | undefined): string {
  if (!s) return "";

  // Fast-path check: is the string already normalized?
  // A normalized string cannot have leading/trailing spaces, consecutive spaces,
  // or any characters other than lowercase alphanumeric [a-z0-9] and single spaces.
  const len = s.length;
  if (len > 0 && s.charCodeAt(0) !== 32 && s.charCodeAt(len - 1) !== 32) {
    let isClean = true;
    let prevSpace = false;
    for (let i = 0; i < len; i++) {
      const code = s.charCodeAt(i);
      if (code === 32) { // space
        if (prevSpace) {
          isClean = false;
          break;
        }
        prevSpace = true;
      } else if (
        (code >= 97 && code <= 122) || // a-z
        (code >= 48 && code <= 57)    // 0-9
      ) {
        prevSpace = false;
      } else {
        isClean = false;
        break;
      }
    }
    if (isClean) {
      return s;
    }
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

// Dynamically construct a regular expression to test if a string contains any
// of the title/credential tokens on word boundaries. This avoids splitting
// and iterating when none of these tokens exist.
const ALL_TOKENS_LIST = [...TITLE_TOKENS, ...CREDENTIAL_TOKENS];
const TITLE_CREDENTIAL_RE = new RegExp(
  `\\b(?:${ALL_TOKENS_LIST.join("|")})\\b`,
  "i"
);

/**
 * Optimized name normalization that skips redundant regex processing when
 * the input is already pre-normalized.
 */
export function normalizeNameFromNormalized(normalized: string): string {
  if (!normalized) return "";

  // Fast-path: if the pre-normalized string does not contain any title or
  // credential tokens, return it immediately to bypass split/filter/join allocations.
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

  // Fast-path reference check: if neither string has any title/credential tokens,
  // we can bypass the redundant second similarity calculation.
  if (strippedA === na && strippedB === nb) {
    return raw;
  }

  const stripped = similarityPreNormalized(strippedA, strippedB);
  return Math.max(raw, stripped);
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const alen = a.length;
  const blen = b.length;
  if (alen === 0) return blen;
  if (blen === 0) return alen;

  // Common prefix skipping to reduce computation bounds
  let start = 0;
  const minLen = Math.min(alen, blen);
  while (start < minLen && a.charCodeAt(start) === b.charCodeAt(start)) {
    start++;
  }

  // Common suffix skipping to reduce computation bounds
  let endA = alen - 1;
  let endB = blen - 1;
  while (endA >= start && endB >= start && a.charCodeAt(endA) === b.charCodeAt(endB)) {
    endA--;
    endB--;
  }

  const lenA = endA - start + 1;
  const lenB = endB - start + 1;

  if (lenA <= 0) return lenB;
  if (lenB <= 0) return lenA;

  // Ensure s2 is the shorter remaining string to minimize memory usage and auxiliary array size
  let s1 = a;
  let s2 = b;
  let s1Start = start;
  let s2Start = start;
  let s1Len = lenA;
  let s2Len = lenB;

  if (s1Len < s2Len) {
    s1 = b;
    s2 = a;
    s1Start = start;
    s2Start = start;
    s1Len = lenB;
    s2Len = lenA;
  }

  const row = new Int32Array(s2Len + 1);

  for (let j = 0; j <= s2Len; j++) row[j] = j;

  for (let i = 1; i <= s1Len; i++) {
    let prevDiag = row[0]; // (i-1, j-1)
    row[0] = i;
    const charCodeS1 = s1.charCodeAt(s1Start + i - 1);
    for (let j = 1; j <= s2Len; j++) {
      const temp = row[j]; // (i-1, j)
      const cost = charCodeS1 === s2.charCodeAt(s2Start + j - 1) ? 0 : 1;
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
