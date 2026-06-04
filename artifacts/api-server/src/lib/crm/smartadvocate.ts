import { and, desc, eq, ilike } from "drizzle-orm";
import { db, integrationsTable, leadsTable } from "@workspace/db";
import { decryptLeadFields } from "../encryption";
import { getIntegrationCredentialsById } from "../../routes/integrations";
import { auditLog } from "../audit";
import { logger } from "../logger";

const DEFAULT_CASE_PUSH_URL = "https://api.smartadvocate.com/getcaseinfo/caserelinfoaspx.aspx";
const DEFAULT_DOC_UPLOAD_URL = "https://api.smartadvocate.com/SASVC/SAWebservice.svc/Receiver/uploaddocument";
const DEFAULT_TENANT_ID = "1618";
const DEFAULT_CASE_TYPE = "Roundup Herbicide";
const DEFAULT_CASE_GROUP = "Toxic Torts";
const DEFAULT_CASE_SUBTYPE = "Non Hodgkin Lymphoma";
const DEFAULT_MAIN_STATUS = "Pre-Lit 00.0 New Intake - Send Welcome Text/Email";
const DEFAULT_INCIDENT_TYPE = "Toxic Torts";
const DEFAULT_DEFENDANT = "Monsanto Company";
const DEFAULT_REFERRED_BY = "Becker Law";

type JsonRecord = Record<string, unknown>;

type SmartAdvocateConfig = {
  tenant_id?: string | number | null;
  case_type?: string | null;
  case_group?: string | null;
  case_subtype?: string | null;
  main_status?: string | null;
  incident_type?: string | null;
  default_defendant?: string | null;
  referred_by?: string | null;
  campaign_name?: string | null;
  paid_advertisement?: string | null;
  tort_filter?: string | null;
  batch_limit?: number | null;
  allow_review_required?: boolean | null;
  static_fields?: Record<string, unknown> | null;
};

type CandidatePath = string | Array<string>;

type MappingSpec = string | number | boolean | null | { field?: string; value?: unknown; default?: unknown };

export interface SmartAdvocatePushOutcome {
  ok: boolean;
  integrationId: number;
  leadId: number;
  status: number;
  responseBody?: string;
  requestUrl: string;
  skipped?: string;
}

function clean(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function safeJson(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function readUserConfig(row: typeof integrationsTable.$inferSelect): SmartAdvocateConfig {
  const cfg = safeJson(row.config);
  const userConfig = safeJson(cfg.userConfig);
  return userConfig as SmartAdvocateConfig;
}

function normalizeUrl(url: string | null | undefined): string {
  const base = clean(url) || DEFAULT_CASE_PUSH_URL;
  return base.replace(/\/+$/, "");
}

function normalizeDocUploadUrl(url: string | null | undefined): string {
  const base = clean(url) || DEFAULT_DOC_UPLOAD_URL;
  return base.replace(/\/+$/, "");
}

function isoDate(value: unknown): string {
  const raw = clean(value);
  if (!raw) return "";
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return raw;
  return d.toISOString().slice(0, 10);
}

function yesNo(value: unknown): string {
  if (value === true || value === "true" || value === 1 || value === "1" || value === "yes") return "Yes";
  if (value === false || value === "false" || value === 0 || value === "0" || value === "no") return "No";
  return clean(value);
}

function getPath(source: Record<string, unknown>, path: string): unknown {
  const segments = path.split(".").map((s) => s.trim()).filter(Boolean);
  let cur: unknown = source;
  for (const seg of segments) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

function hasMeaningfulValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  return true;
}

function firstValue(lead: Record<string, unknown>, candidates: CandidatePath[]): unknown {
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      const nested = firstValue(lead, candidate);
      if (hasMeaningfulValue(nested)) return nested;
      continue;
    }
    const direct = getPath(lead, candidate);
    if (hasMeaningfulValue(direct)) return direct;
  }
  return undefined;
}

function firstText(lead: Record<string, unknown>, candidates: CandidatePath[]): string {
  return clean(firstValue(lead, candidates));
}

function firstDate(lead: Record<string, unknown>, candidates: CandidatePath[]): string {
  return isoDate(firstValue(lead, candidates));
}

function firstYesNo(lead: Record<string, unknown>, candidates: CandidatePath[]): string {
  return yesNo(firstValue(lead, candidates));
}

function isTruthy(value: unknown): boolean {
  if (value === true || value === 1) return true;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on";
  }
  return false;
}

function leadLooksLikeRoundUp(lead: Record<string, unknown>, cfg: SmartAdvocateConfig): boolean {
  const tort = clean(lead.tort_type).toLowerCase();
  const filter = clean(cfg.tort_filter).toLowerCase();
  if (filter) return tort.includes(filter);
  return tort.includes("roundup") || tort.includes("round up");
}

function buildCaseDetails(lead: Record<string, unknown>): string {
  const diagnosis = firstText(lead, ["diagnosis", "custom_fields.Diagnosis of Non-Hodgkin’s Lymphoma (or subtype)"]);
  const diagnosisType = firstText(lead, ["diagnosis_type", "custom_fields.Specific type of Leukemia/Lymphoma", "custom_fields.If Yes, What type of Leukemia/Lymphoma?"]);
  const exposureLocation = firstText(lead, ["location_name", "custom_fields.Where did your exposure to Roundup take place?", "custom_fields.In what county was the injured party exposed?"]);
  const physician = firstText(lead, ["physician_contact_info", "custom_fields.What is the name and location of the doctor and facility who made the cancer diagnosis?"]);
  const treatmentFacility = firstText(lead, ["hospital_contact_info", "custom_fields.What is the name and location of the doctor and facility who provided the cancer treatment?"]);
  const lines = [
    `Lead ID: ${clean(lead.id)}`,
    `Tort Type: ${clean(lead.tort_type)}`,
    `Diagnosis: ${diagnosis}`,
    `Diagnosis Type: ${diagnosisType}`,
    `Diagnosis Date: ${firstDate(lead, ["diagnosis_date", "custom_fields.When were they diagnosed with the Leukemia/Lymphoma?"])}`,
    `Diagnosis Confirmed: ${firstYesNo(lead, ["diagnosis_confirmed", "custom_fields.Have you or a loved one been diagnosed with NHL?"])}`,
    `Exposure Start: ${firstDate(lead, ["exposure_start", "custom_fields.What year did you first start using Roundup?"])}`,
    `Exposure End: ${firstDate(lead, ["exposure_end", "custom_fields.What year did you/loved one stop using roundup?"])}`,
    `Exposure Location: ${exposureLocation}`,
    `Location / Incident State: ${firstText(lead, ["state", "custom_fields.Exposed in California or Hawaii?"])}`,
    `Diagnosing Physician / Facility: ${physician}`,
    `Treatment Facility: ${treatmentFacility}`,
    `Source: ${clean(lead.source)}`,
    `TCPA Consent: ${firstYesNo(lead, ["tcpa_consent"])}`,
    `TrustedForm Cert: ${firstText(lead, ["trustedform_cert_url"])}`,
    `Notes: ${clean(lead.notes)}`,
  ].filter((line) => !line.endsWith(": "));
  return lines.join("\n");
}

function getLeadPushSkipReason(lead: Record<string, unknown>, cfg: SmartAdvocateConfig): string | null {
  const status = clean(lead.status).toLowerCase();
  if (status === "rejected") return "rejected_status";
  if ((status === "review_required" || status === "pending_review") && !isTruthy(cfg.allow_review_required)) {
    return "review_required_status";
  }

  const firstName = firstText(lead, ["first_name", "custom_fields.First Name of the Caller", "custom_fields.Injured party's first name"]);
  const lastName = firstText(lead, ["last_name", "custom_fields.Last Name of the Caller", "custom_fields.Injured party's last name"]);
  const phone = firstText(lead, ["phone_primary", "phone", "custom_fields.Alternate Contact Telephone Number"]);
  const email = firstText(lead, ["email", "custom_fields.Primary Email of Caller"]);
  if (!firstName || !lastName) return "missing_name";
  if (!phone && !email) return "missing_contact";
  return null;
}

function buildDefaultPayload(
  lead: Record<string, unknown>,
  apiKey: string,
  cfg: SmartAdvocateConfig,
): Record<string, string> {
  const firstName = firstText(lead, ["first_name", "custom_fields.First Name of the Caller", "custom_fields.Injured party's first name"]);
  const middleName = firstText(lead, ["middle_name", "custom_fields.Injured party middle name", "custom_fields.Injured_MiddleName"]);
  const lastName = firstText(lead, ["last_name", "custom_fields.Last Name of the Caller", "custom_fields.Injured party's last name"]);
  const phone = firstText(lead, ["phone_primary", "phone", "custom_fields.Alternate Contact Telephone Number", "custom_fields.Emergency Contact Phone"]);
  const birthDate = firstDate(lead, ["date_of_birth", "custom_fields.Birth Date of Caller", "custom_fields.Date of Birth"]);
  const contactEmail = firstText(lead, ["email", "custom_fields.Primary Email of Caller"]);
  const address = firstText(lead, ["street_address", "custom_fields.Mailing Address 1"]);
  const city = firstText(lead, ["city", "custom_fields.City"]);
  const state = firstText(lead, ["state", "custom_fields.State", "custom_fields.Exposed in California or Hawaii?"]);
  const zip = firstText(lead, ["zip", "custom_fields.Zip"]);
  const fullName = clean(lead.name) || `${firstName} ${lastName}`.trim();
  const caseSubtype = firstText(lead, ["diagnosis_type", "custom_fields.Specific type of Leukemia/Lymphoma", "custom_fields.If Yes, What type of Leukemia/Lymphoma?"]) || clean(cfg.case_subtype) || DEFAULT_CASE_SUBTYPE;
  const incidentDate = firstDate(lead, ["exposure_start", "diagnosis_date", "created_at", "custom_fields.What year did you first start using Roundup?"]);
  const campaignName = clean(cfg.campaign_name)
    || clean(cfg.paid_advertisement)
    || firstText(lead, ["campaign_name", "campaign", "custom_fields.paid advertisement", "custom_fields.paid_advertisement", "custom_fields.campaign_name", "custom_fields.Campaign"])
    || clean(lead.source)
    || "MTOS";
  const referredBy = clean(cfg.referred_by)
    || firstText(lead, ["referred_by", "custom_fields.Referred by", "custom_fields.referred_by"])
    || DEFAULT_REFERRED_BY;
  const gender = firstText(lead, ["gender", "custom_fields.What is the injured party's gender?", "custom_fields.Gender of the injured party"]);
  const dod = firstDate(lead, ["date_of_death", "dod", "custom_fields.Date of death"]);
  const diagnosis = firstText(lead, ["diagnosis", "custom_fields.Diagnosis of Non-Hodgkin’s Lymphoma (or subtype)"]);
  const diagnosisDate = firstDate(lead, ["diagnosis_date", "custom_fields.When were they diagnosed with the Leukemia/Lymphoma?"]);
  const physicianContact = firstText(lead, ["physician_contact_info", "custom_fields.What is the name and location of the doctor and facility who made the cancer diagnosis?"]);
  const hospitalContact = firstText(lead, ["hospital_contact_info", "custom_fields.What is the name and location of the doctor and facility who provided the cancer treatment?"]);
  const exposureLocation = firstText(lead, ["location_name", "custom_fields.Where did your exposure to Roundup take place?", "custom_fields.In what county was the injured party exposed?"]);

  return {
    "Integration Key": apiKey,
    "Tenant ID": clean(cfg.tenant_id) || DEFAULT_TENANT_ID,
    CaseType: clean(cfg.case_type) || DEFAULT_CASE_TYPE,
    "Case Group": clean(cfg.case_group) || DEFAULT_CASE_GROUP,
    "Case Subtype": caseSubtype,
    "Main Status": clean(cfg.main_status) || DEFAULT_MAIN_STATUS,
    "Incident Type": clean(cfg.incident_type) || DEFAULT_INCIDENT_TYPE,
    "Default Defendant": clean(cfg.default_defendant) || DEFAULT_DEFENDANT,
    "Referred by": referredBy,
    "paid advertisement": campaignName,
    "Incident Date": incidentDate,
    "Incident State": state,
    firstName,
    lastName,
    email: contactEmail,
    phone,
    caseDetails: buildCaseDetails(lead),
    FirstName: firstName,
    LastName: lastName,
    FullName: fullName,
    Email: contactEmail,
    Phone: phone,
    DOB: birthDate,
    Address: address,
    City: city,
    State: state,
    Zip: zip,
    Injured_FirstName: firstName,
    Injured_MiddleName: middleName,
    Injured_LastName: lastName,
    Injured_PHONE: phone,
    Injured_EMAIL: contactEmail,
    Injured_Address: address,
    Injured_CITY: city,
    Injured_STATE: state,
    Injured_ZIP: zip,
    Injured_GENDER: gender,
    Injured_DOB: birthDate,
    Injured_DOD: dod,
    Diagnosis: diagnosis,
    DiagnosisDate: diagnosisDate,
    DiagnosingFacility: physicianContact,
    TreatingFacility: hospitalContact,
    ExposureLocation: exposureLocation,
    TrustedFormCertUrl: firstText(lead, ["trustedform_cert_url"]),
    TCPAConsent: firstYesNo(lead, ["tcpa_consent"]),
    Source: clean(lead.source),
    LeadId: clean(lead.id),
  };
}

function applyStaticFields(payload: Record<string, string>, cfg: SmartAdvocateConfig): void {
  const staticFields = cfg.static_fields;
  if (!staticFields || typeof staticFields !== "object" || Array.isArray(staticFields)) return;
  for (const [key, value] of Object.entries(staticFields)) {
    const next = clean(value);
    if (next) payload[key] = next;
  }
}

function applyFieldMapping(
  payload: Record<string, string>,
  lead: Record<string, unknown>,
  fieldMapping: unknown,
): void {
  if (!fieldMapping || typeof fieldMapping !== "object" || Array.isArray(fieldMapping)) return;
  for (const [externalField, spec] of Object.entries(fieldMapping as Record<string, MappingSpec>)) {
    if (!externalField.trim()) continue;
    let raw: unknown;
    if (typeof spec === "string") {
      raw = getPath(lead, spec);
    } else if (typeof spec === "number" || typeof spec === "boolean" || spec === null) {
      raw = spec;
    } else if (spec && typeof spec === "object") {
      if (spec.value !== undefined) raw = spec.value;
      else if (spec.field) raw = getPath(lead, spec.field);
      if ((raw === undefined || raw === null || raw === "") && spec.default !== undefined) raw = spec.default;
    }
    const normalized = externalField.endsWith("DOB") || externalField.endsWith("DOD") || /date/i.test(externalField)
      ? isoDate(raw)
      : clean(raw);
    if (normalized) payload[externalField] = normalized;
  }
}

async function loadDecryptedLead(leadId: number): Promise<Record<string, unknown> | null> {
  const [row] = await db.select().from(leadsTable).where(eq(leadsTable.id, leadId)).limit(1);
  if (!row) return null;
  return decryptLeadFields(row as Record<string, unknown>, String(leadId));
}

async function postForm(url: string, payload: Record<string, string>): Promise<{ status: number; body: string }> {
  const body = new URLSearchParams(payload).toString();
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json, text/plain, */*",
      "User-Agent": "MTOS-CRM/1.0 SmartAdvocate",
    },
    body,
  });
  const text = await response.text();
  return { status: response.status, body: text.slice(0, 4000) };
}

async function pushLeadToIntegrationRow(
  integration: typeof integrationsTable.$inferSelect,
  leadId: number,
  source: string,
): Promise<SmartAdvocatePushOutcome> {
  const creds = await getIntegrationCredentialsById(integration.id);
  if (!creds?.api_key) {
    return { ok: false, integrationId: integration.id, leadId, status: 0, requestUrl: normalizeUrl(integration.api_url), skipped: "missing_api_key" };
  }
  const lead = await loadDecryptedLead(leadId);
  if (!lead) {
    return { ok: false, integrationId: integration.id, leadId, status: 0, requestUrl: normalizeUrl(integration.api_url), skipped: "lead_not_found" };
  }

  const cfg = readUserConfig(integration);
  if (!leadLooksLikeRoundUp(lead, cfg)) {
    return { ok: false, integrationId: integration.id, leadId, status: 0, requestUrl: normalizeUrl(integration.api_url), skipped: "not_roundup" };
  }

  const skipReason = getLeadPushSkipReason(lead, cfg);
  if (skipReason) {
    return { ok: false, integrationId: integration.id, leadId, status: 0, requestUrl: normalizeUrl(integration.api_url), skipped: skipReason };
  }

  const payload = buildDefaultPayload(lead, creds.api_key, cfg);
  applyStaticFields(payload, cfg);
  applyFieldMapping(payload, lead, integration.field_mapping);

  const requestUrl = normalizeUrl(integration.api_url);
  const result = await postForm(requestUrl, payload);
  const ok = result.status >= 200 && result.status < 300;

  await auditLog("integration", String(leadId), ok ? "smartadvocate_push_succeeded" : "smartadvocate_push_failed", {
    integration_id: integration.id,
    provider: integration.provider,
    lead_id: leadId,
    source,
    request_url: requestUrl,
    document_upload_url: normalizeDocUploadUrl(clean(cfg.static_fields && (cfg.static_fields as Record<string, unknown>)["Document Upload URL"]) || DEFAULT_DOC_UPLOAD_URL),
    response_status: result.status,
    response_excerpt: result.body.slice(0, 1000),
  });

  return {
    ok,
    integrationId: integration.id,
    leadId,
    status: result.status,
    responseBody: result.body,
    requestUrl,
  };
}

export async function enqueueSmartAdvocatePushForLead(
  leadId: number,
  options: { source?: string } = {},
): Promise<void> {
  setImmediate(() => {
    void pushLeadToAllActiveSmartAdvocateIntegrations(leadId, options).catch((err) => {
      logger.error({ err, leadId }, "smartadvocate enqueue push crashed");
    });
  });
}

export async function pushLeadToAllActiveSmartAdvocateIntegrations(
  leadId: number,
  options: { source?: string } = {},
): Promise<SmartAdvocatePushOutcome[]> {
  const rows = await db
    .select()
    .from(integrationsTable)
    .where(and(eq(integrationsTable.provider, "smartadvocate"), eq(integrationsTable.status, "active")));

  const results: SmartAdvocatePushOutcome[] = [];
  for (const row of rows) {
    try {
      results.push(await pushLeadToIntegrationRow(row, leadId, options.source ?? "lead_created"));
    } catch (err) {
      logger.error({ err, integration_id: row.id, leadId }, "smartadvocate push failed");
      await auditLog("integration", String(leadId), "smartadvocate_push_failed", {
        integration_id: row.id,
        provider: row.provider,
        lead_id: leadId,
        source: options.source ?? "lead_created",
        request_url: normalizeUrl(row.api_url),
        error: err instanceof Error ? err.message : String(err),
      });
      results.push({
        ok: false,
        integrationId: row.id,
        leadId,
        status: 0,
        requestUrl: normalizeUrl(row.api_url),
        responseBody: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return results;
}

export async function syncSmartAdvocateBackfill(
  integrationId: number,
): Promise<{ ok: boolean; pushed: number; attempted: number; skipped: number; details: Record<string, unknown> }> {
  const [integration] = await db.select().from(integrationsTable).where(eq(integrationsTable.id, integrationId)).limit(1);
  if (!integration) {
    return { ok: false, pushed: 0, attempted: 0, skipped: 0, details: { reason: "integration_not_found" } };
  }
  const cfg = readUserConfig(integration);
  const batchLimit = Number(cfg.batch_limit) > 0 ? Number(cfg.batch_limit) : 250;
  const tortFilter = clean(cfg.tort_filter) || "roundup";
  const rows = await db
    .select({ id: leadsTable.id })
    .from(leadsTable)
    .where(ilike(leadsTable.tort_type, `%${tortFilter}%`))
    .orderBy(desc(leadsTable.created_at))
    .limit(batchLimit);

  let pushed = 0;
  let skipped = 0;
  for (const row of rows) {
    const outcome = await pushLeadToIntegrationRow(integration, row.id, "integration_sync");
    if (outcome.ok) pushed += 1;
    else skipped += 1;
  }

  return {
    ok: true,
    pushed,
    attempted: rows.length,
    skipped,
    details: {
      tort_filter: tortFilter,
      batch_limit: batchLimit,
      default_document_upload_url: DEFAULT_DOC_UPLOAD_URL,
      note: "Backfill currently replays the most recent matching qualified RoundUp leads and can create duplicates in SmartAdvocate if run repeatedly without downstream deduplication.",
    },
  };
}
