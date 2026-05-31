/**
 * Pure decision helpers for the intake-to-medical-records automation gates.
 *
 * These are deliberately side-effect free so they can be unit tested without
 * a database or network. The automation node handlers in `executor.ts` load
 * the rows from Postgres and then delegate the verdict to these functions.
 *
 * Design rule (per the AI Constitution: deterministic-first, never invent a
 * clean result): every gate returns an explicit reason string and the
 * evidence it considered, and a "not enough to proceed" verdict routes the
 * claimant to the human review queue rather than silently advancing.
 */

// ──────────────── Consent / TCPA gate ────────────────

/** Which intake channel a claimant arrived through. Drives which consent
 * artifact is mandatory before we are allowed to contact them. */
export type ConsentChannel = "web" | "vendor" | "voice";

export interface ConsentEvalInput {
  /** lead.tcpa_consent — the explicit TCPA opt-in flag. */
  tcpaConsent: boolean;
  /** lead.trustedform_cert_url — the TrustedForm certificate of consent. */
  trustedformCertUrl?: string | null;
  /** True when a linked call_logs row has BOTH a recording_url and a
   * non-empty transcript (the voice consent artifact). */
  hasRecordedCall: boolean;
  /** The resolved intake channel for this claimant. */
  channel: ConsentChannel;
}

export interface ConsentEvalResult {
  valid: boolean;
  channel: ConsentChannel;
  reason: string;
}

/** TrustedForm certificates are always served from this origin. A "cert URL"
 * that does not start with it is not a real certificate and must not pass. */
export function isTrustedFormCert(url: string | null | undefined): boolean {
  return typeof url === "string" && url.startsWith("https://cert.trustedform.com/");
}

/**
 * Resolve the consent channel from the lead's stored preference / origin.
 * An explicit override (workflow node param) always wins.
 */
export function resolveConsentChannel(opts: {
  override?: string | null;
  contactPreference?: string | null;
  source?: string | null;
  hasVendor?: boolean;
}): ConsentChannel {
  const norm = (v?: string | null) => (v ?? "").trim().toLowerCase();
  const ov = norm(opts.override);
  if (ov === "voice" || ov === "agent") return "voice";
  if (ov === "web" || ov === "text_email" || ov === "text" || ov === "email") return "web";
  if (ov === "vendor") return "vendor";

  const pref = norm(opts.contactPreference);
  if (pref === "agent") return "voice";
  if (pref === "text_email") return "web";

  const src = norm(opts.source);
  if (opts.hasVendor || src.includes("vendor") || src.includes("import")) return "vendor";

  // Default to the strictest web path (requires a TrustedForm cert).
  return "web";
}

/**
 * Evaluate whether we hold valid consent to proceed for this claimant.
 *
 * Every channel requires the TCPA opt-in flag. Beyond that:
 *   - web    → a valid TrustedForm certificate URL
 *   - vendor → a vendor-supplied TrustedForm certificate URL
 *   - voice  → a recorded call with a transcript on file
 */
export function evaluateConsent(input: ConsentEvalInput): ConsentEvalResult {
  const { channel } = input;
  if (!input.tcpaConsent) {
    return { valid: false, channel, reason: "Missing TCPA consent flag." };
  }
  switch (channel) {
    case "web":
    case "vendor": {
      if (!isTrustedFormCert(input.trustedformCertUrl)) {
        return {
          valid: false,
          channel,
          reason:
            channel === "vendor"
              ? "Vendor lead is missing a valid TrustedForm certificate URL."
              : "Missing or invalid TrustedForm certificate URL.",
        };
      }
      return { valid: true, channel, reason: "TCPA consent + TrustedForm certificate on file." };
    }
    case "voice": {
      if (!input.hasRecordedCall) {
        return {
          valid: false,
          channel,
          reason: "No recorded consent call with transcript on file.",
        };
      }
      return { valid: true, channel, reason: "TCPA consent + recorded consent call on file." };
    }
    default: {
      // Exhaustiveness guard — an unknown channel is never auto-approved.
      return { valid: false, channel, reason: `Unknown consent channel: ${String(channel)}` };
    }
  }
}

// ──────────────── E-sign completion gate ────────────────

export interface EnvelopeLike {
  template_id: number | null;
  status: string;
}

export interface EsignEvalInput {
  envelopes: EnvelopeLike[];
  /** When set, EVERY listed template must have a signed envelope. */
  requiredTemplateIds?: number[];
  /** When set (and no requiredTemplateIds), at least this many signed. */
  minSigned?: number;
}

export interface EsignEvalResult {
  complete: boolean;
  signed: number;
  total: number;
  /** Required template ids that are not yet signed (only when requiredTemplateIds set). */
  pendingTemplateIds: number[];
  reason: string;
}

/**
 * Decide whether a claimant's e-sign packet is fully executed.
 *
 * Modes (most specific first):
 *   1. requiredTemplateIds — every listed template must have a signed envelope.
 *   2. minSigned — at least N envelopes signed.
 *   3. default — there is at least one envelope and every envelope is signed
 *      (a declined / voided / errored / still-out envelope keeps it pending).
 */
export function evaluateEsignCompletion(input: EsignEvalInput): EsignEvalResult {
  const envelopes = input.envelopes ?? [];
  const total = envelopes.length;
  const signed = envelopes.filter((e) => e.status === "signed").length;

  const required = input.requiredTemplateIds?.filter((n) => Number.isFinite(n)) ?? [];
  if (required.length > 0) {
    const signedTemplateIds = new Set(
      envelopes.filter((e) => e.status === "signed" && e.template_id != null).map((e) => e.template_id as number),
    );
    const pendingTemplateIds = required.filter((id) => !signedTemplateIds.has(id));
    const complete = pendingTemplateIds.length === 0;
    return {
      complete,
      signed,
      total,
      pendingTemplateIds,
      reason: complete
        ? `All ${required.length} required document(s) signed.`
        : `${pendingTemplateIds.length} of ${required.length} required document(s) not yet signed.`,
    };
  }

  if (typeof input.minSigned === "number" && input.minSigned > 0) {
    const complete = signed >= input.minSigned;
    return {
      complete,
      signed,
      total,
      pendingTemplateIds: [],
      reason: complete
        ? `${signed} signed (>= ${input.minSigned} required).`
        : `${signed} signed (need ${input.minSigned}).`,
    };
  }

  const complete = total > 0 && signed === total;
  return {
    complete,
    signed,
    total,
    pendingTemplateIds: [],
    reason:
      total === 0
        ? "No e-sign envelopes found for this lead."
        : complete
          ? `All ${total} envelope(s) signed.`
          : `${signed} of ${total} envelope(s) signed.`,
  };
}
