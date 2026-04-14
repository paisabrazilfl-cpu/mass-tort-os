import { Router } from "express";
import { db, leadsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { generateDraft, getAvailableTemplates } from "../lib/drafting-ai";
import { createBlankPdfWithText } from "../lib/pdf-redaction";
import { decryptLeadFields } from "../lib/encryption";

const router = Router();

router.get("/templates", async (_req, res) => {
  res.json(getAvailableTemplates());
});

router.post("/generate", async (req, res) => {
  const { template_type, lead_id, firm_name, attorney_name, custom_instructions } = req.body;
  if (!template_type) { res.status(400).json({ error: "template_type is required" }); return; }

  let leadData: Record<string, any> = {};
  if (lead_id) {
    const [lead] = await db.select().from(leadsTable).where(eq(leadsTable.id, parseInt(lead_id)));
    if (!lead) { res.status(404).json({ error: "Lead not found" }); return; }
    leadData = decryptLeadFields(lead);
  }

  const draft = await generateDraft({
    template_type,
    lead_data: leadData,
    firm_name,
    attorney_name,
    custom_instructions,
  });

  res.json(draft);
});

router.post("/generate-pdf", async (req, res) => {
  const { template_type, lead_id, firm_name, attorney_name, custom_instructions } = req.body;
  if (!template_type) { res.status(400).json({ error: "template_type is required" }); return; }

  let leadData: Record<string, any> = {};
  if (lead_id) {
    const [lead] = await db.select().from(leadsTable).where(eq(leadsTable.id, parseInt(lead_id)));
    if (lead) leadData = decryptLeadFields(lead);
  }

  const draft = await generateDraft({
    template_type,
    lead_data: leadData,
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
