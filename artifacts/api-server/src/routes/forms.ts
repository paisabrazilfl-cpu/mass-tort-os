import { Router } from "express";
import { db, leadsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { encryptLeadFields } from "../lib/encryption";
import { validateEmail } from "../lib/email-validator";
import { validateAddress } from "../lib/address-validator";
import { runBackgroundCheck } from "../lib/background-check";
import { runFullConflictCheck } from "../lib/conflict-engine";
import { TORT_REGISTRY, validateTortClaim, getTortCategories } from "../lib/tort-engine";
import { lookupNpiAndMatch } from "../lib/taxonomy-engine";
import { runFraudDetection } from "../lib/fraud-engine";
import { finalArbiter } from "../lib/final-arbiter";
import { auditLog } from "../lib/audit";
import { logger } from "../lib/logger";
import { requireRole, auditAction, authMiddleware } from "../lib/rbac";
import {
  getAllFormConfigs,
  getFormConfig,
  getFormConfigByIdOrLabel,
  updateFormConfig,
  addCustomField,
  removeCustomField,
  type CustomField,
} from "../lib/form-config-service";
import { customFieldSchema } from "@workspace/db";

const router = Router();

router.get("/config", async (_req, res) => {
  try {
    const all = await getAllFormConfigs();
    const configs = all.map(c => ({
      id: c.id,
      label: c.label,
      category: c.category,
      fields: [...c.extra_fields, ...c.exposure_fields],
      rules: c.rules,
      valid_diagnoses: c.valid_diagnoses,
      custom_fields: c.custom_fields,
      required_exposure: c.required_exposure,
      intro_text: c.intro_text,
      active: c.active,
      updated_at: c.updated_at,
    }));
    res.json({ tort_campaigns: configs });
  } catch (err) {
    logger.error({ err }, "Failed to load form configs");
    res.status(500).json({ error: "Failed to load form configurations" });
  }
});

router.get("/config/:tortId", async (req, res) => {
  try {
    const config = await getFormConfig(req.params.tortId);
    if (!config) {
      res.status(404).json({ error: "Tort campaign not found" });
      return;
    }
    res.json({
      id: config.id,
      label: config.label,
      category: config.category,
      fields: [...config.extra_fields, ...config.exposure_fields],
      rules: config.rules,
      valid_diagnoses: config.valid_diagnoses,
      custom_fields: config.custom_fields,
      required_exposure: config.required_exposure,
      intro_text: config.intro_text,
      active: config.active,
      updated_at: config.updated_at,
    });
  } catch (err) {
    logger.error({ err }, "Failed to load form config");
    res.status(500).json({ error: "Failed to load form configuration" });
  }
});

router.put(
  "/config/:tortId",
  authMiddleware,
  requireRole("admin"),
  auditAction("form_config_update"),
  async (req, res) => {
    try {
      const { label, valid_diagnoses, exposure_fields, extra_fields, custom_fields, rules, rejection_conditions, required_exposure, intro_text, active } = req.body ?? {};
      if (custom_fields !== undefined) {
        if (!Array.isArray(custom_fields)) {
          res.status(400).json({ error: "custom_fields must be an array" });
          return;
        }
        for (const f of custom_fields) {
          const parsed = customFieldSchema.safeParse(f);
          if (!parsed.success) {
            res.status(400).json({ error: "Invalid custom field", details: parsed.error.issues });
            return;
          }
        }
        const keys = new Set<string>();
        for (const f of custom_fields as CustomField[]) {
          if (keys.has(f.key)) {
            res.status(400).json({ error: `Duplicate field key: ${f.key}` });
            return;
          }
          keys.add(f.key);
        }
      }
      const userId = req.user?.id ?? 0;
      const updated = await updateFormConfig(req.params.tortId, {
        label, valid_diagnoses, exposure_fields, extra_fields, custom_fields, rules, rejection_conditions, required_exposure, intro_text, active,
      }, userId);
      if (!updated) {
        res.status(404).json({ error: "Tort campaign not found" });
        return;
      }
      res.json(updated);
    } catch (err) {
      logger.error({ err }, "Failed to update form config");
      res.status(500).json({ error: "Failed to update form configuration" });
    }
  }
);

router.post(
  "/config/:tortId/fields",
  authMiddleware,
  requireRole("admin"),
  auditAction("form_field_add"),
  async (req, res) => {
    try {
      const parsed = customFieldSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid custom field", details: parsed.error.issues });
        return;
      }
      const userId = req.user?.id ?? 0;
      const updated = await addCustomField(req.params.tortId, parsed.data as CustomField, userId);
      if (!updated) {
        res.status(404).json({ error: "Tort campaign not found" });
        return;
      }
      res.json(updated);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to add field";
      if (msg.includes("already exists")) {
        res.status(409).json({ error: msg });
        return;
      }
      logger.error({ err }, "Failed to add custom field");
      res.status(500).json({ error: msg });
    }
  }
);

router.delete(
  "/config/:tortId/fields/:key",
  authMiddleware,
  requireRole("admin"),
  auditAction("form_field_remove"),
  async (req, res) => {
    try {
      const userId = req.user?.id ?? 0;
      const updated = await removeCustomField(req.params.tortId, req.params.key, userId);
      if (!updated) {
        res.status(404).json({ error: "Tort campaign not found" });
        return;
      }
      res.json(updated);
    } catch (err) {
      logger.error({ err }, "Failed to remove custom field");
      res.status(500).json({ error: "Failed to remove custom field" });
    }
  }
);

router.get("/categories", (_req, res) => {
  res.json(getTortCategories());
});

router.post("/validate/email", (req, res) => {
  const { email } = req.body;
  const result = validateEmail(email);
  res.json(result);
});

router.post("/validate/address", (req, res) => {
  const result = validateAddress(req.body);
  res.json(result);
});

// NOTE: GET /forms/preview/:tortId, /forms/embed/:tortId, and
// /forms/preview-blocker.js are served by forms-public.ts mounted before
// authMiddleware so they are publicly embeddable.

interface PipelineStep {
  name: string;
  status: "passed" | "failed" | "skipped" | "error";
  errors: string[];
  data?: Record<string, unknown>;
}

function extractCustomFieldValues(
  data: Record<string, unknown>,
  allowlist?: string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(data)) {
    if (k.startsWith("cf_")) {
      out[k.slice(3)] = data[k];
    }
  }
  if (data.custom_fields && typeof data.custom_fields === "object" && !Array.isArray(data.custom_fields)) {
    Object.assign(out, data.custom_fields as Record<string, unknown>);
  }
  if (allowlist && allowlist.length >= 0) {
    const allow = new Set(allowlist);
    for (const k of Object.keys(out)) {
      if (!allow.has(k)) delete out[k];
    }
  }
  return out;
}

router.post("/submit", requireRole("paralegal", "attorney", "admin"), auditAction("form_submit"), async (req, res) => {
  const data = req.body;
  const pipeline: PipelineStep[] = [];

  // STEP 1: Schema validation
  const step1: PipelineStep = { name: "SCHEMA_VALIDATION", status: "passed", errors: [] };
  try {
    const requiredFields = [
      "first_name", "last_name", "date_of_birth", "street_address", "city",
      "state", "zip", "phone_primary", "email", "last_4_ssn",
      "diagnosis", "diagnosis_date",
      "physician_first_name", "physician_last_name", "physician_full_address", "physician_contact_info",
      "hospital_name", "hospital_fax", "hospital_contact_info",
      "tort_type",
    ];

    for (const field of requiredFields) {
      if (!data[field] || (typeof data[field] === "string" && !data[field].trim())) {
        step1.errors.push(`MISSING_${field.toUpperCase()}`);
      }
    }

    if (step1.errors.length > 0) {
      step1.status = "failed";
      pipeline.push(step1);
      res.status(422).json({
        status: "REJECTED",
        errors: step1.errors,
        action: "FIX_AND_RESUBMIT",
        pipeline,
        failed_step: "SCHEMA_VALIDATION",
      });
      return;
    }
  } catch (err) {
    step1.status = "error";
    step1.errors.push("SCHEMA_VALIDATION_ERROR");
    pipeline.push(step1);
    logger.error({ err }, "Schema validation error");
    res.status(500).json({ status: "ERROR", errors: ["SCHEMA_VALIDATION_ERROR"], action: "RETRY", pipeline, failed_step: "SCHEMA_VALIDATION" });
    return;
  }
  pipeline.push(step1);

  // STEP 2: Email validation
  const step2: PipelineStep = { name: "EMAIL_VALIDATION", status: "passed", errors: [] };
  try {
    const emailResult = validateEmail(data.email);
    if (!emailResult.valid) {
      step2.errors = emailResult.errors.map((e: string) => `INVALID_EMAIL:${e}`);
      step2.status = "failed";
      step2.data = { suggestion: emailResult.suggestion };
    }
  } catch (err) {
    step2.status = "error";
    step2.errors.push("EMAIL_VALIDATION_ERROR");
    logger.error({ err }, "Email validation error");
  }
  pipeline.push(step2);

  // STEP 3: Address validation
  const step3: PipelineStep = { name: "ADDRESS_VALIDATION", status: "passed", errors: [] };
  try {
    const addressResult = validateAddress({
      street_address: data.street_address,
      city: data.city,
      state: data.state,
      zip: data.zip,
    });
    if (!addressResult.valid) {
      step3.errors = addressResult.errors.map((e: string) => `INVALID_ADDRESS:${e}`);
      step3.status = "failed";
    }
  } catch (err) {
    step3.status = "error";
    step3.errors.push("ADDRESS_VALIDATION_ERROR");
    logger.error({ err }, "Address validation error");
  }
  pipeline.push(step3);

  // STEP 4: TCPA consent
  const step4: PipelineStep = { name: "TCPA_COMPLIANCE", status: "passed", errors: [] };
  try {
    if (!data.tcpa_consent || data.tcpa_consent !== true) {
      step4.errors.push("MISSING_TCPA_CONSENT");
      step4.status = "failed";
    }
  } catch (err) {
    step4.status = "error";
    step4.errors.push("TCPA_CHECK_ERROR");
  }
  pipeline.push(step4);

  // STEP 5: TrustedForm
  const step5: PipelineStep = { name: "TRUSTEDFORM_VALIDATION", status: "passed", errors: [] };
  try {
    if (!data.trustedform_cert_url || typeof data.trustedform_cert_url !== "string" || !data.trustedform_cert_url.startsWith("https://cert.trustedform.com/")) {
      step5.errors.push("MISSING_OR_INVALID_TRUSTEDFORM");
      step5.status = "failed";
    }
  } catch (err) {
    step5.status = "error";
    step5.errors.push("TRUSTEDFORM_CHECK_ERROR");
  }
  pipeline.push(step5);

  // Collect all pre-tort errors
  const preErrors = pipeline.filter(s => s.status === "failed" || s.status === "error").flatMap(s => s.errors);
  if (preErrors.length > 0) {
    res.status(422).json({
      status: "REJECTED",
      errors: preErrors,
      action: "FIX_AND_RESUBMIT",
      pipeline,
      failed_step: pipeline.find(s => s.status !== "passed")?.name,
    });
    return;
  }

  // STEP 6: Tort classification engine
  const step6: PipelineStep = { name: "TORT_CLASSIFICATION", status: "passed", errors: [], data: {} };
  let tortValidation;
  try {
    tortValidation = validateTortClaim({
      tort_type: data.tort_type,
      diagnosis: data.diagnosis,
      exposure_start: data.exposure_start,
      exposure_end: data.exposure_end,
      location_name: data.location_name,
      was_at_location: data.was_at_location,
    });
    step6.data = { tort_id: tortValidation.tort_id, category: tortValidation.category, diagnosis_match: tortValidation.diagnosis_match };

    if (!tortValidation.valid) {
      step6.errors = tortValidation.errors;
      step6.status = "failed";
    }
  } catch (err) {
    step6.status = "error";
    step6.errors.push("TORT_CLASSIFICATION_ERROR");
    logger.error({ err }, "Tort classification error");
    tortValidation = { valid: false, tort_id: null, errors: ["TORT_CLASSIFICATION_ERROR"], diagnosis_match: false, category: null };
  }
  pipeline.push(step6);

  // STEP 7: NPI Lookup + Taxonomy matching
  const step7: PipelineStep = { name: "NPI_TAXONOMY_MATCH", status: "passed", errors: [], data: {} };
  let npiResult = { npi_found: false, npi_number: null as string | null, specialty: null as string | null, taxonomy_match: null as any, error: null as string | null };
  try {
    if (data.physician_first_name && data.physician_last_name) {
      npiResult = await lookupNpiAndMatch(
        data.physician_first_name,
        data.physician_last_name,
        data.diagnosis
      );
      step7.data = {
        npi_found: npiResult.npi_found,
        npi_number: npiResult.npi_number,
        specialty: npiResult.specialty,
        taxonomy_matched: npiResult.taxonomy_match?.matched ?? false,
        fraud_indicators: npiResult.taxonomy_match?.fraud_indicators ?? [],
      };

      if (npiResult.error === "NPI_NOT_FOUND") {
        step7.errors.push("PHYSICIAN_NPI_NOT_FOUND");
        step7.status = "passed";
      } else if (npiResult.error) {
        step7.errors.push(npiResult.error);
        step7.status = "error";
      }
    } else {
      step7.status = "skipped";
    }
  } catch (err) {
    step7.status = "error";
    step7.errors.push("NPI_LOOKUP_ERROR");
    logger.error({ err }, "NPI lookup error");
  }
  pipeline.push(step7);

  // STEP 8: Fraud flagging (flags only — does NOT decide outcome)
  const step8: PipelineStep = { name: "FRAUD_FLAGGING", status: "passed", errors: [], data: {} };
  let fraudResult;
  try {
    fraudResult = runFraudDetection({
      lead_data: data,
      tort_validation: tortValidation!,
      taxonomy_match: npiResult.taxonomy_match,
      npi_found: npiResult.npi_found,
    });
    step8.data = {
      fraud_score: fraudResult.fraud_score,
      hard_block: fraudResult.hard_block,
      has_flags: fraudResult.has_flags,
      indicators: fraudResult.indicators.length,
    };
    if (fraudResult.has_flags) {
      step8.errors = fraudResult.indicators.map(i => `FRAUD:${i.type}`);
    }
  } catch (err) {
    step8.status = "error";
    step8.errors.push("FRAUD_DETECTION_ERROR");
    logger.error({ err }, "Fraud detection error");
    fraudResult = { hard_block: false, hard_block_reason: null, has_flags: false, fraud_score: 0, indicators: [], summary: "Fraud check error — routed to review" };
  }
  pipeline.push(step8);

  // STEP 9: Conflict detection
  const step9: PipelineStep = { name: "CONFLICT_DETECTION", status: "passed", errors: [], data: {} };
  const fullName = `${data.first_name} ${data.last_name}`.trim();
  let conflictCheck;
  try {
    conflictCheck = await runFullConflictCheck({
      entity_type: "lead",
      entity_id: "pending",
      source_module: "form_engine",
      lead_data: { ...data, name: fullName },
    });
    step9.data = { has_conflict: conflictCheck.has_conflict, output_state: conflictCheck.output_state };
  } catch (err) {
    step9.status = "error";
    step9.errors.push("CONFLICT_CHECK_ERROR");
    logger.error({ err }, "Conflict check error");
    conflictCheck = { has_conflict: false, output_state: "ACCEPT" as const, conflict_type: null, severity: "low" as const, details: [], failsafe_mode: "REVIEW_FAIL" as const };
  }
  pipeline.push(step9);

  // STEP 10: FINAL ARBITER — single source of truth for decision
  const complianceErrors = pipeline
    .filter(s => ["TCPA_COMPLIANCE", "TRUSTEDFORM_VALIDATION"].includes(s.name) && s.status !== "passed")
    .flatMap(s => s.errors);
  const validationErrors = pipeline
    .filter(s => ["SCHEMA_VALIDATION", "EMAIL_VALIDATION", "ADDRESS_VALIDATION"].includes(s.name) && s.status !== "passed")
    .flatMap(s => s.errors);

  const arbiterResult = finalArbiter({
    compliance_passed: complianceErrors.length === 0,
    compliance_errors: complianceErrors,
    validation_passed: validationErrors.length === 0,
    validation_errors: validationErrors,
    tort_validation: tortValidation!,
    taxonomy_match: npiResult.taxonomy_match,
    fraud_result: fraudResult!,
    npi_found: npiResult.npi_found,
    diagnosis_confirmed: !!data.diagnosis_confirmed,
    exposure_confirmed: !!data.was_at_location,
    exposure_start: data.exposure_start,
    conflict_reject: conflictCheck!.has_conflict && conflictCheck!.output_state === "REJECT",
    conflict_review: conflictCheck!.has_conflict && conflictCheck!.output_state === "REVIEW_REQUIRED",
  });

  let status: string;
  if (arbiterResult.decision === "REJECTED") {
    status = "rejected";
  } else if (arbiterResult.decision === "TO_BE_REVIEWED") {
    status = "review_required";
  } else {
    status = "new";
  }

  if (arbiterResult.decision === "REJECTED") {
    await auditLog("lead", "rejected", arbiterResult.deciding_engine, {
      reason: arbiterResult.reason,
      fraud_score: fraudResult!.fraud_score,
      fraud_indicators: fraudResult!.indicators,
      conflict: conflictCheck!.has_conflict ? conflictCheck!.conflict_type : null,
    });

    pipeline.push({ name: "FINAL_ARBITER", status: "failed", errors: [arbiterResult.reason], data: { decision: arbiterResult.decision, deciding_engine: arbiterResult.deciding_engine } });

    res.status(422).json({
      status: "REJECTED",
      errors: [arbiterResult.reason],
      action: "REJECTED",
      pipeline,
      failed_step: arbiterResult.deciding_engine,
      fraud_score: fraudResult!.fraud_score,
      fraud_summary: fraudResult!.summary,
    });
    return;
  }

  pipeline.push({ name: "FINAL_ARBITER", status: "passed", errors: [], data: { decision: arbiterResult.decision, reason: arbiterResult.reason, deciding_engine: arbiterResult.deciding_engine } });

  const step10: PipelineStep = { name: "CRM_STORAGE", status: "passed", errors: [], data: {} };
  try {
    const [lead] = await db
      .insert(leadsTable)
      .values(encryptLeadFields({
        name: fullName,
        email: data.email,
        phone: data.phone_primary,
        tort_type: data.tort_type,
        first_name: data.first_name,
        last_name: data.last_name,
        date_of_birth: data.date_of_birth,
        street_address: data.street_address,
        city: data.city,
        state: data.state,
        zip: data.zip,
        phone_primary: data.phone_primary,
        last_4_ssn: data.last_4_ssn,
        diagnosis: data.diagnosis,
        diagnosis_date: data.diagnosis_date,
        diagnosis_confirmed: data.diagnosis_confirmed ?? false,
        was_at_location: data.was_at_location ?? false,
        location_name: data.location_name ?? null,
        physician_first_name: data.physician_first_name,
        physician_last_name: data.physician_last_name,
        physician_full_address: data.physician_full_address,
        physician_contact_info: data.physician_contact_info,
        hospital_name: data.hospital_name,
        hospital_fax: data.hospital_fax,
        hospital_contact_info: data.hospital_contact_info,
        medications: data.medications ?? null,
        tcpa_consent: true,
        trustedform_cert_url: data.trustedform_cert_url,
        trustedform_ip: data.trustedform_ip ?? null,
        trustedform_user_agent: data.trustedform_user_agent ?? null,
        trustedform_timestamp: data.trustedform_timestamp ? new Date(data.trustedform_timestamp) : new Date(),
        email_validation_status: "valid",
        address_validation_status: "valid",
        npi_verified: npiResult.npi_found,
        npi_number: npiResult.npi_number,
        physician_taxonomy: npiResult.specialty,
        fraud_score: fraudResult!.fraud_score,
        fraud_status: arbiterResult.decision,
        fraud_indicators: fraudResult!.indicators.length > 0 ? JSON.stringify(fraudResult!.indicators) : null,
        exposure_start: data.exposure_start ?? null,
        exposure_end: data.exposure_end ?? null,
        diagnosis_type: data.diagnosis_type ?? null,
        notes: data.notes ?? null,
        ad_spend: data.ad_spend ? String(data.ad_spend) : null,
        source: data.source ?? "form_embed",
        status,
        custom_fields: await (async () => {
          const cfg = await getFormConfigByIdOrLabel(String(data.tort_type ?? ""));
          const allow = (cfg?.custom_fields ?? []).map((f) => f.key);
          return extractCustomFieldValues(data, allow);
        })(),
      }))
      .returning();

    step10.data = { lead_id: lead.id, status };

    if (status === "review_required") {
      try {
        const { reviewQueueTable } = await import("@workspace/db");
        const { and: andOp } = await import("drizzle-orm");
        await db
          .update(reviewQueueTable)
          .set({ entity_id: String(lead.id) })
          .where(
            andOp(
              eq(reviewQueueTable.entity_id, "pending"),
              eq(reviewQueueTable.entity_type, "lead"),
              eq(reviewQueueTable.source_module, "form_engine")
            )
          );
      } catch (_) {}
    }

    await auditLog("lead", String(lead.id), "form_submission", {
      source: "form_engine",
      status,
      tort_id: tortValidation!.tort_id,
      fraud_score: fraudResult!.fraud_score,
      npi_verified: npiResult.npi_found,
      trustedform_cert_url: data.trustedform_cert_url,
    });

    // Post-insert background check (non-blocking)
    let bgCheck = null;
    try {
      bgCheck = await runBackgroundCheck({
        first_name: data.first_name,
        last_name: data.last_name,
        state: data.state,
        date_of_birth: data.date_of_birth,
      });

      await db
        .update(leadsTable)
        .set({
          background_check_status: bgCheck.status,
          background_check_data: JSON.stringify(bgCheck),
          updated_at: new Date(),
        })
        .where(eq(leadsTable.id, lead.id));
    } catch (bgErr) {
      logger.warn({ err: bgErr, leadId: lead.id }, "Background check failed post-insert");
    }

    pipeline.push(step10);

    res.status(201).json({
      status: arbiterResult.decision,
      lead_id: lead.id,
      lead_status: status,
      tort_id: tortValidation!.tort_id,
      fraud_score: fraudResult!.fraud_score,
      fraud_flags: fraudResult!.has_flags,
      npi_verified: npiResult.npi_found,
      background_check: bgCheck ? { status: bgCheck.status, summary: bgCheck.summary } : null,
      arbiter: { decision: arbiterResult.decision, reason: arbiterResult.reason, deciding_engine: arbiterResult.deciding_engine },
      pipeline,
    });
  } catch (err) {
    step10.status = "error";
    step10.errors.push("DATABASE_INSERT_ERROR");
    pipeline.push(step10);
    logger.error({ err }, "Form submission insert failed");
    res.status(500).json({
      status: "ERROR",
      errors: ["INTERNAL_ERROR"],
      action: "RETRY",
      pipeline,
      failed_step: "CRM_STORAGE",
    });
  }
});

router.post("/background-check", requireRole("paralegal"), async (req, res) => {
  const { first_name, last_name, state, date_of_birth } = req.body;
  if (!first_name || !last_name) {
    res.status(400).json({ error: "first_name and last_name are required" });
    return;
  }

  try {
    const result = await runBackgroundCheck({ first_name, last_name, state, date_of_birth });
    res.json(result);
  } catch (err) {
    logger.error({ err }, "Background check failed");
    res.status(500).json({ error: "Background check failed", status: "error" });
  }
});

router.post("/background-check/lead/:id", requireRole("paralegal"), async (req, res) => {
  const leadId = Number(req.params.id);
  if (isNaN(leadId)) {
    res.status(400).json({ error: "Invalid lead ID" });
    return;
  }

  try {
    const [lead] = await db.select().from(leadsTable).where(eq(leadsTable.id, leadId));
    if (!lead) {
      res.status(404).json({ error: "Lead not found" });
      return;
    }

    if (!lead.first_name || !lead.last_name) {
      res.status(422).json({ error: "Lead missing first_name or last_name" });
      return;
    }

    const result = await runBackgroundCheck({
      first_name: lead.first_name,
      last_name: lead.last_name,
      state: lead.state ?? undefined,
      date_of_birth: lead.date_of_birth ?? undefined,
    });

    await db
      .update(leadsTable)
      .set({
        background_check_status: result.status,
        background_check_data: JSON.stringify(result),
        updated_at: new Date(),
      })
      .where(eq(leadsTable.id, leadId));

    await auditLog("lead", String(leadId), "background_check", {
      status: result.status,
      records_found: result.records.length,
    });

    res.json(result);
  } catch (err) {
    logger.error({ err }, "Lead background check failed");
    res.status(500).json({ error: "Background check failed", status: "error" });
  }
});

router.post("/npi-verify", requireRole("paralegal"), async (req, res) => {
  const { physician_first_name, physician_last_name, diagnosis } = req.body;
  if (!physician_first_name || !physician_last_name || !diagnosis) {
    res.status(400).json({ error: "physician_first_name, physician_last_name, and diagnosis are required" });
    return;
  }

  try {
    const result = await lookupNpiAndMatch(physician_first_name, physician_last_name, diagnosis);
    res.json(result);
  } catch (err) {
    logger.error({ err }, "NPI verify failed");
    res.status(500).json({ error: "NPI verification failed" });
  }
});

router.post("/fraud-check", requireRole("paralegal"), async (req, res) => {
  const { lead_data, tort_type, diagnosis, physician_first_name, physician_last_name } = req.body;
  if (!diagnosis || !tort_type) {
    res.status(400).json({ error: "tort_type and diagnosis are required" });
    return;
  }

  try {
    const tortValidation = validateTortClaim({
      tort_type,
      diagnosis,
      exposure_start: lead_data?.exposure_start,
      location_name: lead_data?.location_name,
      was_at_location: lead_data?.was_at_location,
    });

    let npiResult = { npi_found: false, taxonomy_match: null as any };
    if (physician_first_name && physician_last_name) {
      const npi = await lookupNpiAndMatch(physician_first_name, physician_last_name, diagnosis);
      npiResult = { npi_found: npi.npi_found, taxonomy_match: npi.taxonomy_match };
    }

    const fraudResult = runFraudDetection({
      lead_data: lead_data || { diagnosis, tort_type },
      tort_validation: tortValidation,
      taxonomy_match: npiResult.taxonomy_match,
      npi_found: npiResult.npi_found,
    });

    res.json({ tort_validation: tortValidation, fraud_result: fraudResult });
  } catch (err) {
    logger.error({ err }, "Fraud check failed");
    res.status(500).json({ error: "Fraud check failed" });
  }
});

router.post("/escalate/fbi", requireRole("attorney", "admin"), auditAction("escalate_fbi"), async (req, res) => {
  const { lead_id, reason, fraud_indicators } = req.body;
  if (!lead_id || !reason) {
    res.status(400).json({ error: "lead_id and reason are required" });
    return;
  }

  try {
    await auditLog("lead", String(lead_id), "fbi_escalation", {
      reason,
      fraud_indicators: fraud_indicators || [],
      fbi_tip_url: "https://tips.fbi.gov/",
      escalated_at: new Date().toISOString(),
    });

    if (lead_id !== "manual") {
      const leadId = Number(lead_id);
      if (isNaN(leadId)) {
        res.status(400).json({ error: "Invalid lead_id — must be a number or 'manual'" });
        return;
      }
      const [existing] = await db.select({ id: leadsTable.id }).from(leadsTable).where(eq(leadsTable.id, leadId));
      if (!existing) {
        res.status(404).json({ error: "Lead not found" });
        return;
      }
      await db
        .update(leadsTable)
        .set({
          status: "rejected",
          rejection_reason: `FBI ESCALATION: ${reason}`,
          fraud_status: "escalated",
          updated_at: new Date(),
        })
        .where(eq(leadsTable.id, leadId));
    }

    res.json({
      status: "ESCALATED",
      fbi_tip_url: "https://tips.fbi.gov/",
      message: "Case logged and escalated. Submit tip at tips.fbi.gov.",
    });
  } catch (err) {
    logger.error({ err }, "FBI escalation logging failed");
    res.status(500).json({ error: "Escalation logging failed" });
  }
});

interface EmbedConfig {
  label: string;
  extra_fields: string[];
  exposure_fields: string[];
  intro_text: string | null;
  custom_fields: CustomField[];
}

export function escapeJs(s: string): string {
  return String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/<\//g, "<\\/");
}

export function generateEmbedScript(tortId: string, config: EmbedConfig, baseUrl: string): string {
  const allStates = '["AL","AK","AZ","AR","CA","CO","CT","DE","DC","FL","GA","HI","ID","IL","IN","IA","KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT","VA","WA","WV","WI","WY"]';
  const extraFields = [...config.extra_fields, ...config.exposure_fields];
  const customFieldsJson = JSON.stringify(config.custom_fields ?? []);
  const introText = config.intro_text ? escapeJs(config.intro_text) : "Complete all required fields to submit your claim for review.";

  return `(function(){
var API="${baseUrl}/api/forms";
var TORT_ID="${escapeJs(tortId)}";
var TORT_LABEL="${escapeJs(config.label)}";
var TORT_INTRO="${introText}";
var EXTRA_FIELDS=${JSON.stringify(extraFields)};
var CUSTOM_FIELDS=${customFieldsJson};

function el(tag,attrs,children){
  var e=document.createElement(tag);
  if(attrs)Object.keys(attrs).forEach(function(k){
    if(k==="style")Object.assign(e.style,attrs[k]);
    else if(k.startsWith("on"))e.addEventListener(k.slice(2),attrs[k]);
    else e.setAttribute(k,attrs[k]);
  });
  if(children){
    if(typeof children==="string")e.textContent=children;
    else if(Array.isArray(children))children.forEach(function(c){if(c)e.appendChild(c);});
  }
  return e;
}

function input(name,label,type,opts){
  opts=opts||{};
  var wrap=el("div",{style:{marginBottom:"12px"}});
  var lbl=el("label",{style:{display:"block",fontWeight:"600",marginBottom:"4px",fontSize:"14px"}},label+(opts.optional?"":" *"));
  var inp;
  if(type==="select"){
    inp=el("select",{name:name,style:{width:"100%",padding:"8px 12px",border:"1px solid #d1d5db",borderRadius:"6px",fontSize:"14px"}});
    inp.appendChild(el("option",{value:""},"Select..."));
    (opts.options||[]).forEach(function(o){
      var opt=el("option",{value:typeof o==="object"?o.value:o},typeof o==="object"?o.label:o);
      inp.appendChild(opt);
    });
  } else if(type==="textarea"){
    inp=el("textarea",{name:name,rows:"3",placeholder:opts.placeholder||"",style:{width:"100%",padding:"8px 12px",border:"1px solid #d1d5db",borderRadius:"6px",fontSize:"14px",resize:"vertical"}});
  } else if(type==="checkbox"){
    var cw=el("div",{style:{display:"flex",alignItems:"flex-start",gap:"8px"}});
    inp=el("input",{type:"checkbox",name:name,style:{marginTop:"3px"}});
    cw.appendChild(inp);
    cw.appendChild(el("span",{style:{fontSize:"13px",lineHeight:"1.4"}},opts.checkLabel||label));
    wrap.appendChild(cw);
    return wrap;
  } else {
    inp=el("input",{type:type||"text",name:name,placeholder:opts.placeholder||"",style:{width:"100%",padding:"8px 12px",border:"1px solid #d1d5db",borderRadius:"6px",fontSize:"14px"}});
    if(opts.maxLength)inp.setAttribute("maxlength",opts.maxLength);
    if(opts.pattern)inp.setAttribute("pattern",opts.pattern);
  }
  if(!opts.optional)inp.setAttribute("required","");
  wrap.appendChild(lbl);
  wrap.appendChild(inp);
  if(name==="email"){
    var errDiv=el("div",{id:"mtos-email-error",style:{color:"#dc2626",fontSize:"12px",marginTop:"4px",display:"none"}});
    wrap.appendChild(errDiv);
    inp.addEventListener("blur",function(){
      fetch(API+"/validate/email",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({email:inp.value})})
        .then(function(r){return r.json()})
        .then(function(r){
          if(!r.valid){
            errDiv.style.display="block";
            errDiv.textContent="Invalid email detected."+(r.suggestion?" Did you mean "+r.suggestion+"?":"")+" Please correct before continuing.";
            inp.style.borderColor="#dc2626";
          }else{
            errDiv.style.display="none";
            inp.style.borderColor="#d1d5db";
          }
        });
    });
  }
  return wrap;
}

function section(title,children,opts){
  opts=opts||{};
  var s=el("div",{style:{border:"1px solid #e5e7eb",borderRadius:"8px",padding:"20px",marginBottom:"16px",borderLeft:opts.accent?"4px solid "+opts.accent:""}});
  s.appendChild(el("h3",{style:{fontSize:"16px",fontWeight:"700",marginBottom:opts.note?"4px":"16px"}},title));
  if(opts.note)s.appendChild(el("p",{style:{fontSize:"12px",color:"#dc2626",marginBottom:"12px"}},opts.note));
  var grid=el("div",{style:{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"0 16px"}});
  children.forEach(function(c){grid.appendChild(c);});
  s.appendChild(grid);
  return s;
}

var container=document.getElementById("mtos-form");
if(!container){console.error("MTOS: #mtos-form not found");return;}

var states=${allStates};
var stateOpts=states.map(function(s){return{value:s,label:s};});

var form=el("form",{id:"mtos-intake-form",style:{maxWidth:"700px",fontFamily:"-apple-system,BlinkMacSystemFont,sans-serif"}});

form.appendChild(el("h2",{style:{fontSize:"22px",fontWeight:"700",marginBottom:"4px"}},"Claim Intake: "+TORT_LABEL));
form.appendChild(el("p",{style:{fontSize:"14px",color:"#6b7280",marginBottom:"20px"}},"Complete all required fields to submit your claim for review."));

form.appendChild(section("Personal Information",[
  input("first_name","First Name"),
  input("last_name","Last Name"),
  input("date_of_birth","Date of Birth","date"),
  input("phone_primary","Phone","tel",{placeholder:"555-555-0100"}),
  input("email","Email","email",{placeholder:"you@example.com"}),
  input("last_4_ssn","Last 4 of SSN","text",{maxLength:"4",pattern:"\\\\d{4}",placeholder:"0000"}),
  input("street_address","Street Address"),
  input("city","City"),
  input("state","State","select",{options:stateOpts}),
  input("zip","Zip","text",{maxLength:"10"}),
]));

form.appendChild(section("Medical Information",[
  input("diagnosis","Diagnosis","text",{placeholder:"e.g. Non-Hodgkin Lymphoma"}),
  input("diagnosis_date","Diagnosis Date","date"),
  input("medications","Medications","text",{placeholder:"Current medications (optional)",optional:true}),
  input("diagnosis_confirmed","Diagnosis Confirmed","checkbox",{checkLabel:"Medical diagnosis confirmed by a physician"}),
  input("was_at_location","Location Exposure","checkbox",{checkLabel:"Client was at the qualifying location for the required duration"}),
]));

if(EXTRA_FIELDS.indexOf("location_name")>=0){
  form.appendChild(input("location_name","Location Name","text",{placeholder:"e.g. MCB Camp Lejeune"}));
}
if(EXTRA_FIELDS.indexOf("exposure_start")>=0){
  form.appendChild(input("exposure_start","Exposure Start Date","date"));
}
if(EXTRA_FIELDS.indexOf("exposure_end")>=0){
  form.appendChild(input("exposure_end","Exposure End Date","date",{optional:true}));
}

if(CUSTOM_FIELDS&&CUSTOM_FIELDS.length>0){
  var customNodes=CUSTOM_FIELDS.map(function(cf){
    var opts={optional:!cf.required};
    if(cf.placeholder)opts.placeholder=cf.placeholder;
    if(cf.options)opts.options=cf.options;
    if(cf.max_length)opts.maxLength=String(cf.max_length);
    if(cf.type==="checkbox")opts.checkLabel=cf.label;
    var node=input("cf_"+cf.key,cf.label,cf.type,opts);
    if(cf.helper_text){
      var help=el("p",{style:{fontSize:"12px",color:"#6b7280",marginTop:"-6px",marginBottom:"8px"}},cf.helper_text);
      node.appendChild(help);
    }
    return node;
  });
  form.appendChild(section("Additional Information",customNodes));
}

form.appendChild(section("Physician Information",[
  input("physician_first_name","Physician First Name"),
  input("physician_last_name","Physician Last Name"),
  input("physician_full_address","Physician Full Address","textarea"),
  input("physician_contact_info","Physician Contact","text",{placeholder:"Phone or email"}),
]));

form.appendChild(section("Hospital Information",[
  input("hospital_name","Hospital Name"),
  input("hospital_fax","Hospital Fax","tel",{placeholder:"555-555-0100"}),
  input("hospital_contact_info","Hospital Contact","text",{placeholder:"Phone, email, or contact person"}),
],{accent:"#dc2626",note:"All hospital fields are mandatory. Leads without complete hospital information will be rejected."}));

var compSection=section("Compliance",[
  input("tcpa_consent","TCPA Consent","checkbox",{checkLabel:"I consent to being contacted via phone, SMS, and email regarding my legal claim. I understand that this is not a condition of service."}),
],{accent:"#2563eb"});
compSection.appendChild(el("input",{type:"hidden",name:"trustedform_cert_url",id:"xxTrustedFormCertUrl_0",value:""}));
form.appendChild(compSection);

form.appendChild(el("input",{type:"hidden",name:"tort_type",value:TORT_LABEL}));
form.appendChild(el("input",{type:"hidden",name:"source",value:"form_embed_"+TORT_ID}));

var msgDiv=el("div",{id:"mtos-msg",style:{marginBottom:"12px",padding:"12px",borderRadius:"6px",display:"none"}});
form.appendChild(msgDiv);

var btnRow=el("div",{style:{display:"flex",gap:"12px",marginTop:"8px"}});
var submitBtn=el("button",{type:"submit",style:{padding:"10px 24px",background:"#1d4ed8",color:"#fff",border:"none",borderRadius:"6px",fontSize:"14px",fontWeight:"600",cursor:"pointer"}},"Submit Claim");
btnRow.appendChild(submitBtn);
form.appendChild(btnRow);

form.addEventListener("submit",function(e){
  e.preventDefault();
  submitBtn.disabled=true;
  submitBtn.textContent="Submitting...";
  msgDiv.style.display="none";

  var fd=new FormData(form);
  var payload={};
  fd.forEach(function(v,k){payload[k]=v;});
  payload.tcpa_consent=!!form.querySelector('[name=tcpa_consent]').checked;
  payload.diagnosis_confirmed=!!form.querySelector('[name=diagnosis_confirmed]').checked;
  payload.was_at_location=!!form.querySelector('[name=was_at_location]').checked;

  var tf=document.getElementById("xxTrustedFormCertUrl_0");
  if(tf&&tf.value)payload.trustedform_cert_url=tf.value;

  fetch(API+"/submit",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)})
    .then(function(r){return r.json().then(function(d){return{ok:r.ok,data:d};});})
    .then(function(r){
      if(r.ok&&r.data.status==="ACCEPTED"){
        msgDiv.style.display="block";
        msgDiv.style.background="#dcfce7";
        msgDiv.style.color="#166534";
        msgDiv.textContent="Your claim has been submitted successfully. Reference ID: "+r.data.lead_id;
        form.reset();
      }else{
        msgDiv.style.display="block";
        msgDiv.style.background="#fef2f2";
        msgDiv.style.color="#991b1b";
        var failStep=r.data.failed_step?" [Step: "+r.data.failed_step+"]":"";
        msgDiv.textContent="Submission failed"+failStep+": "+(r.data.errors||[]).join(", ");
      }
      submitBtn.disabled=false;
      submitBtn.textContent="Submit Claim";
    })
    .catch(function(){
      msgDiv.style.display="block";
      msgDiv.style.background="#fef2f2";
      msgDiv.style.color="#991b1b";
      msgDiv.textContent="Network error. Please try again.";
      submitBtn.disabled=false;
      submitBtn.textContent="Submit Claim";
    });
});

container.appendChild(form);

var tfScript=document.createElement("script");
tfScript.type="text/javascript";
tfScript.src="https://api.trustedform.com/trustedform.js?field=xxTrustedFormCertUrl&ping_field=xxTrustedFormPingUrl&l="+(new Date().getTime())+Math.random();
document.head.appendChild(tfScript);
})();`;
}

export default router;
