// Snapshot sanitizer for the Background Check Hub.
//
// The hub returns a per-lane `raw` payload that is useful for the operator
// who is looking at a live result, but those payloads contain plaintext PII
// (email addresses, phone numbers, claimant names, street addresses,
// dates of birth, full court records). The lead row itself encrypts those
// fields; if we persist them in plaintext inside `lead_background_check_snapshots.result`
// the audit history table becomes a parallel cleartext PII store.
//
// This module is the SINGLE write-side gate. Every code path that inserts
// into `lead_background_check_snapshots` must call
// `sanitizeHubResultForPersistence(result)` first. The on-the-fly
// (in-memory) hub response handed back to the requesting operator is
// unaffected — only the persisted copy is sanitized.
//
// Masking philosophy: keep enough metadata to verify "the right person was
// looked up" (e.g. last 4 digits of phone, first initial of name, year of
// DOB) without storing reconstructable PII. Records arrays are replaced
// with `{ count, redacted: true }` because their contents are large and
// open-ended.
//
// Backward compatibility: the `BackgroundLaneResult.raw` field is typed as
// `unknown`, so consumers cannot rely on a specific shape. Fields that get
// masked retain their original key — only the value changes — so any
// consumer that just renders `JSON.stringify(raw)` keeps working. No
// schema migration required for existing rows; legacy snapshots remain in
// the DB unsanitized (see migration notes in the surfacing PR).

import type { BackgroundHubResult, BackgroundLaneResult } from "./types.js";

/** Mask an email like "alice@example.com" → "a***@example.com". */
export function maskEmail(value: unknown): unknown {
  if (typeof value !== "string" || value.length === 0) return value;
  const at = value.indexOf("@");
  if (at < 1) return "***";
  const local = value.slice(0, at);
  const domain = value.slice(at);
  return `${local[0]}***${domain}`;
}

/** Mask phone: keep last 4 digits, mask the rest. "5555550199" → "***-***-0199" */
export function maskPhone(value: unknown): unknown {
  if (typeof value !== "string" || value.length === 0) return value;
  const digits = value.replace(/\D/g, "");
  if (digits.length === 0) return "***";
  const last4 = digits.slice(-4);
  return `***-***-${last4}`;
}

/** Mask a person's name: "John Doe" → "J*** D***". Empty input passes through. */
export function maskName(value: unknown): unknown {
  if (typeof value !== "string" || value.trim().length === 0) return value;
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => `${part[0]}***`)
    .join(" ");
}

/** Mask street address completely. City/state/zip stay (less identifying alone, needed for audit). */
export function maskStreet(value: unknown): unknown {
  if (typeof value !== "string" || value.length === 0) return value;
  return "*** ***";
}

/** Mask DOB: keep year only. "1985-06-15" → "1985-**-**" */
export function maskDob(value: unknown): unknown {
  if (typeof value !== "string" || value.length === 0) return value;
  const m = value.match(/^(\d{4})/);
  return m ? `${m[1]}-**-**` : "***";
}

/** Mask SSN-like values entirely. */
export function maskSsn(value: unknown): unknown {
  if (typeof value !== "string" || value.length === 0) return value;
  return "***";
}

/** Replace an array of records with a count summary. */
export function summarizeRecords(value: unknown): unknown {
  if (Array.isArray(value)) return { count: value.length, redacted: true };
  return value;
}

/** Free-text fields that may have PII embedded in prose (e.g. "No records found for John Doe"). */
export function redactFreeText(value: unknown): unknown {
  if (typeof value === "string" && value.length > 0) return "[redacted: may contain PII]";
  if (Array.isArray(value) && value.length > 0)
    return [{ count: value.length, redacted: true, reason: "may contain PII" }];
  return value;
}

/**
 * Map of sensitive field names → the mask handler to apply.
 *
 * Names mirror what the bg-hub adapters actually emit (see adapters.ts).
 * Update this table when a new adapter starts emitting a new sensitive key.
 *
 * Field-name choice rationale (kept in sync with pino logger redact paths):
 *   - `phone`/`phone_primary` are the canonical lead column names.
 *   - `input` and `normalized` are the phone adapter's raw shape.
 *   - `searched_name` is what every "honest stub" lane records.
 *   - `suggestion` is the email validator's typo-corrected email.
 *   - city/state/zip intentionally NOT masked — they are needed to verify
 *     the right address was looked up and are not in pino's redact list.
 */
const FIELD_MASKERS: Record<string, (v: unknown) => unknown> = {
  // Email-like
  email: maskEmail,
  user_email: maskEmail,
  suggestion: maskEmail,

  // Phone-like
  phone: maskPhone,
  phone_primary: maskPhone,
  input: maskPhone,
  normalized: maskPhone,

  // Names
  first_name: maskName,
  last_name: maskName,
  full_name: maskName,
  searched_name: maskName,
  business_name: maskName,
  defendant_name: maskName,
  applicant_name: maskName,
  name: maskName,

  // Street address (city/state/zip preserved — see rationale above)
  street: maskStreet,
  street_address: maskStreet,
  address: maskStreet,
  address_line_1: maskStreet,
  address_line_2: maskStreet,

  // Birth/identity
  dob: maskDob,
  date_of_birth: maskDob,
  ssn: maskSsn,
  last_4_ssn: maskSsn,

  // Open-ended record sets
  records: summarizeRecords,

  // Free-text fields that may have PII embedded in prose. These come from
  // the legacy runBackgroundCheck() integration which produces a human-
  // readable `summary` like "No federal records found for John Doe (...)"
  // and a `notes` array carrying provider-side messages. Both can leak
  // claimant identifiers, so we redact entirely.
  summary: redactFreeText,
  source_notes: redactFreeText,
  reason: redactFreeText,
};

/**
 * Recursively walk an arbitrary value, masking known sensitive keys.
 * Pure: returns a new object/array; never mutates the input.
 */
function sanitizeValue(value: unknown): unknown {
  if (value == null) return value;
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const handler = FIELD_MASKERS[k];
    out[k] = handler ? handler(v) : sanitizeValue(v);
  }
  return out;
}

/** Sanitize one lane result's `raw` payload AND the lane-level `error` field.
 *
 * The `error` field carries adapter exception messages. For the legacy
 * runBackgroundCheck() path that's typically a clean network error
 * ("Request failed with status code 401"), but stringified axios errors
 * can include full request URLs that have the claimant name as a query
 * parameter. Defense-in-depth: drop the original message and keep only
 * a marker so operators know an error occurred (the full message is
 * still available in the request log).
 */
export function sanitizeLaneResult(result: BackgroundLaneResult): BackgroundLaneResult {
  const out: BackgroundLaneResult = { ...result };
  if (out.raw !== undefined) out.raw = sanitizeValue(out.raw);
  if (typeof out.error === "string" && out.error.length > 0) {
    out.error = "[error message redacted — see request log for full text]";
  }
  return out;
}

/**
 * Centralized sanitizer for any code path persisting a hub result into
 * `lead_background_check_snapshots`. Returns a deep-copied result with
 * each lane's `raw` payload masked. The verdict, score, flags, notes,
 * sources, and summary are preserved exactly — only PII inside `raw`
 * is masked.
 */
export function sanitizeHubResultForPersistence(
  result: BackgroundHubResult,
): BackgroundHubResult {
  return {
    ...result,
    results: result.results.map(sanitizeLaneResult),
  };
}
