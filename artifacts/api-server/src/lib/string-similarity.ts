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
    .replace(/^\s+|\s+$/g, ""); // Manual trim for Worker compatibility
}

// Title and credential tokens that should NOT contribute to person-name
// similarity. "Dr. John Smith MD" and "John Smith" are the same person; the
// raw normalize() above would penalize them ~40%. Used by name comparisons
// in npi-verify so "Dr. Micah Edwin, MD" matches "Micah Edwin" cleanly.
const TITLE_TOKENS: Record<string, boolean> = Object.create(null);
["dr", "doctor", "mr", "mrs", "ms", "miss"].forEach((t) => (TITLE_TOKENS[t] = true));

const CREDENTIAL_TOKENS: Record<string, boolean> = Object.create(null);
[
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
].forEach((t) => (CREDENTIAL_TOKENS[t] = true));

/**
 * Optimized name normalization that skips redundant regex processing when
 * the input is already pre-normalized.
 *
 * Manual tokenization loop avoids .split()/.filter()/.join() array allocations
 * and ensures compatibility with restricted Worker environments.
 */
export function normalizeNameFromNormalized(normalized: string): string {
  if (!normalized) return "";

  let result = "";
  let start = 0;
  let pos = 0;
  const len = normalized.length;

  while (pos <= len) {
    if (pos === len || normalized[pos] === " ") {
      if (pos > start) {
        const token = normalized.substring(start, pos);
        if (!TITLE_TOKENS[token] && !CREDENTIAL_TOKENS[token]) {
          if (result.length > 0) result += " ";
          result += token;
        }
      }
      start = pos + 1;
    }
    pos++;
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
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  // Prefix skipping
  let start = 0;
  const aLen = a.length;
  const bLen = b.length;
  while (start < aLen && start < bLen && a.charCodeAt(start) === b.charCodeAt(start)) {
    start++;
  }

  // Suffix skipping
  let aEnd = aLen - 1;
  let bEnd = bLen - 1;
  while (aEnd >= start && bEnd >= start && a.charCodeAt(aEnd) === b.charCodeAt(bEnd)) {
    aEnd--;
    bEnd--;
  }

  if (start > aEnd) return bEnd - start + 1;
  if (start > bEnd) return aEnd - start + 1;

  const s1Len = aEnd - start + 1;
  const s2Len = bEnd - start + 1;

  // Ensure s2 is the shorter string
  let s1 = a;
  let s2 = b;
  let s1Start = start;
  let s2Start = start;
  let n = s1Len;
  let m = s2Len;

  if (n < m) {
    [s1, s2] = [b, a];
    [s1Start, s2Start] = [s2Start, s1Start];
    [n, m] = [m, n];
  }

  const row = new Int32Array(m + 1);
  for (let j = 0; j <= m; j++) row[j] = j;

  for (let i = 1; i <= n; i++) {
    let prevDiag = row[0];
    row[0] = i;
    const char1 = s1.charCodeAt(s1Start + i - 1);
    for (let j = 1; j <= m; j++) {
      const temp = row[j];
      const cost = char1 === s2.charCodeAt(s2Start + j - 1) ? 0 : 1;
      row[j] = Math.min(
        row[j] + 1,
        row[j - 1] + 1,
        prevDiag + cost,
      );
      prevDiag = temp;
    }
  }
  return row[m];
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
