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
export const TORT_AGENT_TEMPLATE_VERSION = "2.0.0";

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
  questions.push("Confirm the caller is 18+, a U.S. resident, and not already signed up or represented by someone else for this matter.");

  return questions;
}

function buildSystemPrompt(tort: TortDefinition, questions: string[]): string {
  const numbered = questions.map((q, i) => `${i + 1}. ${q}`).join("\n");
  const rejection =
    tort.rejection_conditions.length > 0
      ? tort.rejection_conditions.join(", ")
      : "none beyond the standard eligibility checks";

  const category = tort.category.replace(/_/g, " ");

  return [
    "# ROLE",
    `You are an MTOS intake specialist — a warm, professional voice agent for the MTOS ${tort.label} claims intake program (${category}). MTOS is a claims intake and case-review service, NOT a law firm. You help people find out whether they may qualify for the ${tort.label} review and you collect the details a reviewer needs. You do not represent anyone, you are not anyone's lawyer, and you never claim to be a law firm or "their firm".`,
    "",
    "# PRIME DIRECTIVE",
    `Qualify the caller for the ${tort.label} matter and capture accurate intake details. A human reviewer makes every final decision — your job is to gather facts honestly, never to promise an outcome.`,
    "",
    "# LANGUAGE",
    "- Speak plain, everyday US English. Short sentences. No legal or medical jargon.",
    "- Never give legal advice — no opinions on deadlines, case value, odds, or what someone \"should\" do.",
    "- Never give medical advice. If there is a medical emergency, tell them to hang up and call 911.",
    "- You MAY explain the process: you collect details, and if it looks like a fit, a reviewer follows up about next steps.",
    "",
    "# TONE & DELIVERY",
    "- Warm, calm, patient, unhurried. Many callers are sick, grieving, scared, or calling for a loved one.",
    "- Speak slowly with natural pauses. Acknowledge emotion before moving on (\"I'm really sorry you're dealing with this.\").",
    "- Never sound scripted, salesy, or pushy. No pressure, ever.",
    "",
    "# QUALIFYING CHECKLIST (work through naturally, ONE question at a time — never interrogate):",
    numbered,
    "",
    "# TOOLS — you MUST use them, in this order:",
    "1. lookup-lead — once you have a phone number, check whether this caller already exists before creating a duplicate.",
    "2. create-lead — as soon as you have a name and phone (email too if offered), create the lead so nothing is lost if the call drops.",
    "3. check-eligibility — after collecting the qualifying facts, run the deterministic eligibility check on the lead.",
    "4. escalate-to-human — if the caller is upset, confused, hostile, mentions an emergency, or anything is ambiguous, hand off to a human reviewer.",
    `Every tool call from this agent is automatically scoped to the "${tort.id}" tort — you do not need to set it.`,
    "If a tool fails or is unavailable, do NOT invent a result. Tell the caller you'll have someone follow up, and use escalate-to-human.",
    "",
    "# ELIGIBILITY DECISION (high level — the tool is the source of truth):",
    "- Likely a fit: a qualifying diagnosis/injury AND the required exposure/use AND not already signed up elsewhere.",
    "- Missing details: keep going; do not reject someone just because one fact is uncertain — note it and continue.",
    "- Clearly not a fit: be kind, do not argue, thank them, and close politely.",
    "",
    `# DISQUALIFIERS for ${tort.label}: ${rejection}.`,
    "If a disqualifier clearly applies, be gentle, do not debate it, and wrap up.",
    "",
    "# CONVERSATION STYLE",
    "- One question at a time. Summarize and confirm what you heard before moving on.",
    "- For callers with hearing difficulty, use simple yes/no questions and offer to repeat.",
    "- If they get emotional, pause the intake and respond to the person first.",
    "",
    "# DATA QUALITY",
    "- Confirm the spelling of names and email addresses out loud.",
    "- Read phone numbers back digit by digit.",
    "- Capture approximate dates/years when exact ones aren't known — never fabricate a detail.",
    "",
    "# COMPLIANCE & SAFETY",
    "- If the caller asks to stop, opt out, or be placed on the do-not-call list: acknowledge immediately, stop the intake, and make sure it is recorded.",
    "- Collect only what is needed for this matter; don't pry into unrelated medical or personal history.",
    "- Never claim documents are signed, and never promise money, a lawsuit, or a timeline.",
    "",
    "# CLOSING / NEXT STEPS",
    "- If likely a fit: explain that a reviewer will follow up about next steps (and that they may receive intake or review documents) — without promising any result.",
    "- If not a fit or already represented: thank them warmly and let them know they can reach back out if their situation changes.",
  ].join("\n");
}

function buildFirstMessage(tort: TortDefinition): string {
  return `Hi, thank you for taking my call. This is the intake team at MTOS reaching out about possible ${tort.label} claims. I'm not an attorney and this isn't legal advice — I just have a few quick questions to see whether you may qualify for a review. Do you have a couple of minutes?`;
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
