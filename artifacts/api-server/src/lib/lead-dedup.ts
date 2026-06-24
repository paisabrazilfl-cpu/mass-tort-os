import { and, eq, isNotNull, or, sql } from "drizzle-orm";
import { db, leadsTable } from "@workspace/db";
import { decrypt } from "./encryption";
import { leadLookupHash } from "./lead-lookup-hash";
import { logger } from "./logger";

/**
 * Shared lead deduplication helper used by every public intake surface
 * (Web Forms widget + Form Engine email-link intake). The product rule
 * is: a single human filling out the website widget AND the emailed
 * intake form for the SAME mass tort campaign must end up as ONE lead
 * row ("signee"), not two.
 *
 * Matching is intentionally scoped to the same tort. The same person
 * can legitimately be a claimant in Roundup AND Camp Lejeune at the
 * same time — those are different cases, different signees, different
 * envelopes. Cross-tort dedup would be product-incorrect.
 *
 * Match precedence:
 *   1. Email match — EXACT case-insensitive equality. We deliberately
 *      do NOT use SQL `ILIKE` because that interprets `_` and `%` as
 *      pattern wildcards. An attacker submitting `victim_a@x.com` could
 *      otherwise be matched against `victimXa@x.com` and tamper with
 *      the wrong lead.
 *   2. Phone match — decrypt with the same `(value, "phone")` /
 *      `(value, "phone_primary")` field-name signature that production
 *      uses on insert (see `encryptLeadFields` in lib/encryption.ts).
 *      Without the field name, AES-GCM AAD verification fails and
 *      every encrypted phone returns `[DECRYPTION_ERROR]`, silently
 *      degrading dedup to email-only.
 *
 * Returns null when no match exists. Never throws — a dedup failure
 * must NEVER block a legitimate intake submission, so internal errors
 * are logged and degrade to "no match" (i.e. a fresh INSERT).
 *
 * NOTE: this helper does READ-then-WRITE without a transaction or
 * unique index. Concurrent submissions for the same email could both
 * miss the match and both INSERT. That race window is acceptable for
 * MVP — duplicates can be reconciled by an operator. A follow-up will
 * add a transactional / advisory-lock guard.
 */
export type DedupMatch = {
  leadId: number;
  matchedBy: "email" | "phone";
};

export type DedupInput = {
  /** Plaintext email entered by the submitter. Optional. */
  email?: string | null;
  /** Plaintext phone entered by the submitter (any format). Optional. */
  phone?: string | null;
  /**
   * Tort scope. Matches against `leads.tort_type`. Web Forms passes the
   * configured tort label (e.g. "Roundup"); Form Engine passes the
   * registry tort_type string. Required — global dedup is intentionally
   * not supported.
   */
  tortType: string;
  /**
   * When provided, dedup is scoped to this firm — only leads belonging to
   * the same firm are considered. Without it the search is global (preserved
   * for public intake surfaces that cannot resolve a firm from the request).
   */
  firmId?: number | null;
};

const PHONE_SCAN_LIMIT = 1000;

function normalizePhone(value: string | null | undefined): string | null {
  if (!value) return null;
  const digits = value.replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(-10) : null;
}

function safeDecryptPhone(
  value: string | null | undefined,
  fieldName: "phone" | "phone_primary",
  entityId?: string,
): string | null {
  if (!value) return null;
  try {
    // CRITICAL: pass fieldName so AES-GCM AAD verification succeeds
    // for ciphertexts produced by encryptLeadFields(...). Calling
    // decrypt() without fieldName when the original encryption used
    // AAD returns "[DECRYPTION_ERROR]" and silently breaks dedup.
    const decrypted = decrypt(value, fieldName, entityId);
    if (!decrypted || decrypted === "[DECRYPTION_ERROR]") return null;
    return normalizePhone(decrypted);
  } catch {
    // Legacy plaintext rows — best-effort raw normalize.
    return normalizePhone(value);
  }
}

export async function findExistingLeadForIntake(
  input: DedupInput,
): Promise<DedupMatch | null> {
  const tortType = (input.tortType ?? "").trim();
  if (!tortType) return null;

  const firmPred = input.firmId != null ? eq(leadsTable.firm_id, input.firmId) : undefined;

  // ---- Path 0: canonical lookup_hash short-circuit (Task #15) -------------
  // When the submitter provides BOTH email and phone, we can skip the entire
  // O(N)-decrypt phone scan loop with a single indexed equality query against
  // `leads.lookup_hash`. The hash is computed at insert-time over the same
  // normalized triple (tort|email|phone10), so a hit here is a definite
  // match. A miss does NOT mean "no duplicate" — it only means there is no
  // EXACT triple match, so we still fall through to the email + phone paths
  // below for legacy rows and partial-input submissions.
  const fastHash = leadLookupHash(tortType, input.email ?? null, input.phone ?? null);
  if (fastHash) {
    try {
      const fastRows = await db
        .select({ id: leadsTable.id })
        .from(leadsTable)
        .where(and(eq(leadsTable.lookup_hash, fastHash), ...(firmPred ? [firmPred] : [])))
        .limit(1);
      if (fastRows.length > 0 && fastRows[0]) {
        return { leadId: fastRows[0].id, matchedBy: "email" };
      }
    } catch (err) {
      logger.warn(
        { err, tortType },
        "lead-dedup: lookup_hash fast-path query failed; falling through to email+phone scan",
      );
    }
  }

  // ---- Path 1: email match (EXACT, case-insensitive) ---------------------
  const email = (input.email ?? "").trim();
  if (email.length > 0) {
    try {
      const rows = await db
        .select({ id: leadsTable.id })
        .from(leadsTable)
        .where(
          and(
            // Use lower()=lower() rather than ILIKE so the submitter's
            // email is treated as a literal value, not a SQL pattern.
            sql`lower(${leadsTable.email}) = ${email.toLowerCase()}`,
            eq(leadsTable.tort_type, tortType),
            ...(firmPred ? [firmPred] : []),
          ),
        )
        .limit(1);
      if (rows.length > 0 && rows[0]) {
        return { leadId: rows[0].id, matchedBy: "email" };
      }
    } catch (err) {
      logger.warn(
        { err, tortType },
        "lead-dedup: email match query failed; falling through to phone",
      );
    }
  }

  // ---- Path 2: phone match (decrypt and compare) --------------------------
  const incomingPhone = normalizePhone(input.phone ?? null);
  if (incomingPhone) {
    try {
      const candidates = await db
        .select({
          id: leadsTable.id,
          phone: leadsTable.phone,
          phone_primary: leadsTable.phone_primary,
        })
        .from(leadsTable)
        .where(
          and(
            eq(leadsTable.tort_type, tortType),
            // Either column may carry the encrypted number — Form
            // Engine writes `phone_primary` while the Web Forms widget
            // writes `phone`. Filtering on `phone` alone would miss
            // every phone_primary-only row and silently degrade dedup.
            or(isNotNull(leadsTable.phone), isNotNull(leadsTable.phone_primary)),
            ...(firmPred ? [firmPred] : []),
          ),
        )
        .limit(PHONE_SCAN_LIMIT);

      for (const row of candidates) {
        // Optimization: use short-circuiting OR to avoid redundant decryptions
        // and temporary array allocations. Most leads have only one phone populated.
        // Passing the lead ID as entityId avoids AAD fallback loops.
        const id = String(row.id);
        const isMatch = (incomingPhone && safeDecryptPhone(row.phone, "phone", id) === incomingPhone) ||
                        (incomingPhone && safeDecryptPhone(row.phone_primary, "phone_primary", id) === incomingPhone);
        if (isMatch) {
          return { leadId: row.id, matchedBy: "phone" };
        }
      }
    } catch (err) {
      logger.warn(
        { err, tortType },
        "lead-dedup: phone match scan failed; treating as no match",
      );
    }
  }

  return null;
}
