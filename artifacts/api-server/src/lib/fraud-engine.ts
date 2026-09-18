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

// OPTIMIZATION: Static module constants to avoid re-allocating arrays and numbers per function invocation
const MS_PER_YEAR = 31557600000; // 365.25 * 24 * 60 * 60 * 1000
const ADULT_ONLY_CONDITIONS = ["mesothelioma", "parkinson", "metallosis", "gastroparesis"] as const;

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

  const dob = context.lead_data.date_of_birth as string;
  const diagDate = context.lead_data.diagnosis_date as string;

  // OPTIMIZATION: Parse ISO date strings directly into primitive millisecond timestamps with Date.parse()
  // to avoid heap allocations from `new Date()` wrapper objects.
  const birthTime = dob ? Date.parse(dob) : NaN;
  const diagTime = diagDate ? Date.parse(diagDate) : NaN;

  if (!Number.isNaN(birthTime) && !Number.isNaN(diagTime)) {
    const ageAtDiagnosis = (diagTime - birthTime) / MS_PER_YEAR;

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

    // OPTIMIZATION: Use Date.now() primitive numeric timestamp instead of `new Date()`
    if (diagTime > Date.now()) {
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
      const diagnosis = (context.lead_data.diagnosis as string || "").toLowerCase();
      // OPTIMIZATION: Re-use pre-allocated ADULT_ONLY_CONDITIONS array
      if (ADULT_ONLY_CONDITIONS.some((c) => diagnosis.includes(c))) {
        indicators.push({
          type: "IMPOSSIBLE_MEDICAL_TIMELINE",
          description: `Diagnosis "${context.lead_data.diagnosis}" is extremely rare in children under 5`,
          severity: "hard_block",
        });
        hardBlock = true;
        hardBlockReason = hardBlockReason || "IMPOSSIBLE_MEDICAL_TIMELINE";
        score += 100;
      }
    }
  }

  const exposureStart = context.lead_data.exposure_start as string;
  if (exposureStart && !Number.isNaN(birthTime)) {
    // OPTIMIZATION: Re-use birthTime and parse exposure date directly into timestamp
    const expTime = Date.parse(exposureStart);
    if (!Number.isNaN(expTime) && expTime < birthTime) {
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
    for (const flag of context.taxonomy_match.fraud_indicators) {
      if (flag === "TAXONOMY_MISMATCH") {
        indicators.push({
          type: "TAXONOMY_MISMATCH",
          description: `Physician specialty "${context.taxonomy_match.physician_specialty}" does not match diagnosis category "${context.taxonomy_match.diagnosis_category}"`,
          severity: "review",
        });
        score += 30;
      }
      if (flag === "PEDIATRIC_PHYSICIAN_ADULT_CONDITION") {
        indicators.push({
          type: "PEDIATRIC_PHYSICIAN_ADULT_CONDITION",
          description: "Pediatric physician listed for adult cancer/disease claim",
          severity: "review",
        });
        score += 50;
      }
      if (flag === "SPECIALTY_OUTSIDE_SCOPE") {
        indicators.push({
          type: "SPECIALTY_OUTSIDE_SCOPE",
          description: "Physician specialty is entirely outside scope of claimed diagnosis",
          severity: "review",
        });
        score += 35;
      }
      if (flag === "NON_MEDICAL_PROVIDER") {
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

  for (const err of context.tort_validation.errors) {
    if (err === "NO_EXPOSURE") {
      indicators.push({
        type: "INCONSISTENT_EXPOSURE",
        description: "Tort requires exposure evidence but none provided",
        severity: "soft",
      });
      score += 15;
    }
    if (err === "EXPOSURE_OUTSIDE_1953_1987") {
      indicators.push({
        type: "EXPOSURE_OUTSIDE_RANGE",
        description: "Camp Lejeune exposure must be between 1953-1987",
        severity: "review",
      });
      score += 30;
    }
  }

  const cappedScore = Math.min(score, 100);
  const hasFlags = indicators.length > 0;

  // OPTIMIZATION: Construct summary string using loop concatenation to avoid `.map().join()` temporary array allocation
  let summary = "No fraud indicators detected";
  if (hasFlags) {
    let typeList = "";
    for (let i = 0; i < indicators.length; i++) {
      if (i > 0) typeList += ", ";
      typeList += indicators[i]!.type;
    }
    summary = `${indicators.length} fraud indicator(s) found (score: ${cappedScore}/100): ${typeList}`;
  }

  return { hard_block: hardBlock, hard_block_reason: hardBlockReason, has_flags: hasFlags, fraud_score: cappedScore, indicators, summary };
}
