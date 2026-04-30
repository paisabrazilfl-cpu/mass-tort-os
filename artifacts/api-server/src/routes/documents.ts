import { Router } from "express";
import { db, documentsTable } from "@workspace/db";
import { eq, and, sql } from "drizzle-orm";
import { badRequest, notFound, serverError, errorEnvelope } from "../lib/http-errors";
import {
  ListDocumentsQueryParams,
  CreateDocumentBody,
  UpdateDocumentBody,
  UpdateDocumentParams,
  DeleteDocumentParams,
} from "@workspace/api-zod";
import { redactPdf, highlightPdfRegions, getPdfPageCount, RedactionNotImplementedError } from "../lib/pdf-redaction";
import { Permission, requirePermission, auditAction } from "../lib/rbac";

const router = Router();

router.get("/", requirePermission(Permission.DOCUMENTS_VIEW), async (req, res) => {
  const parsed = ListDocumentsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    badRequest(res, "Invalid request body", parsed.error.flatten());
    return;
  }

  const { lead_id } = parsed.data;

  // Pagination cap — defaults 50/page, hard ceiling 500. Without this the
  // endpoint would pull every document row in the system on each call.
  const rawLimit = Number(req.query.limit ?? 50);
  const rawOffset = Number(req.query.offset ?? 0);
  const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? rawLimit : 50, 1), 500);
  const offset = Math.max(Number.isFinite(rawOffset) ? rawOffset : 0, 0);

  const docs = lead_id
    ? await db.select().from(documentsTable).where(eq(documentsTable.lead_id, lead_id)).orderBy(sql`${documentsTable.created_at} DESC`).limit(limit).offset(offset)
    : await db.select().from(documentsTable).orderBy(sql`${documentsTable.created_at} DESC`).limit(limit).offset(offset);

  res.json(docs);
});

router.post("/", requirePermission(Permission.DOCUMENTS_CREATE), auditAction("create_document"), async (req, res) => {
  const parsed = CreateDocumentBody.safeParse(req.body);
  if (!parsed.success) {
    badRequest(res, "Invalid request body", parsed.error.flatten());
    return;
  }

  const data = parsed.data;
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

  const body = bodyParsed.data;
  const updateData: Record<string, unknown> = {};

  if (body.document_type !== undefined) updateData.document_type = body.document_type;
  if (body.file_name !== undefined) updateData.file_name = body.file_name;
  if (body.file_url !== undefined) updateData.file_url = body.file_url;
  if (body.signed !== undefined) updateData.signed = body.signed;
  if (body.signed_at !== undefined) updateData.signed_at = body.signed_at ? new Date(body.signed_at) : null;
  if (body.notes !== undefined) updateData.notes = body.notes;

  const [doc] = await db
    .update(documentsTable)
    .set(updateData)
    .where(eq(documentsTable.id, paramsParsed.data.id))
    .returning();

  if (!doc) {
    notFound(res, "Document not found");
    return;
  }

  res.json(doc);
});

router.delete("/:id", requirePermission(Permission.DOCUMENTS_DELETE), auditAction("delete_document"), async (req, res) => {
  const parsed = DeleteDocumentParams.safeParse({ id: Number(req.params.id) });
  if (!parsed.success) {
    badRequest(res, "Invalid request body", parsed.error.flatten());
    return;
  }

  await db.delete(documentsTable).where(eq(documentsTable.id, parsed.data.id));
  res.status(204).send();
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
