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

// Strip title and credential tokens AFTER applying normalize(), so that
// name similarity reflects the actual person name. Returns "" when the
// input collapses to only stripped tokens.
export function normalizeName(s: string | null | undefined): string {
  const normalized = normalize(s);
  return _normalizeNameFromNormalized(normalized);
}

/** Internal helper to avoid re-normalizing the same string twice. */
function _normalizeNameFromNormalized(normalized: string): string {
  if (!normalized) return "";
  const tokens = normalized.split(" ");
  let result = "";
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t && !TITLE_TOKENS.has(t) && !CREDENTIAL_TOKENS.has(t)) {
      result += (result ? " " : "") + t;
    }
  }
  return result;
}

/**
 * Optimized Levenshtein distance using a single Int32Array to minimize
 * GC pressure and memory allocations. Also swaps strings so 'b' is the
 * shorter one, further reducing the vector size.
 */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length < b.length) {
    [a, b] = [b, a];
  }
  const aLen = a.length;
  const bLen = b.length;
  if (bLen === 0) return aLen;

  // We only need one row of the matrix to calculate the distance.
  const v0 = new Int32Array(bLen + 1);
  for (let j = 0; j <= bLen; j++) {
    v0[j] = j;
  }

  for (let i = 0; i < aLen; i++) {
    let prevLeft = i + 1;
    let prevDiagonal = i;
    const aChar = a.charCodeAt(i);

    for (let j = 0; j < bLen; j++) {
      const cost = aChar === b.charCodeAt(j) ? 0 : 1;
      const current = Math.min(prevLeft + 1, v0[j + 1] + 1, prevDiagonal + cost);
      prevDiagonal = v0[j + 1];
      v0[j + 1] = current;
      prevLeft = current;
    }
  }

  return v0[bLen];
}

// 0..1 similarity ratio after normalization. 1.0 = identical, 0.0 = totally different.
// `1 - distance / max(len)` is the standard ratio derivation; produces equivalent
// decisions to Python's difflib.SequenceMatcher.ratio() at the thresholds we use
// here (>=0.7 identity, >=0.8 city, etc.).
export function similarity(a: string | null | undefined, b: string | null | undefined): number {
  const na = normalize(a);
  const nb = normalize(b);
  return _similarityFromNormalized(na, nb);
}

/** Internal helper to avoid re-normalizing when the caller already has them. */
function _similarityFromNormalized(na: string, nb: string): number {
  if (na === "" && nb === "") return 1;
  if (na === "" || nb === "") return 0;
  if (na === nb) return 1;
  const maxLen = Math.max(na.length, nb.length);
  return 1 - levenshtein(na, nb) / maxLen;
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
  const raw = _similarityFromNormalized(na, nb);
  if (raw === 1) return 1;

  const strippedA = _normalizeNameFromNormalized(na);
  const strippedB = _normalizeNameFromNormalized(nb);

  // If stripping didn't change anything, the result is already in 'raw'
  if (strippedA === na && strippedB === nb) return raw;

  const stripped = _similarityFromNormalized(strippedA, strippedB);
  return Math.max(raw, stripped);
}
