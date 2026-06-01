// Canonical claimant consent copy (single source of truth).
//
// The public intake forms (default builder in web-form-defaults.ts, the
// comprehensive tort library in comprehensive-tort-forms.ts, and the legacy
// embed builder in routes/forms.ts) all carry ONE required consent checkbox
// keyed `tcpa_consent`. Its label is this comprehensive legal block so the
// language is identical on every form and can be updated in one place.
//
// `withCanonicalConsent` is applied at RENDER time (embed JS + SSR preview) so
// that ALREADY-PUBLISHED forms — whose stored web_form_config baked in the old
// short label — also display the current consent without a data migration.
//
// NOTE: `[COMPANY]` is the system-wide brand placeholder (see SEO_BRAND /
// NOT_A_LAW_FIRM_DISCLAIMER), rendered literally. This text is template
// language for the firm's counsel to finalize; it does not certify 50-state
// legal sufficiency.

import type { WebFormField } from "@workspace/db";

export const CONSENT_FIELD_KEY = "tcpa_consent";

export const CLAIMANT_CONSENT_ACKNOWLEDGMENT =
  "By checking this box and submitting this form, I knowingly, voluntarily, and " +
  "affirmatively agree and attest, intending to be legally bound, that: " +
  "(1) Consent to Contact (TCPA / Automated & AI Systems) — I expressly consent " +
  "to be contacted by [COMPANY], its affiliates, participating attorneys, and " +
  "their authorized representatives at the telephone number(s) and email " +
  "address(es) I have provided regarding my potential claim, by live persons " +
  "and/or by automated and artificial-intelligence (AI) systems, including " +
  "automatic telephone dialing systems, prerecorded or artificial-voice " +
  "messages, AI-powered voice agents, and AI-generated or automated text " +
  "(SMS/MMS) messages, even if my number appears on any state or federal " +
  "Do-Not-Call registry; I understand message and data rates may apply, message " +
  "frequency may vary, and I may opt out of text messages at any time by " +
  "replying STOP; this consent is not a condition of any purchase or of legal " +
  "representation. " +
  "(2) Electronic Communications & Signatures — I consent to receive disclosures " +
  "and to transact electronically, and I agree that my electronic signature and " +
  "electronic acceptance are legally binding and have the same force and effect " +
  "as a handwritten signature under the federal E-SIGN Act and the Uniform " +
  "Electronic Transactions Act (UETA). " +
  "(3) Affidavit / Attestation of Truth — I affirm, under penalty of perjury " +
  "under the laws of the United States and of my state of residence, that all " +
  "information I have provided is true, accurate, and complete to the best of my " +
  "knowledge and belief, and that I have not knowingly made any false or " +
  "misleading statement. " +
  "(4) Adult Capacity — I affirm that I am at least eighteen (18) years of age " +
  "and legally competent to provide these consents and attestations. " +
  "(5) Indemnification — to the fullest extent permitted by law, I agree to " +
  "indemnify, defend, and hold harmless [COMPANY], its affiliates, and " +
  "participating attorneys and their representatives from and against any and " +
  "all claims, damages, losses, liabilities, and expenses (including reasonable " +
  "attorneys' fees) arising out of or relating to any false, inaccurate, " +
  "incomplete, or misleading information I provide or my breach of these " +
  "acknowledgments and attestations. " +
  "(6) Nationwide Validity & Severability — I intend these consents, " +
  "acknowledgments, and attestations to be valid and enforceable to the maximum " +
  "extent permitted in every state of the United States, and if any provision is " +
  "held unenforceable in a jurisdiction, the remaining provisions shall remain " +
  "in full force and effect.";

/**
 * Force the canonical consent label onto the `tcpa_consent` field of a form's
 * field list. Applied at render time so existing published forms display the
 * current consent block without a stored-config migration. Non-consent fields
 * pass through untouched; the consent field is also normalized to a required
 * checkbox.
 */
export function withCanonicalConsent(fields: WebFormField[]): WebFormField[] {
  return (fields ?? []).map((f) =>
    f.key === CONSENT_FIELD_KEY
      ? { ...f, type: "checkbox" as const, required: true, label: CLAIMANT_CONSENT_ACKNOWLEDGMENT }
      : f,
  );
}
