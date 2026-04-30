import { Router } from "express";
import { db, vendorsTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { badRequest, notFound } from "../lib/http-errors";
import {
  CreateVendorBody,
  UpdateVendorBody,
  GetVendorParams,
  UpdateVendorParams,
  DeleteVendorParams,
} from "@workspace/api-zod";
import { logger } from "../lib/logger";
import { Permission, requirePermission, auditAction } from "../lib/rbac";

const router = Router();

router.get("/", requirePermission(Permission.VENDORS_VIEW), async (_req, res) => {
  const vendors = await db
    .select()
    .from(vendorsTable)
    .orderBy(sql`${vendorsTable.created_at} DESC`);
  res.json(vendors);
});

router.post("/", requirePermission(Permission.VENDORS_MANAGE), auditAction("create_vendor"), async (req, res) => {
  const parsed = CreateVendorBody.safeParse(req.body);
  if (!parsed.success) {
    badRequest(res, "Invalid request body", parsed.error.flatten());
    return;
  }

  const [vendor] = await db
    .insert(vendorsTable)
    .values({
      name: parsed.data.name,
      contact_name: parsed.data.contact_name ?? null,
      contact_email: parsed.data.contact_email ?? null,
      contact_phone: parsed.data.contact_phone ?? null,
      type: parsed.data.type ?? "lead_gen",
      status: parsed.data.status ?? "active",
      notes: parsed.data.notes ?? null,
    })
    .returning();

  logger.info({ vendorId: vendor.id }, "Vendor created");
  res.status(201).json(vendor);
});

router.get("/:id", requirePermission(Permission.VENDORS_VIEW), async (req, res) => {
  const parsed = GetVendorParams.safeParse(req.params);
  if (!parsed.success) {
    badRequest(res, "Invalid request body", parsed.error.flatten());
    return;
  }

  const [vendor] = await db
    .select()
    .from(vendorsTable)
    .where(eq(vendorsTable.id, parsed.data.id));

  if (!vendor) {
    notFound(res, "Vendor not found");
    return;
  }

  res.json(vendor);
});

router.patch("/:id", requirePermission(Permission.VENDORS_MANAGE), auditAction("update_vendor"), async (req, res) => {
  const paramsParsed = UpdateVendorParams.safeParse(req.params);
  if (!paramsParsed.success) {
    badRequest(res, "Invalid path parameters", paramsParsed.error.flatten());
    return;
  }

  const bodyParsed = UpdateVendorBody.safeParse(req.body);
  if (!bodyParsed.success) {
    badRequest(res, "Invalid request body", bodyParsed.error.flatten());
    return;
  }

  const [vendor] = await db
    .update(vendorsTable)
    .set({ ...bodyParsed.data, updated_at: new Date() })
    .where(eq(vendorsTable.id, paramsParsed.data.id))
    .returning();

  if (!vendor) {
    notFound(res, "Vendor not found");
    return;
  }

  logger.info({ vendorId: vendor.id }, "Vendor updated");
  res.json(vendor);
});

router.delete("/:id", requirePermission(Permission.VENDORS_DELETE), auditAction("delete_vendor"), async (req, res) => {
  const parsed = DeleteVendorParams.safeParse(req.params);
  if (!parsed.success) {
    badRequest(res, "Invalid request body", parsed.error.flatten());
    return;
  }

  const [vendor] = await db
    .delete(vendorsTable)
    .where(eq(vendorsTable.id, parsed.data.id))
    .returning();

  if (!vendor) {
    notFound(res, "Vendor not found");
    return;
  }

  logger.info({ vendorId: vendor.id }, "Vendor deleted");
  res.status(204).send();
});

export default router;
