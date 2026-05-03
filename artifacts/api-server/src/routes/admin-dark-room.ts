import { Router } from "express";
import { db, adminDarkRoomLinksTable } from "@workspace/db";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod/v4";
import { authMiddleware, requireRole } from "../lib/rbac";
import { badRequest, notFound } from "../lib/http-errors";

const router = Router();
router.use(authMiddleware);
router.use(requireRole("admin"));

const urlSchema = z
  .string()
  .trim()
  .min(1)
  .max(2048)
  .refine((u) => /^https?:\/\//i.test(u), { message: "URL must start with http:// or https://" });

const createSchema = z.object({
  label: z.string().trim().min(1).max(80),
  url: urlSchema,
});

const updateSchema = z.object({
  label: z.string().trim().min(1).max(80).optional(),
  url: urlSchema.optional(),
  sort_order: z.number().int().min(0).max(10000).optional(),
});

router.get("/", async (req, res) => {
  const userId = req.user!.id;
  const rows = await db
    .select()
    .from(adminDarkRoomLinksTable)
    .where(eq(adminDarkRoomLinksTable.user_id, userId))
    .orderBy(asc(adminDarkRoomLinksTable.sort_order), asc(adminDarkRoomLinksTable.id));
  res.json({ status: "ok", data: { rows } });
});

router.post("/", async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    badRequest(res, "Invalid request body", parsed.error.flatten());
    return;
  }
  const userId = req.user!.id;
  const max = await db
    .select({ s: adminDarkRoomLinksTable.sort_order })
    .from(adminDarkRoomLinksTable)
    .where(eq(adminDarkRoomLinksTable.user_id, userId))
    .orderBy(asc(adminDarkRoomLinksTable.sort_order));
  const nextSort = max.length === 0 ? 0 : (max[max.length - 1]!.s ?? 0) + 1;
  const [row] = await db
    .insert(adminDarkRoomLinksTable)
    .values({
      user_id: userId,
      label: parsed.data.label,
      url: parsed.data.url,
      sort_order: nextSort,
    })
    .returning();
  res.status(201).json(row);
});

router.patch("/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    badRequest(res, "invalid_id");
    return;
  }
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) {
    badRequest(res, "Invalid request body", parsed.error.flatten());
    return;
  }
  const userId = req.user!.id;
  const updates: Record<string, unknown> = { updated_at: new Date() };
  if (parsed.data.label !== undefined) updates.label = parsed.data.label;
  if (parsed.data.url !== undefined) updates.url = parsed.data.url;
  if (parsed.data.sort_order !== undefined) updates.sort_order = parsed.data.sort_order;

  const [row] = await db
    .update(adminDarkRoomLinksTable)
    .set(updates)
    .where(and(eq(adminDarkRoomLinksTable.id, id), eq(adminDarkRoomLinksTable.user_id, userId)))
    .returning();
  if (!row) {
    notFound(res, "not_found");
    return;
  }
  res.json(row);
});

router.delete("/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    badRequest(res, "invalid_id");
    return;
  }
  const userId = req.user!.id;
  const result = await db
    .delete(adminDarkRoomLinksTable)
    .where(and(eq(adminDarkRoomLinksTable.id, id), eq(adminDarkRoomLinksTable.user_id, userId)))
    .returning({ id: adminDarkRoomLinksTable.id });
  if (result.length === 0) {
    notFound(res, "not_found");
    return;
  }
  res.status(204).end();
});

export default router;
