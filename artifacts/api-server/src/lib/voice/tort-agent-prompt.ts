/**
 * Deterministic per-tort Vapi voice-agent prompt builder (Task #90).
 *
 * Turns a TortDefinition (label, valid diagnoses, required exposure,
 * exposure fields) into a tort-specific system prompt, first message, and
 * qualifying-question set. A single shared template keeps all 71 torts
 * consistent; a sha256 fingerprint over the canonical inputs + template
 * version lets the provisioning service detect drift and re-sync only the
 * agents whose generated prompt actually changed.
 *
 * Deterministic-first per the AI Constitution: no LLM is involved in
 * producing the prompt — it is pure string composition from the registry.
 */
import crypto from "crypto";
import type { TortDefinition } from "../tort-engine";

/**
 * Bump this when the SHARED TEMPLATE changes (wording, structure, tool
 * wiring instructions). Changing it forces every agent's fingerprint to
 * change so a "Provision All" re-sync re-pushes the new template to Vapi.
 */
export const TORT_AGENT_TEMPLATE_VERSION = "1.0.0";

export interface TortAgentPrompt {
  systemPrompt: string;
  firstMessage: string;
  qualifyingQuestions: string[];
  fingerprint: string;
}

function humanizeField(field: string): string {
  return field
    .replace(/_/g, " ")
    .replace(/\bexposure start\b/i, "when their exposure began")
    .replace(/\bexposure end\b/i, "when their exposure ended")
    .trim();
}

/**
 * Build the tort-specific qualifying questions from the deterministic
 * registry facts. Order is stable so the fingerprint is stable.
 */
export function buildQualifyingQuestions(tort: TortDefinition): string[] {
  const questions: string[] = [];

  // Diagnosis confirmation — the single most important eligibility gate.
  if (tort.valid_diagnoses.length > 0) {
    const sample = tort.valid_diagnoses.slice(0, 8).join(", ");
    questions.push(
      `Confirm the caller has a qualifying diagnosis for ${tort.label}. Qualifying conditions include: ${sample}. Ask what they were diagnosed with and when.`,
    );
  } else {
    questions.push(
      `Ask the caller to describe the injury or condition they believe is related to ${tort.label}, and when it was diagnosed.`,
    );
  }

  // Exposure questions.
  if (tort.required_exposure) {
    const fields = tort.exposure_fields.length
      ? tort.exposure_fields.map(humanizeField).join(" and ")
      : "their exposure history";
    questions.push(
      `Confirm exposure: ask about ${fields}. Exposure is REQUIRED for ${tort.label} — a caller with no exposure does not qualify.`,
    );
  }

  // Tort rules surfaced as explicit asks.
  for (const rule of tort.rules) {
    if (rule === "LOCATION_REQUIRED") {
      questions.push("Ask for the specific location/facility where the exposure occurred (required).");
    }
    if (rule === "EXPOSURE_DATES_REQUIRED") {
      questions.push("Ask for the start (and end, if applicable) dates of exposure (required).");
    }
  }

  // Extra fields the tort tracks.
  for (const field of tort.extra_fields) {
    questions.push(`Collect: ${humanizeField(field)}.`);
  }

  // Always-on intake basics.
  questions.push("Collect contact details: full name, date of birth, phone number, and email.");
  questions.push("Confirm the caller is 18+, a U.S. resident, and not already represented by another attorney for this matter.");

  return questions;
}

function buildSystemPrompt(tort: TortDefinition, questions: string[]): string {
  const numbered = questions.map((q, i) => `${i + 1}. ${q}`).join("\n");
  const rejection =
    tort.rejection_conditions.length > 0
      ? tort.rejection_conditions.join(", ")
      : "none beyond the standard eligibility checks";

  return [
    `You are a professional, empathetic intake specialist for a mass tort law firm, dedicated exclusively to the ${tort.label} (${tort.category.replace(/_/g, " ")}) litigation.`,
    "",
    "Your job is to qualify inbound and outbound callers for this specific tort. You never provide legal advice and you never promise an outcome.",
    "",
    "QUALIFYING CHECKLIST (work through these naturally, one at a time — do not interrogate):",
    numbered,
    "",
    "TOOLS — you MUST use them:",
    "- lookup-lead: at the start, check whether this caller already exists.",
    "- create-lead: once you have a name and phone (and ideally email), create the lead.",
    "- check-eligibility: after collecting the qualifying facts, run the eligibility check on the lead.",
    "- escalate-to-human: if the caller is upset, confused, or the situation is ambiguous, hand off to a human reviewer.",
    `Every tool call for this agent represents the "${tort.id}" tort; the tort context is sent automatically.`,
    "",
    `DISQUALIFIERS for ${tort.label}: ${rejection}. If the caller clearly does not qualify, be kind, do not argue, and end the call politely.`,
    "",
    "Always: be warm and unhurried, confirm spellings of names and email addresses, and respect any request to stop or be placed on the do-not-call list.",
  ].join("\n");
}

function buildFirstMessage(tort: TortDefinition): string {
  return `Hi, thank you for taking my call. I'm reaching out from a law firm regarding potential ${tort.label} claims. Do you have a few minutes to see whether you may qualify?`;
}

/**
 * Compute a stable fingerprint over the canonical inputs + template
 * version. Anything that affects the generated prompt MUST be part of the
 * hashed payload so drift detection is exact.
 */
export function computeTortAgentFingerprint(
  tort: TortDefinition,
  systemPrompt: string,
  firstMessage: string,
): string {
  const payload = JSON.stringify({
    v: TORT_AGENT_TEMPLATE_VERSION,
    id: tort.id,
    label: tort.label,
    category: tort.category,
    valid_diagnoses: tort.valid_diagnoses,
    required_exposure: tort.required_exposure,
    exposure_fields: tort.exposure_fields,
    extra_fields: tort.extra_fields,
    rules: tort.rules,
    rejection_conditions: tort.rejection_conditions,
    systemPrompt,
    firstMessage,
  });
  return crypto.createHash("sha256").update(payload).digest("hex");
}

export function buildTortAgentPrompt(tort: TortDefinition): TortAgentPrompt {
  const qualifyingQuestions = buildQualifyingQuestions(tort);
  const systemPrompt = buildSystemPrompt(tort, qualifyingQuestions);
  const firstMessage = buildFirstMessage(tort);
  const fingerprint = computeTortAgentFingerprint(tort, systemPrompt, firstMessage);
  return { systemPrompt, firstMessage, qualifyingQuestions, fingerprint };
}
