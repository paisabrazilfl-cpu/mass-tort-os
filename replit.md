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

The application is deployed on **Render** (not Railway or Replit autoscale).
- Production domain: **mtosvelocity.com**
- Deploy flow: push to GitHub `main` → Render auto-deploys. The blueprint lives at `.render/render.yaml` (`branch: main`, `autoDeploy: true`) and defines three resources: a Postgres database (`mtos-db`), the web service (`mtos-api`, health check `/api/healthz`), and the background worker (`mtos-worker`).
- Secrets marked `sync: false` in the blueprint (`SESSION_SECRET`, `ENCRYPTION_KEY_V1`, `ENCRYPTION_KEY_V2`) are NOT pushed from the repo — they must be set manually in the Render dashboard for both the web and worker services, or the app will fail to start / cannot decrypt ePHI.
- `VAPI_PUBLIC_KEY` (and optionally `VAPI_API_KEY`) must also be set in the Render web service env for the dialer's browser calling to work in production. These are the system-level Vapi fallback secrets (see Vault-Only Provider Adapters below); a value stored in the integration vault still takes precedence, env only fills a blank.
- When debugging production issues, check Render logs — not Replit or Railway logs.
- The `RENDER_API_KEY` secret is the Render account key (used for API-triggered deploys / service management). Auto-deploy on push does not require it.
- Railway is no longer the deployment target. The legacy Railway config files (`railway.json`, `mtos-crm.railway.json`, `scripts/railway-deploy.sh`) have been removed from the repo.

## Custom Domain (mtosvelocity.com)

The custom domain is attached to the Render web service `mtos-api` (id `srv-d8ea7h3bc2fs73ccsjvg`, default URL `https://mtos-api-2b4x.onrender.com`). Both `mtosvelocity.com` (apex) and `www.mtosvelocity.com` (subdomain, configured to redirect to the apex) are registered on Render and start as `unverified` until DNS is in place.

**DNS records the OWNER must set at the registrar** (registrar access is owner-only):
- Apex `mtosvelocity.com` → **A** record to `216.24.57.1` (Render's anycast IP). If the registrar supports ALIAS/ANAME at the apex, you may instead point it to `mtos-api-2b4x.onrender.com`.
- `www.mtosvelocity.com` → **CNAME** to `mtos-api-2b4x.onrender.com`.

After the records propagate, Render auto-verifies the domains and issues TLS certificates; `https://mtosvelocity.com` then serves the CRM. Verification status can be re-checked via `GET /v1/services/srv-d8ea7h3bc2fs73ccsjvg/custom-domains`.

Security: rotate the `RENDER_API_KEY` after go-live, since it was used during domain setup.

# Git Push / Branch Convention ⚠️ HARD RULE — NO EXCEPTIONS

**Every single push to GitHub MUST follow these rules exactly. No deviation. No shortcuts.**

1. **Always a new dedicated branch — NEVER push directly to `main`** — never force-push, never reset or rebase over `main`. Direct-to-main pushes violate this rule even via the Contents API.

2. **Branch name = methodical note, always `YYYY-MM-DD-what-changed`** — the date first, then a short slug describing what changed (e.g. `2026-06-04-workspace-hero-banners`, `2026-06-03-bg-check-ui-fix`). Never a bare date, never a random name, never an auto-generated string.

3. **The branch must be the full latest version of the CRM with zero loss of functionality** — merge latest main into the branch before pushing so it contains every prior feature plus the new work. No feature may be dropped or regressed.

4. **GitHub Contents API branch workflow** (since `git commit` is bash-blocked):
   - `GET /repos/{owner}/{repo}/git/ref/heads/main` → get current main tip SHA
   - `POST /repos/{owner}/{repo}/git/refs` → create new branch from that SHA
   - `PUT /repos/{owner}/{repo}/contents/{path}` with `"branch": "<new-branch>"` for each file
   - `POST /repos/{owner}/{repo}/merges` → merge branch into main server-side
   - Use `$GITHUB_TOKEN` env var (the embedded token in the git remote URL expired 2026-06-04)

5. **After the GitHub push, trigger Render deploys** — both `mtos-api` (srv-d8ea7h3bc2fs73ccsjvg) and `mtos-worker` (srv-d8ea7hh9rddc73eltfvg) via `POST https://api.render.com/v1/services/{id}/deploys`. HTTP 200 with empty body = success.

Reinforced by owner on 2026-06-04. Originally set 2026-05-31. Standing permanent instruction — no exceptions.

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
*   **Background Check Hub**: A unified operator action that fans out across nine verification lanes, wrapping existing validators and providing honest status reporting. Surfaced both as a card on each lead's detail page (`BackgroundCheckHubCard`) and as a dedicated top-level page at `/background-check` (sidebar "Leads & Intake" → "Background Check") where an operator searches/selects any lead (optional `?leadId=` deep link) and runs the same hub. The lead-scoped endpoints in `routes/forms.ts` (`/background-check/lead/:id`, `/background-check-hub/lead/:id`, `.../snapshots`) are gated by `FORMS_BACKGROUND_CHECK` **and** an ownership check (`canBypassOwnership` else `created_by_user_id`/`assigned_to`), mirroring `leads.ts` `ensureLeadAccess`, so own-scope roles cannot run or read a check against a lead they cannot see.
*   **Outbound Lead Webhooks**: Dispatches `lead.created` events to configured automation integrations with HMAC-SHA256 signing.
*   **System-Wide Audit Hardening**: Implements structured error responses for Zod validation failures, improved skeleton loading for 404s, pre-flight checks for job queueing, and robust error handling for lead import.
*   **Vault-Only Provider Adapters**: 27 messaging/AI providers (5 voice, 6 SMS, 6 email, 5 fax, 11 LLM) implemented as `lib/{voice,sms,email,fax,ai}/<provider>.ts` adapters that read credentials from the integrations vault via `getIntegrationCredentialsById`. Each category has a lazy registry index (`lib/<cat>/index.ts`) — registries build on first lookup to break the cycle `lib/<cat>/index → lib/integration-wiring → routes/integrations`. Vapi webhook signature/bearer helpers are split into `lib/voice/vapi-webhook.ts` to keep the VoiceAdapter free of routes/integrations imports. Generic per-category webhook receivers live at `/webhooks/{email,fax,sms,voice}/:provider`. Per-category verify scripts (`scripts/verify-{llm,sms,voice,email,fax}.ts`) are gated by `TEST_<X>=1`. Workflow Settings UI exposes a ProviderPicker per category (6 pickers) backed by `GET/PUT /api/workflow-settings`. Anthropic env-key adapter is the hard fallback whenever a chosen LLM provider returns a non-retryable error.
*   **AI Constitution**: Single canonical document at `docs/AI_CONSTITUTION.md` that governs every helper LLM in the system (the `/api/automations/assist` planner, future copilots, and any in-process AI helper). Covers identity (mass-tort plaintiff CRM, HIPAA-adjacent / TCPA-regulated), the prime directive (humans only do final review), house rules (deterministic-first, never invent a clean result, audit everything, firm-tenancy, PII minimization, idempotency), the system map, the toolbox (events, node catalog, 10 bg-hub lanes, 27+ vault providers, decision/conflict/fraud engines, RBAC), the automation decision tree (internal engine vs n8n vs direct API), discovery endpoints, the failure-protocol ladder (re-read → discover → propose graph → review queue), bright lines (qualification, e-sign, PACER purchase, TCPA changes, HIPAA release, settlement, mass ops), and the amendment process. Loaded by `lib/ai-constitution.ts` (`getAiConstitution()` returns markdown+sha+version; `getAiConstitutionPreamble()` returns a ~600-char summary), served at `GET /api/admin/ai-constitution` (perm `automations:view`; `?format=markdown` for raw text), and auto-injected at the top of the `/api/automations/assist` system prompt so the assistant always reasons under it.
*   **Recursive Error-Fallback Loop (planning surfaces)**: Generic primitive `lib/automations/recursive-retry.ts` (`recursiveRetry({attempt, maxAttempts, maxTotalMs})`) wrapping any AI-driven planner so a bad first response triggers up to 3 retries, each with a perspective-shift cue (~20% angle change per attempt — gentle reframe → simplify → minimum viable → literal) plus the previous error fed back. Three independent loop-safety backstops, ANY of which terminates: hard attempt cap (clamped to ABSOLUTE_MAX_ATTEMPTS=6 regardless of caller), wall-clock budget (default 30s, no floor), and no-progress circuit breaker (sha256-of-message + errorCode signature; bails when two consecutive attempts produce identical failures). Every attempt is logged with duration + outcome and surfaced in the response under `retry.attempts[]` (both on success-after-retry and on final failure) so the operator sees what was tried. Wired today into `POST /api/automations/assist`, which converts its 4 failure modes (`llm_unavailable`, `assist_invalid_json`, `assist_bad_shape`, `assist_catalog_violation`) into structured `AttemptOutcome`s instead of bailing immediately. Runtime workflow node retries are explicitly OUT OF SCOPE (they touch real side effects and need an idempotency story first); failures there fall through to the review queue per Constitution §8.
*   **Intake Identity Gate (HIPAA)**: The standalone public intake pages (`/intake/:slug`, served by `routes/public-sites.ts`) can require "Sign in with Google" before the PHI-collecting intake form is shown or accepted. The gate is **feature-flagged by the `GOOGLE_OAUTH_CLIENT_ID` env var** — OFF when unset (existing intake works unchanged), ON when set (auto-activates everywhere). `lib/intake-identity.ts` verifies the Google ID token server-side via `google-auth-library` (`OAuth2Client.verifyIdToken`, checks signature/audience/issuer/expiry; no client secret needed). When enabled, the intake SSR page renders a Google Identity Services card and hides the form (`#mtos-form-wrap`) until sign-in; a **same-origin** helper served at `GET /api/web-forms/intake-gate.js` (must be — PUBLIC_CSP `script-src` has no `'unsafe-inline'`) stashes the signed credential and reveals the form. The web-forms embed forwards it as `google_id_token`. Enforcement is server-side in `runWebFormPipeline` STEP 0: gate ON + missing/invalid token ⇒ `403 identity_required` before any validation or persistence; the verified email/sub are written to `audit_log` (`web_form_identity_verified`) and the raw token is discarded. Enforcement is **global** across all `/api/web-forms/:tortId/submit` (deliberate — a per-page "gate was shown" flag would be trivially bypassable by a direct POST). Activation: owner creates a Google OAuth 2.0 **Web** client, adds the dev preview origin and `https://mtosvelocity.com` as Authorized JavaScript origins, then sets `GOOGLE_OAUTH_CLIENT_ID` in the dev env AND the Render web service.
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