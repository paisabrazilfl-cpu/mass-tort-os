/**
 * DB-aware wrapper around the pure decision-engine library.
 * Loads tort, source, and settings from DB; persists score back to lead.
 */

import { db, leadsTable, formConfigurationsTable, leadSourcesTable, decisionEngineSettingsTable } from "@workspace/db";
import type { Lead } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import {
  scoreLead,
  buildPortfolio,
  type EngineSettings,
  type TortInputs,
  type SourceInputs,
  type ScoreResult,
  type PortfolioSummary,
} from "./decision-engine";
import { logger } from "./logger";

const DEFAULT_SETTINGS: EngineSettings = {
  default_attorney_hourly_cost: 250,
  default_hours_per_lead: 8,
  convex_ratio_threshold: 5,
  concave_ratio_threshold: 1.5,
  concentration_warning_pct: 40,
};

let cachedSettings: EngineSettings | null = null;
let cachedSettingsAt = 0;
const SETTINGS_TTL_MS = 30_000;

export async function getEngineSettings(): Promise<EngineSettings> {
  if (cachedSettings && Date.now() - cachedSettingsAt < SETTINGS_TTL_MS) {
    return cachedSettings;
  }
  try {
    const rows = await db.select().from(decisionEngineSettingsTable).limit(1);
    if (rows.length === 0) {
      // Seed singleton row
      await db
        .insert(decisionEngineSettingsTable)
        .values({ id: 1 })
        .onConflictDoNothing();
      cachedSettings = DEFAULT_SETTINGS;
    } else {
      const r = rows[0]!;
      cachedSettings = {
        default_attorney_hourly_cost: Number(r.default_attorney_hourly_cost),
        default_hours_per_lead: Number(r.default_hours_per_lead),
        convex_ratio_threshold: Number(r.convex_ratio_threshold),
        concave_ratio_threshold: Number(r.concave_ratio_threshold),
        concentration_warning_pct: r.concentration_warning_pct,
      };
    }
  } catch (e) {
    logger.error({ err: e }, "Failed to load decision engine settings; using defaults");
    cachedSettings = DEFAULT_SETTINGS;
  }
  cachedSettingsAt = Date.now();
  return cachedSettings;
}

export function invalidateSettingsCache() {
  cachedSettings = null;
  cachedSettingsAt = 0;
}

export async function updateEngineSettings(updates: Partial<{
  default_attorney_hourly_cost: number;
  default_hours_per_lead: number;
  convex_ratio_threshold: number;
  concave_ratio_threshold: number;
  concentration_warning_pct: number;
  ruin_auto_flag: boolean;
}>) {
  const dbUpdates: Record<string, unknown> = { updated_at: new Date() };
  if (updates.default_attorney_hourly_cost !== undefined)
    dbUpdates.default_attorney_hourly_cost = String(updates.default_attorney_hourly_cost);
  if (updates.default_hours_per_lead !== undefined)
    dbUpdates.default_hours_per_lead = String(updates.default_hours_per_lead);
  if (updates.convex_ratio_threshold !== undefined)
    dbUpdates.convex_ratio_threshold = String(updates.convex_ratio_threshold);
  if (updates.concave_ratio_threshold !== undefined)
    dbUpdates.concave_ratio_threshold = String(updates.concave_ratio_threshold);
  if (updates.concentration_warning_pct !== undefined)
    dbUpdates.concentration_warning_pct = updates.concentration_warning_pct;
  if (updates.ruin_auto_flag !== undefined)
    dbUpdates.ruin_auto_flag = updates.ruin_auto_flag;

  await db
    .insert(decisionEngineSettingsTable)
    .values({ id: 1, ...dbUpdates })
    .onConflictDoUpdate({ target: decisionEngineSettingsTable.id, set: dbUpdates });
  invalidateSettingsCache();
}

async function loadTortInputs(tort_id: string): Promise<TortInputs | null> {
  const rows = await db
    .select()
    .from(formConfigurationsTable)
    .where(eq(formConfigurationsTable.id, tort_id))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    label: row.label,
    avg_settlement_low: row.avg_settlement_low,
    avg_settlement_high: row.avg_settlement_high,
    expected_duration_months: row.expected_duration_months,
    mdl_status: row.mdl_status,
    sol_months: row.sol_months,
    rejection_conditions: (row.rejection_conditions as unknown as string[]) || [],
    required_exposure: row.required_exposure,
    valid_diagnoses: row.valid_diagnoses || [],
  };
}

async function loadSourceInputs(name: string | null): Promise<SourceInputs | null> {
  if (!name) return null;
  const rows = await db
    .select()
    .from(leadSourcesTable)
    .where(eq(leadSourcesTable.name, name))
    .limit(1);
  const row = rows[0];
  if (!row) return { name, cost_per_lead: null, historical_qualified_rate: null, historical_retained_rate: null };
  return {
    name: row.name,
    cost_per_lead: row.cost_per_lead ? Number(row.cost_per_lead) : null,
    historical_qualified_rate: row.historical_qualified_rate ? Number(row.historical_qualified_rate) : null,
    historical_retained_rate: row.historical_retained_rate ? Number(row.historical_retained_rate) : null,
  };
}

/**
 * Compute the score for a single lead and persist to DB. Returns the result.
 * Best-effort: errors are logged and swallowed so they don't break the lead lifecycle.
 */
export async function computeAndPersistLeadScore(leadId: number): Promise<ScoreResult | null> {
  try {
    const leadRows = await db.select().from(leadsTable).where(eq(leadsTable.id, leadId)).limit(1);
    const rawLead = leadRows[0];
    if (!rawLead) return null;
    // Decrypt PII/clinical fields (diagnosis, diagnosis_date, etc.) before scoring,
    // otherwise ruin-flag and severity logic operates on ciphertext.
    const { decryptLeadFields } = await import("./encryption");
    const lead = decryptLeadFields(rawLead as Record<string, any>, String(rawLead.id)) as typeof rawLead;

    const [tort, source, settings] = await Promise.all([
      loadTortInputs(lead.tort_type),
      loadSourceInputs(lead.source),
      getEngineSettings(),
    ]);

    if (!tort) {
      logger.warn({ leadId, tort_type: lead.tort_type }, "No tort config for lead; skipping convexity score");
      return null;
    }

    const result = scoreLead(lead, tort, source, settings);

    await db
      .update(leadsTable)
      .set({
        convexity_score: result.classification,
        convexity_action: result.action,
        convexity_rationale: result.rationale,
        convexity_ruin_flags: result.ruin_flags,
        convexity_downside_usd: String(result.downside_usd),
        convexity_upside_usd: String(result.upside_usd),
        convexity_ratio: String(result.ratio),
        convexity_confidence: result.confidence,
        convexity_computed_at: new Date(),
      })
      .where(eq(leadsTable.id, leadId));

    return result;
  } catch (e) {
    logger.error({ err: e, leadId }, "computeAndPersistLeadScore failed");
    return null;
  }
}

/**
 * Build the admin portfolio aggregation across all torts.
 */
export async function buildPortfolioSummary(): Promise<PortfolioSummary> {
  const settings = await getEngineSettings();

  // All torts
  const tortRows = await db.select().from(formConfigurationsTable);
  const torts = new Map<string, TortInputs>();
  for (const row of tortRows) {
    torts.set(row.id, {
      id: row.id,
      label: row.label,
      avg_settlement_low: row.avg_settlement_low,
      avg_settlement_high: row.avg_settlement_high,
      expected_duration_months: row.expected_duration_months,
      mdl_status: row.mdl_status,
      sol_months: row.sol_months,
      rejection_conditions: (row.rejection_conditions as unknown as string[]) || [],
      required_exposure: row.required_exposure,
      valid_diagnoses: row.valid_diagnoses || [],
    });
  }

  // Aggregate leads by tort
  const aggRows = await db
    .select({
      tort_type: leadsTable.tort_type,
      lead_count: sql<number>`count(*)::int`,
      total_spend: sql<number>`coalesce(sum(${leadsTable.ad_spend}), 0)::float`,
      qualified: sql<number>`count(*) filter (where ${leadsTable.status} in ('qualified','accepted','retained','signed'))::int`,
      retained: sql<number>`count(*) filter (where ${leadsTable.status} in ('retained','signed'))::int`,
      ruin_flag_count: sql<number>`count(*) filter (where jsonb_array_length(${leadsTable.convexity_ruin_flags}) > 0)::int`,
      convex_count: sql<number>`count(*) filter (where ${leadsTable.convexity_score} = 'convex')::int`,
      concave_count: sql<number>`count(*) filter (where ${leadsTable.convexity_score} = 'concave')::int`,
    })
    .from(leadsTable)
    .groupBy(leadsTable.tort_type);

  const byTort = new Map<string, {
    lead_count: number;
    total_spend: number;
    qualified: number;
    retained: number;
    ruin_flag_count: number;
    convex_count: number;
    concave_count: number;
  }>();
  for (const r of aggRows) {
    byTort.set(r.tort_type, {
      lead_count: Number(r.lead_count),
      total_spend: Number(r.total_spend),
      qualified: Number(r.qualified),
      retained: Number(r.retained),
      ruin_flag_count: Number(r.ruin_flag_count),
      convex_count: Number(r.convex_count),
      concave_count: Number(r.concave_count),
    });
  }

  return buildPortfolio(byTort, torts, settings);
}

/**
 * Recompute scores for all leads (admin tool).
 */
export async function recomputeAllScores(): Promise<{ scanned: number; scored: number }> {
  const all = await db.select({ id: leadsTable.id }).from(leadsTable);
  let scored = 0;
  for (const { id } of all) {
    const r = await computeAndPersistLeadScore(id);
    if (r) scored++;
  }
  return { scanned: all.length, scored };
}
