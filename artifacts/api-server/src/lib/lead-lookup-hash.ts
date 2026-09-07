import crypto from "crypto";

/**
 * Extracts the trailing 10 digits from a phone string without full-string regex
 * replacements or intermediate array/substring allocations.
 */
function extractLast10Digits(phone: string): string {
  let d0 = 0, d1 = 0, d2 = 0, d3 = 0, d4 = 0, d5 = 0, d6 = 0, d7 = 0, d8 = 0, d9 = 0;
  let count = 0;
  for (let i = phone.length - 1; i >= 0; i--) {
    const code = phone.charCodeAt(i);
    if (code >= 48 && code <= 57) {
      if (count === 0) d9 = code;
      else if (count === 1) d8 = code;
      else if (count === 2) d7 = code;
      else if (count === 3) d6 = code;
      else if (count === 4) d5 = code;
      else if (count === 5) d4 = code;
      else if (count === 6) d3 = code;
      else if (count === 7) d2 = code;
      else if (count === 8) d1 = code;
      else if (count === 9) {
        d0 = code;
        count = 10;
        break;
      }
      count++;
    }
  }
  if (count < 10) return "";
  return String.fromCharCode(d0, d1, d2, d3, d4, d5, d6, d7, d8, d9);
}

/**
 * Canonical SHA-256 hash over normalized (tort_type | email | phone10).
 * Stored on `leads.lookup_hash` at insert-time so `findExistingLeadForIntake`
 * can short-circuit the O(N)-decrypt phone-scan loop when an exact triple
 * match exists. Returns null when ANY component is missing — the column is
 * intentionally NOT populated for partial inputs because a hash collision
 * across (tort, email, "") and (tort, email, phone) would silently dedup
 * unrelated rows.
 */
export function leadLookupHash(
  tortType: string | null | undefined,
  email: string | null | undefined,
  phone: string | null | undefined,
): string | null {
  // Fast check: null/undefined/empty string short-circuit
  if (!tortType || !email || !phone) return null;

  const tort = tortType.trim().toLowerCase();
  if (!tort) return null;

  const mail = email.trim().toLowerCase();
  if (!mail) return null;

  // Extract last 10 digits without running full regex replace over whole string
  const phone10 = extractLast10Digits(phone);
  if (!phone10) return null;

  const norm = `${tort}|${mail}|${phone10}`;
  return crypto.createHash("sha256").update(norm).digest("hex");
}
