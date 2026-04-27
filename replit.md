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