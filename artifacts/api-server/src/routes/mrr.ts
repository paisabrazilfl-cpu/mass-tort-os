/**
 * Medical Records Requests — operator-facing CRUD over the
 * medical_records_requests tracking table.
 *
 * All writes go through the job queue (the fax send path is the canonical
 * writer); this router is intentionally read-heavy. The only mutation exposed
 * here is PATCH /:id/cancel which lets operators soft-cancel a pending/sent
 * request without going through the queue.
 */
import { Router } from "express";
import { z } from "zod/v4";
import { db, medicalRecordsRequestsTable, leadsTable } from "@workspace/db";
import { eq, and, desc, inArray, sql } from "drizzle-orm";
import { requirePermission, Permission } from "../lib/rbac";
import { badRequest, notFound } from "../lib/http-errors";
import { getFirmIdForUser } from "../lib/subscription-gate";
import { auditLog } from "../lib/audit";
import { enqueueJob } from "../lib/queue";

const router = Router();

async function resolveFirm(userId: number): Promise<number | null> {
  if (userId <= 0) return null; // dev bypass — no firm scope
  return getFirmIdForUser(userId);
}

const ListQuerySchema = z.object({
  lead_id: z.coerce.number().int().positive().optional(),
  status: z.enum(["pending", "sent", "failed", "fulfilled", "cancelled"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(25),
});

// GET /api/mrr — list requests for the firm (optionally filtered by lead or status)
router.get("/", requirePermission(Permission.MEDICAL_RECORDS_VIEW), async (req, res) => {
  const parsed = ListQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    badRequest(res, parsed.error.issues[0]?.message ?? "invalid query");
    return;
  }
  const { lead_id, status, page, page_size } = parsed.data;
  const firmId = await resolveFirm(req.user!.id);
  const offset = (page - 1) * page_size;

  const conditions = [];
  if (firmId != null) conditions.push(eq(medicalRecordsRequestsTable.firm_id, firmId));
  if (lead_id) conditions.push(eq(medicalRecordsRequestsTable.lead_id, lead_id));
  if (status) conditions.push(eq(medicalRecordsRequestsTable.status, status));

  const where = conditions.length > 1
    ? and(...(conditions as [typeof conditions[0], ...typeof conditions]))
    : conditions[0];

  const [rows, [countRow]] = await Promise.all([
    db
      .select({
        id: medicalRecordsRequestsTable.id,
        lead_id: medicalRecordsRequestsTable.lead_id,
        lead_name: leadsTable.name,
        hospital_name: medicalRecordsRequestsTable.hospital_name,
        hospital_npi: medicalRecordsRequestsTable.hospital_npi,
        fax_number: medicalRecordsRequestsTable.fax_number,
        envelope_id: medicalRecordsRequestsTable.envelope_id,
        fax_result_id: medicalRecordsRequestsTable.fax_result_id,
        status: medicalRecordsRequestsTable.status,
        sent_at: medicalRecordsRequestsTable.sent_at,
        expected_by: medicalRecordsRequestsTable.expected_by,
        fulfilled_at: medicalRecordsRequestsTable.fulfilled_at,
        attempt_count: medicalRecordsRequestsTable.attempt_count,
        last_attempt_at: medicalRecordsRequestsTable.last_attempt_at,
        response_fax_result_id: medicalRecordsRequestsTable.response_fax_result_id,
        notes: medicalRecordsRequestsTable.notes,
        created_at: medicalRecordsRequestsTable.created_at,
      })
      .from(medicalRecordsRequestsTable)
      .leftJoin(leadsTable, eq(leadsTable.id, medicalRecordsRequestsTable.lead_id))
      .where(where)
      .orderBy(desc(medicalRecordsRequestsTable.created_at))
      .limit(page_size)
      .offset(offset),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(medicalRecordsRequestsTable)
      .where(where),
  ]);

  const total = countRow?.total ?? 0;
  res.json({ results: rows, total, page, page_size, has_more: offset + rows.length < total });
});

// GET /api/mrr/:id — single request detail
router.get("/:id", requirePermission(Permission.MEDICAL_RECORDS_VIEW), async (req, res) => {
  const id = parseInt(req.params["id"] as string, 10);
  if (isNaN(id)) { badRequest(res, "invalid id"); return; }

  const firmId = await resolveFirm(req.user!.id);

  const conditions = [eq(medicalRecordsRequestsTable.id, id)];
  if (firmId != null) conditions.push(eq(medicalRecordsRequestsTable.firm_id, firmId));

  const [row] = await db
    .select()
    .from(medicalRecordsRequestsTable)
    .where(and(...(conditions as [typeof conditions[0], ...typeof conditions])))
    .limit(1);

  if (!row) { notFound(res, "request not found"); return; }
  res.json(row);
});

// PATCH /api/mrr/:id/cancel — soft-cancel a pending or sent request
router.patch("/:id/cancel", requirePermission(Permission.MEDICAL_RECORDS_MANAGE), async (req, res) => {
  const id = parseInt(req.params["id"] as string, 10);
  if (isNaN(id)) { badRequest(res, "invalid id"); return; }

  const firmId = await resolveFirm(req.user!.id);

  const conditions = [
    eq(medicalRecordsRequestsTable.id, id),
    inArray(medicalRecordsRequestsTable.status, ["pending", "sent"]),
  ];
  if (firmId != null) conditions.push(eq(medicalRecordsRequestsTable.firm_id, firmId));

  const [updated] = await db
    .update(medicalRecordsRequestsTable)
    .set({ status: "cancelled", updated_at: new Date() })
    .where(and(...(conditions as [typeof conditions[0], ...typeof conditions])))
    .returning({ id: medicalRecordsRequestsTable.id, status: medicalRecordsRequestsTable.status });

  if (!updated) { notFound(res, "request not found or already resolved"); return; }

  await auditLog("medical_records_request", String(id), "cancelled", { user_id: req.user!.id });
  res.json(updated);
});

// POST /api/mrr/:id/resend — manually re-enqueue the fax job for a sent/failed request
router.post("/:id/resend", requirePermission(Permission.MEDICAL_RECORDS_MANAGE), async (req, res) => {
  const id = parseInt(req.params["id"] as string, 10);
  if (isNaN(id)) { badRequest(res, "invalid id"); return; }

  const firmId = await resolveFirm(req.user!.id);

  const conditions = [eq(medicalRecordsRequestsTable.id, id)];
  if (firmId != null) conditions.push(eq(medicalRecordsRequestsTable.firm_id, firmId));

  const [row] = await db
    .select()
    .from(medicalRecordsRequestsTable)
    .where(and(...(conditions as [typeof conditions[0], ...typeof conditions])))
    .limit(1);

  if (!row) { notFound(res, "request not found"); return; }
  if (!row.envelope_id || !row.lead_id) {
    res.status(422).json({ status: "error", message: "Request has no envelope — cannot resend" });
    return;
  }

  const now = new Date();
  const expectedBy = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);

  await db.update(medicalRecordsRequestsTable)
    .set({
      status: "sent",
      attempt_count: (row.attempt_count ?? 1) + 1,
      last_attempt_at: now,
      expected_by: expectedBy,
      updated_at: now,
    })
    .where(eq(medicalRecordsRequestsTable.id, id));

  const jobId = await enqueueJob("fax_med_records_request", {
    lead_id: row.lead_id,
    envelope_id: row.envelope_id,
  });

  await auditLog("medical_records_request", String(id), "manual_resend", {
    user_id: req.user!.id,
    attempt_count: (row.attempt_count ?? 1) + 1,
    job_id: jobId,
  });

  res.json({ ok: true, job_id: jobId });
});

export default router;
