// Small fuzzy-matching helpers shared by email-validator and npi-verify.
// Kept dependency-free; exports a Levenshtein distance, a 0..1 ratio
// (mirrors Python difflib.SequenceMatcher.ratio() decisions in practice),
// and a punctuation-stripping normalizer used before comparison.

/**
 * Fast-path helper to check if a string is already normalized:
 * - Only lowercase letters, digits, underscores, and single spaces.
 * - No leading or trailing spaces.
 * - No multiple consecutive spaces.
 */
function isNormalized(s: string): boolean {
  const len = s.length;
  if (len === 0) return true;
  // Check leading/trailing spaces
  if (s.charCodeAt(0) === 32 || s.charCodeAt(len - 1) === 32) return false;

  let prevSpace = false;
  for (let i = 0; i < len; i++) {
    const code = s.charCodeAt(i);
    if (code === 32) {
      if (prevSpace) return false;
      prevSpace = true;
    } else if (
      (code >= 97 && code <= 122) || // a-z
      (code >= 48 && code <= 57) ||  // 0-9
      code === 95                   // _
    ) {
      prevSpace = false;
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

// Dynamically compile a RegExp covering all TITLE_TOKENS and CREDENTIAL_TOKENS as whole words.
const TITLE_CREDENTIAL_RE = new RegExp(
  `\\b(?:${[...TITLE_TOKENS, ...CREDENTIAL_TOKENS].join("|")})\\b`,
  "i"
);

/**
 * Optimized name normalization that skips redundant regex processing when
 * the input is already pre-normalized.
 */
export function normalizeNameFromNormalized(normalized: string): string {
  if (!normalized) return "";
  // Fast path: if there are no title or credential tokens present, return unchanged.
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

  // Fast path: if neither name contained any title or credential tokens,
  // the stripped strings are identical to na/nb and raw is already correct.
  if (strippedA === na && strippedB === nb) {
    return raw;
  }

  const stripped = similarityPreNormalized(strippedA, strippedB);
  return Math.max(raw, stripped);
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const len1 = a.length;
  const len2 = b.length;
  if (len1 === 0) return len2;
  if (len2 === 0) return len1;

  // Track common prefix
  let start = 0;
  while (start < len1 && start < len2 && a.charCodeAt(start) === b.charCodeAt(start)) {
    start++;
  }

  // Track common suffix
  let end1 = len1 - 1;
  let end2 = len2 - 1;
  while (end1 >= start && end2 >= start && a.charCodeAt(end1) === b.charCodeAt(end2)) {
    end1--;
    end2--;
  }

  let alen = end1 - start + 1;
  let blen = end2 - start + 1;

  if (alen === 0) return blen;
  if (blen === 0) return alen;

  // Ensure s2/blen is the shorter remaining slice to minimize memory usage and auxiliary array size
  let s1 = a;
  let s2 = b;
  let s1Start = start;
  let s2Start = start;
  if (alen < blen) {
    s1 = b;
    s2 = a;
    const tmp = alen;
    alen = blen;
    blen = tmp;
  }

  const row = new Int32Array(blen + 1);
  for (let j = 0; j <= blen; j++) row[j] = j;

  for (let i = 1; i <= alen; i++) {
    let prevDiag = row[0]; // (i-1, j-1)
    row[0] = i;
    const charCodeS1 = s1.charCodeAt(s1Start + i - 1);
    for (let j = 1; j <= blen; j++) {
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
