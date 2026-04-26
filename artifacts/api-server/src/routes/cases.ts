import { Router } from "express";
import { db, casesTable, analysisTable, caseDocumentsTable, auditLogTable } from "@workspace/db";
import { eq, sql, desc } from "drizzle-orm";
import { enqueueJob, getQueueStats, requeueDeadLetterJob } from "../lib/queue";
import { auditLog } from "../lib/audit";
import crypto from "crypto";
import { requireRole, auditAction } from "../lib/rbac";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validateCaseId(id: string): boolean {
  return UUID_REGEX.test(id);
}

const router = Router();

router.post("/", requireRole("paralegal", "attorney", "admin"), auditAction("create_case"), async (req, res) => {
  const data = req.body as Record<string, unknown>;
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
    res.status(400).json({ error: "Invalid case ID format" });
    return;
  }

  const { file_name, content, content_type } = req.body as {
    file_name: string;
    content: string;
    content_type?: string;
  };

  if (!file_name || !content) {
    res.status(400).json({ error: "file_name and content are required" });
    return;
  }

  const job_id = await enqueueJob("ingest_file", {
    case_id,
    file_name,
    content,
    content_type,
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
