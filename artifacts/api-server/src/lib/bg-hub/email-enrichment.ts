/**
 * Email enrichment — fraud + provenance signals layered on top of the
 * existing MX-validation in lib/email-validator.ts.
 *
 * Free signals only. No API key required. Two checks:
 *
 *  1. Disposable / throwaway domain match against a curated allowlist
 *     of known disposable-email providers (Mailinator, Guerrilla Mail,
 *     10minutemail, TempMail, Burner Mail, …). Disposable addresses
 *     are nearly 100% fraud in mass-tort intake.
 *
 *  2. Free-provider role-based pattern detection (info@gmail.com,
 *     admin@…, support@…). For a CLAIMANT email these patterns are
 *     almost always wrong-person / shared-mailbox red flags.
 *
 * What this does NOT do (would need a paid signup):
 *   - HaveIBeenPwned breach lookup (free with attribution, but the
 *     contract bumped to k-anonymity-only — still doable, deferred to
 *     a follow-up to keep this patch focused).
 *   - WHOIS-domain-age check (requires either a paid WHOIS API or a
 *     local whois binary; deferred).
 *   - Emailable / Kickbox / NeverBounce risk scoring.
 *
 * The signals here are deliberately conservative — every flag we
 * emit corresponds to behavior that's hard to explain away as a
 * legitimate intake.
 */

// Hand-curated. Adding a domain to this list is a small one-line
// change; the list deliberately omits "free but legitimate" providers
// (gmail, outlook, yahoo) because those are normal claimant emails.
//
// Source: cross-referenced against the publicly maintained
// `disposable-email-domains` list (~3K entries). We carry an
// intentionally smaller curated subset — adding entries is cheap, but
// false positives that flag a real claimant are expensive.
const DISPOSABLE_DOMAINS: ReadonlySet<string> = new Set([
  "mailinator.com",
  "mailinator.net",
  "guerrillamail.com",
  "guerrillamail.net",
  "guerrillamail.org",
  "10minutemail.com",
  "10minutemail.net",
  "tempmail.com",
  "tempmail.net",
  "temp-mail.org",
  "throwawaymail.com",
  "trashmail.com",
  "yopmail.com",
  "yopmail.net",
  "yopmail.fr",
  "fakeinbox.com",
  "getairmail.com",
  "maildrop.cc",
  "mintemail.com",
  "sharklasers.com",
  "spam4.me",
  "dispostable.com",
  "mailcatch.com",
  "burnermail.io",
  "anonbox.net",
  "deadaddress.com",
  "emailondeck.com",
  "fakemailgenerator.com",
  "incognitomail.com",
  "jetable.org",
  "mt2015.com",
  "tempinbox.com",
  "trbvm.com",
  "wegwerfemail.de",
  "mvrht.com",
  "moakt.com",
  "tmail.ws",
  "20minutemail.com",
  "33mail.com",
]);

const FREE_PROVIDER_DOMAINS: ReadonlySet<string> = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "yahoo.com",
  "ymail.com",
  "aol.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "proton.me",
  "protonmail.com",
]);

const ROLE_LOCAL_PARTS: ReadonlySet<string> = new Set([
  "admin",
  "info",
  "support",
  "contact",
  "sales",
  "noreply",
  "no-reply",
  "donotreply",
  "hello",
  "team",
  "webmaster",
  "postmaster",
  "abuse",
  "marketing",
  "billing",
  "office",
]);

export interface EmailEnrichmentResult {
  email: string;
  domain: string | null;
  local_part: string | null;
  is_disposable: boolean;
  is_free_provider: boolean;
  is_role_based: boolean;
  flags: string[];
  notes: string[];
}

export function enrichEmail(email: string | null | undefined): EmailEnrichmentResult {
  const raw = String(email || "").trim().toLowerCase();
  if (!raw || !raw.includes("@")) {
    return {
      email: raw,
      domain: null,
      local_part: null,
      is_disposable: false,
      is_free_provider: false,
      is_role_based: false,
      flags: [],
      notes: [],
    };
  }
  const at = raw.lastIndexOf("@");
  const localPart = raw.slice(0, at);
  const domain = raw.slice(at + 1);
  const flags: string[] = [];
  const notes: string[] = [];

  const isDisposable = DISPOSABLE_DOMAINS.has(domain);
  const isFree = FREE_PROVIDER_DOMAINS.has(domain);
  const isRole = ROLE_LOCAL_PARTS.has(localPart);

  if (isDisposable) {
    flags.push("disposable_domain");
    notes.push(`Email domain "${domain}" is a known disposable / throwaway provider.`);
  }
  if (isRole) {
    flags.push("role_based_email");
    notes.push(`Email local-part "${localPart}" is a role address, not a personal one.`);
  }
  // A free provider alone is not a red flag — gmail.com is normal. But
  // a free-provider + role-based combo is unusual for an individual
  // claimant, so we let both flags fire and the escalation rules
  // decide how to handle the combo.
  return {
    email: raw,
    domain,
    local_part: localPart,
    is_disposable: isDisposable,
    is_free_provider: isFree,
    is_role_based: isRole,
    flags,
    notes,
  };
}
