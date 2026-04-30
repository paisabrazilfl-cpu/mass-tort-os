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