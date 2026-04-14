import { TortValidationResult } from "./tort-engine";
import { TaxonomyMatchResult } from "./taxonomy-engine";
import { FraudDetectionResult } from "./fraud-engine";
import { TORT_REGISTRY } from "./tort-engine";

export type ArbiterDecision = "ACCEPTED" | "REJECTED" | "TO_BE_REVIEWED";

export interface ArbiterResult {
  decision: ArbiterDecision;
  reason: string;
  deciding_engine: string;
}

export function finalArbiter(context: {
  compliance_passed: boolean;
  compliance_errors: string[];
  validation_passed: boolean;
  validation_errors: string[];
  tort_validation: TortValidationResult;
  taxonomy_match: TaxonomyMatchResult | null;
  fraud_result: FraudDetectionResult;
  npi_found: boolean;
  diagnosis_confirmed: boolean;
  exposure_confirmed: boolean;
  exposure_start?: string;
  conflict_reject: boolean;
  conflict_review: boolean;
}): ArbiterResult {

  if (!context.compliance_passed) {
    return {
      decision: "REJECTED",
      reason: `Compliance failure: ${context.compliance_errors.join(", ")}`,
      deciding_engine: "COMPLIANCE_ENGINE",
    };
  }

  if (!context.validation_passed) {
    return {
      decision: "REJECTED",
      reason: `Validation failure: ${context.validation_errors.join(", ")}`,
      deciding_engine: "VALIDATION_ENGINE",
    };
  }

  if (context.conflict_reject) {
    return {
      decision: "REJECTED",
      reason: "Hard conflict detected",
      deciding_engine: "CONFLICT_ENGINE",
    };
  }

  if (context.conflict_review) {
    return {
      decision: "TO_BE_REVIEWED",
      reason: "Conflict detected requiring review",
      deciding_engine: "CONFLICT_ENGINE",
    };
  }

  if (context.fraud_result.hard_block) {
    return {
      decision: "REJECTED",
      reason: `Hard fraud block: ${context.fraud_result.hard_block_reason}`,
      deciding_engine: "FRAUD_ENGINE",
    };
  }

  if (context.tort_validation.errors.includes("UNKNOWN_TORT_TYPE")) {
    return {
      decision: "REJECTED",
      reason: "Unknown tort type",
      deciding_engine: "TORT_ENGINE",
    };
  }

  if (!context.diagnosis_confirmed) {
    return {
      decision: "REJECTED",
      reason: "Diagnosis not confirmed by physician",
      deciding_engine: "TORT_ENGINE",
    };
  }

  const tort = context.tort_validation.tort_id ? TORT_REGISTRY[context.tort_validation.tort_id] : null;
  if (tort?.required_exposure && !context.exposure_confirmed && !context.exposure_start) {
    return {
      decision: "REJECTED",
      reason: "Exposure required but not confirmed",
      deciding_engine: "TORT_ENGINE",
    };
  }

  if (context.tort_validation.errors.includes("EXPOSURE_OUTSIDE_1953_1987")) {
    return {
      decision: "REJECTED",
      reason: "Exposure dates outside valid range",
      deciding_engine: "TORT_ENGINE",
    };
  }

  if (context.fraud_result.has_flags && context.fraud_result.indicators.some(i => i.severity === "review")) {
    return {
      decision: "TO_BE_REVIEWED",
      reason: `Fraud flags require review: ${context.fraud_result.indicators.filter(i => i.severity === "review").map(i => i.type).join(", ")}`,
      deciding_engine: "FRAUD_ENGINE",
    };
  }

  if (context.taxonomy_match && !context.taxonomy_match.matched && context.taxonomy_match.diagnosis_category) {
    return {
      decision: "TO_BE_REVIEWED",
      reason: `Taxonomy mismatch: ${context.taxonomy_match.physician_specialty} vs expected for ${context.taxonomy_match.diagnosis_category}`,
      deciding_engine: "TAXONOMY_ENGINE",
    };
  }

  if (!context.npi_found && context.taxonomy_match === null) {
    return {
      decision: "TO_BE_REVIEWED",
      reason: "NPI lookup failed or physician not found",
      deciding_engine: "NPI_ENGINE",
    };
  }

  if (!context.tort_validation.diagnosis_match) {
    return {
      decision: "TO_BE_REVIEWED",
      reason: "Diagnosis does not match tort valid diagnoses",
      deciding_engine: "TORT_ENGINE",
    };
  }

  return {
    decision: "ACCEPTED",
    reason: "Lead fully validated",
    deciding_engine: "FINAL_ARBITER",
  };
}
