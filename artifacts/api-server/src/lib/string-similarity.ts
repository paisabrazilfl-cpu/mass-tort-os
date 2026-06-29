// Small fuzzy-matching helpers shared by email-validator and npi-verify.
// Kept dependency-free; exports a Levenshtein distance, a 0..1 ratio
// (mirrors Python difflib.SequenceMatcher.ratio() decisions in practice),
// and a punctuation-stripping normalizer used before comparison.

const NORMALIZE_RE_PUNCT = /[^\w\s]/g;
const NORMALIZE_RE_SPACE = /\s+/g;

export function normalize(s: string | null | undefined): string {
  if (!s) return "";
  return s
    .toLowerCase()
    .replace(NORMALIZE_RE_PUNCT, " ")
    .replace(NORMALIZE_RE_SPACE, " ")
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

  let result = "";
  let start = 0;
  let end = normalized.indexOf(" ");

  while (end !== -1) {
    const t = normalized.substring(start, end);
    if (t.length > 0 && !TITLE_TOKENS.has(t) && !CREDENTIAL_TOKENS.has(t)) {
      if (result.length > 0) result += " ";
      result += t;
    }
    start = end + 1;
    end = normalized.indexOf(" ", start);
  }

  const lastToken = normalized.substring(start);
  if (lastToken.length > 0 && !TITLE_TOKENS.has(lastToken) && !CREDENTIAL_TOKENS.has(lastToken)) {
    if (result.length > 0) result += " ";
    result += lastToken;
  }

  return result;
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
  let alen = a.length;
  let blen = b.length;
  if (alen === 0) return blen;
  if (blen === 0) return alen;

  // Prefix skipping
  let start = 0;
  while (start < alen && start < blen && a.charCodeAt(start) === b.charCodeAt(start)) {
    start++;
  }
  if (start === alen) return blen - start;
  if (start === blen) return alen - start;

  // Suffix skipping
  while (alen > start && blen > start && a.charCodeAt(alen - 1) === b.charCodeAt(blen - 1)) {
    alen--;
    blen--;
  }

  let len1 = alen - start;
  let len2 = blen - start;

  // Ensure s2 is the shorter string
  let s1 = a;
  let s2 = b;
  if (len1 < len2) {
    s1 = b;
    s2 = a;
    const tmp = len1;
    len1 = len2;
    len2 = tmp;
  }

  const row = new Int32Array(len2 + 1);
  for (let j = 0; j <= len2; j++) row[j] = j;

  for (let i = 1; i <= len1; i++) {
    let prevDiag = row[0];
    row[0] = i;
    const charS1 = s1.charCodeAt(start + i - 1);
    for (let j = 1; j <= len2; j++) {
      const temp = row[j];
      const cost = charS1 === s2.charCodeAt(start + j - 1) ? 0 : 1;
      row[j] = Math.min(
        row[j] + 1,
        row[j - 1] + 1,
        prevDiag + cost,
      );
      prevDiag = temp;
    }
  }
  return row[len2];
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
