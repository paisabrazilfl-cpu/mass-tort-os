# MTOS Smoke Report

**Probes:** 62 · **PASS:** 39 · **FAIL:** 23 · **SKIP:** 0

## :x: Failures (23)
- **§7.1 — Lead routes are firm-scoped (post-7baf80e)**
  - Reason: `leadFirmScope import not found`
- **§7.2 — POST /api/leads stamps firm_id on insert**
  - Reason: `firm_id: requireFirmId(req) not found`
- **§7.5 — GET /api/cases is firm-scoped via casesTable.firm_id**
  - Reason: `case firm filter not found`
- **§7.5 — casesTable schema has firm_id column**
  - Reason: `firm_id column not found`
- **§9.1 — Automations webhook (public) is mounted before authMiddleware**
  - Reason: `automationsWebhookRouter not imported`
- **§9.7 — Self-Heal list is firm-scoped via Drizzle (no SQL concat)**
  - Reason: `requireFirmId not found`
- **§11.7 — Background Check Hub has 11 lane adapters**
  - Reason: `phone_provenance adapter entry not found`
- **§11.7 — bg-hub exposes final_status_live_lanes_only on result**
  - Reason: `live-lanes field not found`
- **§11.7 — bg-hub lane results expose manual_action_urls**
  - Reason: `smart-link field not found`
- **§11.7 — STUB_LANES is reduced to four (business_entity demoted)**
  - Reason: `business_entity still in STUB_LANES; SEC EDGAR adapter should have removed it`
- **§12.4 — Integration CRUD routes use integrationFirmScope predicate**
  - Reason: `scope predicate not found`
- **§12.4 — Integration sync returns 501 for unsupported providers**
  - Reason: `501 status not found`
- **§12.4 — Garbo preset is registered in integration-presets.ts**
  - Reason: `garbo preset not found`
- **§12.4 — integration-wiring.ts lists garbo with status:live**
  - Reason: `garbo: status:live not found`
- **§13.7 — 43 schema modules in lib/db/src/schema/**
  - Reason: `expected 43 schema files, found 48`
- **§13.11 — webhook-idempotency helper exists and is wired into webhook handlers**
  - Reason: `called from webhooks.ts not found`
- **§13.12 — Per-firm webhook URL variants wired**
  - Reason: `per-firm URL pattern not found`
- **security — Vapi tools log every failed bearer attempt with IP**
  - Reason: `clientIpOf helper not found`
- **security — Backfill SQL files exist for cases / integrations / webhook-events**
  - Reason: `scripts/backfill-cases-firm-id.sql missing`
- **security — Automation crm.* handlers firm-scope every lead touch**
  - Reason: `crm.qualify_lead handler missing s.ctx.firmId guard`
- **security — forms.create_lead_from_submission stamps firm_id**
  - Reason: `firm_id stamp missing`
- **manual citations — hub.ts:31-43 has every ADAPTERS entry**
  - Reason: `ADAPTERS list has 10 entries, expected 11`
- **ai-resiliency v2 — Phase 2 wiring: resilient-retry wrapper exists and is gated by AI_RESILIENCY_V2 env flag**
  - Reason: `flag check imported into the route not found`

## :white_check_mark: Passes by section

### ai-resiliency v2
- ✅ CircuitBreaker module exists with expected exports — lib/ai/circuit-breaker.ts: CircuitBreaker class + get/allow/recordSuccess/recordFailure
- ✅ ErrorClassifier module exists with four categories — lib/ai/error-classifier.ts: all 4 ErrorClass values + ProviderUnavailableError + PolicyViolationError
- ✅ Observer module exists with emitAiStateTransition + PII redactor — lib/ai/observer.ts: emitAiStateTransition + PII redactor (SSN/phone/email/date) + 100ms collapse

### manual citations
- ✅ rbac.ts:51 actually contains UserRole union — rbac.ts:51 = "export type UserRole = "super_admin" | "admin" | "user_manager" | "attorney" | ""
- ✅ encryption.ts:27 contains CURRENT_KEY_VERSION = 1 — encryption.ts:27 = "const CURRENT_KEY_VERSION = 1;"

### security
- ✅ CI poller has cycle-in-flight mutex — ci-poller.ts has cycleInFlight mutex to prevent overlapping ticks

### §11.3
- ✅ Decision Engine writes convexity_action on the lead row — decision-engine-service.ts writes convexity_score/action/rationale/etc

### §11.4
- ✅ Praxis Predictive is documented as heuristic, not ML — predictive-scoring.ts honestly admits it's a weighted-feature heuristic

### §11.7
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

### §13.3
- ✅ Automation node catalog ↔ handler parity — 76 catalog nodes ↔ 76 handlers; perfect parity

### §13.7
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
- ✅ GET /api/leads/export hard cap = 50_000 — leads.ts EXPORT_HARD_CAP = 50_000

### §9.1
- ✅ Automations webhook uses rawBody HMAC (not JSON.stringify) — automations-webhook.ts uses req.rawBody buffer for HMAC (comments mentioning the old bug are ignored)
- ✅ app.ts attaches rawBody for both webhook surfaces — app.ts express.json verify hook captures rawBody for both prefixes

### §9.4
- ✅ Workflow runs persist to automation_runs table — schema/automations.ts defines automation_runs + automation_workflows

### §9.7
- ✅ Self-Heal returns 503 when JULES_API_KEY missing — admin-self-heal.ts returns 503 + code:jules_not_configured when key absent
- ✅ Codebase-wide: no SQL `1=1` literal or `firm_id="+` concat in any route/lib — no `1=1` or `firm_id="+'` concat in any route/lib file
- ✅ Codebase-wide: no `res.json([])` inside catch blocks — no silent `res.json([])` in catch blocks across routes/

### §9.8
- ✅ Competitive Intel watchlist is firm-scoped — admin-competitive-intel.ts filters watchlist by firm_id
