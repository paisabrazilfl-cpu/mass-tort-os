// Small fuzzy-matching helpers shared by email-validator and npi-verify.
// Kept dependency-free; exports a Levenshtein distance, a 0..1 ratio
// (mirrors Python difflib.SequenceMatcher.ratio() decisions in practice),
// and a punctuation-stripping normalizer used before comparison.

function isNormalized(s: string): boolean {
  if (s.length === 0) return true;
  if (s.charCodeAt(0) === 32 || s.charCodeAt(s.length - 1) === 32) return false;
  let prevSpace = false;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code === 32) {
      if (prevSpace) return false;
      prevSpace = true;
    } else {
      prevSpace = false;
      if (
        !(code >= 97 && code <= 122) &&
        !(code >= 48 && code <= 57) &&
        code !== 95
      ) {
        return false;
      }
    }
  }
  return true;
}

export function normalize(s: string | null | undefined): string {
  if (!s) return "";
  if (isNormalized(s)) return s;
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

/**
 * Optimized name normalization that skips redundant regex processing when
 * the input is already pre-normalized.
 */
const TITLE_CREDENTIAL_RE = new RegExp(
  `\\b(?:${Array.from(TITLE_TOKENS).concat(Array.from(CREDENTIAL_TOKENS)).join("|")})\\b`,
);

export function normalizeNameFromNormalized(normalized: string): string {
  if (!normalized) return "";
  if (!TITLE_CREDENTIAL_RE.test(normalized)) return normalized;
  return normalized
    .split(" ")
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

  let s1 = a;
  let s2 = b;

  // Trim common prefix
  let start = 0;
  while (
    start < s1.length &&
    start < s2.length &&
    s1.charCodeAt(start) === s2.charCodeAt(start)
  ) {
    start++;
  }

  // Trim common suffix
  let end1 = s1.length - 1;
  let end2 = s2.length - 1;
  while (
    end2 >= start &&
    end1 >= start &&
    s1.charCodeAt(end1) === s2.charCodeAt(end2)
  ) {
    end1--;
    end2--;
  }

  let alen = end1 - start + 1;
  let blen = end2 - start + 1;

  if (blen <= 0) return alen;
  if (alen <= 0) return blen;

  // Ensure s2/blen is the shorter string
  if (alen < blen) {
    const tmpStr = s1;
    s1 = s2;
    s2 = tmpStr;

    const tmpLen = alen;
    alen = blen;
    blen = tmpLen;
  }

  const row = new Int32Array(blen + 1);
  for (let j = 0; j <= blen; j++) row[j] = j;

  for (let i = 1; i <= alen; i++) {
    let prevDiag = row[0]; // (i-1, j-1)
    row[0] = i;
    const charCode1 = s1.charCodeAt(start + i - 1);
    for (let j = 1; j <= blen; j++) {
      const temp = row[j]; // (i-1, j)
      const cost = charCode1 === s2.charCodeAt(start + j - 1) ? 0 : 1;
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
