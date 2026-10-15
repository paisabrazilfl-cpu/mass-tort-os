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

// Performance Optimization: Hoist location set to module scope for O(1) lookups
const VALID_LOCATIONS_SET = new Set([
  "USA", "US", "UNITED STATES",
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "DC", "FL", "GA",
  "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD", "MA",
  "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY",
  "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC", "SD", "TN", "TX",
  "UT", "VT", "VA", "WA", "WV", "WI", "WY",
]);

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

// Performance Optimization: Hoist static regular expressions to prevent per-call re-compilation
const LOCATION_SPLIT_RE = /[\s,]+/;
const REPEATED_CHAR_NAME_RE = /^(.)\1+$/;
const GARBAGE_TORT_RE = /^[^a-zA-Z]*$|^(.)\1{3,}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DIGITS_ONLY_RE = /\D/g;

export function checkLogicalConflicts(ctx: ConflictCheckContext): ConflictResult {
  const details: string[] = [];
  const lead = ctx.lead_data || {};

  const locationRaw = String(lead.location_name || lead.location || "").toUpperCase().trim();
  if (locationRaw) {
    // Performance Optimization: Single-pass O(1) set lookup over split words
    const locationWords = locationRaw.split(LOCATION_SPLIT_RE);
    let matchesUS = false;
    for (let i = 0; i < locationWords.length; i++) {
      const word = locationWords[i]?.trim();
      if (word && VALID_LOCATIONS_SET.has(word)) {
        matchesUS = true;
        break;
      }
    }
    if (!matchesUS) {
      details.push(`Location "${lead.location_name || lead.location}" is outside allowed US geography`);
    }
  }

  const tortType = String(lead.tort_type || "").trim();
  const diagnosisType = String(lead.diagnosis_type || "").toLowerCase().trim();
  if (tortType && diagnosisType && KNOWN_TORT_CONDITIONS[tortType]) {
    const validConditions = KNOWN_TORT_CONDITIONS[tortType]!;
    // Performance Optimization: Direct loop avoids array closure allocations from .some()
    let matchesAny = false;
    for (let i = 0; i < validConditions.length; i++) {
      if (diagnosisType.includes(validConditions[i]!)) {
        matchesAny = true;
        break;
      }
    }
    if (!matchesAny) {
      details.push(
        `Diagnosis "${lead.diagnosis_type}" does not match known conditions for tort "${tortType}" (expected: ${validConditions.join(", ")})`
      );
    }
  }

  if (lead.exposure_start && lead.exposure_end) {
    // Performance Optimization: Date.parse avoids Date object heap allocations
    const startMs = Date.parse(String(lead.exposure_start));
    const endMs = Date.parse(String(lead.exposure_end));
    if (!isNaN(startMs) && !isNaN(endMs) && startMs > endMs) {
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

  // Performance Optimization: Direct field checks without temporary array allocations
  const nameVal = lead.name;
  if (nameVal === undefined || nameVal === null || String(nameVal).trim() === "") {
    details.push('Required field "name" is missing or empty');
  }
  const tortVal = lead.tort_type;
  if (tortVal === undefined || tortVal === null || String(tortVal).trim() === "") {
    details.push('Required field "tort_type" is missing or empty');
  }

  const name = String(lead.name || "").trim();
  if (name) {
    if (name.length < 2) {
      details.push(`Name "${name}" appears invalid (too short)`);
    }
    if (REPEATED_CHAR_NAME_RE.test(name)) {
      details.push(`Name "${name}" appears to be garbage input`);
    }
  }

  const tortType = String(lead.tort_type || "").trim();
  if (tortType) {
    if (tortType.length < 3) {
      details.push(`Tort type "${tortType}" appears invalid`);
    }
    if (GARBAGE_TORT_RE.test(tortType)) {
      details.push(`Tort type "${tortType}" appears to be garbage input`);
    }
  }

  const email = String(lead.email || "").trim();
  if (email && (email.length < 5 || !EMAIL_RE.test(email))) {
    details.push(`Email "${email}" format is invalid`);
  }

  const phone = String(lead.phone || "").trim();
  if (phone) {
    const digits = phone.replace(DIGITS_ONLY_RE, "");
    if (digits.length < 10) {
      details.push(`Phone "${phone}" appears invalid (too few digits)`);
    }
  }

  if (details.length === 0) {
    return { has_conflict: false, conflict_type: null, severity: "low", details: [], failsafe_mode: "SAFE_FAIL", output_state: "ACCEPT" };
  }

  // Performance Optimization: Single indexed loop avoids .some() callback allocations
  let hasRequired = false;
  let hasGarbage = false;
  for (let i = 0; i < details.length; i++) {
    const d = details[i]!;
    if (!hasRequired && d.includes("Required field")) {
      hasRequired = true;
    }
    if (!hasGarbage && d.includes("garbage input")) {
      hasGarbage = true;
    }
  }

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

    // Performance Optimization: Populate set with indexed loops
    const globalSet = new Set<string>();
    for (let i = 0; i < globalLocs.length; i++) {
      globalSet.add(String(globalLocs[i]).toUpperCase());
    }

    const extraLocs: string[] = [];
    const seenBuyer = new Set<string>();
    for (let i = 0; i < buyerLocs.length; i++) {
      const locUpper = String(buyerLocs[i]).toUpperCase();
      if (!seenBuyer.has(locUpper)) {
        seenBuyer.add(locUpper);
        if (!globalSet.has(locUpper)) {
          extraLocs.push(locUpper);
        }
      }
    }

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
    // Performance Optimization: Direct set lookup over conditions
    const buyerCondsSet = new Set<string>();
    const buyerCondsArr = Array.isArray(buyerCriteria.required_conditions) ? buyerCriteria.required_conditions : [];
    for (let i = 0; i < buyerCondsArr.length; i++) {
      buyerCondsSet.add(String(buyerCondsArr[i]).toLowerCase());
    }

    const globalConds = Array.isArray(globalTortRules.required_conditions) ? globalTortRules.required_conditions : [];
    for (let i = 0; i < globalConds.length; i++) {
      const gc = globalConds[i];
      if (!buyerCondsSet.has(String(gc).toLowerCase())) {
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
