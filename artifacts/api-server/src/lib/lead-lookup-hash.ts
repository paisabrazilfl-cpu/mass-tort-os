import crypto from "crypto";

/**
 * Extract the trailing 10 ASCII digits from a phone string using right-to-left
 * character inspection. Avoids regex `.replace(/\D/g, "")` compilation and
 * intermediate string allocations.
 */
function extractLast10Digits(phone: string): string {
  const len = phone.length;
  if (len < 10) return "";

  let count = 0;
  let c9 = 0, c8 = 0, c7 = 0, c6 = 0, c5 = 0, c4 = 0, c3 = 0, c2 = 0, c1 = 0, c0 = 0;

  for (let i = len - 1; i >= 0; i--) {
    const code = phone.charCodeAt(i);
    if (code >= 48 && code <= 57) {
      count++;
      if (count === 1) c9 = code;
      else if (count === 2) c8 = code;
      else if (count === 3) c7 = code;
      else if (count === 4) c6 = code;
      else if (count === 5) c5 = code;
      else if (count === 6) c4 = code;
      else if (count === 7) c3 = code;
      else if (count === 8) c2 = code;
      else if (count === 9) c1 = code;
      else {
        c0 = code;
        return String.fromCharCode(c0, c1, c2, c3, c4, c5, c6, c7, c8, c9);
      }
    }
  }

  return "";
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
  // Fast falsy short-circuit for missing/partial inputs to bypass string normalizations
  if (!tortType || !email || !phone) return null;

  const phone10 = extractLast10Digits(phone);
  if (!phone10) return null;

  const tort = tortType.trim().toLowerCase();
  if (!tort) return null;

  const mail = email.trim().toLowerCase();
  if (!mail) return null;

  const norm = `${tort}|${mail}|${phone10}`;
  return crypto.createHash("sha256").update(norm).digest("hex");
}
