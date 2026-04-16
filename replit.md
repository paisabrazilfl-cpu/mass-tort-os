# Overview

This project is a full-stack Mass Tort Operating System (MTOS), a distributed case processing CRM designed for mass tort law firms. It aims to streamline the entire legal process from lead intake and document management to case analysis, compliance, and distributed processing. The system incorporates AI for medical document extraction, advanced validation engines, and robust conflict resolution. It features a sophisticated form engine for compliant lead generation across 24 tort campaigns and a comprehensive analytics suite. The core business vision is to provide a scalable, efficient, and compliant solution to manage complex mass tort litigation, significantly improving operational efficiency and compliance for law firms.

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
*   **Conflict Resolution & Error Fallback**: A robust system detects conflicts, provides fail-safe modes, and an error fallback mechanism with retry logic, ensuring system stability and data quality. All failures are logged to an audit trail and a review queue.
*   **Form Engine**: A comprehensive engine for TCPA and TrustedForm compliant lead generation, featuring a tort-based form builder, embeddable JS script, live validation, background checks, and a 10-step submission pipeline with a "Final Arbiter."
*   **Taxonomy Engine**: Matches NPI provider taxonomies with medical diagnoses to identify potential mismatches.
*   **Fraud Engine**: Flags potential fraud indicators, deferring to the Final Arbiter for resolution.
*   **Compliance & Auditability**: Extensive logging of all actions and conflicts to an `audit_log` table, along with compliance-specific fields in lead records.

**Key Features & Implementations:**

*   **Dashboards**: Overview of pipeline stats, CPSR, pipeline charts, and activity feeds.
*   **Lead & Case Management**: Comprehensive features for lead intake, qualification, detailed views, document association, and distributed case processing with AI analysis and audit trails.
*   **Document Management**: Centralized document view, OCR inbox, AI document analysis for structured data extraction, PDF redaction/highlighting, side-by-side document review, medical timeline builder, and AI document drafting.
*   **Paralegal Management**: Tools for managing paralegal teams, performance tracking, and leaderboards.
*   **Analytics**: KPIs, conversion funnels, trend charts, and tort breakdown analysis, including Praxis AI Predictive Analytics for scoring.
*   **Vendor Management**: Full CRUD for vendors (lead gen, law firm, marketing, referral types) with status tracking.
*   **CSV Lead Import**: Bulk lead ingestion with auto-column mapping, preview, deduplication, conflict detection, encryption of sensitive fields, and detailed error tracking.
*   **Role-Based Access Control (RBAC)**: JWT (HS256) authentication with role hierarchy (admin > attorney > paralegal > viewer) and granular route-level access control.
*   **Security Infrastructure**: Comprehensive security layer protecting ePHI/PII data, including token revocation, refresh tokens, MFA/TOTP, password complexity, account lockout, row-level isolation, field-level encryption with key rotation and AAD, security headers, rate limiting, security event alerting, path traversal protection, information disclosure prevention, business logic hardening, Intrusion Detection System (IDS), and AI threat analysis.

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