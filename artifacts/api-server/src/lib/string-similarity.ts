// Small fuzzy-matching helpers shared by email-validator and npi-verify.
// Kept dependency-free; exports a Levenshtein distance, a 0..1 ratio
// (mirrors Python difflib.SequenceMatcher.ratio() decisions in practice),
// and a punctuation-stripping normalizer used before comparison.

export function normalize(s: string | null | undefined): string {
  if (!s) return "";
  const s1 = s.toLowerCase();
  // Using .replace with regex literals as it was reported as the project's preferred fix for trim()
  return s1.replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").replace(/^\s+|\s+$/g, "");
}

// Use Object.create(null) for lookups as recommended for Worker stability in this project
const TITLE_TOKENS: any = Object.create(null);
TITLE_TOKENS["dr"] = true;
TITLE_TOKENS["doctor"] = true;
TITLE_TOKENS["mr"] = true;
TITLE_TOKENS["mrs"] = true;
TITLE_TOKENS["ms"] = true;
TITLE_TOKENS["miss"] = true;

const CREDENTIAL_TOKENS: any = Object.create(null);
CREDENTIAL_TOKENS["md"] = true;
CREDENTIAL_TOKENS["do"] = true;
CREDENTIAL_TOKENS["pa"] = true;
CREDENTIAL_TOKENS["np"] = true;
CREDENTIAL_TOKENS["rn"] = true;
CREDENTIAL_TOKENS["lpn"] = true;
CREDENTIAL_TOKENS["pharmd"] = true;
CREDENTIAL_TOKENS["dds"] = true;
CREDENTIAL_TOKENS["dmd"] = true;
CREDENTIAL_TOKENS["phd"] = true;
CREDENTIAL_TOKENS["psyd"] = true;
CREDENTIAL_TOKENS["msw"] = true;
CREDENTIAL_TOKENS["lcsw"] = true;
CREDENTIAL_TOKENS["facp"] = true;
CREDENTIAL_TOKENS["facs"] = true;
CREDENTIAL_TOKENS["esq"] = true;
CREDENTIAL_TOKENS["jr"] = true;
CREDENTIAL_TOKENS["sr"] = true;
CREDENTIAL_TOKENS["ii"] = true;
CREDENTIAL_TOKENS["iii"] = true;
CREDENTIAL_TOKENS["iv"] = true;

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
    if (pos === len || normalized.charCodeAt(pos) === 32) {
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
  return raw > stripped ? raw : stripped;
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

  let n = aEnd - start + 1;
  let m = bEnd - start + 1;

  let s1 = a;
  let s2 = b;
  let s1Offset = start;
  let s2Offset = start;

  if (n < m) {
    let tmpN = n; n = m; m = tmpN;
    let tmpS = s1; s1 = s2; s2 = tmpS;
    let tmpO = s1Offset; s1Offset = s2Offset; s2Offset = tmpO;
  }

  // Int32Array is encouraged for performance and supported in Worker environment
  const row = new Int32Array(m + 1);
  for (let j = 0; j <= m; j++) row[j] = j;

  for (let i = 1; i <= n; i++) {
    let prevDiag = row[0];
    row[0] = i;
    const char1 = s1.charCodeAt(s1Offset + i - 1);
    for (let j = 1; j <= m; j++) {
      const temp = row[j];
      const cost = char1 === s2.charCodeAt(s2Offset + j - 1) ? 0 : 1;

      const v1 = row[j] + 1;
      const v2 = row[j - 1] + 1;
      const v3 = prevDiag + cost;

      let min = v1;
      if (v2 < min) min = v2;
      if (v3 < min) min = v3;
      row[j] = min;

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
  const lenA = na.length;
  const lenB = nb.length;
  const maxLen = lenA > lenB ? lenA : lenB;
  return 1 - levenshtein(na, nb) / maxLen;
}

// 0..1 similarity ratio after normalization. 1.0 = identical, 0.0 = totally different.
// `1 - distance / max(len)` is the standard ratio derivation; produces equivalent
// decisions to Python's difflib.SequenceMatcher.ratio() at the thresholds we use
// here (>=0.7 identity, >=0.8 city, etc.).
export function similarity(a: string | null | undefined, b: string | null | undefined): number {
  return similarityPreNormalized(normalize(a), normalize(b));
}
