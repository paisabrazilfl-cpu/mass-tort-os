import { TORT_REGISTRY, type TortDefinition } from "./tort-engine";
import { CLAIMANT_CONSENT_ACKNOWLEDGMENT } from "./consent-copy";
import { forceFieldsRequired } from "./web-form-fields";
import type {
  WebFormConfig,
  WebFormField,
  EligibilityRule,
} from "@workspace/db/schema";

/**
 * Build the industry-standard default web form for a given tort.
 *
 * Layout follows what mass-tort lead-gen vendors (Sokolove, Morgan & Morgan,
 * 1Law, etc.) actually present on landing pages: three short sections,
 * eligibility-first, ~10 fields total, single-page. Heavier intake (SSN,
 * physician, hospital fax, etc.) is intentionally left out — those live on
 * the operator-side intake form and get collected after a paralegal
 * follow-up.
 */
export function buildDefaultWebFormConfig(tort: TortDefinition): WebFormConfig {
  const diagnosisOptions = (tort.valid_diagnoses ?? []).map(formatDiagnosisOption);
  const showDiagnosis = diagnosisOptions.length > 0;
  const showExposureYear = tort.required_exposure;

  const fields: WebFormField[] = [
    // ── ELIGIBILITY ─────────────────────────────────────────────
    {
      key: "age_18_plus",
      label: "Are you 18 years of age or older?",
      type: "radio",
      section: "eligibility",
      required: true,
      options: ["Yes", "No"],
    },
    {
      key: "us_resident",
      label: "Do you currently reside in the United States?",
      type: "radio",
      section: "eligibility",
      required: true,
      options: ["Yes", "No"],
    },
    {
      key: "represented_by_attorney",
      label: "Are you currently represented by an attorney for this matter?",
      type: "radio",
      section: "eligibility",
      required: true,
      options: ["Yes", "No"],
    },
    ...(showDiagnosis
      ? [
          {
            key: "diagnosis_confirmed",
            label: `Have you been diagnosed with one of the qualifying conditions for ${tort.label}?`,
            type: "radio" as const,
            section: "eligibility" as const,
            required: true,
            options: ["Yes", "No", "Not sure"],
            helper_text: `Qualifying conditions include: ${diagnosisOptions.slice(0, 4).join(", ")}${
              diagnosisOptions.length > 4 ? "…" : ""
            }`,
          },
        ]
      : []),

    // ── CONTACT ─────────────────────────────────────────────────
    {
      key: "first_name",
      label: "First name",
      type: "text",
      section: "contact",
      required: true,
      max_length: 100,
    },
    {
      key: "last_name",
      label: "Last name",
      type: "text",
      section: "contact",
      required: true,
      max_length: 100,
    },
    {
      key: "email",
      label: "Email address",
      type: "email",
      section: "contact",
      required: true,
      max_length: 254,
    },
    {
      key: "phone",
      label: "Phone number",
      type: "tel",
      section: "contact",
      required: true,
      placeholder: "555-555-5555",
      max_length: 20,
    },
    {
      key: "state",
      label: "State of residence",
      type: "state",
      section: "contact",
      required: true,
    },

    // ── STORY ───────────────────────────────────────────────────
    ...(showDiagnosis
      ? [
          {
            key: "diagnosis",
            label: "Specific diagnosis",
            type: "select" as const,
            section: "story" as const,
            required: true,
            options: diagnosisOptions,
            helper_text: "If you remember the exact wording your doctor used.",
          },
          {
            key: "diagnosis_year",
            label: "Year of diagnosis",
            type: "number" as const,
            section: "story" as const,
            required: true,
            placeholder: "YYYY",
          },
        ]
      : []),
    ...(showExposureYear
      ? [
          {
            key: "exposure_start_year",
            label: "Year you first started exposure / use",
            type: "number" as const,
            section: "story" as const,
            required: true,
            placeholder: "YYYY",
          },
        ]
      : []),
    {
      key: "hospital_fax",
      label: "Doctor's or hospital fax number",
      type: "tel",
      section: "story",
      required: true,
      placeholder: "(555) 555-5555",
      max_length: 20,
      helper_text:
        "If you know the fax number for your treating doctor or hospital, we can request your medical records faster.",
    },
    {
      key: "brief_description",
      label: "Briefly describe what happened",
      type: "textarea",
      section: "story",
      required: true,
      max_length: 2000,
      helper_text: "A few sentences is fine — your paralegal will gather full details later.",
    },
    {
      key: "tcpa_consent",
      label: CLAIMANT_CONSENT_ACKNOWLEDGMENT,
      type: "checkbox",
      section: "story",
      required: true,
    },
  ];

  const eligibility_rules: EligibilityRule[] = [
    {
      id: "must_be_adult",
      field: "age_18_plus",
      op: "eq",
      value: "No",
      message: "You must be 18 or older to submit this form.",
    },
    {
      id: "must_be_us_resident",
      field: "us_resident",
      op: "eq",
      value: "No",
      message:
        "We currently only accept claims from U.S. residents. Please consult a local attorney.",
    },
    {
      id: "no_existing_representation",
      field: "represented_by_attorney",
      op: "eq",
      value: "Yes",
      message:
        "You are already represented by an attorney for this matter. Please continue working with your current counsel.",
    },
    {
      id: "tcpa_required",
      field: "tcpa_consent",
      op: "ne",
      value: "true",
      message: "You must consent to be contacted in order to submit this form.",
    },
    ...(showDiagnosis
      ? [
          {
            id: "diagnosis_required",
            field: "diagnosis_confirmed",
            op: "eq" as const,
            value: "No",
            message: `A qualifying diagnosis is required for the ${tort.label} program.`,
          },
        ]
      : []),
  ];

  return {
    enabled: true,
    intro_headline: `${tort.label} Claim Review`,
    intro_subhead:
      "Tell us a few details to see if you may qualify. Takes under two minutes — no fees unless we win.",
    fields: forceFieldsRequired(fields),
    eligibility_rules,
    send_confirmation_email: true,
    confirmation_subject: `Thanks for reaching out about your ${tort.label} claim`,
    confirmation_body_html: defaultConfirmationHtml(tort.label),
  };
}

function formatDiagnosisOption(raw: string): string {
  return raw
    .split(/\s+/)
    .map((w) => (w.length <= 4 && w === w.toUpperCase() ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ");
}

function defaultConfirmationHtml(tortLabel: string): string {
  return `<!doctype html>
<html><body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#0f172a;line-height:1.55;max-width:560px;margin:0 auto;padding:24px;">
  <h2 style="margin:0 0 16px 0;font-size:20px;">Thanks, {{first_name}} — we got your inquiry.</h2>
  <p>We've received your information about your potential <strong>${tortLabel}</strong> claim. A dedicated paralegal will review your submission and reach out within one business day to walk you through the next steps and gather the additional medical and exposure details required to file.</p>
  <p style="margin-top:20px;">In the meantime, please gather:</p>
  <ul>
    <li>Names and dates of any related medical diagnoses</li>
    <li>Names of treating physicians and hospitals</li>
    <li>Approximate dates of exposure or product use</li>
  </ul>
  <p>If you have questions before we reach you, simply reply to this email.</p>
  <p style="color:#64748b;font-size:12px;margin-top:32px;">This message confirms your submission — it is not a guarantee of representation. No attorney–client relationship is formed until a written agreement is signed.</p>
</body></html>`;
}

/**
 * Build defaults for every tort in TORT_REGISTRY.
 */
export function buildAllDefaultWebFormConfigs(): Record<string, WebFormConfig> {
  const out: Record<string, WebFormConfig> = {};
  for (const [id, tort] of Object.entries(TORT_REGISTRY)) {
    out[id] = buildDefaultWebFormConfig(tort);
  }
  return out;
}
