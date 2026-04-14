import { Router } from "express";
import { db, vendorsTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import {
  CreateVendorBody,
  UpdateVendorBody,
  GetVendorParams,
  UpdateVendorParams,
  DeleteVendorParams,
} from "@workspace/api-zod";
import { logger } from "../lib/logger";
import { requireRole, auditAction } from "../lib/rbac";

const router = Router();

router.get("/", async (_req, res) => {
  const vendors = await db
    .select()
    .from(vendorsTable)
    .orderBy(sql`${vendorsTable.created_at} DESC`);
  res.json(vendors);
});

router.post("/", requireRole("attorney", "admin"), auditAction("create_vendor"), async (req, res) => {
  const parsed = CreateVendorBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
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

router.get("/:id", async (req, res) => {
  const parsed = GetVendorParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [vendor] = await db
    .select()
    .from(vendorsTable)
    .where(eq(vendorsTable.id, parsed.data.id));

  if (!vendor) {
    res.status(404).json({ error: "Vendor not found" });
    return;
  }

  res.json(vendor);
});

router.patch("/:id", requireRole("attorney", "admin"), auditAction("update_vendor"), async (req, res) => {
  const paramsParsed = UpdateVendorParams.safeParse(req.params);
  if (!paramsParsed.success) {
    res.status(400).json({ error: paramsParsed.error.message });
    return;
  }

  const bodyParsed = UpdateVendorBody.safeParse(req.body);
  if (!bodyParsed.success) {
    res.status(400).json({ error: bodyParsed.error.message });
    return;
  }

  const [vendor] = await db
    .update(vendorsTable)
    .set({ ...bodyParsed.data, updated_at: new Date() })
    .where(eq(vendorsTable.id, paramsParsed.data.id))
    .returning();

  if (!vendor) {
    res.status(404).json({ error: "Vendor not found" });
    return;
  }

  logger.info({ vendorId: vendor.id }, "Vendor updated");
  res.json(vendor);
});

router.delete("/:id", requireRole("admin"), auditAction("delete_vendor"), async (req, res) => {
  const parsed = DeleteVendorParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [vendor] = await db
    .delete(vendorsTable)
    .where(eq(vendorsTable.id, parsed.data.id))
    .returning();

  if (!vendor) {
    res.status(404).json({ error: "Vendor not found" });
    return;
  }

  logger.info({ vendorId: vendor.id }, "Vendor deleted");
  res.status(204).send();
});

export default router;
