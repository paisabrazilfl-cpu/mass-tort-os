import { TaxonomyMatchResult } from "./taxonomy-engine";
import { TortValidationResult } from "./tort-engine";

export type FraudSeverity = "none" | "soft" | "review" | "hard_block";

export interface FraudIndicator {
  type: string;
  description: string;
  severity: FraudSeverity;
}

export interface FraudDetectionResult {
  hard_block: boolean;
  hard_block_reason: string | null;
  has_flags: boolean;
  fraud_score: number;
  indicators: FraudIndicator[];
  summary: string;
}

// Hoisted constants & performance helpers
const ADULT_ONLY_CONDITIONS = ["mesothelioma", "parkinson", "metallosis", "gastroparesis"];
const MS_PER_YEAR = 365.25 * 24 * 60 * 60 * 1000;

export function runFraudDetection(context: {
  lead_data: Record<string, unknown>;
  tort_validation: TortValidationResult;
  taxonomy_match: TaxonomyMatchResult | null;
  npi_found: boolean;
}): FraudDetectionResult {
  const indicators: FraudIndicator[] = [];
  let score = 0;
  let hardBlock = false;
  let hardBlockReason: string | null = null;

  const dob = context.lead_data.date_of_birth as string | undefined;
  const diagDate = context.lead_data.diagnosis_date as string | undefined;

  let birthTime = NaN;
  if (dob) {
    birthTime = Date.parse(dob);
  }

  if (diagDate) {
    const diagnosisTime = Date.parse(diagDate);
    if (!isNaN(birthTime) && !isNaN(diagnosisTime)) {
      const ageAtDiagnosis = (diagnosisTime - birthTime) / MS_PER_YEAR;

      if (ageAtDiagnosis < 0) {
        indicators.push({
          type: "IMPOSSIBLE_TIMELINE",
          description: "Diagnosis date is before date of birth",
          severity: "hard_block",
        });
        hardBlock = true;
        hardBlockReason = "IMPOSSIBLE_TIMELINE";
        score += 100;
      }

      if (diagnosisTime > Date.now()) {
        indicators.push({
          type: "FUTURE_DIAGNOSIS_DATE",
          description: "Diagnosis date is in the future",
          severity: "hard_block",
        });
        hardBlock = true;
        hardBlockReason = hardBlockReason || "FUTURE_DIAGNOSIS_DATE";
        score += 100;
      }

      if (!hardBlock && ageAtDiagnosis < 5) {
        const rawDiag = context.lead_data.diagnosis as string | undefined;
        if (rawDiag) {
          const diagnosis = rawDiag.toLowerCase();
          for (let i = 0; i < ADULT_ONLY_CONDITIONS.length; i++) {
            if (diagnosis.includes(ADULT_ONLY_CONDITIONS[i])) {
              indicators.push({
                type: "IMPOSSIBLE_MEDICAL_TIMELINE",
                description: `Diagnosis "${rawDiag}" is extremely rare in children under 5`,
                severity: "hard_block",
              });
              hardBlock = true;
              hardBlockReason = hardBlockReason || "IMPOSSIBLE_MEDICAL_TIMELINE";
              score += 100;
              break;
            }
          }
        }
      }
    }
  }

  const exposureStart = context.lead_data.exposure_start as string | undefined;
  if (exposureStart && !isNaN(birthTime)) {
    const expTime = Date.parse(exposureStart);
    if (!isNaN(expTime) && expTime < birthTime) {
      indicators.push({
        type: "EXPOSURE_BEFORE_BIRTH",
        description: "Claimed exposure start date is before date of birth",
        severity: "hard_block",
      });
      hardBlock = true;
      hardBlockReason = hardBlockReason || "EXPOSURE_BEFORE_BIRTH";
      score += 100;
    }
  }

  if (context.taxonomy_match) {
    const flags = context.taxonomy_match.fraud_indicators;
    for (let i = 0; i < flags.length; i++) {
      const flag = flags[i];
      if (flag === "TAXONOMY_MISMATCH") {
        indicators.push({
          type: "TAXONOMY_MISMATCH",
          description: `Physician specialty "${context.taxonomy_match.physician_specialty}" does not match diagnosis category "${context.taxonomy_match.diagnosis_category}"`,
          severity: "review",
        });
        score += 30;
      } else if (flag === "PEDIATRIC_PHYSICIAN_ADULT_CONDITION") {
        indicators.push({
          type: "PEDIATRIC_PHYSICIAN_ADULT_CONDITION",
          description: "Pediatric physician listed for adult cancer/disease claim",
          severity: "review",
        });
        score += 50;
      } else if (flag === "SPECIALTY_OUTSIDE_SCOPE") {
        indicators.push({
          type: "SPECIALTY_OUTSIDE_SCOPE",
          description: "Physician specialty is entirely outside scope of claimed diagnosis",
          severity: "review",
        });
        score += 35;
      } else if (flag === "NON_MEDICAL_PROVIDER") {
        indicators.push({
          type: "NON_MEDICAL_PROVIDER",
          description: "Listed provider is not a medical doctor (dentist, optometrist, etc.)",
          severity: "review",
        });
        score += 60;
      }
    }
  }

  if (!context.npi_found && context.lead_data.physician_first_name && context.lead_data.physician_last_name) {
    indicators.push({
      type: "NPI_NOT_FOUND",
      description: "Physician could not be found in NPI registry",
      severity: "review",
    });
    score += 20;
  }

  if (!context.tort_validation.diagnosis_match) {
    indicators.push({
      type: "INVALID_TORT_MAPPING",
      description: `Diagnosis "${context.lead_data.diagnosis}" does not match any valid diagnosis for tort "${context.lead_data.tort_type}"`,
      severity: "review",
    });
    score += 25;
  }

  const errors = context.tort_validation.errors;
  for (let i = 0; i < errors.length; i++) {
    const err = errors[i];
    if (err === "NO_EXPOSURE") {
      indicators.push({
        type: "INCONSISTENT_EXPOSURE",
        description: "Tort requires exposure evidence but none provided",
        severity: "soft",
      });
      score += 15;
    } else if (err === "EXPOSURE_OUTSIDE_1953_1987") {
      indicators.push({
        type: "EXPOSURE_OUTSIDE_RANGE",
        description: "Camp Lejeune exposure must be between 1953-1987",
        severity: "review",
      });
      score += 30;
    }
  }

  const cappedScore = score < 100 ? score : 100;
  const numIndicators = indicators.length;
  const hasFlags = numIndicators > 0;

  let summary = "";
  if (numIndicators === 0) {
    summary = "No fraud indicators detected";
  } else {
    let types = "";
    for (let i = 0; i < numIndicators; i++) {
      if (i > 0) types += ", ";
      types += indicators[i].type;
    }
    summary = `${numIndicators} fraud indicator(s) found (score: ${cappedScore}/100): ${types}`;
  }

  return { hard_block: hardBlock, hard_block_reason: hardBlockReason, has_flags: hasFlags, fraud_score: cappedScore, indicators, summary };
}
