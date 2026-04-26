import { Router } from "express";
import { db, casesTable, analysisTable, caseDocumentsTable, auditLogTable } from "@workspace/db";
import { eq, sql, desc } from "drizzle-orm";
import { CreateCaseBody, UploadCaseFileBody } from "@workspace/api-zod";
import { enqueueJob, getQueueStats, requeueDeadLetterJob } from "../lib/queue";
import { auditLog } from "../lib/audit";
import crypto from "crypto";
import { requireRole, auditAction } from "../lib/rbac";

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

router.post("/", requireRole("paralegal", "attorney", "admin"), auditAction("create_case"), async (req, res) => {
  // CreateCaseBody is `record<string, unknown>` in OpenAPI — we still want
  // to reject non-objects (arrays, primitives, null) so the worker never sees
  // garbage that would dead-letter post-enqueue.
  const parsed = CreateCaseBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ status: "error", code: "validation_failed", message: "Body must be a JSON object", details: parsed.error.flatten() });
    return;
  }
  const data = parsed.data;
  const case_id = crypto.randomUUID();

  const job_id = await enqueueJob("create_case", { case_id, data });

  await auditLog("case", case_id, "intake_submitted", { data }, {
    ip_address: req.ip,
    user_agent: req.get("user-agent"),
  });

  res.status(201).json({ case_id, status: "queued", job_id });
});

router.post("/:id/upload", requireRole("paralegal", "attorney", "admin"), auditAction("upload_case_file"), async (req, res) => {
  const case_id = String(req.params.id);
  if (!validateCaseId(case_id)) {
    res.status(400).json({ status: "error", code: "invalid_case_id", message: "Invalid case ID format (expected UUID)" });
    return;
  }

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

router.post("/:id/analyze", requireRole("paralegal"), async (req, res) => {
  const case_id = String(req.params.id);
  if (!validateCaseId(case_id)) {
    res.status(400).json({ error: "Invalid case ID format" });
    return;
  }

  const job_id = await enqueueJob("analyze_case", { case_id });

  await auditLog("case", case_id, "analysis_queued", {}, {
    ip_address: req.ip,
    user_agent: req.get("user-agent"),
  });

  res.json({ case_id, status: "queued", job_id });
});

router.get("/", requireRole("viewer"), async (req, res) => {
  const cases = await db
    .select()
    .from(casesTable)
    .orderBy(desc(casesTable.created_at))
    .limit(100);
  res.json(cases);
});

// NOTE: worker admin routes are registered BEFORE the parameterized
// `/:id` route so a future change to that param's pattern can't shadow
// them. Express matches in registration order.
router.get("/worker/queue-stats", requireRole("admin"), async (req, res) => {
  const stats = await getQueueStats();
  res.json(stats);
});

// Admin: requeue a dead-lettered job after the underlying issue has been
// fixed (e.g. vendor outage resolved, missing API key added). Resets
// retry_count to 0 so the operator gets a clean fresh attempt.
router.post(
  "/worker/jobs/:id/requeue",
  requireRole("admin"),
  auditAction("requeue_dead_letter_job"),
  async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "Invalid job id" });
      return;
    }
    const ok = await requeueDeadLetterJob(id);
    if (!ok) {
      res.status(404).json({ error: "Job not found or not in dead_letter status" });
      return;
    }
    res.json({ ok: true, job_id: id, status: "pending" });
  },
);

router.get("/:id", requireRole("viewer"), async (req, res) => {
  const case_id = String(req.params.id);
  if (!validateCaseId(case_id)) {
    res.status(400).json({ error: "Invalid case ID format" });
    return;
  }

  // Fetch the case first so we can 404 fast without touching the children.
  const [caseRow] = await db
    .select()
    .from(casesTable)
    .where(eq(casesTable.id, case_id));

  if (!caseRow) {
    res.status(404).json({ error: "Case not found" });
    return;
  }

  // Children are independent — fetch in parallel to cut latency ~3×.
  const [docs, analyses, auditEntries] = await Promise.all([
    db.select().from(caseDocumentsTable).where(eq(caseDocumentsTable.case_id, case_id)),
    db.select().from(analysisTable).where(eq(analysisTable.case_id, case_id)).orderBy(desc(analysisTable.created_at)),
    db.select().from(auditLogTable).where(eq(auditLogTable.entity_id, case_id)).orderBy(desc(auditLogTable.occurred_at)).limit(50),
  ]);

  res.json({
    case: caseRow,
    documents: docs,
    analyses,
    audit_trail: auditEntries,
  });
});

export default router;
