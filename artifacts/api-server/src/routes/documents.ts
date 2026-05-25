import { Router } from "express";
import { db, documentsTable, leadsTable } from "@workspace/db";
import { eq, and, sql, desc } from "drizzle-orm";
import { badRequest, notFound, serverError, errorEnvelope } from "../lib/http-errors";
import { requireFirmId } from "../lib/firm-scope";
import { logger } from "../lib/logger";
import {
  ListDocumentsQueryParams,
  CreateDocumentBody,
  UpdateDocumentBody,
  UpdateDocumentParams,
  DeleteDocumentParams,
} from "@workspace/api-zod";
import { redactPdf, highlightPdfRegions, getPdfPageCount, RedactionNotImplementedError } from "../lib/pdf-redaction";
import { Permission, requirePermission, auditAction } from "../lib/rbac";
// pdf-lib is heavy (~830 KB with transitives) and externalized in the
// production bundle. Load on demand inside renderPlaceholderPdf so importing
// this route file at boot does not crash when pdf-lib is absent from the
// runtime node_modules (Replit Autoscale ships only dist/, not node_modules).
type PdfLib = typeof import("pdf-lib");
let pdfLibModule: PdfLib | null = null;
async function loadPdfLib(): Promise<PdfLib> {
  if (!pdfLibModule) pdfLibModule = await import("pdf-lib");
  return pdfLibModule;
}

const router = Router();

// Render a placeholder PDF for documents that have no real file backing them yet
// (e.g. seeded sample rows, or records created from an automation step before
// the file content has been attached). Keeps the Document Center "View" action
// honest — the user always gets *something* viewable, with a clear note that
// no file is attached, instead of a dead link.
async function renderPlaceholderPdf(doc: {
  id: number;
  lead_id: number;
  document_type: string;
  file_name: string;
  signed: boolean;
  signed_at: Date | null;
  notes: string | null;
  created_at: Date;
}): Promise<Uint8Array> {
  const { PDFDocument, StandardFonts, rgb } = await loadPdfLib();
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]); // US Letter
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  const draw = (text: string, x: number, y: number, opts?: { size?: number; bold?: boolean; color?: ReturnType<typeof rgb> }) => {
    page.drawText(text, {
      x,
      y,
      size: opts?.size ?? 11,
      font: opts?.bold ? bold : font,
      color: opts?.color ?? rgb(0.1, 0.1, 0.1),
    });
  };

  draw(doc.file_name, 50, 740, { size: 18, bold: true });
  draw(`Document Type: ${doc.document_type.replace(/_/g, " ")}`, 50, 710, { size: 12 });
  draw(`Lead ID: #${doc.lead_id}`, 50, 690);
  draw(`Status: ${doc.signed ? "Signed" : "Pending"}`, 50, 672);
  draw(`Created: ${doc.created_at.toISOString()}`, 50, 654);
  if (doc.signed_at) draw(`Signed: ${doc.signed_at.toISOString()}`, 50, 636);

  page.drawRectangle({
    x: 50,
    y: 540,
    width: 512,
    height: 70,
    borderColor: rgb(0.85, 0.6, 0.05),
    borderWidth: 1,
    color: rgb(1, 0.97, 0.88),
  });
  draw("No file attached", 60, 588, { size: 13, bold: true, color: rgb(0.55, 0.35, 0) });
  draw("This document record exists in the database but no file has been uploaded yet.", 60, 568, { size: 10, color: rgb(0.3, 0.3, 0.3) });
  draw("Attach a PDF via the lead's Documents tab or an automation handler to replace this placeholder.", 60, 552, { size: 10, color: rgb(0.3, 0.3, 0.3) });

  if (doc.notes) {
    draw("Notes", 50, 510, { size: 12, bold: true });
    const notes = doc.notes.length > 1500 ? doc.notes.slice(0, 1500) + "…" : doc.notes;
    const wrapped = notes.match(/.{1,90}/g) ?? [];
    wrapped.slice(0, 25).forEach((line, i) => draw(line, 50, 492 - i * 14, { size: 10 }));
  }

  draw(`Document #${doc.id} — Mass Tort OS`, 50, 40, { size: 9, color: rgb(0.5, 0.5, 0.5) });

  return pdf.save();
}

router.get("/:id/view", requirePermission(Permission.DOCUMENTS_VIEW), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) {
    badRequest(res, "Invalid document id");
    return;
  }

  // documents.lead_id → leads.firm_id; scope through the parent lead so
  // a caller from firm A can't view firm B's documents by guessing the id.
  let doc: typeof documentsTable.$inferSelect | undefined;
  try {
    const firmId = requireFirmId(req);
    const rows = await db
      .select({ d: documentsTable })
      .from(documentsTable)
      .innerJoin(leadsTable, eq(leadsTable.id, documentsTable.lead_id))
      .where(and(eq(documentsTable.id, id), eq(leadsTable.firm_id, firmId)))
      .limit(1);
    doc = rows[0]?.d;
  } catch (err: any) {
    logger.error({ err: err?.message, id }, "documents GET /:id/view failed");
    serverError(res, "Failed to load document");
    return;
  }
  if (!doc) {
    notFound(res, "Document not found");
    return;
  }

  const url = doc.file_url?.trim();
  if (url && /^https?:\/\//i.test(url)) {
    // External file_url — let the browser fetch it directly. We don't proxy
    // here to avoid SSRF / large-file streaming concerns; the source URL was
    // already supplied by an authenticated operator at upload time.
    res.redirect(302, url);
    return;
  }

  // No real file → render the placeholder so the operator always gets a
  // viewable PDF instead of a broken link.
  try {
    const pdfBytes = await renderPlaceholderPdf(doc);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${doc.file_name.replace(/[^a-zA-Z0-9._-]/g, "_")}"`);
    res.setHeader("Cache-Control", "private, no-store");
    res.send(Buffer.from(pdfBytes));
  } catch (err) {
    req.log.error({ err, document_id: id }, "Failed to render document placeholder PDF");
    serverError(res, "Failed to render document");
  }
});

router.get("/", requirePermission(Permission.DOCUMENTS_VIEW), async (req, res) => {
  const parsed = ListDocumentsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    badRequest(res, "Invalid request body", parsed.error.flatten());
    return;
  }

  const firmId = requireFirmId(req);
  const { lead_id } = parsed.data;

  // Pagination cap — defaults 50/page, hard ceiling 500. Without this the
  // endpoint would pull every document row in the system on each call.
  const rawLimit = Number(req.query.limit ?? 50);
  const rawOffset = Number(req.query.offset ?? 0);
  const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? rawLimit : 50, 1), 500);
  const offset = Math.max(Number.isFinite(rawOffset) ? rawOffset : 0, 0);

  // Scope every list query through leads.firm_id. Without the firm filter
  // the no-lead_id branch was returning every document in the database, and
  // the lead_id branch wasn't verifying the caller could see that lead. An
  // INNER JOIN through leads gives us both safeguards in one predicate, and
  // the leads_firm_id_idx makes the firm filter cheap.
  try {
    const firmId = requireFirmId(req);
    const baseConds = [eq(leadsTable.firm_id, firmId)];
    if (lead_id) baseConds.push(eq(documentsTable.lead_id, lead_id));
    const rows = await db
      .select({ d: documentsTable })
      .from(documentsTable)
      .innerJoin(leadsTable, eq(leadsTable.id, documentsTable.lead_id))
      .where(and(...baseConds))
      .orderBy(desc(documentsTable.created_at))
      .limit(limit)
      .offset(offset);
    res.json(rows.map((r) => r.d));
  } catch (err: any) {
    logger.error({ err: err?.message, lead_id }, "documents GET / failed");
    serverError(res, "Failed to list documents");
  }
});

router.post("/", requirePermission(Permission.DOCUMENTS_CREATE), auditAction("create_document"), async (req, res) => {
  const parsed = CreateDocumentBody.safeParse(req.body);
  if (!parsed.success) {
    badRequest(res, "Invalid request body", parsed.error.flatten());
    return;
  }

  const firmId = requireFirmId(req);
  const data = parsed.data;
  try {
    // Verify the parent lead belongs to the caller's firm BEFORE inserting,
    // otherwise an operator from firm A could attach a document row to firm B's
    // lead and later read/edit it via the (now firm-scoped) list/view routes.
    const [lead] = await db
      .select({ id: leadsTable.id })
      .from(leadsTable)
      .where(and(eq(leadsTable.id, data.lead_id), eq(leadsTable.firm_id, firmId)))
      .limit(1);
    if (!lead) { notFound(res, "Lead not found"); return; }

    const [doc] = await db
      .insert(documentsTable)
      .values({
        lead_id: data.lead_id,
        document_type: data.document_type,
        file_name: data.file_name,
        file_url: data.file_url ?? null,
        signed: data.signed,
        signed_at: data.signed_at ? new Date(data.signed_at) : null,
        notes: data.notes ?? null,
      })
      .returning();

    res.status(201).json(doc);
  } catch (err: any) {
    logger.error({ err: err?.message, lead_id: data.lead_id }, "documents POST / failed");
    serverError(res, "Failed to create document");
  }
});

router.patch("/:id", requirePermission(Permission.DOCUMENTS_UPDATE), auditAction("update_document"), async (req, res) => {
  const paramsParsed = UpdateDocumentParams.safeParse({ id: Number(req.params.id) });
  if (!paramsParsed.success) {
    badRequest(res, "Invalid path parameters", paramsParsed.error.flatten());
    return;
  }

  const bodyParsed = UpdateDocumentBody.safeParse(req.body);
  if (!bodyParsed.success) {
    badRequest(res, "Invalid request body", bodyParsed.error.flatten());
    return;
  }

  const firmId = requireFirmId(req);
  const body = bodyParsed.data;
  const updateData: Record<string, unknown> = {};

  if (body.document_type !== undefined) updateData.document_type = body.document_type;
  if (body.file_name !== undefined) updateData.file_name = body.file_name;
  if (body.file_url !== undefined) updateData.file_url = body.file_url;
  if (body.signed !== undefined) updateData.signed = body.signed;
  if (body.signed_at !== undefined) updateData.signed_at = body.signed_at ? new Date(body.signed_at) : null;
  if (body.notes !== undefined) updateData.notes = body.notes;

  try {
    // Scope the UPDATE via a subquery on leads.firm_id. Without this any
    // operator could PATCH any document in the system by id.
    const scopedLeadIds = db
      .select({ id: leadsTable.id })
      .from(leadsTable)
      .where(eq(leadsTable.firm_id, firmId));
    const [doc] = await db
      .update(documentsTable)
      .set(updateData)
      .where(and(
        eq(documentsTable.id, paramsParsed.data.id),
        sql`${documentsTable.lead_id} IN ${scopedLeadIds}`,
      ))
      .returning();

    if (!doc) { notFound(res, "Document not found"); return; }
    res.json(doc);
  } catch (err: any) {
    logger.error({ err: err?.message, id: paramsParsed.data.id }, "documents PATCH /:id failed");
    serverError(res, "Failed to update document");
  }
});

router.delete("/:id", requirePermission(Permission.DOCUMENTS_DELETE), auditAction("delete_document"), async (req, res) => {
  const parsed = DeleteDocumentParams.safeParse({ id: Number(req.params.id) });
  if (!parsed.success) {
    badRequest(res, "Invalid request body", parsed.error.flatten());
    return;
  }

  try {
    const firmId = requireFirmId(req);
    const scopedLeadIds = db
      .select({ id: leadsTable.id })
      .from(leadsTable)
      .where(eq(leadsTable.firm_id, firmId));
    const deleted = await db
      .delete(documentsTable)
      .where(and(
        eq(documentsTable.id, parsed.data.id),
        sql`${documentsTable.lead_id} IN ${scopedLeadIds}`,
      ))
      .returning({ id: documentsTable.id });
    if (deleted.length === 0) { notFound(res, "Document not found"); return; }
    res.status(204).send();
  } catch (err: any) {
    logger.error({ err: err?.message, id: parsed.data.id }, "documents DELETE /:id failed");
    serverError(res, "Failed to delete document");
  }
});

router.post("/redact", requirePermission(Permission.DOCUMENTS_REDACT), auditAction("redact_document"), async (req, res) => {
  const { pdf_base64, rules } = req.body;
  if (!pdf_base64) { res.status(400).json({ error: "pdf_base64 is required" }); return; }

  try {
    const pdfBytes = Buffer.from(pdf_base64, "base64");
    const redacted = await redactPdf(pdfBytes, rules || []);
    res.json({ pdf_base64: Buffer.from(redacted).toString("base64"), pages: await getPdfPageCount(redacted) });
  } catch (err: unknown) {
    // Distinguish "we cannot do this redaction mode" (caller-fixable) from
    // "the redaction crashed" (server problem). The CRM client uses the
    // stable `redaction_not_implemented` code to render an actionable
    // message instead of a generic "internal error" dialog.
    if (err instanceof RedactionNotImplementedError) {
      req.log.warn({ err: err.message }, "Redaction request rejected — unsupported rule type");
      errorEnvelope(res, 422, err.code, err.message);
      return;
    }
    req.log.error({ err }, "PDF redaction failed");
    serverError(res, "PDF redaction failed");
  }
});

router.post("/highlight", requirePermission(Permission.DOCUMENTS_UPDATE), async (req, res) => {
  const { pdf_base64, highlights } = req.body;
  if (!pdf_base64) { res.status(400).json({ error: "pdf_base64 is required" }); return; }

  try {
    const pdfBytes = Buffer.from(pdf_base64, "base64");
    const highlighted = await highlightPdfRegions(pdfBytes, highlights || []);
    res.json({ pdf_base64: Buffer.from(highlighted).toString("base64"), pages: await getPdfPageCount(highlighted) });
  } catch (err: any) {
    serverError(res, "PDF highlighting failed");
  }
});

export default router;
