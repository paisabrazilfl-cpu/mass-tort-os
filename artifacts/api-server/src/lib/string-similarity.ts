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

// Strip title and credential tokens from a pre-normalized string.
// Returns "" when the input collapses to only stripped tokens.
function stripNameTokens(normalized: string): string {
  const tokens = normalized.split(" ").filter(Boolean);
  const filtered = tokens.filter((t) => !TITLE_TOKENS.has(t) && !CREDENTIAL_TOKENS.has(t));
  if (filtered.length === tokens.length) return normalized;
  return filtered.join(" ");
}

export function normalizeName(s: string | null | undefined): string {
  return stripNameTokens(normalize(s));
}

// Convenience: similarity that also tries the title-stripped variant and
// returns whichever is HIGHER. Strictly additive — can never lower a
// previously-passing score; existing thresholds keep their meaning.
export function similarityName(a: string | null | undefined, b: string | null | undefined): number {
  const na = normalize(a);
  const nb = normalize(b);
  const raw = calculateSimilarity(na, nb);
  if (raw === 1) return 1;

  const sa = stripNameTokens(na);
  const sb = stripNameTokens(nb);

  // If stripping didn't change anything, the score won't change.
  if (sa === na && sb === nb) return raw;

  const stripped = calculateSimilarity(sa, sb);
  return Math.max(raw, stripped);
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  // Ensure b is the shorter string to minimize Int32Array size
  if (a.length < b.length) [a, b] = [b, a];
  if (b.length === 0) return a.length;

  const bLen = b.length;
  const v = new Int32Array(bLen + 1);
  for (let i = 0; i <= bLen; i++) v[i] = i;

  for (let i = 0; i < a.length; i++) {
    let prev = i;
    v[0] = i + 1;
    const aChar = a.charCodeAt(i);
    for (let j = 0; j < bLen; j++) {
      const nextPrev = v[j + 1];
      const cost = aChar === b.charCodeAt(j) ? 0 : 1;
      v[j + 1] = Math.min(v[j] + 1, v[j + 1] + 1, prev + cost);
      prev = nextPrev;
    }
  }
  return v[bLen];
}

// Internal helper that accepts pre-normalized strings.
function calculateSimilarity(na: string, nb: string): number {
  if (na === "" && nb === "") return 1;
  if (na === "" || nb === "") return 0;
  const maxLen = Math.max(na.length, nb.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(na, nb) / maxLen;
}

// 0..1 similarity ratio after normalization. 1.0 = identical, 0.0 = totally different.
// `1 - distance / max(len)` is the standard ratio derivation; produces equivalent
// decisions to Python's difflib.SequenceMatcher.ratio() at the thresholds we use
// here (>=0.7 identity, >=0.8 city, etc.).
export function similarity(a: string | null | undefined, b: string | null | undefined): number {
  return calculateSimilarity(normalize(a), normalize(b));
}
