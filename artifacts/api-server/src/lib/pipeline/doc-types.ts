/**
 * Required-document tracking for the Intake-to-Med-Recs pipeline.
 *
 * Task #168 step 6 sends THREE e-sign documents per lead — a HIPAA medical
 * authorization, a Retainer agreement, and a Personal Truth Affidavit — and
 * each signature must be tracked INDEPENDENTLY. The lead only reaches
 * DOCS_SIGNED once all three required document types are signed. This module is
 * the single source of truth for (a) classifying an e-sign envelope into one of
 * those required types and (b) the deterministic "all required docs signed"
 * gate. It deliberately has no DB/route imports so it can be unit-tested in
 * isolation and reused by the worker, the webhook, and the orchestrator without
 * an import cycle.
 */

/** The three documents a lead must sign before DOCS_SIGNED (spec step 6). */
export const REQUIRED_DOC_TYPES = ["hipaa", "retainer", "affidavit"] as const;
export type RequiredDocType = (typeof REQUIRED_DOC_TYPES)[number];

/**
 * Envelope statuses that mean "this envelope is dead/replaced and no longer
 * represents outstanding work" — a declined/voided/expired/cancelled/errored
 * draft must not deadlock a lead forever. A signed replacement of the same
 * required type still advances.
 */
export const DEAD_ENVELOPE_STATUSES: ReadonlySet<string> = new Set([
  "declined",
  "voided",
  "expired",
  "cancelled",
  "canceled",
  "error",
  "failed",
]);

/**
 * Deterministically map an e-sign template to one of the required pipeline
 * document types, or null when the template is not one of the three. Matching
 * is on the template's `template_type` first (the structured field), then a
 * tolerant scan of the human name, so an operator who names a template
 * "HIPAA Authorization" or sets template_type "hipaa_authorization" both work.
 */
export function classifyEnvelopeDocType(
  tpl: { template_type?: string | null; name?: string | null } | null | undefined,
): RequiredDocType | null {
  if (!tpl) return null;
  const hay = `${tpl.template_type ?? ""} ${tpl.name ?? ""}`.toLowerCase();
  if (hay.includes("hipaa")) return "hipaa";
  if (hay.includes("affidavit") || hay.includes("truth")) return "affidavit";
  if (hay.includes("retainer") || hay.includes("engagement") || hay.includes("representation")) {
    return "retainer";
  }
  return null;
}

/**
 * Lower-level gate kept for callers that only have raw statuses (no doc_type):
 * the active signing set is "executed" when at least one envelope is signed and
 * none of the live envelopes is still in flight. Dead/replaced envelopes are
 * ignored. This is the per-document-group primitive `allRequiredDocumentsSigned`
 * builds on.
 */
export function allDocumentsSigned(envelopeStatuses: readonly string[]): boolean {
  const live = envelopeStatuses.filter((s) => !DEAD_ENVELOPE_STATUSES.has(s));
  if (live.length === 0) return false;
  return live.every((s) => s === "signed");
}

/**
 * The real DOCS_SIGNED gate (spec step 6): every required document type
 * (HIPAA + Retainer + Affidavit) must have at least one live envelope and all
 * of its live envelopes must be signed. A required type with no envelope at all
 * (or only dead ones) holds the lead — it is genuinely outstanding. Envelopes
 * with a null/other doc_type (non-pipeline documents) are not counted toward
 * the required set, so an unrelated signed envelope can never satisfy the gate.
 */
export function allRequiredDocumentsSigned(
  envelopes: ReadonlyArray<{ doc_type: string | null; status: string }>,
): boolean {
  for (const required of REQUIRED_DOC_TYPES) {
    const group = envelopes.filter((e) => e.doc_type === required);
    const live = group.filter((e) => !DEAD_ENVELOPE_STATUSES.has(e.status));
    if (live.length === 0) return false; // required doc missing or all dead
    if (!live.every((e) => e.status === "signed")) return false; // one still outstanding
  }
  return true;
}
