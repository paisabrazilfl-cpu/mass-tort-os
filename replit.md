# Overview

This project is a full-stack Mass Tort Operating System (MTOS), a distributed case processing CRM designed for mass tort law firms. It aims to streamline the entire legal process from lead intake and document management to case analysis, compliance, and distributed processing. Key capabilities include AI-powered medical document extraction, advanced validation, robust conflict resolution, a sophisticated form engine for compliant lead generation across numerous tort campaigns, and a comprehensive analytics suite. The core business vision is to provide a scalable, efficient, and compliant solution for managing complex mass tort litigation, significantly improving operational efficiency and compliance for law firms.

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
*   **Conflict Resolution & Error Fallback**: A robust system detects conflicts, provides fail-safe modes, and an error fallback mechanism with retry logic.
*   **Form Engine**: A comprehensive engine for TCPA and TrustedForm compliant lead generation, featuring a tort-based form builder, embeddable JS script, live validation, background checks, and a 10-step submission pipeline.
*   **Lead Intake Dedup**: Implements a "one signee per (human, tort)" policy using existing lead data for updates or fresh inserts, with strict fill-empty semantics for public merges to prevent data tampering.
*   **MTOS Worker Build Isolation**: Ensures independent builds for API server and worker processes to prevent build conflicts.
*   **Workflow Settings Provider-Warning UX**: Notifies users when active integrations lack a selected default provider, preventing silent job failures.
*   **News Pages HTML Stripping**: Applies HTML stripping to article descriptions from RSS sources before rendering and search filtering.
*   **Background-Check Snapshot PII Sanitization**: Masks sensitive PII in persisted background check results, preserving auditability without exposing raw data.
*   **Taxonomy Engine**: Matches NPI provider taxonomies with medical diagnoses to identify mismatches.
*   **NPI Verify**: Operator-facing verification against the CMS NPI Registry, returning per-field confidence scores.
*   **Fraud Engine**: Flags potential fraud indicators.
*   **Compliance & Auditability**: Extensive logging of all actions and conflicts to an `audit_log` table, along with compliance-specific fields in lead records.
*   **Role-Based Access Control (RBAC)**: JWT (HS256) authentication with role hierarchy and granular route-level access control.
*   **Schema-vs-Database Workflow**: Uses `drizzle-kit push` for schema management.
*   **Dialog Accessibility Convention**: Enforces accessibility standards for dialogs using Radix UI.
*   **Web Auth Pipeline (CRM)**: Manages user authentication, token refresh, and MFA.
*   **Security Infrastructure**: Comprehensive security layer protecting ePHI/PII data, including token revocation, refresh tokens, MFA/TOTP, field-level encryption, rate limiting, and AI threat analysis.
*   **API Server Bundle Size Budget**: Manages API server bundle size by externalizing heavy runtime dependencies.
*   **Auto-Document Workflow**: Automates dispatch of e-sign packets and medical record faxes based on lead qualification.

**Key Features & Implementations:**

*   **Dashboards**: Provides pipeline statistics, CPSR, charts, and activity feeds.
*   **Lead & Case Management**: Tools for lead intake, qualification, detailed views, document association, and distributed case processing.
*   **Document Management**: Centralized document view, OCR inbox, AI document analysis, PDF redaction/highlighting, side-by-side document review, medical timeline builder, and AI document drafting.
*   **Paralegal Management**: Tools for managing paralegal teams, performance tracking, and leaderboards.
*   **Analytics**: KPIs, conversion funnels, trend charts, and tort breakdown analysis, including Praxis AI Predictive Analytics.
*   **Vendor Management**: CRUD operations for various vendor types with status tracking.
*   **CSV Lead Import**: Bulk lead ingestion with auto-column mapping, deduplication, conflict detection, and encryption.
*   **Public Form Submission Surface**: A 10-step submission pipeline for public-facing forms with built-in validation and rate limiting.
*   **Web Forms (lightweight, embeddable lead capture)**: Per-tort, public, JS-embeddable lead capture forms with admin configuration and full responsiveness across devices.
*   **Background Check Hub**: A unified operator action that fans out across multiple verification lanes, wrapping existing live validators and providing honest stub statuses for un-adapted lanes.
*   **Outbound Lead Webhooks**: Fires `lead.created` events to active automation integrations via webhooks, with HMAC-SHA256 signing for security and detailed audit logging.
*   **System-Wide Audit Hardening**: Addressed defects such as leaked Zod errors, persistent skeletons on 404s, silent retry-loops for leads with no email, and 500 errors on wrong content-types for lead import.
*   **Backend Audit Coverage**: Systematically verifies backend route files and worker job types for defects, ensuring proper error handling, data integrity, and canonical response envelopes.
*   **Integration Wiring Transparency**: Provides clear status (live, live_no_vault, vault_only) for all preset integrations in the admin UI, ensuring operators understand which integrations are actively wired to code paths.

# Audit Coverage

*   **Frontend audit coverage (launch-critical sweep, narrowed Task #42)**: Covered the 14 authenticated launch-critical pages of the CRM via live Playwright e2e: Dashboard (`/`), Leads (`/leads`), New Intake (`/leads/new`), Lead Import (`/lead-import`), Cases (`/cases` + `/cases/:id`), Review Queue (`/review-queue`), Documents (`/documents`), OCR Inbox (`/ocr-inbox`), Doc Review (`/doc-review`), Drafting AI (`/drafting`), Workflow Settings (`/workflow-settings`), Integrations (`/integrations`), Buyers (`/buyers`), Web Forms (`/web-forms`). All passed: rendered cleanly, primary interaction exercised, no console errors, no 4xx/5xx. Login (`/login`) and Login MFA (`/login/mfa`) verified at the API layer (POST `/api/auth/login` accepts a real scrypt-hashed admin and returns a JWT) — the in-browser `/login` page is unreachable in dev because the `IS_DEV` auth bypass in `rbac.ts` auto-authenticates as Dev Admin (this is intentional and fails closed in production). Pages outside the launch path (Pipeline, Paralegals, NPI Lookup, Analytics, Compliance, Form Engine, Vendors, Security, Timeline, Predictive, News, Financial News, Decision Engine, Document Templates, Template Assignments) are deferred to a post-launch backlog.

# External Dependencies

*   **Database**: PostgreSQL
*   **ORM**: Drizzle ORM
*   **AI**: Anthropic Claude
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