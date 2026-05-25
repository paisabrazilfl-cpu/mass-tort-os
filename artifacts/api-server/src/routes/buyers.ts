import { Router } from "express";
import { db, buyersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { authMiddleware, Permission, requirePermission } from "../lib/rbac";
import { auditAction } from "../lib/rbac";
import { z } from "zod/v4";
import { badRequest, conflict, notFound } from "../lib/http-errors";

const router = Router();
router.use(authMiddleware);

const buyerSchema = z.object({
  name: z.string().min(1).max(255),
  legal_name: z.string().max(255).nullish(),
  contact_name: z.string().max(255).nullish(),
  contact_email: z.email().nullish(),
  contact_phone: z.string().max(50).nullish(),
  notes: z.string().nullish(),
  esign_provider_integration_id: z.number().int().nullish(),
  fax_provider_integration_id: z.number().int().nullish(),
  email_provider_integration_id: z.number().int().nullish(),
  default_email_from_name: z.string().max(255).nullish(),
  default_email_from_address: z.email().nullish(),
  default_fax_from_number: z.string().max(50).nullish(),
  active: z.boolean().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

router.get("/", requirePermission(Permission.BUYERS_VIEW), async (_req, res) => {
  const rows = await db.select().from(buyersTable).orderBy(buyersTable.name);
  res.json(rows);
});

router.get("/:id", requirePermission(Permission.BUYERS_VIEW), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    badRequest(res, "invalid_id");
    return;
  }
  const [row] = await db.select().from(buyersTable).where(eq(buyersTable.id, id));
  if (!row) {
    notFound(res, "not_found");
    return;
  }
  res.json(row);
});

router.post("/", requirePermission(Permission.BUYERS_MANAGE), auditAction("create_buyer"), async (req, res) => {
  const parsed = buyerSchema.safeParse(req.body);
  if (!parsed.success) {
    badRequest(res, "Invalid request body", parsed.error.flatten());
    return;
  }
  try {
    const [row] = await db.insert(buyersTable).values(parsed.data as any).returning();
    res.status(201).json(row);
  } catch (e: any) {
    if (String(e?.message || "").includes("duplicate")) {
      conflict(res, "name_taken", "A buyer with this name already exists");
      return;
    }
    throw e;
  }
});

router.put("/:id", requirePermission(Permission.BUYERS_MANAGE), auditAction("update_buyer"), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    badRequest(res, "invalid_id");
    return;
  }
  const parsed = buyerSchema.partial().safeParse(req.body);
  if (!parsed.success) {
    badRequest(res, "Invalid request body", parsed.error.flatten());
    return;
  }
  const updates = { ...parsed.data, updated_at: new Date() } as any;
  const [row] = await db.update(buyersTable).set(updates).where(eq(buyersTable.id, id)).returning();
  if (!row) {
    notFound(res, "not_found");
    return;
  }
  res.json(row);
});

router.delete("/:id", requirePermission(Permission.BUYERS_MANAGE), auditAction("delete_buyer"), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    badRequest(res, "invalid_id");
    return;
  }
  await db.delete(buyersTable).where(eq(buyersTable.id, id));
  res.status(204).end();
});

export default router;
