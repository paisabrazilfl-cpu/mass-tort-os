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
  return normalizeNameFromNormalized(normalize(s));
}

// Internal helper that avoids redundant normalization when comparing
// raw vs title-stripped variants.
function similarityPreNormalized(na: string, nb: string): number {
  if (na === nb) return 1;
  if (na === "" || nb === "") return 0;
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
  if (na === nb) return 1;

  const raw = similarityPreNormalized(na, nb);
  if (raw >= 0.99) return raw; // Early return for near-perfect matches

  const sna = normalizeNameFromNormalized(na);
  const snb = normalizeNameFromNormalized(nb);

  // If normalization didn't change anything, don't re-calculate
  if (sna === na && snb === nb) return raw;

  const stripped = similarityPreNormalized(sna, snb);
  return Math.max(raw, stripped);
}

// Optimized version of normalizeName that starts from an already-normalized string.
function normalizeNameFromNormalized(normalized: string): string {
  if (!normalized) return "";
  const tokens = normalized.split(" ").filter(Boolean);
  return tokens
    .filter((t) => !TITLE_TOKENS.has(t) && !CREDENTIAL_TOKENS.has(t))
    .join(" ");
}

// Optimised Levenshtein distance:
// 1. Uses Int32Array for better performance and less GC pressure.
// 2. Uses a single-vector approach to further reduce allocations.
// 3. Swaps a and b so b is always the shorter string, minimizing space.
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length < b.length) [a, b] = [b, a];
  if (b.length === 0) return a.length;

  const bLen = b.length;
  const v = new Int32Array(bLen + 1);
  for (let j = 0; j <= bLen; j++) v[j] = j;

  for (let i = 0; i < a.length; i++) {
    let lastValue = i + 1;
    let prevDiagonal = i;
    const charA = a.charCodeAt(i);
    for (let j = 0; j < bLen; j++) {
      const cost = charA === b.charCodeAt(j) ? 0 : 1;
      const currentValue = Math.min(v[j + 1] + 1, lastValue + 1, prevDiagonal + cost);
      prevDiagonal = v[j + 1];
      v[j + 1] = currentValue;
      lastValue = currentValue;
    }
  }
  return v[bLen];
}

// 0..1 similarity ratio after normalization. 1.0 = identical, 0.0 = totally different.
// `1 - distance / max(len)` is the standard ratio derivation; produces equivalent
// decisions to Python's difflib.SequenceMatcher.ratio() at the thresholds we use
// here (>=0.7 identity, >=0.8 city, etc.).
export function similarity(a: string | null | undefined, b: string | null | undefined): number {
  const na = normalize(a);
  const nb = normalize(b);
  return similarityPreNormalized(na, nb);
}
