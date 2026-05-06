import { z } from "zod";

/**
 * Shared fax-number normalizer + validator.
 *
 * Accepts the loose human formats operators paste in ("(614) 455-2138",
 * "614.455.2138 ext 2", "+1 614 455 2138") and produces a canonical pair:
 *
 *   - tenDigit  — bare 10-digit US/CA number ("6144552138"). What SRFax
 *                 and most CSP fax APIs actually want on the wire.
 *   - e164      — "+16144552138". What we persist on lead.hospital_fax
 *                 and surface in the UI / audit log.
 *
 * Rules:
 *   - Strip everything that isn't a digit or leading "+".
 *   - Drop a leading "+" or country-code "1" if present.
 *   - Reject anything that is not exactly 10 digits after normalization.
 *   - Reject obvious garbage (all zeros, all same digit) so a typo doesn't
 *     cause us to fax a stranger.
 *
 * International (non-NANP) faxes are out of scope for v1 — every adapter
 * we ship today (SRFax) is NANP-only, and the medical-records-request
 * use case is U.S.-centric.
 */
export interface NormalizedFax {
  ok: true;
  tenDigit: string;
  e164: string;
}
export interface NormalizedFaxError {
  ok: false;
  code: "empty" | "too_short" | "too_long" | "invalid_digits";
  message: string;
}

export function normalizeFaxNumber(raw: string | null | undefined): NormalizedFax | NormalizedFaxError {
  if (raw == null) return { ok: false, code: "empty", message: "Fax number is required." };
  const s = String(raw).trim();
  if (!s) return { ok: false, code: "empty", message: "Fax number is required." };

  // Strip extension suffixes ("ext 5", "x123", "#10") before counting digits —
  // a fax extension would otherwise inflate the digit count past 10 and trip
  // the too_long check below.
  const noExt = s.replace(/\s*(?:ext\.?|x|#)\s*\d+\s*$/i, "");
  // Keep digits only — drop "+", spaces, dashes, parens, dots, letters.
  let digits = noExt.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) digits = digits.slice(1);

  if (digits.length < 10) {
    return { ok: false, code: "too_short", message: `Fax number must be 10 digits (got ${digits.length}).` };
  }
  if (digits.length > 10) {
    return { ok: false, code: "too_long", message: `Fax number must be 10 digits (got ${digits.length}).` };
  }
  // Reject NANP-impossible numbers: area code can't start with 0 or 1,
  // exchange (NXX) can't start with 0 or 1.
  if (digits[0] === "0" || digits[0] === "1") {
    return { ok: false, code: "invalid_digits", message: "Invalid area code." };
  }
  if (digits[3] === "0" || digits[3] === "1") {
    return { ok: false, code: "invalid_digits", message: "Invalid exchange code." };
  }
  // Reject obvious garbage (all same digit).
  if (/^(\d)\1+$/.test(digits)) {
    return { ok: false, code: "invalid_digits", message: "Fax number looks invalid." };
  }
  return { ok: true, tenDigit: digits, e164: `+1${digits}` };
}

/**
 * Zod schema that accepts a raw fax string and emits the E.164 form on
 * successful parse. Use in route bodies / form configs that need a fax field.
 */
export const FaxNumberSchema = z
  .string()
  .min(1, "Fax number is required")
  .transform((raw, ctx) => {
    const result = normalizeFaxNumber(raw);
    if (!result.ok) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: result.message });
      return z.NEVER;
    }
    return result.e164;
  });
