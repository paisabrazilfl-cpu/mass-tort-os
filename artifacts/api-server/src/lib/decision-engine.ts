/**
 * MTOS Decision Engine — convexity scoring for leads & tort portfolio.
 *
 * Implements the asymmetric-risk framework:
 *   1. Generate outcomes
 *   2. Asymmetry analysis (downside vs upside ratio)
 *   3. Ruin detection (hard filter)
 *   4. Signal vs noise
 *   5. Convexity classification
 *   6. Recommended action
 *
 * Pure functions only — no DB access. All inputs passed in.
 */

import type { Lead } from "@workspace/db";

export type Classification = "convex" | "neutral" | "concave";
export type Action = "execute" | "modify" | "reject" | "review";
export type Confidence = "low" | "medium" | "high";

export interface TortInputs {
  id: string;
  label: string;
  avg_settlement_low: number | null;
  avg_settlement_high: number | null;
  expected_duration_months: number | null;
  mdl_status: string | null;
  sol_months: number | null;
  rejection_conditions: string[];
  required_exposure: boolean;
  valid_diagnoses: string[];
}

export interface SourceInputs {
  name: string;
  cost_per_lead: number | null;
  historical_qualified_rate: number | null;
  historical_retained_rate: number | null;
}

export interface EngineSettings {
  default_attorney_hourly_cost: number;
  default_hours_per_lead: number;
  convex_ratio_threshold: number;
  concave_ratio_threshold: number;
  concentration_warning_pct: number;
}

export interface ScoreResult {
  classification: Classification;
  action: Action;
  rationale: string;
  ruin_flags: string[];
  downside_usd: number;
  upside_usd: number;
  ratio: number;
  confidence: Confidence;
}

/**
 * Detect ruin paths — irreversible failure conditions per the framework.
 * Each flag is a short machine-readable code; the rationale explains.
 */
export function detectRuinFlags(
  lead: Pick<Lead, "diagnosis" | "diagnosis_confirmed" | "exposure_start" | "state" | "tort_type" | "diagnosis_date" | "rejection_reason">,
  tort: TortInputs
): string[] {
  const flags: string[] = [];

  // 1. Statute of limitations expired
  if (tort.sol_months && (lead.diagnosis_date || lead.exposure_start)) {
    const startDate = lead.diagnosis_date
      ? new Date(lead.diagnosis_date)
      : lead.exposure_start
        ? new Date(lead.exposure_start)
        : null;
    if (startDate && !Number.isNaN(startDate.getTime())) {
      const ageMonths = (Date.now() - startDate.getTime()) / (1000 * 60 * 60 * 24 * 30.44);
      if (ageMonths > tort.sol_months) flags.push("sol_expired");
    }
  }

  // 2. MDL closed (no recovery vehicle)
  if (tort.mdl_status === "closed") flags.push("mdl_closed");

  // 3. Required diagnosis missing or not valid for this tort
  if (tort.valid_diagnoses.length > 0 && lead.diagnosis) {
    const dx = lead.diagnosis.toLowerCase().trim();
    const matches = tort.valid_diagnoses.some(d => dx.includes(d.toLowerCase()) || d.toLowerCase().includes(dx));
    if (!matches) flags.push("diagnosis_invalid");
  }

  // 4. Required exposure missing
  if (tort.required_exposure && !lead.exposure_start) {
    flags.push("exposure_missing");
  }

  // 5. Already rejected upstream
  if (lead.rejection_reason) flags.push("prior_rejection");

  return flags;
}

/**
 * Score a single lead. Pure function.
 */
export function scoreLead(
  lead: Pick<
    Lead,
    | "diagnosis"
    | "diagnosis_confirmed"
    | "exposure_start"
    | "state"
    | "tort_type"
    | "diagnosis_date"
    | "rejection_reason"
    | "source"
  >,
  tort: TortInputs,
  source: SourceInputs | null,
  settings: EngineSettings
): ScoreResult {
  // Step 3: Ruin detection FIRST — overrides everything
  const ruin_flags = detectRuinFlags(lead, tort);

  // Step 1+2: Compute downside / upside in USD
  const cpl = source?.cost_per_lead ?? 0;
  const workCost = settings.default_attorney_hourly_cost * settings.default_hours_per_lead;
  const downside_usd = cpl + workCost;

  const settlementMid =
    tort.avg_settlement_low && tort.avg_settlement_high
      ? (tort.avg_settlement_low + tort.avg_settlement_high) / 2
      : tort.avg_settlement_high ?? tort.avg_settlement_low ?? 0;

  // Diagnosis severity multiplier (cancer/death > chronic > acute)
  const dx = (lead.diagnosis || "").toLowerCase();
  let severityMult = 1.0;
  if (/cancer|carcinoma|lymphoma|leukemia|myeloma|sarcoma/.test(dx)) severityMult = 1.4;
  else if (/death|deceased|fatal/.test(dx)) severityMult = 1.6;
  else if (lead.diagnosis_confirmed) severityMult = 1.1;
  else severityMult = 0.7;

  const retainedRate = source?.historical_retained_rate ?? 0.3;
  const upside_usd = settlementMid * retainedRate * severityMult;

  // Step 5: Asymmetry ratio
  const ratio = downside_usd > 0 ? upside_usd / downside_usd : upside_usd > 0 ? Infinity : 0;

  // Confidence: low if any major input is missing
  let confidence: Confidence = "high";
  if (!source?.cost_per_lead || !tort.avg_settlement_low) confidence = "low";
  else if (!source?.historical_retained_rate || !tort.avg_settlement_high) confidence = "medium";

  // Step 6: Decision
  let classification: Classification;
  let action: Action;
  let rationale: string;

  if (ruin_flags.length > 0) {
    classification = "concave";
    action = "review";
    rationale = `Ruin path detected: ${ruin_flags.join(", ")}. Human review required — do not auto-reject.`;
  } else if (ratio === Infinity) {
    classification = "convex";
    action = "execute";
    rationale = `Unbounded asymmetry — upside present with effectively zero downside.`;
  } else if (ratio >= settings.convex_ratio_threshold) {
    classification = "convex";
    action = "execute";
    rationale = `Strong positive asymmetry (upside/downside = ${ratio.toFixed(1)}x). Scale exposure.`;
  } else if (ratio < settings.concave_ratio_threshold) {
    classification = "concave";
    action = "modify";
    rationale = `Weak asymmetry (${ratio.toFixed(1)}x). Reduce CPL, improve qualification, or pause source.`;
  } else {
    classification = "neutral";
    action = "modify";
    rationale = `Neutral asymmetry (${ratio.toFixed(1)}x). Monitor; not yet a clear convex bet.`;
  }

  if (confidence === "low") {
    rationale += ` (Low confidence: missing CPL or settlement data — calibrate inputs.)`;
  }

  return {
    classification,
    action,
    rationale,
    ruin_flags,
    downside_usd: Math.round(downside_usd * 100) / 100,
    upside_usd: Math.round(upside_usd * 100) / 100,
    ratio: Number.isFinite(ratio) ? Math.round(ratio * 100) / 100 : 9999,
    confidence,
  };
}

export interface PortfolioTortRow {
  tort_id: string;
  label: string;
  lead_count: number;
  total_spend_usd: number;
  qualified_count: number;
  retained_count: number;
  qualified_rate: number;
  retained_rate: number;
  classification: Classification;
  action: Action;
  rationale: string;
  ruin_flag_count: number;
  spend_pct: number;
}

export interface PortfolioSummary {
  total_spend_usd: number;
  tort_count: number;
  convex_count: number;
  concave_count: number;
  ruin_risk_lead_count: number;
  concentration_warning: { tort_id: string; pct: number } | null;
  rows: PortfolioTortRow[];
}

/**
 * Aggregate per-tort portfolio view.
 */
export function buildPortfolio(
  leadsByTort: Map<
    string,
    {
      lead_count: number;
      total_spend: number;
      qualified: number;
      retained: number;
      ruin_flag_count: number;
      convex_count: number;
      concave_count: number;
    }
  >,
  torts: Map<string, TortInputs>,
  settings: EngineSettings
): PortfolioSummary {
  const totalSpend = Array.from(leadsByTort.values()).reduce((s, r) => s + r.total_spend, 0);
  let totalConvex = 0;
  let totalConcave = 0;
  let totalRuin = 0;
  let concentration: { tort_id: string; pct: number } | null = null;

  const rows: PortfolioTortRow[] = [];
  for (const [tort_id, agg] of leadsByTort.entries()) {
    const tort = torts.get(tort_id);
    if (!tort) continue;
    const qualified_rate = agg.lead_count > 0 ? agg.qualified / agg.lead_count : 0;
    const retained_rate = agg.lead_count > 0 ? agg.retained / agg.lead_count : 0;
    const spend_pct = totalSpend > 0 ? (agg.total_spend / totalSpend) * 100 : 0;

    // Tort-level classification = majority of its leads
    let classification: Classification = "neutral";
    let action: Action = "modify";
    let rationale: string;
    if (agg.ruin_flag_count / Math.max(agg.lead_count, 1) > 0.3) {
      classification = "concave";
      action = "reject";
      rationale = `>30% of leads carry ruin flags. Pause intake and audit source quality.`;
    } else if (agg.convex_count > agg.concave_count && retained_rate > 0.15) {
      classification = "convex";
      action = "execute";
      rationale = `Majority convex leads with ${(retained_rate * 100).toFixed(0)}% retention. Scale.`;
    } else if (agg.concave_count > agg.convex_count) {
      classification = "concave";
      action = "modify";
      rationale = `Majority concave leads. Renegotiate CPL or improve filters.`;
    } else {
      rationale = `Mixed signal — collect more data before scaling or pausing.`;
    }

    if (tort.mdl_status === "closed") {
      classification = "concave";
      action = "reject";
      rationale = `MDL is closed — no active recovery vehicle. Cease intake.`;
    } else if (tort.mdl_status === "active_bellwether") {
      rationale += ` MDL has active bellwether — settlement signal strong.`;
    }

    if (classification === "convex") totalConvex++;
    if (classification === "concave") totalConcave++;
    totalRuin += agg.ruin_flag_count;

    if (spend_pct > settings.concentration_warning_pct && (!concentration || spend_pct > concentration.pct)) {
      concentration = { tort_id, pct: spend_pct };
    }

    rows.push({
      tort_id,
      label: tort.label,
      lead_count: agg.lead_count,
      total_spend_usd: Math.round(agg.total_spend * 100) / 100,
      qualified_count: agg.qualified,
      retained_count: agg.retained,
      qualified_rate: Math.round(qualified_rate * 10000) / 10000,
      retained_rate: Math.round(retained_rate * 10000) / 10000,
      classification,
      action,
      rationale,
      ruin_flag_count: agg.ruin_flag_count,
      spend_pct: Math.round(spend_pct * 100) / 100,
    });
  }

  rows.sort((a, b) => b.total_spend_usd - a.total_spend_usd);

  return {
    total_spend_usd: Math.round(totalSpend * 100) / 100,
    tort_count: rows.length,
    convex_count: totalConvex,
    concave_count: totalConcave,
    ruin_risk_lead_count: totalRuin,
    concentration_warning: concentration,
    rows,
  };
}
