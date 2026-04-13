export interface ExtractedFeatures {
  diagnosis_present?: boolean;
  exposure?: "yes" | "no" | "unclear";
  severity?: number;
  contradictions?: string[];
  tort_type?: string;
  exposure_period_years?: number;
  diagnosis_type?: string;
}

/**
 * Deterministic scoring engine — no AI involvement.
 * Score is 0–100 based on strict Boolean gate logic.
 */
export function scoreFeatures(f: ExtractedFeatures): number {
  let score = 0;

  // Gate 1: Confirmed diagnosis (40pts)
  if (f.diagnosis_present === true) score += 40;

  // Gate 2: Confirmed exposure (30pts)
  if (f.exposure === "yes") score += 30;
  else if (f.exposure === "unclear") score += 10;

  // Gate 3: Severity threshold (20pts)
  const severity = typeof f.severity === "number" ? f.severity : 0;
  if (severity > 0.7) score += 20;
  else if (severity > 0.5) score += 12;
  else if (severity > 0.3) score += 5;

  // Gate 4: No contradictions (10pts)
  const contradictions = Array.isArray(f.contradictions)
    ? f.contradictions.filter(Boolean)
    : [];
  if (contradictions.length === 0) score += 10;
  else if (contradictions.length === 1) score += 4;

  return Math.max(0, Math.min(score, 100));
}

export function scoreToVerdict(score: number): "strong" | "moderate" | "weak" | "disqualified" {
  if (score >= 80) return "strong";
  if (score >= 50) return "moderate";
  if (score >= 25) return "weak";
  return "disqualified";
}
