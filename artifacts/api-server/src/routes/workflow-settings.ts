import { Router } from "express";
import { db, workflowSettingsTable, integrationsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { authMiddleware, Permission, requirePermission } from "../lib/rbac";
import { auditAction } from "../lib/rbac";
import { requireFirmId } from "../lib/firm-scope";
import { z } from "zod/v4";
import { listEsignProviders } from "../lib/esign";
import { listFaxProviders } from "../lib/fax";
import { listEmailProviders } from "../lib/email";
import { listSmsProviders } from "../lib/sms";
import { listVoiceProviders } from "../lib/voice";
import { listLlmProviders } from "../lib/ai";
import { badRequest, serverError } from "../lib/http-errors";
import { logger } from "../lib/logger";
import { pool } from "@workspace/db";

const router = Router();
router.use(authMiddleware);

// Idempotent schema repair — first request after deploy adds the firm_id
// column to the legacy singleton table. Safe to re-run; postgres' IF NOT
// EXISTS guards keep this from churning on every cold start once applied.
let _schemaPatched = false;
async function ensureFirmIdColumn(): Promise<void> {
  if (_schemaPatched) return;
  try {
    await pool.query("ALTER TABLE workflow_settings ADD COLUMN IF NOT EXISTS firm_id integer");
    await pool.query("CREATE INDEX IF NOT EXISTS workflow_settings_firm_idx ON workflow_settings(firm_id)");
    // Drop the old unique-on-scope constraint (legacy singleton) if it
    // still exists, then add the (firm_id, scope) unique. The legacy
    // constraint name varies by drizzle version — try the two common ones.
    await pool.query("ALTER TABLE workflow_settings DROP CONSTRAINT IF EXISTS workflow_settings_scope_unique");
    await pool.query("ALTER TABLE workflow_settings DROP CONSTRAINT IF EXISTS workflow_settings_scope_key");
    await pool.query("CREATE UNIQUE INDEX IF NOT EXISTS workflow_settings_firm_scope_idx ON workflow_settings(firm_id, scope)");
  } catch (err) {
    logger.warn({ err }, "workflow_settings firm_id schema repair partial — continuing");
  }
  _schemaPatched = true;
}

const settingsSchema = z.object({
  scope: z.string().min(1).max(100).default("global"),
  esign_provider_integration_id: z.number().int().nullish(),
  fax_provider_integration_id: z.number().int().nullish(),
  email_provider_integration_id: z.number().int().nullish(),
  sms_provider_integration_id: z.number().int().nullish(),
  voice_provider_integration_id: z.number().int().nullish(),
  llm_default_provider_integration_id: z.number().int().nullish(),
  llm_drafting_provider_integration_id: z.number().int().nullish(),
  default_email_from_name: z.string().max(255).nullish(),
  default_email_from_address: z.email().nullish(),
  default_fax_from_number: z.string().max(50).nullish(),
  auto_send_on_approval: z.boolean().optional(),
  auto_fax_doctor_on_signed_hipaa: z.boolean().optional(),
  esign_resend_after_days: z.number().int().min(0).max(60).optional(),
  esign_expire_after_days: z.number().int().min(1).max(180).optional(),
  max_send_retries: z.number().int().min(0).max(10).optional(),
  notify_on_failure_email: z.email().nullish(),
  med_records_cover_letter_template_id: z.number().int().nullish(),
  notes: z.string().nullish(),
});

router.get("/", requirePermission(Permission.WORKFLOW_SETTINGS_VIEW), async (req, res) => {
  try {
    await ensureFirmIdColumn();
    const firmId = requireFirmId(req);
    const rows = await db
      .select()
      .from(workflowSettingsTable)
      .where(eq(workflowSettingsTable.firm_id, firmId));
    res.json(rows);
  } catch (err: any) {
    logger.error({ err: err?.message }, "workflow-settings GET / failed");
    serverError(res, "Failed to list workflow settings");
  }
});

router.get("/:scope", requirePermission(Permission.WORKFLOW_SETTINGS_VIEW), async (req, res) => {
  try {
    await ensureFirmIdColumn();
    const firmId = requireFirmId(req);
    const scope = String(req.params.scope);
    const [row] = await db
      .select()
      .from(workflowSettingsTable)
      .where(and(eq(workflowSettingsTable.firm_id, firmId), eq(workflowSettingsTable.scope, scope)));
    if (!row) {
      res.json({
        scope,
        esign_provider_integration_id: null,
        fax_provider_integration_id: null,
        email_provider_integration_id: null,
        sms_provider_integration_id: null,
        voice_provider_integration_id: null,
        llm_default_provider_integration_id: null,
        llm_drafting_provider_integration_id: null,
        default_email_from_name: null,
        default_email_from_address: null,
        default_fax_from_number: null,
        auto_send_on_approval: false,
        auto_fax_doctor_on_signed_hipaa: false,
        esign_resend_after_days: 3,
        esign_expire_after_days: 30,
        max_send_retries: 3,
        notify_on_failure_email: null,
        med_records_cover_letter_template_id: null,
        notes: null,
        _is_default: true,
      });
      return;
    }
    res.json(row);
  } catch (err: any) {
    logger.error({ err: err?.message }, "workflow-settings GET /:scope failed");
    serverError(res, "Failed to load workflow settings");
  }
});

/**
 * Upsert by (firm_id, scope). PUT /api/workflow-settings  with { scope, …fields }
 */
router.put("/", requirePermission(Permission.WORKFLOW_SETTINGS_MANAGE), auditAction("update_workflow_settings"), async (req, res) => {
  const parsed = settingsSchema.safeParse(req.body);
  if (!parsed.success) {
    badRequest(res, "Invalid request body", parsed.error.flatten());
    return;
  }
  try {
    await ensureFirmIdColumn();
    const firmId = requireFirmId(req);
    const d = parsed.data;
    const [existing] = await db
      .select()
      .from(workflowSettingsTable)
      .where(and(eq(workflowSettingsTable.firm_id, firmId), eq(workflowSettingsTable.scope, d.scope)));
    type WorkflowSettingsInsert = typeof workflowSettingsTable.$inferInsert;
    type WorkflowSettingsUpdate = Partial<WorkflowSettingsInsert>;
    if (existing) {
      const updatePayload: WorkflowSettingsUpdate = {
        ...(d as WorkflowSettingsUpdate),
        firm_id: firmId,
        updated_by_user_id: req.user?.id ?? null,
        updated_at: new Date(),
      };
      const [row] = await db
        .update(workflowSettingsTable)
        .set(updatePayload)
        .where(eq(workflowSettingsTable.id, existing.id))
        .returning();
      res.json(row);
      return;
    }
    const insertPayload: WorkflowSettingsInsert = {
      ...(d as WorkflowSettingsInsert),
      firm_id: firmId,
      updated_by_user_id: req.user?.id ?? null,
    };
    const [row] = await db
      .insert(workflowSettingsTable)
      .values(insertPayload)
      .returning();
    res.status(201).json(row);
  } catch (err: any) {
    logger.error({ err: err?.message }, "workflow-settings PUT / failed");
    serverError(res, "Failed to upsert workflow settings");
  }
});

/**
 * Helper for the CRM: list active integrations grouped by category so the admin
 * UI can render dropdowns for each provider slot. Firm-scoped so an admin
 * from firm A can't enumerate firm B's vault rows (the previous version
 * returned every integration in the database).
 *
 * `adapter_implemented` is true when the provider has a working in-process
 * adapter (lib/<klass>/<provider>.ts).
 */
router.get("/_options/providers", requirePermission(Permission.WORKFLOW_SETTINGS_MANAGE), async (req, res) => {
  try {
    const firmId = requireFirmId(req);
    const all = await db
      .select()
      .from(integrationsTable)
      .where(and(eq(integrationsTable.status, "active"), eq(integrationsTable.firm_id, firmId)));
    const supportedEsign = new Set(listEsignProviders());
    const supportedFax = new Set(listFaxProviders());
    const supportedEmail = new Set(listEmailProviders());
    const supportedSms = new Set(listSmsProviders());
    const supportedVoice = new Set(listVoiceProviders());
    const supportedLlm = new Set(listLlmProviders());

    const map = (klass: string, supported: Set<string>) =>
      all
        .filter((r) => r.type === klass)
        .map((r) => ({
          id: r.id,
          name: r.name,
          provider: r.provider,
          adapter_implemented: supported.has(r.provider),
        }));

    res.json({
      esign: map("esign", supportedEsign),
      fax: map("fax", supportedFax),
      email: map("email", supportedEmail),
      sms: map("sms", supportedSms),
      // Preset rows for voice agents declare type="voice_ai" (not "voice"),
      // so the dropdown was previously empty after Round-2 mappings landed.
      voice: map("voice_ai", supportedVoice),
      llm: map("ai", supportedLlm),
    });
  } catch (err: any) {
    logger.error({ err: err?.message }, "workflow-settings /_options/providers failed");
    serverError(res, "Failed to load provider options");
  }
});

export default router;
