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

const RFC_EMAIL_REGEX = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

const DISPOSABLE_DOMAINS = [
  "tempmail.com", "throwaway.email", "guerrillamail.com", "mailinator.com",
  "yopmail.com", "sharklasers.com", "trashmail.com", "10minutemail.com",
  "fakeinbox.com", "dispostable.com", "maildrop.cc", "guerrillamailblock.com",
];

export interface EmailValidationResult {
  valid: boolean;
  errors: string[];
  suggestion?: string;
}

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

  const parts = trimmed.split("@");
  if (parts.length !== 2) {
    errors.push("INVALID_EMAIL_STRUCTURE");
    return { valid: false, errors };
  }

  const [localPart, domain] = parts;

  if (localPart.length === 0 || localPart.length > 64) {
    errors.push("INVALID_LOCAL_PART");
  }

  if (domain.length === 0 || domain.length > 253) {
    errors.push("INVALID_DOMAIN");
  }

  if (!domain.includes(".")) {
    errors.push("MISSING_TLD");
  }

  if (TYPO_DOMAINS[domain]) {
    errors.push("TYPO_DOMAIN_DETECTED");
    suggestion = `${localPart}@${TYPO_DOMAINS[domain]}`;
  }

  for (const tld of MALFORMED_TLDS) {
    if (trimmed.endsWith(tld)) {
      errors.push("MALFORMED_TLD");
      const corrected = trimmed.slice(0, -tld.length) + ".com";
      suggestion = corrected;
      break;
    }
  }

  if (DISPOSABLE_DOMAINS.includes(domain)) {
    errors.push("DISPOSABLE_EMAIL");
  }

  const suspiciousPatterns = [
    /^test@/,
    /^fake@/,
    /^none@/,
    /^noemail@/,
    /^na@/,
    /^asdf/,
    /^aaa+@/,
  ];
  for (const pat of suspiciousPatterns) {
    if (pat.test(trimmed)) {
      errors.push("SUSPICIOUS_EMAIL_PATTERN");
      break;
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    suggestion,
  };
}
