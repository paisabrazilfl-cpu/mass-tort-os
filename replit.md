# Overview

This project is a full-stack Mass Tort Operating System (MTOS), a distributed case processing CRM designed for mass tort law firms. It aims to streamline the entire legal process from lead intake and document management to case analysis, compliance, and distributed processing. Key capabilities include AI-driven medical document extraction, advanced validation, robust conflict resolution, a sophisticated form engine for compliant lead generation across numerous tort campaigns, and a comprehensive analytics suite. The core business vision is to provide a scalable, efficient, and compliant solution for managing complex mass tort litigation, significantly improving operational efficiency and compliance for law firms.

# User Preferences

I prefer clear and direct communication. I value a development process that emphasizes iterative development and early feedback. Please ask for my approval before implementing any major architectural changes or significant feature additions. I appreciate detailed explanations for complex technical decisions.

# Owner Account

The platform owner and operator is **paisabrazilfl@gmail.com**, role `super_admin`.

**What super_admin means in this system:**

The super_admin login is the owner-level account. It sits above every other role in the system. When this account logs in, it sees the entire platform — every firm, every lead, every case, every audit log, every admin panel, and every system configuration screen. No other role can see this much. A regular admin only sees their own firm. A super_admin sees everything across all firms simultaneously.

The hierarchy from top to bottom is: super_admin → admin → attorney → paralegal → viewer. The super_admin can do anything any lower role can do, plus things no other role can access at all.

**Boss Omega Dark Room:**

The Boss Omega Dark Room is a hidden section of the CRM that only appears when logged in as the super_admin account (paisabrazilfl@gmail.com). It is not visible to any other role — not admin, not attorney, not anyone else. It does not appear in the navigation for any other login. It is the owner's private control panel, locked exclusively behind the super_admin credential.

**Account lockout note:**

If the super_admin account ever gets locked out from too many failed login attempts, the lockout must be cleared directly in the database. This is a known recovery step, not a bug.

# Deployment

The application is deployed on **Railway** (not Render or Replit autoscale).
- Production domain: **masstortvelocity.com**
- When debugging production issues, check Railway logs — not Replit deployment logs.
- The `RENDER_API_KEY` secret is a legacy credential and is no longer the active deployment target.

# System Architecture

The project is structured as a pnpm monorepo using TypeScript, targeting Node.js 24. The backend is an Express 5 API, integrated with a PostgreSQL database using Drizzle ORM. API codegen is handled by Orval from an OpenAPI specification. The UI/UX is built with React and Vite.

**Core Architectural Patterns & Design Decisions:**

*   **Monorepo Structure**: Facilitates shared code, consistent tooling, and simplified dependency management.
*   **Distributed Architecture**: Employs a PostgreSQL job queue for asynchronous task processing by a dedicated worker process, enabling scalable and fault-tolerant case analysis and document ingestion.
*   **Deterministic Logic First, AI Second**: Prioritizes deterministic logic for tasks like field validation, scoring, routing, and conflict detection. AI is reserved for natural-language tasks (extraction, summarization, drafting).
*   **File Vault**: Secure storage for case-related documents with SHA-256 hashing for integrity verification.
*   **Conflict Resolution & Error Fallback**: Robust system for detecting conflicts, providing fail-safe modes, and implementing retry logic.
*   **Form Engine**: Comprehensive engine for TCPA and TrustedForm compliant lead generation, including a tort-based form builder, embeddable JS script, live validation, and a multi-step submission pipeline.
*   **Lead Intake Dedup**: Uses `findExistingLeadForIntake` for de-duplicating leads by email and phone per tort, updating existing records with strict fill-empty semantics.
*   **Compliance & Auditability**: Extensive logging of all actions and conflicts to an `audit_log` table, along with compliance-specific fields in lead records.
*   **Role-Based Access Control (RBAC)**: JWT (HS256) authentication with role hierarchy and granular route-level access control.
*   **Schema-vs-Database Workflow**: Uses `drizzle-kit push` for schema management.
*   **Web Auth Pipeline**: Manages user authentication, token refresh, MFA, and email verification, with new accounts requiring email verification before sign-in.
*   **Security Infrastructure**: Comprehensive security layer protecting ePHI/PII data, including token revocation, refresh tokens, MFA/TOTP, field-level encryption, rate limiting, and AI threat analysis.
*   **Auto-Document Workflow**: Automates dispatch of e-sign packets and medical record faxes based on lead qualification.
*   **Background Check Hub**: A unified operator action that fans out across nine verification lanes, wrapping existing validators and providing honest status reporting.
*   **Outbound Lead Webhooks**: Dispatches `lead.created` events to configured automation integrations with HMAC-SHA256 signing.
*   **System-Wide Audit Hardening**: Implements structured error responses for Zod validation failures, improved skeleton loading for 404s, pre-flight checks for job queueing, and robust error handling for lead import.
*   **Vault-Only Provider Adapters**: 27 messaging/AI providers (5 voice, 6 SMS, 6 email, 5 fax, 11 LLM) implemented as `lib/{voice,sms,email,fax,ai}/<provider>.ts` adapters that read credentials from the integrations vault via `getIntegrationCredentialsById`. Each category has a lazy registry index (`lib/<cat>/index.ts`) — registries build on first lookup to break the cycle `lib/<cat>/index → lib/integration-wiring → routes/integrations`. Vapi webhook signature/bearer helpers are split into `lib/voice/vapi-webhook.ts` to keep the VoiceAdapter free of routes/integrations imports. Generic per-category webhook receivers live at `/webhooks/{email,fax,sms,voice}/:provider`. Per-category verify scripts (`scripts/verify-{llm,sms,voice,email,fax}.ts`) are gated by `TEST_<X>=1`. Workflow Settings UI exposes a ProviderPicker per category (6 pickers) backed by `GET/PUT /api/workflow-settings`. Anthropic env-key adapter is the hard fallback whenever a chosen LLM provider returns a non-retryable error.
*   **AI Constitution**: Single canonical document at `docs/AI_CONSTITUTION.md` that governs every helper LLM in the system (the `/api/automations/assist` planner, future copilots, and any in-process AI helper). Covers identity (mass-tort plaintiff CRM, HIPAA-adjacent / TCPA-regulated), the prime directive (humans only do final review), house rules (deterministic-first, never invent a clean result, audit everything, firm-tenancy, PII minimization, idempotency), the system map, the toolbox (events, node catalog, 10 bg-hub lanes, 27+ vault providers, decision/conflict/fraud engines, RBAC), the automation decision tree (internal engine vs n8n vs direct API), discovery endpoints, the failure-protocol ladder (re-read → discover → propose graph → review queue), bright lines (qualification, e-sign, PACER purchase, TCPA changes, HIPAA release, settlement, mass ops), and the amendment process. Loaded by `lib/ai-constitution.ts` (`getAiConstitution()` returns markdown+sha+version; `getAiConstitutionPreamble()` returns a ~600-char summary), served at `GET /api/admin/ai-constitution` (perm `automations:view`; `?format=markdown` for raw text), and auto-injected at the top of the `/api/automations/assist` system prompt so the assistant always reasons under it.
*   **Recursive Error-Fallback Loop (planning surfaces)**: Generic primitive `lib/automations/recursive-retry.ts` (`recursiveRetry({attempt, maxAttempts, maxTotalMs})`) wrapping any AI-driven planner so a bad first response triggers up to 3 retries, each with a perspective-shift cue (~20% angle change per attempt — gentle reframe → simplify → minimum viable → literal) plus the previous error fed back. Three independent loop-safety backstops, ANY of which terminates: hard attempt cap (clamped to ABSOLUTE_MAX_ATTEMPTS=6 regardless of caller), wall-clock budget (default 30s, no floor), and no-progress circuit breaker (sha256-of-message + errorCode signature; bails when two consecutive attempts produce identical failures). Every attempt is logged with duration + outcome and surfaced in the response under `retry.attempts[]` (both on success-after-retry and on final failure) so the operator sees what was tried. Wired today into `POST /api/automations/assist`, which converts its 4 failure modes (`llm_unavailable`, `assist_invalid_json`, `assist_bad_shape`, `assist_catalog_violation`) into structured `AttemptOutcome`s instead of bailing immediately. Runtime workflow node retries are explicitly OUT OF SCOPE (they touch real side effects and need an idempotency story first); failures there fall through to the review queue per Constitution §8.
*   **Automation Workflows (n8n-style)**: Internal drag-and-drop workflow engine (React Flow editor at `/automations`). 37-node catalog across triggers/logic/data/CRM/integrations/AI/scripts (JS via vm; Python/Bash/PowerShell via spawn)/IO/utility. Graph executor (`lib/automations/executor.ts`) walks edges with branch handling via `sourceHandle`, MAX_STEPS=200, and validates emitted `__branch` against the catalog's declared `outputs`. Node handlers wired to real services: SendGrid email, Telnyx SMS / SrFax (with SSRF guard), e-sign job dispatch, AI extract/summarize/draft/classify (callLLM), Vault read/write, paralegal round-robin assignment, lead status updates, review queue, background-check hub, NPI lookup, decision engine, document templates, OCR, and form publish/embed/validate/lead-from-submission with intake-dedup. Persists to `automation_workflows` + `automation_runs`. RBAC perms `automations:view|manage|execute`. Routes mounted at `/api/automations` (CRUD + node-catalog + run + run history + `POST /assist`). AI Assistant drawer in editor calls `/assist`, which prompts an LLM with a compact catalog summary (including branch outputs) and validates the returned graph against `NODE_CATALOG` (422 on unknown node types or invalid `sourceHandle`). Supports JSON import/export.

# External Dependencies

*   **Database**: PostgreSQL
*   **ORM**: Drizzle ORM
*   **AI**: OpenAI, Anthropic Claude
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