import { Router, type Request, type Response } from "express";
import { db, leadsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { generateDraft, getAvailableTemplates } from "../lib/drafting-ai";
import { createBlankPdfWithText } from "../lib/pdf-redaction";
import { decryptLeadFields } from "../lib/encryption";
import { Permission, requirePermission, auditAction } from "../lib/rbac";
import { requireFirmId } from "../lib/firm-scope";
import { logger } from "../lib/logger";
import { badRequest, notFound, serverError } from "../lib/http-errors";

const router = Router();

router.get("/templates", requirePermission(Permission.DRAFTING_TEMPLATES_VIEW), async (_req, res) => {
  res.json(getAvailableTemplates());
});

// Resolve and firm-scope the optional lead_id. Centralizes the cross-firm
// check so generate + generate-pdf can't drift apart and one can't end up
// strict while the other leaks. Returns:
//   { ok: true, leadData }  — caller proceeds (leadData={} when no id given)
//   { ok: false }           — response already sent (400 / 404 / 500)
async function resolveLeadData(
  req: Request,
  res: Response,
  rawLeadId: unknown,
): Promise<{ ok: true; leadData: Record<string, any> } | { ok: false }> {
  if (rawLeadId == null || rawLeadId === "") {
    return { ok: true, leadData: {} };
  }
  const id = Number(rawLeadId);
  if (!Number.isInteger(id) || id <= 0) {
    badRequest(res, "lead_id must be a positive integer");
    return { ok: false };
  }
  try {
    const firmId = requireFirmId(req);
    const [lead] = await db
      .select()
      .from(leadsTable)
      .where(and(eq(leadsTable.id, id), eq(leadsTable.firm_id, firmId)));
    if (!lead) {
      notFound(res, "Lead not found");
      return { ok: false };
    }
    // Task #8: bind AAD to lead.id (per-row scoping).
    return { ok: true, leadData: decryptLeadFields(lead, String(lead.id)) };
  } catch (err: any) {
    logger.error({ err: err?.message, leadId: id }, "drafting: lead fetch failed");
    serverError(res, "Failed to load lead");
    return { ok: false };
  }
}

router.post("/generate", requirePermission(Permission.DRAFTING_GENERATE), auditAction("generate_draft"), async (req, res) => {
  const { template_type, lead_id, firm_name, attorney_name, custom_instructions } = req.body;
  if (!template_type) { badRequest(res, "template_type is required"); return; }

  const resolved = await resolveLeadData(req, res, lead_id);
  if (!resolved.ok) return;

  const draft = await generateDraft({
    template_type,
    lead_data: resolved.leadData,
    firm_name,
    attorney_name,
    custom_instructions,
  });

  res.json(draft);
});

router.post("/generate-pdf", requirePermission(Permission.DRAFTING_GENERATE), auditAction("generate_draft_pdf"), async (req, res) => {
  const { template_type, lead_id, firm_name, attorney_name, custom_instructions } = req.body;
  if (!template_type) { badRequest(res, "template_type is required"); return; }

  const resolved = await resolveLeadData(req, res, lead_id);
  if (!resolved.ok) return;

  const draft = await generateDraft({
    template_type,
    lead_data: resolved.leadData,
    firm_name,
    attorney_name,
    custom_instructions,
  });

  const pdfBytes = await createBlankPdfWithText(draft.content, draft.title);
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${draft.title.replace(/\s/g, "_")}.pdf"`);
  res.send(Buffer.from(pdfBytes));
});

export default router;
