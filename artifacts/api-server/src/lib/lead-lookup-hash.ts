import crypto from "crypto";

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
  const tort = (tortType ?? "").trim().toLowerCase();
  const mail = (email ?? "").trim().toLowerCase();
  const phoneDigits = (phone ?? "").replace(/\D/g, "");
  const phone10 =
    phoneDigits.length >= 10
      ? phoneDigits.substring(phoneDigits.length - 10)
      : "";
  if (!tort || !mail || !phone10) return null;
  const norm = `${tort}|${mail}|${phone10}`;
  return crypto.createHash("sha256").update(norm).digest("hex");
}
