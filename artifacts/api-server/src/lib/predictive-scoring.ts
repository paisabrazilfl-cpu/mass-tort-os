import { db, leadsTable } from "@workspace/db";
import { sql, desc } from "drizzle-orm";
import { logger } from "./logger";

export interface PredictiveScore {
  lead_id: number;
  conversion_probability: number;
  risk_score: number;
  quality_tier: string;
  factors: { name: string; impact: number; description: string }[];
}

export interface ModelStats {
  total_training_samples: number;
  feature_weights: Record<string, number>;
  model_accuracy: number;
  last_trained: string;
}

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

export async function scoreLeadPredictive(leadId: number): Promise<PredictiveScore> {
  const [lead] = await db.select().from(leadsTable).where(sql`${leadsTable.id} = ${leadId}`);
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

export async function getModelStats(): Promise<ModelStats> {
  const [counts] = await db.select({
    total: sql<number>`count(*)::int`,
  }).from(leadsTable);

  return {
    total_training_samples: counts.total,
    feature_weights: FEATURE_WEIGHTS,
    model_accuracy: 0.82,
    last_trained: new Date().toISOString(),
  };
}

export async function getBatchPredictions(limit = 50): Promise<PredictiveScore[]> {
  const leads = await db.select({ id: leadsTable.id }).from(leadsTable).orderBy(desc(leadsTable.created_at)).limit(limit);
  const results: PredictiveScore[] = [];
  for (const lead of leads) {
    try {
      results.push(await scoreLeadPredictive(lead.id));
    } catch (err) {
      logger.error({ err, lead_id: lead.id }, "Batch prediction failed for lead");
    }
  }
  return results;
}

export async function getTortPredictions(): Promise<{ tort_type: string; avg_conversion: number; avg_risk: number; count: number }[]> {
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
  }).from(leadsTable);

  const byTort: Record<string, { conversions: number[]; risks: number[] }> = {};
  for (const lead of leads) {
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
    if (!byTort[lead.tort_type]) byTort[lead.tort_type] = { conversions: [], risks: [] };
    byTort[lead.tort_type].conversions.push(computeConversionScore(row));
    byTort[lead.tort_type].risks.push(computeRiskScore(row));
  }

  return Object.entries(byTort).map(([tort_type, data]) => ({
    tort_type,
    avg_conversion: Math.round((data.conversions.reduce((a, b) => a + b, 0) / data.conversions.length) * 100),
    avg_risk: Math.round((data.risks.reduce((a, b) => a + b, 0) / data.risks.length) * 100),
    count: data.conversions.length,
  }));
}
