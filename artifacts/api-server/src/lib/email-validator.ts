import { levenshtein } from "./string-similarity";

const TYPO_DOMAINS: Record<string, string> = {
  "gnail.com": "gmail.com",
  "gmial.com": "gmail.com",
  "gmai.com": "gmail.com",
  "gmal.com": "gmail.com",
  "gmali.com": "gmail.com",
  "gamil.com": "gmail.com",
  "yaho.com": "yahoo.com",
  "yahooo.com": "yahoo.com",
  "yhaoo.com": "yahoo.com",
  "yhoo.com": "yahoo.com",
  "hotmial.com": "hotmail.com",
  "hotmal.com": "hotmail.com",
  "hotmai.com": "hotmail.com",
  "hotamil.com": "hotmail.com",
  "outlookk.com": "outlook.com",
  "outllook.com": "outlook.com",
  "outlok.com": "outlook.com",
  "outook.com": "outlook.com",
  "aol.con": "aol.com",
  "gmail.con": "gmail.com",
  "gmail.vom": "gmail.com",
  "gmail.cmo": "gmail.com",
  "yahoo.con": "yahoo.com",
  "yahoo.vom": "yahoo.com",
  "yahoo.cmo": "yahoo.com",
  "hotmail.con": "hotmail.com",
  "hotmail.vom": "hotmail.com",
  "outlook.con": "outlook.com",
  "outlook.vom": "outlook.com",
};

const MALFORMED_TLDS = [".vom", ".con", ".cmo", ".coom", ".comm", ".cim", ".ocm", ".cm"];

const COMMON_PROVIDERS_FUZZY: Array<{ prefix: string; canonical: string; minLen: number }> = [
  { prefix: "gmail", canonical: "gmail.com", minLen: 5 },
  { prefix: "yahoo", canonical: "yahoo.com", minLen: 5 },
  { prefix: "hotmail", canonical: "hotmail.com", minLen: 6 },
  { prefix: "outlook", canonical: "outlook.com", minLen: 6 },
  { prefix: "icloud", canonical: "icloud.com", minLen: 5 },
  { prefix: "protonmail", canonical: "protonmail.com", minLen: 8 },
];

function findFuzzyProviderMatch(domain: string): string | null {
  if (!domain.endsWith(".com")) return null;
  const prefix = domain.slice(0, -4);
  if (prefix.length < 3) return null;

  let bestCanonical: string | null = null;
  let minDistance = Infinity;

  for (const { prefix: known, canonical, minLen } of COMMON_PROVIDERS_FUZZY) {
    if (prefix.length < minLen) continue;
    if (prefix === known) return null;
    // Anchor on the first character to avoid classifying real-but-similar
    // domains (ymail.com, email.com, cloud.com) as typos of gmail/icloud.
    if (prefix[0] !== known[0]) continue;
    const dist = levenshtein(prefix, known);
    const threshold = known.length <= 7 ? 3 : 4;
    if (dist === 0 || dist > threshold) continue;
    if (dist < minDistance) {
      bestCanonical = canonical;
      minDistance = dist;
    }
  }
  return bestCanonical;
}

const RFC_EMAIL_REGEX = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

// Hoisted Set for O(1) constant-time disposable domain lookups
const DISPOSABLE_DOMAINS_SET = new Set([
  "tempmail.com", "throwaway.email", "guerrillamail.com", "mailinator.com",
  "yopmail.com", "sharklasers.com", "trashmail.com", "10minutemail.com",
  "fakeinbox.com", "dispostable.com", "maildrop.cc", "guerrillamailblock.com",
]);

// Hoisted static regex patterns to avoid re-instantiating RegExp objects per call
const SUSPICIOUS_PATTERNS = [
  /^test@/,
  /^fake@/,
  /^none@/,
  /^noemail@/,
  /^na@/,
  /^asdf/,
  /^aaa+@/,
];

export interface EmailValidationResult {
  valid: boolean;
  errors: string[];
  suggestion?: string;
}

// Codes that are advisory ("did you mean ...?") rather than hard failures.
// They remain in `errors` for backwards compatibility with existing UI that
// renders the codes verbatim, but they are excluded from the `valid` boolean
// so callers (e.g. the form-submission pipeline) do not reject leads on a
// suggested-correction signal.
const ADVISORY_CODES = new Set(["TYPO_DOMAIN_DETECTED", "LIKELY_TYPO_DOMAIN"]);

export function validateEmail(email: string): EmailValidationResult {
  const errors: string[] = [];
  let suggestion: string | undefined;

  if (!email || typeof email !== "string") {
    return { valid: false, errors: ["MISSING_EMAIL"] };
  }

  const trimmed = email.trim().toLowerCase();

  if (!RFC_EMAIL_REGEX.test(trimmed)) {
    errors.push("INVALID_RFC_FORMAT");
    return { valid: false, errors };
  }

  const atIndex = trimmed.indexOf("@");
  if (atIndex === -1) {
    errors.push("INVALID_EMAIL_STRUCTURE");
    return { valid: false, errors };
  }

  const localPart = trimmed.slice(0, atIndex);
  const domain = trimmed.slice(atIndex + 1);

  if (localPart.length === 0 || localPart.length > 64) {
    errors.push("INVALID_LOCAL_PART");
  }

  if (domain.length === 0 || domain.length > 253) {
    errors.push("INVALID_DOMAIN");
  }

  if (!domain.includes(".")) {
    errors.push("MISSING_TLD");
  }

  const typoTarget = TYPO_DOMAINS[domain];
  if (typoTarget) {
    errors.push("TYPO_DOMAIN_DETECTED");
    suggestion = `${localPart}@${typoTarget}`;
  } else {
    const fuzzyMatch = findFuzzyProviderMatch(domain);
    if (fuzzyMatch) {
      errors.push("LIKELY_TYPO_DOMAIN");
      suggestion = `${localPart}@${fuzzyMatch}`;
    }
  }

  if (!trimmed.endsWith(".com")) {
    for (const tld of MALFORMED_TLDS) {
      if (trimmed.endsWith(tld)) {
        errors.push("MALFORMED_TLD");
        suggestion = trimmed.slice(0, -tld.length) + ".com";
        break;
      }
    }
  }

  if (DISPOSABLE_DOMAINS_SET.has(domain)) {
    errors.push("DISPOSABLE_EMAIL");
  }

  for (const pat of SUSPICIOUS_PATTERNS) {
    if (pat.test(trimmed)) {
      errors.push("SUSPICIOUS_EMAIL_PATTERN");
      break;
    }
  }

  // Fast check: avoid .filter() array allocations on every call
  let isValid = true;
  if (errors.length > 0) {
    for (let i = 0; i < errors.length; i++) {
      if (!ADVISORY_CODES.has(errors[i]!)) {
        isValid = false;
        break;
      }
    }
  }

  return {
    valid: isValid,
    errors,
    suggestion,
  };
}
