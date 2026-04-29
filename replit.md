# Overview

This project is a full-stack Mass Tort Operating System (MTOS), a distributed case processing CRM designed for mass tort law firms. It streamlines the entire legal process from lead intake and document management to case analysis, compliance, and distributed processing. The system incorporates AI for medical document extraction, advanced validation engines, and robust conflict resolution. It features a sophisticated form engine for compliant lead generation across numerous tort campaigns and a comprehensive analytics suite. The core business vision is to provide a scalable, efficient, and compliant solution to manage complex mass tort litigation, significantly improving operational efficiency and compliance for law firms.

# User Preferences

I prefer clear and direct communication. I value a development process that emphasizes iterative development and early feedback. Please ask for my approval before implementing any major architectural changes or significant feature additions. I appreciate detailed explanations for complex technical decisions.

# System Architecture

The project is structured as a pnpm monorepo using TypeScript, targeting Node.js 24. The backend is an Express 5 API, integrated with a PostgreSQL database using Drizzle ORM. API codegen is handled by Orval from an OpenAPI specification. The UI/UX is built with React and Vite.

**Core Architectural Patterns & Design Decisions:**

*   **Monorepo Structure**: Facilitates shared code, consistent tooling, and simplified dependency management.
*   **Distributed Architecture**: Employs a PostgreSQL job queue for asynchronous task processing by a dedicated worker process, enabling scalable and fault-tolerant case analysis and document ingestion.
*   **Deterministic Scoring Engine**: A rule-based scoring system provides transparent and auditable case qualification.
*   **File Vault**: Secure storage for case-related documents with SHA-256 hashing for integrity verification.
*   **AI Integration**: Utilizes Anthropic Claude for medical document extraction and OCR.
*   **Conflict Resolution & Error Fallback**: A robust system detects conflicts, provides fail-safe modes, and an error fallback mechanism with retry logic, ensuring system stability and data quality.
*   **Form Engine**: A comprehensive engine for TCPA and TrustedForm compliant lead generation, featuring a tort-based form builder, embeddable JS script, live validation, background checks, and a 10-step submission pipeline.
*   **Taxonomy Engine**: Matches NPI provider taxonomies with medical diagnoses to identify potential mismatches.
*   **NPI Verify (operator-facing rich verification)**: `POST /api/npi/verify` (perm `npi:lookup`) confirms whether a claimed provider profile matches the CMS NPI Registry, returning per-field confidence scores instead of just dumping the first registry hit. Two strategies: (a) if an NPI is supplied, do a direct lookup; (b) otherwise search by name + city + state and pick the best fuzzy candidate. Implemented in `lib/npi-verify.ts` with shared helpers in `lib/string-similarity.ts` (Levenshtein → 0..1 ratio, also reused by the email validator). Decision thresholds: identity ≥ 0.7, city ≥ 0.8, state exact-or-≥0.9, plus taxonomy match. Surfaced in the CRM under the **Verify Match** tab on the NPI Lookup page with a side-by-side per-field comparison and explicit Verified / Could Not Verify states. Distinct from the public-form `/api/forms/npi-verify` taxonomy-only check.
*   **Fraud Engine**: Flags potential fraud indicators.
*   **Compliance & Auditability**: Extensive logging of all actions and conflicts to an `audit_log` table, along with compliance-specific fields in lead records.
*   **Role-Based Access Control (RBAC)**: JWT (HS256) authentication with role hierarchy and granular route-level access control.
*   **Schema-vs-Database Workflow (Drizzle, push-based)**: Uses `drizzle-kit push` for schema management, ensuring the database aligns with the TypeScript schema definitions.
*   **Dialog Accessibility Convention (Radix UI)**: Enforces accessibility standards for dialogs to ensure compatibility with screen readers.
*   **Web Auth Pipeline (CRM)**: Manages user authentication, token refresh, and MFA.
*   **Security Infrastructure**: Comprehensive security layer protecting ePHI/PII data, including token revocation, refresh tokens, MFA/TOTP, field-level encryption, rate limiting, and AI threat analysis.
*   **API Server Bundle Size Budget**: Manages API server bundle size by externalizing heavy runtime dependencies.
*   **Auto-Document Workflow**: Automates dispatch of e-sign packets and medical record faxes based on lead qualification.

**Key Features & Implementations:**

*   **Dashboards**: Overview of pipeline statistics, CPSR, charts, and activity feeds.
*   **Lead & Case Management**: Features for lead intake, qualification, detailed views, document association, and distributed case processing.
*   **Document Management**: Centralized document view, OCR inbox, AI document analysis, PDF redaction/highlighting, side-by-side document review, medical timeline builder, and AI document drafting.
*   **Paralegal Management**: Tools for managing paralegal teams, performance tracking, and leaderboards.
*   **Analytics**: KPIs, conversion funnels, trend charts, and tort breakdown analysis, including Praxis AI Predictive Analytics.
*   **Vendor Management**: CRUD operations for various vendor types with status tracking.
*   **CSV Lead Import**: Bulk lead ingestion with auto-column mapping, deduplication, conflict detection, and encryption of sensitive fields.
*   **Public Form Submission Surface**: A 10-step submission pipeline for public-facing forms with built-in validation and rate limiting.
*   **Web Forms (lightweight, embeddable lead capture)**: Per-tort, public, JS-embeddable lead capture forms with admin configuration (fields, eligibility rules, on/off toggle, confirmation email). Distinct from the heavier operator/public intake. Endpoints under `/api/web-forms/:tortId/*` (`GET` config / `embed.js` / `preview` HTML, `POST` submit). The embedded form is **fully responsive** — single-column on phones, side-by-side radio choices on tablets, max-width centered on desktop, with 16px input font (no iOS zoom-on-focus) and 44px+ touch targets. Admin UI under "Web Forms" sidebar entry uses a card list on mobile and a table on tablet/desktop. A `/api/web-forms/:tortId/preview` endpoint serves a standalone HTML page so admins can verify the form across viewports before sending the embed snippet to a partner.
*   **Background Check Hub (unified, multi-lane verification)**: A single operator action that fans out across **9 verification lanes** for a claimant — `address`, `email`, `phone`, `residency`, `criminal_court`, `incarceration`, `sex_offender_nsopw`, `attorney`, `business_entity` — and resolves each to one of `PASS` / `REVIEW_REQUIRED` / `FAIL` / `NOT_RUN`. The hub *wraps existing live validators* (email-validator, address-validator, CourtListener+OFAC criminal-court check) instead of replacing them with weaker stubs; lanes without a live adapter (NSOPW, attorney conflict, business entity, residency cross-check, incarceration, phone validation) are honest stubs that surface as `REVIEW_REQUIRED` or `NOT_RUN` with explicit `notes` and a `live_adapter_available: false` source flag — **no fake passes, ever**. The arbiter applies strict precedence (`FAIL` > `REVIEW_REQUIRED` > `PASS`, with `NOT_RUN` escalating to `REVIEW_REQUIRED` rather than silently passing) and includes the NSOPW special-case (manual-check flag → REVIEW; confirmed registry match → FAIL). Implemented in `artifacts/api-server/src/lib/bg-hub/{types,sources,escalation,adapters,hub}.ts` with 19 unit tests (`bg-hub.test.ts`). Endpoints: `POST /api/forms/background-check-hub/lead/:id` runs the hub and `GET /api/forms/background-check-hub/lead/:id/snapshots` returns history; both gated by `forms:background_check`. Every run persists a row to `lead_background_check_snapshots` (jsonb result + headline status/score/version) so operators see a full ledger. Surfaced in the lead-detail Compliance tab as the "Background Check Hub" card with per-lane status badges, scores, flags, source attribution, and a previous-runs list. Distinct from the legacy single-source `POST /api/forms/background-check/lead/:id` (CourtListener-only) which remains for backwards compatibility — the hub *includes* that lane via the `criminal_court` adapter.

*   **Outbound Lead Webhooks (n8n / Zapier / Make)**: When a lead is created — whether from a web form, operator intake, or any future source — the API server fires a `lead.created` event to every active integration of `type=automation` that has a `webhook_url` configured. Implemented in `lib/lead-webhook-dispatcher.ts`. Fire-and-forget via `setImmediate` so a slow third-party endpoint never blocks the lead-creation HTTP response; 5-second per-delivery timeout. If the integration has an `api_key` saved, the JSON body is signed with HMAC-SHA256 and sent in `X-MTOS-Signature: sha256=<hex>`; if no key is on file we send unsigned and record `signed: false` honestly in the audit row (no fake signatures). Each delivery writes an `audit_log` row with `action=webhook_dispatched` capturing target URL, response status, latency, signed flag, delivery UUID, and any error — so operators can see at a glance which deliveries succeeded. The integrations admin `/test` endpoint now performs a real live ping for automation integrations (sends a sample `lead.created` payload and reports the actual HTTP outcome) instead of only verifying credential decryption.

*   **Integration Wiring Transparency (migration-readiness honesty layer)**: Of the ~120 preset integrations available in the admin Integrations Hub, only **8** actually have working API call-out adapter code in this build today: SendGrid (email), DocuSign + Dropbox Sign (e-signature), Telnyx (fax), n8n + Zapier + Make (outbound lead webhooks), and Anthropic (AI extraction/OCR/drafting via the Replit AI SDK — env auth, the vault entry is decorative for this provider). The other ~113 presets are **vault-only**: an operator can save credentials but no code path consumes them. Rather than silently lying to operators with a uniform "Connect" button, we ship a single source of truth at `lib/integration-wiring.ts` (REGISTRY map of provider→{status,note}) with three statuses — `live`, `live_no_vault`, `vault_only`. Surfaced two ways: (a) `GET /api/integrations/presets` annotates each preset with `wired` + `wiring_note`; (b) `POST /api/integrations/:id/test` returns `success:false` with an explicit "no live adapter wired" message for vault-only providers no matter how cleanly their credentials decrypt — plus explicit fields `adapter_wired`, `vault_consumed`, `wiring_status` for non-UI consumers. The CRM integrations page renders Live / Vault-only badges per preset card, an amber "Heads up" warning on connected-but-unwired cards, and a Wiring column on the Active Connections table. **Drift protection**: `assertWiringRegistryConsistency()` runs at module load and cross-checks REGISTRY against the live ADAPTERS maps in `lib/email/sendgrid.ts`, `lib/esign/index.ts`, and `lib/fax/index.ts` — if a new adapter ships without being declared "live" in the registry (or vice-versa) the API server refuses to boot.

# External Dependencies

*   **Database**: PostgreSQL
*   **ORM**: Drizzle ORM
*   **AI**: Anthropic Claude
*   **Image Processing**: Sharp
*   **Validation**: Zod
*   **API Codegen**: Orval
*   **Background Checks**: CourtListener (federal courts only — see `lib/courtlistener-courts.ts` for state→court_id catalog; CourtListener has no `state=` query param so state filtering is implemented via `court=<csv>`), OFAC sanctions list (best-effort; gated on `OFAC_API_KEY` env — when unset the check is honestly skipped via the `notes` field instead of fabricating a clean result)
*   **NPI Lookup**: NPPES API (CMS NPI Registry)
*   **Security**: Helmet.js, express-rate-limit
*   **News Feeds**: Google News RSS, Yahoo Finance RSS, MarketWatch RSS, CNBC RSS
*   **E-Signature**: Dropbox Sign, DocuSign
*   **Fax**: Telnyx
*   **Email**: SendGrid