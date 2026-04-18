import { anthropic } from "@workspace/integrations-anthropic-ai";
import { logger } from "./logger";

const MODEL = "claude-haiku-4-5";

export interface LeadIntelligenceInput {
  lead: Record<string, any>;
  documents?: Array<Record<string, any>>;
  ocr_results?: Array<Record<string, any>>;
}

export interface LeadIntelligenceScore {
  completion_score: number;
  completion_grade: string;
  completion_details: string[];
  reliability_score: number;
  reliability_grade: string;
  reliability_details: string[];
  truthfulness_score: number;
  truthfulness_grade: string;
  truthfulness_details: string[];
  overall_assessment: string;
  recommended_action: string;
  scored_at: string;
}

function gradeFromScore(score: number): string {
  if (score >= 90) return "Exceptional";
  if (score >= 75) return "Strong";
  if (score >= 60) return "Adequate";
  if (score >= 40) return "Deficient";
  return "Critical";
}

function computeCompletionScore(lead: Record<string, any>): { score: number; details: string[] } {
  const details: string[] = [];
  let filled = 0;
  let total = 0;

  const requiredFields: [string, string][] = [
    ["first_name", "First Name"],
    ["last_name", "Last Name"],
    ["date_of_birth", "Date of Birth"],
    ["phone_primary", "Primary Phone"],
    ["email", "Email Address"],
    ["street_address", "Street Address"],
    ["city", "City"],
    ["state", "State"],
    ["zip", "ZIP Code"],
    ["last_4_ssn", "Last 4 SSN"],
    ["tort_type", "Tort Classification"],
    ["diagnosis", "Diagnosis"],
    ["diagnosis_date", "Diagnosis Date"],
    ["physician_first_name", "Treating Physician First Name"],
    ["physician_last_name", "Treating Physician Last Name"],
    ["physician_full_address", "Physician Address"],
    ["physician_contact_info", "Physician Contact"],
    ["hospital_name", "Hospital/Facility Name"],
    ["hospital_fax", "Hospital Fax"],
    ["hospital_contact_info", "Hospital Contact"],
  ];

  const supplementaryFields: [string, string][] = [
    ["medications", "Current Medications"],
    ["exposure_start", "Exposure Start Date"],
    ["exposure_end", "Exposure End Date"],
    ["location_name", "Exposure Location"],
    ["npi_number", "NPI Number"],
    ["source", "Lead Source"],
    ["law_firm", "Referring Law Firm"],
    ["trustedform_cert_url", "TrustedForm Certificate"],
  ];

  for (const [key, label] of requiredFields) {
    total += 3;
    const val = lead[key];
    if (val && String(val).trim() && !String(val).includes("[DECRYPTION_ERROR]")) {
      filled += 3;
    } else {
      details.push(`Missing required field: ${label}`);
    }
  }

  for (const [key, label] of supplementaryFields) {
    total += 1;
    const val = lead[key];
    if (val && String(val).trim() && !String(val).includes("[DECRYPTION_ERROR]")) {
      filled += 1;
    } else {
      details.push(`Missing supplementary field: ${label}`);
    }
  }

  if (lead.diagnosis_confirmed) {
    filled += 2;
    total += 2;
  } else {
    total += 2;
    details.push("Diagnosis not confirmed by claimant");
  }

  if (lead.was_at_location) {
    filled += 2;
    total += 2;
  } else {
    total += 2;
    details.push("Location exposure not confirmed");
  }

  if (lead.tcpa_consent) {
    filled += 2;
    total += 2;
  } else {
    total += 2;
    details.push("TCPA consent not obtained");
  }

  const score = Math.round((filled / total) * 100);
  if (details.length === 0) {
    details.push("All required and supplementary fields are complete");
  }
  return { score, details };
}

function computeReliabilityScore(lead: Record<string, any>, documents: Array<Record<string, any>>): { score: number; details: string[] } {
  const details: string[] = [];
  let score = 50;

  if (lead.npi_verified) {
    score += 12;
    details.push("NPI verification confirmed via NPPES registry");
  } else {
    score -= 8;
    details.push("Physician NPI has not been independently verified");
  }

  if (lead.email_validation_status === "valid") {
    score += 8;
    details.push("Email address validated as deliverable");
  } else if (lead.email_validation_status === "invalid") {
    score -= 10;
    details.push("Email address failed deliverability validation");
  } else {
    details.push("Email validation has not been performed");
  }

  if (lead.address_validation_status === "valid") {
    score += 8;
    details.push("Physical address verified as deliverable");
  } else if (lead.address_validation_status === "invalid") {
    score -= 10;
    details.push("Physical address failed validation");
  } else {
    details.push("Address validation has not been performed");
  }

  if (lead.background_check_status === "clean") {
    score += 10;
    details.push("Background check returned no adverse findings");
  } else if (lead.background_check_status === "flagged") {
    score -= 5;
    details.push("Background check returned flagged records requiring review");
  } else {
    details.push("Background check has not been initiated");
  }

  if (lead.trustedform_cert_url) {
    score += 8;
    details.push("TrustedForm certificate captured and recorded");
  } else {
    score -= 3;
    details.push("No TrustedForm certificate on file");
  }

  if (documents && documents.length > 0) {
    const signedDocs = documents.filter((d: any) => d.signed);
    if (signedDocs.length > 0) {
      score += 10;
      details.push(`${signedDocs.length} signed document(s) on file`);
    }
    score += Math.min(documents.length * 2, 8);
    details.push(`${documents.length} document(s) associated with this lead`);
  } else {
    score -= 5;
    details.push("No supporting documents have been uploaded");
  }

  if (lead.tcpa_consent) {
    score += 4;
  }

  score = Math.max(0, Math.min(100, score));
  return { score, details };
}

function computeTruthfulnessScore(lead: Record<string, any>): { score: number; details: string[] } {
  const details: string[] = [];
  let score = 70;

  if (typeof lead.fraud_score === "number") {
    if (lead.fraud_score <= 10) {
      score += 15;
      details.push(`Fraud detection score is nominal (${lead.fraud_score}/100)`);
    } else if (lead.fraud_score <= 30) {
      score += 5;
      details.push(`Fraud detection score is within acceptable range (${lead.fraud_score}/100)`);
    } else if (lead.fraud_score <= 60) {
      score -= 15;
      details.push(`Fraud detection score is elevated and warrants review (${lead.fraud_score}/100)`);
    } else {
      score -= 30;
      details.push(`Fraud detection score is critically high (${lead.fraud_score}/100)`);
    }
  } else {
    details.push("Fraud detection analysis has not been performed");
  }

  if (lead.fraud_status === "ACCEPTED") {
    score += 10;
    details.push("Final Arbiter determination: ACCEPTED");
  } else if (lead.fraud_status === "REJECTED") {
    score -= 25;
    details.push("Final Arbiter determination: REJECTED — credibility concerns identified");
  } else if (lead.fraud_status === "TO_BE_REVIEWED") {
    score -= 5;
    details.push("Final Arbiter determination: PENDING REVIEW");
  }

  if (lead.fraud_indicators) {
    try {
      const indicators = JSON.parse(lead.fraud_indicators);
      if (Array.isArray(indicators) && indicators.length > 0) {
        score -= indicators.length * 5;
        details.push(`${indicators.length} fraud indicator(s) flagged: ${indicators.slice(0, 3).join(", ")}${indicators.length > 3 ? "..." : ""}`);
      }
    } catch {
      if (typeof lead.fraud_indicators === "string" && lead.fraud_indicators.trim()) {
        score -= 10;
        details.push("Fraud indicators present in record");
      }
    }
  }

  if (lead.status === "review_required") {
    score -= 10;
    details.push("Lead is flagged for manual review — potential data inconsistencies");
  }

  if (lead.diagnosis_confirmed && lead.was_at_location && lead.diagnosis && lead.diagnosis_date) {
    score += 8;
    details.push("Core claim elements (diagnosis, location, dates) are internally consistent");
  } else {
    const inconsistencies: string[] = [];
    if (!lead.diagnosis_confirmed) inconsistencies.push("unconfirmed diagnosis");
    if (!lead.was_at_location) inconsistencies.push("unverified location exposure");
    if (!lead.diagnosis) inconsistencies.push("missing diagnosis detail");
    if (!lead.diagnosis_date) inconsistencies.push("missing diagnosis date");
    if (inconsistencies.length > 0) {
      score -= inconsistencies.length * 3;
      details.push(`Claim consistency gaps: ${inconsistencies.join(", ")}`);
    }
  }

  score = Math.max(0, Math.min(100, score));
  return { score, details };
}

export async function scoreLeadIntelligence(input: LeadIntelligenceInput): Promise<LeadIntelligenceScore> {
  const { lead, documents = [] } = input;

  const completion = computeCompletionScore(lead);
  const reliability = computeReliabilityScore(lead, documents);
  const truthfulness = computeTruthfulnessScore(lead);

  let overall_assessment = "";
  let recommended_action = "";

  try {
    const prompt = `You are a senior mass tort case evaluation analyst. Based on the following lead intelligence scores, provide a concise 2-3 sentence professional assessment and a single recommended next action.

Lead: ${lead.name || "Unknown"} — Tort: ${lead.tort_type || "Unspecified"}
Status: ${lead.status || "unknown"}

COMPLETION SCORE: ${completion.score}/100 (${gradeFromScore(completion.score)})
Key findings: ${completion.details.slice(0, 5).join("; ")}

RELIABILITY SCORE: ${reliability.score}/100 (${gradeFromScore(reliability.score)})
Key findings: ${reliability.details.slice(0, 5).join("; ")}

TRUTHFULNESS SCORE: ${truthfulness.score}/100 (${gradeFromScore(truthfulness.score)})
Key findings: ${truthfulness.details.slice(0, 5).join("; ")}

Documents on file: ${documents.length}
Fraud score: ${lead.fraud_score ?? "N/A"}
NPI verified: ${lead.npi_verified ? "Yes" : "No"}
Background check: ${lead.background_check_status || "Not performed"}

Respond in JSON format:
{"overall_assessment": "...", "recommended_action": "..."}

Use precise legal/professional language. No hedging. Be direct and authoritative.`;

    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 300,
      messages: [{ role: "user", content: prompt }],
    });

    const text = response.content[0]?.type === "text" ? response.content[0].text : "";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      overall_assessment = parsed.overall_assessment || "";
      recommended_action = parsed.recommended_action || "";
    }
  } catch (err) {
    logger.error({ err: err }, "Lead intelligence AI assessment failed, using deterministic fallback");
    const avg = Math.round((completion.score + reliability.score + truthfulness.score) / 3);
    if (avg >= 75) {
      overall_assessment = "This claimant's file demonstrates strong completeness and verifiable data integrity. The lead is well-positioned for advancement in the litigation pipeline.";
      recommended_action = "Proceed with retainer execution and initiate medical records procurement.";
    } else if (avg >= 50) {
      overall_assessment = "This claimant's file contains notable gaps in documentation or verification that require remediation prior to case advancement.";
      recommended_action = "Assign to paralegal for data completion and schedule follow-up verification within 48 hours.";
    } else {
      overall_assessment = "This claimant's file presents significant deficiencies across multiple evaluation criteria. The record does not currently meet the threshold for case advancement.";
      recommended_action = "Escalate for supervisory review. Do not advance until critical deficiencies are resolved.";
    }
  }

  return {
    completion_score: completion.score,
    completion_grade: gradeFromScore(completion.score),
    completion_details: completion.details,
    reliability_score: reliability.score,
    reliability_grade: gradeFromScore(reliability.score),
    reliability_details: reliability.details,
    truthfulness_score: truthfulness.score,
    truthfulness_grade: gradeFromScore(truthfulness.score),
    truthfulness_details: truthfulness.details,
    overall_assessment,
    recommended_action,
    scored_at: new Date().toISOString(),
  };
}
