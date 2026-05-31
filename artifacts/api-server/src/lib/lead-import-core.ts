/**
 * Lead-import core — shared CSV→lead pipeline.
 *
 * Extracted from routes/lead-import.ts so multiple surfaces can reuse the exact
 * same ingestion semantics (parse → map → dedup → conflict-check → encrypt →
 * insert). Today it backs both:
 *   - POST /api/lead-import/execute  (bulk import UI)
 *   - POST /api/dialer/campaigns/upload-dial  (CSV "Upload & Dial")
 *
 * Keeping this as the single source of truth guarantees dialer-uploaded leads
 * get identical dedup + encryption + conflict treatment as imported leads.
 */
import { db, leadsTable, importBatchesTable, importRowsTable } from "@workspace/db";
import { eq, and, ilike } from "drizzle-orm";
import { encryptLeadFields, decrypt, rebindLeadEncryptionAad } from "./encryption";
import { leadLookupHash } from "./lead-lookup-hash";
import { runFullConflictCheck } from "./conflict-engine";
import { logger } from "./logger";
import { normalizeFaxNumber as normalizeFaxNumberSync } from "./fax/normalize";

export const COLUMN_ALIASES: Record<string, string> = {
  "first name": "first_name",
  "firstname": "first_name",
  "last name": "last_name",
  "lastname": "last_name",
  "full name": "name",
  "fullname": "name",
  "email address": "email",
  "email": "email",
  "phone number": "phone",
  "phone": "phone",
  "primary phone": "phone_primary",
  "cell phone": "phone_primary",
  "mobile": "phone_primary",
  "tort": "tort_type",
  "tort type": "tort_type",
  "tort_type": "tort_type",
  "mass tort": "tort_type",
  "dob": "date_of_birth",
  "date of birth": "date_of_birth",
  "birthdate": "date_of_birth",
  "birth date": "date_of_birth",
  "ssn": "last_4_ssn",
  "last 4 ssn": "last_4_ssn",
  "ssn last 4": "last_4_ssn",
  "last4ssn": "last_4_ssn",
  "address": "street_address",
  "street address": "street_address",
  "street": "street_address",
  "city": "city",
  "state": "state",
  "zip": "zip",
  "zip code": "zip",
  "zipcode": "zip",
  "diagnosis": "diagnosis",
  "diagnosis type": "diagnosis_type",
  "diagnosis date": "diagnosis_date",
  "physician first name": "physician_first_name",
  "physician last name": "physician_last_name",
  "doctor name": "physician_last_name",
  "physician": "physician_last_name",
  "hospital": "hospital_name",
  "hospital name": "hospital_name",
  "hospital fax": "hospital_fax",
  "fax": "hospital_fax",
  "doctor fax": "hospital_fax",
  "medications": "medications",
  "meds": "medications",
  "npi": "npi_number",
  "npi number": "npi_number",
  "source": "source",
  "lead source": "source",
  "vendor": "law_firm",
  "law firm": "law_firm",
  "client id": "client_id",
  "notes": "notes",
  "exposure start": "exposure_start",
  "exposure end": "exposure_end",
  "location": "location_name",
  "location name": "location_name",
  "ad spend": "ad_spend",
  "tcpa consent": "tcpa_consent",
  "tcpa": "tcpa_consent",
  "consent": "tcpa_consent",
  "trustedform": "trustedform_cert_url",
  "trustedform cert": "trustedform_cert_url",
  "trustedform cert url": "trustedform_cert_url",
  "cert url": "trustedform_cert_url",
  "contact preference": "contact_preference",
};

export const LEAD_FIELDS = new Set([
  "name", "email", "phone", "tort_type", "first_name", "last_name",
  "date_of_birth", "street_address", "city", "state", "zip",
  "phone_primary", "last_4_ssn", "diagnosis", "diagnosis_type",
  "diagnosis_date", "physician_first_name", "physician_last_name",
  "physician_full_address", "physician_contact_info", "hospital_name",
  "hospital_fax", "hospital_contact_info", "medications", "npi_number",
  "source", "law_firm", "client_id", "notes", "exposure_start",
  "exposure_end", "location_name", "ad_spend", "tort_type",
  "tcpa_consent", "trustedform_cert_url", "contact_preference",
]);

export function parseCSV(text: string): { headers: string[]; rows: Record<string, string>[] } {
  const lines = text.split(/\r?\n/).filter(line => line.trim());
  if (lines.length < 2) return { headers: [], rows: [] };

  const parseRow = (line: string): string[] => {
    const fields: string[] = [];
    let current = "";
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (ch === "," && !inQuotes) {
        fields.push(current.trim());
        current = "";
      } else {
        current += ch;
      }
    }
    fields.push(current.trim());
    return fields;
  };

  const rawHeaders = parseRow(lines[0]);
  const headers = rawHeaders.map(h => h.replace(/^["']|["']$/g, "").trim());

  const rows: Record<string, string>[] = [];
  for (let i = 1; i < lines.length; i++) {
    const values = parseRow(lines[i]);
    if (values.every(v => !v.trim())) continue;
    const row: Record<string, string> = {};
    headers.forEach((h, idx) => {
      row[h] = (values[idx] || "").trim();
    });
    rows.push(row);
  }

  return { headers, rows };
}

export function autoMapColumns(headers: string[]): Record<string, string> {
  const mapping: Record<string, string> = {};
  for (const header of headers) {
    const normalized = header.toLowerCase().replace(/[_\-]/g, " ").trim();
    if (COLUMN_ALIASES[normalized]) {
      mapping[header] = COLUMN_ALIASES[normalized];
    } else if (LEAD_FIELDS.has(normalized.replace(/ /g, "_"))) {
      mapping[header] = normalized.replace(/ /g, "_");
    }
  }
  return mapping;
}

export function mapRowToLead(row: Record<string, string>, columnMapping: Record<string, string>): Record<string, any> {
  const lead: Record<string, any> = {};
  for (const [csvCol, leadField] of Object.entries(columnMapping)) {
    const value = row[csvCol];
    if (value !== undefined && value !== "") {
      if (leadField === "diagnosis_confirmed" || leadField === "was_at_location" || leadField === "tcpa_consent") {
        lead[leadField] = ["true", "yes", "1", "y"].includes(value.toLowerCase());
      } else if (leadField === "hospital_fax") {
        // Run the imported fax through the shared E.164 normalizer. If it
        // can't be parsed we drop it (with a marker on the row) rather than
        // store garbage that would later fail in auto-dispatch.
        const norm = normalizeFaxNumberSync(value);
        if (norm.ok) {
          lead.hospital_fax = norm.e164;
        } else {
          lead.hospital_fax = null;
          lead._import_warnings = [...(lead._import_warnings ?? []), `hospital_fax_invalid:${norm.message}`];
        }
      } else {
        lead[leadField] = value;
      }
    }
  }

  if (!lead.name && lead.first_name && lead.last_name) {
    lead.name = `${lead.first_name} ${lead.last_name}`;
  } else if (!lead.name && lead.first_name) {
    lead.name = lead.first_name;
  } else if (!lead.name && lead.last_name) {
    lead.name = lead.last_name;
  }

  return lead;
}

// Dedup is scoped to the caller's firm: email/phone uniqueness is per-firm,
// not global — two different firms may legitimately hold the same claimant.
export async function checkDuplicate(
  lead: Record<string, any>,
  firmId: number,
): Promise<{ isDuplicate: boolean; matchId?: number; reason?: string }> {
  try {
    if (lead.email) {
      const emailMatches = await db
        .select({ id: leadsTable.id, name: leadsTable.name, email: leadsTable.email })
        .from(leadsTable)
        .where(and(ilike(leadsTable.email, lead.email.trim()), eq(leadsTable.firm_id, firmId)))
        .limit(1);

      if (emailMatches.length > 0) {
        return { isDuplicate: true, matchId: emailMatches[0].id, reason: `Email match: ${lead.email}` };
      }
    }

    const incomingPhones: string[] = [];
    if (lead.phone_primary) {
      const digits = lead.phone_primary.replace(/\D/g, "");
      if (digits.length >= 10) incomingPhones.push(digits);
    }
    if (lead.phone) {
      const digits = lead.phone.replace(/\D/g, "");
      if (digits.length >= 10) incomingPhones.push(digits);
    }

    if (incomingPhones.length > 0) {
      // Scope phone dedup to the caller's firm — no cross-tenant comparison.
      const existingLeads = await db
        .select({ id: leadsTable.id, name: leadsTable.name, phone: leadsTable.phone, phone_primary: leadsTable.phone_primary })
        .from(leadsTable)
        .where(eq(leadsTable.firm_id, firmId))
        .limit(5000);

      for (const existing of existingLeads) {
        const storedPhones: string[] = [];
        if (existing.phone) {
          try {
            const decrypted = decrypt(existing.phone);
            if (decrypted && decrypted !== "[DECRYPTION_ERROR]") {
              storedPhones.push(decrypted.replace(/\D/g, ""));
            }
          } catch {
            storedPhones.push(existing.phone.replace(/\D/g, ""));
          }
        }
        if (existing.phone_primary) {
          try {
            const decrypted = decrypt(existing.phone_primary);
            if (decrypted && decrypted !== "[DECRYPTION_ERROR]") {
              storedPhones.push(decrypted.replace(/\D/g, ""));
            }
          } catch {
            storedPhones.push(existing.phone_primary.replace(/\D/g, ""));
          }
        }

        for (const incoming of incomingPhones) {
          for (const stored of storedPhones) {
            if (stored.length >= 10 && stored === incoming) {
              return { isDuplicate: true, matchId: existing.id, reason: `Phone match` };
            }
          }
        }
      }
    }

    return { isDuplicate: false };
  } catch (err) {
    logger.error({ err }, "Dedup check failed — treating as non-duplicate (safe fallback)");
    return { isDuplicate: false };
  }
}

export interface ImportBatchSummary {
  batchId: number;
  successCount: number;
  duplicateCount: number;
  errorCount: number;
  conflictCount: number;
  /** Lead ids created during this batch (success + conflict rows). */
  createdLeadIds: number[];
}

export async function processImportBatch(
  batchId: number,
  rows: Record<string, string>[],
  columnMapping: Record<string, string>,
  firmId: number,
): Promise<ImportBatchSummary> {
  let successCount = 0;
  let duplicateCount = 0;
  let errorCount = 0;
  let conflictCount = 0;
  const createdLeadIds: number[] = [];

  for (let i = 0; i < rows.length; i++) {
    const rowNum = i + 1;
    try {
      const leadData = mapRowToLead(rows[i], columnMapping);

      if (!leadData.name || !leadData.tort_type) {
        await db.insert(importRowsTable).values({
          batch_id: batchId,
          row_number: rowNum,
          status: "error",
          raw_data: rows[i],
          error_message: `Missing required fields: ${!leadData.name ? "name" : ""}${!leadData.name && !leadData.tort_type ? ", " : ""}${!leadData.tort_type ? "tort_type" : ""}`,
          processed_at: new Date(),
        });
        errorCount++;
        continue;
      }

      const dedupResult = await checkDuplicate(leadData, firmId);
      if (dedupResult.isDuplicate) {
        await db.insert(importRowsTable).values({
          batch_id: batchId,
          row_number: rowNum,
          status: "duplicate",
          raw_data: rows[i],
          dedup_match_id: dedupResult.matchId,
          dedup_reason: dedupResult.reason,
          processed_at: new Date(),
        });
        duplicateCount++;
        continue;
      }

      const conflictResult = await runFullConflictCheck({
        entity_type: "lead",
        entity_id: `import_batch_${batchId}_row_${rowNum}`,
        source_module: "lead_import",
        lead_data: leadData,
      });

      if (conflictResult.output_state === "REJECT") {
        await db.insert(importRowsTable).values({
          batch_id: batchId,
          row_number: rowNum,
          status: "rejected",
          raw_data: rows[i],
          conflict_details: conflictResult,
          error_message: conflictResult.details.join("; "),
          processed_at: new Date(),
        });
        errorCount++;
        continue;
      }

      // Strip transient/non-column markers before building the insert
      // payload — `_import_warnings` is collected in mapRowToLead() so we
      // can surface per-row notes (e.g. invalid hospital_fax was dropped),
      // but it is NOT a column on the leads table and would cause the
      // insert to fail.
      const { _import_warnings: importWarnings, ...leadColumns } = leadData;
      const insertData: Record<string, any> = {
        ...leadColumns,
        firm_id: firmId,
        status: conflictResult.has_conflict ? "review_required" : "new",
        source: leadColumns.source || "csv_import",
        diagnosis_confirmed: leadColumns.diagnosis_confirmed || false,
        was_at_location: leadColumns.was_at_location || false,
      };

      const encrypted = encryptLeadFields(insertData);

      // Task #15: stamp canonical (tort|email|phone10) hash so subsequent
      // intake dedup queries can short-circuit. Uses PLAINTEXT inputs from
      // insertData (pre-encryption) so phone10 normalizes correctly.
      const csvLookupHash = leadLookupHash(
        insertData.tort_type ?? null,
        insertData.email ?? null,
        insertData.phone_primary ?? insertData.phone ?? null,
      );

      const [newLead] = await db
        .insert(leadsTable)
        .values({ ...(encrypted as any), lookup_hash: csvLookupHash })
        .returning();
      // Task #8: rebind ciphertext AAD to the freshly-assigned lead.id.
      await rebindLeadEncryptionAad(db, leadsTable, newLead as Record<string, unknown>, eq);

      createdLeadIds.push(newLead.id);

      const rowStatus = conflictResult.has_conflict ? "conflict" : "success";
      if (conflictResult.has_conflict) conflictCount++;
      else successCount++;

      await db.insert(importRowsTable).values({
        batch_id: batchId,
        row_number: rowNum,
        status: rowStatus,
        raw_data: rows[i],
        lead_id: newLead.id,
        conflict_details: conflictResult.has_conflict ? conflictResult : null,
        // Surface per-row warnings (e.g. invalid hospital_fax was dropped)
        // in the import row itself so operators can audit later. We piggyback
        // on `error_message` for free-text since adding a new column would
        // be a schema change.
        error_message:
          importWarnings && importWarnings.length > 0 ? `warnings: ${importWarnings.join("; ")}` : null,
        processed_at: new Date(),
      });
    } catch (err: unknown) {
      logger.error({ err, batch_id: batchId, row: rowNum }, "Import row failed");
      await db.insert(importRowsTable).values({
        batch_id: batchId,
        row_number: rowNum,
        status: "error",
        raw_data: rows[i],
        error_message: err instanceof Error ? err.message : "Unknown error during import",
        processed_at: new Date(),
      }).catch(async (insertErr) => {
        logger.warn(
          { err: insertErr, original_err: err instanceof Error ? err.message : String(err), batch_id: batchId, row: rowNum },
          "Failed to record import error row",
        );
      });
      errorCount++;
    }

    if (rowNum % 50 === 0) {
      await db
        .update(importBatchesTable)
        .set({
          processed_rows: rowNum,
          success_count: successCount,
          duplicate_count: duplicateCount,
          error_count: errorCount,
          conflict_count: conflictCount,
        })
        .where(eq(importBatchesTable.id, batchId));
    }
  }

  await db
    .update(importBatchesTable)
    .set({
      status: "completed",
      processed_rows: rows.length,
      success_count: successCount,
      duplicate_count: duplicateCount,
      error_count: errorCount,
      conflict_count: conflictCount,
      completed_at: new Date(),
    })
    .where(eq(importBatchesTable.id, batchId));

  logger.info(
    { batch_id: batchId, success: successCount, duplicates: duplicateCount, errors: errorCount, conflicts: conflictCount },
    "Import batch completed"
  );

  return { batchId, successCount, duplicateCount, errorCount, conflictCount, createdLeadIds };
}
