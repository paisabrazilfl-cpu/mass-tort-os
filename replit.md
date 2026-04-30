# Overview

This project is a full-stack Mass Tort Operating System (MTOS), a distributed case processing CRM designed for mass tort law firms. It aims to streamline the entire legal process from lead intake and document management to case analysis, compliance, and distributed processing. Key capabilities include AI-driven medical document extraction, advanced validation, robust conflict resolution, a sophisticated form engine for compliant lead generation across numerous tort campaigns, and a comprehensive analytics suite. The core business vision is to provide a scalable, efficient, and compliant solution for managing complex mass tort litigation, significantly improving operational efficiency and compliance for law firms.

# User Preferences

I prefer clear and direct communication. I value a development process that emphasizes iterative development and early feedback. Please ask for my approval before implementing any major architectural changes or significant feature additions. I appreciate detailed explanations for complex technical decisions.

# System Architecture

The project is structured as a pnpm monorepo using TypeScript, targeting Node.js 24. The backend is an Express 5 API, integrated with a PostgreSQL database using Drizzle ORM. API codegen is handled by Orval from an OpenAPI specification. The UI/UX is built with React and Vite.

**Core Architectural Patterns & Design Decisions:**

*   **Monorepo Structure**: Facilitates shared code, consistent tooling, and simplified dependency management.
*   **Distributed Architecture**: Employs a PostgreSQL job queue for asynchronous task processing by a dedicated worker process, enabling scalable and fault-tolerant case analysis and document ingestion.
*   **Deterministic Logic First, AI Second**: Prioritizes deterministic logic (e.g., `if/then/else`, regex, rule-based branching) for tasks like field validation, scoring, routing, and conflict detection. AI is reserved for true natural-language tasks (extraction from unstructured medical PDFs, summarization, drafting).
*   **File Vault**: Secure storage for case-related documents with SHA-256 hashing for integrity verification.
*   **Conflict Resolution & Error Fallback**: Robust system for detecting conflicts, providing fail-safe modes, and implementing retry logic for system stability and data quality.
*   **Form Engine**: Comprehensive engine for TCPA and TrustedForm compliant lead generation, including a tort-based form builder, embeddable JS script, live validation, and a multi-step submission pipeline.
*   **Lead Intake Dedup**: Shared helper `findExistingLeadForIntake` for de-duplicating leads by email and phone per tort, updating existing records with strict fill-empty semantics to prevent tampering.
*   **MTOS Worker Build Isolation**: Separate build targets for API server and worker to prevent build conflicts.
*   **Workflow Settings UX**: Provides clear warnings when integrations are active but no default provider is selected, preventing job failures.
*   **News Pages HTML Stripping**: `stripHtml` helper applied to article descriptions before rendering and search filtering to prevent HTML injection.
*   **Background-Check Snapshot PII Sanitization**: `lead_background_check_snapshots.result.raw` payloads are masked at write time to redact sensitive PII while preserving audit and reproducibility data.
*   **Taxonomy Engine**: Matches NPI provider taxonomies with medical diagnoses to identify mismatches.
*   **NPI Verify**: Operator-facing verification against CMS NPI Registry, returning per-field confidence scores.
*   **Fraud Engine**: Flags potential fraud indicators.
*   **Compliance & Auditability**: Extensive logging of all actions and conflicts to an `audit_log` table, along with compliance-specific fields in lead records.
*   **Role-Based Access Control (RBAC)**: JWT (HS256) authentication with role hierarchy and granular route-level access control.
*   **Schema-vs-Database Workflow**: Uses `drizzle-kit push` for schema management.
*   **Dialog Accessibility Convention**: Enforces accessibility standards for dialogs using Radix UI.
*   **Web Auth Pipeline**: Manages user authentication, token refresh, and MFA.
*   **Security Infrastructure**: Comprehensive security layer protecting ePHI/PII data, including token revocation, refresh tokens, MFA/TOTP, field-level encryption, rate limiting, and AI threat analysis.
*   **API Server Bundle Size Budget**: Manages API server bundle size by externalizing heavy runtime dependencies.
*   **Auto-Document Workflow**: Automates dispatch of e-sign packets and medical record faxes based on lead qualification.
*   **Public Form Submission Surface**: A 10-step submission pipeline for public-facing forms with built-in validation and rate limiting.
*   **Web Forms**: Per-tort, public, JS-embeddable lead capture forms with admin configuration and responsive design.
*   **Background Check Hub**: A unified operator action that fans out across nine verification lanes, wrapping existing validators and providing honest status reporting (PASS/REVIEW_REQUIRED/FAIL/NOT_RUN).
*   **Outbound Lead Webhooks**: Dispatches `lead.created` events to configured automation integrations (n8n/Zapier/Make) with HMAC-SHA256 signing if an API key is provided.
*   **System-Wide Audit Hardening**: Implements structured error responses for Zod validation failures, improved skeleton loading for 404s, pre-flight checks for job queueing, and robust error handling for lead import.
*   **Integration Wiring Transparency**: Provides a single source of truth for integration wiring status (`live`, `live_no_vault`, `vault_only`) and informs operators about functional vs. vault-only integrations.

# MVI Launch (Task #51)

The MVI launch shipped six discrete pieces of work behind a single firm shell. Each note is intentionally short — the source of truth is the code in the listed files.

*   **T001 — Schema migration**: Added `firms`, `call_logs`, `lead_dispositions`, `sms_messages`; `users.firm_id` is `NOT NULL` with FK to `firms.id` (round-4 promotion); nullable `fax_results.lead_id` (no enforced FK — legacy rows may dangle); `leads.lookup_hash` for dedup perf. Schema pushed via `pnpm --filter @workspace/db run push`; drift gate green at 36 tables.
*   **T002 — Stripe billing**: `lib/payments/stripe.ts` resolves credentials from the integrations vault (`api_key` + `client_secret` for whsec). Routes `POST /api/billing/{checkout,portal}`, `GET /api/billing/{state,invoices}`, public `POST /api/webhooks/stripe` (verifies against rawBody). Subscription gate middleware blocks write methods when `subscription_status NOT IN ('active','trialing')` — `past_due` is intentionally NOT allowed (operator must come current via the customer portal before resuming writes); reads always pass. UI: `pages/billing.tsx` (typed via generated React Query hooks).
*   **T003 — Vapi voice intake**: `lib/voice/vapi.ts` accepts EITHER HMAC-SHA256 of raw body (`X-Vapi-Signature`) OR static bearer (`Authorization: Bearer …`). Public webhooks for call lifecycle + intake-result + escalate-human upsert `call_logs` / `lead_dispositions`. Tool callbacks (`lookupLead`, `createLead`, `checkEligibility`, `escalateToHuman`) are bearer-gated. `checkEligibility` delegates to the decision engine and returns the spec contract `{result: "go"|"hold"|"abort", reason, disqualifiers[]}` (ACCEPT→go, REVIEW/DEFER→hold, ABORT→abort). `createLead` writes encrypted PII via `encryptLeadFields()` then `rebindLeadEncryptionAad()` so AAD binds to the assigned lead.id (#8). `escalateToHuman` writes a `review_queue` row (`source_module="vapi"`) in addition to the disposition + `lead.status="review"` bump, so operators see a single queue entry. `routes/calls.ts` list/detail are firm-scoped via `getFirmIdForUser(req.user.id)`; cross-firm ids return 404 (no existence leak). UI: `pages/calls.tsx` (typed via generated hooks).
*   **T004 — Telnyx SMS**: `lib/sms/telnyx.ts` `sendSms(to, body, { firmId, leadId })`. Adapter loads credentials by `provider="telnyx"` (matches `integration-presets.ts`; the legacy `telnyx_sms` slug never existed in presets). Public webhook `POST /api/webhooks/telnyx/sms` verifies Telnyx Ed25519 signature and updates `sms_messages.status`. Lead-detail action button → `POST /api/leads/:id/send-sms`. Wired into `workflow-engine.ts` review-queue follow-up step.
*   **T005 — Six blockers (#7, #8, #15, #16, #20, #25)**: threat-analyzer thresholds tuned + internal-user allowlist (#7); every `encryptLeadFields()` call site now binds `entityId = lead.id` (#8); CSV import short-circuits via `leads.lookup_hash` instead of decrypt-loop (#15); `fax_results.lead_id` populated at insert and backfilled by `scripts/src/backfill-fax-results-lead-id.ts`, lookups now read OR(lead_id, LIKE source_file) (#16); dev-login shortcut gated behind `MTOS_DEV_LOGIN=1` with two spawn-based smoke tests using `__VERDICT__` markers (#20); `lib/lead-ownership-backfill.ts` mirrors the case version, no NOT NULL promotion, wired into `scripts/post-merge.sh` (#25).
*   **T006 — RBAC + OpenAPI + verify scripts + gates**: New `Permission.{BILLING_MANAGE, CALLS_VIEW, SMS_SEND}` plus role-matrix update. New billing/calls/SMS routes added to `lib/api-spec/openapi.yaml`; codegen regenerated and consumed by `pages/{billing,calls}.tsx` via the generated React Query hooks (no ad-hoc fetch). Operator scripts `artifacts/api-server/src/scripts/verify-{stripe,vapi}.ts` mirror the docusign pattern: take an integration row id, decrypt the vault, ping the live API. `verify-stripe.ts` deliberately exits non-zero when the webhook signing secret (`whsec_...`) is missing or malformed — without it `firms.subscription_status` would never advance and the subscription gate would block all writes. **Round-5 firm-context layer**: `AuthUser.firm_id` is required, `generateToken()` embeds it, `_authMiddleware` fail-closes on missing claim, and a new `firmContextMiddleware` (lib/firm-context.ts) loads `req.firm` immediately after auth — every fail-close path writes an `audit_log` row (`firm_context_no_user` / `firm_context_missing_claim` / `firm_context_not_found`). Calls list endpoint + UI gained inclusive `start_date`/`end_date` filters against `call_logs.started_at`. All four standing gates (typecheck, rbac-test 133/133, rbac-route-matrix, db-drift) green at sign-off.

# External Dependencies

*   **Database**: PostgreSQL
*   **ORM**: Drizzle ORM
*   **AI**: OpenAI (primary, via Replit AI Integrations proxy); Anthropic Claude (fallback provider)
*   **Image Processing**: Sharp
*   **Validation**: Zod
*   **API Codegen**: Orval
*   **Background Checks**: CourtListener, OFAC sanctions list
*   **NPI Lookup**: NPPES API (CMS NPI Registry)
*   **Security**: Helmet.js, express-rate-limit
*   **News Feeds**: Google News RSS, Yahoo Finance RSS, MarketWatch RSS, CNBC RSS
*   **E-Signature**: Dropbox Sign, DocuSign
*   **Fax**: Telnyx
*   **Email**: SendGrid