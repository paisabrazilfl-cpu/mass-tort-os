import { Router } from "express";
import { db, documentsTable } from "@workspace/db";
import { eq, and, sql } from "drizzle-orm";
import {
  ListDocumentsQueryParams,
  CreateDocumentBody,
  UpdateDocumentBody,
  UpdateDocumentParams,
  DeleteDocumentParams,
} from "@workspace/api-zod";

const router = Router();

router.get("/", async (req, res) => {
  const parsed = ListDocumentsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { lead_id } = parsed.data;

  const docs = lead_id
    ? await db.select().from(documentsTable).where(eq(documentsTable.lead_id, lead_id)).orderBy(sql`${documentsTable.created_at} DESC`)
    : await db.select().from(documentsTable).orderBy(sql`${documentsTable.created_at} DESC`);

  res.json(docs);
});

router.post("/", async (req, res) => {
  const parsed = CreateDocumentBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
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

router.patch("/:id", async (req, res) => {
  const paramsParsed = UpdateDocumentParams.safeParse({ id: Number(req.params.id) });
  if (!paramsParsed.success) {
    res.status(400).json({ error: paramsParsed.error.message });
    return;
  }

  const bodyParsed = UpdateDocumentBody.safeParse(req.body);
  if (!bodyParsed.success) {
    res.status(400).json({ error: bodyParsed.error.message });
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
    res.status(404).json({ error: "Document not found" });
    return;
  }

  res.json(doc);
});

router.delete("/:id", async (req, res) => {
  const parsed = DeleteDocumentParams.safeParse({ id: Number(req.params.id) });
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  await db.delete(documentsTable).where(eq(documentsTable.id, parsed.data.id));
  res.status(204).send();
});

export default router;
