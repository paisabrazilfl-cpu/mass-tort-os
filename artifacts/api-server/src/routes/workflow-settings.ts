import { Router } from "express";
import { db, workflowSettingsTable, integrationsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { authMiddleware, Permission, requirePermission } from "../lib/rbac";
import { auditAction } from "../lib/rbac";
import { z } from "zod/v4";
import { listEsignProviders } from "../lib/esign";
import { listFaxProviders } from "../lib/fax";
import { listEmailProviders } from "../lib/email";
import { listSmsProviders } from "../lib/sms";
import { listVoiceProviders } from "../lib/voice";
import { listLlmProviders } from "../lib/ai";
import { badRequest } from "../lib/http-errors";

const router = Router();
router.use(authMiddleware);

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

router.get("/", requirePermission(Permission.WORKFLOW_SETTINGS_VIEW), async (_req, res) => {
  const rows = await db.select().from(workflowSettingsTable);
  res.json(rows);
});

router.get("/:scope", requirePermission(Permission.WORKFLOW_SETTINGS_VIEW), async (req, res) => {
  const scope = String(req.params.scope);
  const [row] = await db
    .select()
    .from(workflowSettingsTable)
    .where(eq(workflowSettingsTable.scope, scope));
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
});

/**
 * Upsert by scope. PUT /api/workflow-settings  with { scope: "global", ...fields }
 */
router.put("/", requirePermission(Permission.WORKFLOW_SETTINGS_MANAGE), auditAction("update_workflow_settings"), async (req, res) => {
  const parsed = settingsSchema.safeParse(req.body);
  if (!parsed.success) {
    badRequest(res, "Invalid request body", parsed.error.flatten());
    return;
  }
  const d = parsed.data;
  const [existing] = await db
    .select()
    .from(workflowSettingsTable)
    .where(eq(workflowSettingsTable.scope, d.scope));
  if (existing) {
    const [row] = await db
      .update(workflowSettingsTable)
      .set({ ...d, updated_by_user_id: req.user?.id ?? null, updated_at: new Date() } as any)
      .where(eq(workflowSettingsTable.id, existing.id))
      .returning();
    res.json(row);
    return;
  }
  const [row] = await db
    .insert(workflowSettingsTable)
    .values({ ...d, updated_by_user_id: req.user?.id ?? null } as any)
    .returning();
  res.status(201).json(row);
});

/**
 * Helper for the CRM: list active integrations grouped by category so the admin
 * UI can render dropdowns for each provider slot.
 *
 * `adapter_implemented` is true when the provider has a working in-process
 * adapter (lib/<klass>/<provider>.ts). For the LLM categories anthropic and
 * openai are env-managed via the Replit AI SDK and remain selectable even
 * without a vault row — they show up as a synthetic option per group.
 */
router.get("/_options/providers", requirePermission(Permission.WORKFLOW_SETTINGS_MANAGE), async (_req, res) => {
  const all = await db
    .select()
    .from(integrationsTable)
    .where(eq(integrationsTable.status, "active"));
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
});

export default router;
