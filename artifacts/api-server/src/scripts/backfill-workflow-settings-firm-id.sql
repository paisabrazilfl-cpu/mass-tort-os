-- Backfill legacy workflow_settings rows that have NULL firm_id. Before
-- this migration the table was a singleton: one row per scope, shared
-- across every firm, exposing operational config (which esign / fax / LLM
-- provider, default-from address) across tenants via the /api/workflow-
-- settings endpoints.
--
-- The strict-scope routes refuse to return NULL-firm_id rows. This
-- script fans the singleton out: for every existing firm, INSERT a copy
-- of each legacy row stamped with that firm's id. The legacy rows are
-- then deleted so no NULL-firm_id row remains.
--
-- Idempotent: safe to re-run. The (firm_id, scope) UNIQUE constraint
-- prevents duplicate fan-out rows, and the final cleanup is a no-op if
-- no NULL-firm_id rows exist.

BEGIN;

-- 1. Fan out: for every (firm, legacy_settings_row) pair, INSERT a
--    firm-scoped copy. ON CONFLICT (firm_id, scope) DO NOTHING means a
--    firm that has already customized its settings keeps its own row.
INSERT INTO workflow_settings (
  firm_id, scope,
  esign_provider_integration_id, fax_provider_integration_id, email_provider_integration_id,
  sms_provider_integration_id, voice_provider_integration_id,
  llm_default_provider_integration_id, llm_drafting_provider_integration_id,
  default_email_from_name, default_email_from_address, default_fax_from_number,
  auto_send_on_approval, auto_fax_doctor_on_signed_hipaa,
  esign_resend_after_days, esign_expire_after_days, max_send_retries,
  notify_on_failure_email, med_records_cover_letter_template_id,
  metadata, notes, updated_by_user_id, created_at, updated_at
)
SELECT
  f.id, ws.scope,
  ws.esign_provider_integration_id, ws.fax_provider_integration_id, ws.email_provider_integration_id,
  ws.sms_provider_integration_id, ws.voice_provider_integration_id,
  ws.llm_default_provider_integration_id, ws.llm_drafting_provider_integration_id,
  ws.default_email_from_name, ws.default_email_from_address, ws.default_fax_from_number,
  ws.auto_send_on_approval, ws.auto_fax_doctor_on_signed_hipaa,
  ws.esign_resend_after_days, ws.esign_expire_after_days, ws.max_send_retries,
  ws.notify_on_failure_email, ws.med_records_cover_letter_template_id,
  COALESCE(ws.metadata, '{}'::jsonb), ws.notes, ws.updated_by_user_id, NOW(), NOW()
FROM workflow_settings ws
CROSS JOIN firms f
WHERE ws.firm_id IS NULL
ON CONFLICT (firm_id, scope) DO NOTHING;

-- 2. Delete the legacy NULL-firm rows now that every firm has its own copy.
DELETE FROM workflow_settings WHERE firm_id IS NULL;

COMMIT;

-- Verify: should return 0 after a successful backfill on a healthy DB.
-- SELECT COUNT(*) FROM workflow_settings WHERE firm_id IS NULL;
