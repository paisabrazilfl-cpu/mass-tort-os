import { Router } from "express";
import { db, leadsTable } from "@workspace/db";
import { eq, ilike, and, or, sql } from "drizzle-orm";
import {
  ListLeadsQueryParams,
  CreateLeadBody,
  UpdateLeadBody,
  GetLeadParams,
  UpdateLeadParams,
  DeleteLeadParams,
  QualifyLeadParams,
} from "@workspace/api-zod";

const router = Router();

router.get("/", async (req, res) => {
  const parsed = ListLeadsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { status, tort_type, search } = parsed.data;

  const conditions = [];
  if (status) conditions.push(eq(leadsTable.status, status));
  if (tort_type) conditions.push(eq(leadsTable.tort_type, tort_type));
  if (search) {
    conditions.push(
      or(
        ilike(leadsTable.name, `%${search}%`),
        ilike(leadsTable.email, `%${search}%`),
        ilike(leadsTable.tort_type, `%${search}%`)
      )
    );
  }

  const leads =
    conditions.length > 0
      ? await db.select().from(leadsTable).where(and(...conditions)).orderBy(sql`${leadsTable.created_at} DESC`)
      : await db.select().from(leadsTable).orderBy(sql`${leadsTable.created_at} DESC`);

  res.json(leads);
});

router.post("/", async (req, res) => {
  const parsed = CreateLeadBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const data = parsed.data;
  let status = "new";

  if (!data.diagnosis_confirmed || !data.was_at_location) {
    status = "rejected";
  }

  const [lead] = await db
    .insert(leadsTable)
    .values({
      ...data,
      status,
      exposure_start: data.exposure_start ?? null,
      exposure_end: data.exposure_end ?? null,
      diagnosis_type: data.diagnosis_type ?? null,
      location_name: data.location_name ?? null,
      notes: data.notes ?? null,
      ad_spend: data.ad_spend ? String(data.ad_spend) : null,
      source: data.source ?? null,
    })
    .returning();

  res.status(201).json(lead);
});

router.get("/:id", async (req, res) => {
  const parsed = GetLeadParams.safeParse({ id: Number(req.params.id) });
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [lead] = await db
    .select()
    .from(leadsTable)
    .where(eq(leadsTable.id, parsed.data.id));

  if (!lead) {
    res.status(404).json({ error: "Lead not found" });
    return;
  }

  res.json(lead);
});

router.patch("/:id", async (req, res) => {
  const paramsParsed = UpdateLeadParams.safeParse({ id: Number(req.params.id) });
  if (!paramsParsed.success) {
    res.status(400).json({ error: paramsParsed.error.message });
    return;
  }

  const bodyParsed = UpdateLeadBody.safeParse(req.body);
  if (!bodyParsed.success) {
    res.status(400).json({ error: bodyParsed.error.message });
    return;
  }

  const body = bodyParsed.data;
  const updateData: Record<string, unknown> = {
    updated_at: new Date(),
  };

  if (body.name !== undefined) updateData.name = body.name;
  if (body.email !== undefined) updateData.email = body.email;
  if (body.phone !== undefined) updateData.phone = body.phone;
  if (body.tort_type !== undefined) updateData.tort_type = body.tort_type;
  if (body.exposure_start !== undefined) updateData.exposure_start = body.exposure_start;
  if (body.exposure_end !== undefined) updateData.exposure_end = body.exposure_end;
  if (body.diagnosis_confirmed !== undefined) updateData.diagnosis_confirmed = body.diagnosis_confirmed;
  if (body.diagnosis_type !== undefined) updateData.diagnosis_type = body.diagnosis_type;
  if (body.was_at_location !== undefined) updateData.was_at_location = body.was_at_location;
  if (body.location_name !== undefined) updateData.location_name = body.location_name;
  if (body.status !== undefined) updateData.status = body.status;
  if (body.rejection_reason !== undefined) updateData.rejection_reason = body.rejection_reason;
  if (body.notes !== undefined) updateData.notes = body.notes;
  if (body.ad_spend !== undefined) updateData.ad_spend = body.ad_spend !== null ? String(body.ad_spend) : null;
  if (body.source !== undefined) updateData.source = body.source;

  const [lead] = await db
    .update(leadsTable)
    .set(updateData)
    .where(eq(leadsTable.id, paramsParsed.data.id))
    .returning();

  if (!lead) {
    res.status(404).json({ error: "Lead not found" });
    return;
  }

  res.json(lead);
});

router.delete("/:id", async (req, res) => {
  const parsed = DeleteLeadParams.safeParse({ id: Number(req.params.id) });
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  await db.delete(leadsTable).where(eq(leadsTable.id, parsed.data.id));
  res.status(204).send();
});

router.post("/:id/qualify", async (req, res) => {
  const parsed = QualifyLeadParams.safeParse({ id: Number(req.params.id) });
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [lead] = await db
    .select()
    .from(leadsTable)
    .where(eq(leadsTable.id, parsed.data.id));

  if (!lead) {
    res.status(404).json({ error: "Lead not found" });
    return;
  }

  const gatesPassed: string[] = [];
  const gatesFailed: string[] = [];

  if (lead.diagnosis_confirmed) {
    gatesPassed.push("Diagnosis Confirmed");
  } else {
    gatesFailed.push("Diagnosis Confirmed");
  }

  if (lead.was_at_location) {
    gatesPassed.push("Location Exposure Verified");
  } else {
    gatesFailed.push("Location Exposure Verified");
  }

  if (lead.tort_type && lead.tort_type.trim().length > 0) {
    gatesPassed.push("Tort Type Identified");
  } else {
    gatesFailed.push("Tort Type Identified");
  }

  const qualified = gatesFailed.length === 0;
  const newStatus = qualified ? "qualified" : "rejected";
  const reason = qualified
    ? "All Boolean Gatekeeper criteria met. Lead is qualified for retainer."
    : `Disqualified: failed gates — ${gatesFailed.join(", ")}.`;

  await db
    .update(leadsTable)
    .set({
      status: newStatus,
      rejection_reason: qualified ? null : reason,
      updated_at: new Date(),
    })
    .where(eq(leadsTable.id, lead.id));

  res.json({
    lead_id: lead.id,
    qualified,
    status: newStatus,
    reason,
    gates_passed: gatesPassed,
    gates_failed: gatesFailed,
  });
});

export default router;
