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
import { runFullConflictCheck, checkAIClassificationConflict, routeToReview } from "../lib/conflict-engine";
import { withErrorFallback } from "../lib/error-fallback";
import { auditLog } from "../lib/audit";
import { logger } from "../lib/logger";

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

  const hospitalMissing: string[] = [];
  if (!data.hospital_name?.trim()) hospitalMissing.push("hospital_name");
  if (!data.hospital_fax?.trim()) hospitalMissing.push("hospital_fax");
  if (!data.hospital_contact_info?.trim()) hospitalMissing.push("hospital_contact_info");

  if (hospitalMissing.length > 0) {
    await auditLog("lead", "rejected", "hospital_validation_failed", {
      missing_fields: hospitalMissing,
      output_state: "REJECT",
    });
    res.status(422).json({
      status: "INVALID_LEAD",
      error_code: "HOSPITAL_REQUIRED_FIELDS_MISSING",
      action: "REJECT",
      missing_fields: hospitalMissing,
      error: `Hospital fields are required: ${hospitalMissing.join(", ")}`,
    });
    return;
  }

  const requiredFieldErrors: string[] = [];
  const requiredChecks: [string, unknown][] = [
    ["first_name", data.first_name],
    ["last_name", data.last_name],
    ["date_of_birth", data.date_of_birth],
    ["street_address", data.street_address],
    ["city", data.city],
    ["state", data.state],
    ["zip", data.zip],
    ["phone_primary", data.phone_primary],
    ["last_4_ssn", data.last_4_ssn],
    ["diagnosis", data.diagnosis],
    ["diagnosis_date", data.diagnosis_date],
    ["physician_first_name", data.physician_first_name],
    ["physician_last_name", data.physician_last_name],
    ["physician_full_address", data.physician_full_address],
    ["physician_contact_info", data.physician_contact_info],
  ];

  for (const [field, value] of requiredChecks) {
    if (!value || (typeof value === "string" && !value.trim())) {
      requiredFieldErrors.push(field);
    }
  }

  if (requiredFieldErrors.length > 0) {
    res.status(422).json({
      status: "INVALID_LEAD",
      error_code: "REQUIRED_FIELDS_MISSING",
      action: "REJECT",
      missing_fields: requiredFieldErrors,
      error: `Required fields missing: ${requiredFieldErrors.join(", ")}`,
    });
    return;
  }

  const fullName = `${data.first_name} ${data.last_name}`.trim();

  const conflictCheck = await runFullConflictCheck({
    entity_type: "lead",
    entity_id: "pending",
    source_module: "lead_ingestion",
    lead_data: { ...data, name: fullName } as Record<string, unknown>,
  });

  if (conflictCheck.has_conflict) {
    if (conflictCheck.output_state === "REJECT") {
      res.status(422).json({
        error: "Lead rejected by conflict detection",
        output_state: "REJECT",
        conflict_type: conflictCheck.conflict_type,
        failsafe_mode: conflictCheck.failsafe_mode,
        details: conflictCheck.details,
      });
      return;
    }
    if (conflictCheck.output_state === "REVIEW_REQUIRED") {
      const [lead] = await db
        .insert(leadsTable)
        .values({
          ...data,
          name: fullName,
          status: "review_required",
          rejection_reason: `Conflict: ${conflictCheck.details.join("; ")}`,
          exposure_start: data.exposure_start ?? null,
          exposure_end: data.exposure_end ?? null,
          diagnosis_type: data.diagnosis_type ?? null,
          location_name: data.location_name ?? null,
          notes: data.notes ?? null,
          ad_spend: data.ad_spend ? String(data.ad_spend) : null,
          source: data.source ?? null,
        })
        .returning();

      try {
        const { reviewQueueTable } = await import("@workspace/db");
        const { eq: eqOp, and: andOp } = await import("drizzle-orm");
        await db
          .update(reviewQueueTable)
          .set({ entity_id: String(lead.id) })
          .where(
            andOp(
              eqOp(reviewQueueTable.entity_id, "pending"),
              eqOp(reviewQueueTable.entity_type, "lead"),
              eqOp(reviewQueueTable.source_module, "lead_ingestion")
            )
          );
      } catch (_) {}

      res.status(201).json({
        ...lead,
        _conflict: {
          output_state: "REVIEW_REQUIRED",
          conflict_type: conflictCheck.conflict_type,
          details: conflictCheck.details,
        },
      });
      return;
    }
  }

  let status = "new";
  if (!data.diagnosis_confirmed || !data.was_at_location) {
    status = "rejected";
  }

  const [lead] = await db
    .insert(leadsTable)
    .values({
      ...data,
      name: fullName,
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

  await auditLog("lead", String(lead.id), "created", { output_state: "ACCEPT", status });

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
  if (body.first_name !== undefined) updateData.first_name = body.first_name;
  if (body.last_name !== undefined) updateData.last_name = body.last_name;
  if (body.date_of_birth !== undefined) updateData.date_of_birth = body.date_of_birth;
  if (body.street_address !== undefined) updateData.street_address = body.street_address;
  if (body.city !== undefined) updateData.city = body.city;
  if (body.state !== undefined) updateData.state = body.state;
  if (body.zip !== undefined) updateData.zip = body.zip;
  if (body.phone_primary !== undefined) updateData.phone_primary = body.phone_primary;
  if (body.last_4_ssn !== undefined) updateData.last_4_ssn = body.last_4_ssn;
  if (body.diagnosis !== undefined) updateData.diagnosis = body.diagnosis;
  if (body.diagnosis_date !== undefined) updateData.diagnosis_date = body.diagnosis_date;
  if (body.physician_first_name !== undefined) updateData.physician_first_name = body.physician_first_name;
  if (body.physician_last_name !== undefined) updateData.physician_last_name = body.physician_last_name;
  if (body.physician_full_address !== undefined) updateData.physician_full_address = body.physician_full_address;
  if (body.physician_contact_info !== undefined) updateData.physician_contact_info = body.physician_contact_info;
  if (body.hospital_name !== undefined) updateData.hospital_name = body.hospital_name;
  if (body.hospital_fax !== undefined) updateData.hospital_fax = body.hospital_fax;
  if (body.hospital_contact_info !== undefined) updateData.hospital_contact_info = body.hospital_contact_info;
  if (body.tcpa_consent !== undefined) updateData.tcpa_consent = body.tcpa_consent;
  if (body.trustedform_cert_url !== undefined) updateData.trustedform_cert_url = body.trustedform_cert_url;
  if (body.first_name !== undefined || body.last_name !== undefined) {
    const [existing] = await db.select({ first_name: leadsTable.first_name, last_name: leadsTable.last_name }).from(leadsTable).where(eq(leadsTable.id, paramsParsed.data.id));
    if (existing) {
      const fn = body.first_name ?? existing.first_name ?? "";
      const ln = body.last_name ?? existing.last_name ?? "";
      if (fn || ln) updateData.name = `${fn} ${ln}`.trim();
    }
  }

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

  if (lead.status === "review_required") {
    res.status(409).json({
      error: "Lead is pending manual review and cannot be auto-qualified",
      lead_id: lead.id,
      status: "review_required",
      output_state: "REVIEW_REQUIRED",
    });
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
