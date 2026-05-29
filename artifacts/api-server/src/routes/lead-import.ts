import { Router } from "express";
import { db, importBatchesTable, importRowsTable } from "@workspace/db";
import { eq, desc, or, and } from "drizzle-orm";
import { Permission, requirePermission } from "../lib/rbac";
import { auditLog } from "../lib/audit";
import { logger } from "../lib/logger";
import { serverError } from "../lib/http-errors";
import {
  LEAD_FIELDS,
  parseCSV,
  autoMapColumns,
  mapRowToLead,
  processImportBatch,
} from "../lib/lead-import-core";

const router = Router();
router.post("/preview", requirePermission(Permission.LEAD_IMPORT_PREVIEW), async (req, res) => {
  try {
    const { csv_data } = req.body ?? {};
    if (!csv_data) { res.status(400).json({ error: "csv_data is required (send JSON body with Content-Type: application/json)" }); return; }

    const { headers, rows } = parseCSV(csv_data);
    if (headers.length === 0) { res.status(400).json({ error: "No valid CSV headers found" }); return; }

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
    serverError(res, "Failed to preview CSV");
  }
});

router.post("/execute", requirePermission(Permission.LEAD_IMPORT_EXECUTE), async (req, res) => {
  try {
    const { csv_data, column_mapping, filename = "import.csv" } = req.body ?? {};
    if (!csv_data) { res.status(400).json({ error: "csv_data is required (send JSON body with Content-Type: application/json)" }); return; }

    const { headers, rows } = parseCSV(csv_data);
    if (rows.length === 0) { res.status(400).json({ error: "No data rows found in CSV" }); return; }

    const maxRows = 5000;
    if (rows.length > maxRows) {
      res.status(400).json({ error: `Import limited to ${maxRows} rows per batch. This file has ${rows.length} rows.` }); return;
    }

    const mapping = column_mapping || autoMapColumns(headers);
    const user = req.user!;

    const [batch] = await db
      .insert(importBatchesTable)
      .values({
        filename,
        status: "processing",
        total_rows: rows.length,
        column_mapping: mapping,
        created_by: user.email,
      })
      .returning();

    await auditLog("import_batch", String(batch.id), "import_batch_started", {
      filename,
      total_rows: rows.length,
      user_email: user.email,
    });

    res.status(202).json({
      batch_id: batch.id,
      status: "processing",
      total_rows: rows.length,
      message: "Import started. Each lead will be individually validated, deduped, and conflict-checked.",
    });

    processImportBatch(batch.id, rows, mapping, user.firm_id).catch(err => {
      logger.error({ err, batch_id: batch.id }, "Import batch processing failed");
    });
  } catch (err) {
    logger.error({ err }, "Failed to start import");
    serverError(res, "Failed to start import");
  }
});

router.get("/batches", requirePermission(Permission.LEAD_IMPORT_PREVIEW), async (_req, res) => {
  try {
    const batches = await db
      .select()
      .from(importBatchesTable)
      .orderBy(desc(importBatchesTable.created_at))
      .limit(50);
    res.json(batches);
  } catch (err) {
    logger.error({ err }, "Failed to list import batches");
    serverError(res, "Failed to list batches");
  }
});

router.get("/batches/:id", requirePermission(Permission.LEAD_IMPORT_PREVIEW), async (req, res) => {
  try {
    const [batch] = await db
      .select()
      .from(importBatchesTable)
      .where(eq(importBatchesTable.id, Number(req.params.id)));

    if (!batch) { res.status(404).json({ error: "Batch not found" }); return; }

    const rows = await db
      .select()
      .from(importRowsTable)
      .where(eq(importRowsTable.batch_id, batch.id))
      .orderBy(importRowsTable.row_number);

    res.json({ ...batch, rows });
  } catch (err) {
    logger.error({ err }, "Failed to get batch details");
    serverError(res, "Failed to get batch details");
  }
});

router.get("/batches/:id/errors", requirePermission(Permission.LEAD_IMPORT_PREVIEW), async (req, res) => {
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
    serverError(res, "Failed to get batch errors");
  }
});

router.get("/batches/:id/duplicates", requirePermission(Permission.LEAD_IMPORT_PREVIEW), async (req, res) => {
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
    serverError(res, "Failed to get batch duplicates");
  }
});

export default router;
