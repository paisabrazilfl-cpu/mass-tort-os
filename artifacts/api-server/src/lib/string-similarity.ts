// Small fuzzy-matching helpers shared by email-validator and npi-verify.
// Kept dependency-free; exports a Levenshtein distance, a 0..1 ratio
// (mirrors Python difflib.SequenceMatcher.ratio() decisions in practice),
// and a punctuation-stripping normalizer used before comparison.

export function normalize(s: string | null | undefined): string {
  if (!s) return "";

  // Fast path for clean strings: already lowercase alphanumeric/space with single spaces
  let clean = true;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    // lowercase a-z (97-122), 0-9 (48-57), underscore (95)
    if (
      (code >= 97 && code <= 122) ||
      (code >= 48 && code <= 57) ||
      code === 95
    ) {
      continue;
    } else if (code === 32) {
      // no leading space, no trailing space, no double space
      if (i === 0 || s.charCodeAt(i - 1) === 32) {
        clean = false;
        break;
      }
    } else {
      clean = false;
      break;
    }
  }
  if (clean && s.length > 0 && s.charCodeAt(s.length - 1) !== 32) {
    return s;
  }

  // Single-pass replacement: replace contiguous sequences of non-word chars with a space
  return s
    .toLowerCase()
    .replace(/[^\w]+/g, " ")
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

// Pre-compiled regex to test if a pre-normalized string contains any title or credential tokens
const TITLE_CREDENTIAL_RE = new RegExp(
  `\\b(?:${[...TITLE_TOKENS, ...CREDENTIAL_TOKENS].join("|")})\\b`,
);

/**
 * Optimized name normalization that skips redundant regex processing when
 * the input is already pre-normalized.
 */
export function normalizeNameFromNormalized(normalized: string): string {
  if (!normalized) return "";
  // Fast path: if no title or credential tokens exist, return normalized string without split/filter/join allocations
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

  // Fast path: if neither string contained title/credential tokens to strip, skip redundant Levenshtein calculation
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

  let start = 0;
  let aEnd = a.length;
  let bEnd = b.length;

  // Fast path: skip common prefix characters
  while (start < aEnd && start < bEnd && a.charCodeAt(start) === b.charCodeAt(start)) {
    start++;
  }

  // Fast path: skip common suffix characters
  while (aEnd > start && bEnd > start && a.charCodeAt(aEnd - 1) === b.charCodeAt(bEnd - 1)) {
    aEnd--;
    bEnd--;
  }

  const alen = aEnd - start;
  const blen = bEnd - start;

  if (alen === 0) return blen;
  if (blen === 0) return alen;

  // Ensure b-slice (s2) is the shorter string to minimize auxiliary array size
  let s1 = a;
  let s1Start = start;
  let s1Len = alen;
  let s2 = b;
  let s2Start = start;
  let s2Len = blen;

  if (s1Len < s2Len) {
    s1 = b;
    s1Start = start;
    s1Len = blen;
    s2 = a;
    s2Start = start;
    s2Len = alen;
  }

  const row = new Int32Array(s2Len + 1);

  for (let j = 0; j <= s2Len; j++) row[j] = j;

  for (let i = 1; i <= s1Len; i++) {
    let prevDiag = row[0]; // (i-1, j-1)
    row[0] = i;
    const charCode1 = s1.charCodeAt(s1Start + i - 1);
    for (let j = 1; j <= s2Len; j++) {
      const temp = row[j]; // (i-1, j)
      const cost = charCode1 === s2.charCodeAt(s2Start + j - 1) ? 0 : 1;
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
