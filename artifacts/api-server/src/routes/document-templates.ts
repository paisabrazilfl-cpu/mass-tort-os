import { Router } from "express";
import { db, documentTemplatesTable, templateAssignmentsTable } from "@workspace/db";
import { and, eq, isNull } from "drizzle-orm";
import { authMiddleware, requireRole } from "../lib/rbac";
import { auditAction } from "../lib/rbac";
import { z } from "zod/v4";
import { uploadTemplate, deleteTemplate, downloadTemplate } from "../lib/template-storage";

const router = Router();
router.use(authMiddleware);

const templateSchema = z.object({
  name: z.string().min(1).max(255),
  template_type: z.string().min(1).max(50),
  description: z.string().nullish(),
  source: z.enum(["pdf", "ai"]).default("pdf"),
  storage_path: z.string().nullish(),
  ai_prompt: z.string().nullish(),
  requires_signature: z.boolean().default(true),
  signer_role: z.string().max(50).default("lead"),
  merge_fields: z.array(z.string()).default([]),
  delivery_subject: z.string().max(255).nullish(),
  delivery_message: z.string().nullish(),
  triggers_med_records_request: z.boolean().default(false),
  active: z.boolean().default(true),
});

const assignmentSchema = z.object({
  template_id: z.number().int(),
  buyer_id: z.number().int().nullish(),
  tort_type: z.string().max(100).nullish(),
  enabled: z.boolean().default(true),
  send_order: z.number().int().default(0),
  notes: z.string().nullish(),
});

// ---------- Templates ----------

router.get("/", requireRole("viewer"), async (_req, res) => {
  const rows = await db.select().from(documentTemplatesTable).orderBy(documentTemplatesTable.name);
  res.json(rows);
});

router.get("/:id", requireRole("viewer"), async (req, res) => {
  const id = Number(req.params.id);
  const [row] = await db.select().from(documentTemplatesTable).where(eq(documentTemplatesTable.id, id));
  if (!row) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json(row);
});

router.post("/", requireRole("admin"), auditAction("create_template"), async (req, res) => {
  const parsed = templateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const data = parsed.data;
  if (data.source === "pdf" && !data.storage_path) {
    res.status(400).json({ error: "pdf_template_requires_storage_path" });
    return;
  }
  if (data.source === "ai" && !data.ai_prompt) {
    res.status(400).json({ error: "ai_template_requires_prompt" });
    return;
  }
  const [row] = await db
    .insert(documentTemplatesTable)
    .values({ ...data, uploaded_by_user_id: req.user?.id ?? null } as any)
    .returning();
  res.status(201).json(row);
});

router.put("/:id", requireRole("admin"), auditAction("update_template"), async (req, res) => {
  const id = Number(req.params.id);
  const parsed = templateSchema.partial().safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const updates = { ...parsed.data, updated_at: new Date() } as any;
  const [row] = await db
    .update(documentTemplatesTable)
    .set(updates)
    .where(eq(documentTemplatesTable.id, id))
    .returning();
  if (!row) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json(row);
});

router.delete("/:id", requireRole("admin"), auditAction("delete_template"), async (req, res) => {
  const id = Number(req.params.id);
  const [existing] = await db.select().from(documentTemplatesTable).where(eq(documentTemplatesTable.id, id));
  if (!existing) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  if (existing.storage_path) {
    await deleteTemplate(existing.storage_path).catch(() => {
      /* file may already be gone */
    });
  }
  await db.delete(documentTemplatesTable).where(eq(documentTemplatesTable.id, id));
  res.status(204).end();
});

/**
 * Upload a PDF and return the storage path. Client then POSTs to /
 * with that storage_path to actually create the template row.
 * Body: { fileName: string, base64: string }
 */
router.post("/upload", requireRole("admin"), auditAction("upload_template_pdf"), async (req, res) => {
  const { fileName, base64 } = req.body || {};
  if (!fileName || typeof fileName !== "string") {
    res.status(400).json({ error: "fileName_required" });
    return;
  }
  if (!base64 || typeof base64 !== "string") {
    res.status(400).json({ error: "base64_required" });
    return;
  }
  try {
    const buf = Buffer.from(base64, "base64");
    if (buf.length === 0) {
      res.status(400).json({ error: "empty_file" });
      return;
    }
    if (buf.length > 25 * 1024 * 1024) {
      res.status(413).json({ error: "file_too_large", max_bytes: 25 * 1024 * 1024 });
      return;
    }
    const stored = await uploadTemplate(buf, fileName);
    res.status(201).json(stored);
  } catch (err: any) {
    res.status(500).json({ error: "upload_failed", message: String(err?.message || err) });
  }
});

router.get("/:id/preview", requireRole("viewer"), async (req, res) => {
  const id = Number(req.params.id);
  const [row] = await db.select().from(documentTemplatesTable).where(eq(documentTemplatesTable.id, id));
  if (!row || !row.storage_path) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  try {
    const buf = await downloadTemplate(row.storage_path);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${row.name}.pdf"`);
    res.send(buf);
  } catch {
    res.status(404).json({ error: "file_missing" });
  }
});

// ---------- Assignments (buyer × tort × template) ----------

router.get("/assignments/all", requireRole("viewer"), async (_req, res) => {
  const rows = await db.select().from(templateAssignmentsTable);
  res.json(rows);
});

router.get("/assignments/by-template/:templateId", requireRole("viewer"), async (req, res) => {
  const templateId = Number(req.params.templateId);
  const rows = await db
    .select()
    .from(templateAssignmentsTable)
    .where(eq(templateAssignmentsTable.template_id, templateId));
  res.json(rows);
});

router.post("/assignments", requireRole("admin"), auditAction("upsert_template_assignment"), async (req, res) => {
  const parsed = assignmentSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const d = parsed.data;
  // Upsert: same (template, buyer, tort) tuple updates instead of duplicating.
  const buyerCond = d.buyer_id == null
    ? isNull(templateAssignmentsTable.buyer_id)
    : eq(templateAssignmentsTable.buyer_id, d.buyer_id);
  const tortCond = d.tort_type == null
    ? isNull(templateAssignmentsTable.tort_type)
    : eq(templateAssignmentsTable.tort_type, d.tort_type);
  const existing = await db
    .select()
    .from(templateAssignmentsTable)
    .where(
      and(
        eq(templateAssignmentsTable.template_id, d.template_id),
        buyerCond,
        tortCond,
      ),
    );
  if (existing.length > 0) {
    const [row] = await db
      .update(templateAssignmentsTable)
      .set({
        enabled: d.enabled,
        send_order: d.send_order,
        notes: d.notes ?? null,
        updated_by_user_id: req.user?.id ?? null,
        updated_at: new Date(),
      })
      .where(eq(templateAssignmentsTable.id, existing[0].id))
      .returning();
    res.json(row);
    return;
  }
  const [row] = await db
    .insert(templateAssignmentsTable)
    .values({ ...d, updated_by_user_id: req.user?.id ?? null } as any)
    .returning();
  res.status(201).json(row);
});

router.delete("/assignments/:id", requireRole("admin"), auditAction("delete_template_assignment"), async (req, res) => {
  const id = Number(req.params.id);
  await db.delete(templateAssignmentsTable).where(eq(templateAssignmentsTable.id, id));
  res.status(204).end();
});

export default router;
