// Small fuzzy-matching helpers shared by email-validator and npi-verify.
// Kept dependency-free; exports a Levenshtein distance, a 0..1 ratio
// (mirrors Python difflib.SequenceMatcher.ratio() decisions in practice),
// and a punctuation-stripping normalizer used before comparison.

const NON_ALPHANUM_RE = /[^\w\s]/g;
const WHITESPACE_RE = /\s+/g;
const TRIM_RE = /^\s+|\s+$/g;

export function normalize(s: string | null | undefined): string {
  if (!s) return "";
  const low = s.toLowerCase();
  const clean = low.replace(NON_ALPHANUM_RE, " ").replace(WHITESPACE_RE, " ").replace(TRIM_RE, "");
  return clean;
}

// Title and credential tokens that should NOT contribute to person-name
// similarity. "Dr. John Smith MD" and "John Smith" are the same person; the
// raw normalize() above would penalize them ~40%. Used by name comparisons
// in npi-verify so "Dr. Micah Edwin, MD" matches "Micah Edwin" cleanly.
// Using plain objects for Cloudflare Worker compatibility.
const TITLE_TOKENS: Record<string, boolean> = {};
const titleList = ["dr", "doctor", "mr", "mrs", "ms", "miss"];
for (let i = 0; i < titleList.length; i++) {
  TITLE_TOKENS[titleList[i]] = true;
}

const CREDENTIAL_TOKENS: Record<string, boolean> = {};
const credentialList = [
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
];
for (let i = 0; i < credentialList.length; i++) {
  CREDENTIAL_TOKENS[credentialList[i]] = true;
}

/**
 * Optimized name normalization that skips redundant regex processing when
 * the input is already pre-normalized.
 * Refactored to avoid split/filter/join for Cloudflare Worker compatibility.
 */
export function normalizeNameFromNormalized(normalized: string): string {
  if (!normalized) return "";
  let result = "";
  let start = 0;
  const len = normalized.length;
  let changed = false;

  while (start < len) {
    let end = normalized.indexOf(" ", start);
    if (end === -1) end = len;

    if (start < end) {
      const token = normalized.substring(start, end);
      if (TITLE_TOKENS[token] || CREDENTIAL_TOKENS[token]) {
        changed = true;
      } else {
        if (result.length > 0) result += " ";
        result += token;
      }
    } else {
      // Handles potential double spaces if they existed
      changed = true;
    }
    start = end + 1;
  }
  return changed ? result : normalized;
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

  const s_na = normalizeNameFromNormalized(na);
  const s_nb = normalizeNameFromNormalized(nb);

  // If no tokens were stripped, we already have the best possible score
  if (s_na === na && s_nb === nb) return raw;

  const stripped = similarityPreNormalized(s_na, s_nb);
  return Math.max(raw, stripped);
}

/**
 * Optimized Levenshtein distance with prefix and suffix skipping.
 * Refactored to avoid Int32Array and use indexed loops for Worker compatibility.
 */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;

  const aLen = a.length;
  const bLen = b.length;
  if (aLen === 0) return bLen;
  if (bLen === 0) return aLen;

  let start = 0;
  while (start < aLen && start < bLen && a.charCodeAt(start) === b.charCodeAt(start)) {
    start++;
  }

  let aEnd = aLen;
  let bEnd = bLen;
  while (aEnd > start && bEnd > start && a.charCodeAt(aEnd - 1) === b.charCodeAt(bEnd - 1)) {
    aEnd--;
    bEnd--;
  }

  if (start === aEnd) return bEnd - start;
  if (start === bEnd) return aEnd - start;

  const alen = aEnd - start;
  const blen = bEnd - start;

  // Use variables to ensure we iterate over the shorter string for the row array
  let s1: string, s2: string, minLen: number, maxLen: number;
  if (alen < blen) {
    s1 = b;
    s2 = a;
    minLen = alen;
    maxLen = blen;
  } else {
    s1 = a;
    s2 = b;
    minLen = blen;
    maxLen = alen;
  }

  // Plain array instead of Int32Array for worker compatibility
  const row = new Array(minLen + 1);
  for (let j = 0; j <= minLen; j++) row[j] = j;

  for (let i = 1; i <= maxLen; i++) {
    let prevDiag = row[0];
    row[0] = i;
    const s1Char = s1.charCodeAt(start + i - 1);
    for (let j = 1; j <= minLen; j++) {
      const temp = row[j];
      const cost = s1Char === s2.charCodeAt(start + j - 1) ? 0 : 1;

      let val = row[j] + 1;
      const v2 = row[j - 1] + 1;
      if (v2 < val) val = v2;
      const v3 = prevDiag + cost;
      if (v3 < val) val = v3;

      row[j] = val;
      prevDiag = temp;
    }
  }
  return row[minLen];
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
