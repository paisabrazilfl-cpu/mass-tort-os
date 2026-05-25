# Mass Tort OS — Technical White Paper

**Audience:** law-firm partners, IT leads, and operations directors evaluating a CRM for mass-tort claimant intake and case management.

**Goal:** explain what the system is, how it is built, what it does, and — equally — what it does not yet do. Every architectural claim in this document is backed by a file path you can open in the repository and verify against the smoke-test harness shipped alongside it.

---

## 1. Executive summary

Mass Tort OS (MTOS) is a multi-tenant CRM and intake-automation platform purpose-built for mass-tort and personal-injury practices. It handles the workflow from public lead capture through qualification, document automation, signed retainer, and case hand-off — with the compliance disclosures, audit trail, and fraud signals a plaintiff's firm requires when screening hundreds of leads per day.

The product targets the specific operational stack mass-tort firms actually run:

- **Lead acquisition** through vendor webhooks, embeddable web forms, CSV imports, Vapi voice agents, and direct API.
- **Qualification gates** that combine deterministic conflict-checking (Boolean Gatekeeper rules) with explainable lead-quality scoring (Praxis).
- **Document automation** that fires e-sign packets and medical-records fax requests on qualified-status transition, with provider-agnostic adapters for SendGrid / Postmark / Mailgun / AWS SES, SRFax / eFax / Phaxio / Documo / Telnyx Fax, and DocuSign / Dropbox Sign.
- **Live background screening** across address, email, phone, criminal court, OFAC sanctions, PACER federal courts, and SEC EDGAR — plus one-click prefilled smart-links for the four lookups that cannot be lawfully or technically automated (NSOPW, federal BOP, state bar, state property records).
- **Multi-tenant isolation** enforced at the database predicate level via a single canonical helper, audited by both static smoke tests and the catalog↔handler parity test.

Recent reinforcement focused on three things buyers will probe in a demo: (a) cross-tenant data isolation, (b) honesty about what the system can vs cannot automate, and (c) end-to-end evidence — a 56-probe smoke harness that gates every claim in this document against the actual source code.

---

## 2. The problem space

A mass-tort firm running a TV or Meta campaign for, say, the hair-relaxer or Camp Lejeune dockets receives hundreds of inbound calls and form submissions per day. Roughly:

- **20–40%** are duplicates already on file or already attached to a competing firm.
- **5–15%** are professional plaintiffs with prior claim histories.
- **10–25%** are outside the qualifying medical, exposure, or jurisdictional window.
- A non-trivial **3–8%** carry adverse public-records signals (sex-offender registry, active criminal docket, sanctions hit, bankruptcy in flight that the trustee will claim from).

Every minute a paralegal spends manually working a lead that will ultimately fail qualification is a minute they are not working a lead that will retain. The cost-per-signed-retainer (CPSR) economics of mass-tort make the difference between "process this in 3 minutes" and "process this in 30 minutes" the difference between break-even and a 4× return on ad spend.

MTOS is built around that economic reality. Every adapter, gate, and audit hook in the system is designed to reduce time-to-decision on a lead without sacrificing accuracy or compliance posture.

---

## 3. Architecture

MTOS is a pnpm monorepo. The relevant packages:

```
artifacts/
  api-server/     — Express 5 + Drizzle ORM, esbuild-bundled; serves API and worker.
  mtos-crm/       — React 19 + Vite SPA, served by api-server in production.
  mockup-sandbox/ — Design exploration; not deployed.
  n8n/            — Optional self-hosted automation runner.

lib/
  db/                  — Drizzle schema (42 tables); single source of truth.
  api-spec/            — OpenAPI YAML; generates the typed client.
  api-zod/             — Zod schemas + TS types generated from the OpenAPI.
  api-client-react/    — Tanstack Query hooks generated from the OpenAPI.
  integrations/        — Vault-shared adapter packages.
```

The API server runs as two entrypoints from the same codebase: a `server` (HTTP) and a `worker` (background-job queue consumer). Both share the encrypted credential vault and the audit log.

The data store is **PostgreSQL 16**. 42 schema modules under `lib/db/src/schema/` define the table set; the canonical list is documented at §13.7 of the in-product manual.

### 3.1 Multi-tenant model

MTOS is built as a **single-firm shell that scales to multi-firm SaaS** without rearchitecture. Every business table carries a `firm_id` column. Every authenticated request carries a `firm_id` claim in its JWT, stamped by the auth middleware (`lib/rbac.ts`) and validated by the firm-context middleware (`lib/firm-context.ts`) before any route handler executes.

The contract is enforced by a single helper:

```ts
// artifacts/api-server/src/lib/firm-scope.ts
export function requireFirmId(req: Request): number {
  const firmId = req.user?.firm_id;
  if (typeof firmId !== "number") throw new MissingFirmContextError();
  return firmId;
}

export function leadFirmScope(req: Request) {
  return eq(leadsTable.firm_id, requireFirmId(req));
}
```

Every read, mutation, and aggregate query against `leadsTable`, `casesTable`, `integrationsTable`, `competitive_intel_*`, `self_heal_sessions`, etc. **ANDs this predicate into the WHERE clause**. A `grep` for `leadFirmScope(req)` in `routes/leads.ts` returns four-plus call sites; `integrationFirmScope(req)` in `routes/integrations.ts` returns five-plus. The smoke test (`pnpm smoke`) probes these counts and fails CI if they regress.

Cross-firm reads return **404 Not Found**, not 403, so the existence of a row in another firm cannot be inferred by status code.

For inbound provider webhooks — which arrive with no firm context — the system supports two URL shapes per channel:

```
POST /api/webhooks/sms/telnyx                    (single-firm-shell convenience)
POST /api/webhooks/sms/telnyx/i/:integrationId   (per-firm disambiguation)
```

When the explicit integration id is present, `loadProviderForWebhook` reads that row directly and refuses to route if the row's provider does not match the URL segment — eliminating cross-firm signature-verification ambiguity in deployments with more than one firm active for the same provider.

### 3.2 Encryption at rest

Personally identifiable claimant data (SSN, DOB, diagnosis, medications, address, phone, notes, etc.) is encrypted column-level with **AES-256-GCM**. The encryption key is versioned: `CURRENT_KEY_VERSION = 1` today; rotation to V2 is a runtime constant change plus a re-encryption script.

Additional Authenticated Data (AAD) is `fieldName:entityId` for lead PII columns, so a ciphertext extracted from one row cannot be pasted into another row and decrypt successfully — AES-GCM's auth tag verification rejects the swap.

Vault credentials (integration API keys) follow the same scheme with the integration row id as the AAD scope.

Decryption is version-aware: every ciphertext carries an `enc:v<N>:<hasAAD>:<payload>` header, and the decryptor walks an AAD-fallback chain (strict field+entity → field-only → none) for backwards compatibility with rows encrypted before the rebind step landed. Failures log `[DECRYPTION_ERROR]` rather than throwing.

### 3.3 RBAC

Five roles (`super_admin`, `admin`, `attorney`, `paralegal`, `viewer`) with numeric hierarchy weights and a fine-grained permission enum. `requireRole(...)` middleware enforces hierarchy ("at least attorney"); `requirePermission(...)` enforces individual capabilities ("can export leads").

`ROLE_PERMISSIONS` maps each role to its default permission set; super_admin receives `Object.values(Permission)` plus the ability to bypass the per-firm scope check — explicitly so a platform operator can support multi-tenant customers.

The viewer role triggers per-row ownership filtering on the leads and cases tables: a viewer sees only leads they created or are assigned to. Paralegal and above see the full firm intake queue.

### 3.4 Audit log

Every state-changing action writes a row to `audit_log` via `auditLog(entity_type, entity_id, action, details, { ip_address, user_agent })`. The action vocabulary is documented exhaustively at §13.10 of the in-product manual and includes lead lifecycle events (created / qualified / rejected / disqualified), case events (intake_submitted / file_upload_queued / analysis_queued), user events (role_changed / force_logout), integration events (created / updated / sync_ran / sync_unsupported), and competitive-intel lookups.

Audit writes are fire-and-forget so an audit-DB hiccup never escalates a 200 to a 500; the write path catches and logs any failure.

---

## 4. Lead intake and qualification

A lead enters MTOS through one of five channels:

| Channel | Mount | Auth |
|---|---|---|
| **Operator intake form** | `POST /api/leads` | Authenticated; firm-scoped on insert |
| **Public web form** | `POST /api/web-forms/:tortId/submit` | Public; TrustedForm + TCPA-consent capture; enqueued to the worker for validation + dedup before insert |
| **CSV import** | `POST /api/lead-import/preview` then `/execute` | Authenticated; preview returns row-level errors; execute is idempotent on the `lookup_hash` |
| **Vapi voice tool callback** | `POST /api/vapi-tools/create-lead` | Static-bearer (constant-time compared); every bearer mismatch logs the caller IP for audit |
| **Webhook trigger from n8n / Zapier / Make** | `POST /api/automations/webhook/:slug` | Public; HMAC-SHA256 over the raw request bytes (not the JSON-restringified body) |

Every intake path runs the same downstream pipeline:

1. **Conflict check** (`runFullConflictCheck`) — verifies the claimant is not already represented for this tort by another firm (per the cross-firm exclusion list) and is not on the firm's internal block list.
2. **Encryption** — all PII fields encrypted with the lead's `id` rebound as AAD on insert (Task #8 contract).
3. **Lookup hash** — SHA-256 over the normalized `(tort_type | email | phone10)` triple, indexed so subsequent dedup is a single index lookup, not a decrypt-loop scan.
4. **Decision Engine score** — `computeAndPersistLeadScore` writes `convexity_score`, `convexity_action`, `convexity_rationale`, and the `convexity_ruin_flags` array to the row asynchronously; never blocks the intake response.
5. **Outbound webhook dispatch** — every active automation integration (n8n / Zapier / Make / custom) receives a signed `lead.created` event payload.

### 4.1 Boolean Gatekeeper qualification

`POST /api/leads/:id/qualify` runs three deterministic gates:

- `diagnosis_confirmed`
- `was_at_location`
- `tort_type` is present and non-empty

All three must pass for the lead to transition from `new` → `qualified`. The transition fires `enqueueLeadApprovalPackets(leadId)` which kicks the document automation chain (see §6).

The gates are intentionally deterministic. The AI / heuristic / machine-learned signals (Praxis predictive scoring, see §5.2) are advisory inputs to the operator's decision, not gates on the workflow itself. The AI Constitution (`docs/AI_CONSTITUTION.md`) lists the bright lines: the AI never unilaterally qualifies a lead, sends an e-sign packet, purchases PACER documents, modifies TCPA consent text, or transmits a HIPAA release.

---

## 5. The Decision Engine and Praxis Predictive

Two related but distinct scoring surfaces.

### 5.1 Decision Engine — convexity scoring

`lib/decision-engine-service.ts` runs a hand-crafted rule-based scorer over the lead's medical, exposure, and source signals, producing five outputs persisted to the row:

- `convexity_score`: `convex` / `neutral` / `concave` — qualitative label.
- `convexity_action`: `execute` / `modify` / `reject` / `review` — recommended next step.
- `convexity_rationale`: free text explaining the action.
- `convexity_ruin_flags`: array of disqualifying signals (e.g. `exposure_outside_window`, `diagnosis_unrelated_to_tort`).
- `convexity_missing_fields`: array of fields the engine needs to complete the score.

The same `result` object that produces the action also produces the rationale. The lead-detail UI reads these columns directly. There is no possibility for the displayed "why" to diverge from the actual decision — the verification is captured by a unit test and one of the smoke probes.

### 5.2 Praxis — predictive scoring

`/api/analytics/predictive/*` returns three numbers per lead:

- `conversion_probability` (0–100)
- `risk_score` (0–100)
- `quality_tier` ∈ {`platinum`, `gold`, `silver`, `bronze`, `unqualified`}

Plus a factor-list breakdown (positive and negative impacts) so the score is explainable, not a black box.

**Honesty note carried in the source itself** (`lib/predictive-scoring.ts`):

> `total_training_samples` was a misnomer — no actual ML training happens. This is a hand-tuned weighted-feature scorer with backtest accuracy reporting. The frontend label was changed to "Leads Scored."

This document does not market Praxis as a trained ML model. It is a transparent weighted-feature heuristic with a backtest-accuracy honest signal computed against the firm's historical signed-vs-rejected outcomes. Buyers who want true ML on lead conversion are encouraged to layer their own model on the same input feature set; the heuristic ships as the default.

---

## 6. Document automation

The `qualified` state transition fires `enqueueLeadApprovalPackets(leadId)` (`lib/workflow-engine.ts`). The workflow produces and dispatches:

1. **HIPAA release + retainer agreement** to the claimant via e-sign (DocuSign or Dropbox Sign, depending on `workflow_settings.esign_provider_integration_id`).
2. **Medical records request** to the treating physician's office via fax (SRFax / eFax / Phaxio / Documo / Telnyx Fax, depending on `workflow_settings.fax_provider_integration_id`).
3. **Outbound notification email** to the operator's chosen address (SendGrid / Postmark / Mailgun / Resend / AWS SES / Brevo).

Each provider category resolves through `lib/provider-router.ts`, which checks (in priority order) buyer-level overrides → workflow-settings global → environment-variable default. Adapters live in `lib/{esign,fax,email,voice,sms}/index.ts` registries. Adding a new provider requires writing one adapter file conforming to the registry's interface and registering it in the registry's `getRegistry()` builder — no other code changes.

The visual workflow editor (Automations page) exposes the same send-email and send-fax operations as drag-and-drop nodes that respect the firm's chosen provider via the same router — fixed in the recent reinforcement pass after an audit discovered the editor was previously hardcoded to SendGrid and SRFax regardless of operator configuration.

Provider callbacks (envelope signed / fax delivered / SMS delivery report) flow through `routes/webhooks.ts`. Every callback:

- Verifies signature against the matched integration's webhook secret using the raw request bytes captured by Express's `verify` hook before JSON parsing.
- Records the event in the appropriate per-channel events table (`email_events`, `fax_events`, `sms_messages`, `document_envelopes.events[]`).
- Stamps the resolved `firm_id` and `integration_id` for cross-firm-safe filtering.
- Dedups against `processed_webhook_events` (unique on `provider, external_event_id`) so a provider retry does not double-fire downstream automations.

---

## 7. The Background Check Hub

Eleven verification lanes, each producing one of four statuses: `PASS`, `REVIEW_REQUIRED`, `FAIL`, `NOT_RUN`. The hub exposes two aggregate verdicts on every result so the UI can distinguish "all automated checks cleared" from "every lane, including manual-lookup lanes, cleared":

- `final_status` — strict aggregate over every lane, including the four advisory stub lanes that always require human eyes. This is the gate for hard decisions.
- `final_status_live_lanes_only` — restricted to lanes with a live data adapter. When this is `PASS`, the operator can honestly tell counsel "the system actually screened and found nothing."

Each lane also carries optional `manual_action_urls`: prefilled public-records search URLs the operator clicks to run the lookup their browser session, not the server, executes. These are the smart-link buttons that turn five-tabs-of-typing into five clicks.

| # | Lane | State | Source |
|---|---|---|---|
| 1 | `address` | **live** | Internal validator + USPS-style normalization |
| 2 | `email` | **live** | MX + format + 40-domain curated disposable-domain list + role-based local-part detection |
| 3 | `phone` | **live** | Phone-format validation |
| 4 | `phone_provenance` | **live** when Telnyx configured | Telnyx Number Lookup — line type, carrier, portability, derived burner-risk verdict |
| 5 | `residency` | smart-link | County property-records portal deep-link (FL / TX / CA prefilled; other states fall through to a search-engine bang) |
| 6 | `criminal_court` | **live** | CourtListener REST v4 + free Treasury OFAC SDN screening |
| 7 | `incarceration` | smart-link | Federal BOP inmate locator + VINELink state DOC search, both prefilled |
| 8 | `sex_offender_nsopw` | **hybrid** | Live FCRA-compliant screen via Garbo when configured; otherwise prefilled NSOPW smart-link |
| 9 | `attorney` | smart-link | State bar lookup — ten states deep-linked (CA, NY, TX, FL, IL, PA, OH, GA, NC, WA), others fall through to a search-engine bang |
| 10 | `business_entity` | **live** | SEC EDGAR `company_tickers.json` against ~10,000 SEC-registered entities; small-LLC fallback via state SoS smart-link |
| 11 | `pacer_federal` | **live** when PACER credentials configured | PACER PCL Search API (per-page billing) |

The four lanes pinned to `REVIEW_REQUIRED` regardless of adapter output — `residency`, `incarceration`, `sex_offender_nsopw` (when Garbo absent), `attorney` — are explicitly listed in `lib/bg-hub/escalation.ts:STUB_LANES`. The UI labels them honestly with the source ("manual property-records lookup", "BOP + VINELink smart-links", etc.) so a buyer cannot mistake an amber REVIEW badge for "the system tried and found nothing."

### 7.1 Tort-aware lane gating

Not every tort needs every lane. `lib/bg-hub/tort-policy.ts` categorizes torts by slug and decides which lanes run.

| Category | Examples | Lanes skipped or downgraded |
|---|---|---|
| `medical_injury` | Camp Lejeune, Roundup, talc, hair relaxer, PFAS, hernia mesh | none — every lane runs |
| `pharmaceutical_injury` | Zantac, Tylenol-autism, Ozempic, NEC baby formula | none — every lane runs |
| `child_safety` | Roblox, Discord, Snap, Meta, Instagram, Character.ai, TikTok | `business_entity` + `attorney` skipped; `incarceration` / `pacer_federal` / `residency` advisory |
| `consumer_fraud` | Class-action false-advertising | `incarceration`, `sex_offender_nsopw`, `attorney` skipped |
| `data_breach` | T-Mobile, Equifax, BIPA | every medical-style lane skipped |
| `securities` | 10b-5 class actions | identity-style lanes skipped; `business_entity` + `attorney` are the point |
| `premises_liability` | slip-and-fall, building defect | `attorney` skipped; criminal_court + residency + pacer core |
| `unknown` | unrecognized slug | run everything (safe default) |

`runBackgroundCheckHub(lead, { tortSlug })` is the public signature. Skipped lanes are **omitted** from the response entirely; advisory lanes run but their REVIEW/FAIL results are downgraded to NOT_RUN so they're informational only and never gate intake. The smoke harness asserts the categorization for Roblox, Camp Lejeune, and Zantac, and asserts that `child_safety` skips business + attorney.

---

## 8. Integration architecture

`routes/integrations.ts` exposes a firm-scoped CRUD surface backed by the `integrations` table. Every CRUD verb ANDs `firm_id = requireFirmId(req)` into the WHERE clause. Credentials are encrypted column-level with AAD scoped to the integration row id, so the same plaintext key encrypted under two different row ids produces two different ciphertexts and cannot be cross-decrypted.

Integration **categories** advertised in the vault: `ai_llm`, `esignature`, `voice_ai`, `sms`, `email`, `fax`, `ocr`, `identity`, `payments`, `background_check`, `web_search`, `court_records`.

The **preset table** (`lib/integration-presets.ts`) lists ~60 provider presets with category, score, recommended flag, pricing model, and documentation URL. Each preset declares the credential fields the UI should collect (`api_key`, `client_id`, `client_secret`, etc.).

The **wiring registry** (`lib/integration-wiring.ts`) is the source of truth for whether a provider has live adapter code. A boot-time consistency check fails the process if the wiring registry references a provider that has no preset, or if a preset's required fields are missing from the wiring entry. This catches drift between marketing and implementation at the deploy boundary.

The **sync handler registry** (`lib/integration-sync.ts`) is consulted by `POST /api/integrations/:id/sync`. Providers without a registered handler return HTTP **501 Not Implemented** plus `syncable_providers: [...]` so the UI can hide or disable the Sync button rather than displaying one that does nothing. Fasten is the only provider with a registered live sync today (medical records); event-driven providers (Stripe, Telnyx, Vapi, DocuSign, Dropbox Sign) honestly do not support pull-style sync.

### 8.1 Premium screening via Garbo

When the operator pastes a Garbo (https://garbo.io) API key into Settings → Integrations, the `sex_offender_nsopw` lane switches from smart-link manual workflow to a live FCRA-compliant screen. Garbo aggregates the sex-offender registry data NSOPW prohibits scraping, plus arrest and violence-related public records, into a single API call.

`lib/bg-hub/garbo.ts` ships a complete adapter scaffold: firm-scoped credential lookup, Bearer auth, timeout handling, fail-open error envelope, response normalization to the hub's flag vocabulary. Three lines marked `OPERATOR-CONFIRM` carry the exact endpoint path / request body / response field-name mapping; those are filled in from Garbo's developer docs after the operator obtains an API key. The smoke harness probes that the scaffold exists and the credential lookup wires through the encrypted vault.

---

## 9. AI surfaces

Three layers, in priority order from "AI-as-product" to "AI-as-utility":

1. **AI Constitution** (`docs/AI_CONSTITUTION.md`) — a single canonical document loaded by `lib/ai-constitution.ts` and prepended to every LLM call's system prompt. Defines the bright lines: actions the AI will never take unattended (final qualification decision, e-sign send, PACER purchase, TCPA modification, HIPAA release transmission).

2. **AI Provider Router** (`lib/ai-provider.ts`) — abstracts over Anthropic, OpenAI, Google Gemini, OpenRouter, Groq, DeepSeek, Perplexity, Mistral, Cohere, xAI, Fireworks. Modules name their use case (`ai-extract`, `ai-fields`, `ai-ocr`, `drafting-ai`, `threat-analyzer`, `lead-intelligence`, `automations-assist`) and the router picks a provider per the firm's workflow settings, with the live-no-vault Anthropic Replit AI SDK as the fallback. Adapter selection is invariant across providers — change a setting, switch providers, no code change.

3. **AI as workflow nodes** — the Automations editor exposes `ai.extract_fields`, `ai.summarize`, `ai.draft` as drag-and-drop nodes, plus AI-Assist that builds the workflow graph itself from a natural-language prompt. AI-Assist runs through a recursive retry harness (`lib/automations/recursive-retry.ts`) that re-attempts with perspective-shift cues, a sha256-based circuit breaker to detect identical failures, and hard caps on attempts and wall-clock budget.

What AI does NOT do in MTOS:

- It is not the qualification decision-maker — that is the deterministic Boolean Gatekeeper in `routes/leads.ts`.
- It is not a trained ML model — the Praxis Predictive surface is a hand-tuned weighted-feature heuristic, transparently documented.
- It is not auto-released — every drafted document goes through Doc Review before any send.

---

## 10. Compliance and security posture

### 10.1 Encryption — column-level AES-256-GCM with versioned AAD; documented at §5.4 of the in-product manual; rotation procedure shipped in `scripts/rotate-encryption-key.ts`.

### 10.2 RBAC — five roles, hierarchy weights, fine-grained permission enum, per-row ownership filtering for viewer role. Validated by a boot-time `validateRouteTable` walk that throws if any non-public route is missing an auth middleware or permission gate.

### 10.3 Audit log — every state-changing action persists an immutable row with `(entity_type, entity_id, action, details, occurred_at, ip_address, user_agent)`. Read-only from the application layer.

### 10.4 TCPA — `tcpa_consent` boolean + TrustedForm certificate URL + ping URL + cert token + IP + user agent + timestamp captured at form-submit time. Public web-form submissions cannot proceed without explicit consent capture.

### 10.5 PHI / HIPAA — claimant medical fields (`diagnosis`, `diagnosis_date`, `medications`, `physician_*`) are encrypted at rest with AAD bound to the row id. The decision to send a HIPAA release is operator-initiated (Bright Lines policy); the AI never auto-sends. **Customers handling protected health information are reminded that they must execute Business Associate Agreements (BAAs) with every downstream provider that touches PHI** — Anthropic, OpenAI, Telnyx, Fasten, DocuSign, etc. MTOS does not paper those agreements for you.

### 10.6 FCRA — claimant background screening via Garbo is the FCRA-compliant path. Consumer people-search APIs (BeenVerified, Spokeo, Whitepages class) are deliberately not integrated because they disclaim Consumer Reporting Agency status and using their data for claimant qualification is FCRA-illegal regardless of permissible-purpose stance.

### 10.7 Multi-tenant isolation — `requireFirmId(req)` is the single canonical helper. Every business-table query AND-restricts on it. Cross-firm IDOR returns 404, not 403. The smoke harness probes that every CRUD verb in `routes/leads.ts`, `routes/cases.ts`, `routes/integrations.ts`, `routes/admin-self-heal.ts`, `routes/admin-competitive-intel.ts`, and `routes/analytics.ts` uses the helper.

### 10.8 Webhook idempotency — every inbound provider callback is deduped against `processed_webhook_events` (unique on `provider, external_event_id`) so a provider retry does not double-fire downstream automations. The helper fails OPEN: a DB blip never silently drops a legitimate webhook.

### 10.9 Per-firm webhook URLs — `/api/webhooks/{email,sms,fax,voice}/:provider/i/:integrationId` disambiguates the multi-firm cross-firm signature ambiguity that arises when two firms have the same provider active.

### 10.10 Session tokens — JWTs with `tv` (token_version) claim. Force-logout bumps `mtos_users.token_version`, invalidating every outstanding token for that user in one DB write.

---

## 11. Recent reinforcement (audit-driven)

This document is written after a multi-commit hardening pass focused on production-readiness. Highlights:

- **Cross-tenant data isolation** closed across leads, cases, analytics, integrations, admin-self-heal, admin-competitive-intel, and the four automation handlers that touch `leadsTable`. `firm_id` column added to `casesTable` and `integrationsTable` with idempotent backfill SQL in `scripts/`.
- **SQL injection vector** in `admin-self-heal.ts` (a `1=1` fallback combined with string-concatenated firm_id) replaced with parameterized Drizzle and a strict `requireFirmId` contract.
- **Public webhook surface** for n8n / Zapier / Make rescued from a non-functional state: the handler lived behind `authMiddleware` so external providers could never reach it, AND it computed HMAC over `JSON.stringify(req.body)` (key-reordering, whitespace-dropping) so every signature mismatched. Now mounted at the public layer; HMAC computed over the raw request bytes captured by Express's `verify` hook.
- **Automation editor send-email / send-fax nodes** unbundled from their hardcoded SendGrid / SRFax dependencies; both now route through `resolveProvider(category)` to honor each firm's chosen integration.
- **OFAC sanctions screening** moved from a paid third-party (`search.ofac-api.com`) to free Treasury SDN list ingestion with 24h cache, fail-open on refresh.
- **Background Check Hub** restructured: SEC EDGAR live business-entity adapter; smart-link infrastructure for four lanes that can't be lawfully or technically scraped; tort-policy module so Roblox doesn't waste a check on physician verification it can't run; Garbo integration scaffold; new `final_status_live_lanes_only` UI signal.
- **Smoke harness** (`scripts/smoke.ts`) — 56 probes, all PASS, that gate every architectural claim in this document against the actual source file. Run `pnpm --filter @workspace/api-server smoke` to reproduce. The receipts are committed at `smoke-report.{md,json}`.

The git history on `claude/debug-codebase-s75LX` documents the pass in commits `7baf80e` (firm-scoping core) → `e323d85` (manual reconcile) → `9810296` (integrations + automation scoping) → `e1da6a3` (multi-provider + sync registry + bg-hub honesty) → `3b0e8d3` (Treasury OFAC + live-lanes status) → `91e6c39` (SEC EDGAR + smart-links + state deep-links) → `1b0abea` (Garbo + phone-provenance + tort-policy) → `7b919bb` (manual reconcile) → `7db6743` (smoke harness).

---

## 12. What is not in the box

Honesty section. Buyers who probe for these in a demo will find them missing; the system surfaces each gap honestly to the operator.

- **Residency / incarceration / state-bar full automation across all 50 states.** Smart-link manual workflows ship; full automation requires paid integrations (Smarty + Lob NCOA for residency, VINELink partner API for incarceration, Martindale-Hubbell or per-state bar APIs for attorney). The smart-link infrastructure is built so adding each is a ~100-line patch when credentials arrive.
- **NSOPW automated lookup without Garbo.** NSOPW's terms of use prohibit automated queries. The lane emits a prefilled smart-link the operator clicks. Garbo subscription removes the manual step lawfully.
- **NCOA / address-history bureau-tier lookup.** Smarty or LexisNexis Risk integrations are wireable; not shipped.
- **Sterling / Checkr / Accurate enterprise background-check wiring.** Listed as integration presets but no live adapter code; vault-only today.
- **OpenCorporates / SAM.gov full business-entity coverage.** SEC EDGAR covers ~10K SEC-registered entities; small unregistered LLCs surface a state SoS smart-link.
- **DB-level end-to-end test suite.** Unit tests + smoke probes are 90+ deep with zero DB dependency; full DB-backed integration tests require a real PostgreSQL — operator-run in staging.
- **SOC 2 attestation.** Not paper-trailed; the security controls (encryption, audit, RBAC, multi-tenancy, webhook idempotency, MFA, force-logout, rate-limit) are in place to support a SOC 2 Type I path, but the audit itself is operator-procured.

---

## 13. Verification

This document ships alongside an executable verification suite. From the repository root:

```
pnpm typecheck                              # all 4 workspaces compile
pnpm --filter @workspace/api-server test    # unit tests + parity tests
pnpm --filter @workspace/api-server smoke   # 56-probe code-claims sanity
```

The smoke harness produces both `smoke-report.md` (human) and `smoke-report.json` (machine). A failing probe blocks CI. Adding a new claim to this document should be accompanied by adding a probe — drift between marketing and implementation is the single failure mode this project is most aggressive about preventing.

For end-to-end live-deployment verification, the operator runs:

```
MTOS_BASE_URL=https://api.your-firm.com \
MTOS_ADMIN_EMAIL=admin@your-firm.com \
MTOS_ADMIN_PASSWORD=… \
pnpm --filter @workspace/api-server smoke:http
```

The HTTP smoke is GET-only and safe to point at production. It walks 35+ documented endpoints and records HTTP status + envelope shape per route.

---

## 14. Roadmap

Capabilities under design or scoped for the next quarter, in declining priority:

1. **Production-tier audit log retention + read API** (operator-facing audit dashboard).
2. **Per-state SoS automation pilot** (CA, DE, NY, TX, FL, IL) replacing the smart-link layer with API calls where the state exposes one.
3. **OpenCorporates integration** for small-LLC business entity coverage.
4. **VINElink partner API integration** for live state-DOC incarceration screening.
5. **MDL filing-window automation** — claimant exposure-date / diagnosis-date validation against active MDL filing windows pulled live from court dockets.
6. **Per-firm webhook URL onboarding wizard** — the existing `/i/:integrationId` URL pattern works; the UI affordance to display per-firm URLs to operators during integration setup is the gap.
7. **SOC 2 Type I evidence collection.**
8. **Encryption key rotation drill** — exercise the rotation path on a non-production environment so the runbook is real, not theoretical.

---

## 15. Contact

Engineering decisions, architectural questions, security disclosures: operators are routed through the in-product `/api/admin/self-heal` channel (when configured against Jules) or via the audit log's `support_request` action.

Document authored against branch `claude/debug-codebase-s75LX`, commit `7db6743`. Verifiable by `pnpm --filter @workspace/api-server smoke`.
