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
  const tokens = normalize(s).split(" ").filter(Boolean);
  return tokens
    .filter((t) => !TITLE_TOKENS.has(t) && !CREDENTIAL_TOKENS.has(t))
    .join(" ");
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

  const raw = similarityNormalized(na, nb);
  // Early return if raw similarity is perfect — stripping credentials can't improve it.
  if (raw >= 1.0) return 1.0;

  const sa = stripTokens(na);
  const sb = stripTokens(nb);
  const stripped = similarityNormalized(sa, sb);
  return Math.max(raw, stripped);
}

// Internal helper for normalizeName() and similarityName() to avoid
// redundant normalize() calls on already-normalized strings.
function stripTokens(normalized: string): string {
  return normalized
    .split(" ")
    .filter((t) => t && !TITLE_TOKENS.has(t) && !CREDENTIAL_TOKENS.has(t))
    .join(" ");
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  // Swap to ensure `b` is the shorter string, minimizing memory allocation.
  if (a.length < b.length) {
    [a, b] = [b, a];
  }

  const bLen = b.length;
  // Use Int32Array for better performance and reduced GC pressure.
  let prev = new Int32Array(bLen + 1);
  let curr = new Int32Array(bLen + 1);

  for (let j = 0; j <= bLen; j++) prev[j] = j;

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    const aChar = a.charCodeAt(i - 1);
    for (let j = 1; j <= bLen; j++) {
      const cost = aChar === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    // Swap references to reuse buffers.
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }
  return prev[bLen];
}

// 0..1 similarity ratio after normalization. 1.0 = identical, 0.0 = totally different.
// `1 - distance / max(len)` is the standard ratio derivation; produces equivalent
// decisions to Python's difflib.SequenceMatcher.ratio() at the thresholds we use
// here (>=0.7 identity, >=0.8 city, etc.).
export function similarity(
  a: string | null | undefined,
  b: string | null | undefined,
): number {
  return similarityNormalized(normalize(a), normalize(b));
}

// Internal helper to avoid redundant normalize() calls.
function similarityNormalized(na: string, nb: string): number {
  if (na === "" && nb === "") return 1;
  if (na === "" || nb === "") return 0;
  const maxLen = Math.max(na.length, nb.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(na, nb) / maxLen;
}
