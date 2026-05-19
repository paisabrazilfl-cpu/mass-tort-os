import { Router } from "express";
import { z } from "zod";
import { db, casesTable, analysisTable, caseDocumentsTable, auditLogTable, jobQueueTable } from "@workspace/db";
import { eq, or, desc, and } from "drizzle-orm";
import { CreateCaseBody, UploadCaseFileBody } from "@workspace/api-zod";
import { enqueueJob, getQueueStats, requeueDeadLetterJob } from "../lib/queue";
import { auditLog } from "../lib/audit";
import { updateCaseStatus } from "../lib/case-status";
import { requireFirmId } from "../lib/firm-scope";
import crypto from "crypto";
import type { AuthUser } from "../lib/rbac";
import { Permission, requirePermission, auditAction, denyForbidden } from "../lib/rbac";
import { badRequest, notFound, forbidden } from "../lib/http-errors";

/**
 * Cases viewer-ownership predicate, factored out so the role × route test
 * matrix in `src/lib/__tests__/rbac.test.ts` can assert "this case is
 * visible to user X" without standing up a real database.
 *
 * Returns `true` when the given user is permitted to see the given case
 * row. Mirror this in {@link viewerCasesListPredicate} (the SQL-level
 * version) when changing semantics — they MUST agree.
 *
 * Rule: only the `viewer` role is per-row scoped. Paralegals and above see
 * the entire intake queue; viewers see only cases they OWN
 * (`created_by_user_id`) or are explicitly ASSIGNED TO (`assigned_to`).
 */
export function isCaseVisibleToUser(
  user: Pick<AuthUser, "id" | "role">,
  row: { created_by_user_id: number | null; assigned_to: number | null },
): boolean {
  if (user.role !== "viewer") return true;
  return row.created_by_user_id === user.id || row.assigned_to === user.id;
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validateCaseId(id: string): boolean {
  return UUID_REGEX.test(id);
}

// Reasonable upload-payload caps so a malicious caller can't enqueue a
// gigabyte-sized base64 blob and force the worker to OOM. The express
// global limit is 55mb; we cap the document content payload at 25mb of
// base64 (~18.75mb decoded) which fits any realistic medical PDF.
const MAX_FILE_NAME_LEN = 255;
const MAX_CONTENT_BASE64_BYTES = 25 * 1024 * 1024;

const router = Router();

router.post("/", requirePermission(Permission.CASE_CREATE), auditAction("create_case"), async (req, res) => {
  // CreateCaseBody is `record<string, unknown>` in OpenAPI — we still want
  // to reject non-objects (arrays, primitives, null) so the worker never sees
  // garbage that would dead-letter post-enqueue.
  const parsed = CreateCaseBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ status: "error", code: "validation_failed", message: "Body must be a JSON object", details: parsed.error.flatten() });
    return;
  }
  const firmId = requireFirmId(req);
  const data = parsed.data;
  const case_id = crypto.randomUUID();

  // Carry the creator's id into the worker so the new row gets a non-null
  // `created_by_user_id`, which is what the viewer-ownership filter on
  // GET / and GET /:id reads. The dev-mode synthetic user is `id=0`; we
  // store null in that case so dev-only cases never leak into a real
  // viewer's filtered list.
  const created_by_user_id =
    req.user && req.user.id > 0 ? req.user.id : null;

  const job_id = await enqueueJob("create_case", { case_id, data, created_by_user_id, firm_id: firmId });

  await auditLog("case", case_id, "intake_submitted", { data, created_by_user_id }, {
    ip_address: req.ip,
    user_agent: req.get("user-agent"),
  });

  res.status(201).json({ case_id, status: "queued", job_id });
});

router.post("/:id/upload", requirePermission(Permission.CASE_UPLOAD), auditAction("upload_case_file"), async (req, res) => {
  const case_id = String(req.params.id);
  if (!validateCaseId(case_id)) {
    res.status(400).json({ status: "error", code: "invalid_case_id", message: "Invalid case ID format (expected UUID)" });
    return;
  }

  const firmId = requireFirmId(req);
  const parsed = UploadCaseFileBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ status: "error", code: "validation_failed", message: "Invalid request body", details: parsed.error.flatten() });
    return;
  }
  const { file_name, content, content_type } = parsed.data;

  if (file_name.length > MAX_FILE_NAME_LEN) {
    res.status(400).json({ status: "error", code: "file_name_too_long", message: `file_name max length is ${MAX_FILE_NAME_LEN}` });
    return;
  }
  // Reject path-traversal in file_name early. We only ever use the basename
  // server-side but a stored audit/log line containing "../etc/passwd" would
  // be misleading and the saveFile() implementation in worker has no
  // additional guard if a future change wires `file_name` into a path.
  if (file_name.includes("/") || file_name.includes("\\") || file_name.includes("..")) {
    res.status(400).json({ status: "error", code: "invalid_file_name", message: "file_name must not contain path separators or '..'" });
    return;
  }
  if (content.length > MAX_CONTENT_BASE64_BYTES) {
    res.status(413).json({ status: "error", code: "payload_too_large", message: `content base64 size exceeds ${MAX_CONTENT_BASE64_BYTES} bytes` });
    return;
  }

  const job_id = await enqueueJob("ingest_file", {
    case_id,
    file_name,
    content,
    firm_id: firmId,
    // The worker treats a missing content_type as "let the OCR/MIME sniffer
    // decide". Drizzle's payload column is jsonb so undefined drops the key
    // (preferred) — coercing to null was a TS mismatch and added noise.
    content_type: content_type ?? undefined,
  });

  await auditLog("case", case_id, "file_upload_queued", { file_name }, {
    ip_address: req.ip,
    user_agent: req.get("user-agent"),
  });

  res.json({ case_id, status: "queued", job_id, file_name });
});

// Allow-list of statuses an HTTP caller (or n8n workflow) is permitted
// to set. The full state machine is wider, but only a few transitions are
// safe to expose to automations — anything else stays worker-only.
const SETTABLE_CASE_STATUSES = [
  "documents_received",
  "ready_for_review",
  "client_signed",
  "filed",
  "review_required",
  "closed",
] as const;

const PatchCaseStatusBody = z.object({
  status: z.enum(SETTABLE_CASE_STATUSES),
  reason: z.string().trim().max(500).optional(),
});

/**
 * Manual / automation-driven case stage advancement (Task #52). Used by
 * the n8n "case auto-advance" workflow once required documents have been
 * received. Goes through `updateCaseStatus`, which guarantees the
 * `case.stage_changed` event fires (no-op if status is unchanged).
 */
router.patch("/:id/status", requirePermission(Permission.CASE_ANALYZE), async (req, res) => {
  const case_id = String(req.params.id);
  if (!validateCaseId(case_id)) {
    badRequest(res, "Invalid case ID format");
    return;
  }
  const firmId = requireFirmId(req);
  const parsed = PatchCaseStatusBody.safeParse(req.body);
  if (!parsed.success) {
    badRequest(res, "Invalid request body", parsed.error.issues);
    return;
  }
  const result = await updateCaseStatus({
    case_id,
    new_status: parsed.data.status,
    changed_by: req.user!.id,
    firm_id: firmId,
    context: parsed.data.reason ? { reason: parsed.data.reason } : undefined,
    source: "http:patch_case_status",
  });
  if (!result.ok) {
    notFound(res);
    return;
  }
  res.json({
    case_id,
    old_status: result.old_status,
    new_status: result.new_status,
    transitioned: result.transitioned,
  });
});

router.post("/:id/analyze", requirePermission(Permission.CASE_ANALYZE), async (req, res) => {
  const case_id = String(req.params.id);
  if (!validateCaseId(case_id)) {
    badRequest(res, "Invalid case ID format");
    return;
  }
  const firmId = requireFirmId(req);

  const job_id = await enqueueJob("analyze_case", { case_id, firm_id: firmId });

  await auditLog("case", case_id, "analysis_queued", {}, {
    ip_address: req.ip,
    user_agent: req.get("user-agent"),
  });

  res.json({ case_id, status: "queued", job_id });
});

router.get("/", requirePermission(Permission.CASE_VIEW_OWN, Permission.CASE_VIEW_ANY), async (req, res) => {
  // Ownership filter: viewer sees only rows they own (created_by_user_id)
  // or are assigned to (assigned_to). paralegal/attorney/admin see all
  // rows — paralegals must triage the whole intake queue. Rows with both
  // ownership columns NULL are visible only to paralegal+.
  const user = req.user!;
  const firmId = requireFirmId(req);
  const isViewerOnly = user.role === "viewer";
  const rows = isViewerOnly
    ? await db
        .select()
        .from(casesTable)
        .where(
          and(
            eq(casesTable.firm_id, firmId),
            or(
              eq(casesTable.created_by_user_id, user.id),
              eq(casesTable.assigned_to, user.id),
            ),
          ),
        )
        .orderBy(desc(casesTable.created_at))
        .limit(100)
    : await db
        .select()
        .from(casesTable)
        .where(eq(casesTable.firm_id, firmId))
        .orderBy(desc(casesTable.created_at))
        .limit(100);
  res.json(rows);
});

// NOTE: worker admin routes are registered BEFORE the parameterized
// `/:id` route so a future change to that param's pattern can't shadow
// them. Express matches in registration order.
router.get("/worker/queue-stats", requirePermission(Permission.CASE_WORKER_ADMIN), async (req, res) => {
  const stats = await getQueueStats();
  res.json(stats);
});

router.get("/worker/jobs", requirePermission(Permission.CASE_WORKER_ADMIN), async (req, res) => {
  const statusFilter = typeof req.query.status === "string" ? req.query.status : undefined;
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const firmId = requireFirmId(req);

  const rows = await db
    .select({
      id: jobQueueTable.id,
      job_type: jobQueueTable.job_type,
      status: jobQueueTable.status,
      error: jobQueueTable.error,
      retry_count: jobQueueTable.retry_count,
      created_at: jobQueueTable.created_at,
      started_at: jobQueueTable.started_at,
      completed_at: jobQueueTable.completed_at,
      payload: jobQueueTable.payload,
    })
    .from(jobQueueTable)
    .where(
      and(
        statusFilter ? eq(jobQueueTable.status, statusFilter) : undefined,
        eq(jobQueueTable.firm_id, firmId),
      ),
    )
    .orderBy(desc(jobQueueTable.created_at))
    .limit(limit);

  const jobs = rows.map((row) => {
    const payload = row.payload as Record<string, unknown> | null;
    return {
      id: row.id,
      job_type: row.job_type,
      status: row.status,
      error: row.error ?? null,
      retry_count: row.retry_count,
      created_at: row.created_at,
      started_at: row.started_at ?? null,
      completed_at: row.completed_at ?? null,
      case_id: (payload?.case_id as string | undefined) ?? null,
    };
  });

  res.json(jobs);
});

// Admin: requeue a dead-lettered job after the underlying issue has been
// fixed (e.g. vendor outage resolved, missing API key added). Resets
// retry_count to 0 so the operator gets a clean fresh attempt.
router.post(
  "/worker/jobs/:id/requeue",
  requirePermission(Permission.CASE_WORKER_ADMIN),
  auditAction("requeue_dead_letter_job"),
  async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      badRequest(res, "Invalid job id");
      return;
    }
    const ok = await requeueDeadLetterJob(id);
    if (!ok) {
      notFound(res, "Job not found or not in dead_letter status");
      return;
    }
    res.json({ ok: true, job_id: id, status: "pending" });
  },
);

router.get("/:id", requirePermission(Permission.CASE_VIEW_OWN, Permission.CASE_VIEW_ANY), async (req, res) => {
  const case_id = String(req.params.id);
  if (!validateCaseId(case_id)) {
    badRequest(res, "Invalid case ID format");
    return;
  }

  const firmId = requireFirmId(req);

  // Fetch the case first so we can 404 fast without touching the children.
  const [caseRow] = await db
    .select()
    .from(casesTable)
    .where(and(eq(casesTable.id, case_id), eq(casesTable.firm_id, firmId)));

  if (!caseRow) {
    notFound(res, "Case not found");
    return;
  }

  // Ownership check: mirrors the GET / filter. Only the viewer role is
  // restricted; paralegal+ see every case.
  // We emit 403 (not 404) so the CRM can show a clear "no access" banner;
  // case ids are opaque UUIDs so existence-leak is low-value.
  const user = req.user!;
  if (!isCaseVisibleToUser(user, caseRow)) {
    denyForbidden(req, res, "case_ownership_denied", "Insufficient permissions", {
      case_id,
      owner_user_id: caseRow.created_by_user_id,
      assigned_to: caseRow.assigned_to,
    });
    return;
  }

  // Children are independent — fetch in parallel to cut latency ~3×.
  // Note: caseDocumentsTable and analysisTable don't have firm_id directly (they link via case_id).
  // auditLogTable has firm_id.
  const [docs, analyses, auditEntries] = await Promise.all([
    db.select().from(caseDocumentsTable).where(eq(caseDocumentsTable.case_id, case_id)),
    db.select().from(analysisTable).where(eq(analysisTable.case_id, case_id)).orderBy(desc(analysisTable.created_at)),
    db.select().from(auditLogTable).where(and(eq(auditLogTable.entity_id, case_id), eq(auditLogTable.firm_id, firmId))).orderBy(desc(auditLogTable.occurred_at)).limit(50),
  ]);

  res.json({
    case: caseRow,
    documents: docs,
    analyses,
    audit_trail: auditEntries,
  });
});

export default router;
