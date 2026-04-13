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

### API Server (`artifacts/api-server`)
- **Type**: Express API, served at `/api`
- **Lead routes**: `/api/leads`, `/api/leads/:id`, `/api/leads/:id/qualify`
- **Document routes**: `/api/documents`
- **Dashboard routes**: `/api/dashboard/stats`, `/api/dashboard/pipeline`, `/api/dashboard/recent-activity`
- **Cases routes**: `/api/cases`, `/api/cases/:id`, `/api/cases/:id/upload`, `/api/cases/:id/analyze`
- **Worker routes**: `/api/cases/worker/queue-stats`

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
- `leads` — Lead records with Boolean Gatekeeper fields
- `documents` — Retainer PDFs and intake forms

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

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.
