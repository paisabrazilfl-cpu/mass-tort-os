import { db, reviewQueueTable } from "@workspace/db";
import { auditLog } from "./audit";
import { logger } from "./logger";

export type ConflictType =
  | "LOGICAL_CONFLICT"
  | "RULE_OVERRIDE_CONFLICT"
  | "DATA_INTEGRITY_CONFLICT"
  | "AI_CLASSIFICATION_CONFLICT";

export type FailsafeMode = "SAFE_FAIL" | "REVIEW_FAIL" | "HARD_BLOCK";

export type SystemOutputState = "ACCEPT" | "REJECT" | "REVIEW_REQUIRED" | "ERROR_FALLBACK";

export interface ConflictResult {
  has_conflict: boolean;
  conflict_type: ConflictType | null;
  severity: "low" | "medium" | "high" | "critical";
  details: string[];
  failsafe_mode: FailsafeMode;
  output_state: SystemOutputState;
}

export interface ConflictCheckContext {
  entity_type: string;
  entity_id: string;
  source_module: string;
  lead_data?: Record<string, unknown>;
  tort_criteria?: Record<string, unknown>;
  ai_classification?: Record<string, unknown>;
  user_settings?: Record<string, unknown>;
}

const VALID_LOCATIONS = [
  "USA", "US", "UNITED STATES",
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "DC", "FL", "GA",
  "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD", "MA",
  "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY",
  "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC", "SD", "TN", "TX",
  "UT", "VT", "VA", "WA", "WV", "WI", "WY",
];

const KNOWN_TORT_CONDITIONS: Record<string, string[]> = {
  "Camp Lejeune": ["cancer", "leukemia", "kidney disease", "liver disease", "parkinson", "bladder cancer", "non-hodgkin"],
  "Roundup": ["non-hodgkin lymphoma", "cancer", "nhl"],
  "Talcum Powder": ["ovarian cancer", "mesothelioma", "cancer"],
  "AFFF": ["cancer", "kidney cancer", "testicular cancer", "thyroid disease"],
  "Asbestos": ["mesothelioma", "asbestosis", "lung cancer"],
  "NEC": ["necrotizing enterocolitis", "nec", "premature infant"],
  "Tylenol": ["autism", "adhd", "attention deficit"],
  "Hair Relaxer": ["uterine cancer", "ovarian cancer", "endometriosis"],
  "Paraquat": ["parkinson", "parkinson's disease"],
  "Zantac": ["cancer", "bladder cancer", "stomach cancer"],
};

export function checkLogicalConflicts(ctx: ConflictCheckContext): ConflictResult {
  const details: string[] = [];
  const lead = ctx.lead_data || {};

  const locationRaw = String(lead.location_name || lead.location || "").toUpperCase().trim();
  if (locationRaw) {
    const locationWords = locationRaw.split(/[\s,]+/).map((w) => w.trim()).filter(Boolean);
    const matchesUS = locationWords.some((word) => VALID_LOCATIONS.includes(word));
    if (!matchesUS) {
      details.push(`Location "${lead.location_name || lead.location}" is outside allowed US geography`);
    }
  }

  const tortType = String(lead.tort_type || "").trim();
  const diagnosisType = String(lead.diagnosis_type || "").toLowerCase().trim();
  if (tortType && diagnosisType && KNOWN_TORT_CONDITIONS[tortType]) {
    const validConditions = KNOWN_TORT_CONDITIONS[tortType];
    const matchesAny = validConditions.some((c) => diagnosisType.includes(c));
    if (!matchesAny) {
      details.push(
        `Diagnosis "${lead.diagnosis_type}" does not match known conditions for tort "${tortType}" (expected: ${validConditions.join(", ")})`
      );
    }
  }

  if (lead.exposure_start && lead.exposure_end) {
    const start = new Date(String(lead.exposure_start));
    const end = new Date(String(lead.exposure_end));
    if (start > end) {
      details.push(`Exposure start date (${lead.exposure_start}) is after end date (${lead.exposure_end})`);
    }
  }

  if (details.length === 0) {
    return { has_conflict: false, conflict_type: null, severity: "low", details: [], failsafe_mode: "SAFE_FAIL", output_state: "ACCEPT" };
  }

  return {
    has_conflict: true,
    conflict_type: "LOGICAL_CONFLICT",
    severity: details.length >= 2 ? "high" : "medium",
    details,
    failsafe_mode: "REVIEW_FAIL",
    output_state: "REVIEW_REQUIRED",
  };
}

export function checkDataIntegrity(ctx: ConflictCheckContext): ConflictResult {
  const details: string[] = [];
  const lead = ctx.lead_data || {};

  const requiredFields = ["name", "tort_type"];
  for (const field of requiredFields) {
    const val = lead[field];
    if (val === undefined || val === null || String(val).trim() === "") {
      details.push(`Required field "${field}" is missing or empty`);
    }
  }

  const name = String(lead.name || "").trim();
  if (name && name.length < 2) {
    details.push(`Name "${name}" appears invalid (too short)`);
  }
  if (name && /^(.)\1+$/.test(name)) {
    details.push(`Name "${name}" appears to be garbage input`);
  }

  const tortType = String(lead.tort_type || "").trim();
  if (tortType && tortType.length < 3) {
    details.push(`Tort type "${tortType}" appears invalid`);
  }
  const garbagePattern = /^[^a-zA-Z]*$|^(.)\1{3,}$/;
  if (tortType && garbagePattern.test(tortType)) {
    details.push(`Tort type "${tortType}" appears to be garbage input`);
  }

  const email = String(lead.email || "").trim();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    details.push(`Email "${email}" format is invalid`);
  }

  const phone = String(lead.phone || "").trim();
  if (phone && phone.replace(/\D/g, "").length < 10) {
    details.push(`Phone "${phone}" appears invalid (too few digits)`);
  }

  if (details.length === 0) {
    return { has_conflict: false, conflict_type: null, severity: "low", details: [], failsafe_mode: "SAFE_FAIL", output_state: "ACCEPT" };
  }

  const hasRequired = details.some((d) => d.includes("Required field"));
  const hasGarbage = details.some((d) => d.includes("garbage input"));

  return {
    has_conflict: true,
    conflict_type: "DATA_INTEGRITY_CONFLICT",
    severity: hasRequired || hasGarbage ? "critical" : "medium",
    details,
    failsafe_mode: hasGarbage ? "SAFE_FAIL" : "REVIEW_FAIL",
    output_state: hasGarbage ? "REJECT" : "REVIEW_REQUIRED",
  };
}

export function checkAIClassificationConflict(
  aiResult: { verdict: string; score: number },
  ruleResult: { qualified: boolean; status: string },
  ctx: ConflictCheckContext
): ConflictResult {
  const aiAccepts = aiResult.verdict === "strong" || aiResult.verdict === "moderate";
  const rulesAccept = ruleResult.qualified;

  if (aiAccepts === rulesAccept) {
    return { has_conflict: false, conflict_type: null, severity: "low", details: [], failsafe_mode: "SAFE_FAIL", output_state: rulesAccept ? "ACCEPT" : "REJECT" };
  }

  const details: string[] = [];
  if (aiAccepts && !rulesAccept) {
    details.push(
      `AI classification says ACCEPT (verdict: ${aiResult.verdict}, score: ${aiResult.score}) but rule engine says REJECT (status: ${ruleResult.status})`
    );
  } else {
    details.push(
      `Rule engine says ACCEPT but AI classification says REJECT (verdict: ${aiResult.verdict}, score: ${aiResult.score})`
    );
  }

  return {
    has_conflict: true,
    conflict_type: "AI_CLASSIFICATION_CONFLICT",
    severity: "high",
    details,
    failsafe_mode: "REVIEW_FAIL",
    output_state: "REVIEW_REQUIRED",
  };
}

export function checkRuleOverrideConflict(
  buyerCriteria: Record<string, unknown>,
  globalTortRules: Record<string, unknown>,
  ctx: ConflictCheckContext
): ConflictResult {
  const details: string[] = [];

  if (buyerCriteria.allowed_locations && globalTortRules.allowed_locations) {
    const buyerLocs = Array.isArray(buyerCriteria.allowed_locations) ? buyerCriteria.allowed_locations : [buyerCriteria.allowed_locations];
    const globalLocs = Array.isArray(globalTortRules.allowed_locations) ? globalTortRules.allowed_locations : [globalTortRules.allowed_locations];

    const buyerSet = new Set(buyerLocs.map((l: string) => String(l).toUpperCase()));
    const globalSet = new Set(globalLocs.map((l: string) => String(l).toUpperCase()));
    const extraLocs = [...buyerSet].filter((l) => !globalSet.has(l));
    if (extraLocs.length > 0) {
      details.push(`Buyer criteria allows locations [${extraLocs.join(", ")}] that are excluded by global tort rules`);
    }
  }

  if (buyerCriteria.min_age !== undefined && globalTortRules.min_age !== undefined) {
    if (Number(buyerCriteria.min_age) < Number(globalTortRules.min_age)) {
      details.push(`Buyer min_age (${buyerCriteria.min_age}) is lower than global min_age (${globalTortRules.min_age})`);
    }
  }

  if (buyerCriteria.required_conditions && globalTortRules.required_conditions) {
    const buyerConds = new Set(
      (Array.isArray(buyerCriteria.required_conditions) ? buyerCriteria.required_conditions : []).map((c: string) =>
        String(c).toLowerCase()
      )
    );
    const globalConds = Array.isArray(globalTortRules.required_conditions) ? globalTortRules.required_conditions : [];
    for (const gc of globalConds) {
      if (!buyerConds.has(String(gc).toLowerCase())) {
        details.push(`Global required condition "${gc}" is missing from buyer criteria`);
      }
    }
  }

  if (details.length === 0) {
    return { has_conflict: false, conflict_type: null, severity: "low", details: [], failsafe_mode: "SAFE_FAIL", output_state: "ACCEPT" };
  }

  return {
    has_conflict: true,
    conflict_type: "RULE_OVERRIDE_CONFLICT",
    severity: "high",
    details,
    failsafe_mode: "HARD_BLOCK",
    output_state: "REVIEW_REQUIRED",
  };
}

export async function runFullConflictCheck(ctx: ConflictCheckContext): Promise<ConflictResult> {
  const checks = [
    checkDataIntegrity(ctx),
    checkLogicalConflicts(ctx),
  ];

  for (const result of checks) {
    if (result.has_conflict) {
      await routeToReview(result, ctx);
      return result;
    }
  }

  return { has_conflict: false, conflict_type: null, severity: "low", details: [], failsafe_mode: "SAFE_FAIL", output_state: "ACCEPT" };
}

export async function routeToReview(conflict: ConflictResult, ctx: ConflictCheckContext): Promise<number> {
  logger.warn(
    { conflict_type: conflict.conflict_type, severity: conflict.severity, entity: ctx.entity_id, module: ctx.source_module },
    "CONFLICT DETECTED — routing to REVIEW_STATE"
  );

  const [item] = await db
    .insert(reviewQueueTable)
    .values({
      entity_type: ctx.entity_type,
      entity_id: ctx.entity_id,
      conflict_type: conflict.conflict_type || "UNKNOWN",
      severity: conflict.severity,
      failsafe_mode: conflict.failsafe_mode,
      source_module: ctx.source_module,
      summary: conflict.details.join("; "),
      details: {
        conflict_details: conflict.details,
        output_state: conflict.output_state,
        lead_data: ctx.lead_data,
        tort_criteria: ctx.tort_criteria,
        ai_classification: ctx.ai_classification,
      },
      resolution: "pending",
    })
    .returning({ id: reviewQueueTable.id });

  await auditLog(ctx.entity_type, ctx.entity_id, "conflict_detected", {
    conflict_type: conflict.conflict_type,
    severity: conflict.severity,
    failsafe_mode: conflict.failsafe_mode,
    output_state: conflict.output_state,
    details: conflict.details,
    review_queue_id: item.id,
  });

  return item.id;
}
