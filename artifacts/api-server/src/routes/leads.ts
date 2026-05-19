import { Router } from "express";
import { db, leadsTable, documentsTable } from "@workspace/db";
import { eq, ilike, and, or, sql, gte, lte, desc } from "drizzle-orm";
import { badRequest as httpBadRequest, serverError } from "../lib/http-errors";
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
import { encryptLeadFields, decryptLeadFields, decryptLeadArray, rebindLeadEncryptionAad } from "../lib/encryption";
import { leadLookupHash } from "../lib/lead-lookup-hash";
import { Permission, requirePermission, auditAction, canBypassOwnership, denyForbidden } from "../lib/rbac";
import { scoreLeadIntelligence } from "../lib/lead-intelligence";
import { computeAndPersistLeadScore } from "../lib/decision-engine-service";
import { dispatchLeadCreated } from "../lib/lead-webhook-dispatcher";
import { dispatchEvent } from "../lib/event-dispatcher";
import { dispatchTrigger } from "../lib/automations/dispatch";
import { sendSmsViaRouter } from "../lib/sms/send";
import { requireFirmId } from "../lib/firm-scope";

// Thrown by buildLeadFilters when a date query param parses to Invalid Date.
// Caught at each route call site and converted to a 400 with a structured
// `details.field` so the CRM client can highlight the offending input.
class BadDateFilterError extends Error {
  constructor(public field: "date_from" | "date_to", public value: string) {
    super(`Invalid ${field}: ${value}`);
    this.name = "BadDateFilterError";
  }
}

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
  // Date filters: the OpenAPI-generated zod schema only validates that these
  // are strings (not valid ISO dates), so `new Date("garbage")` silently
  // produced an Invalid Date that drizzle's timestamp mapper later threw
  // `RangeError: Invalid time value` on — surfaced as a 500. We now reject
  // garbage dates with a clean 400 instead via the BadDateFilterError below,
  // matching the project-wide "malformed input → structured 400" policy.
  if (data.date_from) {
    const d = new Date(data.date_from);
    if (Number.isNaN(d.getTime())) throw new BadDateFilterError("date_from", data.date_from);
    conditions.push(gte(leadsTable.created_at, d));
  }
  if (data.date_to) {
    const d = new Date(data.date_to);
    if (Number.isNaN(d.getTime())) throw new BadDateFilterError("date_to", data.date_to);
    conditions.push(lte(leadsTable.created_at, d));
  }
  if (data.lead_id) conditions.push(eq(leadsTable.id, data.lead_id));
  if (data.source) conditions.push(eq(leadsTable.source, data.source));
  return conditions;
}

const router = Router();

// Unified error envelope helpers — match the shape used by routes/auth.ts
// and the global handler in app.ts so the CRM client has ONE error contract:
//   { status: "error", code: <stable_string>, message: <human>, details?: ... }
function badRequest(res: import("express").Response, parseError: { flatten: () => unknown }, message = "Invalid request body") {
  res.status(400).json({
    status: "error",
    code: "validation_failed",
    message,
    details: parseError.flatten(),
  });
}
function notFound(res: import("express").Response, what = "Lead not found") {
  res.status(404).json({ status: "error", code: "not_found", message: what });
}
function forbidden(res: import("express").Response, message = "Insufficient permissions") {
  // Normalized envelope: SCREAMING_SNAKE code matches lib/http-errors.ts
  // so the CRM can switch on it instead of string-matching the message.
  res.status(403).json({ status: "error", code: "FORBIDDEN", message });
}

router.get("/export", requirePermission(Permission.LEAD_EXPORT), auditAction("export_leads"), async (req, res) => {
  const parsed = ExportLeadsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    badRequest(res, parsed.error);
    return;
  }

  // Hard cap export size so a single CSV download can't pull the entire table
  // and OOM the API container. 50k is generous for a CRM export; clients that
  // need more should paginate.
  const EXPORT_HARD_CAP = 50_000;
  const firmId = requireFirmId(req);
  let conditions;
  try {
    conditions = buildLeadFilters(parsed.data);
  } catch (err) {
    if (err instanceof BadDateFilterError) {
      res.status(400).json({
        status: "error",
        code: "invalid_date_filter",
        message: err.message,
        details: { field: err.field, value: err.value },
      });
      return;
    }
    throw err;
  }

  conditions.push(eq(leadsTable.firm_id, firmId));

  const leads = await db
    .select()
    .from(leadsTable)
    .where(and(...conditions))
    .orderBy(desc(leadsTable.created_at))
    .limit(EXPORT_HARD_CAP);

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

router.get("/", requirePermission(Permission.LEAD_VIEW_OWN, Permission.LEAD_VIEW_ANY), async (req, res) => {
  const parsed = ListLeadsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    badRequest(res, parsed.error);
    return;
  }

  // Pagination — read directly from query so we don't need to bump the OpenAPI
  // spec for this defensive cap. Defaults: 50 rows per page, hard cap 500.
  const rawLimit = Number(req.query.limit ?? 50);
  const rawOffset = Number(req.query.offset ?? 0);
  const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? rawLimit : 50, 1), 500);
  const offset = Math.max(Number.isFinite(rawOffset) ? rawOffset : 0, 0);

  const firmId = requireFirmId(req);
  let conditions;
  try {
    conditions = buildLeadFilters(parsed.data);
  } catch (err) {
    if (err instanceof BadDateFilterError) {
      res.status(400).json({
        status: "error",
        code: "invalid_date_filter",
        message: err.message,
        details: { field: err.field, value: err.value },
      });
      return;
    }
    throw err;
  }
  const user = req.user!;

  conditions.push(eq(leadsTable.firm_id, firmId));

  // Ownership filter: only admin/attorney can see every row. Everyone else
  // (paralegal/viewer) sees leads they created or are assigned to. The check
  // is expressed via canBypassOwnership() so a future role addition only
  // needs editing rbac.ts — never the route files.
  if (!canBypassOwnership(user)) {
    conditions.push(
      or(
        eq(leadsTable.created_by_user_id, user.id),
        eq(leadsTable.assigned_to, user.id),
      )!
    );
  }

  const leads = await db
    .select()
    .from(leadsTable)
    .where(and(...conditions))
    .orderBy(desc(leadsTable.created_at))
    .limit(limit)
    .offset(offset);

  res.json(decryptLeadArray(leads));
});

router.post("/", requirePermission(Permission.LEAD_CREATE), auditAction("create_lead"), async (req, res) => {
  const parsed = CreateLeadBody.safeParse(req.body);
  if (!parsed.success) {
    badRequest(res, parsed.error);
    return;
  }

  const data = parsed.data;
  const firmId = requireFirmId(req);

  // Normalize hospital_fax to E.164 via shared validator. A 4xx is returned
  // for malformed numbers so a typo never lands as plain text on the lead
  // (which would later surface as a misleading "no fax on file" error in
  // the auto-dispatch pipeline).
  if (data.hospital_fax?.trim()) {
    const { normalizeFaxNumber } = await import("../lib/fax/normalize");
    const norm = normalizeFaxNumber(data.hospital_fax);
    if (!norm.ok) {
      res.status(400).json({
        status: "error",
        code: "INVALID_HOSPITAL_FAX",
        message: norm.message,
        field: "hospital_fax",
      });
      return;
    }
    data.hospital_fax = norm.e164;
  }

  const hospitalMissing: string[] = [];
  if (!data.hospital_name?.trim()) hospitalMissing.push("hospital_name");
  if (!data.hospital_fax?.trim()) hospitalMissing.push("hospital_fax");
  if (!data.hospital_contact_info?.trim()) hospitalMissing.push("hospital_contact_info");

  if (hospitalMissing.length > 0) {
    await auditLog("lead", "rejected", "hospital_validation_failed", {
      missing_fields: hospitalMissing,
      output_state: "REJECT",
    });
    // Pipeline-style 422: keep the domain fields (`action`,
    // `missing_fields`) that the intake page reads, but emit the canonical
    // envelope (`status:"error"`, `code`, `message`, `details`) so the
    // generic client error parser handles it uniformly. The previous
    // `status:"INVALID_LEAD"` clashed with the envelope discriminator.
    res.status(422).json({
      status: "error",
      code: "hospital_required_fields_missing",
      message: `Hospital fields are required: ${hospitalMissing.join(", ")}`,
      details: { missing_fields: hospitalMissing },
      action: "REJECT",
      missing_fields: hospitalMissing,
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
      status: "error",
      code: "required_fields_missing",
      message: `Required fields missing: ${requiredFieldErrors.join(", ")}`,
      details: { missing_fields: requiredFieldErrors },
      action: "REJECT",
      missing_fields: requiredFieldErrors,
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
      // Conflict-engine pipeline response. We keep the `output_state` /
      // `conflict_type` / `failsafe_mode` fields the CRM intake page reads
      // (see `pages/lead-intake.tsx`) and add the unified envelope keys on
      // top so the generic 4xx handler in the client also recognises it.
      res.status(422).json({
        status: "error",
        code: "conflict_rejected",
        message: "Lead rejected by conflict detection",
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
          ...(encryptLeadFields({
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
          }) as any),
          firm_id: firmId,
          // Task #15: canonical (tort|email|phone10) hash from PLAINTEXT inputs.
          lookup_hash: leadLookupHash(
            data.tort_type ?? null,
            data.email ?? null,
            data.phone_primary ?? data.phone ?? null,
          ),
        })
        .returning();

      // Task #8: rebind ciphertext AAD to the freshly-assigned lead.id.
      await rebindLeadEncryptionAad(db, leadsTable, lead, eq);

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
      } catch (rqErr) {
        // Non-blocking: lead is already inserted. Log so an operator can
        // reconcile the orphan review_queue row instead of swallowing.
        logger.warn(
          { err: rqErr, leadId: lead.id },
          "Failed to backfill review_queue.entity_id after lead insert (orphan row may exist)",
        );
      }

      // Decision Engine — score even review-required leads (banner + portfolio rollup).
      computeAndPersistLeadScore(lead.id).catch((err) => {
        logger.error({ err, leadId: lead.id }, "Post-conflict lead score failed");
      });

      // Outbound webhook to active automation integrations (n8n / Zapier / Make).
      // Fire-and-forget; never blocks the response.
      dispatchLeadCreated({
        source: lead.source ?? "operator_intake",
        lead: {
          id: lead.id,
          name: lead.name ?? null,
          first_name: lead.first_name ?? null,
          last_name: lead.last_name ?? null,
          email: lead.email ?? null,
          state: lead.state ?? null,
          tort_type: lead.tort_type ?? null,
          status: lead.status ?? null,
          source: lead.source ?? null,
          created_at: lead.created_at ? new Date(lead.created_at).toISOString() : new Date().toISOString(),
        },
      });

      res.status(201).json({
        ...decryptLeadFields(lead, String(lead.id)),
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
      ...(encryptLeadFields({
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
      }) as any),
      firm_id: firmId,
      // Task #15: canonical (tort|email|phone10) hash from PLAINTEXT inputs.
      lookup_hash: leadLookupHash(
        data.tort_type ?? null,
        data.email ?? null,
        data.phone_primary ?? data.phone ?? null,
      ),
    })
    .returning();

  // Task #8: rebind ciphertext AAD to the freshly-assigned lead.id so a
  // future swap of these bytes into another row would fail AES-GCM verify.
  await rebindLeadEncryptionAad(db, leadsTable, lead, eq);

  await auditLog("lead", String(lead.id), "created", { output_state: "ACCEPT", status });

  // Decision Engine — score asynchronously; never block lead creation on errors.
  computeAndPersistLeadScore(lead.id).catch((err) => {
    logger.error({ err, leadId: lead.id }, "Post-create lead score failed");
  });

  // Outbound webhook to active automation integrations (n8n / Zapier / Make).
  // Fire-and-forget; never blocks the response.
  dispatchLeadCreated({
    source: lead.source ?? "operator_intake",
    lead: {
      id: lead.id,
      name: lead.name ?? null,
      first_name: lead.first_name ?? null,
      last_name: lead.last_name ?? null,
      email: lead.email ?? null,
      state: lead.state ?? null,
      tort_type: lead.tort_type ?? null,
      status: lead.status ?? null,
      source: lead.source ?? null,
      created_at: lead.created_at ? new Date(lead.created_at).toISOString() : new Date().toISOString(),
    },
  });

  res.status(201).json(decryptLeadFields(lead, String(lead.id)));
});

router.get("/:id", requirePermission(Permission.LEAD_VIEW_OWN, Permission.LEAD_VIEW_ANY), auditAction("view_lead"), async (req, res) => {
  const parsed = GetLeadParams.safeParse({ id: Number(req.params.id) });
  if (!parsed.success) {
    badRequest(res, parsed.error);
    return;
  }
  const firmId = requireFirmId(req);

  const [lead] = await db
    .select()
    .from(leadsTable)
    .where(and(eq(leadsTable.id, parsed.data.id), eq(leadsTable.firm_id, firmId)));

  if (!lead) {
    notFound(res);
    return;
  }

  const user = req.user!;
  if (!canBypassOwnership(user)) {
    if (lead.created_by_user_id !== user.id && lead.assigned_to !== user.id) {
      denyForbidden(req, res, "lead_ownership_denied", "Insufficient permissions", {
        lead_id: lead.id,
        owner_user_id: lead.created_by_user_id,
        assigned_to: lead.assigned_to,
      });
      return;
    }
  }

  res.json(decryptLeadFields(lead, String(lead.id)));
});

/**
 * Ownership/role check shared by lead-scoped automation endpoints.
 * Returns true if request is allowed; false (and writes 403/404) otherwise.
 */
async function ensureLeadAccess(req: import("express").Request, res: import("express").Response, leadId: number): Promise<boolean> {
  if (!Number.isFinite(leadId)) {
    httpBadRequest(res, "Invalid lead id");
    return false;
  }
  const firmId = requireFirmId(req);
  const [check] = await db
    .select({
      id: leadsTable.id,
      created_by_user_id: leadsTable.created_by_user_id,
      assigned_to: leadsTable.assigned_to,
    })
    .from(leadsTable)
    .where(and(eq(leadsTable.id, leadId), eq(leadsTable.firm_id, firmId)));
  if (!check) {
    notFound(res);
    return false;
  }
  const user = (req as { user?: import("../lib/rbac").AuthUser }).user;
  if (user && !canBypassOwnership(user)) {
    if (check.created_by_user_id !== user.id && check.assigned_to !== user.id) {
      denyForbidden(req as import("express").Request, res, "lead_ownership_denied", "Insufficient permissions", {
        lead_id: leadId,
        owner_user_id: check.created_by_user_id,
        assigned_to: check.assigned_to,
      });
      return false;
    }
  }
  return true;
}

router.get("/:id/envelopes", requirePermission(Permission.LEAD_VIEW_OWN, Permission.LEAD_VIEW_ANY), async (req, res) => {
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

router.get("/:id/fax-results", requirePermission(Permission.LEAD_VIEW_OWN, Permission.LEAD_VIEW_ANY), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ status: "error", code: "validation_failed", message: "Invalid lead id" });
    return;
  }
  if (!(await ensureLeadAccess(req, res, id))) return;
  const { faxResultsTable } = await import("@workspace/db");
  const { desc, eq: eqOp, or, ilike } = await import("drizzle-orm");
  const { buildFaxResultsLikePattern } = await import("../lib/fax-results-matcher");
  // Task #16: query the canonical FK lead_id column AND fall back to the
  // legacy filename pattern for any historical fax_results row whose
  // lead_id was never backfilled. fax_results.lead_id is intentionally
  // nullable (per T001 "no enforced FK since legacy rows may dangle"),
  // so the read path keeps the OR(lead_id, LIKE source_file) contract.
  const pattern = buildFaxResultsLikePattern(id);
  const rows = await db
    .select()
    .from(faxResultsTable)
    .where(or(eqOp(faxResultsTable.lead_id, id), ilike(faxResultsTable.source_file, pattern)))
    .orderBy(desc(faxResultsTable.created_at));
  res.json(rows);
});

router.patch("/:id", requirePermission(Permission.LEAD_UPDATE), auditAction("update_lead"), async (req, res) => {
  const paramsParsed = UpdateLeadParams.safeParse({ id: Number(req.params.id) });
  if (!paramsParsed.success) {
    badRequest(res, paramsParsed.error);
    return;
  }
  const firmId = requireFirmId(req);

  const user = req.user!;
  if (!canBypassOwnership(user)) {
    const [check] = await db
      .select({ created_by_user_id: leadsTable.created_by_user_id, assigned_to: leadsTable.assigned_to })
      .from(leadsTable)
      .where(and(eq(leadsTable.id, paramsParsed.data.id), eq(leadsTable.firm_id, firmId)));
    if (check && check.created_by_user_id !== user.id && check.assigned_to !== user.id) {
      denyForbidden(req, res, "lead_ownership_denied", "Insufficient permissions", {
        lead_id: paramsParsed.data.id,
        owner_user_id: check.created_by_user_id,
        assigned_to: check.assigned_to,
      });
      return;
    }
  }

  const bodyParsed = UpdateLeadBody.safeParse(req.body);
  if (!bodyParsed.success) {
    badRequest(res, bodyParsed.error);
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
  if ((body as { assigned_to?: number | null }).assigned_to !== undefined) updateData.assigned_to = (body as { assigned_to?: number | null }).assigned_to;
  if ((body as { npi_number?: string | null }).npi_number !== undefined) updateData.npi_number = (body as { npi_number?: string | null }).npi_number;
  if ((body as { medications?: string | null }).medications !== undefined) updateData.medications = (body as { medications?: string | null }).medications;
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
  if (body.hospital_fax !== undefined) {
    if (body.hospital_fax === null || body.hospital_fax === "") {
      updateData.hospital_fax = null;
    } else {
      const { normalizeFaxNumber } = await import("../lib/fax/normalize");
      const norm = normalizeFaxNumber(body.hospital_fax);
      if (!norm.ok) {
        res.status(400).json({
          status: "error",
          code: "INVALID_HOSPITAL_FAX",
          message: norm.message,
          field: "hospital_fax",
        });
        return;
      }
      updateData.hospital_fax = norm.e164;
    }
  }
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

  // Task #8: bind AAD to lead.id on UPDATE so a swapped ciphertext from
  // another row would fail AES-GCM auth verification on read.
  const encryptedUpdate = encryptLeadFields(updateData, String(paramsParsed.data.id));

  // Capture old status BEFORE update so we can detect a transition to "approved".
  const [priorLead] = await db
    .select({ status: leadsTable.status })
    .from(leadsTable)
    .where(and(eq(leadsTable.id, paramsParsed.data.id), eq(leadsTable.firm_id, firmId)));
  const priorStatus = priorLead?.status ?? null;

  const [lead] = await db
    .update(leadsTable)
    .set(encryptedUpdate)
    .where(and(eq(leadsTable.id, paramsParsed.data.id), eq(leadsTable.firm_id, firmId)))
    .returning();

  if (!lead) {
    notFound(res);
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
      const decrypted = decryptLeadFields(lead, String(lead.id));
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
    computeAndPersistLeadScore(lead.id).catch((err) => {
      logger.error({ err, leadId: lead.id }, "Post-update lead score failed");
    });
  }

  // Task #52 — outbound lead.updated event for n8n / Zapier / Make.
  // changed_fields drives the NPI-on-provider-fill automation
  // (subscribed integrations filter on `physician_*` keys).
  // PATCH bodies are small so it's safe to forward `new_values` verbatim.
  // Note: encrypted/PII fields would be redacted by an integration's
  // mapping layer; payload here mirrors what the operator sent.
  const changedFields = Object.keys(body as Record<string, unknown>).filter(
    (k) => (body as Record<string, unknown>)[k] !== undefined,
  );
  if (changedFields.length > 0) {
    dispatchEvent(
      {
        event: "lead.updated",
        payload: {
          lead_id: lead.id,
          changed_fields: changedFields,
          new_values: changedFields.reduce<Record<string, unknown>>((acc, k) => {
            acc[k] = (body as Record<string, unknown>)[k];
            return acc;
          }, {}),
          prior_status: priorStatus,
        },
      },
      { source: `user:${user.id}` },
    );
  }

  res.json(decryptLeadFields(lead, String(lead.id)));

  // Dispatch trigger.case_status_changed if status changed
  if (lead && priorStatus && priorStatus !== lead.status) {
    dispatchTrigger("trigger.case_status_changed", {
      input: {
        lead: { id: lead.id, status: lead.status, prior_status: priorStatus, firm_id: lead.firm_id },
        from_status: priorStatus,
        to_status: lead.status,
      },
      firmId: lead.firm_id ?? null,
      source: "leads.patch",
    }).catch((err) => {
      logger.error({ err, leadId: lead.id }, "case_status_changed trigger failed");
    });
  }
});

router.delete("/:id", requirePermission(Permission.LEAD_DELETE), auditAction("delete_lead"), async (req, res) => {
  const parsed = DeleteLeadParams.safeParse({ id: Number(req.params.id) });
  if (!parsed.success) {
    badRequest(res, parsed.error);
    return;
  }
  const firmId = requireFirmId(req);

  await db.delete(leadsTable).where(and(eq(leadsTable.id, parsed.data.id), eq(leadsTable.firm_id, firmId)));
  res.status(204).send();
});

router.post("/:id/qualify", requirePermission(Permission.LEAD_QUALIFY), auditAction("qualify_lead"), async (req, res) => {
  const parsed = QualifyLeadParams.safeParse({ id: Number(req.params.id) });
  if (!parsed.success) {
    badRequest(res, parsed.error);
    return;
  }
  const firmId = requireFirmId(req);

  const [lead] = await db
    .select()
    .from(leadsTable)
    .where(and(eq(leadsTable.id, parsed.data.id), eq(leadsTable.firm_id, firmId)));

  if (!lead) {
    notFound(res);
    return;
  }

  const user = req.user!;
  if (!canBypassOwnership(user)) {
    if (lead.created_by_user_id !== user.id && lead.assigned_to !== user.id) {
      denyForbidden(req, res, "lead_ownership_denied", "Insufficient permissions", {
        lead_id: lead.id,
        owner_user_id: lead.created_by_user_id,
        assigned_to: lead.assigned_to,
      });
      return;
    }
  }

  if (lead.status === "review_required") {
    // Pipeline response — same dual-shape pattern as the conflict-engine 422
    // above. Note: `lead_status` (not `status`) carries the lead's lifecycle
    // state so we don't collide with the envelope's `status: "error"` key.
    res.status(409).json({
      status: "error",
      code: "review_required",
      message: "Lead is pending manual review and cannot be auto-qualified",
      lead_id: lead.id,
      lead_status: "review_required",
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
    .where(and(eq(leadsTable.id, lead.id), eq(leadsTable.firm_id, firmId)));

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

router.post("/:id/intelligence", requirePermission(Permission.LEAD_QUALIFY), auditAction("score_lead_intelligence"), async (req, res) => {
  try {
    const leadId = Number(req.params.id);
    if (isNaN(leadId)) {
      httpBadRequest(res, "Invalid lead identifier");
      return;
    }
    const firmId = requireFirmId(req);

    const [lead] = await db.select().from(leadsTable).where(and(eq(leadsTable.id, leadId), eq(leadsTable.firm_id, firmId)));
    if (!lead) {
      notFound(res, "Lead record not found");
      return;
    }

    const decryptedLead = decryptLeadFields(lead, String(lead.id));

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
    serverError(res, "Intelligence scoring temporarily unavailable. Please retry.");
  }
});

router.patch("/:id/notes", requirePermission(Permission.LEAD_UPDATE), auditAction("update_lead_notes"), async (req, res) => {
  try {
    const leadId = Number(req.params.id);
    if (isNaN(leadId)) {
      httpBadRequest(res, "Invalid lead identifier");
      return;
    }
    const firmId = requireFirmId(req);

    const user = req.user!;
    if (!canBypassOwnership(user)) {
      const [check] = await db
        .select({ created_by_user_id: leadsTable.created_by_user_id, assigned_to: leadsTable.assigned_to })
        .from(leadsTable)
        .where(and(eq(leadsTable.id, leadId), eq(leadsTable.firm_id, firmId)));
      if (check && check.created_by_user_id !== user.id && check.assigned_to !== user.id) {
        denyForbidden(req, res, "lead_ownership_denied", "Insufficient permissions", {
          lead_id: leadId,
          owner_user_id: check.created_by_user_id,
          assigned_to: check.assigned_to,
        });
        return;
      }
    }

    const { notes } = req.body;
    if (typeof notes !== "string") {
      httpBadRequest(res, "Notes must be provided as a text string");
      return;
    }

    // Task #8: bind AAD to lead.id on the notes UPDATE.
    const encryptedUpdate = encryptLeadFields({ notes, updated_at: new Date() }, String(leadId));
    const [lead] = await db
      .update(leadsTable)
      .set(encryptedUpdate)
      .where(and(eq(leadsTable.id, leadId), eq(leadsTable.firm_id, firmId)))
      .returning();

    if (!lead) {
      notFound(res, "Lead record not found");
      return;
    }

    res.json({ success: true, updated_at: lead.updated_at });
  } catch (err) {
    logger.error({ err: err }, "Notes update failed");
    serverError(res, "Unable to save notes. Please retry.");
  }
});

// POST /api/leads/:id/send-sms — fire a one-off Telnyx SMS to the lead's
// stored phone number. The phone column is encrypted, so we decrypt it
// server-side and never echo the raw number back to the client. Persists
// an sms_messages row scoped to the firm + lead so the delivery webhook
// can update its status.
router.post(
  "/:id/send-sms",
  requirePermission(Permission.SMS_SEND),
  auditAction("send_lead_sms"),
  async (req, res) => {
    const leadId = Number(req.params.id);
    if (!Number.isFinite(leadId)) {
      httpBadRequest(res, "Invalid lead identifier");
      return;
    }

    const body = (req.body ?? {}) as { body?: unknown };
    const message = typeof body.body === "string" ? body.body.trim() : "";
    if (!message) {
      httpBadRequest(res, "body is required (the SMS text to send)");
      return;
    }
    if (message.length > 1600) {
      httpBadRequest(res, "body exceeds 1600 character limit");
      return;
    }

    const ok = await ensureLeadAccess(req, res, leadId);
    if (!ok) return;

    const firmId = requireFirmId(req);
    const [leadRow] = await db
      .select()
      .from(leadsTable)
      .where(and(eq(leadsTable.id, leadId), eq(leadsTable.firm_id, firmId)));
    if (!leadRow) {
      notFound(res);
      return;
    }
    const decrypted = decryptLeadFields(leadRow, String(leadRow.id));
    const phone = typeof decrypted.phone === "string" ? decrypted.phone.trim() : "";
    if (!phone) {
      httpBadRequest(res, "Lead has no phone number on file");
      return;
    }

    const user = req.user!;

    const result = await sendSmsViaRouter({
      to: phone,
      body: message,
      firmId,
      leadId,
      createdByUserId: user.id,
    });

    if (!result.ok) {
      // 502 because the upstream provider rejected — the request itself was valid.
      logger.warn(
        { lead_id: leadId, sms_message_id: result.smsMessageId, provider: result.provider, err: result.error },
        "send_lead_sms failed",
      );
      res.status(502).json({
        status: "error",
        code: "SMS_SEND_FAILED",
        message: result.error ?? "SMS provider rejected the message.",
        sms_message_id: result.smsMessageId ?? null,
        provider: result.provider ?? null,
      });
      return;
    }

    res.json({
      status: "ok",
      data: {
        sms_message_id: result.smsMessageId,
        telnyx_message_id: result.externalMessageId,
      },
    });
  },
);

export default router;
