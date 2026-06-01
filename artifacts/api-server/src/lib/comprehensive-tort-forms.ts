/**
 * Comprehensive intake-form definitions for every mass-tort campaign.
 *
 * Each tort exports a deep-qualifying public web form (8-15 tort-specific
 * questions) PLUS a universal anti-fraud probe stack appended to every form.
 * The same data drives:
 *   - the operator-side custom_fields (rendered in the CRM card)
 *   - the rules[] list (validation badges in the CRM card)
 *   - the public web_form_config (the embeddable claimant form)
 *
 * Seeded into form_configurations on boot by seedFormConfigurations() in
 * form-config-service.ts. Idempotent: only fills NULL columns so admin
 * hand-edits via the CRM Edit dialog are never overwritten.
 */
import { TORT_REGISTRY } from "./tort-engine";
import { CLAIMANT_CONSENT_ACKNOWLEDGMENT } from "./consent-copy";
import type {
  WebFormConfig,
  WebFormField,
  EligibilityRule,
  CustomField,
  SiteProfile,
} from "@workspace/db";

export interface ComprehensiveTortForm {
  intro_text: string;
  custom_fields: CustomField[];
  extra_fields: string[];
  rules: string[];
  web_form_config: WebFormConfig;
}

// ─────────────────────────────────────────────────────────────────────────
// SHARED BUILDING BLOCKS
// ─────────────────────────────────────────────────────────────────────────

export const CONTACT_FIELDS: WebFormField[] = [
  { key: "first_name", label: "First name", type: "text", section: "contact", required: true, max_length: 100 },
  { key: "last_name", label: "Last name", type: "text", section: "contact", required: true, max_length: 100 },
  { key: "email", label: "Email address", type: "email", section: "contact", required: true, max_length: 254 },
  { key: "phone", label: "Phone number", type: "tel", section: "contact", required: true, placeholder: "555-555-5555", max_length: 20 },
  { key: "dob", label: "Date of birth", type: "date", section: "contact", required: true, helper_text: "Used for identity verification and to confirm legal capacity to file." },
  { key: "state", label: "State of residence", type: "state", section: "contact", required: true },
];

export const BASE_ELIGIBILITY: WebFormField[] = [
  { key: "age_18_plus", label: "Are you 18 years of age or older?", type: "radio", section: "eligibility", required: true, options: ["Yes", "No"] },
  { key: "us_resident", label: "Do you currently reside in the United States?", type: "radio", section: "eligibility", required: true, options: ["Yes", "No"] },
  { key: "represented_by_attorney", label: "Are you currently represented by another attorney for this specific matter?", type: "radio", section: "eligibility", required: true, options: ["Yes", "No"] },
];

export const BASE_RULES: EligibilityRule[] = [
  { id: "must_be_adult", field: "age_18_plus", op: "eq", value: "No", message: "You must be 18 or older to submit this form." },
  { id: "must_be_us_resident", field: "us_resident", op: "eq", value: "No", message: "We currently only accept claims from U.S. residents." },
  { id: "no_existing_representation", field: "represented_by_attorney", op: "eq", value: "Yes", message: "You are already represented by an attorney for this matter. Please continue with your current counsel." },
  { id: "tcpa_consent_required", field: "tcpa_consent", op: "ne", value: "true", message: "You must consent to be contacted in order to submit this form." },
];

// ── ANTI-FRAUD PROBES (appended to every web form) ──────────────────────
// These questions are designed to surface lead-reseller fraud, identity
// laundering, fabricated injury claims, and statute-of-limitations issues.
// They double-record critical facts in different framings so downstream
// cross-checks (e.g. fraud-engine.ts) can detect inconsistencies.
export const ANTI_FRAUD_FIELDS: WebFormField[] = [
  {
    key: "claimant_relationship_to_injury",
    label: "Who is the injured person on this claim?",
    type: "select",
    section: "eligibility",
    required: true,
    options: [
      "I am the injured person",
      "I am the parent/legal guardian of an injured minor",
      "I am the spouse or next of kin (the injured person is deceased)",
      "I hold power of attorney for the injured person",
      "Other",
    ],
    helper_text: "Only the injured party, a legal guardian, or an estate representative may sign retainer documents.",
  },
  {
    key: "prior_similar_lawsuit",
    label: "Have you ever filed a lawsuit or claim for this same injury before?",
    type: "radio",
    section: "story",
    required: true,
    options: ["No", "Yes — dismissed or withdrawn", "Yes — settled previously"],
    helper_text: "Required disclosure. A prior dismissed claim may still qualify; a prior settlement typically does not.",
  },
  {
    key: "prior_settlement_disclosure",
    label: "Have you received any settlement, judgment, or insurance payout related to this injury?",
    type: "radio",
    section: "story",
    required: true,
    options: ["No", "Yes — partial", "Yes — full release signed"],
    helper_text: "A signed full release typically forecloses a new claim.",
  },
  {
    key: "hipaa_release_consent",
    label: "Do you authorize us to request your medical records (HIPAA authorization) to verify the diagnosis you reported?",
    type: "radio",
    section: "story",
    required: true,
    options: ["Yes — I will sign the HIPAA release", "I want to discuss first"],
    helper_text: "We cannot meaningfully evaluate a case without medical records confirming the diagnosis.",
  },
  {
    key: "best_contact_time",
    label: "Best time of day to reach you by phone",
    type: "select",
    section: "contact",
    required: false,
    options: ["Morning (8 AM – 12 PM)", "Afternoon (12 PM – 5 PM)", "Evening (5 PM – 8 PM)", "Anytime"],
  },
  {
    key: "preferred_language",
    label: "Preferred language for follow-up call",
    type: "select",
    section: "contact",
    required: false,
    options: ["English", "Español", "Português", "Other"],
  },
  {
    key: "lead_source_attestation",
    label: "How did you hear about us?",
    type: "select",
    section: "story",
    required: false,
    options: ["Google or web search", "Television commercial", "Social media (Facebook, TikTok, Instagram)", "Referral from friend or family", "Referral from another attorney", "Direct mail", "Other"],
    helper_text: "Used to verify lead-source attribution against vendor reports.",
  },
  {
    key: "truthful_attestation",
    label: "I attest under penalty of perjury that all information I have provided is true, accurate, and complete to the best of my knowledge.",
    type: "checkbox",
    section: "story",
    required: true,
    helper_text: "Knowingly providing false information may constitute fraud and disqualifies your claim.",
  },
];

export const TCPA_FIELD: WebFormField = {
  key: "tcpa_consent",
  label: CLAIMANT_CONSENT_ACKNOWLEDGMENT,
  type: "checkbox",
  section: "story",
  required: true,
};

export const ANTI_FRAUD_RULES: EligibilityRule[] = [
  { id: "attestation_required", field: "truthful_attestation", op: "ne", value: "true", message: "You must attest to the accuracy of your information." },
  { id: "claimant_not_self_warning", field: "claimant_relationship_to_injury", op: "eq", value: "Other", message: "Please contact us by phone — third-party submissions require additional documentation." },
  { id: "prior_full_release_knockout", field: "prior_settlement_disclosure", op: "eq", value: "Yes — full release signed", message: "A previously signed full release typically forecloses a new claim for the same injury. We cannot proceed without first reviewing the release agreement." },
  { id: "hipaa_consent_required", field: "hipaa_release_consent", op: "ne", value: "Yes — I will sign the HIPAA release", message: "Initial intake requires HIPAA authorization to verify medical records — please call us to discuss." },
];

export const TREATMENT_FIELDS: WebFormField[] = [
  { key: "had_surgery", label: "Did you require surgery related to this condition?", type: "radio", section: "story", required: false, options: ["Yes", "No", "Scheduled"] },
  { key: "hospitalized", label: "Were you hospitalized due to this condition?", type: "radio", section: "story", required: false, options: ["Yes", "No"] },
  { key: "currently_treating", label: "Are you currently receiving treatment?", type: "radio", section: "story", required: false, options: ["Yes", "No", "Treatment ended"] },
  { key: "medical_records_available", label: "Do you have medical records documenting your diagnosis?", type: "radio", section: "story", required: false, options: ["Yes", "No", "In process of obtaining"] },
];

export const DAMAGE_FIELDS: WebFormField[] = [
  { key: "lost_wages", label: "Did you miss work or lose income as a result of this condition?", type: "radio", section: "story", required: false, options: ["Yes", "No"] },
  { key: "approx_medical_costs", label: "Estimated out-of-pocket medical expenses so far", type: "select", section: "story", required: false, options: ["Under $1,000", "$1,000 – $5,000", "$5,000 – $25,000", "$25,000 – $100,000", "Over $100,000", "Still accumulating"] },
];

export const DESCRIPTION_FIELD: WebFormField = {
  key: "brief_description",
  label: "In your own words, briefly describe what happened (optional)",
  type: "textarea",
  section: "story",
  required: false,
  max_length: 2000,
  helper_text: "A few sentences is fine — your case manager will gather full details on the follow-up call.",
};

function conf(
  tortId: string,
  headline: string,
  subhead: string,
  eligibilityExtra: WebFormField[],
  rulesExtra: EligibilityRule[],
  storyFields: WebFormField[],
): [string, WebFormConfig] {
  const config: WebFormConfig = {
    enabled: true,
    intro_headline: headline,
    intro_subhead: subhead,
    fields: [
      ...BASE_ELIGIBILITY,
      ...eligibilityExtra,
      ...CONTACT_FIELDS,
      ...storyFields,
      ...TREATMENT_FIELDS,
      ...DAMAGE_FIELDS,
      ...ANTI_FRAUD_FIELDS,
      DESCRIPTION_FIELD,
      TCPA_FIELD,
    ],
    eligibility_rules: [...BASE_RULES, ...rulesExtra, ...ANTI_FRAUD_RULES],
    send_confirmation_email: true,
    confirmation_subject: `We received your ${headline} inquiry`,
    confirmation_body_html: confirmationHtml(headline),
  };
  return [tortId, config];
}

export function confirmationHtml(label: string): string {
  return `<!doctype html>
<html><body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#0f172a;line-height:1.6;max-width:560px;margin:0 auto;padding:24px">
<h2 style="margin:0 0 16px;font-size:20px">Thanks, {{first_name}} — we received your inquiry.</h2>
<p>A dedicated case manager will review your <strong>${label}</strong> submission and contact you within one business day to discuss next steps and gather any additional details needed to evaluate your claim.</p>
<p style="margin-top:18px"><strong>Before your call, it helps to have ready:</strong></p>
<ul>
  <li>Names and approximate dates of any diagnoses</li>
  <li>Names of your treating physicians and hospitals</li>
  <li>Any records related to product use or exposure</li>
  <li>Health insurance or Medicare/Medicaid information</li>
</ul>
<p style="color:#64748b;font-size:12px;margin-top:28px">This message confirms your submission only — it does not constitute legal advice or create an attorney–client relationship. No fees unless we win.</p>
</body></html>`;
}

// ─────────────────────────────────────────────────────────────────────────
// WEB FORMS — 31 torts
// ─────────────────────────────────────────────────────────────────────────

const WEB_FORMS: Record<string, WebFormConfig> = Object.fromEntries([

  conf("roundup",
    "Roundup / Glyphosate Claim Review",
    "Exposure to Roundup (glyphosate) herbicide has been linked to Non-Hodgkin's Lymphoma and other blood cancers. Answer a few questions to see if you may have a case.",
    [
      { key: "used_roundup", label: "Did you personally use Roundup or another glyphosate-based herbicide?", type: "radio", section: "eligibility", required: true, options: ["Yes", "No"] },
      { key: "has_cancer_diagnosis", label: "Have you been diagnosed with cancer or a blood disorder?", type: "radio", section: "eligibility", required: true, options: ["Yes", "No", "Awaiting results"] },
    ],
    [
      { id: "must_have_used_roundup", field: "used_roundup", op: "eq", value: "No", message: "This program is for individuals who personally used Roundup or a glyphosate herbicide." },
      { id: "must_have_diagnosis", field: "has_cancer_diagnosis", op: "eq", value: "No", message: "A qualifying cancer or blood disorder diagnosis is required for the Roundup program." },
    ],
    [
      { key: "roundup_use_type", label: "How did you primarily use Roundup?", type: "select", section: "story", required: true, options: ["Residential (lawn, garden, landscaping)", "Agriculture / farming", "Professional landscaping or groundskeeping", "Golf course or park maintenance", "Municipal / government work", "Other occupational use"] },
      { key: "roundup_years_used", label: "Approximately how many years did you use Roundup?", type: "select", section: "story", required: true, options: ["Less than 1 year", "1–2 years", "3–5 years", "6–10 years", "More than 10 years"] },
      { key: "roundup_exposure_start_year", label: "What year did you first use Roundup?", type: "number", section: "story", required: true, placeholder: "YYYY" },
      { key: "roundup_frequency", label: "How often did you use Roundup?", type: "select", section: "story", required: true, options: ["Daily or near-daily", "Several times a week", "Weekly", "Monthly", "A few times a year"] },
      { key: "roundup_protective_gear", label: "Did you regularly wear protective gear (gloves, mask, full coverage) while applying?", type: "radio", section: "story", required: false, options: ["Yes", "No", "Sometimes"] },
      { key: "diagnosis", label: "What is your cancer or blood disorder diagnosis?", type: "select", section: "story", required: true, options: ["Non-Hodgkin's Lymphoma (NHL)", "Diffuse Large B-Cell Lymphoma (DLBCL)", "Follicular Lymphoma", "Marginal Zone Lymphoma", "T-Cell Lymphoma", "Chronic Lymphocytic Leukemia (CLL)", "Hairy Cell Leukemia", "Multiple Myeloma", "Other / unsure"] },
      { key: "diagnosis_year", label: "What year were you diagnosed?", type: "number", section: "story", required: true, placeholder: "YYYY" },
      { key: "treating_oncologist", label: "Name of treating oncologist or hematologist (if known)", type: "text", section: "story", required: false, placeholder: "Dr. Jane Smith" },
      { key: "treating_hospital", label: "Hospital or cancer center where treated", type: "text", section: "story", required: false, placeholder: "City Cancer Center" },
    ]
  ),

  conf("talcum-powder",
    "Talcum Powder Ovarian Cancer Claim Review",
    "Regular use of talcum powder in the genital area has been linked to ovarian cancer and mesothelioma. Find out if you qualify for compensation.",
    [
      { key: "used_talcum", label: "Did you use Johnson's Baby Powder, Shower to Shower, or another talc product in the genital/perineal area?", type: "radio", section: "eligibility", required: true, options: ["Yes", "No", "Unsure"] },
      { key: "has_ovarian_cancer", label: "Have you been diagnosed with ovarian cancer, endometrial cancer, or mesothelioma?", type: "radio", section: "eligibility", required: true, options: ["Yes", "No"] },
    ],
    [
      { id: "must_have_used_talcum", field: "used_talcum", op: "eq", value: "No", message: "This program requires personal use of a talcum-based powder product." },
      { id: "must_have_diagnosis", field: "has_ovarian_cancer", op: "eq", value: "No", message: "A qualifying cancer diagnosis is required for the Talcum Powder program." },
    ],
    [
      { key: "talcum_brand", label: "Which brand(s) did you use?", type: "select", section: "story", required: true, options: ["Johnson's Baby Powder", "Shower to Shower", "Both Johnson's and Shower to Shower", "Other talc-based powder", "Multiple brands"] },
      { key: "talcum_years_used", label: "How many years did you use talcum powder?", type: "select", section: "story", required: true, options: ["Less than 1 year", "1–4 years", "5–9 years", "10–19 years", "20+ years"] },
      { key: "talcum_start_year", label: "Approximately what year did you begin using talcum powder?", type: "number", section: "story", required: true, placeholder: "YYYY" },
      { key: "talcum_frequency", label: "How often did you use it?", type: "select", section: "story", required: true, options: ["Daily", "Several times a week", "Weekly", "Occasionally"] },
      { key: "diagnosis", label: "What is your diagnosis?", type: "select", section: "story", required: true, options: ["Ovarian Cancer", "Epithelial Ovarian Cancer", "Fallopian Tube Cancer", "Primary Peritoneal Cancer", "Endometrial / Uterine Cancer", "Mesothelioma", "Other / still determining"] },
      { key: "diagnosis_stage", label: "What stage was your cancer at diagnosis?", type: "select", section: "story", required: false, options: ["Stage I", "Stage II", "Stage III", "Stage IV", "Not staged / unsure"] },
      { key: "diagnosis_year", label: "Year of diagnosis", type: "number", section: "story", required: true, placeholder: "YYYY" },
      { key: "treating_oncologist", label: "Name of your treating oncologist (if known)", type: "text", section: "story", required: false },
      { key: "treating_hospital", label: "Hospital or cancer center where treated", type: "text", section: "story", required: false },
      { key: "had_hysterectomy", label: "Did you undergo a hysterectomy or oophorectomy related to this diagnosis?", type: "radio", section: "story", required: false, options: ["Yes", "No"] },
    ]
  ),

  conf("camp-lejeune",
    "Camp Lejeune Water Contamination Claim Review",
    "Military personnel and their families who lived or worked at Camp Lejeune between 1953 and 1987 may have been exposed to toxic water. The PACT Act allows you to file a claim.",
    [
      { key: "lived_at_lejeune", label: "Did you live, work, or serve at Camp Lejeune, NC between August 1953 and December 1987?", type: "radio", section: "eligibility", required: true, options: ["Yes", "No"] },
      { key: "lejeune_duration", label: "Did you spend at least 30 days at Camp Lejeune during that period?", type: "radio", section: "eligibility", required: true, options: ["Yes", "No", "Unsure — need to verify records"] },
      { key: "has_qualifying_illness", label: "Have you been diagnosed with a serious illness that may be linked to contaminated water?", type: "radio", section: "eligibility", required: true, options: ["Yes", "No"] },
    ],
    [
      { id: "must_have_been_at_lejeune", field: "lived_at_lejeune", op: "eq", value: "No", message: "This program requires that you lived, worked, or served at Camp Lejeune between 1953 and 1987." },
      { id: "must_meet_duration", field: "lejeune_duration", op: "eq", value: "No", message: "The PACT Act requires a minimum of 30 days at Camp Lejeune during the exposure period." },
      { id: "must_have_illness", field: "has_qualifying_illness", op: "eq", value: "No", message: "A qualifying illness linked to water contamination is required to pursue this claim." },
    ],
    [
      { key: "lejeune_relationship", label: "What was your relationship to Camp Lejeune?", type: "select", section: "story", required: true, options: ["Active duty military (stationed there)", "Civilian employee (DoD or contractor)", "Family member / dependent living on base", "National Guard or Reserve (training)", "Other"] },
      { key: "lejeune_years_present", label: "Approximately which years were you at Camp Lejeune?", type: "text", section: "story", required: true, placeholder: "e.g., 1972 – 1975" },
      { key: "lejeune_total_days", label: "Estimated total days on base during that period", type: "select", section: "story", required: true, options: ["30–90 days", "3–6 months", "6–12 months", "1–3 years", "More than 3 years"] },
      { key: "diagnosis", label: "What is your diagnosis?", type: "select", section: "story", required: true, options: ["Bladder Cancer", "Kidney Cancer", "Liver Cancer", "Non-Hodgkin's Lymphoma", "Leukemia (any type)", "Multiple Myeloma", "Parkinson's Disease", "Neurobehavioral Effects", "Female Infertility", "Miscarriage or Fetal Death", "Cardiac Defects (birth defect)", "Esophageal Cancer", "Lung Cancer", "Breast Cancer", "Scleroderma", "Other serious illness"] },
      { key: "diagnosis_year", label: "Year of diagnosis", type: "number", section: "story", required: true, placeholder: "YYYY" },
      { key: "filed_va_claim", label: "Have you filed a VA disability claim related to this illness?", type: "radio", section: "story", required: false, options: ["Yes — approved", "Yes — denied", "Yes — pending", "No"] },
      { key: "has_military_records", label: "Do you have military records or orders confirming your time at Camp Lejeune?", type: "radio", section: "story", required: false, options: ["Yes", "No", "Working on obtaining them"] },
      { key: "treating_physician", label: "Name of your primary treating physician", type: "text", section: "story", required: false },
      { key: "treating_hospital", label: "Hospital or VA facility where treated", type: "text", section: "story", required: false },
    ]
  ),

  conf("afff",
    "AFFF / PFAS Firefighting Foam Cancer Claim Review",
    "Military personnel, airport firefighters, and others exposed to AFFF (aqueous film-forming foam) containing PFAS chemicals may qualify for substantial compensation.",
    [
      { key: "exposed_to_afff", label: "Were you exposed to AFFF firefighting foam as part of your work or military service?", type: "radio", section: "eligibility", required: true, options: ["Yes", "No", "Unsure"] },
      { key: "has_cancer_diagnosis", label: "Have you been diagnosed with cancer?", type: "radio", section: "eligibility", required: true, options: ["Yes", "No"] },
    ],
    [
      { id: "must_have_exposure", field: "exposed_to_afff", op: "eq", value: "No", message: "This program requires documented exposure to AFFF firefighting foam." },
      { id: "must_have_cancer", field: "has_cancer_diagnosis", op: "eq", value: "No", message: "A qualifying cancer diagnosis is required for the AFFF/PFAS program." },
    ],
    [
      { key: "afff_role", label: "In what capacity were you exposed to AFFF?", type: "select", section: "story", required: true, options: ["Military firefighter", "Airport firefighter (civilian)", "Municipal / structural firefighter", "Industrial firefighter", "Navy / shipboard operations", "Military pilot or aviation crew", "Base resident near training area", "Other"] },
      { key: "afff_exposure_years", label: "Approximately how many years were you exposed?", type: "select", section: "story", required: true, options: ["Less than 1 year", "1–3 years", "4–9 years", "10–19 years", "20+ years"] },
      { key: "afff_exposure_start_year", label: "What year did your AFFF exposure begin?", type: "number", section: "story", required: true, placeholder: "YYYY" },
      { key: "afff_exposure_frequency", label: "How frequently were you exposed?", type: "select", section: "story", required: true, options: ["Daily or near-daily", "Weekly", "Monthly drills/exercises", "Occasional emergency responses", "Large-scale spill or training event"] },
      { key: "diagnosis", label: "What is your cancer diagnosis?", type: "select", section: "story", required: true, options: ["Kidney Cancer (Renal Cell Carcinoma)", "Testicular Cancer", "Bladder Cancer", "Prostate Cancer", "Thyroid Cancer", "Pancreatic Cancer", "Liver Cancer", "Breast Cancer", "Colon / Rectal Cancer", "Non-Hodgkin's Lymphoma", "Leukemia", "Ulcerative Colitis", "Thyroid Disease (non-cancer)", "Other"] },
      { key: "diagnosis_year", label: "Year of diagnosis", type: "number", section: "story", required: true, placeholder: "YYYY" },
      { key: "treating_oncologist", label: "Name of treating oncologist", type: "text", section: "story", required: false },
      { key: "treating_hospital", label: "Hospital or VA facility", type: "text", section: "story", required: false },
      { key: "has_military_or_employment_records", label: "Do you have records confirming your role/service (military orders, employment records)?", type: "radio", section: "story", required: false, options: ["Yes", "No", "Working on obtaining them"] },
    ]
  ),

  conf("paraquat",
    "Paraquat Parkinson's Disease Claim Review",
    "Research links exposure to Paraquat weed killer with a significantly elevated risk of Parkinson's disease. If you were exposed and later diagnosed, you may have a case.",
    [
      { key: "exposed_to_paraquat", label: "Were you exposed to Paraquat (Gramoxone or similar) herbicide?", type: "radio", section: "eligibility", required: true, options: ["Yes", "No", "Unsure"] },
      { key: "has_parkinsons", label: "Have you been diagnosed with Parkinson's disease or a Parkinson's-like condition?", type: "radio", section: "eligibility", required: true, options: ["Yes", "No"] },
    ],
    [
      { id: "must_have_exposure", field: "exposed_to_paraquat", op: "eq", value: "No", message: "This program requires personal exposure to Paraquat herbicide." },
      { id: "must_have_parkinsons", field: "has_parkinsons", op: "eq", value: "No", message: "A Parkinson's disease or Parkinsonism diagnosis is required for this claim." },
    ],
    [
      { key: "paraquat_role", label: "In what capacity were you exposed to Paraquat?", type: "select", section: "story", required: true, options: ["Farmworker / agricultural worker", "Farmer (self-employed)", "Landscaper or groundskeeper", "Golf course worker", "Vineyard / orchard worker", "Lived near treated fields", "Mixed or applied Paraquat professionally", "Other"] },
      { key: "paraquat_years_exposed", label: "How many years were you exposed?", type: "select", section: "story", required: true, options: ["Less than 1 year", "1–3 years", "4–9 years", "10–19 years", "20+ years"] },
      { key: "paraquat_exposure_start_year", label: "What year did exposure begin?", type: "number", section: "story", required: true, placeholder: "YYYY" },
      { key: "paraquat_application_method", label: "How was Paraquat typically applied?", type: "select", section: "story", required: false, options: ["Backpack / handheld sprayer", "Tractor-mounted sprayer", "Aerial application nearby", "Mixed or loaded concentrate", "Direct skin/clothing contact", "Unsure"] },
      { key: "paraquat_protective_equipment", label: "Did you use protective equipment (respirator, gloves, full suit) consistently?", type: "radio", section: "story", required: false, options: ["Yes, always", "Sometimes", "Rarely or never"] },
      { key: "paraquat_diagnosis_year", label: "What year were you diagnosed with Parkinson's?", type: "number", section: "story", required: true, placeholder: "YYYY" },
      { key: "paraquat_symptoms_onset", label: "At what age did Parkinson's symptoms first appear?", type: "number", section: "story", required: false, placeholder: "Age" },
      { key: "treating_neurologist", label: "Name of your treating neurologist", type: "text", section: "story", required: false },
      { key: "treating_hospital", label: "Hospital or clinic where treated", type: "text", section: "story", required: false },
      { key: "current_medications", label: "Are you currently taking Parkinson's medications (Levodopa, etc.)?", type: "radio", section: "story", required: false, options: ["Yes", "No"] },
    ]
  ),

  conf("hair-relaxer",
    "Chemical Hair Relaxer Cancer Claim Review",
    "Studies link long-term use of chemical hair relaxers to uterine cancer, ovarian cancer, and uterine fibroids. Women who regularly used relaxers may be eligible for compensation.",
    [
      { key: "used_hair_relaxer", label: "Did you use chemical hair relaxers (lye or no-lye) on a regular basis?", type: "radio", section: "eligibility", required: true, options: ["Yes", "No"] },
      { key: "has_qualifying_diagnosis", label: "Have you been diagnosed with uterine cancer, ovarian cancer, or uterine fibroids requiring surgery?", type: "radio", section: "eligibility", required: true, options: ["Yes", "No"] },
    ],
    [
      { id: "must_have_used_relaxer", field: "used_hair_relaxer", op: "eq", value: "No", message: "This program is for individuals who regularly used chemical hair relaxers." },
      { id: "must_have_diagnosis", field: "has_qualifying_diagnosis", op: "eq", value: "No", message: "A qualifying diagnosis (uterine cancer, ovarian cancer, or fibroids requiring surgery) is required." },
    ],
    [
      { key: "relaxer_brands", label: "Which hair relaxer brand(s) did you use? (select primary)", type: "select", section: "story", required: true, options: ["Dark & Lovely", "Just for Me", "ORS Olive Oil", "Motions", "Soft & Beautiful", "Revlon Realistic", "PCJ", "Affirm", "Multiple brands / store brands", "Other / don't recall brand"] },
      { key: "relaxer_years_used", label: "How many years did you use chemical hair relaxers?", type: "select", section: "story", required: true, options: ["Less than 1 year", "1–4 years", "5–9 years", "10–14 years", "15–19 years", "20+ years"] },
      { key: "relaxer_frequency", label: "How often did you use relaxers?", type: "select", section: "story", required: true, options: ["Every 6–8 weeks (regularly)", "Every 3–4 months", "A few times a year", "Varied"] },
      { key: "relaxer_start_age", label: "At what age did you start using hair relaxers?", type: "number", section: "story", required: true, placeholder: "Age" },
      { key: "diagnosis", label: "What is your diagnosis?", type: "select", section: "story", required: true, options: ["Uterine / Endometrial Cancer", "Uterine Fibroids (required surgery or procedure)", "Ovarian Cancer", "Other gynecological condition"] },
      { key: "diagnosis_year", label: "Year of diagnosis", type: "number", section: "story", required: true, placeholder: "YYYY" },
      { key: "required_surgery_or_procedure", label: "Did your condition require surgery, a procedure, or hospitalization?", type: "radio", section: "story", required: true, options: ["Yes", "No"] },
      { key: "procedure_type", label: "Type of surgical or medical procedure (if applicable)", type: "select", section: "story", required: false, options: ["Hysterectomy", "Myomectomy (fibroid removal)", "Endometrial ablation", "Uterine artery embolization (UAE)", "Cancer surgery / debulking", "Chemotherapy / radiation", "Other"] },
      { key: "treating_gynecologist", label: "Name of treating gynecologist or oncologist", type: "text", section: "story", required: false },
      { key: "treating_hospital", label: "Hospital or cancer center", type: "text", section: "story", required: false },
    ]
  ),

  conf("depo-provera",
    "Depo-Provera Brain Tumor Claim Review",
    "Long-term use of Depo-Provera injectable birth control has been linked to an increased risk of meningioma (brain tumor). Find out if you qualify.",
    [
      { key: "used_depo_provera", label: "Did you receive Depo-Provera (medroxyprogesterone acetate) injections?", type: "radio", section: "eligibility", required: true, options: ["Yes", "No", "Unsure of brand"] },
      { key: "has_brain_tumor", label: "Have you been diagnosed with a meningioma (brain tumor)?", type: "radio", section: "eligibility", required: true, options: ["Yes", "No"] },
    ],
    [
      { id: "must_have_used_depo", field: "used_depo_provera", op: "eq", value: "No", message: "This program is for individuals who received Depo-Provera injectable birth control." },
      { id: "must_have_tumor", field: "has_brain_tumor", op: "eq", value: "No", message: "A meningioma (brain tumor) diagnosis is required for the Depo-Provera program." },
    ],
    [
      { key: "depo_duration_use", label: "How long did you use Depo-Provera injections?", type: "select", section: "story", required: true, options: ["Less than 1 year", "1–2 years", "3–4 years", "5–9 years", "10+ years"] },
      { key: "depo_start_year", label: "Approximately what year did you start Depo-Provera?", type: "number", section: "story", required: true, placeholder: "YYYY" },
      { key: "depo_end_year", label: "What year did you stop using Depo-Provera?", type: "number", section: "story", required: false, placeholder: "YYYY (leave blank if still using)" },
      { key: "depo_total_injections", label: "Approximately how many injections did you receive in total?", type: "select", section: "story", required: false, options: ["1–4 injections", "5–12 injections", "13–24 injections", "25–48 injections", "More than 48 (4+ years)", "Unsure"], show_if: { field: "depo_duration", op: "ne", value: "<1 yr" } },
      { key: "tumor_type", label: "What type of brain tumor were you diagnosed with?", type: "select", section: "story", required: true, options: ["Meningioma (benign)", "Meningioma (atypical / Grade II)", "Meningioma (malignant / Grade III)", "Other brain tumor", "Still awaiting pathology"] },
      { key: "tumor_location", label: "Tumor location (if known)", type: "text", section: "story", required: false, placeholder: "e.g., frontal lobe, spinal meningioma" },
      { key: "diagnosis_year", label: "Year of brain tumor diagnosis", type: "number", section: "story", required: true, placeholder: "YYYY" },
      { key: "required_brain_surgery", label: "Did you require brain surgery (craniotomy) or other procedure?", type: "radio", section: "story", required: true, options: ["Yes", "No", "Scheduled"] },
      { key: "treating_neurosurgeon", label: "Name of treating neurosurgeon or neurologist", type: "text", section: "story", required: false },
      { key: "treating_hospital", label: "Hospital or medical center", type: "text", section: "story", required: false },
      { key: "radiation_or_chemo", label: "Did you receive radiation therapy or chemotherapy for the tumor?", type: "radio", section: "story", required: false, options: ["Yes", "No", "Currently receiving"] },
    ]
  ),

  conf("ozempic",
    "Ozempic / GLP-1 Drug Injury Claim Review",
    "Users of Ozempic, Wegovy, Mounjaro, and similar GLP-1 drugs have reported severe gastrointestinal injuries. You may be eligible for compensation.",
    [
      { key: "used_glp1_drug", label: "Were you prescribed Ozempic, Wegovy, Mounjaro, Rybelsus, Saxenda, Victoza, or another GLP-1 drug?", type: "radio", section: "eligibility", required: true, options: ["Yes", "No"] },
      { key: "has_gi_injury", label: "Have you experienced a serious gastrointestinal injury while taking or after stopping the drug?", type: "radio", section: "eligibility", required: true, options: ["Yes", "No"] },
    ],
    [
      { id: "must_have_taken_drug", field: "used_glp1_drug", op: "eq", value: "No", message: "This program is for individuals who were prescribed a GLP-1 receptor agonist medication." },
      { id: "must_have_gi_injury", field: "has_gi_injury", op: "eq", value: "No", message: "A qualifying gastrointestinal injury is required for the GLP-1 Drug program." },
    ],
    [
      { key: "glp1_drug_name", label: "Which GLP-1 drug(s) did you take?", type: "select", section: "story", required: true, options: ["Ozempic (semaglutide — diabetes)", "Wegovy (semaglutide — weight loss)", "Mounjaro (tirzepatide — diabetes)", "Zepbound (tirzepatide — weight loss)", "Rybelsus (semaglutide — oral)", "Saxenda (liraglutide — weight loss)", "Victoza (liraglutide — diabetes)", "Multiple GLP-1 drugs"] },
      { key: "glp1_prescribed_for", label: "What was the drug prescribed for?", type: "select", section: "story", required: true, options: ["Type 2 diabetes management", "Weight loss / obesity", "Both diabetes and weight loss", "Off-label use"] },
      { key: "glp1_duration", label: "How long were you on the medication?", type: "select", section: "story", required: true, options: ["Less than 1 month", "1–3 months", "4–6 months", "7–12 months", "More than 1 year"] },
      { key: "glp1_injury", label: "What was your primary injury or complication?", type: "select", section: "story", required: true, options: ["Gastroparesis (stomach paralysis)", "Intestinal obstruction / ileus", "Aspiration during surgery or anesthesia", "Severe vomiting / unable to keep food down", "Gastric bezoar", "Pancreatitis", "Severe dehydration requiring hospitalization", "Other serious GI complication"] },
      { key: "glp1_injury_year", label: "What year did the injury occur?", type: "number", section: "story", required: true, placeholder: "YYYY" },
      { key: "glp1_er_visit", label: "Did you visit an emergency room or require hospitalization?", type: "radio", section: "story", required: true, options: ["Yes", "No"] },
      { key: "glp1_required_procedure", label: "Did you require a procedure (endoscopy, surgery) for this complication?", type: "radio", section: "story", required: false, options: ["Yes", "No"] },
      { key: "prescribing_doctor", label: "Name of the prescribing doctor", type: "text", section: "story", required: false },
      { key: "treating_hospital", label: "Hospital or ER where treated", type: "text", section: "story", required: false },
      { key: "still_on_medication", label: "Are you currently still taking the medication?", type: "radio", section: "story", required: false, options: ["Yes", "No — discontinued due to injury", "No — doctor stopped it", "No — other reason"] },
    ]
  ),

  conf("glp1",
    "GLP-1 Drug Injury Claim Review",
    "Users of GLP-1 drugs (Ozempic, Wegovy, Mounjaro) have suffered serious stomach and gastrointestinal complications. See if you qualify for compensation.",
    [
      { key: "used_glp1_drug", label: "Were you prescribed Ozempic, Wegovy, Mounjaro, Zepbound, Saxenda, Rybelsus, or another GLP-1 drug?", type: "radio", section: "eligibility", required: true, options: ["Yes", "No"] },
      { key: "has_gi_injury", label: "Did you suffer a serious gastrointestinal complication while on or after stopping the drug?", type: "radio", section: "eligibility", required: true, options: ["Yes", "No"] },
    ],
    [
      { id: "must_have_taken_drug", field: "used_glp1_drug", op: "eq", value: "No", message: "This program requires use of a GLP-1 receptor agonist medication." },
      { id: "must_have_injury", field: "has_gi_injury", op: "eq", value: "No", message: "A qualifying gastrointestinal injury is required for this program." },
    ],
    [
      { key: "glp1_drug_name", label: "Which drug(s) did you take?", type: "select", section: "story", required: true, options: ["Ozempic", "Wegovy", "Mounjaro", "Zepbound", "Saxenda", "Victoza / Rybelsus", "Multiple"] },
      { key: "glp1_prescribed_for", label: "Prescribed for?", type: "select", section: "story", required: true, options: ["Type 2 diabetes", "Weight loss", "Both", "Off-label"] },
      { key: "glp1_duration", label: "Duration of use", type: "select", section: "story", required: true, options: ["< 1 month", "1–3 months", "4–6 months", "7–12 months", "1–2 years", "2+ years"] },
      { key: "glp1_injury", label: "Primary injury or complication", type: "select", section: "story", required: true, options: ["Gastroparesis (stomach paralysis)", "Intestinal obstruction / ileus", "Aspiration (surgery/anesthesia)", "Severe nausea / vomiting", "Pancreatitis", "Severe dehydration", "Gastric bezoar", "Other serious GI event"] },
      { key: "glp1_injury_year", label: "Year injury occurred", type: "number", section: "story", required: true, placeholder: "YYYY" },
      { key: "glp1_hospitalized", label: "Were you hospitalized?", type: "radio", section: "story", required: true, options: ["Yes", "No"] },
      { key: "prescribing_doctor", label: "Name of prescribing doctor", type: "text", section: "story", required: false },
      { key: "treating_hospital", label: "Hospital where treated", type: "text", section: "story", required: false },
    ]
  ),

  conf("social-media",
    "Social Media Mental Health Harm Claim Review",
    "Instagram, TikTok, Facebook, and Snapchat have been accused of deliberately addicting minors and causing serious mental health harm. If you or your child were affected, you may have a case.",
    [
      { key: "social_claimant_type", label: "Who is affected by social media harm?", type: "radio", section: "eligibility", required: true, options: ["I am the affected person (age 18+ now)", "I am the parent/guardian of a minor who was affected", "I am filing on behalf of an adult child"] },
      { key: "was_minor_during_use", label: "Was the affected person under 18 years old when the addiction/harm developed?", type: "radio", section: "eligibility", required: true, options: ["Yes", "No", "Was a minor initially, continued into adulthood"] },
      { key: "has_mental_health_diagnosis", label: "Has a doctor or mental health professional diagnosed a mental health condition linked to social media use?", type: "radio", section: "eligibility", required: true, options: ["Yes", "No", "Seeking diagnosis / evaluating"] },
    ],
    [
      { id: "must_have_been_minor", field: "was_minor_during_use", op: "eq", value: "No", message: "This program primarily covers harms that developed while the user was a minor. Please consult an attorney for adult cases." },
      { id: "must_have_diagnosis", field: "has_mental_health_diagnosis", op: "eq", value: "No", message: "A clinical mental health diagnosis linked to social media use is required for this program." },
    ],
    [
      { key: "platforms_used", label: "Which social media platforms were primarily used?", type: "select", section: "story", required: true, options: ["Instagram", "TikTok", "Facebook", "Snapchat", "YouTube", "Multiple platforms (2+)", "All major platforms"] },
      { key: "age_started", label: "At what age did regular social media use begin?", type: "number", section: "story", required: true, placeholder: "Age" },
      { key: "daily_hours", label: "At peak use, how many hours per day were spent on social media?", type: "select", section: "story", required: true, options: ["1–2 hours", "3–4 hours", "5–6 hours", "7–8 hours", "More than 8 hours"] },
      { key: "years_of_use", label: "How many years of regular use (prior to seeking help)?", type: "select", section: "story", required: true, options: ["Less than 1 year", "1–2 years", "3–4 years", "5+ years"] },
      { key: "social_diagnoses", label: "What mental health diagnosis(es) has been received?", type: "select", section: "story", required: true, options: ["Clinical depression", "Anxiety disorder", "Eating disorder (anorexia, bulimia, ARFID)", "Body dysmorphia", "PTSD or trauma", "Self-harm behaviors", "Suicide attempt", "Addiction to social media (diagnosed)", "Multiple diagnoses"] },
      { key: "diagnosis_year", label: "Year of mental health diagnosis", type: "number", section: "story", required: true, placeholder: "YYYY" },
      { key: "hospitalized_psychiatric", label: "Was the affected person hospitalized or placed in psychiatric care?", type: "radio", section: "story", required: true, options: ["Yes", "No"] },
      { key: "inpatient_treatment", label: "Did they receive inpatient or residential mental health treatment?", type: "radio", section: "story", required: false, options: ["Yes", "No", "Outpatient only"] },
      { key: "treating_provider", label: "Name of treating therapist, psychiatrist, or mental health provider", type: "text", section: "story", required: false },
      { key: "self_harm_or_attempt", label: "Did the harm involve self-harm or a suicide attempt?", type: "radio", section: "story", required: false, options: ["Yes", "No", "Prefer not to answer"] },
    ]
  ),

  conf("roblox",
    "Roblox Child Exploitation Claim Review",
    "Children have been targeted by predators on Roblox, leading to exploitation, grooming, and sexual abuse. If your child was harmed, you may have legal recourse against the company.",
    [
      { key: "is_parent_or_guardian", label: "Are you a parent, guardian, or the affected person (now 18+)?", type: "radio", section: "eligibility", required: true, options: ["Parent or guardian of a minor", "Parent of an adult child affected as a minor", "I am the affected person (now 18+)", "Other legal representative"] },
      { key: "child_was_minor", label: "Was the child under 18 when the harm occurred on Roblox?", type: "radio", section: "eligibility", required: true, options: ["Yes", "No"] },
      { key: "harm_occurred", label: "Did the child experience grooming, sexual exploitation, or inappropriate contact through Roblox?", type: "radio", section: "eligibility", required: true, options: ["Yes", "No", "Unsure / ongoing investigation"] },
    ],
    [
      { id: "must_be_minor", field: "child_was_minor", op: "eq", value: "No", message: "This program covers harm to minors on the Roblox platform." },
      { id: "must_have_harm", field: "harm_occurred", op: "eq", value: "No", message: "Documented harm through the Roblox platform is required for this claim." },
    ],
    [
      { key: "child_age_at_incident", label: "How old was the child when the harm began?", type: "number", section: "story", required: true, placeholder: "Age" },
      { key: "incident_year", label: "Approximately what year did the incident(s) begin?", type: "number", section: "story", required: true, placeholder: "YYYY" },
      { key: "nature_of_harm", label: "What type of harm occurred? (sensitive details — describe in the description field if you prefer)", type: "select", section: "story", required: true, options: ["Grooming by an adult stranger", "Sexual solicitation through chat", "Exploitation involving images or videos", "In-person meeting arranged through platform", "Financial exploitation / manipulation", "Cyberbullying and harassment", "Multiple types of harm"] },
      { key: "reported_to_law_enforcement", label: "Was the incident reported to law enforcement?", type: "radio", section: "story", required: true, options: ["Yes — criminal case opened", "Yes — reported but not prosecuted", "No", "In process of reporting"] },
      { key: "perpetrator_known", label: "Is the perpetrator known or identified?", type: "radio", section: "story", required: false, options: ["Yes", "No", "Partially"] },
      { key: "child_receiving_therapy", label: "Is the child currently receiving mental health counseling or therapy?", type: "radio", section: "story", required: false, options: ["Yes", "No", "Recently started"] },
      { key: "reported_to_roblox", label: "Was the incident reported to Roblox?", type: "radio", section: "story", required: false, options: ["Yes — platform did not act", "Yes — platform acted", "No"] },
      { key: "child_diagnosed_mental_health", label: "Has the child received a mental health diagnosis (PTSD, anxiety, depression) related to this incident?", type: "radio", section: "story", required: false, options: ["Yes", "No", "Currently evaluating"] },
      { key: "therapist_or_counselor", label: "Name of treating therapist or counselor (if applicable)", type: "text", section: "story", required: false },
    ]
  ),

  conf("online-gaming",
    "Online Gaming Addiction & Exploitation Claim Review",
    "Online gaming companies have been accused of using predatory practices to addict minors and expose them to exploitation. See if you have a case.",
    [
      { key: "affected_person_type", label: "Who was affected?", type: "radio", section: "eligibility", required: true, options: ["I am the affected person", "I am a parent/guardian of a minor affected", "Both"] },
      { key: "was_minor_during_harm", label: "Was the affected person under 18 when the harm began?", type: "radio", section: "eligibility", required: true, options: ["Yes", "No", "Started as minor, continued into adulthood"] },
      { key: "has_documented_harm", label: "Has the affected person received a diagnosis or experienced documented harm?", type: "radio", section: "eligibility", required: true, options: ["Yes", "No", "Seeking evaluation"] },
    ],
    [
      { id: "must_have_harm", field: "has_documented_harm", op: "eq", value: "No", message: "A documented diagnosis or clear harm is required for this program." },
    ],
    [
      { key: "gaming_platforms", label: "Which platforms were involved?", type: "select", section: "story", required: true, options: ["Xbox / Xbox Live", "PlayStation Network", "Steam", "Epic Games / Fortnite", "Activision / Call of Duty", "Riot Games", "Multiple platforms", "Other"] },
      { key: "daily_gaming_hours", label: "At peak, how many hours per day was the person gaming?", type: "select", section: "story", required: true, options: ["2–4 hours", "5–6 hours", "7–9 hours", "10–12 hours", "12+ hours"] },
      { key: "years_of_gaming", label: "How many years of heavy gaming?", type: "select", section: "story", required: true, options: ["Less than 1 year", "1–2 years", "3–4 years", "5+ years"] },
      { key: "harm_type", label: "What type of harm occurred?", type: "select", section: "story", required: true, options: ["Gaming addiction / behavioral disorder", "Financial exploitation (gambling-style loot boxes)", "Sexual exploitation or grooming by other players", "Cyberbullying and harassment", "Physical health decline (vision, weight)", "Academic/occupational failure", "Multiple harms"] },
      { key: "gaming_diagnosis", label: "Mental health or medical diagnosis received", type: "select", section: "story", required: false, options: ["Internet Gaming Disorder (IGD)", "Depression", "Anxiety", "ADHD exacerbated by gaming", "Sleep disorder", "No formal diagnosis yet", "Other"] },
      { key: "diagnosis_year", label: "Year of diagnosis (if applicable)", type: "number", section: "story", required: false, placeholder: "YYYY" },
      { key: "money_spent_in_game", label: "Approximate total spent on in-game purchases", type: "select", section: "story", required: false, options: ["Under $500", "$500–$2,000", "$2,000–$10,000", "$10,000–$50,000", "Over $50,000"] },
      { key: "treating_provider", label: "Name of treating therapist, psychiatrist, or specialist", type: "text", section: "story", required: false },
    ]
  ),

  conf("asbestos",
    "Asbestos & Mesothelioma Claim Review",
    "Workers and veterans exposed to asbestos-containing materials may develop mesothelioma, asbestosis, or lung cancer decades later. Substantial compensation may be available.",
    [
      { key: "was_exposed_to_asbestos", label: "Were you exposed to asbestos or asbestos-containing materials in your work or military service?", type: "radio", section: "eligibility", required: true, options: ["Yes", "No", "Unsure"] },
      { key: "has_asbestos_diagnosis", label: "Have you been diagnosed with mesothelioma, asbestosis, lung cancer, or another asbestos-related illness?", type: "radio", section: "eligibility", required: true, options: ["Yes", "No"] },
    ],
    [
      { id: "must_have_exposure", field: "was_exposed_to_asbestos", op: "eq", value: "No", message: "This program requires documented or likely exposure to asbestos." },
      { id: "must_have_diagnosis", field: "has_asbestos_diagnosis", op: "eq", value: "No", message: "A mesothelioma or asbestos-related diagnosis is required to pursue this claim." },
    ],
    [
      { key: "exposure_industry", label: "What industry or occupation caused the exposure?", type: "select", section: "story", required: true, options: ["Shipbuilding / Navy", "Construction / demolition", "Automotive / mechanic", "Manufacturing / factory", "Railroad", "Power plant / utility", "Military (non-Navy)", "Insulation / pipe fitting", "Mining", "Firefighting", "Other trades"] },
      { key: "exposure_start_year", label: "What year did asbestos exposure begin?", type: "number", section: "story", required: true, placeholder: "YYYY" },
      { key: "exposure_end_year", label: "What year did exposure end (if applicable)?", type: "number", section: "story", required: false, placeholder: "YYYY" },
      { key: "exposure_total_years", label: "Total years of asbestos exposure", type: "select", section: "story", required: true, options: ["Less than 1 year", "1–4 years", "5–9 years", "10–19 years", "20+ years"] },
      { key: "asbestos_product_type", label: "What asbestos-containing materials were you exposed to?", type: "select", section: "story", required: false, options: ["Pipe insulation / lagging", "Floor / ceiling tiles", "Roof shingles / siding", "Brake pads / clutch linings", "Boiler insulation", "Fireproofing spray", "Gaskets / packing", "Multiple / unsure"] },
      { key: "diagnosis", label: "What is your diagnosis?", type: "select", section: "story", required: true, options: ["Malignant Mesothelioma (pleural)", "Malignant Mesothelioma (peritoneal)", "Malignant Mesothelioma (pericardial)", "Lung Cancer (asbestos-related)", "Asbestosis", "Pleural Plaques / Thickening", "Other asbestos-related illness"] },
      { key: "diagnosis_year", label: "Year of diagnosis", type: "number", section: "story", required: true, placeholder: "YYYY" },
      { key: "treating_oncologist", label: "Name of treating oncologist or pulmonologist", type: "text", section: "story", required: false },
      { key: "treating_hospital", label: "Hospital or cancer center", type: "text", section: "story", required: false },
      { key: "has_trust_fund_claim", label: "Have you previously filed an asbestos trust fund claim?", type: "radio", section: "story", required: true, options: ["Yes", "No", "In process"] },
    ]
  ),

  conf("benzene",
    "Benzene Exposure Cancer Claim Review",
    "Benzene is a known carcinogen found in gasoline, solvents, and industrial settings. Chronic exposure is linked to leukemia, lymphoma, and other blood cancers.",
    [
      { key: "was_exposed_to_benzene", label: "Were you exposed to benzene or benzene-containing products in the workplace?", type: "radio", section: "eligibility", required: true, options: ["Yes", "No", "Unsure"] },
      { key: "has_blood_cancer", label: "Have you been diagnosed with leukemia, lymphoma, or another blood disorder?", type: "radio", section: "eligibility", required: true, options: ["Yes", "No"] },
    ],
    [
      { id: "must_have_exposure", field: "was_exposed_to_benzene", op: "eq", value: "No", message: "This program requires documented benzene exposure." },
      { id: "must_have_cancer", field: "has_blood_cancer", op: "eq", value: "No", message: "A blood cancer or disorder diagnosis linked to benzene is required." },
    ],
    [
      { key: "benzene_industry", label: "Which industry or job involved benzene exposure?", type: "select", section: "story", required: true, options: ["Oil refinery worker", "Gas station attendant / fueling", "Petrochemical plant", "Chemical manufacturing", "Rubber / tire manufacturing", "Printing / screen printing", "Dry cleaning", "Automotive / mechanic", "Shoe / leather manufacturing", "Military (fuel handling)", "Pipeline / pipeline maintenance", "Other"] },
      { key: "benzene_exposure_years", label: "Total years of benzene exposure", type: "select", section: "story", required: true, options: ["Less than 1 year", "1–4 years", "5–9 years", "10–19 years", "20+ years"] },
      { key: "benzene_exposure_start", label: "Year benzene exposure began", type: "number", section: "story", required: true, placeholder: "YYYY" },
      { key: "benzene_ppe_used", label: "Was proper respiratory protective equipment (PPE) provided and consistently used?", type: "radio", section: "story", required: false, options: ["Yes", "No", "Sometimes"] },
      { key: "diagnosis", label: "Cancer or blood disorder diagnosis", type: "select", section: "story", required: true, options: ["Acute Myeloid Leukemia (AML)", "Chronic Myeloid Leukemia (CML)", "Acute Lymphocytic Leukemia (ALL)", "Chronic Lymphocytic Leukemia (CLL)", "Myelodysplastic Syndrome (MDS)", "Non-Hodgkin's Lymphoma", "Hodgkin's Lymphoma", "Multiple Myeloma", "Aplastic Anemia", "Other"] },
      { key: "diagnosis_year", label: "Year of diagnosis", type: "number", section: "story", required: true, placeholder: "YYYY" },
      { key: "treating_oncologist", label: "Treating oncologist name", type: "text", section: "story", required: false },
      { key: "treating_hospital", label: "Hospital or cancer center", type: "text", section: "story", required: false },
      { key: "employer_at_time_of_exposure", label: "Primary employer during exposure period", type: "text", section: "story", required: false, placeholder: "Company name" },
    ]
  ),

  conf("cpap",
    "CPAP / BiPAP Device Injury Claim Review",
    "Certain CPAP and BiPAP machines have been recalled after it was found that foam components can break down and be inhaled or ingested, potentially causing serious harm.",
    [
      { key: "used_recalled_cpap", label: "Did you use a Philips, DreamStation, or another CPAP/BiPAP device later recalled?", type: "radio", section: "eligibility", required: true, options: ["Yes", "No", "Unsure of brand"] },
      { key: "has_respiratory_or_cancer", label: "Have you been diagnosed with a respiratory illness, cancer, or other condition potentially linked to the device?", type: "radio", section: "eligibility", required: true, options: ["Yes", "No"] },
    ],
    [
      { id: "must_have_used_device", field: "used_recalled_cpap", op: "eq", value: "No", message: "This program requires use of a recalled CPAP or BiPAP device." },
      { id: "must_have_diagnosis", field: "has_respiratory_or_cancer", op: "eq", value: "No", message: "A qualifying respiratory or cancer diagnosis is required." },
    ],
    [
      { key: "cpap_brand", label: "Which CPAP/BiPAP device did you use?", type: "select", section: "story", required: true, options: ["Philips DreamStation 1", "Philips DreamStation Go", "Philips System One", "Philips REMstar", "Philips Trilogy Evo (ventilator)", "Philips A-Series BiPAP", "Other Philips device", "Unsure of exact model"] },
      { key: "cpap_years_used", label: "How many years did you use the device?", type: "select", section: "story", required: true, options: ["Less than 1 year", "1–2 years", "3–5 years", "6–10 years", "More than 10 years"] },
      { key: "cpap_use_start_year", label: "What year did you start using the device?", type: "number", section: "story", required: true, placeholder: "YYYY" },
      { key: "cpap_aware_of_recall", label: "Were you notified of the recall?", type: "radio", section: "story", required: false, options: ["Yes — stopped using", "Yes — still using", "No — unaware until recently"] },
      { key: "diagnosis", label: "What is your diagnosis?", type: "select", section: "story", required: true, options: ["Lung Cancer", "Respiratory Injury / ARDS", "Kidney Cancer", "Liver Cancer", "Nasal / Sinus Cancer", "Bladder Cancer", "Foam degradation ingestion injury", "Thyroid issues", "Other diagnosis"] },
      { key: "diagnosis_year", label: "Year of diagnosis", type: "number", section: "story", required: true, placeholder: "YYYY" },
      { key: "treating_pulmonologist", label: "Name of treating pulmonologist or oncologist", type: "text", section: "story", required: false },
      { key: "treating_hospital", label: "Hospital or clinic", type: "text", section: "story", required: false },
      { key: "has_purchase_records", label: "Do you have purchase records, prescriptions, or equipment records for the device?", type: "radio", section: "story", required: false, options: ["Yes", "No", "May have — need to check"] },
    ]
  ),

  conf("philips-cpap",
    "Philips CPAP/BiPAP Recall Claim Review",
    "Philips recalled millions of CPAP, BiPAP, and ventilator devices in 2021 after finding that the sound-dampening foam can degrade and expose users to carcinogenic particles and gases.",
    [
      { key: "used_philips_device", label: "Did you use a Philips DreamStation, System One, or another Philips sleep therapy device?", type: "radio", section: "eligibility", required: true, options: ["Yes", "No", "Unsure"] },
      { key: "has_health_condition", label: "Have you developed a health condition since using the device?", type: "radio", section: "eligibility", required: true, options: ["Yes", "No"] },
      { key: "device_registered", label: "Did you register your device or receive a recall notice from Philips?", type: "radio", section: "eligibility", required: false, options: ["Yes", "No", "Unsure"] },
    ],
    [
      { id: "must_have_philips_device", field: "used_philips_device", op: "eq", value: "No", message: "This program is specifically for users of recalled Philips sleep therapy devices." },
      { id: "must_have_health_condition", field: "has_health_condition", op: "eq", value: "No", message: "A health condition linked to the Philips device recall is required." },
    ],
    [
      { key: "philips_model", label: "Philips device model (if known)", type: "select", section: "story", required: true, options: ["DreamStation 1 (DSX500)", "DreamStation Go (DSX200)", "System One (REMstar Pro/Auto)", "Trilogy Evo (ventilator)", "A-Series BiPAP", "C-Series ASV", "Other Philips model", "Unsure"] },
      { key: "philips_years_used", label: "How many years did you use the Philips device?", type: "select", section: "story", required: true, options: ["Less than 1 year", "1–2 years", "3–4 years", "5–7 years", "8–10 years", "More than 10 years"] },
      { key: "philips_start_year", label: "Year you started using the Philips device", type: "number", section: "story", required: true, placeholder: "YYYY" },
      { key: "philips_ozone_cleaner", label: "Did you use an ozone-based CPAP cleaner (SoClean, VirtuClean, etc.) with your device?", type: "radio", section: "story", required: true, options: ["Yes", "No", "Unsure"] },
      { key: "diagnosis", label: "Diagnosis or health condition developed", type: "select", section: "story", required: true, options: ["Lung Cancer", "Respiratory damage / ARDS", "Kidney Cancer", "Liver Cancer", "Nasal / sinus cancer", "Bladder Cancer", "Throat / laryngeal cancer", "Thyroid condition", "Toxic chemical inhalation injury", "Other"] },
      { key: "diagnosis_year", label: "Year of diagnosis", type: "number", section: "story", required: true, placeholder: "YYYY" },
      { key: "treating_doctor", label: "Name of treating physician", type: "text", section: "story", required: false },
      { key: "treating_hospital", label: "Hospital or clinic", type: "text", section: "story", required: false },
      { key: "submitted_recall_registration", label: "Did you submit a device registration through the Philips recall program?", type: "radio", section: "story", required: false, options: ["Yes", "No", "In process"] },
    ]
  ),

  conf("hernia-mesh",
    "Hernia Mesh Complication Claim Review",
    "Thousands of patients have suffered serious complications — including hernia recurrence, infection, and organ damage — from defective hernia mesh implants.",
    [
      { key: "had_hernia_mesh_implant", label: "Did you receive a hernia mesh implant?", type: "radio", section: "eligibility", required: true, options: ["Yes", "No"] },
      { key: "has_mesh_complication", label: "Have you experienced complications from the mesh (pain, infection, recurrence, bowel issues)?", type: "radio", section: "eligibility", required: true, options: ["Yes", "No"] },
    ],
    [
      { id: "must_have_implant", field: "had_hernia_mesh_implant", op: "eq", value: "No", message: "This program requires a hernia mesh implant." },
      { id: "must_have_complication", field: "has_mesh_complication", op: "eq", value: "No", message: "A documented complication from hernia mesh is required." },
    ],
    [
      { key: "hernia_type", label: "What type of hernia was repaired?", type: "select", section: "story", required: true, options: ["Inguinal hernia", "Femoral hernia", "Umbilical hernia", "Incisional hernia", "Hiatal hernia", "Ventral hernia", "Multiple hernias", "Unsure"] },
      { key: "mesh_brand", label: "Mesh product brand (if known)", type: "select", section: "story", required: false, options: ["Bard / Davol (Covidien)", "Ethicon / Johnson & Johnson", "Atrium C-QUR", "Gore-Tex / W.L. Gore", "Mentor / Allergan", "Herniamesh", "Unsure / not told"] },
      { key: "surgery_year", label: "What year was the hernia mesh implanted?", type: "number", section: "story", required: true, placeholder: "YYYY" },
      { key: "complication_type", label: "What complications did you experience?", type: "select", section: "story", required: true, options: ["Chronic pain at implant site", "Mesh migration", "Infection / abscess", "Hernia recurrence", "Bowel obstruction or perforation", "Fistula formation", "Adhesion / organ damage", "Mesh shrinkage causing tightness", "Multiple complications"] },
      { key: "complication_year", label: "What year did complications develop?", type: "number", section: "story", required: true, placeholder: "YYYY" },
      { key: "required_revision_surgery", label: "Did you require a second (revision) surgery to remove or repair the mesh?", type: "radio", section: "story", required: true, options: ["Yes", "No", "Scheduled"] },
      { key: "revision_surgery_year", label: "Year of revision surgery (if applicable)", type: "number", section: "story", required: false, placeholder: "YYYY" },
      { key: "still_in_pain", label: "Are you still experiencing pain or complications from the mesh?", type: "radio", section: "story", required: false, options: ["Yes — ongoing", "Improved but not resolved", "Resolved after revision surgery"] },
      { key: "original_surgeon", label: "Name of the surgeon who implanted the mesh", type: "text", section: "story", required: false },
      { key: "treating_hospital", label: "Hospital where surgery was performed", type: "text", section: "story", required: false },
    ]
  ),

  conf("hip-implants",
    "Metal Hip Implant Failure Claim Review",
    "Metal-on-metal hip implants and other defective devices have caused metallosis, device failure, and the need for painful revision surgeries. You may be entitled to compensation.",
    [
      { key: "had_hip_implant", label: "Did you receive a hip replacement or hip implant device?", type: "radio", section: "eligibility", required: true, options: ["Yes", "No"] },
      { key: "has_implant_failure", label: "Did your hip implant fail, require revision surgery, or cause pain and complications?", type: "radio", section: "eligibility", required: true, options: ["Yes", "No"] },
    ],
    [
      { id: "must_have_implant", field: "had_hip_implant", op: "eq", value: "No", message: "This program requires a hip replacement or implant." },
      { id: "must_have_failure", field: "has_implant_failure", op: "eq", value: "No", message: "A documented implant failure or complication is required." },
    ],
    [
      { key: "hip_implant_brand", label: "Hip implant brand or system (if known)", type: "select", section: "story", required: false, options: ["DePuy ASR (J&J)", "DePuy Pinnacle (J&J)", "Stryker Rejuvenate / ABG II", "Stryker LFIT V40", "Wright Conserve / Profemur", "Biomet M2a-Magnum", "Smith & Nephew BHR / R3", "Zimmer Durom / M/L Taper", "Other metal-on-metal system", "Unsure"] },
      { key: "implant_year", label: "Year of original hip implant surgery", type: "number", section: "story", required: true, placeholder: "YYYY" },
      { key: "complication_type", label: "What complication did you experience?", type: "select", section: "story", required: true, options: ["Metallosis (metal poisoning)", "Implant loosening", "Fracture of implant components", "Tissue / bone damage from metal debris", "Chronic pain at hip", "Dislocation", "Corrosion at modular junction", "Device failure requiring urgent revision", "Multiple complications"] },
      { key: "complication_year", label: "Year complications began", type: "number", section: "story", required: true, placeholder: "YYYY" },
      { key: "revision_surgery", label: "Have you had or been recommended revision surgery?", type: "radio", section: "story", required: true, options: ["Yes — completed", "Yes — scheduled", "Recommended but not yet scheduled", "No"] },
      { key: "revision_surgery_year", label: "Year of revision surgery (if completed)", type: "number", section: "story", required: false, placeholder: "YYYY" },
      { key: "cobalt_chromium_tested", label: "Have you been tested for elevated cobalt or chromium levels in your blood?", type: "radio", section: "story", required: false, options: ["Yes — elevated levels found", "Yes — levels normal", "No", "Testing pending"] },
      { key: "original_surgeon", label: "Name of original implanting surgeon", type: "text", section: "story", required: false },
      { key: "treating_hospital", label: "Hospital where surgery was performed", type: "text", section: "story", required: false },
    ]
  ),

  conf("ivc-filters",
    "IVC Filter Injury Claim Review",
    "Retrievable IVC (inferior vena cava) filters have been linked to fractures, migration, and perforation of organs. If your IVC filter caused injury, you may have a case.",
    [
      { key: "had_ivc_filter", label: "Have you had an IVC filter implanted?", type: "radio", section: "eligibility", required: true, options: ["Yes", "No"] },
      { key: "has_ivc_complication", label: "Did your IVC filter migrate, fracture, perforate organs, or cause other complications?", type: "radio", section: "eligibility", required: true, options: ["Yes", "No", "Possible — investigating"] },
    ],
    [
      { id: "must_have_filter", field: "had_ivc_filter", op: "eq", value: "No", message: "This program requires an IVC filter implant." },
      { id: "must_have_complication", field: "has_ivc_complication", op: "eq", value: "No", message: "A documented IVC filter complication is required." },
    ],
    [
      { key: "ivc_filter_brand", label: "IVC filter brand (if known)", type: "select", section: "story", required: false, options: ["Bard Recovery / G2 / Eclipse", "Bard Meridian / Denali", "Cook Celect / Günther Tulip", "Cordis / Cardinal Health OptEase / TrapEase", "ALN Filter", "Argon Option / Option Elite", "Rex Medical Option", "Other / unsure"] },
      { key: "ivc_implant_year", label: "Year the IVC filter was implanted", type: "number", section: "story", required: true, placeholder: "YYYY" },
      { key: "filter_type", label: "Was the filter intended to be temporary (retrievable) or permanent?", type: "radio", section: "story", required: true, options: ["Retrievable (temporary)", "Permanent", "Unsure"] },
      { key: "filter_retrieved", label: "Was the filter ever retrieved (removed)?", type: "radio", section: "story", required: false, options: ["Yes", "No — still in place", "Attempted but could not be retrieved"] },
      { key: "complication_type", label: "What complication occurred?", type: "select", section: "story", required: true, options: ["Filter fracture (broken pieces in body)", "Filter migration (moved from original position)", "Perforation of vena cava or other organ", "Deep vein thrombosis (DVT) worsened", "Pulmonary embolism while filter in place", "Chest or abdominal pain from device", "Chronic back or groin pain", "Multiple complications"] },
      { key: "complication_year", label: "Year complication discovered", type: "number", section: "story", required: true, placeholder: "YYYY" },
      { key: "required_surgery_to_remove", label: "Did you require surgery to remove or address the filter?", type: "radio", section: "story", required: false, options: ["Yes", "No", "Attempted, could not be completed"] },
      { key: "treating_interventionalist", label: "Name of treating interventional radiologist or surgeon", type: "text", section: "story", required: false },
      { key: "treating_hospital", label: "Hospital where filter was placed", type: "text", section: "story", required: false },
    ]
  ),

  conf("bard-powerport",
    "Bard PowerPort Catheter Injury Claim Review",
    "Bard PowerPort implantable port catheters have been linked to catheter fracture, migration, and other serious complications. Find out if you qualify for compensation.",
    [
      { key: "had_bard_powerport", label: "Did you have a Bard PowerPort or similar implantable port-a-cath device?", type: "radio", section: "eligibility", required: true, options: ["Yes", "No", "Unsure of brand"] },
      { key: "has_powerport_complication", label: "Did your port catheter fracture, migrate, or cause complications?", type: "radio", section: "eligibility", required: true, options: ["Yes", "No"] },
    ],
    [
      { id: "must_have_device", field: "had_bard_powerport", op: "eq", value: "No", message: "This program requires use of a Bard PowerPort or similar implantable port device." },
      { id: "must_have_complication", field: "has_powerport_complication", op: "eq", value: "No", message: "A documented catheter complication is required." },
    ],
    [
      { key: "powerport_implant_year", label: "Year the PowerPort was implanted", type: "number", section: "story", required: true, placeholder: "YYYY" },
      { key: "powerport_reason", label: "Why was the port-a-cath implanted?", type: "select", section: "story", required: true, options: ["Chemotherapy administration", "Frequent IV access / infusions", "Antibiotic treatment", "Blood draws / dialysis access", "TPN (nutrition)", "Other"] },
      { key: "complication_type", label: "What complication occurred?", type: "select", section: "story", required: true, options: ["Catheter fracture / breakage", "Catheter migration (moved to heart or lungs)", "Cardiac arrhythmia from migrated fragment", "Port infection / sepsis", "Thrombosis (blood clot) at site", "Pain and local tissue damage", "Device malfunction / failure", "Multiple complications"] },
      { key: "complication_year", label: "Year complication occurred", type: "number", section: "story", required: true, placeholder: "YYYY" },
      { key: "required_surgery_to_remove", label: "Did you require surgery or an emergency procedure to remove the fragment?", type: "radio", section: "story", required: true, options: ["Yes", "No", "Attempted"] },
      { key: "treating_oncologist", label: "Name of treating oncologist or physician who implanted port", type: "text", section: "story", required: false },
      { key: "treating_hospital", label: "Hospital or infusion center", type: "text", section: "story", required: false },
    ]
  ),

  conf("exactech",
    "Exactech Implant Failure Claim Review",
    "Exactech recalled hundreds of thousands of knee, hip, and ankle replacement systems due to defective packaging that caused device degradation and premature failure.",
    [
      { key: "had_exactech_implant", label: "Did you receive an Exactech hip, knee, or ankle replacement?", type: "radio", section: "eligibility", required: true, options: ["Yes", "No", "Unsure of brand"] },
      { key: "has_implant_complication", label: "Has your implant failed, caused pain, or required revision surgery?", type: "radio", section: "eligibility", required: true, options: ["Yes", "No", "Early signs of concern"] },
    ],
    [
      { id: "must_have_exactech", field: "had_exactech_implant", op: "eq", value: "No", message: "This program requires an Exactech brand joint replacement device." },
      { id: "must_have_complication", field: "has_implant_complication", op: "eq", value: "No", message: "A documented implant complication or failure is required." },
    ],
    [
      { key: "exactech_joint_type", label: "Which joint was replaced?", type: "select", section: "story", required: true, options: ["Knee (Optetrak, Optetrak Logic, Truliant)", "Hip", "Ankle (Vantage)", "Multiple joints"] },
      { key: "exactech_implant_year", label: "Year of the Exactech implant surgery", type: "number", section: "story", required: true, placeholder: "YYYY" },
      { key: "complication_type", label: "What complication(s) have you experienced?", type: "select", section: "story", required: true, options: ["Premature wear / polyethylene degradation", "Implant loosening", "Severe pain at joint", "Limited range of motion", "Swelling and inflammation", "Device fracture or failure", "Required or scheduled revision surgery"] },
      { key: "complication_year", label: "Year complications began", type: "number", section: "story", required: true, placeholder: "YYYY" },
      { key: "revision_surgery", label: "Have you had or been recommended revision surgery?", type: "radio", section: "story", required: true, options: ["Yes — completed", "Yes — scheduled", "Recommended but postponed", "No"] },
      { key: "original_surgeon", label: "Surgeon who implanted the Exactech device", type: "text", section: "story", required: false },
      { key: "treating_hospital", label: "Hospital where surgery was performed", type: "text", section: "story", required: false },
      { key: "notified_of_recall", label: "Were you notified of the Exactech recall?", type: "radio", section: "story", required: false, options: ["Yes", "No", "Unsure"] },
    ]
  ),

  conf("paragard",
    "Paragard IUD Injury Claim Review",
    "The copper Paragard IUD has been reported to break during removal, leaving fragments embedded in the uterus and causing serious injury. If you were harmed, you may have a claim.",
    [
      { key: "had_paragard", label: "Did you use the Paragard copper IUD?", type: "radio", section: "eligibility", required: true, options: ["Yes", "No"] },
      { key: "paragard_broke_or_caused_injury", label: "Did the Paragard IUD break during removal, embed in your uterus, or cause serious injury?", type: "radio", section: "eligibility", required: true, options: ["Yes", "No"] },
    ],
    [
      { id: "must_have_paragard", field: "had_paragard", op: "eq", value: "No", message: "This program is for Paragard IUD users only." },
      { id: "must_have_injury", field: "paragard_broke_or_caused_injury", op: "eq", value: "No", message: "A documented Paragard IUD injury or breakage during removal is required." },
    ],
    [
      { key: "paragard_insertion_year", label: "Year the Paragard IUD was inserted", type: "number", section: "story", required: true, placeholder: "YYYY" },
      { key: "paragard_removal_year", label: "Year of attempted or completed removal", type: "number", section: "story", required: true, placeholder: "YYYY" },
      { key: "injury_type", label: "What injury occurred?", type: "select", section: "story", required: true, options: ["Device broke / fractured during removal", "Arms or fragments embedded in uterine wall", "Device migrated (moved from uterus)", "Perforation of uterus or nearby organ", "Failed removal requiring surgery", "Chronic pain from embedded fragments", "Multiple injuries"] },
      { key: "required_surgery", label: "Did you require surgery to remove the broken device or fragments?", type: "radio", section: "story", required: true, options: ["Yes", "No", "Scheduled"] },
      { key: "surgery_type", label: "Type of procedure required", type: "select", section: "story", required: false, options: ["Hysteroscopy", "Laparoscopy", "Laparotomy (open surgery)", "Hysterectomy (uterus removal)", "D&C", "Still in place / no procedure yet", "Other"] },
      { key: "subsequent_fertility_issues", label: "Did this injury cause fertility problems or pregnancy complications?", type: "radio", section: "story", required: false, options: ["Yes", "No", "Unknown / evaluating"] },
      { key: "treating_gynecologist", label: "Name of treating gynecologist or surgeon", type: "text", section: "story", required: false },
      { key: "treating_hospital", label: "Hospital or clinic", type: "text", section: "story", required: false },
    ]
  ),

  conf("nec",
    "NEC (Necrotizing Enterocolitis) Infant Formula Claim Review",
    "Premature infants fed cow's-milk-based formula (Enfamil, Similac) have a significantly higher risk of developing NEC. If your premature baby was harmed, you may have a claim.",
    [
      { key: "premature_infant", label: "Was the affected child born premature (before 37 weeks gestation)?", type: "radio", section: "eligibility", required: true, options: ["Yes", "No"] },
      { key: "fed_cows_milk_formula", label: "Was the premature infant fed cow's-milk-based formula (Enfamil, Similac) in the NICU or hospital?", type: "radio", section: "eligibility", required: true, options: ["Yes", "No", "Unsure — hospital provided formula"] },
      { key: "infant_diagnosed_nec", label: "Was the infant diagnosed with Necrotizing Enterocolitis (NEC)?", type: "radio", section: "eligibility", required: true, options: ["Yes", "No"] },
    ],
    [
      { id: "must_be_premature", field: "premature_infant", op: "eq", value: "No", message: "This program is for premature infants who were fed cow's-milk-based formula and developed NEC." },
      { id: "must_have_fed_formula", field: "fed_cows_milk_formula", op: "eq", value: "No", message: "Cow's-milk-based formula use in the NICU is required for this claim." },
      { id: "must_have_nec", field: "infant_diagnosed_nec", op: "eq", value: "No", message: "A NEC (Necrotizing Enterocolitis) diagnosis is required." },
    ],
    [
      { key: "claimant_relationship", label: "Your relationship to the affected infant", type: "select", section: "story", required: true, options: ["Parent (mother)", "Parent (father)", "Legal guardian", "Other legal representative"] },
      { key: "infant_gestational_age", label: "Baby's gestational age at birth (weeks)", type: "number", section: "story", required: true, placeholder: "e.g., 28" },
      { key: "formula_brand", label: "Which formula was given in the hospital/NICU?", type: "select", section: "story", required: true, options: ["Enfamil (Mead Johnson / Reckitt)", "Similac (Abbott)", "Both Enfamil and Similac", "Other cow's-milk-based formula", "Unsure — hospital provided it"] },
      { key: "nec_diagnosis_year", label: "Year the infant was diagnosed with NEC", type: "number", section: "story", required: true, placeholder: "YYYY" },
      { key: "nec_severity", label: "How severe was the NEC?", type: "select", section: "story", required: true, options: ["Stage I (mild / suspected)", "Stage II (moderate / confirmed)", "Stage III (severe / advanced, surgery required)", "Fatal — infant died from NEC"] },
      { key: "required_nec_surgery", label: "Did the infant require surgery (bowel resection) due to NEC?", type: "radio", section: "story", required: true, options: ["Yes", "No"] },
      { key: "long_term_complications", label: "Did the infant suffer long-term complications from NEC?", type: "select", section: "story", required: false, options: ["Short bowel syndrome", "Developmental delays", "Intestinal stricture", "Ostomy (colostomy/ileostomy) required", "Multiple long-term complications", "Infant passed away", "Still too early to assess", "None so far"] },
      { key: "treating_hospital", label: "Hospital / NICU where infant was treated", type: "text", section: "story", required: false },
      { key: "neonatologist_name", label: "Treating neonatologist's name (if known)", type: "text", section: "story", required: false },
    ]
  ),

  conf("zantac",
    "Zantac (Ranitidine) Cancer Claim Review",
    "Zantac and generic ranitidine medications were found to contain NDMA, a probable human carcinogen. Long-term users who developed cancer may be eligible for compensation.",
    [
      { key: "took_zantac", label: "Did you take Zantac (ranitidine) or generic ranitidine regularly?", type: "radio", section: "eligibility", required: true, options: ["Yes", "No"] },
      { key: "has_cancer", label: "Have you been diagnosed with cancer?", type: "radio", section: "eligibility", required: true, options: ["Yes", "No"] },
    ],
    [
      { id: "must_have_taken_zantac", field: "took_zantac", op: "eq", value: "No", message: "This program requires regular use of Zantac (ranitidine) or generic ranitidine." },
      { id: "must_have_cancer", field: "has_cancer", op: "eq", value: "No", message: "A cancer diagnosis is required for the Zantac program." },
    ],
    [
      { key: "zantac_prescription_or_otc", label: "Was your Zantac prescription-strength or over-the-counter?", type: "select", section: "story", required: true, options: ["Prescription (150mg or 300mg)", "OTC (regular / 75mg)", "Both at different times", "Unsure"] },
      { key: "zantac_years_used", label: "How many years did you take ranitidine?", type: "select", section: "story", required: true, options: ["Less than 1 year", "1–2 years", "3–5 years", "6–10 years", "More than 10 years"] },
      { key: "zantac_start_year", label: "Approximately what year did you start taking ranitidine?", type: "number", section: "story", required: true, placeholder: "YYYY" },
      { key: "zantac_frequency", label: "How frequently did you take Zantac?", type: "select", section: "story", required: true, options: ["Daily (every day)", "Most days", "Several times a week", "Occasionally as needed"] },
      { key: "diagnosis", label: "Cancer diagnosis", type: "select", section: "story", required: true, options: ["Bladder Cancer", "Stomach / Gastric Cancer", "Esophageal Cancer", "Liver Cancer", "Colorectal Cancer", "Kidney Cancer", "Pancreatic Cancer", "Lung Cancer", "Prostate Cancer", "Breast Cancer", "Thyroid Cancer", "Non-Hodgkin's Lymphoma", "Other"] },
      { key: "diagnosis_year", label: "Year of cancer diagnosis", type: "number", section: "story", required: true, placeholder: "YYYY" },
      { key: "treating_oncologist", label: "Treating oncologist name", type: "text", section: "story", required: false },
      { key: "treating_hospital", label: "Hospital or cancer center", type: "text", section: "story", required: false },
    ]
  ),

  conf("suboxone",
    "Suboxone Tooth Decay Claim Review",
    "Suboxone and other sublingual buprenorphine films have been linked to severe tooth decay, tooth loss, and dental damage — even in patients with no prior dental issues.",
    [
      { key: "took_suboxone", label: "Did you take Suboxone (buprenorphine/naloxone) sublingual film or strips?", type: "radio", section: "eligibility", required: true, options: ["Yes", "No"] },
      { key: "has_dental_damage", label: "Did you experience severe tooth decay, cavities, or tooth loss while on Suboxone?", type: "radio", section: "eligibility", required: true, options: ["Yes", "No"] },
    ],
    [
      { id: "must_have_taken_suboxone", field: "took_suboxone", op: "eq", value: "No", message: "This program requires use of Suboxone or buprenorphine sublingual film." },
      { id: "must_have_dental_damage", field: "has_dental_damage", op: "eq", value: "No", message: "Documented dental damage from Suboxone film is required." },
    ],
    [
      { key: "suboxone_form", label: "What form of Suboxone or buprenorphine did you take?", type: "select", section: "story", required: true, options: ["Suboxone Film (sublingual)", "Subutex (buprenorphine only, sublingual)", "Generic buprenorphine/naloxone film", "Tablet form (Suboxone tablet)", "Multiple forms at different times"] },
      { key: "suboxone_years_used", label: "How many years did you take sublingual buprenorphine?", type: "select", section: "story", required: true, options: ["Less than 1 year", "1–2 years", "3–5 years", "6–10 years", "More than 10 years"] },
      { key: "suboxone_start_year", label: "Year you started taking Suboxone", type: "number", section: "story", required: true, placeholder: "YYYY" },
      { key: "dental_damage_type", label: "What dental damage occurred?", type: "select", section: "story", required: true, options: ["Severe tooth decay / cavities in multiple teeth", "Crumbling or fracturing teeth", "Complete tooth loss (multiple extractions)", "Abscesses and infections", "Gum disease exacerbated by decay", "Need for dentures or implants", "Multiple types of damage"] },
      { key: "teeth_lost", label: "How many teeth were lost or extracted due to the decay?", type: "select", section: "story", required: false, options: ["1–2 teeth", "3–5 teeth", "6–10 teeth", "More than 10 teeth", "All or nearly all teeth", "None lost (severe decay only)"] },
      { key: "dental_damage_start_year", label: "When did dental problems begin (approximately)?", type: "number", section: "story", required: true, placeholder: "YYYY" },
      { key: "dental_costs", label: "Estimated dental treatment costs incurred", type: "select", section: "story", required: false, options: ["Under $2,000", "$2,000–$5,000", "$5,000–$15,000", "$15,000–$50,000", "Over $50,000", "Still accumulating"] },
      { key: "had_good_dental_health_before", label: "Did you have generally good dental health before starting Suboxone?", type: "radio", section: "story", required: true, options: ["Yes", "No", "Some prior issues but much worse on Suboxone"] },
      { key: "prescribing_doctor", label: "Name of prescribing doctor (MAT provider or pain specialist)", type: "text", section: "story", required: false },
      { key: "treating_dentist", label: "Name of treating dentist", type: "text", section: "story", required: false },
    ]
  ),

  conf("tepezza",
    "Tepezza Hearing Loss Claim Review",
    "Tepezza (teprotumumab), used to treat thyroid eye disease, has been linked to permanent hearing loss, tinnitus, and other ear-related complications.",
    [
      { key: "received_tepezza", label: "Did you receive Tepezza (teprotumumab) infusions?", type: "radio", section: "eligibility", required: true, options: ["Yes", "No"] },
      { key: "has_hearing_loss", label: "Did you experience hearing loss, tinnitus (ringing), or ear damage after Tepezza treatment?", type: "radio", section: "eligibility", required: true, options: ["Yes", "No"] },
    ],
    [
      { id: "must_have_tepezza", field: "received_tepezza", op: "eq", value: "No", message: "This program requires Tepezza (teprotumumab) treatment." },
      { id: "must_have_hearing_loss", field: "has_hearing_loss", op: "eq", value: "No", message: "A hearing loss or ear injury after Tepezza infusions is required." },
    ],
    [
      { key: "tepezza_infusions_count", label: "How many Tepezza infusions did you receive?", type: "select", section: "story", required: true, options: ["1–2 infusions", "3–4 infusions", "5–6 infusions (full course)", "7+ infusions (additional rounds)", "Unsure"] },
      { key: "tepezza_treatment_year", label: "Year you started Tepezza treatment", type: "number", section: "story", required: true, placeholder: "YYYY" },
      { key: "hearing_condition", label: "What hearing or ear condition developed?", type: "select", section: "story", required: true, options: ["Sensorineural hearing loss (permanent)", "Tinnitus (ringing, buzzing)", "Autophony (hearing own voice amplified)", "Eustachian tube dysfunction", "Hyperacusis (sound sensitivity)", "Multiple ear conditions"] },
      { key: "hearing_loss_severity", label: "Severity of hearing loss", type: "select", section: "story", required: false, options: ["Mild (25–40 dB)", "Moderate (41–55 dB)", "Moderately severe (56–70 dB)", "Severe (71–90 dB)", "Profound / total loss", "Tinnitus only (no measurable loss)"] },
      { key: "hearing_aids_required", label: "Do you now require hearing aids or cochlear implants?", type: "radio", section: "story", required: false, options: ["Yes", "No", "Evaluating options"] },
      { key: "tepezza_prescribing_doctor", label: "Name of prescribing ophthalmologist or endocrinologist", type: "text", section: "story", required: false },
      { key: "treating_audiologist", label: "Name of treating audiologist or ENT doctor", type: "text", section: "story", required: false },
      { key: "treating_hospital", label: "Hospital or infusion center where Tepezza was administered", type: "text", section: "story", required: false },
      { key: "hearing_permanent", label: "Has your doctor indicated the hearing loss is permanent?", type: "radio", section: "story", required: false, options: ["Yes", "No", "Still evaluating"] },
    ]
  ),

  conf("tylenol",
    "Tylenol Autism / ADHD Prenatal Claim Review",
    "Research suggests a link between prenatal acetaminophen (Tylenol) use and autism spectrum disorder (ASD) or ADHD in children. Parents may have a claim against the manufacturers.",
    [
      { key: "took_tylenol_pregnant", label: "Did you take Tylenol (acetaminophen) during pregnancy?", type: "radio", section: "eligibility", required: true, options: ["Yes", "No", "Unsure — taken under various brand names"] },
      { key: "child_has_asd_adhd", label: "Was your child diagnosed with autism spectrum disorder (ASD) or ADHD?", type: "radio", section: "eligibility", required: true, options: ["Yes", "No"] },
    ],
    [
      { id: "must_have_taken_tylenol_pregnant", field: "took_tylenol_pregnant", op: "eq", value: "No", message: "This program requires prenatal use of acetaminophen (Tylenol) during pregnancy." },
      { id: "must_have_child_diagnosis", field: "child_has_asd_adhd", op: "eq", value: "No", message: "A child's ASD or ADHD diagnosis is required for the Tylenol prenatal program." },
    ],
    [
      { key: "acetaminophen_trimester", label: "During which trimester(s) was acetaminophen taken?", type: "select", section: "story", required: true, options: ["First trimester only", "Second trimester only", "Third trimester only", "First and second trimesters", "Second and third trimesters", "All three trimesters", "Throughout most of pregnancy"] },
      { key: "acetaminophen_frequency_pregnancy", label: "How frequently was it taken during pregnancy?", type: "select", section: "story", required: true, options: ["Daily or near-daily", "Several times a week", "Weekly", "Occasionally (a few times total)"] },
      { key: "acetaminophen_brand", label: "What brand or form was used?", type: "select", section: "story", required: false, options: ["Tylenol (brand name)", "Generic acetaminophen / paracetamol", "Percocet / opioid combo with acetaminophen", "NyQuil / DayQuil (contain acetaminophen)", "Multiple products"] },
      { key: "child_diagnosis", label: "Child's diagnosis", type: "select", section: "story", required: true, options: ["Autism Spectrum Disorder (ASD)", "ADHD (Attention Deficit Hyperactivity Disorder)", "Both ASD and ADHD", "ASD with intellectual disability", "Other neurodevelopmental disorder"] },
      { key: "child_diagnosis_year", label: "Year child was diagnosed", type: "number", section: "story", required: true, placeholder: "YYYY" },
      { key: "child_age_at_diagnosis", label: "Child's age at diagnosis", type: "number", section: "story", required: false, placeholder: "Age" },
      { key: "child_current_age", label: "Child's current age", type: "number", section: "story", required: false, placeholder: "Age" },
      { key: "child_receiving_therapy", label: "Is the child currently receiving therapy or special education services?", type: "radio", section: "story", required: false, options: ["Yes", "No"] },
      { key: "treating_pediatrician", label: "Name of diagnosing pediatrician or specialist", type: "text", section: "story", required: false },
      { key: "ob_gyn", label: "Name of OB/GYN during pregnancy", type: "text", section: "story", required: false },
      { key: "child_medical_records_available", label: "Do you have medical records documenting the child's diagnosis?", type: "radio", section: "story", required: false, options: ["Yes", "No", "Working on obtaining them"] },
    ]
  ),

  conf("autonomous-vehicles",
    "Autonomous Vehicle Accident Claim Review",
    "Accidents involving self-driving or driver-assist technology (Tesla Autopilot, Waymo, Cruise, Uber AV) may qualify for injury claims against the manufacturer or operator.",
    [
      { key: "av_accident_involved", label: "Were you involved in an accident where a vehicle was using autonomous or driver-assist technology?", type: "radio", section: "eligibility", required: true, options: ["Yes", "No"] },
      { key: "suffered_injury", label: "Did you suffer physical injuries in the accident?", type: "radio", section: "eligibility", required: true, options: ["Yes", "No"] },
    ],
    [
      { id: "must_have_av_accident", field: "av_accident_involved", op: "eq", value: "No", message: "This program requires involvement in an accident where autonomous or driver-assist technology was active." },
      { id: "must_have_injury", field: "suffered_injury", op: "eq", value: "No", message: "Physical injury from the autonomous vehicle accident is required." },
    ],
    [
      { key: "av_technology", label: "What autonomous or driver-assist technology was involved?", type: "select", section: "story", required: true, options: ["Tesla Autopilot / Full Self-Driving (FSD)", "Tesla Automatic Emergency Braking", "Waymo (Google)", "Cruise (GM)", "Uber / Lyft AV program", "GM SuperCruise", "Ford BlueCruise", "Other ADAS / driver-assist system", "Unsure — investigating"] },
      { key: "av_role_in_accident", label: "What was your role in the accident?", type: "select", section: "story", required: true, options: ["Driver of the AV-equipped vehicle", "Passenger in the AV-equipped vehicle", "Driver of another vehicle struck by AV", "Pedestrian struck by AV vehicle", "Cyclist struck by AV vehicle", "Other"] },
      { key: "accident_year", label: "Year of the accident", type: "number", section: "story", required: true, placeholder: "YYYY" },
      { key: "accident_state", label: "State where the accident occurred", type: "state", section: "story", required: true },
      { key: "police_report_filed", label: "Was a police report filed?", type: "radio", section: "story", required: true, options: ["Yes", "No"] },
      { key: "injury_type", label: "What injuries did you sustain?", type: "select", section: "story", required: true, options: ["Traumatic Brain Injury (TBI)", "Spinal cord injury", "Broken bones / fractures", "Soft tissue / whiplash", "Burn injuries", "Internal organ damage", "Wrongful death (filing on behalf of deceased)", "Multiple serious injuries"] },
      { key: "hospitalized_for_injuries", label: "Were you hospitalized for your injuries?", type: "radio", section: "story", required: true, options: ["Yes", "No"] },
      { key: "treating_hospital", label: "Hospital where you were treated", type: "text", section: "story", required: false },
      { key: "had_prior_insurance_claim", label: "Have you filed an auto insurance claim related to this accident?", type: "radio", section: "story", required: false, options: ["Yes", "No", "In process"] },
    ]
  ),

  conf("delivery-injury",
    "Delivery Platform Worker Injury Claim Review",
    "Gig delivery workers (DoorDash, Uber Eats, Instacart, Amazon Flex, etc.) injured on the job may have claims beyond standard workers' comp due to contractor misclassification.",
    [
      { key: "was_gig_delivery_worker", label: "Were you working as a gig/contractor delivery driver for a delivery app?", type: "radio", section: "eligibility", required: true, options: ["Yes", "No"] },
      { key: "injured_while_delivering", label: "Were you injured while actively making deliveries?", type: "radio", section: "eligibility", required: true, options: ["Yes", "No"] },
    ],
    [
      { id: "must_be_gig_worker", field: "was_gig_delivery_worker", op: "eq", value: "No", message: "This program is for gig economy delivery workers injured on the job." },
      { id: "must_be_injured", field: "injured_while_delivering", op: "eq", value: "No", message: "An injury sustained while making deliveries is required." },
    ],
    [
      { key: "delivery_platform", label: "Which platform were you working for at the time of injury?", type: "select", section: "story", required: true, options: ["DoorDash", "Uber Eats", "Instacart", "Amazon Flex", "Grubhub", "Postmates", "Shipt", "Multiple platforms", "Other"] },
      { key: "how_long_working", label: "How long had you been working for this platform?", type: "select", section: "story", required: true, options: ["Less than 1 month", "1–3 months", "4–6 months", "7–12 months", "1–2 years", "More than 2 years"] },
      { key: "injury_type", label: "How were you injured?", type: "select", section: "story", required: true, options: ["Vehicle accident while driving", "Struck by another vehicle", "Slip and fall at delivery location", "Assault during delivery", "Bicycle accident", "Motorcycle accident", "Repetitive strain / overuse injury", "Dog bite / animal attack", "Other"] },
      { key: "injury_year", label: "Year of injury", type: "number", section: "story", required: true, placeholder: "YYYY" },
      { key: "injury_severity", label: "Injury severity", type: "select", section: "story", required: true, options: ["Required ER visit / urgent care", "Required hospitalization", "Required surgery", "Permanent disability or impairment", "Missed significant work time", "Ongoing chronic pain"] },
      { key: "platform_workers_comp", label: "Did the platform provide workers' compensation or any injury coverage?", type: "radio", section: "story", required: true, options: ["Yes", "No — denied coverage as contractor", "No — never offered any", "Partially covered"] },
      { key: "treating_hospital", label: "Hospital or clinic where treated", type: "text", section: "story", required: false },
    ]
  ),

  conf("rideshare-assault",
    "Uber / Lyft Sexual Assault Claim Review",
    "Uber and Lyft have faced thousands of sexual assault allegations against their drivers. If you were assaulted during a rideshare trip, you may have a legal claim against the company.",
    [
      { key: "assaulted_during_rideshare", label: "Were you sexually assaulted or harassed during or in connection with an Uber or Lyft ride?", type: "radio", section: "eligibility", required: true, options: ["Yes", "No"] },
      { key: "assault_within_sol", label: "Did the assault occur within the last 10 years?", type: "radio", section: "eligibility", required: true, options: ["Yes", "No", "Unsure"] },
    ],
    [
      { id: "must_have_assault", field: "assaulted_during_rideshare", op: "eq", value: "No", message: "This program is for survivors of sexual assault or harassment during a rideshare trip." },
      { id: "must_be_within_sol", field: "assault_within_sol", op: "eq", value: "No", message: "Due to statutes of limitations, we typically need incidents within the last 10 years. Please consult a local attorney for older incidents." },
    ],
    [
      { key: "rideshare_platform", label: "Which rideshare platform was involved?", type: "select", section: "story", required: true, options: ["Uber", "Lyft", "Both Uber and Lyft (separate incidents)", "Other rideshare platform"] },
      { key: "assault_year", label: "Approximately what year did the assault occur?", type: "number", section: "story", required: true, placeholder: "YYYY" },
      { key: "assault_state", label: "State where the assault occurred", type: "state", section: "story", required: true },
      { key: "reported_to_platform", label: "Did you report the assault to Uber or Lyft?", type: "radio", section: "story", required: true, options: ["Yes", "No", "Tried but received no meaningful response"] },
      { key: "reported_to_police", label: "Did you report the assault to law enforcement?", type: "radio", section: "story", required: false, options: ["Yes — criminal charges filed", "Yes — reported but no charges", "No", "Prefer not to share"] },
      { key: "attacker_identified", label: "Was the driver identified or is their information available through the app?", type: "radio", section: "story", required: false, options: ["Yes", "No", "Unsure"] },
      { key: "received_medical_care", label: "Did you receive medical or counseling care related to the assault?", type: "radio", section: "story", required: false, options: ["Yes", "No"] },
      { key: "treating_provider", label: "Name of treating therapist, hospital, or crisis center (if comfortable sharing)", type: "text", section: "story", required: false },
      { key: "have_trip_receipt", label: "Do you have the ride receipt or trip confirmation showing the date and driver?", type: "radio", section: "story", required: false, options: ["Yes", "No", "Can look it up in the app"] },
    ]
  ),

  conf("industrial-water",
    "Industrial Water Contamination Claim Review",
    "Communities near industrial sites, military bases, or landfills may have been exposed to PFAS, TCE, PCE, or other toxic chemicals through contaminated drinking water.",
    [
      { key: "drank_contaminated_water", label: "Did you live, work, or attend school in an area with a known water contamination issue?", type: "radio", section: "eligibility", required: true, options: ["Yes", "No", "Unsure"] },
      { key: "has_health_condition", label: "Have you been diagnosed with a serious illness that may be linked to the contamination?", type: "radio", section: "eligibility", required: true, options: ["Yes", "No"] },
    ],
    [
      { id: "must_have_exposure", field: "drank_contaminated_water", op: "eq", value: "No", message: "This program requires residence or work in an area with documented water contamination." },
      { id: "must_have_illness", field: "has_health_condition", op: "eq", value: "No", message: "A health condition linked to water contamination is required." },
    ],
    [
      { key: "contamination_source", label: "What was the primary source or type of contamination?", type: "select", section: "story", required: true, options: ["PFAS / PFOA / PFOS (firefighting foam, industrial)", "TCE or PCE (dry cleaning, manufacturing solvents)", "Chromium-6 (industrial discharge)", "Lead from pipes or industrial site", "Benzene or petroleum products", "Agricultural runoff (pesticides, nitrates)", "Military base contamination (Camp Lejeune or other)", "Landfill / Superfund site leaching", "Multiple contaminants / unsure"] },
      { key: "contamination_city_state", label: "City or county and state where the contamination occurred", type: "text", section: "story", required: true, placeholder: "e.g., Flint, MI or Wilmington, NC" },
      { key: "years_of_exposure", label: "How many years were you exposed to the contaminated water?", type: "select", section: "story", required: true, options: ["Less than 1 year", "1–3 years", "4–9 years", "10–19 years", "20+ years"] },
      { key: "exposure_start_year", label: "Year exposure began", type: "number", section: "story", required: true, placeholder: "YYYY" },
      { key: "notified_of_contamination", label: "Were you ever officially notified of the contamination?", type: "radio", section: "story", required: false, options: ["Yes — by government or utility", "Yes — through news or community group", "No — found out independently", "Still unresolved / unclear"] },
      { key: "diagnosis", label: "What health condition or illness have you developed?", type: "select", section: "story", required: true, options: ["Kidney Cancer", "Bladder Cancer", "Thyroid Cancer", "Liver Cancer / disease", "Testicular Cancer", "Non-Hodgkin's Lymphoma", "Parkinson's Disease", "Ulcerative Colitis / Crohn's Disease", "Thyroid disease (non-cancer)", "PFAS-related immune disorder", "Neurological disorder", "Birth defects / developmental issues (child)", "Miscarriage / stillbirth", "Other serious illness"] },
      { key: "diagnosis_year", label: "Year of diagnosis", type: "number", section: "story", required: true, placeholder: "YYYY" },
      { key: "treating_doctor", label: "Treating physician name", type: "text", section: "story", required: false },
      { key: "treating_hospital", label: "Hospital or clinic", type: "text", section: "story", required: false },
    ]
  ),

] as [string, WebFormConfig][]);

// ─────────────────────────────────────────────────────────────────────────
// CRM-VISIBLE CUSTOM FIELDS (operator-side)
// ─────────────────────────────────────────────────────────────────────────
// These are surfaced as blue-tinted badges in the Form Engine card grid.
// Each tort's set = universal anti-fraud probes + 4-6 tort-specific
// qualifying questions distilled from the web form's story section.

const UNIVERSAL_CUSTOM_FIELDS: CustomField[] = [
  { key: "claimant_is_self", label: "Claimant is the injured party", type: "select", required: true, options: ["Self", "Parent/Guardian of minor", "Next of kin (decedent)", "Power of Attorney", "Other"], helper_text: "Only the injured party or a legal representative may sign retainer documents." },
  { key: "prior_lawsuit_disclosure", label: "Prior similar lawsuit filed", type: "select", required: true, options: ["No", "Yes — dismissed", "Yes — settled"], helper_text: "Required for SOL/res-judicata analysis." },
  { key: "prior_settlement_disclosure", label: "Prior settlement received for this injury", type: "select", required: true, options: ["No", "Yes — partial", "Yes — full release signed"], helper_text: "A signed full release typically forecloses a new claim." },
  { key: "hipaa_release_signed", label: "HIPAA medical-records release signed", type: "select", required: true, options: ["Yes", "Sent — awaiting signature", "Declined"], helper_text: "Required before sub-contracting record retrieval." },
  { key: "identity_verified", label: "Identity verified (ID + DOB match)", type: "select", required: false, options: ["Verified", "Pending", "Mismatch — flagged"], helper_text: "Compare DOB and last 4 SSN against state ID." },
  { key: "ssn_last_four", label: "Last 4 of SSN (operator entry)", type: "text", required: false, max_length: 4, placeholder: "1234" },
  { key: "preferred_contact_time", label: "Preferred call time", type: "select", required: false, options: ["Morning", "Afternoon", "Evening", "Anytime"] },
  { key: "preferred_language", label: "Preferred language", type: "select", required: false, options: ["English", "Español", "Português", "Other"] },
  { key: "lead_source_attestation", label: "Lead source claimed by intake", type: "select", required: false, options: ["Web search", "TV", "Social", "Referral - friend", "Referral - attorney", "Direct mail", "Other"], helper_text: "Compare against vendor attribution to detect lead resale fraud." },
  { key: "truthful_attestation_signed", label: "Sworn truthful-attestation signed", type: "checkbox", required: true, helper_text: "Penalty-of-perjury checkbox on intake form." },
];

// Per-tort additional qualifying questions surfaced on the operator card.
// These mirror the most case-critical fields from each web form's story
// section and act as cheap proxies the case manager can verify on the call.
const TORT_SPECIFIC_CUSTOM_FIELDS: Record<string, CustomField[]> = {
  "roundup": [
    { key: "roundup_use_setting", label: "Roundup use setting", type: "select", required: true, options: ["Residential", "Agricultural", "Professional landscaping", "Golf/park", "Municipal", "Other"] },
    { key: "roundup_years_used", label: "Years of Roundup use", type: "select", required: true, options: ["<1", "1-2", "3-5", "6-10", "10+"] },
    { key: "roundup_first_use_year", label: "First-use year", type: "number", required: true, placeholder: "YYYY" },
    { key: "ppe_used", label: "Used protective gear consistently", type: "select", required: false, options: ["Yes", "Sometimes", "No"] },
    { key: "nhl_subtype", label: "NHL subtype confirmed by pathology", type: "select", required: false, options: ["DLBCL", "Follicular", "Marginal Zone", "T-Cell", "Hairy Cell", "CLL", "Multiple Myeloma", "Other / TBD"] },
    { key: "treating_oncologist", label: "Treating oncologist", type: "text", required: false },
  ],
  "talcum-powder": [
    { key: "talc_brand_primary", label: "Primary talc brand used", type: "select", required: true, options: ["Johnson's Baby Powder", "Shower to Shower", "Both", "Other talc", "Multiple"] },
    { key: "talc_years_used", label: "Years of perineal talc use", type: "select", required: true, options: ["<1", "1-4", "5-9", "10-19", "20+"] },
    { key: "talc_diagnosis_specific", label: "Specific diagnosis", type: "select", required: true, options: ["Epithelial Ovarian", "Fallopian Tube", "Primary Peritoneal", "Endometrial", "Mesothelioma", "Other"] },
    { key: "talc_stage_at_dx", label: "Stage at diagnosis", type: "select", required: false, options: ["I", "II", "III", "IV", "Unknown"] },
    { key: "talc_hysterectomy", label: "Hysterectomy / oophorectomy performed", type: "select", required: false, options: ["Yes", "No"] },
  ],
  "camp-lejeune": [
    { key: "lejeune_role", label: "Role at Camp Lejeune", type: "select", required: true, options: ["Active duty", "Civilian employee", "Family member", "Reservist/NG", "Other"] },
    { key: "lejeune_dates", label: "Years present (e.g. 1972-1975)", type: "text", required: true, placeholder: "1972-1975" },
    { key: "lejeune_total_days", label: "Estimated days on base", type: "select", required: true, options: ["30-90", "3-6 mo", "6-12 mo", "1-3 yr", "3+ yr"] },
    { key: "lejeune_va_claim_status", label: "VA disability claim status", type: "select", required: false, options: ["Approved", "Denied", "Pending", "None filed"] },
    { key: "lejeune_records_available", label: "Military records confirming presence", type: "select", required: false, options: ["Yes", "Obtaining", "No"] },
  ],
  "afff": [
    { key: "afff_role", label: "AFFF exposure role", type: "select", required: true, options: ["Military firefighter", "Airport firefighter", "Municipal firefighter", "Industrial firefighter", "Navy shipboard", "Aviation crew", "Base resident", "Other"] },
    { key: "afff_years_exposed", label: "Years exposed", type: "select", required: true, options: ["<1", "1-3", "4-9", "10-19", "20+"] },
    { key: "afff_first_exposure_year", label: "First-exposure year", type: "number", required: true, placeholder: "YYYY" },
    { key: "afff_cancer_dx", label: "Cancer diagnosis", type: "select", required: true, options: ["Kidney", "Testicular", "Bladder", "Prostate", "Thyroid", "Pancreatic", "Liver", "Breast", "Colon/Rectal", "NHL", "Leukemia", "Ulcerative Colitis", "Other"] },
    { key: "afff_service_records", label: "Service / employment records", type: "select", required: false, options: ["Yes", "Obtaining", "No"] },
  ],
  "paraquat": [
    { key: "paraquat_role", label: "Paraquat exposure role", type: "select", required: true, options: ["Farmworker", "Farmer (self)", "Landscaper", "Golf course", "Vineyard/orchard", "Lived near treated fields", "Mixed/applied professionally", "Other"] },
    { key: "paraquat_years", label: "Years exposed", type: "select", required: true, options: ["<1", "1-3", "4-9", "10-19", "20+"] },
    { key: "paraquat_ppe_use", label: "PPE used consistently", type: "select", required: false, options: ["Always", "Sometimes", "Rarely"] },
    { key: "parkinsons_dx_year", label: "Parkinson's diagnosis year", type: "number", required: true, placeholder: "YYYY" },
    { key: "on_parkinsons_meds", label: "Currently on Parkinson's medications", type: "select", required: false, options: ["Yes", "No"] },
    { key: "treating_neurologist", label: "Treating neurologist", type: "text", required: false },
  ],
  "hair-relaxer": [
    { key: "relaxer_brand_primary", label: "Primary relaxer brand", type: "select", required: true, options: ["Dark & Lovely", "Just for Me", "ORS Olive Oil", "Motions", "Soft & Beautiful", "Revlon Realistic", "PCJ", "Affirm", "Multiple/store", "Other"] },
    { key: "relaxer_years", label: "Years of regular use", type: "select", required: true, options: ["<1", "1-4", "5-9", "10-14", "15-19", "20+"] },
    { key: "relaxer_start_age", label: "Age started using relaxers", type: "number", required: true, placeholder: "Age" },
    { key: "relaxer_dx", label: "Diagnosis", type: "select", required: true, options: ["Uterine/Endometrial Cancer", "Fibroids req. surgery", "Ovarian Cancer", "Other gyn condition"] },
    { key: "relaxer_procedure", label: "Procedure required", type: "select", required: false, options: ["Hysterectomy", "Myomectomy", "Endometrial ablation", "UAE", "Cancer surgery", "Chemo/radiation", "Other"] },
  ],
  "depo-provera": [
    { key: "depo_duration", label: "Duration of Depo use", type: "select", required: true, options: ["<1 yr", "1-2 yr", "3-4 yr", "5-9 yr", "10+ yr"] },
    { key: "depo_total_injections", label: "Approx total injections", type: "select", required: false, options: ["1-4", "5-12", "13-24", "25-48", "48+", "Unsure"] },
    { key: "tumor_type", label: "Tumor classification", type: "select", required: true, options: ["Meningioma (benign)", "Atypical / Grade II", "Malignant / Grade III", "Other brain tumor", "Pending pathology"] },
    { key: "tumor_dx_year", label: "Tumor diagnosis year", type: "number", required: true, placeholder: "YYYY" },
    { key: "required_craniotomy", label: "Brain surgery required", type: "select", required: true, options: ["Yes", "Scheduled", "No"] },
    { key: "treating_neurosurgeon", label: "Treating neurosurgeon", type: "text", required: false },
  ],
  "glp1": [
    { key: "glp1_drug", label: "GLP-1 drug taken", type: "select", required: true, options: ["Ozempic", "Wegovy", "Mounjaro", "Zepbound", "Saxenda", "Rybelsus/Victoza", "Multiple"] },
    { key: "glp1_indication", label: "Prescribed for", type: "select", required: true, options: ["Type 2 diabetes", "Weight loss", "Both", "Off-label"] },
    { key: "glp1_duration", label: "Duration on drug", type: "select", required: true, options: ["<1mo", "1-3mo", "4-6mo", "7-12mo", "1-2yr", "2+yr"] },
    { key: "glp1_injury_primary", label: "Primary injury", type: "select", required: true, options: ["Gastroparesis", "Bowel obstruction/ileus", "Aspiration", "Severe vomiting", "Pancreatitis", "Severe dehydration", "Bezoar", "Other"] },
    { key: "glp1_hospitalized", label: "Hospitalized for injury", type: "select", required: true, options: ["Yes", "No"] },
    { key: "prescribing_doctor", label: "Prescribing doctor", type: "text", required: false },
  ],
  "ozempic": [
    { key: "ozempic_drug", label: "Drug taken", type: "select", required: true, options: ["Ozempic", "Wegovy", "Mounjaro", "Zepbound", "Rybelsus", "Saxenda", "Victoza", "Multiple"] },
    { key: "ozempic_indication", label: "Prescribed for", type: "select", required: true, options: ["Diabetes", "Weight loss", "Both", "Off-label"] },
    { key: "ozempic_duration", label: "Duration on drug", type: "select", required: true, options: ["<1mo", "1-3mo", "4-6mo", "7-12mo", "1+yr"] },
    { key: "ozempic_injury", label: "Primary injury", type: "select", required: true, options: ["Gastroparesis", "Bowel obstruction", "Aspiration", "Severe vomiting", "Bezoar", "Pancreatitis", "Severe dehydration", "NAION/vision loss", "Other"] },
    { key: "ozempic_er_visit", label: "ER visit / hospitalization", type: "select", required: true, options: ["Yes", "No"] },
    { key: "ozempic_procedure", label: "Procedure required", type: "select", required: false, options: ["Yes", "No"] },
  ],
  "social-media": [
    { key: "social_claimant_type", label: "Claimant type", type: "select", required: true, options: ["Self (now 18+)", "Parent of minor", "Parent of adult-child harmed as minor"] },
    { key: "social_platform_primary", label: "Primary platform", type: "select", required: true, options: ["Instagram", "TikTok", "Facebook", "Snapchat", "YouTube", "Multiple", "All major"] },
    { key: "social_age_started", label: "Age regular use began", type: "number", required: true, placeholder: "Age" },
    { key: "social_peak_hours_day", label: "Peak hours per day", type: "select", required: true, options: ["1-2", "3-4", "5-6", "7-8", "8+"] },
    { key: "social_diagnosis", label: "Mental health diagnosis", type: "select", required: true, options: ["Depression", "Anxiety", "Eating disorder", "Body dysmorphia", "PTSD", "Self-harm", "Suicide attempt", "Multiple"] },
    { key: "social_hospitalized", label: "Psychiatric hospitalization", type: "select", required: true, options: ["Yes", "No"] },
  ],
  "roblox": [
    { key: "child_age_at_incident", label: "Child's age when harm began", type: "number", required: true, placeholder: "Age" },
    { key: "incident_year", label: "Incident year", type: "number", required: true, placeholder: "YYYY" },
    { key: "harm_nature", label: "Nature of harm", type: "select", required: true, options: ["Grooming by stranger", "Sexual solicitation in chat", "Image/video exploitation", "In-person meet arranged", "Financial exploitation", "Cyberbullying", "Multiple"] },
    { key: "reported_to_le", label: "Reported to law enforcement", type: "select", required: true, options: ["Yes - case opened", "Yes - no prosecution", "No", "In process"] },
    { key: "child_in_therapy", label: "Child in therapy", type: "select", required: false, options: ["Yes", "Recently started", "No"] },
    { key: "reported_to_roblox", label: "Reported to Roblox", type: "select", required: false, options: ["Yes - no action", "Yes - acted", "No"] },
  ],
  "online-gaming": [
    { key: "gaming_platform", label: "Primary platform", type: "select", required: true, options: ["Xbox Live", "PSN", "Steam", "Epic/Fortnite", "Activision/COD", "Riot", "Multiple", "Other"] },
    { key: "gaming_hours_day", label: "Peak hours/day", type: "select", required: true, options: ["2-4", "5-6", "7-9", "10-12", "12+"] },
    { key: "gaming_harm_type", label: "Harm type", type: "select", required: true, options: ["Gaming addiction", "Loot-box exploitation", "Sexual exploitation", "Cyberbullying", "Physical health decline", "Academic/work failure", "Multiple"] },
    { key: "gaming_diagnosis", label: "Diagnosis", type: "select", required: false, options: ["IGD", "Depression", "Anxiety", "ADHD exacerbated", "Sleep disorder", "None yet", "Other"] },
    { key: "gaming_spend_total", label: "In-game purchase total", type: "select", required: false, options: ["<$500", "$500-2k", "$2k-10k", "$10k-50k", "$50k+"] },
  ],
  "asbestos": [
    { key: "asbestos_industry", label: "Exposure industry", type: "select", required: true, options: ["Shipbuilding/Navy", "Construction", "Auto/mechanic", "Manufacturing", "Railroad", "Power plant", "Military", "Insulation/pipe", "Mining", "Firefighting", "Other"] },
    { key: "asbestos_first_exposure_year", label: "First-exposure year", type: "number", required: true, placeholder: "YYYY" },
    { key: "asbestos_total_years", label: "Total exposure years", type: "select", required: true, options: ["<1", "1-4", "5-9", "10-19", "20+"] },
    { key: "asbestos_dx", label: "Diagnosis", type: "select", required: true, options: ["Mesothelioma (pleural)", "Mesothelioma (peritoneal)", "Mesothelioma (pericardial)", "Lung cancer (asbestos)", "Asbestosis", "Pleural plaques", "Other"] },
    { key: "asbestos_dx_year", label: "Diagnosis year", type: "number", required: true, placeholder: "YYYY" },
    { key: "asbestos_trust_claim", label: "Asbestos trust claim filed", type: "select", required: true, options: ["Yes", "No", "In process"] },
  ],
  "benzene": [
    { key: "benzene_industry", label: "Exposure industry", type: "select", required: true, options: ["Oil refinery", "Gas station", "Petrochemical", "Chemical mfg", "Rubber/tire", "Printing", "Dry cleaning", "Auto/mechanic", "Shoe/leather", "Military fuel", "Pipeline", "Other"] },
    { key: "benzene_years", label: "Exposure years", type: "select", required: true, options: ["<1", "1-4", "5-9", "10-19", "20+"] },
    { key: "benzene_first_year", label: "First-exposure year", type: "number", required: true, placeholder: "YYYY" },
    { key: "benzene_dx", label: "Diagnosis", type: "select", required: true, options: ["AML", "CML", "ALL", "CLL", "MDS", "NHL", "Hodgkin", "Multiple Myeloma", "Aplastic Anemia", "Other"] },
    { key: "benzene_dx_year", label: "Diagnosis year", type: "number", required: true, placeholder: "YYYY" },
    { key: "benzene_employer", label: "Primary employer (exposure period)", type: "text", required: false },
  ],
  "cpap": [
    { key: "cpap_brand_model", label: "CPAP device brand/model", type: "select", required: true, options: ["Philips DreamStation 1", "Philips DreamStation Go", "Philips System One", "Philips REMstar", "Philips Trilogy", "Philips A-Series BiPAP", "Other Philips", "Unsure"] },
    { key: "cpap_years_used", label: "Years of use", type: "select", required: true, options: ["<1", "1-2", "3-5", "6-10", "10+"] },
    { key: "cpap_first_use_year", label: "First-use year", type: "number", required: true, placeholder: "YYYY" },
    { key: "cpap_dx", label: "Diagnosis", type: "select", required: true, options: ["Lung cancer", "Respiratory injury/ARDS", "Kidney cancer", "Liver cancer", "Nasal/sinus cancer", "Bladder cancer", "Foam ingestion injury", "Thyroid", "Other"] },
    { key: "cpap_dx_year", label: "Diagnosis year", type: "number", required: true, placeholder: "YYYY" },
    { key: "cpap_records_available", label: "Device purchase/Rx records", type: "select", required: false, options: ["Yes", "Maybe", "No"] },
  ],
  "philips-cpap": [
    { key: "philips_model", label: "Philips model", type: "select", required: true, options: ["DreamStation 1 (DSX500)", "DreamStation Go (DSX200)", "System One", "Trilogy Evo", "A-Series BiPAP", "C-Series ASV", "Other", "Unsure"] },
    { key: "philips_years_used", label: "Years used", type: "select", required: true, options: ["<1", "1-2", "3-4", "5-7", "8-10", "10+"] },
    { key: "philips_start_year", label: "Start year", type: "number", required: true, placeholder: "YYYY" },
    { key: "philips_ozone", label: "Used ozone cleaner (SoClean etc.)", type: "select", required: true, options: ["Yes", "No", "Unsure"] },
    { key: "philips_dx", label: "Diagnosis", type: "select", required: true, options: ["Lung cancer", "Respiratory/ARDS", "Kidney cancer", "Liver cancer", "Nasal/sinus cancer", "Bladder cancer", "Throat/laryngeal cancer", "Thyroid", "Toxic inhalation", "Other"] },
    { key: "philips_recall_registered", label: "Submitted Philips recall registration", type: "select", required: false, options: ["Yes", "In process", "No"] },
  ],
  "hernia-mesh": [
    { key: "hernia_type", label: "Hernia type repaired", type: "select", required: true, options: ["Inguinal", "Femoral", "Umbilical", "Incisional", "Hiatal", "Ventral", "Multiple", "Unsure"] },
    { key: "mesh_brand", label: "Mesh brand (if known)", type: "select", required: false, options: ["Bard/Davol", "Ethicon/J&J", "Atrium C-QUR", "Gore-Tex", "Mentor/Allergan", "Herniamesh", "Unsure"] },
    { key: "mesh_surgery_year", label: "Implant year", type: "number", required: true, placeholder: "YYYY" },
    { key: "mesh_complication", label: "Complication", type: "select", required: true, options: ["Chronic pain", "Migration", "Infection", "Recurrence", "Bowel obstruction/perforation", "Fistula", "Adhesion/organ damage", "Shrinkage", "Multiple"] },
    { key: "revision_surgery", label: "Revision surgery required", type: "select", required: true, options: ["Yes", "Scheduled", "No"] },
    { key: "implanting_surgeon", label: "Implanting surgeon", type: "text", required: false },
  ],
  "hip-implants": [
    { key: "hip_brand", label: "Hip implant brand", type: "select", required: false, options: ["DePuy ASR", "DePuy Pinnacle", "Stryker Rejuvenate/ABG II", "Stryker LFIT V40", "Wright Conserve/Profemur", "Biomet M2a-Magnum", "Smith & Nephew BHR/R3", "Zimmer Durom/M/L Taper", "Other MoM", "Unsure"] },
    { key: "hip_implant_year", label: "Implant year", type: "number", required: true, placeholder: "YYYY" },
    { key: "hip_complication", label: "Complication", type: "select", required: true, options: ["Metallosis", "Loosening", "Component fracture", "Tissue/bone damage", "Chronic pain", "Dislocation", "Modular junction corrosion", "Urgent revision", "Multiple"] },
    { key: "hip_revision_status", label: "Revision surgery status", type: "select", required: true, options: ["Completed", "Scheduled", "Recommended", "No"] },
    { key: "cobalt_chromium_test", label: "Co/Cr blood levels tested", type: "select", required: false, options: ["Elevated", "Normal", "Not tested", "Pending"] },
  ],
  "ivc-filters": [
    { key: "ivc_brand", label: "IVC filter brand", type: "select", required: false, options: ["Bard Recovery/G2/Eclipse", "Bard Meridian/Denali", "Cook Celect/Tulip", "Cordis OptEase/TrapEase", "ALN", "Argon Option", "Rex Medical", "Other/unsure"] },
    { key: "ivc_implant_year", label: "Implant year", type: "number", required: true, placeholder: "YYYY" },
    { key: "ivc_filter_type", label: "Filter type", type: "select", required: true, options: ["Retrievable", "Permanent", "Unsure"] },
    { key: "ivc_retrieved", label: "Filter retrieved", type: "select", required: false, options: ["Yes", "Still in place", "Failed retrieval"] },
    { key: "ivc_complication", label: "Complication", type: "select", required: true, options: ["Fracture", "Migration", "Perforation", "DVT worsened", "PE while in place", "Chest/abdominal pain", "Chronic back/groin pain", "Multiple"] },
    { key: "ivc_complication_year", label: "Complication discovery year", type: "number", required: true, placeholder: "YYYY" },
  ],
  "bard-powerport": [
    { key: "powerport_implant_year", label: "Port implant year", type: "number", required: true, placeholder: "YYYY" },
    { key: "powerport_reason", label: "Reason for port", type: "select", required: true, options: ["Chemo", "Frequent IV/infusions", "Antibiotics", "Blood draws/dialysis", "TPN", "Other"] },
    { key: "powerport_complication", label: "Complication", type: "select", required: true, options: ["Catheter fracture", "Catheter migration", "Arrhythmia from fragment", "Port infection/sepsis", "Thrombosis", "Local tissue damage", "Device failure", "Multiple"] },
    { key: "powerport_complication_year", label: "Complication year", type: "number", required: true, placeholder: "YYYY" },
    { key: "powerport_removal_surgery", label: "Removal/emergency procedure", type: "select", required: true, options: ["Yes", "Attempted", "No"] },
  ],
  "exactech": [
    { key: "exactech_joint", label: "Joint replaced", type: "select", required: true, options: ["Knee (Optetrak/Logic/Truliant)", "Hip", "Ankle (Vantage)", "Multiple"] },
    { key: "exactech_implant_year", label: "Implant year", type: "number", required: true, placeholder: "YYYY" },
    { key: "exactech_complication", label: "Complication", type: "select", required: true, options: ["Premature wear", "Loosening", "Severe pain", "Limited ROM", "Swelling/inflammation", "Fracture/failure", "Revision required"] },
    { key: "exactech_revision_status", label: "Revision surgery status", type: "select", required: true, options: ["Completed", "Scheduled", "Recommended (postponed)", "No"] },
    { key: "exactech_recall_notified", label: "Recall notification received", type: "select", required: false, options: ["Yes", "No", "Unsure"] },
  ],
  "paragard": [
    { key: "paragard_insertion_year", label: "Paragard insertion year", type: "number", required: true, placeholder: "YYYY" },
    { key: "paragard_removal_year", label: "Removal attempt/year", type: "number", required: true, placeholder: "YYYY" },
    { key: "paragard_injury", label: "Injury type", type: "select", required: true, options: ["Device broke at removal", "Arms embedded in uterine wall", "Migrated", "Perforation", "Failed removal req. surgery", "Chronic pain from fragments", "Multiple"] },
    { key: "paragard_surgery_required", label: "Surgery to remove fragments", type: "select", required: true, options: ["Yes", "Scheduled", "No"] },
    { key: "paragard_procedure_type", label: "Procedure type", type: "select", required: false, options: ["Hysteroscopy", "Laparoscopy", "Laparotomy", "Hysterectomy", "D&C", "None yet", "Other"] },
    { key: "paragard_fertility_impact", label: "Fertility / pregnancy impact", type: "select", required: false, options: ["Yes", "No", "Unknown"] },
  ],
  "nec": [
    { key: "nec_claimant_rel", label: "Claimant relationship to infant", type: "select", required: true, options: ["Mother", "Father", "Legal guardian", "Other rep"] },
    { key: "nec_gestational_age", label: "Gestational age (weeks)", type: "number", required: true, placeholder: "e.g. 28" },
    { key: "nec_formula_brand", label: "Formula brand in NICU", type: "select", required: true, options: ["Enfamil", "Similac", "Both", "Other cow's-milk", "Unsure"] },
    { key: "nec_dx_year", label: "NEC diagnosis year", type: "number", required: true, placeholder: "YYYY" },
    { key: "nec_severity", label: "NEC severity", type: "select", required: true, options: ["Stage I", "Stage II", "Stage III (surgery)", "Fatal"] },
    { key: "nec_surgery_required", label: "Bowel resection required", type: "select", required: true, options: ["Yes", "No"] },
  ],
  "zantac": [
    { key: "zantac_rx_or_otc", label: "Prescription or OTC Zantac", type: "select", required: true, options: ["Rx (150/300mg)", "OTC (75mg)", "Both", "Unsure"] },
    { key: "zantac_years", label: "Years of use", type: "select", required: true, options: ["<1", "1-2", "3-5", "6-10", "10+"] },
    { key: "zantac_start_year", label: "Start year", type: "number", required: true, placeholder: "YYYY" },
    { key: "zantac_frequency", label: "Frequency", type: "select", required: true, options: ["Daily", "Most days", "Several/week", "Occasional"] },
    { key: "zantac_dx", label: "Cancer diagnosis", type: "select", required: true, options: ["Bladder", "Stomach/Gastric", "Esophageal", "Liver", "Colorectal", "Kidney", "Pancreatic", "Lung", "Prostate", "Breast", "Thyroid", "NHL", "Other"] },
    { key: "zantac_dx_year", label: "Diagnosis year", type: "number", required: true, placeholder: "YYYY" },
  ],
  "suboxone": [
    { key: "suboxone_form", label: "Form taken", type: "select", required: true, options: ["Suboxone Film", "Subutex (sublingual)", "Generic film", "Tablet", "Multiple forms"] },
    { key: "suboxone_years", label: "Years of use", type: "select", required: true, options: ["<1", "1-2", "3-5", "6-10", "10+"] },
    { key: "suboxone_start_year", label: "Start year", type: "number", required: true, placeholder: "YYYY" },
    { key: "dental_damage", label: "Dental damage type", type: "select", required: true, options: ["Severe decay multiple teeth", "Crumbling/fracturing", "Complete tooth loss", "Abscesses/infections", "Gum disease", "Need dentures/implants", "Multiple"] },
    { key: "teeth_lost_count", label: "Teeth lost or extracted", type: "select", required: false, options: ["1-2", "3-5", "6-10", "10+", "All/nearly all", "None (decay only)"] },
    { key: "prior_dental_health", label: "Good dental health prior to Suboxone", type: "select", required: true, options: ["Yes", "Some prior issues — worse on drug", "No"] },
    // Operator-authored field preserved from the live CRM (do not rename the
    // key — sync merges by key, and renaming would orphan historical answers).
    { key: "first_dental_visit", label: "Date of First Dental Issue", type: "date", required: false, helper_text: "First date the claimant noticed or was treated for dental damage — anchors the SOL clock." },
  ],
  "tepezza": [
    { key: "tepezza_infusion_count", label: "Tepezza infusions received", type: "select", required: true, options: ["1-2", "3-4", "5-6 (full course)", "7+", "Unsure"] },
    { key: "tepezza_treatment_year", label: "Treatment start year", type: "number", required: true, placeholder: "YYYY" },
    { key: "tepezza_ear_condition", label: "Hearing/ear condition", type: "select", required: true, options: ["Sensorineural hearing loss", "Tinnitus", "Autophony", "Eustachian tube dysfunction", "Hyperacusis", "Multiple"] },
    { key: "hearing_loss_severity", label: "Hearing loss severity", type: "select", required: false, options: ["Mild (25-40 dB)", "Moderate (41-55)", "Mod-severe (56-70)", "Severe (71-90)", "Profound", "Tinnitus only"] },
    { key: "hearing_aids_needed", label: "Hearing aids / implants needed", type: "select", required: false, options: ["Yes", "Evaluating", "No"] },
    { key: "permanent_loss", label: "Doctor confirmed permanent", type: "select", required: false, options: ["Yes", "Still evaluating", "No"] },
    // Operator-authored field preserved from the live CRM (do not rename the
    // key — sync merges by key, and renaming would orphan historical answers).
    { key: "audiogram_db", label: "Audiogram dB Loss", type: "text", required: false, placeholder: "e.g. 45 dB R / 50 dB L", helper_text: "Decibel loss from the audiogram report — objective severity evidence." },
  ],
  "tylenol": [
    { key: "tylenol_trimester", label: "Trimester(s) of use", type: "select", required: true, options: ["1st only", "2nd only", "3rd only", "1st+2nd", "2nd+3rd", "All three", "Most of pregnancy"] },
    { key: "tylenol_frequency", label: "Frequency during pregnancy", type: "select", required: true, options: ["Daily", "Several/week", "Weekly", "Occasional"] },
    { key: "tylenol_brand", label: "Brand/form used", type: "select", required: false, options: ["Tylenol", "Generic acetaminophen", "Percocet/opioid combo", "NyQuil/DayQuil", "Multiple"] },
    { key: "child_diagnosis", label: "Child's diagnosis", type: "select", required: true, options: ["ASD", "ADHD", "Both ASD+ADHD", "ASD with intellectual disability", "Other neurodev"] },
    { key: "child_dx_year", label: "Child's diagnosis year", type: "number", required: true, placeholder: "YYYY" },
    { key: "child_in_services", label: "Child in therapy / SPED", type: "select", required: false, options: ["Yes", "No"] },
  ],
  "autonomous-vehicles": [
    { key: "av_tech", label: "AV / driver-assist tech involved", type: "select", required: true, options: ["Tesla Autopilot/FSD", "Tesla AEB", "Waymo", "Cruise", "Uber/Lyft AV", "GM SuperCruise", "Ford BlueCruise", "Other ADAS", "Unsure"] },
    { key: "av_role", label: "Role in accident", type: "select", required: true, options: ["AV driver", "AV passenger", "Other-vehicle driver struck", "Pedestrian struck", "Cyclist struck", "Other"] },
    { key: "av_accident_year", label: "Accident year", type: "number", required: true, placeholder: "YYYY" },
    { key: "av_police_report", label: "Police report filed", type: "select", required: true, options: ["Yes", "No"] },
    { key: "av_injury_type", label: "Injury type", type: "select", required: true, options: ["TBI", "Spinal cord", "Fractures", "Whiplash/soft tissue", "Burns", "Internal organ damage", "Wrongful death", "Multiple"] },
    { key: "av_hospitalized", label: "Hospitalized", type: "select", required: true, options: ["Yes", "No"] },
  ],
  "delivery-injury": [
    { key: "delivery_platform", label: "Delivery platform at injury", type: "select", required: true, options: ["DoorDash", "Uber Eats", "Instacart", "Amazon Flex", "Grubhub", "Postmates", "Shipt", "Multiple", "Other"] },
    { key: "delivery_tenure", label: "Time working for platform", type: "select", required: true, options: ["<1mo", "1-3mo", "4-6mo", "7-12mo", "1-2yr", "2+yr"] },
    { key: "delivery_injury_type", label: "How injured", type: "select", required: true, options: ["Vehicle accident", "Struck by vehicle", "Slip/fall at delivery", "Assault during delivery", "Bicycle accident", "Motorcycle accident", "Repetitive strain", "Dog bite", "Other"] },
    { key: "delivery_injury_year", label: "Injury year", type: "number", required: true, placeholder: "YYYY" },
    { key: "delivery_injury_severity", label: "Severity", type: "select", required: true, options: ["ER visit", "Hospitalization", "Surgery required", "Permanent disability", "Missed significant work", "Ongoing chronic pain"] },
    { key: "delivery_workers_comp", label: "Workers' comp offered by platform", type: "select", required: true, options: ["Yes", "Denied as contractor", "Never offered", "Partial"] },
  ],
  "rideshare-assault": [
    { key: "rideshare_platform", label: "Platform involved", type: "select", required: true, options: ["Uber", "Lyft", "Both", "Other"] },
    { key: "assault_year", label: "Approximate year of assault", type: "number", required: true, placeholder: "YYYY" },
    { key: "reported_to_platform", label: "Reported to platform", type: "select", required: true, options: ["Yes", "Tried — no response", "No"] },
    { key: "reported_to_police", label: "Reported to police", type: "select", required: false, options: ["Yes - charges filed", "Yes - no charges", "No", "Prefer not to share"] },
    { key: "driver_identified", label: "Driver identified", type: "select", required: false, options: ["Yes", "No", "Unsure"] },
    { key: "received_medical_or_counseling", label: "Received medical / counseling care", type: "select", required: false, options: ["Yes", "No"] },
    { key: "have_trip_receipt", label: "Has trip receipt / app record", type: "select", required: false, options: ["Yes", "Can retrieve from app", "No"] },
  ],
  "industrial-water": [
    { key: "contamination_type", label: "Contamination type", type: "select", required: true, options: ["PFAS/PFOA/PFOS", "TCE/PCE", "Chromium-6", "Lead", "Benzene/petroleum", "Agricultural runoff", "Military base", "Landfill/Superfund", "Multiple/unsure"] },
    { key: "contamination_location", label: "City/county, state", type: "text", required: true, placeholder: "e.g. Wilmington, NC" },
    { key: "exposure_years", label: "Years of exposure", type: "select", required: true, options: ["<1", "1-3", "4-9", "10-19", "20+"] },
    { key: "exposure_start_year", label: "First-exposure year", type: "number", required: true, placeholder: "YYYY" },
    { key: "official_notification", label: "Notified of contamination", type: "select", required: false, options: ["Yes - govt/utility", "Yes - news/community", "No - found independently", "Unclear"] },
    { key: "industrial_water_dx", label: "Diagnosis", type: "select", required: true, options: ["Kidney cancer", "Bladder cancer", "Thyroid cancer", "Liver cancer/disease", "Testicular cancer", "NHL", "Parkinson's", "UC/Crohn's", "Thyroid disease (non-cancer)", "PFAS immune", "Neurological", "Birth defects", "Miscarriage/stillbirth", "Other"] },
  ],
};

// ─────────────────────────────────────────────────────────────────────────
// CRM VALIDATION RULES (operator-visible)
// ─────────────────────────────────────────────────────────────────────────
// String-keyed rule names appended to form_configurations.rules so they
// render as the "Validation Rules" list on each card. These complement the
// machine-enforced eligibility_rules inside web_form_config.

const UNIVERSAL_RULES: string[] = [
  "TCPA_CONSENT_REQUIRED",
  "ATTESTATION_REQUIRED",
  "HIPAA_RELEASE_REQUIRED",
  "ATTORNEY_REPRESENTATION_KNOCKOUT",
  "PRIOR_FULL_RELEASE_KNOCKOUT",
  "IDENTITY_VERIFICATION_PENDING",
  "DUPLICATE_LEAD_CHECK",
  "DISPOSABLE_EMAIL_REJECTED",
  "VOIP_PHONE_FLAGGED",
  "MINIMUM_AGE_18",
];

// ─────────────────────────────────────────────────────────────────────────
// EXTRA FIELD DECLARATIONS (operator-visible)
// ─────────────────────────────────────────────────────────────────────────
// Per-tort extra fields beyond the registry baseline. Surfaced as the
// "Extra Fields" badge row.
const UNIVERSAL_EXTRA_FIELDS: string[] = [
  "claimant_relationship",
  "prior_lawsuit_history",
  "hipaa_release_status",
  "identity_verification",
  "lead_source",
];

// ─────────────────────────────────────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────────────────────────────────────

export function getComprehensiveTortForm(tortId: string): ComprehensiveTortForm | null {
  const webForm = WEB_FORMS[tortId];
  const tort = TORT_REGISTRY[tortId];
  if (!webForm || !tort) return null;

  const tortCustom = TORT_SPECIFIC_CUSTOM_FIELDS[tortId] ?? [];
  const customFields: CustomField[] = [...UNIVERSAL_CUSTOM_FIELDS, ...tortCustom];

  // Merge registry rules with the universal compliance set, de-duped.
  const rules = Array.from(new Set([...(tort.rules ?? []), ...UNIVERSAL_RULES]));

  // Merge registry extra_fields with the universal compliance set, de-duped.
  const extra_fields = Array.from(
    new Set([...(tort.extra_fields ?? []), ...UNIVERSAL_EXTRA_FIELDS]),
  );

  return {
    intro_text: webForm.intro_subhead,
    custom_fields: customFields,
    extra_fields,
    rules,
    web_form_config: webForm,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// PER-TORT SITE BRANDING + SCREENING METADATA
// ─────────────────────────────────────────────────────────────────────────
// Branding (colors/fonts/image asset map) consumed by the SSR landing/intake/
// SEO renderers via brandingFromProfile(). Image paths are same-origin static
// files served by routes/brand-assets.ts (/api/brand-assets/:tort/:file) so the
// public pages' `img-src 'self'` CSP is satisfied. Seeded with NULL-fill
// semantics — admin hand-edits via the CRM are never overwritten.
export const TORT_SITE_PROFILES: Record<string, SiteProfile> = {
  "depo-provera": {
    brand_name: "Depo-Provera Brain Tumor Claim Review",
    colors: {
      primary: "#0d9488",
      primary_dark: "#0f3a52",
      accent: "#1e3a5f",
    },
    fonts: {
      heading: "Georgia, 'Times New Roman', serif",
      body: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    },
    images: {
      logo: "/api/brand-assets/depo-provera/logo.png",
      favicon: "/api/brand-assets/depo-provera/favicon.png",
      hero: "/api/brand-assets/depo-provera/hero.jpg",
      og: "/api/brand-assets/depo-provera/og.jpg",
    },
  },
};

// Internal statute-of-limitations screening window (months from diagnosis /
// discovery). NOT legal advice — a conservative intake-triage default used to
// flag potentially time-barred inquiries for human review.
export const TORT_SOL_MONTHS: Record<string, number> = {
  "depo-provera": 24,
};

export function getTortSiteProfile(tortId: string): SiteProfile | null {
  return TORT_SITE_PROFILES[tortId] ?? null;
}

export function getTortSolMonths(tortId: string): number | null {
  return TORT_SOL_MONTHS[tortId] ?? null;
}

export function getAllComprehensiveTortForms(): Record<string, ComprehensiveTortForm> {
  const out: Record<string, ComprehensiveTortForm> = {};
  for (const tortId of Object.keys(TORT_REGISTRY)) {
    const f = getComprehensiveTortForm(tortId);
    if (f) out[tortId] = f;
  }
  return out;
}

/**
 * Compute summary stats for a web form — used by /config to expose form
 * richness to the CRM card without shipping the full field list over the
 * wire. Total count includes anti-fraud probes added by conf().
 */
export interface WebFormStats {
  total_fields: number;
  eligibility_count: number;
  contact_count: number;
  story_count: number;
  required_count: number;
  anti_fraud_count: number;
  eligibility_rules_count: number;
  enabled: boolean;
}

export function summarizeWebForm(cfg: WebFormConfig | null | undefined): WebFormStats | null {
  if (!cfg) return null;
  const fields = cfg.fields ?? [];
  const antiFraudKeys = new Set(ANTI_FRAUD_FIELDS.map(f => f.key));
  return {
    total_fields: fields.length,
    eligibility_count: fields.filter(f => f.section === "eligibility").length,
    contact_count: fields.filter(f => f.section === "contact").length,
    story_count: fields.filter(f => f.section === "story").length,
    required_count: fields.filter(f => f.required).length,
    anti_fraud_count: fields.filter(f => antiFraudKeys.has(f.key)).length,
    eligibility_rules_count: (cfg.eligibility_rules ?? []).length,
    enabled: cfg.enabled !== false,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// CANONICAL LOCKED GUARDRAILS (Site Maker Engine)
//
// Every site generated by the Site Maker auto-attaches and LOCKS the same
// base contact fields, base eligibility questions, anti-fraud probes, the
// TCPA consent, and the corresponding eligibility rules. These are the
// non-negotiable compliance spine of every public tort site. The Site Maker
// may APPEND tort-specific custom fields/rules on top, but it can never
// remove or mutate the locked base — operators and the AI scaffold both
// treat these keys/ids as read-only.
// ─────────────────────────────────────────────────────────────────────────

/**
 * The six canonical tort categories every site must belong to. Mirrors the
 * `category` union in tort-engine.ts — kept here so the Site Maker and the AI
 * scaffold can validate/constrain category without importing the heavy engine.
 */
export const CANONICAL_CATEGORIES = [
  "pharmaceutical",
  "product_liability",
  "medical_device",
  "environmental",
  "transportation",
  "digital_platform",
] as const;

export type CanonicalCategory = (typeof CANONICAL_CATEGORIES)[number];

/** Field keys that are locked on every generated site and cannot be removed. */
export const CANONICAL_BASE_FIELD_KEYS: readonly string[] = Object.freeze([
  ...BASE_ELIGIBILITY.map(f => f.key),
  ...CONTACT_FIELDS.map(f => f.key),
  ...TREATMENT_FIELDS.map(f => f.key),
  ...DAMAGE_FIELDS.map(f => f.key),
  ...ANTI_FRAUD_FIELDS.map(f => f.key),
  DESCRIPTION_FIELD.key,
  TCPA_FIELD.key,
]);

/** Eligibility-rule ids that are locked on every generated site. */
export const CANONICAL_BASE_RULE_IDS: readonly string[] = Object.freeze([
  ...BASE_RULES.map(r => r.id),
  ...ANTI_FRAUD_RULES.map(r => r.id),
]);

export interface BuildCanonicalWebFormInput {
  /** Hero headline shown above the form (usually the tort display name). */
  headline: string;
  /** Supporting sub-headline. */
  subhead: string;
  /**
   * Tort-specific eligibility questions appended after the base eligibility
   * block (e.g. "Were you diagnosed with X?"). Keys must NOT collide with the
   * locked base keys — collisions are dropped to protect the canonical spine.
   */
  eligibilityExtra?: WebFormField[];
  /** Tort-specific eligibility rules appended after the base rules. */
  rulesExtra?: EligibilityRule[];
  /**
   * Tort-specific story/diagnosis fields appended into the story section
   * (before the locked treatment/damage/anti-fraud blocks).
   */
  storyExtra?: WebFormField[];
}

/**
 * Build a complete, compliance-locked WebFormConfig for a brand-new site.
 * Mirrors the internal `conf()` builder used by the canonical seed forms so
 * generated sites are structurally identical to hand-authored ones: the
 * locked base fields/rules always appear, in the same order, regardless of
 * what tort-specific extras are supplied. Any extra field/rule that collides
 * with a locked canonical key/id is silently dropped.
 */
export function buildCanonicalWebFormConfig(input: BuildCanonicalWebFormInput): WebFormConfig {
  const lockedKeys = new Set(CANONICAL_BASE_FIELD_KEYS);
  const lockedRuleIds = new Set(CANONICAL_BASE_RULE_IDS);
  const seenExtraKeys = new Set<string>();
  const seenExtraRuleIds = new Set<string>();

  const dedupeFields = (fields: WebFormField[] | undefined): WebFormField[] =>
    (fields ?? []).filter(f => {
      if (lockedKeys.has(f.key) || seenExtraKeys.has(f.key)) return false;
      seenExtraKeys.add(f.key);
      return true;
    });

  const eligibilityExtra = dedupeFields(input.eligibilityExtra);
  const storyExtra = dedupeFields(input.storyExtra);

  // A rule may only reference a field that actually survives into this config —
  // a locked canonical field or one of the accepted extra fields. This closes
  // an integrity gap where a direct API caller could persist "orphan" knockout
  // rules pointing at fields that were never added (dead logic on the live site).
  const validRuleFieldKeys = new Set<string>([
    ...lockedKeys,
    ...eligibilityExtra.map(f => f.key),
    ...storyExtra.map(f => f.key),
  ]);
  const rulesExtra = (input.rulesExtra ?? []).filter(r => {
    if (lockedRuleIds.has(r.id) || seenExtraRuleIds.has(r.id)) return false;
    if (!validRuleFieldKeys.has(r.field)) return false;
    seenExtraRuleIds.add(r.id);
    return true;
  });

  return {
    enabled: true,
    intro_headline: input.headline,
    intro_subhead: input.subhead,
    fields: [
      ...BASE_ELIGIBILITY,
      ...eligibilityExtra,
      ...CONTACT_FIELDS,
      ...storyExtra,
      ...TREATMENT_FIELDS,
      ...DAMAGE_FIELDS,
      ...ANTI_FRAUD_FIELDS,
      DESCRIPTION_FIELD,
      TCPA_FIELD,
    ],
    eligibility_rules: [...BASE_RULES, ...rulesExtra, ...ANTI_FRAUD_RULES],
    send_confirmation_email: true,
    confirmation_subject: `We received your ${input.headline} inquiry`,
    confirmation_body_html: confirmationHtml(input.headline),
  };
}
