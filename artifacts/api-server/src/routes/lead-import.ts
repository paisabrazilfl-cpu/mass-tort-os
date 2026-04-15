import { Router } from "express";
import { db, leadsTable, importBatchesTable, importRowsTable } from "@workspace/db";
import { eq, desc, or, and, ilike, sql } from "drizzle-orm";
import { requireRole } from "../lib/rbac";
import { auditLog } from "../lib/audit";
import { encryptLeadFields, decrypt, hashForLookup } from "../lib/encryption";
import { runFullConflictCheck } from "../lib/conflict-engine";
import { logger } from "../lib/logger";

const router = Router();

const COLUMN_ALIASES: Record<string, string> = {
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
};

const LEAD_FIELDS = new Set([
  "name", "email", "phone", "tort_type", "first_name", "last_name",
  "date_of_birth", "street_address", "city", "state", "zip",
  "phone_primary", "last_4_ssn", "diagnosis", "diagnosis_type",
  "diagnosis_date", "physician_first_name", "physician_last_name",
  "physician_full_address", "physician_contact_info", "hospital_name",
  "hospital_fax", "hospital_contact_info", "medications", "npi_number",
  "source", "law_firm", "client_id", "notes", "exposure_start",
  "exposure_end", "location_name", "ad_spend", "tort_type",
]);

function parseCSV(text: string): { headers: string[]; rows: Record<string, string>[] } {
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

function autoMapColumns(headers: string[]): Record<string, string> {
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

function mapRowToLead(row: Record<string, string>, columnMapping: Record<string, string>): Record<string, any> {
  const lead: Record<string, any> = {};
  for (const [csvCol, leadField] of Object.entries(columnMapping)) {
    const value = row[csvCol];
    if (value !== undefined && value !== "") {
      if (leadField === "diagnosis_confirmed" || leadField === "was_at_location" || leadField === "tcpa_consent") {
        lead[leadField] = ["true", "yes", "1", "y"].includes(value.toLowerCase());
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

async function checkDuplicate(lead: Record<string, any>): Promise<{ isDuplicate: boolean; matchId?: number; reason?: string }> {
  try {
    if (lead.email) {
      const emailMatches = await db
        .select({ id: leadsTable.id, name: leadsTable.name, email: leadsTable.email })
        .from(leadsTable)
        .where(ilike(leadsTable.email, lead.email.trim()))
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
      const existingLeads = await db
        .select({ id: leadsTable.id, name: leadsTable.name, phone: leadsTable.phone, phone_primary: leadsTable.phone_primary })
        .from(leadsTable)
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

router.post("/preview", requireRole("paralegal"), async (req, res) => {
  try {
    const { csv_data } = req.body;
    if (!csv_data) return res.status(400).json({ error: "csv_data is required" });

    const { headers, rows } = parseCSV(csv_data);
    if (headers.length === 0) return res.status(400).json({ error: "No valid CSV headers found" });

    const columnMapping = autoMapColumns(headers);
    const unmappedColumns = headers.filter(h => !columnMapping[h]);
    const sampleRows = rows.slice(0, 5).map(row => mapRowToLead(row, columnMapping));

    res.json({
      total_rows: rows.length,
      headers,
      column_mapping: columnMapping,
      unmapped_columns: unmappedColumns,
      available_fields: Array.from(LEAD_FIELDS),
      sample_leads: sampleRows,
    });
  } catch (err) {
    logger.error({ err }, "CSV preview failed");
    res.status(500).json({ error: "Failed to preview CSV" });
  }
});

router.post("/execute", requireRole("attorney"), async (req, res) => {
  try {
    const { csv_data, column_mapping, filename = "import.csv" } = req.body;
    if (!csv_data) return res.status(400).json({ error: "csv_data is required" });

    const { headers, rows } = parseCSV(csv_data);
    if (rows.length === 0) return res.status(400).json({ error: "No data rows found in CSV" });

    const maxRows = 5000;
    if (rows.length > maxRows) {
      return res.status(400).json({ error: `Import limited to ${maxRows} rows per batch. This file has ${rows.length} rows.` });
    }

    const mapping = column_mapping || autoMapColumns(headers);
    const user = (req as any).user;

    const [batch] = await db
      .insert(importBatchesTable)
      .values({
        filename,
        status: "processing",
        total_rows: rows.length,
        column_mapping: mapping,
        created_by: user?.username || "system",
      })
      .returning();

    await auditLog("import_batch", String(batch.id), "import_batch_started", {
      filename,
      total_rows: rows.length,
      user_email: user?.email,
    });

    res.status(202).json({
      batch_id: batch.id,
      status: "processing",
      total_rows: rows.length,
      message: "Import started. Each lead will be individually validated, deduped, and conflict-checked.",
    });

    processImportBatch(batch.id, rows, mapping, req).catch(err => {
      logger.error({ err, batch_id: batch.id }, "Import batch processing failed");
    });
  } catch (err) {
    logger.error({ err }, "Failed to start import");
    res.status(500).json({ error: "Failed to start import" });
  }
});

async function processImportBatch(
  batchId: number,
  rows: Record<string, string>[],
  columnMapping: Record<string, string>,
  req: any
) {
  let successCount = 0;
  let duplicateCount = 0;
  let errorCount = 0;
  let conflictCount = 0;

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

      const dedupResult = await checkDuplicate(leadData);
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

      const insertData: Record<string, any> = {
        ...leadData,
        status: conflictResult.has_conflict ? "review_required" : "new",
        source: leadData.source || "csv_import",
        diagnosis_confirmed: leadData.diagnosis_confirmed || false,
        was_at_location: leadData.was_at_location || false,
      };

      const encrypted = encryptLeadFields(insertData);

      const [newLead] = await db
        .insert(leadsTable)
        .values(encrypted)
        .returning({ id: leadsTable.id });

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
        processed_at: new Date(),
      });
    } catch (err: any) {
      logger.error({ err, batch_id: batchId, row: rowNum }, "Import row failed");
      await db.insert(importRowsTable).values({
        batch_id: batchId,
        row_number: rowNum,
        status: "error",
        raw_data: rows[i],
        error_message: err.message || "Unknown error during import",
        processed_at: new Date(),
      }).catch(() => {});
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
}

router.get("/batches", async (_req, res) => {
  try {
    const batches = await db
      .select()
      .from(importBatchesTable)
      .orderBy(desc(importBatchesTable.created_at))
      .limit(50);
    res.json(batches);
  } catch (err) {
    logger.error({ err }, "Failed to list import batches");
    res.status(500).json({ error: "Failed to list batches" });
  }
});

router.get("/batches/:id", async (req, res) => {
  try {
    const [batch] = await db
      .select()
      .from(importBatchesTable)
      .where(eq(importBatchesTable.id, Number(req.params.id)));

    if (!batch) return res.status(404).json({ error: "Batch not found" });

    const rows = await db
      .select()
      .from(importRowsTable)
      .where(eq(importRowsTable.batch_id, batch.id))
      .orderBy(importRowsTable.row_number);

    res.json({ ...batch, rows });
  } catch (err) {
    logger.error({ err }, "Failed to get batch details");
    res.status(500).json({ error: "Failed to get batch details" });
  }
});

router.get("/batches/:id/errors", async (req, res) => {
  try {
    const rows = await db
      .select()
      .from(importRowsTable)
      .where(
        and(
          eq(importRowsTable.batch_id, Number(req.params.id)),
          or(
            eq(importRowsTable.status, "error"),
            eq(importRowsTable.status, "rejected")
          )
        )
      )
      .orderBy(importRowsTable.row_number);

    res.json(rows);
  } catch (err) {
    logger.error({ err }, "Failed to get batch errors");
    res.status(500).json({ error: "Failed to get batch errors" });
  }
});

router.get("/batches/:id/duplicates", async (req, res) => {
  try {
    const rows = await db
      .select()
      .from(importRowsTable)
      .where(
        and(
          eq(importRowsTable.batch_id, Number(req.params.id)),
          eq(importRowsTable.status, "duplicate")
        )
      )
      .orderBy(importRowsTable.row_number);

    res.json(rows);
  } catch (err) {
    logger.error({ err }, "Failed to get batch duplicates");
    res.status(500).json({ error: "Failed to get batch duplicates" });
  }
});

export default router;
