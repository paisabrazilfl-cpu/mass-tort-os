/**
 * Outbound caller-context builder.
 *
 * When we place an OUTBOUND voice call to someone already in the CRM, the
 * agent should already know who it is calling — name, contact details, the
 * tort, and everything we have captured so far — so it can greet them by
 * name and CONFIRM facts instead of re-asking from scratch.
 *
 * This loads the lead, decrypts its PII (AAD bound to the lead id), and
 * produces two things:
 *   - `variableValues`: a flat `lead_*` map injected into Vapi
 *     `assistantOverrides.variableValues` so any `{{lead_first_name}}`
 *     style placeholder resolves.
 *   - `summary`: a human-readable block injected as `{{caller_context}}`
 *     into the shared prompt's KNOWN CALLER section.
 *
 * Per the operator's choice, we send EVERYTHING meaningful in the record.
 * Purely internal/system columns (hashes, encryption artifacts, scoring
 * internals, fraud internals, raw consent tokens) are intentionally
 * excluded — they are not useful on a call and would only add noise.
 */
import { db, leadsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { decryptLeadFields } from "../encryption";
import { TORT_REGISTRY } from "../tort-engine";

/** Ordered, human-meaningful fields to surface to the agent. */
const FIELD_LABELS: Array<{ key: string; label: string }> = [
  { key: "first_name", label: "First name" },
  { key: "last_name", label: "Last name" },
  { key: "name", label: "Full name" },
  { key: "date_of_birth", label: "Date of birth" },
  { key: "phone", label: "Phone" },
  { key: "phone_primary", label: "Primary phone" },
  { key: "email", label: "Email" },
  { key: "street_address", label: "Street address" },
  { key: "city", label: "City" },
  { key: "state", label: "State" },
  { key: "zip", label: "ZIP" },
  { key: "status", label: "Lead status" },
  { key: "contact_preference", label: "Preferred contact method" },
  { key: "diagnosis", label: "Diagnosis" },
  { key: "diagnosis_type", label: "Diagnosis type" },
  { key: "diagnosis_date", label: "Diagnosis date" },
  { key: "exposure_start", label: "Exposure start" },
  { key: "exposure_end", label: "Exposure end" },
  { key: "location_name", label: "Exposure location" },
  { key: "medications", label: "Medications / products" },
  { key: "physician_first_name", label: "Physician first name" },
  { key: "physician_last_name", label: "Physician last name" },
  { key: "physician_full_address", label: "Physician address" },
  { key: "physician_contact_info", label: "Physician contact" },
  { key: "hospital_name", label: "Hospital" },
  { key: "hospital_contact_info", label: "Hospital contact" },
  { key: "notes", label: "Notes" },
];

function asText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const s = typeof value === "string" ? value : String(value);
  const trimmed = s.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export interface LeadCallContext {
  /** Flat `lead_*` map for assistantOverrides.variableValues. */
  variableValues: Record<string, string>;
  /** Human-readable block for the `{{caller_context}}` prompt placeholder. */
  summary: string;
  /** Resolved tort id for the lead (for call_logs attribution). */
  tortType: string | null;
}

/**
 * Build the outbound caller context for a lead. Returns null when the lead
 * does not exist (or is out of the given firm scope). The optional
 * `firmId` enforces tenancy — pass the operator's firm so a cross-firm
 * lead id cannot be enriched.
 */
export async function buildLeadCallContext(
  leadId: number,
  firmId: number | null,
): Promise<LeadCallContext | null> {
  const rows = await db.select().from(leadsTable).where(eq(leadsTable.id, leadId)).limit(1);
  const row = rows[0];
  if (!row) return null;
  if (firmId !== null && row.firm_id !== null && row.firm_id !== firmId) return null;

  const lead = decryptLeadFields(row as Record<string, unknown>, String(row.id));

  const variableValues: Record<string, string> = {};
  const lines: string[] = [];

  const tortId = asText(lead.tort_type);
  const tortDef = tortId ? TORT_REGISTRY[tortId] : null;
  const tortLabel = tortDef?.label ?? tortId;
  if (tortLabel) {
    variableValues.lead_tort = tortLabel;
    lines.push(`Tort / claim program: ${tortLabel}`);
  }

  for (const { key, label } of FIELD_LABELS) {
    const text = asText((lead as Record<string, unknown>)[key]);
    if (text === null) continue;
    variableValues[`lead_${key}`] = text;
    lines.push(`${label}: ${text}`);
  }

  const summary = lines.length > 0 ? lines.join("\n") : "";
  return { variableValues, summary, tortType: tortId };
}
