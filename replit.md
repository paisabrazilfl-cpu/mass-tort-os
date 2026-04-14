# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Full-stack Mass Tort Operating System (MTOS) — a distributed case processing CRM for mass tort law firms.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)
- **AI**: Anthropic Claude (via Replit AI Integrations) — for medical document extraction

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally
- `pnpm --filter @workspace/api-server run worker` — run distributed worker

## Artifacts

### Mass Tort OS (`artifacts/mtos-crm`)
- **Type**: react-vite, served at `/`
- **Pages**:
  - `/` — Dashboard (pipeline stats, CPSR, pipeline chart, activity feed)
  - `/leads` — Lead list (filterable, searchable)
  - `/leads/new` — Intake form (Boolean Gatekeeper qualification)
  - `/leads/:id` — Lead detail with documents
  - `/documents` — All documents
  - `/cases` — Distributed Case Pipeline (queue stats, case list)
  - `/cases/new` — Submit Case (to processing queue)
  - `/cases/:id` — Case detail (documents, AI analysis, audit trail)
  - `/pipeline` — Pipeline View (conversion funnel, trend charts, tort breakdown)
  - `/paralegals` — Paralegal Management (cards, leaderboard, add paralegal)
  - `/analytics` — Analytics & ROI (KPIs, conversion funnel, score distribution)
  - `/compliance` — Compliance Audit Trail (event log, filters, JSON drill-down)
  - `/ocr-inbox` — OCR Inbox (Legora Grid, fax upload)
  - `/npi-lookup` — NPI Provider Lookup (CMS NPI Registry search)
  - `/review-queue` — Review Queue (conflict resolution, error fallback items)

### API Server (`artifacts/api-server`)
- **Type**: Express API, served at `/api`
- **Lead routes**: `/api/leads`, `/api/leads/:id`, `/api/leads/:id/qualify`
- **Document routes**: `/api/documents`
- **Dashboard routes**: `/api/dashboard/stats`, `/api/dashboard/pipeline`, `/api/dashboard/recent-activity`
- **Cases routes**: `/api/cases`, `/api/cases/:id`, `/api/cases/:id/upload`, `/api/cases/:id/analyze`
- **Worker routes**: `/api/cases/worker/queue-stats`
- **Paralegal routes**: `/api/paralegals`, `/api/paralegals/:id`, `/api/paralegals/:id/performance`
- **Analytics routes**: `/api/analytics/overview`, `/api/analytics/pipeline-trend`, `/api/analytics/conversion-funnel`, `/api/analytics/tort-breakdown`, `/api/analytics/paralegal-leaderboard`
- **Compliance routes**: `/api/compliance/audit-trail`, `/api/compliance/audit-summary`
- **NPI routes**: `/api/npi/search`, `/api/npi/lookup/:npi`
- **Review queue routes**: `/api/review-queue`, `/api/review-queue/stats`, `/api/review-queue/:id`

## Distributed Architecture

```
FastAPI Gateway (Express)
    ↓
PostgreSQL Job Queue (job_queue table)
    ↓
Worker Process (dist/worker.mjs)
    ├── create_case → writes to cases table
    ├── ingest_file → saves to vault/, writes to case_documents
    └── analyze_case → reads vault/, calls Claude AI, scores, writes to analysis
    ↓
PostgreSQL Results + Audit Log
```

### Worker Workflow
- **Name**: "MTOS Worker: Job Processor"  
- **Command**: `pnpm --filter @workspace/api-server run build && pnpm --filter @workspace/api-server run worker`
- Polls `job_queue` table every 2 seconds for pending jobs
- Uses PostgreSQL `SELECT ... FOR UPDATE SKIP LOCKED` for safe concurrent processing

## Database Schema

### Lead/Document Tables (original CRM)
- `leads` — Lead records with Boolean Gatekeeper fields + expanded schema (29 columns): personal (first_name, last_name, date_of_birth, street_address, city, state, zip, phone_primary, last_4_ssn), medical (diagnosis, diagnosis_date), physician (first/last name, full_address, contact_info), hospital (name, fax, contact_info). Hospital fields are mandatory — leads missing hospital info are rejected at API level.
- `documents` — Retainer PDFs and intake forms

### CRM Tables
- `paralegals` — Paralegal team (name, email, role, performance stats)
- `review_queue` — Conflict resolution + error fallback items (entity, conflict_type, severity, failsafe_mode, resolution)

### Distributed Case Pipeline Tables
- `cases` — Case records (id: UUID, data: JSONB, status)
- `case_documents` — Vault file references (path to filesystem)
- `analysis` — AI extraction results + deterministic scores (0-100)
- `job_queue` — PostgreSQL-based job broker (replaces Redis in MVP)
- `audit_log` — Full audit trail for all case actions

## Scoring Engine (`src/lib/scoring.ts`)
Deterministic, zero-hallucination scoring:
- Gate 1: Diagnosis confirmed (+40pts)
- Gate 2: Exposure confirmed (+30pts, +10pts if unclear)
- Gate 3: Severity > 0.7 (+20pts), > 0.5 (+12pts), > 0.3 (+5pts)
- Gate 4: No contradictions (+10pts, -6pts per contradiction after first)
- **Verdicts**: Strong (80+), Moderate (50-79), Weak (25-49), Disqualified (<25)

## File Vault (`vault/`)
- Files stored at `vault/<case_id>/<timestamp>_<filename>`
- SHA-256 hash stored in `case_documents.file_hash`
- Read by worker during analysis phase

## AI Integration
- Provider: Anthropic Claude Haiku (via Replit AI Integrations — no user API key needed)
- Charged to Replit credits
- Env vars: `AI_INTEGRATIONS_ANTHROPIC_BASE_URL`, `AI_INTEGRATIONS_ANTHROPIC_API_KEY`
- Extracts: diagnosis_present, exposure, severity, contradictions, tort_type, diagnosis_type, exposure_period_years

## OCR Engine — Fax Inbox → Legora Grid

**Problem**: PaddleOCR (Python/GPU) doesn't run in Node.js. **Solution**: Claude Vision + Sharp.

### Pipeline
```
POST /api/ocr/upload (base64 image)
    ↓
vault save (vault/fax_<timestamp>/<filename>)
    ↓
job_queue: process_fax job
    ↓
Worker: reads vault → Sharp preprocessing → Claude Vision OCR
    ↓
fax_results table (Legora Grid row)
    ↓
GET /api/ocr/results → UI display
```

### OCR Routes
- `POST /api/ocr/upload` — accepts `{ file_name, image_base64, mime_type }`, stores to vault, enqueues
- `GET /api/ocr/results` — all Legora Grid rows
- `GET /api/ocr/results/:id` — single result
- `GET /api/ocr/queue-stats` — pending/processing/done/failed counts

### Preprocessing (Sharp, `src/lib/ocr-preprocess.ts`)
1. Grayscale conversion
2. 2x upsample (for Rx label detail)
3. Unsharp mask / sharpen (sigma 1.5)
4. Normalize contrast
5. PNG output → base64 → Claude Vision

### AI OCR (`src/lib/ai-ocr.ts`)
- Model: `claude-haiku-4-5` (vision)
- Extracts: `rx_number`, `drug_name`, `fill_date`, `quantity`, `confidence`, `raw_text`
- Legora Grid format — ready for litigation case linking

### DB Table
`fax_results`: id, job_id, source_file, vault_path, rx_number, drug_name, fill_date, quantity, confidence, raw_text, status (pending|processing|done|failed), error, created_at, processed_at

### Frontend
- `/ocr-inbox` — Legora Grid table with queue stats, upload form, expandable raw text rows

## Conflict Resolution + Error Fallback System

### Conflict Detection Engine (`src/lib/conflict-engine.ts`)
- **DATA_INTEGRITY_CONFLICT**: Missing required fields, garbage input, invalid email/phone
- **LOGICAL_CONFLICT**: Foreign location (non-US), tort/diagnosis mismatch, date range errors
- **AI_CLASSIFICATION_CONFLICT**: AI verdict disagrees with rule engine
- **RULE_OVERRIDE_CONFLICT**: Buyer criteria contradicts global tort rules

### Error Fallback (`src/lib/error-fallback.ts`)
- `withErrorFallback()` — wraps any async operation with try/catch, retry (max 2), sanitized input retry, audit logging
- `createLoopGuard()` — prevents infinite loops: max_retries=2, max_ai_rechecks=1, max_rule_re_evaluations=2
- All failures logged to audit_log AND review_queue

### Failsafe Modes
- **SAFE_FAIL**: Auto-reject on garbage/uncertainty
- **REVIEW_FAIL**: Route to manual review queue
- **HARD_BLOCK**: Stop processing on compliance risk

### System Output States
Every module produces: `ACCEPT`, `REJECT`, `REVIEW_REQUIRED`, or `ERROR_FALLBACK`

### Integration Points
- Lead ingestion: conflict check runs before insert (garbage → REJECT, bad location → REVIEW_REQUIRED)
- Worker analyze_case: wrapped in error fallback with loop guard
- Worker process_fax: wrapped in error fallback with retry
- All conflicts/failures: audit_log entry + review_queue entry

## Form Engine (TCPA + TrustedForm Compliance)

### Architecture
```
Form Engine
├── Form Builder (Tort-Based) — 24 tort campaigns across 6 categories
├── Embeddable JS Script — GET /api/forms/embed/:tortId
├── Live Validation Layer
│   ├── Email Validator (RFC + typo detection) — POST /api/forms/validate/email
│   ├── Address Validator (US format) — POST /api/forms/validate/address
│   └── TCPA + TrustedForm Validator (server-side)
├── Background Check — CourtListener (free) + OFAC sanctions
│   ├── POST /api/forms/background-check
│   └── POST /api/forms/background-check/lead/:id
├── Submission Pipeline — POST /api/forms/submit (10-step with fallbacks)
│   ├── Step 1: Schema validation
│   ├── Step 2: Email validation
│   ├── Step 3: Address validation
│   ├── Step 4: TCPA consent
│   ├── Step 5: TrustedForm cert
│   ├── Step 6: Tort classification engine
│   ├── Step 7: NPI lookup + taxonomy matching
│   ├── Step 8: Fraud detection engine
│   ├── Step 9: Conflict detection
│   └── Step 10: CRM storage + background check (post-insert)
├── GET /api/forms/config — all tort campaign configs
├── GET /api/forms/categories — grouped by category
├── POST /api/forms/npi-verify — NPI taxonomy matching
├── POST /api/forms/fraud-check — standalone fraud detection
└── POST /api/forms/escalate/fbi — FBI tip escalation + audit
```

### Tort Registry (24 torts, 6 categories)
- **Pharmaceutical**: Roundup, Paraquat, Zantac, Depo-Provera, GLP-1, NEC, Tylenol
- **Product Liability**: Talcum Powder, Hair Relaxer, Asbestos, Benzene
- **Medical Device**: Hernia Mesh, Hip Implants, IVC Filters, CPAP
- **Environmental**: Camp Lejeune, AFFF/PFAS, Industrial Water
- **Transportation**: Uber/Lyft Assault, Delivery Platform Injury, Autonomous Vehicles
- **Digital Platform**: Roblox, Social Media Harm, Online Gaming

### Tort Engine (`src/lib/tort-engine.ts`)
- Each tort has: valid_diagnoses, required_exposure flag, exposure_fields, extra_fields, rules, rejection_conditions
- `validateTortClaim()` — diagnosis matching, exposure validation, rule enforcement
- Camp Lejeune: exposure date 1953-1987 range check

### Taxonomy Engine (`src/lib/taxonomy-engine.ts`)
- Maps NPI taxonomy codes to diagnosis categories (oncology, neurology, gastroenterology, etc.)
- Detects: pediatric physician + adult cancer, specialty outside scope, non-medical provider
- `lookupNpiAndMatch()` — queries NPPES API, matches taxonomy to diagnosis
- Confidence levels: high (exact match), medium (generalist), low (mismatch)

### Fraud Detection Engine (`src/lib/fraud-engine.ts`)
- Scoring 0-100: ≥60 → REJECTED, ≥20 → TO_BE_REVIEWED, <20 → ACCEPTED
- Triggers: taxonomy mismatch, missing NPI, diagnosis mismatch, impossible timeline, exposure before birth, future diagnosis date
- Returns: status, fraud_score, indicators array, summary

### FBI Escalation
- POST /api/forms/escalate/fbi — logs to audit_log, marks lead as "escalated"
- Review Queue UI: "Send to FBI" button on critical/high severity items
- Opens https://tips.fbi.gov/ in new tab

### Compliance Fields (leads table)
- tcpa_consent, trustedform_cert_url, trustedform_ip, trustedform_user_agent, trustedform_timestamp
- email_validation_status, address_validation_status
- background_check_status, background_check_data
- medications, npi_verified, npi_number, physician_taxonomy
- fraud_score, fraud_status, fraud_indicators

### Email Validation Engine
- RFC regex, typo domain detection (gnail→gmail, hotmial→hotmail, etc.)
- Malformed TLD detection (.vom, .con, .cmo)
- Disposable email blocking, suspicious pattern detection
- Server-side final gate on form submission

### Background Check
- Sources: CourtListener (free court records API), OFAC sanctions list
- Returns: clean, flagged, not_found, or error
- Distinguishes "no matches" from "source unreachable" (never false-clean on failure)

### Embeddable Form
- `<script src="/api/forms/embed/:tortId"></script><div id="mtos-form"></div>`
- Auto-renders TCPA-compliant form with TrustedForm script injection
- Live email validation on blur, medications field, exposure dates per tort
- Submits directly to /api/forms/submit

### Frontend
- `/form-engine` — Form Engine dashboard (3 tabs: Form Builder, Validation Tools, Background Check)
- `/review-queue` — FBI escalation button on critical/high severity review items

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.
