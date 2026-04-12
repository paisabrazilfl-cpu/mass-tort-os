# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

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

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally

## Artifacts

### Mass Tort OS (`artifacts/mtos-crm`)
- **Type**: react-vite, served at `/`
- **Purpose**: Full-stack Mass Tort Operating System (MTOS) CRM
- **Features**:
  - Dashboard with real-time pipeline stats (Total Leads, Qualified, Signed Retainers, CPSR)
  - Lead management with Boolean Gatekeeper qualification engine
  - Intake form with conditional disqualification logic
  - Document management for retainer PDFs
  - Dark-mode professional legal-tech UI with Recharts pipeline charts
  - Recent activity feed

### API Server (`artifacts/api-server`)
- **Type**: Express API, served at `/api`
- **Routes**: `/api/leads`, `/api/documents`, `/api/dashboard/stats`, `/api/dashboard/pipeline`, `/api/dashboard/recent-activity`

## Database Schema

### `leads` table
- id, name, email, phone, tort_type, exposure_start, exposure_end
- diagnosis_confirmed, diagnosis_type, was_at_location, location_name
- status (new|qualified|signed|rejected), rejection_reason
- notes, ad_spend, source, created_at, updated_at

### `documents` table
- id, lead_id (FK→leads), document_type (retainer|medical_record|intake_form|other)
- file_name, file_url, signed, signed_at, notes, created_at

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.
