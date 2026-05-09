/**
 * FHIR Bundle → MTOS ingestion.
 *
 * Takes a FHIR R4 Bundle (or NDJSON-style array of resources from a Fasten
 * Connect bulk export) and:
 *   1. Persists the raw payload to the file vault under the lead's case dir
 *      so the originals are always recoverable for litigation discovery.
 *   2. Inserts a `documents` row pointing at the raw file so it shows up
 *      under the lead's Documents tab.
 *   3. Mines the Bundle for high-signal facts (diagnoses, medications,
 *      providers, encounters, observations) and writes a structured summary
 *      that the existing AI extraction pipeline can pick up.
 *
 * NEVER throws on per-resource parse errors — partial ingestion is far
 * better than dropping the whole bundle. Failures are logged + audited.
 */
import { db, documentsTable, leadsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "../logger";
import { auditLog } from "../audit";
import { saveFile } from "../vault";

interface FhirResource {
  resourceType?: string;
  id?: string;
  code?: { text?: string; coding?: Array<{ system?: string; code?: string; display?: string }> };
  subject?: { reference?: string };
  effectiveDateTime?: string;
  recordedDate?: string;
  onsetDateTime?: string;
  authoredOn?: string;
  performer?: Array<{ display?: string }>;
  medicationCodeableConcept?: { text?: string };
  status?: string;
  clinicalStatus?: { text?: string };
  conclusion?: string;
  description?: string;
}

interface FhirBundle {
  resourceType?: string;
  type?: string;
  entry?: Array<{ resource?: FhirResource }>;
}

export interface IngestSummary {
  total_resources: number;
  by_type: Record<string, number>;
  diagnoses: Array<{ text: string; date?: string; status?: string }>;
  medications: Array<{ text: string; date?: string; status?: string }>;
  encounters: Array<{ text: string; date?: string }>;
  providers: string[];
  observations_count: number;
}

function pickResources(input: unknown): FhirResource[] {
  // Accept either a Bundle or a plain array of resources.
  if (Array.isArray(input)) return input as FhirResource[];
  const b = input as FhirBundle;
  if (b && Array.isArray(b.entry)) {
    return b.entry.map((e) => e.resource).filter((r): r is FhirResource => !!r);
  }
  return [];
}

function codeableText(r: FhirResource | undefined): string | undefined {
  if (!r) return undefined;
  if (r.code?.text) return r.code.text;
  const coding = r.code?.coding?.[0];
  return coding?.display || coding?.code;
}

function dateOf(r: FhirResource): string | undefined {
  return r.recordedDate || r.onsetDateTime || r.effectiveDateTime || r.authoredOn;
}

/** Walk the Bundle and pull the high-signal facts MTOS scoring cares about. */
export function summarizeBundle(input: unknown): IngestSummary {
  const resources = pickResources(input);
  const summary: IngestSummary = {
    total_resources: resources.length,
    by_type: {},
    diagnoses: [],
    medications: [],
    encounters: [],
    providers: [],
    observations_count: 0,
  };
  const providerSet = new Set<string>();
  for (const r of resources) {
    const t = r.resourceType || "Unknown";
    summary.by_type[t] = (summary.by_type[t] || 0) + 1;

    if (t === "Condition") {
      const text = codeableText(r);
      if (text) {
        summary.diagnoses.push({
          text,
          date: dateOf(r),
          status: r.clinicalStatus?.text || r.status,
        });
      }
    } else if (t === "MedicationRequest" || t === "MedicationStatement") {
      const text = r.medicationCodeableConcept?.text || codeableText(r);
      if (text) {
        summary.medications.push({ text, date: dateOf(r), status: r.status });
      }
    } else if (t === "Encounter") {
      const text = codeableText(r) || r.description || "Encounter";
      summary.encounters.push({ text, date: dateOf(r) });
    } else if (t === "Practitioner" || t === "PractitionerRole") {
      const name = (r as { name?: Array<{ text?: string }> }).name?.[0]?.text;
      if (name) providerSet.add(name);
    } else if (t === "Observation" || t === "DiagnosticReport") {
      summary.observations_count += 1;
    }
    for (const p of r.performer || []) {
      if (p?.display) providerSet.add(p.display);
    }
  }
  summary.providers = Array.from(providerSet).slice(0, 50);
  return summary;
}

/**
 * Persist a raw FHIR payload (Bundle JSON or NDJSON bytes) to the vault and
 * register a documents row pointing at it.
 */
export async function ingestFhirPayload(opts: {
  leadId: number;
  caseId: string;
  payload: unknown | Uint8Array;
  sourceLabel: string; // e.g. "fasten_connect:Epic MyChart" — surfaced in document.notes
  contentType?: string;
}): Promise<{ documentId: number; vaultPath: string; summary: IngestSummary | null }> {
  const isBytes = opts.payload instanceof Uint8Array;
  const fileName = `fasten-${Date.now()}.${isBytes ? "ndjson" : "json"}`;
  const contentBase64 = isBytes
    ? Buffer.from(opts.payload as Uint8Array).toString("base64")
    : Buffer.from(JSON.stringify(opts.payload)).toString("base64");

  const { path } = await saveFile(opts.caseId, contentBase64, fileName);

  let summary: IngestSummary | null = null;
  if (!isBytes) {
    try {
      summary = summarizeBundle(opts.payload);
    } catch (err) {
      logger.warn({ err, leadId: opts.leadId }, "FHIR bundle summarize failed — keeping raw file only");
    }
  }

  const [doc] = await db
    .insert(documentsTable)
    .values({
      lead_id: opts.leadId,
      document_type: "medical_records_fhir",
      file_name: fileName,
      file_url: path,
      notes: summary
        ? `${opts.sourceLabel} — ${summary.total_resources} FHIR resources (${
            Object.keys(summary.by_type).join(", ") || "no types"
          })`
        : `${opts.sourceLabel} — raw FHIR payload`,
    })
    .returning();

  await auditLog("document", String(doc.id), "fasten_ingested", {
    lead_id: opts.leadId,
    source: opts.sourceLabel,
    summary,
  });

  // Best-effort enrichment of the lead row from the bundle. Only fills empty
  // fields — never overwrites operator-entered values.
  if (summary && summary.diagnoses.length > 0) {
    try {
      const [lead] = await db.select().from(leadsTable).where(eq(leadsTable.id, opts.leadId));
      if (lead) {
        const update: Record<string, unknown> = {};
        if (!lead.diagnosis && summary.diagnoses[0]?.text) {
          update.diagnosis = summary.diagnoses[0].text;
        }
        if (!lead.diagnosis_date && summary.diagnoses[0]?.date) {
          update.diagnosis_date = summary.diagnoses[0].date;
        }
        if (!lead.physician_first_name && summary.providers[0]) {
          // Best-effort split on the first space; on failure we just store the
          // full string in last_name. Operator can clean up.
          const parts = summary.providers[0].split(/\s+/);
          if (parts.length >= 2) {
            update.physician_first_name = parts[0];
            update.physician_last_name = parts.slice(1).join(" ");
          } else {
            update.physician_last_name = summary.providers[0];
          }
        }
        if (Object.keys(update).length > 0) {
          await db.update(leadsTable).set(update).where(eq(leadsTable.id, opts.leadId));
          await auditLog("lead", String(opts.leadId), "fasten_enriched", { fields: Object.keys(update) });
        }
      }
    } catch (err) {
      logger.warn({ err, leadId: opts.leadId }, "Lead enrichment from FHIR bundle failed");
    }
  }

  return { documentId: doc.id, vaultPath: path, summary };
}
