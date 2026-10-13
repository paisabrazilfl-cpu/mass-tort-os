import crypto from "crypto";

/**
 * Fast backward digit extractor that extracts the last 10 ASCII digits
 * without regex or intermediate heap allocations. Returns null if fewer
 * than 10 digits are present.
 */
function extractLast10Digits(phone: string): string | null {
  let d0 = 0, d1 = 0, d2 = 0, d3 = 0, d4 = 0, d5 = 0, d6 = 0, d7 = 0, d8 = 0, d9 = 0;
  let count = 0;
  for (let i = phone.length - 1; i >= 0; i--) {
    const code = phone.charCodeAt(i);
    if (code >= 48 && code <= 57) {
      count++;
      switch (count) {
        case 1: d9 = code; break;
        case 2: d8 = code; break;
        case 3: d7 = code; break;
        case 4: d6 = code; break;
        case 5: d5 = code; break;
        case 6: d4 = code; break;
        case 7: d3 = code; break;
        case 8: d2 = code; break;
        case 9: d1 = code; break;
        case 10: d0 = code; break;
      }
      if (count === 10) break;
    }
  }
  if (count < 10) return null;
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
 *
 * Performance optimization:
 * - Uses early guards to skip processing when any input is nullish/empty.
 * - Extracts last 10 digits in a single backward pass without regex or array allocations.
 * - Checks phone digit count first so invalid phones return null before string lowercasing/trimming.
 */
export function leadLookupHash(
  tortType: string | null | undefined,
  email: string | null | undefined,
  phone: string | null | undefined,
): string | null {
  // Fast nullish / empty guards
  if (!tortType || !email || !phone) return null;

  // Extract phone digits first (fails fast if < 10 digits without doing string transformations)
  const phone10 = extractLast10Digits(phone);
  if (!phone10) return null;

  const tort = tortType.trim().toLowerCase();
  if (!tort) return null;

  const mail = email.trim().toLowerCase();
  if (!mail) return null;

  const norm = `${tort}|${mail}|${phone10}`;
  return crypto.createHash("sha256").update(norm).digest("hex");
}
