# MTOS Smoke Report

**Probes:** 60 · **PASS:** 60 · **FAIL:** 0 · **SKIP:** 0

## :white_check_mark: Passes by section

### ai-resiliency v2
- ✅ CircuitBreaker module exists with expected exports — lib/ai/circuit-breaker.ts: CircuitBreaker class + get/allow/recordSuccess/recordFailure
- ✅ ErrorClassifier module exists with four categories — lib/ai/error-classifier.ts: all 4 ErrorClass values + ProviderUnavailableError + PolicyViolationError
- ✅ Observer module exists with emitAiStateTransition + PII redactor — lib/ai/observer.ts: emitAiStateTransition + PII redactor (SSN/phone/email/date) + 100ms collapse
- ✅ Phase 2 wiring: resilient-retry wrapper exists and is gated by AI_RESILIENCY_V2 env flag — resilient-retry.ts wires the v2 layer; routes/automations.ts opts in via isResiliencyV2Enabled() === (AI_RESILIENCY_V2 === "1"); flag absent → byte-identical to Phase 1

### manual citations
- ✅ rbac.ts:51 actually contains UserRole union — rbac.ts:51 = "export type UserRole = "super_admin" | "admin" | "attorney" | "paralegal" | "vie"
- ✅ encryption.ts:27 contains CURRENT_KEY_VERSION = 1 — encryption.ts:27 = "const CURRENT_KEY_VERSION = 1;"
- ✅ hub.ts:31-43 has every ADAPTERS entry — hub.ts ADAPTERS block has exactly 11 lane entries

### security
- ✅ CI poller has cycle-in-flight mutex — ci-poller.ts has cycleInFlight mutex to prevent overlapping ticks
- ✅ Vapi tools log every failed bearer attempt with IP — vapi-tools.ts logs IP + reason for every rejected bearer
- ✅ Backfill SQL files exist for cases / integrations / webhook-events — All 3 operator-runnable backfill SQL scripts present
- ✅ Automation crm.* handlers firm-scope every lead touch — executor.ts: qualify_lead / assign_paralegal / background_check / decision_engine all firm-scoped
- ✅ forms.create_lead_from_submission stamps firm_id — forms.create_lead_from_submission stamps firm_id from run context

### §11.3
- ✅ Decision Engine writes convexity_action on the lead row — decision-engine-service.ts writes convexity_score/action/rationale/etc

### §11.4
- ✅ Praxis Predictive is documented as heuristic, not ML — predictive-scoring.ts honestly admits it's a weighted-feature heuristic

### §11.7
- ✅ Background Check Hub has 11 lane adapters — hub.ts ADAPTERS list has all 11 lanes
- ✅ bg-hub exposes final_status_live_lanes_only on result — types.ts BackgroundHubResult has final_status_live_lanes_only
- ✅ bg-hub lane results expose manual_action_urls — types.ts BackgroundLaneResult has manual_action_urls
- ✅ STUB_LANES is reduced to four (business_entity demoted) — escalation.ts STUB_LANES has exactly 4 lanes; business_entity demoted to live
- ✅ SEC EDGAR adapter exists and exports searchEdgar — sec-edgar.ts wired to https://www.sec.gov/files/company_tickers.json
- ✅ Treasury OFAC SDN adapter exists — ofac-treasury.ts wired to treasury.gov SDN CSV
- ✅ Garbo adapter scaffold exists with credential lookup — garbo.ts has credential lookup + 3 marked OPERATOR-CONFIRM blocks for the API contract
- ✅ Phone provenance via Telnyx Lookup — phone-provenance.ts wired to Telnyx /v2/number_lookup
- ✅ Email enrichment has curated disposable-domain list — email-enrichment.ts curated disposable list present
- ✅ Smart-links module emits prefilled URLs for 4 lanes — smart-links.ts has 10 state-bar deep-links + state SoS deep-links
- ✅ Tort-policy categorization covers Roblox + Camp Lejeune + Zantac — tort-policy.ts maps Roblox / Camp Lejeune / Zantac to the right categories
- ✅ Tort-policy skips business_entity + attorney for child_safety — tort-policy.ts: child_safety category skips attorney + business_entity lanes

### §12.4
- ✅ integrationsTable schema has firm_id — schema/integrations.ts has firm_id integer column + index
- ✅ Integration CRUD routes use integrationFirmScope predicate — integrations.ts uses integrationFirmScope at 8 call sites
- ✅ Integration sync returns 501 for unsupported providers — integrations.ts /:id/sync returns HTTP 501 + syncable_providers list
- ✅ Garbo preset is registered in integration-presets.ts — integration-presets.ts has Garbo entry under Background Check
- ✅ integration-wiring.ts lists garbo with status:live — integration-wiring.ts garbo is registered as live

### §13.11
- ✅ webhook-idempotency helper exists and is wired into webhook handlers — webhook-idempotency.ts exports markWebhookProcessed; webhooks.ts uses it

### §13.12
- ✅ Per-firm webhook URL variants wired — webhooks.ts accepts both /provider and /provider/i/:integrationId for email/sms/fax/voice

### §13.3
- ✅ Automation node catalog ↔ handler parity — 74 catalog nodes ↔ 74 handlers; perfect parity

### §13.7
- ✅ 42 schema modules in lib/db/src/schema/ — lib/db/src/schema has 42 .ts modules (matches §13.7 claim)
- ✅ processed_webhook_events schema exists — schema/processed_webhook_events.ts has the documented idempotency table

### §13.9
- ✅ Lead status enum values are referenced somewhere in the codebase — Lead status enum: all 5 documented values referenced in code

### §2.1
- ✅ UserRole defines five roles — rbac.ts UserRole union contains all 5 roles
- ✅ ROLE_HIERARCHY assigns numeric weights — rbac.ts ROLE_HIERARCHY has all 5 weights

### §2.5
- ✅ Access token TTL is 15 minutes — rbac.ts ACCESS_TOKEN_EXPIRY = '15m'
- ✅ Refresh token TTL is 7 days — rbac.ts REFRESH_TOKEN_EXPIRY_MS = 7*24*60*60*1000

### §3.1-3.6
- ✅ Permission enum has every documented bucket — Permission enum has 20 expected entries

### §3.7
- ✅ ROLE_PERMISSIONS map super_admin → every permission — super_admin: new Set<Permission>(Object.values(Permission))

### §5.1
- ✅ firm-scope helper exists with requireFirmId + leadFirmScope — lib/firm-scope.ts exports requireFirmId + leadFirmScope + MissingFirmContextError

### §5.4
- ✅ Encryption pinned to V1 in CURRENT_KEY_VERSION — encryption.ts CURRENT_KEY_VERSION = 1
- ✅ AES-256-GCM with field+entity AAD — encryption.ts uses aes-256-gcm + buildAAD(field, entityId)

### §5.6
- ✅ AI Constitution loader exists — lib/ai-constitution.ts + docs/AI_CONSTITUTION.md both present

### §7.1
- ✅ GET /api/leads route is mounted under leadsRouter — routes/index.ts mounts leads at /api/leads; GET / handler present
- ✅ Lead routes are firm-scoped (post-7baf80e) — leads.ts uses leadFirmScope(req) at 14 call sites
- ✅ GET /api/leads/export hard cap = 50_000 — leads.ts EXPORT_HARD_CAP = 50_000

### §7.2
- ✅ POST /api/leads stamps firm_id on insert — leads.ts POST stamps firm_id from JWT

### §7.5
- ✅ GET /api/cases is firm-scoped via casesTable.firm_id — cases.ts list + detail filter by casesTable.firm_id
- ✅ casesTable schema has firm_id column — schema/cases.ts has firm_id integer column + index

### §9.1
- ✅ Automations webhook (public) is mounted before authMiddleware — routes/index.ts mounts automationsWebhookRouter before authMiddleware (verified by source ordering)
- ✅ Automations webhook uses rawBody HMAC (not JSON.stringify) — automations-webhook.ts uses req.rawBody buffer for HMAC (comments mentioning the old bug are ignored)
- ✅ app.ts attaches rawBody for both webhook surfaces — app.ts express.json verify hook captures rawBody for both prefixes

### §9.4
- ✅ Workflow runs persist to automation_runs table — schema/automations.ts defines automation_runs + automation_workflows

### §9.7
- ✅ Self-Heal returns 503 when JULES_API_KEY missing — admin-self-heal.ts returns 503 + code:jules_not_configured when key absent
- ✅ Self-Heal list is firm-scoped via Drizzle (no SQL concat) — admin-self-heal.ts uses Drizzle + requireFirmId; no 1=1 fallback

### §9.8
- ✅ Competitive Intel watchlist is firm-scoped — admin-competitive-intel.ts filters watchlist by firm_id
