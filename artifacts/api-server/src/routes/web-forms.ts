import { Router, type IRouter, type Request, type Response } from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { db, formConfigurationsTable, leadsTable, workflowSettingsTable, vendorsTable } from "@workspace/db";
import type { WebFormConfig, WebFormField, EligibilityRule } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { getFormConfig } from "../lib/form-config-service";
import { validateEmail } from "../lib/email-validator";
import { validateAddress } from "../lib/address-validator";
import { encryptLeadFields, rebindLeadEncryptionAad } from "../lib/encryption";
import { auditLog } from "../lib/audit";
import { logger } from "../lib/logger";
import { resolveProvider, isResolved } from "../lib/provider-router";
import { getEmailAdapter } from "../lib/email/sendgrid";
import { badRequest, notFound, serverError } from "../lib/http-errors";
import { dispatchLeadCreated } from "../lib/lead-webhook-dispatcher";
import { findExistingLeadForIntake } from "../lib/lead-dedup";
import { leadLookupHash } from "../lib/lead-lookup-hash";
import { runBackgroundCheck } from "../lib/background-check";
import { provisionPortalInvite } from "../lib/portal-invite";

const router: IRouter = Router();

// Per-IP rate limit on the public web-forms surface (separate from the
// heavy /api/forms-public/* surface). Keeps tort-id enumeration and
// config-scraping expensive even when the form lives on a third-party
// landing page.
const webFormsRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests" },
  // Use ipKeyGenerator (honours trust proxy / req.ip) instead of reading
  // X-Forwarded-For directly. A spoofed XFF header previously let an attacker
  // rotate fake IPs and bypass this limit entirely — the same fix applied to
  // auth.ts (and documented there) must be consistent here.
  keyGenerator: (req) => ipKeyGenerator(req.ip ?? req.socket.remoteAddress ?? "unknown"),
});

router.use(webFormsRateLimit);

// Strict host pattern: alphanumerics, dot, hyphen, optional :port.
const SAFE_HOST = /^[a-zA-Z0-9.-]+(?::\d{1,5})?$/;

function resolveBaseUrl(req: Request): string | null {
  const fromEnv = process.env.PUBLIC_API_BASE_URL?.trim();
  if (fromEnv) return fromEnv.replace(/\/+$/, "");

  const host = req.get("host") ?? "";
  if (!SAFE_HOST.test(host)) return null;

  const proto = (req.get("x-forwarded-proto") ?? req.protocol ?? "https")
    .split(",")[0]
    .trim()
    .toLowerCase();
  if (proto !== "http" && proto !== "https") return null;

  return `${proto}://${host}`;
}

function sourceIpOf(req: Request): string {
  return (
    (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ||
    req.socket.remoteAddress ||
    "unknown"
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Pipeline
// ─────────────────────────────────────────────────────────────────────────

interface PipelineStep {
  name: string;
  status: "passed" | "failed" | "skipped";
  errors: string[];
  data?: Record<string, unknown>;
}

/**
 * Server-side check of an eligibility rule. The client may render hints
 * inline, but submission is gated HERE — never trust the browser.
 */
function ruleFails(rule: EligibilityRule, value: unknown): boolean {
  switch (rule.op) {
    case "eq":
      return String(value ?? "").trim().toLowerCase() ===
        String(rule.value).trim().toLowerCase();
    case "ne":
      return String(value ?? "").trim().toLowerCase() !==
        String(rule.value).trim().toLowerCase();
    case "in":
      return Array.isArray(rule.value) &&
        rule.value.map((v) => String(v).toLowerCase()).includes(String(value ?? "").toLowerCase());
    case "not_in":
      return Array.isArray(rule.value) &&
        !rule.value.map((v) => String(v).toLowerCase()).includes(String(value ?? "").toLowerCase());
    case "lt": {
      const n = Number(value);
      const t = Number(rule.value);
      return Number.isFinite(n) && Number.isFinite(t) && n < t;
    }
    case "gt": {
      const n = Number(value);
      const t = Number(rule.value);
      return Number.isFinite(n) && Number.isFinite(t) && n > t;
    }
    default:
      return false;
  }
}

function validateAgainstFields(
  fields: WebFormField[],
  body: Record<string, unknown>,
): { ok: true } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  for (const f of fields) {
    const v = body[f.key];
    const empty =
      v === undefined ||
      v === null ||
      (typeof v === "string" && v.trim() === "") ||
      (f.type === "checkbox" && v !== true && v !== "true" && v !== "on");
    if (f.required && empty) {
      errors.push(`MISSING_${f.key.toUpperCase()}`);
      continue;
    }
    if (empty) continue;

    if (f.type === "select" || f.type === "radio") {
      if (Array.isArray(f.options) && f.options.length > 0) {
        const allowed = f.options.map((o) => String(o).toLowerCase());
        if (!allowed.includes(String(v).toLowerCase())) {
          errors.push(`INVALID_${f.key.toUpperCase()}`);
        }
      }
    } else if (f.type === "number") {
      if (!Number.isFinite(Number(v))) {
        errors.push(`INVALID_${f.key.toUpperCase()}`);
      }
    } else if (f.type === "tel") {
      const digits = String(v).replace(/\D/g, "");
      if (digits.length < 7 || digits.length > 15) {
        errors.push(`INVALID_${f.key.toUpperCase()}`);
      }
    } else if (f.type === "state") {
      if (!/^[A-Z]{2}$/.test(String(v).toUpperCase())) {
        errors.push(`INVALID_${f.key.toUpperCase()}`);
      }
    } else if (typeof v === "string" && f.max_length && v.length > f.max_length) {
      errors.push(`TOO_LONG_${f.key.toUpperCase()}`);
    }
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true };
}

interface PipelineResult {
  status: number;
  body: Record<string, unknown>;
}

async function runWebFormPipeline(
  tortId: string,
  config: { label: string; web_form_config: WebFormConfig },
  body: Record<string, unknown>,
  _req: Request,
): Promise<PipelineResult> {
  const pipeline: PipelineStep[] = [];
  const cfg = config.web_form_config;

  // STEP 1: Schema validation against the configured fields.
  const step1: PipelineStep = { name: "SCHEMA_VALIDATION", status: "passed", errors: [] };
  const schemaCheck = validateAgainstFields(cfg.fields, body);
  if (!schemaCheck.ok) {
    step1.errors = schemaCheck.errors;
    step1.status = "failed";
    pipeline.push(step1);
    return failed(pipeline, "SCHEMA_VALIDATION", "Lead failed schema validation");
  }
  pipeline.push(step1);

  // STEP 2: Eligibility rules (server-enforced if-then logic).
  const step2: PipelineStep = { name: "ELIGIBILITY_RULES", status: "passed", errors: [] };
  const blockedMessages: string[] = [];
  for (const rule of cfg.eligibility_rules) {
    const value = body[rule.field];
    if (ruleFails(rule, value)) {
      blockedMessages.push(rule.message);
      step2.errors.push(`BLOCKED_${rule.id.toUpperCase()}`);
    }
  }
  if (step2.errors.length > 0) {
    step2.status = "failed";
    pipeline.push(step2);
    return {
      status: 422,
      body: {
        status: "error",
        code: "eligibility_blocked",
        message: blockedMessages[0] ?? "You do not currently qualify based on the answers provided.",
        outcome: "rejected",
        errors: step2.errors,
        blocked_messages: blockedMessages,
        action: "DO_NOT_RESUBMIT",
        pipeline,
        failed_step: "ELIGIBILITY_RULES",
      },
    };
  }
  pipeline.push(step2);

  // STEP 3: Email validation.
  const step3: PipelineStep = { name: "EMAIL_VALIDATION", status: "passed", errors: [] };
  const emailField = cfg.fields.find((f) => f.type === "email");
  let emailValue: string | undefined;
  if (emailField) {
    emailValue = String(body[emailField.key] ?? "").trim();
    const emailResult = validateEmail(emailValue);
    if (!emailResult.valid) {
      step3.errors = emailResult.errors ?? ["INVALID_EMAIL"];
      step3.status = "failed";
      pipeline.push(step3);
      return failed(pipeline, "EMAIL_VALIDATION", "Email failed validation");
    }
  }
  pipeline.push(step3);

  // STEP 4: Address validation (only if any address-related fields are present).
  const step4: PipelineStep = { name: "ADDRESS_VALIDATION", status: "skipped", errors: [] };
  const stateField = cfg.fields.find((f) => f.type === "state" || f.key === "state");
  if (stateField) {
    const stateValue = String(body[stateField.key] ?? "").toUpperCase();
    const addressResult = validateAddress({ state: stateValue, street_address: "", city: "", zip: "" });
    // For web forms we only have state, not full address. Only flag if state itself
    // is missing/invalid (already caught by schema validation but defense in depth).
    if (stateValue && addressResult.errors?.includes("INVALID_STATE")) {
      step4.errors = ["INVALID_STATE"];
      step4.status = "failed";
      pipeline.push(step4);
      return failed(pipeline, "ADDRESS_VALIDATION", "State failed validation");
    }
    step4.status = "passed";
  }
  pipeline.push(step4);

  // STEP 5: Persist the lead (dedup-aware upsert).
  //
  // Product rule: a single human filling out the website widget AND
  // the emailed Form Engine intake for the SAME tort campaign must end
  // up as ONE lead row ("signee"). See lib/lead-dedup.ts for the match
  // strategy. We attempt dedup BEFORE the insert, then either UPDATE
  // the existing row (preserving its identity for downstream documents
  // / envelopes) or INSERT a fresh one.
  const step5: PipelineStep = { name: "LEAD_INSERT", status: "passed", errors: [] };
  let leadId: number | null = null;
  let dedupOutcome: "inserted" | "merged_email" | "merged_phone" = "inserted";
  // Lift these out of the try block so the outbound webhook dispatch
  // below can reference them after a successful insert.
  const firstName = String(body.first_name ?? "").trim() || null;
  const lastName = String(body.last_name ?? "").trim() || null;
  const stateCode = stateField
    ? String(body[stateField.key] ?? "").toUpperCase().slice(0, 2) || null
    : null;
  // The legacy `name` column on `leads` is still NOT NULL at the table
  // level (kept for back-compat with older read paths). Match the same
  // join used by the operator intake handler in routes/leads.ts so admin
  // list views show the lead identically regardless of source.
  const fullName = `${firstName ?? ""} ${lastName ?? ""}`.trim() || (emailValue || "Web form lead");
  // TCPA consent: the default web form's "tcpa_required" eligibility rule
  // already blocks submission unless this checkbox is true, so by the time
  // we reach STEP 5 it's guaranteed truthy. Persist it on the lead row
  // anyway as a durable proof-of-consent column. The submission IP +
  // user-agent + timestamp are captured in the immutable audit_log row
  // above and can be cross-referenced by lead_id during any TCPA dispute.
  // If an operator removed the tcpa_consent field from a custom form, we
  // honestly write `false` so downstream contact rules can refuse to dial.
  const tcpaConsentVal = body.tcpa_consent;
  const tcpaConsented =
    tcpaConsentVal === true ||
    tcpaConsentVal === "true" ||
    tcpaConsentVal === "on";
  // Optional doctor's / hospital fax — used by the automation engine to
  // auto-dispatch a medical-records-request fax. Validated HARD through the
  // shared E.164 normalizer so a bad number can never reach the fax adapter.
  // The field is optional, but if present it must be valid (4xx) — silently
  // dropping bad input would let typos sit on the lead and surface as
  // "no fax on file" hours later when the automation tries to dispatch.
  let hospitalFaxE164: string | null = null;
  if (cfg.fields.some((f) => f.key === "hospital_fax")) {
    const raw = body.hospital_fax;
    if (raw != null && String(raw).trim()) {
      const { normalizeFaxNumber } = await import("../lib/fax/normalize");
      const norm = normalizeFaxNumber(String(raw));
      if (!norm.ok) {
        // The pipeline runs from a public route handler that surfaces
        // step errors via the standard PipelineResult envelope. Push the
        // failure on a synthetic FAX_VALIDATION step and short-circuit.
        const stepFax: PipelineStep = {
          name: "FAX_VALIDATION",
          status: "failed",
          errors: [`INVALID_HOSPITAL_FAX:${norm.message}`],
        };
        pipeline.push(stepFax);
        return failed(pipeline, "FAX_VALIDATION", norm.message);
      }
      hospitalFaxE164 = norm.e164;
    }
  }

  try {
    const phone = String(body.phone ?? "").trim() || null;
    const briefStory = body.brief_description ? String(body.brief_description).slice(0, 5000) : null;

    // Dedup BEFORE the write. We scope to the same tort label that we'd
    // be inserting under so the comparison is apples-to-apples.
    const existing = await findExistingLeadForIntake({
      email: emailValue || null,
      phone,
      tortType: config.label,
    });

    const encrypted = encryptLeadFields({ phone });

    if (existing) {
      // FILL-EMPTY MERGE.
      //
      // This endpoint is PUBLIC and unauthenticated. Without a
      // possession-of-email proof (a signed token in a confirmation-
      // email link — tracked as a follow-up), an attacker who knows or
      // guesses a victim's email could submit a form to tamper with
      // their record. We mitigate by NEVER overwriting an already-set
      // identifying field. We only fill columns that are currently
      // NULL/empty, so the worst an attacker can do is annotate a
      // partial lead — they cannot alter existing PII or status.
      //
      // SQL `COALESCE(existing, $new)` keeps the existing value if it
      // is NOT NULL; otherwise picks the submitter's value. We use
      // `sql` template tags to express this concisely while still
      // letting Drizzle parameterize the new values safely.
      const setExpr: Record<string, unknown> = {
        updated_at: new Date(),
      };
      if (firstName) setExpr.first_name = sql`COALESCE(${leadsTable.first_name}, ${firstName})`;
      if (lastName) setExpr.last_name = sql`COALESCE(${leadsTable.last_name}, ${lastName})`;
      if (emailValue) setExpr.email = sql`COALESCE(${leadsTable.email}, ${emailValue})`;
      if (encrypted.phone) setExpr.phone = sql`COALESCE(${leadsTable.phone}, ${encrypted.phone})`;
      if (stateCode) setExpr.state = sql`COALESCE(${leadsTable.state}, ${stateCode})`;
      if (briefStory) setExpr.notes = sql`COALESCE(${leadsTable.notes}, ${briefStory})`;
      if (hospitalFaxE164) setExpr.hospital_fax = sql`COALESCE(${leadsTable.hospital_fax}, ${hospitalFaxE164})`;
      // tcpa_consent is the one field that should ratchet UP — once
      // consented, stay consented. Never demote to false.
      if (tcpaConsented) setExpr.tcpa_consent = sql`${leadsTable.tcpa_consent} OR true`;
      await db
        .update(leadsTable)
        .set(setExpr as Partial<typeof leadsTable.$inferInsert>)
        .where(eq(leadsTable.id, existing.leadId));

      // Audit every public merge so an operator can investigate
      // suspicious activity. The audit row carries the submitter IP /
      // user-agent recorded in the surrounding pipeline's audit_log
      // entries, which can be cross-referenced by lead_id.
      await auditLog("lead", String(existing.leadId), "web_form_merge", {
        tort_id: tortId,
        matched_by: existing.matchedBy,
        had_email: !!emailValue,
        had_phone: !!encrypted.phone,
      });

      leadId = existing.leadId;
      dedupOutcome = existing.matchedBy === "email" ? "merged_email" : "merged_phone";
    } else {
      const inserted = await db
        .insert(leadsTable)
        .values({
          name: fullName,
          tort_type: config.label,
          status: "web_form_intake",
          source: `web_form_${tortId}`,
          first_name: firstName,
          last_name: lastName,
          email: emailValue || null,
          phone: encrypted.phone,
          state: stateCode,
          notes: briefStory,
          hospital_fax: hospitalFaxE164,
          tcpa_consent: tcpaConsented,
          // Task #15: canonical dedup hash over plaintext (tort|email|phone10).
          // Returns null if any component is missing — column stays NULL and
          // the dedup helper falls back to the email/phone scan paths.
          lookup_hash: leadLookupHash(config.label, emailValue, phone),
        } as typeof leadsTable.$inferInsert)
        .returning();
      leadId = inserted[0]?.id ?? null;
      // Task #8: rebind ciphertext AAD to the freshly-assigned lead.id.
      if (inserted[0]) {
        await rebindLeadEncryptionAad(db, leadsTable, inserted[0] as Record<string, unknown>, eq);
      }
    }
  } catch (err) {
    logger.error({ err, tortId }, "web-form lead persist failed");
    step5.errors = ["LEAD_INSERT_FAILED"];
    step5.status = "failed";
    pipeline.push(step5);
    return failed(pipeline, "LEAD_INSERT", "Failed to record submission");
  }
  step5.data = { dedup_outcome: dedupOutcome, lead_id: leadId };
  pipeline.push(step5);

  // STEP 5b: Background check (synchronous-but-non-fatal, same pattern
  // as the heavy Form Engine pipeline at routes/forms.ts:861). The
  // result is persisted onto the lead row via `background_check_status`
  // and `background_check_data`. A failure here MUST NOT roll back the
  // lead — operators can re-run the heavy hub manually from the UI.
  const stepBg: PipelineStep = { name: "BACKGROUND_CHECK", status: "skipped", errors: [] };
  // Skip on MERGE *only if the merged lead already has a meaningful
  // bg result*. This prevents:
  //   (a) clobbering a meaningful prior result with a transient
  //       `error` / `not_found` from the lightweight check,
  //   (b) an attacker spamming the bg-check provider via the public
  //       endpoint with a victim's email.
  // But it deliberately ALLOWS backfill: if the original submission
  // failed the bg step or skipped it (no name on file at the time),
  // a legitimate resubmission can still complete the bg check.
  let bgAlreadyDone = false;
  if (leadId && dedupOutcome !== "inserted") {
    const [existingBg] = await db
      .select({ status: leadsTable.background_check_status })
      .from(leadsTable)
      .where(eq(leadsTable.id, leadId))
      .limit(1);
    bgAlreadyDone =
      !!existingBg?.status && existingBg.status !== "" && existingBg.status !== "error";
  }
  if (bgAlreadyDone) {
    stepBg.errors = ["SKIPPED_ALREADY_HAS_RESULT"];
  } else if (leadId && firstName && lastName) {
    try {
      const bg = await runBackgroundCheck({
        first_name: firstName,
        last_name: lastName,
        state: stateCode ?? undefined,
      });
      await db
        .update(leadsTable)
        .set({
          background_check_status: bg.status,
          background_check_data: JSON.stringify(bg),
          updated_at: new Date(),
        })
        .where(eq(leadsTable.id, leadId));
      stepBg.status = "passed";
      stepBg.data = { status: bg.status };

      if (bg.status === "clean" && leadId) {
        void provisionPortalInvite(leadId);
      }
    } catch (bgErr) {
      logger.warn({ err: bgErr, leadId }, "web-form background check failed");
      stepBg.status = "failed";
      stepBg.errors = ["BACKGROUND_CHECK_ERROR"];
    }
  } else if (leadId) {
    stepBg.errors = ["MISSING_NAME_FOR_BG_CHECK"];
  }
  pipeline.push(stepBg);

  // Outbound webhook: notify any active automation integrations
  // (n8n / Zapier / Make) that a new lead landed. Fire-and-forget so
  // a slow third-party endpoint never blocks our response to the
  // submitter. Each delivery is audit-logged with status + latency.
  if (leadId) {
    dispatchLeadCreated({
      source: `web_form_${tortId}`,
      lead: {
        id: leadId,
        name: fullName,
        first_name: firstName,
        last_name: lastName,
        email: emailValue || null,
        state: stateCode,
        tort_type: config.label,
        status: "web_form_intake",
        source: `web_form_${tortId}`,
        created_at: new Date().toISOString(),
      },
    });

    // Fan out to internal automation workflows whose entry node is
    // `trigger.form_submitted`. The submission payload + lead reference
    // become the trigger input, so a graph can wire `documents.fax_medical_records`
    // straight to "input.lead.id" and have the doctor's-fax dispatch
    // happen automatically when the web form is submitted.
    const { dispatchTrigger } = await import("../lib/automations/dispatch");
    void dispatchTrigger("trigger.form_submitted", {
      input: {
        tort_id: tortId,
        tort_label: config.label,
        submission: body,
        lead: {
          id: leadId,
          first_name: firstName,
          last_name: lastName,
          email: emailValue || null,
          state: stateCode,
          tort_type: config.label,
          hospital_fax: hospitalFaxE164,
        },
      },
      // Web-form submissions are tenant-less at intake (the lead has no
      // firm_id assigned yet). To prevent cross-tenant PII leakage we
      // scope the dispatch to system-wide workflows only (firm_id IS NULL).
      // Per-firm workflows pick the lead up later, after assignment, via
      // the `trigger.lead_assigned` / `trigger.lead_created_in_firm` events.
      // (Previously this was "any" which fanned to every firm — flagged as
      // a multi-tenant risk in code review.)
      firmId: null,
      source: `web_form_${tortId}`,
    });
  }

  // STEP 6: Optional confirmation email.
  const step6: PipelineStep = { name: "CONFIRMATION_EMAIL", status: "skipped", errors: [] };
  let emailOutcome:
    | "sent"
    | "would_send_no_provider"
    | "would_send_no_adapter"
    | "skipped"
    | "failed" = "skipped";
  if (cfg.send_confirmation_email && emailValue) {
    try {
      const resolved = await resolveProvider("email");
      if (!isResolved(resolved)) {
        emailOutcome = "would_send_no_provider";
        step6.status = "skipped";
        step6.errors = [resolved.reason];
        void auditLog("web_form_confirmation_email", String(leadId ?? tortId), "would_send_no_provider", {
          tort_id: tortId,
          reason: resolved.reason,
          details: resolved.details,
        });
      } else {
        const adapter = getEmailAdapter(resolved.provider);
        if (!adapter) {
          // The operator picked an email provider in workflow_settings that
          // is in the credential vault but has no live send adapter shipped
          // in this build (e.g., Mailgun, Postmark, SES). The migration-
          // honesty principle forbids us from claiming we sent it. Audit
          // the miss so the operator can see WHICH provider needs to be
          // wired (or swapped to SendGrid).
          emailOutcome = "would_send_no_adapter";
          step6.status = "skipped";
          step6.errors = [`no_adapter:${resolved.provider}`];
          logger.warn(
            {
              tortId,
              leadId,
              provider: resolved.provider,
              integration_id: resolved.integration_id,
            },
            "Web form confirmation email skipped — no adapter shipped for chosen email provider",
          );
          void auditLog(
            "web_form_confirmation_email",
            String(leadId ?? tortId),
            "would_send_no_adapter",
            {
              tort_id: tortId,
              provider: resolved.provider,
              integration_id: resolved.integration_id,
              integration_name: resolved.name,
              reason:
                "Provider selected in workflow_settings has no live send adapter in this build. Switch to SendGrid or wait for the adapter to ship.",
            },
          );
        } else {
          const globalSettings = await db
            .select({ fromAddress: workflowSettingsTable.default_email_from_address, fromName: workflowSettingsTable.default_email_from_name })
            .from(workflowSettingsTable)
            .where(eq(workflowSettingsTable.scope, "global"))
            .limit(1)
            .then((r) => r[0] ?? null);
          const fromEmail = resolved.credentials.from_email
            || globalSettings?.fromAddress
            || "noreply@example.com";
          const fromName = resolved.credentials.from_name
            || globalSettings?.fromName
            || "Mass Tort OS";
          const html = renderTemplate(cfg.confirmation_body_html, body);
          const subject = renderTemplate(cfg.confirmation_subject, body);
          const result = await adapter.send(resolved.credentials, {
            to: emailValue,
            toName: [body.first_name, body.last_name].filter(Boolean).join(" ") || undefined,
            fromEmail,
            fromName,
            subject,
            html,
          });
          emailOutcome = result.ok ? "sent" : "failed";
          step6.status = result.ok ? "passed" : "skipped";
          if (!result.ok) step6.errors = [result.code];
          void auditLog("web_form_confirmation_email", String(leadId ?? tortId), emailOutcome, {
            tort_id: tortId,
            provider: resolved.provider,
            external_message_id: result.ok ? result.externalMessageId : undefined,
            error: result.ok ? undefined : result.message,
          });
        }
      }
    } catch (err) {
      emailOutcome = "failed";
      step6.status = "skipped";
      step6.errors = ["EXCEPTION"];
      logger.warn({ err, tortId, leadId }, "Confirmation email exception (non-blocking)");
    }
  }
  pipeline.push(step6);

  return {
    status: 200,
    body: {
      status: "success",
      outcome: "accepted",
      lead_id: leadId,
      message:
        emailOutcome === "sent"
          ? "Submission received. Check your email for next steps."
          : "Submission received. A paralegal will reach out shortly.",
      pipeline,
      confirmation_email: emailOutcome,
    },
  };
}

function failed(pipeline: PipelineStep[], failedStep: string, message: string): PipelineResult {
  const errors = pipeline.flatMap((p) => p.errors);
  return {
    status: 422,
    body: {
      status: "error",
      code: "validation_rejected",
      message,
      outcome: "rejected",
      errors,
      action: "FIX_AND_RESUBMIT",
      pipeline,
      failed_step: failedStep,
    },
  };
}

function renderTemplate(tpl: string, body: Record<string, unknown>): string {
  return tpl.replace(/{{\s*([a-z_][a-z0-9_]*)\s*}}/gi, (_match, key) => {
    const v = body[key];
    if (v === undefined || v === null) return "";
    return htmlEscape(String(v));
  });
}

function htmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ─────────────────────────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────────────────────────

/**
 * Public sanitized config — what the embed.js needs to render the form.
 * Excludes admin metadata; includes only fields/eligibility/intro.
 */
router.get("/:tortId", async (req, res) => {
  const tortId = String(req.params.tortId);
  try {
    const config = await getFormConfig(tortId);
    if (!config || !config.active) {
      notFound(res, "Form not found or inactive");
      return;
    }
    const cfg = config.web_form_config;
    if (!cfg || !cfg.enabled) {
      notFound(res, "Web form is not enabled for this campaign");
      return;
    }
    res.json({
      tort_id: tortId,
      tort_label: config.label,
      enabled: cfg.enabled,
      intro_headline: cfg.intro_headline,
      intro_subhead: cfg.intro_subhead,
      fields: cfg.fields,
      eligibility_rules: cfg.eligibility_rules,
    });
  } catch (err) {
    logger.error({ err, tortId }, "Failed to fetch web form config");
    serverError(res, "Failed to fetch form");
  }
});

/**
 * Embeddable JS. Renders the configured form, evaluates eligibility rules
 * client-side for live UX, then POSTs to /submit. Server still re-validates
 * everything — client checks are only a hint.
 */
/**
 * Standalone HTML preview of the embedded form. Useful for admins to verify
 * the form across desktop / tablet / mobile viewports before sending the embed
 * snippet to a partner. Mirrors what a partner site would see.
 */
router.get("/:tortId/preview", async (req, res) => {
  const tortId = String(req.params.tortId);
  try {
    const baseUrl = resolveBaseUrl(req);
    if (!baseUrl) {
      badRequest(res, "Invalid host");
      return;
    }
    const config = await getFormConfig(tortId);
    if (!config || !config.active) {
      notFound(res, "Form not found or inactive");
      return;
    }
    const cfg = config.web_form_config;
    if (!cfg || !cfg.enabled) {
      notFound(res, "Web form is not enabled for this campaign");
      return;
    }
    const safeLabel = String(config.label).replace(/[<>&"']/g, "");
    const safeTortId = encodeURIComponent(tortId);
    // Thread vendor token into the embed.js src so the form's submit fetch includes ?v=TOKEN.
    const rawVt = typeof req.query.v === "string" ? req.query.v : "";
    const safeVt = /^[0-9a-f]{32,64}$/i.test(rawVt) ? rawVt : "";
    const embedSrc = safeVt
      ? `${baseUrl}/api/web-forms/${safeTortId}/embed.js?v=${safeVt}`
      : `${baseUrl}/api/web-forms/${safeTortId}/embed.js`;
    const isVendorLink = Boolean(safeVt);
    const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex,nofollow" />
<title>${safeLabel}</title>
<style>
html,body{margin:0;padding:0;background:#f8fafc;min-height:100%}
body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#0f172a}
.wrap{max-width:720px;margin:0 auto;padding:16px}
.bar{font-size:12px;color:#64748b;padding:8px 4px;border-bottom:1px solid #e2e8f0;margin-bottom:16px}
.card{background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:8px;box-shadow:0 1px 2px rgba(0,0,0,.04)}
@media (min-width:640px){.wrap{padding:24px}.card{padding:16px}}
</style>
</head>
<body>
<div class="wrap">
${isVendorLink ? "" : `<div class="bar">Preview · responsive · embedded form for <strong>${safeLabel}</strong></div>`}
<div class="card"><div id="mtos-web-form"></div></div>
</div>
<script src="${embedSrc}" defer></script>
</body>
</html>`;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.send(html);
  } catch (err) {
    logger.error({ err, tortId }, "Failed to generate web form preview");
    serverError(res, "Failed to generate preview");
  }
});

router.get("/:tortId/embed.js", async (req, res) => {
  const tortId = String(req.params.tortId);
  try {
    const baseUrl = resolveBaseUrl(req);
    if (!baseUrl) {
      badRequest(res, "Invalid host");
      return;
    }
    const config = await getFormConfig(tortId);
    if (!config || !config.active) {
      notFound(res, "Form not found or inactive");
      return;
    }
    const cfg = config.web_form_config;
    if (!cfg || !cfg.enabled) {
      notFound(res, "Web form is not enabled for this campaign");
      return;
    }
    // Pass vendor token through so the generated embed includes it in its submit URL.
    const vt = typeof req.query.v === "string" && /^[0-9a-f]{32,64}$/i.test(req.query.v)
      ? req.query.v : undefined;
    const js = generateWebFormEmbed(tortId, config.label, cfg, baseUrl, vt);
    res.setHeader("Content-Type", "application/javascript; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    res.send(js);
  } catch (err) {
    logger.error({ err, tortId }, "Failed to generate web form embed");
    serverError(res, "Failed to generate embed");
  }
});

/**
 * Submit a web form. Runs the pipeline; persists a lead if accepted; sends
 * a confirmation email if configured.
 */
router.post("/:tortId/submit", async (req, res) => {
  const tortId = String(req.params.tortId);
  let config;
  try {
    config = await getFormConfig(tortId);
  } catch (err) {
    logger.error({ err, tortId }, "form-config lookup failed during web-form submit");
    serverError(res, "Form lookup failed");
    return;
  }
  if (!config || !config.active) {
    notFound(res, "Form not found or inactive");
    return;
  }
  const cfg = config.web_form_config;
  if (!cfg || !cfg.enabled) {
    notFound(res, "Web form is not enabled for this campaign");
    return;
  }

  const sourceIp = sourceIpOf(req);
  const origin = req.get("origin") ?? null;
  const referer = req.get("referer") ?? null;

  const body =
    req.body && typeof req.body === "object"
      ? (req.body as Record<string, unknown>)
      : {};

  // Resolve optional vendor token (?v=TOKEN) and stamp vendor_id on the lead.
  const vToken = req.query.v;
  if (typeof vToken === "string" && /^[0-9a-f]{32,64}$/i.test(vToken)) {
    try {
      const [vendor] = await db
        .select({ id: vendorsTable.id })
        .from(vendorsTable)
        .where(eq(vendorsTable.portal_token, vToken));
      if (vendor) {
        (body as Record<string, unknown>).vendor_id = vendor.id;
      }
    } catch (err) {
      logger.warn({ err }, "web-form vendor token resolution failed — lead will be unattributed");
    }
  }

  // Audit the attempt regardless of outcome (TCPA / abuse trail).
  void auditLog("web_form_submission_attempt", tortId, "web_form_embed", {
    tort_id: tortId,
    tort_label: config.label,
    source_ip: sourceIp,
    origin,
    referer,
  }).catch((err) => logger.warn({ err, tortId }, "audit attempt failed"));

  const result = await runWebFormPipeline(
    tortId,
    { label: config.label, web_form_config: cfg },
    body,
    req,
  );

  // Audit the result row.
  void auditLog(
    "web_form_submission_result",
    String(result.body.lead_id ?? tortId),
    "web_form_embed",
    {
      tort_id: tortId,
      tort_label: config.label,
      source_ip: sourceIp,
      status_code: result.status,
      outcome: result.body.status ?? null,
      lead_id: result.body.lead_id ?? null,
      failed_step: result.body.failed_step ?? null,
      confirmation_email: result.body.confirmation_email ?? null,
    },
  ).catch((err) => logger.warn({ err, tortId }, "audit result failed"));

  res.status(result.status).json(result.body);
});

/**
 * Pre-submit live validators (used by embed.js for inline UX hints).
 * No PII required.
 */
router.post("/validate/email", (req, res) => {
  const email = (req.body as Record<string, unknown>)?.email;
  res.json(validateEmail(typeof email === "string" ? email : ""));
});

router.post("/validate/address", (req, res) => {
  const body = (req.body as Record<string, unknown>) ?? {};
  res.json(
    validateAddress({
      street_address: typeof body.street_address === "string" ? body.street_address : undefined,
      city: typeof body.city === "string" ? body.city : undefined,
      state: typeof body.state === "string" ? body.state : undefined,
      zip: typeof body.zip === "string" ? body.zip : undefined,
    }),
  );
});

// ─────────────────────────────────────────────────────────────────────────
// Embed JS generator
// ─────────────────────────────────────────────────────────────────────────

function generateWebFormEmbed(
  tortId: string,
  label: string,
  cfg: WebFormConfig,
  baseUrl: string,
  vendorToken?: string,
): string {
  const data = {
    api: `${baseUrl}/api/web-forms`,
    tortId,
    tortLabel: label,
    introHeadline: cfg.intro_headline,
    introSubhead: cfg.intro_subhead,
    fields: cfg.fields,
    rules: cfg.eligibility_rules,
    vt: vendorToken ?? "",
  };
  const json = JSON.stringify(data);
  // Note: the embed runtime is intentionally small (~3KB) and dependency-free
  // so it loads fast on partner landing pages. It does no eval — fields and
  // rules are JSON-injected once at boot.
  return `(function(){
var DATA=${json};
var STATES=["AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA","KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT","VA","WA","WV","WI","WY","DC"];
function el(t,a,c){var e=document.createElement(t);if(a)Object.keys(a).forEach(function(k){if(k==="text")e.textContent=a[k];else if(k.indexOf("on")===0)e.addEventListener(k.slice(2),a[k]);else e.setAttribute(k,a[k]);});if(c)c.forEach(function(x){if(x)e.appendChild(x);});return e;}
function input(f){
  if(f.type==="textarea")return el("textarea",{name:f.key,id:"wf_"+f.key,rows:"4",maxlength:String(f.max_length||2000),placeholder:f.placeholder||""});
  if(f.type==="checkbox"){var c=el("input",{type:"checkbox",name:f.key,id:"wf_"+f.key,value:"true"});return c;}
  if(f.type==="select"||f.type==="state"){
    var opts=f.type==="state"?STATES.map(function(s){return s;}):(f.options||[]);
    var s=el("select",{name:f.key,id:"wf_"+f.key});
    s.appendChild(el("option",{value:"",text:"— Select —"}));
    opts.forEach(function(o){s.appendChild(el("option",{value:o,text:o}));});
    return s;
  }
  if(f.type==="radio"){
    var w=el("div",{"class":"wf-radio-group"});
    (f.options||[]).forEach(function(o,i){
      var id="wf_"+f.key+"_"+i;
      var lab=el("label",{"for":id,"class":"wf-radio-opt"});
      var r=el("input",{type:"radio",name:f.key,id:id,value:o});
      lab.appendChild(r);
      lab.appendChild(el("span",{text:o}));
      w.appendChild(lab);
    });
    return w;
  }
  return el("input",{type:f.type,name:f.key,id:"wf_"+f.key,maxlength:String(f.max_length||255),placeholder:f.placeholder||""});
}
function buildSection(name,title,fields){
  if(fields.length===0)return null;
  var wrap=el("fieldset",{"class":"wf-section wf-section-"+name});
  wrap.appendChild(el("legend",{text:title}));
  fields.forEach(function(f){
    var row=el("div",{"class":"wf-row"});
    var lab=el("label",{"for":"wf_"+f.key,"class":"wf-label"+(f.required?" wf-required":"")});
    lab.appendChild(el("span",{text:f.label}));
    if(f.required)lab.appendChild(el("span",{"class":"wf-req-star",text:" *"}));
    row.appendChild(lab);
    if(f.type==="checkbox"){
      var inline=el("div",{"class":"wf-checkbox-row"});
      inline.appendChild(input(f));
      var cl=el("label",{"for":"wf_"+f.key,"class":"wf-cb-label",text:f.label});
      row.innerHTML="";
      row.appendChild(inline);
      inline.appendChild(cl);
    }else{
      row.appendChild(input(f));
    }
    if(f.helper_text)row.appendChild(el("div",{"class":"wf-helper",text:f.helper_text}));
    row.appendChild(el("div",{"class":"wf-error","id":"wfe_"+f.key}));
    wrap.appendChild(row);
  });
  return wrap;
}
function readVal(f){
  if(f.type==="checkbox"){var c=document.getElementById("wf_"+f.key);return c&&c.checked?"true":"false";}
  if(f.type==="radio"){var rs=document.getElementsByName(f.key);for(var i=0;i<rs.length;i++)if(rs[i].checked)return rs[i].value;return "";}
  var e=document.getElementById("wf_"+f.key);return e?e.value:"";
}
function ruleFails(rule,val){
  var v=String(val||"").trim().toLowerCase();
  var t=String(rule.value).trim().toLowerCase();
  if(rule.op==="eq")return v===t;
  if(rule.op==="ne")return v!==t;
  if(rule.op==="lt")return Number(v)<Number(t);
  if(rule.op==="gt")return Number(v)>Number(t);
  return false;
}
function init(){
  var root=document.getElementById("mtos-web-form")||document.querySelector(".mtos-web-form");
  if(!root){console.warn("MTOS web form: container #mtos-web-form not found");return;}
  var style=el("style",{text:".mtos-wf{box-sizing:border-box;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;width:100%;max-width:640px;margin:0 auto;padding:16px;color:#0f172a;line-height:1.4}.mtos-wf *,.mtos-wf *::before,.mtos-wf *::after{box-sizing:border-box}.mtos-wf h2{margin:0 0 8px 0;font-size:22px;line-height:1.25;word-wrap:break-word}.mtos-wf .wf-sub{color:#475569;margin:0 0 20px 0;font-size:15px}.mtos-wf .wf-section{border:none;padding:0;margin:0 0 24px 0;min-width:0}.mtos-wf legend{font-weight:600;font-size:14px;text-transform:uppercase;letter-spacing:.04em;color:#0f172a;margin-bottom:12px;padding:0;display:block;width:100%}.mtos-wf .wf-row{margin-bottom:14px;min-width:0}.mtos-wf .wf-grid{display:grid;grid-template-columns:1fr;gap:14px;margin-bottom:14px}.mtos-wf .wf-label{display:block;font-size:13px;font-weight:500;margin-bottom:6px;word-wrap:break-word}.mtos-wf .wf-req-star{color:#dc2626}.mtos-wf input[type=text],.mtos-wf input[type=email],.mtos-wf input[type=tel],.mtos-wf input[type=number],.mtos-wf input[type=date],.mtos-wf select,.mtos-wf textarea{display:block;width:100%;max-width:100%;padding:12px 14px;border:1px solid #cbd5e1;border-radius:8px;font-size:16px;font-family:inherit;background:#fff;color:#0f172a;-webkit-appearance:none;appearance:none;min-height:44px}.mtos-wf select{background-image:url(data:image/svg+xml;charset=US-ASCII,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2212%22%20height%3D%228%22%20viewBox%3D%220%200%2012%208%22%3E%3Cpath%20fill%3D%22%23475569%22%20d%3D%22M6%208L0%200h12z%22%2F%3E%3C%2Fsvg%3E);background-repeat:no-repeat;background-position:right 14px center;padding-right:36px}.mtos-wf input:focus,.mtos-wf select:focus,.mtos-wf textarea:focus{outline:none;border-color:#0f172a;box-shadow:0 0 0 3px rgba(15,23,42,.12)}.mtos-wf textarea{resize:vertical;min-height:96px;line-height:1.5}.mtos-wf .wf-radio-group{display:flex;flex-direction:column;gap:8px}.mtos-wf .wf-radio-opt{display:flex;align-items:center;gap:10px;font-size:15px;cursor:pointer;padding:10px 12px;border:1px solid #e2e8f0;border-radius:8px;min-height:44px;background:#fff}.mtos-wf .wf-radio-opt:hover{background:#f8fafc}.mtos-wf .wf-radio-opt input[type=radio]{width:18px;height:18px;margin:0;flex-shrink:0;accent-color:#0f172a}.mtos-wf .wf-checkbox-row{display:flex;align-items:flex-start;gap:10px;padding:4px 0}.mtos-wf .wf-checkbox-row input[type=checkbox]{width:20px;height:20px;margin-top:1px;flex-shrink:0;accent-color:#0f172a}.mtos-wf .wf-cb-label{font-size:14px;color:#334155;line-height:1.45;cursor:pointer;flex:1;min-width:0;word-wrap:break-word}.mtos-wf .wf-helper{font-size:12px;color:#64748b;margin-top:6px;line-height:1.4}.mtos-wf .wf-error{font-size:12px;color:#dc2626;margin-top:4px;min-height:0}.mtos-wf button{background:#0f172a;color:#fff;border:0;padding:14px 20px;border-radius:8px;font-size:16px;font-weight:600;cursor:pointer;width:100%;margin-top:8px;min-height:48px;-webkit-appearance:none;appearance:none}.mtos-wf button:hover:not(:disabled){background:#1e293b}.mtos-wf button:disabled{opacity:.5;cursor:not-allowed}.mtos-wf .wf-block{background:#fef2f2;border:1px solid #fca5a5;color:#991b1b;padding:12px 14px;border-radius:8px;font-size:14px;margin-top:14px;line-height:1.45}.mtos-wf .wf-success{background:#f0fdf4;border:1px solid #86efac;color:#166534;padding:16px 18px;border-radius:8px;font-size:15px;line-height:1.5}@media (min-width:480px){.mtos-wf .wf-radio-group{flex-direction:row;flex-wrap:wrap}.mtos-wf .wf-radio-opt{flex:0 1 auto;min-width:120px}}@media (min-width:640px){.mtos-wf{padding:24px}.mtos-wf h2{font-size:26px}.mtos-wf .wf-grid-2{grid-template-columns:1fr 1fr}.mtos-wf button{width:auto;min-width:200px}}@media (max-width:380px){.mtos-wf{padding:12px}.mtos-wf h2{font-size:20px}.mtos-wf .wf-sub{font-size:14px}.mtos-wf legend{font-size:13px}}"});
  document.head.appendChild(style);
  var cont=el("div",{"class":"mtos-wf"});
  if(DATA.introHeadline)cont.appendChild(el("h2",{text:DATA.introHeadline}));
  if(DATA.introSubhead)cont.appendChild(el("p",{"class":"wf-sub",text:DATA.introSubhead}));
  var form=el("form",{"class":"mtos-wf-form",novalidate:"true"});
  var sections=[["eligibility","Eligibility"],["contact","Your Contact Info"],["story","Your Situation"]];
  sections.forEach(function(s){
    var fs=DATA.fields.filter(function(f){return f.section===s[0];});
    var sec=buildSection(s[0],s[1],fs);
    if(sec)form.appendChild(sec);
  });
  var msg=el("div",{"class":"wf-msg"});
  var btn=el("button",{type:"submit",text:"Submit"});
  form.appendChild(msg);
  form.appendChild(btn);
  form.addEventListener("submit",function(ev){
    ev.preventDefault();
    msg.innerHTML="";
    btn.disabled=true;btn.textContent="Submitting…";
    var payload={};
    DATA.fields.forEach(function(f){payload[f.key]=readVal(f);});
    // Client-side eligibility hint (server is the source of truth).
    for(var i=0;i<DATA.rules.length;i++){
      var r=DATA.rules[i];
      if(ruleFails(r,payload[r.field])){
        msg.appendChild(el("div",{"class":"wf-block",text:r.message}));
        btn.disabled=false;btn.textContent="Submit";
        return;
      }
    }
    fetch(DATA.api+"/"+DATA.tortId+"/submit"+(DATA.vt?"?v="+encodeURIComponent(DATA.vt):""),{
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify(payload)
    }).then(function(r){return r.json().then(function(j){return {status:r.status,body:j};});}).then(function(out){
      btn.disabled=false;btn.textContent="Submit";
      if(out.status===200&&out.body.status==="success"){
        cont.innerHTML="";
        cont.appendChild(el("div",{"class":"wf-success",text:out.body.message||"Thank you. A paralegal will reach out shortly."}));
        return;
      }
      var m=out.body.message||"There was a problem. Please check your answers and try again.";
      msg.appendChild(el("div",{"class":"wf-block",text:m}));
    }).catch(function(){
      btn.disabled=false;btn.textContent="Submit";
      msg.appendChild(el("div",{"class":"wf-block",text:"Network error. Please try again."}));
    });
  });
  cont.appendChild(form);
  root.innerHTML="";
  root.appendChild(cont);
}
if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",init);else init();
})();`;
}

export default router;

// Re-export so admin endpoints in routes/forms.ts can update web_form_config.
export async function updateWebFormConfig(
  tortId: string,
  next: WebFormConfig,
  updatedBy: number | null,
): Promise<WebFormConfig | null> {
  const updated = await db
    .update(formConfigurationsTable)
    .set({
      web_form_config: next,
      updated_by: updatedBy ?? undefined,
      updated_at: new Date(),
    })
    .where(eq(formConfigurationsTable.id, tortId))
    .returning({ web_form_config: formConfigurationsTable.web_form_config });
  return updated[0]?.web_form_config ?? null;
}
