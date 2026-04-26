import { Router } from "express";
import { db, leadsTable, documentsTable } from "@workspace/db";
import { eq, ilike, and, or, sql, gte, lte } from "drizzle-orm";
import {
  ListLeadsQueryParams,
  CreateLeadBody,
  UpdateLeadBody,
  GetLeadParams,
  UpdateLeadParams,
  DeleteLeadParams,
  QualifyLeadParams,
  ExportLeadsQueryParams,
} from "@workspace/api-zod";
import { runFullConflictCheck, checkAIClassificationConflict, routeToReview } from "../lib/conflict-engine";
import { withErrorFallback } from "../lib/error-fallback";
import { auditLog } from "../lib/audit";
import { logger } from "../lib/logger";
import { encryptLeadFields, decryptLeadFields, decryptLeadArray } from "../lib/encryption";
import { requireRole, auditAction } from "../lib/rbac";
import { scoreLeadIntelligence } from "../lib/lead-intelligence";
import { computeAndPersistLeadScore } from "../lib/decision-engine-service";

function buildLeadFilters(data: {
  status?: string;
  tort_type?: string;
  search?: string;
  vendor_id?: number;
  law_firm?: string;
  client_id?: string;
  date_from?: string;
  date_to?: string;
  lead_id?: number;
  source?: string;
}) {
  const conditions = [];
  if (data.status) conditions.push(eq(leadsTable.status, data.status));
  if (data.tort_type) conditions.push(eq(leadsTable.tort_type, data.tort_type));
  if (data.search) {
    conditions.push(
      or(
        ilike(leadsTable.name, `%${data.search}%`),
        ilike(leadsTable.email, `%${data.search}%`),
        ilike(leadsTable.tort_type, `%${data.search}%`)
      )
    );
  }
  if (data.vendor_id) conditions.push(eq(leadsTable.vendor_id, data.vendor_id));
  if (data.law_firm) conditions.push(ilike(leadsTable.law_firm, `%${data.law_firm}%`));
  if (data.client_id) conditions.push(eq(leadsTable.client_id, data.client_id));
  if (data.date_from) conditions.push(gte(leadsTable.created_at, new Date(data.date_from)));
  if (data.date_to) conditions.push(lte(leadsTable.created_at, new Date(data.date_to)));
  if (data.lead_id) conditions.push(eq(leadsTable.id, data.lead_id));
  if (data.source) conditions.push(eq(leadsTable.source, data.source));
  return conditions;
}

const router = Router();

router.get("/export", requireRole("attorney", "admin"), auditAction("export_leads"), async (req, res) => {
  const parsed = ExportLeadsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  // Hard cap export size so a single CSV download can't pull the entire table
  // and OOM the API container. 50k is generous for a CRM export; clients that
  // need more should paginate.
  const EXPORT_HARD_CAP = 50_000;
  const conditions = buildLeadFilters(parsed.data);
  const leads =
    conditions.length > 0
      ? await db.select().from(leadsTable).where(and(...conditions)).orderBy(sql`${leadsTable.created_at} DESC`).limit(EXPORT_HARD_CAP)
      : await db.select().from(leadsTable).orderBy(sql`${leadsTable.created_at} DESC`).limit(EXPORT_HARD_CAP);

  if (leads.length === 0) {
    res.status(200).type("text/csv").send("No leads found");
    return;
  }

  const decryptedLeads = decryptLeadArray(leads);
  const requestedFields = parsed.data.fields?.split(",").map((f: string) => f.trim()).filter(Boolean);
  const allKeys = Object.keys(leads[0]);
  const fields = requestedFields && requestedFields.length > 0
    ? requestedFields.filter((f: string) => allKeys.includes(f))
    : allKeys;

  const escapeCSV = (val: unknown): string => {
    if (val === null || val === undefined) return "";
    // Serialize objects/arrays (e.g. custom_fields JSONB) as JSON
    // so CSV cells contain usable data instead of "[object Object]".
    let str: string;
    if (val instanceof Date) {
      str = val.toISOString();
    } else if (typeof val === "object") {
      try {
        str = JSON.stringify(val);
      } catch {
        str = "";
      }
    } else {
      str = String(val);
    }
    if (str.includes(",") || str.includes('"') || str.includes("\n")) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  const header = fields.join(",");
  const rows = decryptedLeads.map((lead: Record<string, unknown>) =>
    fields.map((f: string) => escapeCSV(lead[f])).join(",")
  );

  const csv = [header, ...rows].join("\n");
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename=leads-export-${Date.now()}.csv`);
  res.send(csv);
});

router.get("/", requireRole("viewer"), async (req, res) => {
  const parsed = ListLeadsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  // Pagination — read directly from query so we don't need to bump the OpenAPI
  // spec for this defensive cap. Defaults: 50 rows per page, hard cap 500.
  const rawLimit = Number(req.query.limit ?? 50);
  const rawOffset = Number(req.query.offset ?? 0);
  const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? rawLimit : 50, 1), 500);
  const offset = Math.max(Number.isFinite(rawOffset) ? rawOffset : 0, 0);

  const conditions = buildLeadFilters(parsed.data);
  const user = req.user!;
  if (user.role !== "admin" && user.role !== "attorney" && user.id !== 0) {
    conditions.push(
      or(
        eq(leadsTable.created_by_user_id, user.id),
        eq(leadsTable.assigned_to, user.id),
      )!
    );
  }

  const leads =
    conditions.length > 0
      ? await db.select().from(leadsTable).where(and(...conditions)).orderBy(sql`${leadsTable.created_at} DESC`).limit(limit).offset(offset)
      : await db.select().from(leadsTable).orderBy(sql`${leadsTable.created_at} DESC`).limit(limit).offset(offset);

  res.json(decryptLeadArray(leads));
});

router.post("/", requireRole("paralegal", "attorney", "admin"), auditAction("create_lead"), async (req, res) => {
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
        .values(encryptLeadFields({
          ...data,
          name: fullName,
          status: "review_required",
          rejection_reason: `Conflict: ${conflictCheck.details.join("; ")}`,
          exposure_start: data.exposure_start ?? null,
          exposure_end: data.exposure_end ?? null,
          diagnosis_type: data.diagnosis_type ?? null,
          location_name: data.location_name ?? null,
          created_by_user_id: req.user?.id ?? null,
          notes: data.notes ?? null,
          ad_spend: data.ad_spend ? String(data.ad_spend) : null,
          source: data.source ?? null,
        }) as any)
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

      // Decision Engine — score even review-required leads (banner + portfolio rollup).
      computeAndPersistLeadScore(lead.id).catch(() => {});

      res.status(201).json({
        ...decryptLeadFields(lead),
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
    .values(encryptLeadFields({
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
      created_by_user_id: req.user?.id ?? null,
    }) as any)
    .returning();

  await auditLog("lead", String(lead.id), "created", { output_state: "ACCEPT", status });

  // Decision Engine — score asynchronously; never block lead creation on errors.
  computeAndPersistLeadScore(lead.id).catch(() => {});

  res.status(201).json(decryptLeadFields(lead));
});

router.get("/:id", requireRole("viewer"), auditAction("view_lead"), async (req, res) => {
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

  const user = req.user!;
  if (user.role !== "admin" && user.role !== "attorney" && user.id !== 0) {
    if (lead.created_by_user_id !== user.id && lead.assigned_to !== user.id) {
      res.status(403).json({ error: "Insufficient permissions" });
      return;
    }
  }

  res.json(decryptLeadFields(lead));
});

/**
 * Ownership/role check shared by lead-scoped automation endpoints.
 * Returns true if request is allowed; false (and writes 403/404) otherwise.
 */
async function ensureLeadAccess(req: Express.Request, res: import("express").Response, leadId: number): Promise<boolean> {
  if (!Number.isFinite(leadId)) {
    res.status(400).json({ error: "invalid_id" });
    return false;
  }
  const [check] = await db
    .select({
      id: leadsTable.id,
      created_by_user_id: leadsTable.created_by_user_id,
      assigned_to: leadsTable.assigned_to,
    })
    .from(leadsTable)
    .where(eq(leadsTable.id, leadId));
  if (!check) {
    res.status(404).json({ error: "Lead not found" });
    return false;
  }
  const user = (req as { user?: { id: number; role: string } }).user;
  if (user && user.role !== "admin" && user.role !== "attorney" && user.id !== 0) {
    if (check.created_by_user_id !== user.id && check.assigned_to !== user.id) {
      res.status(403).json({ error: "Insufficient permissions" });
      return false;
    }
  }
  return true;
}

router.get("/:id/envelopes", requireRole("viewer"), async (req, res) => {
  const id = Number(req.params.id);
  if (!(await ensureLeadAccess(req, res, id))) return;
  const { documentEnvelopesTable } = await import("@workspace/db");
  const { desc } = await import("drizzle-orm");
  const rows = await db
    .select()
    .from(documentEnvelopesTable)
    .where(eq(documentEnvelopesTable.lead_id, id))
    .orderBy(desc(documentEnvelopesTable.created_at));
  res.json(rows);
});

router.get("/:id/fax-results", requireRole("viewer"), async (req, res) => {
  const id = Number(req.params.id);
  if (!(await ensureLeadAccess(req, res, id))) return;
  const { faxResultsTable } = await import("@workspace/db");
  const { desc, like } = await import("drizzle-orm");
  // fax_results has no lead_id column; we tag source_file with `_lead_${id}_` when enqueued.
  const rows = await db
    .select()
    .from(faxResultsTable)
    .where(like(faxResultsTable.source_file, `%_lead_${id}_%`))
    .orderBy(desc(faxResultsTable.created_at));
  res.json(rows);
});

router.patch("/:id", requireRole("paralegal", "attorney", "admin"), auditAction("update_lead"), async (req, res) => {
  const paramsParsed = UpdateLeadParams.safeParse({ id: Number(req.params.id) });
  if (!paramsParsed.success) {
    res.status(400).json({ error: paramsParsed.error.message });
    return;
  }

  const user = req.user!;
  if (user.role !== "admin" && user.role !== "attorney" && user.id !== 0) {
    const [check] = await db.select({ created_by_user_id: leadsTable.created_by_user_id, assigned_to: leadsTable.assigned_to }).from(leadsTable).where(eq(leadsTable.id, paramsParsed.data.id));
    if (check && check.created_by_user_id !== user.id && check.assigned_to !== user.id) {
      res.status(403).json({ error: "Insufficient permissions" });
      return;
    }
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

  const encryptedUpdate = encryptLeadFields(updateData);

  // Capture old status BEFORE update so we can detect a transition to "approved".
  const [priorLead] = await db
    .select({ status: leadsTable.status })
    .from(leadsTable)
    .where(eq(leadsTable.id, paramsParsed.data.id));
  const priorStatus = priorLead?.status ?? null;

  const [lead] = await db
    .update(leadsTable)
    .set(encryptedUpdate)
    .where(eq(leadsTable.id, paramsParsed.data.id))
    .returning();

  if (!lead) {
    res.status(404).json({ error: "Lead not found" });
    return;
  }

  // Workflow hook: lead JUST transitioned to "qualified" (this CRM's term for "approved")
  // → fire document automation. Fire-and-forget; never block the API response on it.
  if (body.status === "qualified" && priorStatus !== "qualified") {
    import("../lib/workflow-engine")
      .then(({ enqueueLeadApprovalPackets }) => enqueueLeadApprovalPackets(lead.id))
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.error("[workflow-engine] dispatch failed for lead", lead.id, err);
      });
  }

  const conflictFields = ["diagnosis", "tort_type", "diagnosis_confirmed", "was_at_location", "location_name", "exposure_start"];
  const hasConflictRelevantChange = conflictFields.some(f => (body as Record<string, unknown>)[f] !== undefined);
  if (hasConflictRelevantChange) {
    try {
      const decrypted = decryptLeadFields(lead);
      const ctx = {
        entity_type: "lead",
        entity_id: String(lead.id),
        source_module: "lead_update",
        lead_data: decrypted,
      };
      const conflictResult = await runFullConflictCheck(ctx);
      if (conflictResult.output_state === "REJECT" || conflictResult.output_state === "REVIEW_REQUIRED") {
        await routeToReview(conflictResult, ctx);
      }
    } catch (conflictErr) {
      logger.warn({ leadId: lead.id }, "Post-update conflict check failed (non-blocking)");
    }
  }

  // Decision Engine — recompute when relevant fields change.
  const convexityFields = ["tort_type", "diagnosis", "diagnosis_date", "diagnosis_confirmed", "exposure_start", "exposure_end", "date_of_birth", "state", "phone", "email", "source", "rejection_reason", "ad_spend", "status"];
  if (convexityFields.some(f => (body as Record<string, unknown>)[f] !== undefined)) {
    computeAndPersistLeadScore(lead.id).catch(() => {});
  }

  res.json(decryptLeadFields(lead));
});

router.delete("/:id", requireRole("attorney", "admin"), auditAction("delete_lead"), async (req, res) => {
  const parsed = DeleteLeadParams.safeParse({ id: Number(req.params.id) });
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  await db.delete(leadsTable).where(eq(leadsTable.id, parsed.data.id));
  res.status(204).send();
});

router.post("/:id/qualify", requireRole("paralegal", "attorney", "admin"), auditAction("qualify_lead"), async (req, res) => {
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

  const user = req.user!;
  if (user.role !== "admin" && user.role !== "attorney" && user.id !== 0) {
    if (lead.created_by_user_id !== user.id && lead.assigned_to !== user.id) {
      res.status(403).json({ error: "Insufficient permissions" });
      return;
    }
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

  // Workflow hook: just transitioned into "qualified" — dispatch document packets.
  if (qualified && lead.status !== "qualified") {
    import("../lib/workflow-engine")
      .then(({ enqueueLeadApprovalPackets }) => enqueueLeadApprovalPackets(lead.id))
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.error("[workflow-engine] dispatch failed for lead", lead.id, err);
      });
  }

  res.json({
    lead_id: lead.id,
    qualified,
    status: newStatus,
    reason,
    gates_passed: gatesPassed,
    gates_failed: gatesFailed,
  });
});

router.post("/:id/intelligence", requireRole("paralegal", "attorney", "admin"), auditAction("score_lead_intelligence"), async (req, res) => {
  try {
    const leadId = Number(req.params.id);
    if (isNaN(leadId)) {
      res.status(400).json({ error: "Invalid lead identifier" });
      return;
    }

    const [lead] = await db.select().from(leadsTable).where(eq(leadsTable.id, leadId));
    if (!lead) {
      res.status(404).json({ error: "Lead record not found" });
      return;
    }

    const decryptedLead = decryptLeadFields(lead);

    let documents: any[] = [];
    try {
      documents = await db.select().from(documentsTable).where(eq(documentsTable.lead_id, leadId));
    } catch (docErr) {
      logger.warn({ err: docErr }, "Document retrieval failed during intelligence scoring — proceeding without documents");
    }

    const result = await scoreLeadIntelligence({
      lead: decryptedLead,
      documents,
    });

    res.json(result);
  } catch (err) {
    logger.error({ err: err }, "Lead intelligence scoring encountered an unrecoverable error");
    res.status(500).json({ error: "Intelligence scoring temporarily unavailable. Please retry." });
  }
});

router.patch("/:id/notes", requireRole("paralegal", "attorney", "admin"), auditAction("update_lead_notes"), async (req, res) => {
  try {
    const leadId = Number(req.params.id);
    if (isNaN(leadId)) {
      res.status(400).json({ error: "Invalid lead identifier" });
      return;
    }

    const user = req.user!;
    if (user.role !== "admin" && user.role !== "attorney" && user.id !== 0) {
      const [check] = await db.select({ created_by_user_id: leadsTable.created_by_user_id, assigned_to: leadsTable.assigned_to }).from(leadsTable).where(eq(leadsTable.id, leadId));
      if (check && check.created_by_user_id !== user.id && check.assigned_to !== user.id) {
        res.status(403).json({ error: "Insufficient permissions" });
        return;
      }
    }

    const { notes } = req.body;
    if (typeof notes !== "string") {
      res.status(400).json({ error: "Notes must be provided as a text string" });
      return;
    }

    const encryptedUpdate = encryptLeadFields({ notes, updated_at: new Date() });
    const [lead] = await db
      .update(leadsTable)
      .set(encryptedUpdate)
      .where(eq(leadsTable.id, leadId))
      .returning();

    if (!lead) {
      res.status(404).json({ error: "Lead record not found" });
      return;
    }

    res.json({ success: true, updated_at: lead.updated_at });
  } catch (err) {
    logger.error({ err: err }, "Notes update failed");
    res.status(500).json({ error: "Unable to save notes. Please retry." });
  }
});

export default router;
