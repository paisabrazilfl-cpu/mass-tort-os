# Overview

This project is a full-stack Mass Tort Operating System (MTOS), a distributed case processing CRM designed for mass tort law firms. It aims to streamline the entire legal process from lead intake and document management to case analysis, compliance, and distributed processing. The system incorporates AI for medical document extraction, advanced validation engines (TCPA, TrustedForm, email, address), and a robust conflict resolution and error fallback system. It features a sophisticated form engine for compliant lead generation across 24 tort campaigns and a comprehensive analytics suite. The core business vision is to provide a scalable, efficient, and compliant solution to manage complex mass tort litigation, significantly improving operational efficiency and compliance for law firms.

# User Preferences

I prefer clear and direct communication. I value a development process that emphasizes iterative development and early feedback. Please ask for my approval before implementing any major architectural changes or significant feature additions. I appreciate detailed explanations for complex technical decisions.

# System Architecture

The project is structured as a pnpm monorepo using TypeScript, targeting Node.js 24. The backend is an Express 5 API, integrated with a PostgreSQL database using Drizzle ORM. API codegen is handled by Orval from an OpenAPI specification. The UI/UX is built with React and Vite.

**Core Architectural Patterns & Design Decisions:**

*   **Monorepo Structure**: Facilitates shared code, consistent tooling, and simplified dependency management across services.
*   **Distributed Architecture**: Employs a PostgreSQL job queue for asynchronous task processing by a dedicated worker process, enabling scalable and fault-tolerant case analysis and document ingestion.
*   **Deterministic Scoring Engine**: A rule-based scoring system provides transparent and auditable case qualification.
*   **File Vault**: Secure storage for case-related documents with SHA-256 hashing for integrity verification.
*   **AI Integration**: Utilizes Anthropic Claude for medical document extraction and OCR, enhancing automated data processing.
*   **Conflict Resolution & Error Fallback**: A robust system detects data integrity, logical, AI classification, and rule override conflicts. It provides fail-safe modes (safe fail, review fail, hard block) and an error fallback mechanism with retry logic and loop guards, ensuring system stability and data quality. All failures are logged to an audit trail and a review queue.
*   **Form Engine**: A comprehensive engine for TCPA and TrustedForm compliant lead generation, featuring a tort-based form builder, embeddable JS script, live validation (email, address), background checks (CourtListener, OFAC), and a 10-step submission pipeline with a "Final Arbiter" for ultimate decision-making.
*   **Taxonomy Engine**: Matches NPI provider taxonomies with medical diagnoses to identify potential mismatches or scope issues.
*   **Fraud Engine**: Flags potential fraud indicators without making final decisions, deferring to the Final Arbiter for resolution.
*   **Compliance & Auditability**: Extensive logging of all actions and conflicts to an `audit_log` table, along with compliance-specific fields in lead records (e.g., `tcpa_consent`, `trustedform_cert_url`).

**Key Features & Implementations:**

*   **Dashboard**: Overview of pipeline stats, CPSR, pipeline chart, and activity feed.
*   **Lead Management**: Features lead listing, intake forms with Boolean Gatekeeper qualification, detailed lead views with documents, CSV export (single lead + bulk with filters: status, tort type, date range, law firm, client ID, vendor, custom field selection).
*   **Case Management**: Distributed case pipeline, case submission, detailed case views with AI analysis and audit trails.
*   **Document Management**: Centralized document view and OCR inbox with Legora Grid for fax processing.
*   **Paralegal Management**: Tools for managing paralegal teams, performance tracking, and leaderboards.
*   **Analytics**: KPIs, conversion funnels, trend charts, and tort breakdown analysis.
*   **NPI Lookup**: Integration with the CMS NPI Registry.
*   **Review Queue**: Manages conflict resolution and error fallback items, with UI for manual review and FBI escalation.
*   **OCR Engine**: Processes fax images using Sharp for preprocessing and Claude Vision for OCR, extracting structured data into a `fax_results` table.
*   **Vendor Management**: Full CRUD for vendors (lead gen, law firm, marketing, referral types) with status tracking. Leads can be associated with vendors via `vendor_id`, `law_firm`, and `client_id` fields.
*   **AI Document Analysis (AIFields)**: Claude Haiku structured extraction of Rx numbers, providers, diagnoses, timelines from medical documents. Routes: `/api/ocr/ai-fields`, `/api/ocr/ai-fields/result/:id`.
*   **PDF Redaction/Highlighting**: pdf-lib based programmatic redaction and highlighting for HIPAA-compliant document sharing. Routes: `/api/documents/redact`, `/api/documents/highlight`.
*   **Side-by-Side Doc Review**: React page (`/doc-review`) comparing intake form data vs OCR/AI-extracted document data with field-by-field matching and fraud risk indicator.
*   **MedChron Timeline Builder**: Generates chronological exposure/medical timelines from lead data, OCR results, and NPI records. Route: `/api/timeline/lead/:id`, page: `/timeline`.
*   **AI Document Drafting**: Claude-powered generation of HIPAA authorizations, retainer agreements, medical records requests, demand letters, and intake summaries. Routes: `/api/drafting/templates`, `/api/drafting/generate`, `/api/drafting/generate-pdf`. Page: `/drafting`.
*   **Lens AI Predictive Analytics**: Weighted regression scoring engine computing conversion probability, risk score, and quality tier (platinum/gold/silver/bronze/unqualified). Routes: `/api/analytics/predictive/lead/:id`, `/api/analytics/predictive/batch`, `/api/analytics/predictive/by-tort`, `/api/analytics/predictive/model`. Page: `/predictive`.
*   **Role-Based Access Control (RBAC)**: JWT (HS256) authentication with role hierarchy (admin > attorney > paralegal > viewer). Auth routes: `/api/auth/login`, `/api/auth/register`, `/api/auth/me`. `mtos_users` DB table. Registration restricted to viewer/paralegal self-assignment; admin/attorney roles require admin promotion. Auth endpoints have dedicated rate limiting (20 req/15min). Async password hashing with `crypto.scrypt` + timing-safe comparison. Dev mode auto-authenticates; production requires Bearer tokens.
*   **Security Infrastructure**: Comprehensive security layer protecting ePHI/PII data:
    *   **Field-level Encryption**: AES-256-GCM encryption for sensitive fields (last_4_ssn, date_of_birth, diagnosis, diagnosis_date, street_address, phone_primary, phone, medications, notes, physician_full_address, physician_contact_info, hospital_contact_info, background_check_data) using `ENCRYPTION_KEY` env var. Encrypted values prefixed with `enc:`. Decryption errors return `[DECRYPTION_ERROR]` instead of raw ciphertext. Note: `name`, `email`, `first_name`, `last_name` remain unencrypted for search/filter functionality.
    *   **Security Headers & Rate Limiting**: Helmet.js (CSP, HSTS, X-Content-Type, referrer policy), express-rate-limit (500 req/15min global, 20 req/15min auth), 1MB request body limit. CORS restricted to app domain in production.
    *   **Route-level Access Control**: Security dashboard routes require admin role via `requireRole("admin")`. Health check endpoint exempt from auth for monitoring probes.
    *   **Intrusion Detection System (IDS)**: Middleware scanning for SQL injection, XSS, path traversal, command injection, brute force (100 req/60s). Auto-blocks critical threat IPs for 24h via `blocked_ips` table. All threats logged to `security_alerts` table.
    *   **AI Threat Analysis**: Claude Haiku classifies attack patterns, suggests countermeasures, updates alert records.
    *   **Security Dashboard**: CRM page at `/security` showing threat level, stats (24h alerts, critical count, blocked IPs), attack type/severity breakdowns, blocked IP management, alert table with dismiss, manual IP blocking, and AI analysis trigger.

# External Dependencies

*   **Database**: PostgreSQL
*   **ORM**: Drizzle ORM
*   **AI**: Anthropic Claude (via Replit AI Integrations)
*   **Image Processing**: Sharp (for OCR preprocessing)
*   **Validation**: Zod
*   **API Codegen**: Orval
*   **Background Checks**: CourtListener (free court records API), OFAC sanctions list
*   **NPI Lookup**: NPPES API (CMS NPI Registry)
*   **Security**: Helmet.js (security headers), express-rate-limit (rate limiting)
*   **News Feeds**: Google News RSS, Yahoo Finance RSS, MarketWatch RSS, CNBC RSS (real-time, 10min cache)

# Integrations Hub

Supports 16 pre-built connectors and custom API/vendor/webpage connections:

**CRMs**: Zapier, HubSpot, Clio Manage, Law Ruler, Salesforce, Litify, Filevine, Smokeball, MyCase, Pipedrive, Lead Docket
**Services**: Blacklist Alliance, TCPA Litigator List, TrustedForm, Jornaya, LexisNexis
**Custom**: Custom API, Vendor API, Web Page connections with configurable sync direction

Routes: `/api/integrations` (CRUD), `/api/integrations/presets` (list connectors), `/api/integrations/:id/test` (connection test), `/api/integrations/:id/sync` (data sync). DB table: `integrations`. Page: `/integrations`.

# News Feeds

*   **Mass Tort News** (`/news`): Real-time RSS from 5 Google News queries (mass tort, pharmaceutical class action, MDL, product liability, toxic tort). Filterable by category with search. Route: `/api/news/mass-tort`.
*   **Financial News** (`/financial-news`): RSS from Yahoo Finance, MarketWatch, CNBC, plus pharma/FDA and legal-impact focused feeds. Source breakdown dashboard. Route: `/api/news/financial`.