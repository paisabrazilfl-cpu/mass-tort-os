import { db, leadsTable, formConfigurationsTable } from "@workspace/db";
import { sql, desc, eq, and } from "drizzle-orm";
import { logger } from "./logger";

export interface PredictiveScore {
  lead_id: number;
  conversion_probability: number;
  risk_score: number;
  quality_tier: string;
  factors: { name: string; impact: number; description: string }[];
}

export interface ModelStats {
  // Renamed-in-spirit but kept for frontend compatibility:
  // total_training_samples = count of leads the heuristic has been applied to
  // (no actual ML training happens — this is a hand-tuned weighted-feature
  // scorer, so "training samples" was a misnomer; the front-end label was
  // changed to "Leads Scored").
  total_training_samples: number;
  feature_weights: Record<string, number>;
  // model_accuracy = real backtest accuracy of the binary good/bad prediction
  // (silver-or-better predicts a sign; bronze/unqualified predicts a reject)
  // measured against leads that have actually reached `signed` or `rejected`.
  // Returns 0 when there are too few terminal outcomes to report
  // meaningfully; see `evaluated_samples` and `accuracy_available`.
  model_accuracy: number;
  // New, honest fields:
  evaluated_samples: number;       // # leads with status in (signed, rejected)
  accuracy_available: boolean;     // false ⇒ not enough outcomes; UI should show "—"
  last_computed: string;           // when this stats payload was generated
  // Deprecated alias; kept so older frontends still find a value.
  // @deprecated use last_computed
  last_trained: string;
}

const ACCURACY_MIN_SAMPLES = 5;

interface TrainingRow {
  status: string;
  tort_type: string;
  fraud_score: number | null;
  npi_verified: boolean | null;
  diagnosis_confirmed: boolean;
  was_at_location: boolean;
  has_email: boolean;
  has_phone: boolean;
  has_address: boolean;
  ad_spend: number;
  source: string | null;
}

const FEATURE_WEIGHTS: Record<string, number> = {
  fraud_score_low: 0.25,
  npi_verified: 0.20,
  diagnosis_confirmed: 0.20,
  was_at_location: 0.15,
  has_complete_contact: 0.10,
  has_ad_spend: 0.05,
  known_source: 0.05,
};

function computeConversionScore(row: TrainingRow): number {
  let score = 0;

  if (row.fraud_score !== null && row.fraud_score < 30) score += FEATURE_WEIGHTS.fraud_score_low;
  else if (row.fraud_score !== null && row.fraud_score < 60) score += FEATURE_WEIGHTS.fraud_score_low * 0.5;

  if (row.npi_verified) score += FEATURE_WEIGHTS.npi_verified;
  if (row.diagnosis_confirmed) score += FEATURE_WEIGHTS.diagnosis_confirmed;
  if (row.was_at_location) score += FEATURE_WEIGHTS.was_at_location;

  const contactComplete = row.has_email && row.has_phone && row.has_address;
  if (contactComplete) score += FEATURE_WEIGHTS.has_complete_contact;
  else if (row.has_email || row.has_phone) score += FEATURE_WEIGHTS.has_complete_contact * 0.5;

  if (row.ad_spend > 0) score += FEATURE_WEIGHTS.has_ad_spend;
  if (row.source && row.source !== "unknown") score += FEATURE_WEIGHTS.known_source;

  return Math.min(score, 1.0);
}

function computeRiskScore(row: TrainingRow): number {
  let risk = 0;
  if (row.fraud_score !== null && row.fraud_score > 70) risk += 0.35;
  else if (row.fraud_score !== null && row.fraud_score > 40) risk += 0.15;
  if (!row.npi_verified) risk += 0.20;
  if (!row.diagnosis_confirmed) risk += 0.20;
  if (!row.was_at_location) risk += 0.15;
  if (!row.has_email && !row.has_phone) risk += 0.10;
  return Math.min(risk, 1.0);
}

function getQualityTier(conversionScore: number, riskScore: number): string {
  const net = conversionScore - riskScore * 0.5;
  if (net >= 0.7) return "platinum";
  if (net >= 0.5) return "gold";
  if (net >= 0.3) return "silver";
  if (net >= 0.1) return "bronze";
  return "unqualified";
}

// firmId guards against IDOR: callers must pass req.user!.firm_id so we
// verify the lead belongs to their firm before returning score data.
export async function scoreLeadPredictive(leadId: number, firmId?: number): Promise<PredictiveScore> {
  const where = firmId != null
    ? and(eq(leadsTable.id, leadId), eq(leadsTable.firm_id, firmId))
    : sql`${leadsTable.id} = ${leadId}`;
  const [lead] = await db.select().from(leadsTable).where(where);
  if (!lead) throw new Error(`Lead ${leadId} not found`);

  const row: TrainingRow = {
    status: lead.status,
    tort_type: lead.tort_type,
    fraud_score: lead.fraud_score,
    npi_verified: lead.npi_verified ?? false,
    diagnosis_confirmed: lead.diagnosis_confirmed,
    was_at_location: lead.was_at_location,
    has_email: !!lead.email,
    has_phone: !!lead.phone_primary || !!lead.phone,
    has_address: !!lead.street_address,
    ad_spend: lead.ad_spend ? parseFloat(lead.ad_spend) : 0,
    source: lead.source,
  };

  const conversionProb = computeConversionScore(row);
  const riskScore = computeRiskScore(row);
  const qualityTier = getQualityTier(conversionProb, riskScore);

  const factors: PredictiveScore["factors"] = [];
  if (row.fraud_score !== null) {
    factors.push({
      name: "Fraud Score",
      impact: row.fraud_score < 30 ? 1 : row.fraud_score < 60 ? 0 : -1,
      description: `Fraud score: ${row.fraud_score}/100`,
    });
  }
  if (row.npi_verified) factors.push({ name: "NPI Verified", impact: 1, description: "Provider NPI verified via NPPES" });
  else factors.push({ name: "NPI Not Verified", impact: -1, description: "No NPI verification on record" });
  if (row.diagnosis_confirmed) factors.push({ name: "Diagnosis Confirmed", impact: 1, description: "Diagnosis confirmed by provider" });
  else factors.push({ name: "Diagnosis Unconfirmed", impact: -1, description: "Diagnosis not yet confirmed" });
  if (row.was_at_location) factors.push({ name: "Location Verified", impact: 1, description: "Presence at exposure location confirmed" });
  if (!row.has_email && !row.has_phone) factors.push({ name: "Missing Contact", impact: -1, description: "No email or phone on file" });

  return { lead_id: leadId, conversion_probability: Math.round(conversionProb * 100), risk_score: Math.round(riskScore * 100), quality_tier: qualityTier, factors };
}

export async function getModelStats(firmId?: number): Promise<ModelStats> {
  const firmPred = firmId != null ? eq(leadsTable.firm_id, firmId) : undefined;

  const [counts] = await db.select({
    total: sql<number>`count(*)::int`,
  }).from(leadsTable).where(firmPred);

  // Real backtest: replay the scorer against every lead that has reached a
  // terminal outcome (signed | rejected) and compare its predicted quality
  // tier against the actual outcome. We treat silver-or-better as "predict
  // signed" and bronze/unqualified as "predict rejected" — that mirrors
  // how the rest of the app consumes the tier.
  const terminalLeads = await db.select({
    status: leadsTable.status,
    fraud_score: leadsTable.fraud_score,
    npi_verified: leadsTable.npi_verified,
    diagnosis_confirmed: leadsTable.diagnosis_confirmed,
    was_at_location: leadsTable.was_at_location,
    email: leadsTable.email,
    phone: leadsTable.phone,
    phone_primary: leadsTable.phone_primary,
    street_address: leadsTable.street_address,
    ad_spend: leadsTable.ad_spend,
    source: leadsTable.source,
    tort_type: leadsTable.tort_type,
  })
    .from(leadsTable)
    .where(
      firmPred
        ? and(sql`${leadsTable.status} in ('signed','rejected')`, firmPred)
        : sql`${leadsTable.status} in ('signed','rejected')`,
    );

  let correct = 0;
  for (const lead of terminalLeads) {
    const row: TrainingRow = {
      status: lead.status,
      tort_type: lead.tort_type,
      fraud_score: lead.fraud_score,
      npi_verified: lead.npi_verified ?? false,
      diagnosis_confirmed: lead.diagnosis_confirmed,
      was_at_location: lead.was_at_location,
      has_email: !!lead.email,
      has_phone: !!lead.phone_primary || !!lead.phone,
      has_address: !!lead.street_address,
      ad_spend: lead.ad_spend ? parseFloat(lead.ad_spend) : 0,
      source: lead.source,
    };
    const tier = getQualityTier(computeConversionScore(row), computeRiskScore(row));
    const predictedSigned = tier === "platinum" || tier === "gold" || tier === "silver";
    const actuallySigned = lead.status === "signed";
    if (predictedSigned === actuallySigned) correct++;
  }

  const evaluated = terminalLeads.length;
  const accuracyAvailable = evaluated >= ACCURACY_MIN_SAMPLES;
  const accuracy = accuracyAvailable ? correct / evaluated : 0;
  const now = new Date().toISOString();

  return {
    total_training_samples: counts.total,
    feature_weights: FEATURE_WEIGHTS,
    model_accuracy: accuracy,
    evaluated_samples: evaluated,
    accuracy_available: accuracyAvailable,
    last_computed: now,
    last_trained: now,
  };
}

export async function getBatchPredictions(limit = 50, firmId?: number): Promise<PredictiveScore[]> {
  const firmPred = firmId != null ? eq(leadsTable.firm_id, firmId) : undefined;
  const leads = await db
    .select({ id: leadsTable.id })
    .from(leadsTable)
    .where(firmPred)
    .orderBy(desc(leadsTable.created_at))
    .limit(limit);
  const results: PredictiveScore[] = [];
  for (const lead of leads) {
    try {
      results.push(await scoreLeadPredictive(lead.id, firmId));
    } catch (err) {
      logger.error({ err, lead_id: lead.id }, "Batch prediction failed for lead");
    }
  }
  return results;
}

export async function getTortPredictions(firmId?: number): Promise<{ tort_type: string; avg_conversion: number; avg_risk: number; count: number }[]> {
  // Build a label → canonical-id index from form_configurations so historic
  // leads whose `tort_type` holds the human label ("Roundup") get merged
  // into the same bucket as those holding the slug ("roundup"). Same root-
  // cause as the Decision-Engine fix, applied to the predictive analytics
  // endpoint so the By-Tort table doesn't show duplicate rows.
  const tortRows = await db
    .select({ id: formConfigurationsTable.id, label: formConfigurationsTable.label })
    .from(formConfigurationsTable);
  const idToLabel = new Map<string, string>();
  const labelToId = new Map<string, string>();
  for (const row of tortRows) {
    idToLabel.set(row.id, row.label);
    labelToId.set(row.label.toLowerCase(), row.id);
  }

  const firmPred = firmId != null ? eq(leadsTable.firm_id, firmId) : undefined;
  const leads = await db.select({
    id: leadsTable.id,
    tort_type: leadsTable.tort_type,
    fraud_score: leadsTable.fraud_score,
    npi_verified: leadsTable.npi_verified,
    diagnosis_confirmed: leadsTable.diagnosis_confirmed,
    was_at_location: leadsTable.was_at_location,
    email: leadsTable.email,
    phone: leadsTable.phone,
    phone_primary: leadsTable.phone_primary,
    street_address: leadsTable.street_address,
    ad_spend: leadsTable.ad_spend,
    source: leadsTable.source,
    status: leadsTable.status,
  }).from(leadsTable).where(firmPred);

  const byTort: Record<string, { conversions: number[]; risks: number[] }> = {};
  for (const lead of leads) {
    if (!lead.tort_type) continue;
    const row: TrainingRow = {
      status: lead.status,
      tort_type: lead.tort_type,
      fraud_score: lead.fraud_score,
      npi_verified: lead.npi_verified ?? false,
      diagnosis_confirmed: lead.diagnosis_confirmed,
      was_at_location: lead.was_at_location,
      has_email: !!lead.email,
      has_phone: !!lead.phone_primary || !!lead.phone,
      has_address: !!lead.street_address,
      ad_spend: lead.ad_spend ? parseFloat(lead.ad_spend) : 0,
      source: lead.source,
    };
    // Resolve to canonical slug: id match wins, then case-insensitive label
    // fallback. Unmapped values (renamed/orphan campaigns) keep the raw key
    // so they remain visible in the table rather than silently disappearing.
    const key = idToLabel.has(lead.tort_type)
      ? lead.tort_type
      : labelToId.get(lead.tort_type.toLowerCase()) ?? lead.tort_type;
    if (!byTort[key]) byTort[key] = { conversions: [], risks: [] };
    byTort[key].conversions.push(computeConversionScore(row));
    byTort[key].risks.push(computeRiskScore(row));
  }

  return Object.entries(byTort).map(([key, data]) => ({
    // Display the canonical campaign label when we have it, otherwise the
    // raw key so orphans are still surfaced (with their dirty value visible).
    tort_type: idToLabel.get(key) ?? key,
    avg_conversion: Math.round((data.conversions.reduce((a, b) => a + b, 0) / data.conversions.length) * 100),
    avg_risk: Math.round((data.risks.reduce((a, b) => a + b, 0) / data.risks.length) * 100),
    count: data.conversions.length,
  }));
}
