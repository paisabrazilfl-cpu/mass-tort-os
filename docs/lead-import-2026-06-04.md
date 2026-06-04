# Lead import handoff — 2026-06-04

Prepared import source:

- XLSX source on gateway: `/data/media/inbound/LEADS_ALL_INFO---b758e174-6a66-484c-a4a2-a314864ef093.xlsx`
- Converted rows: 10,818
- Batch CSVs on gateway:
  - `/data/workspace/mtos_import/mtos_leads_import_part_01.csv` — 5,000 rows
  - `/data/workspace/mtos_import/mtos_leads_import_part_02.csv` — 5,000 rows
  - `/data/workspace/mtos_import/mtos_leads_import_part_03.csv` — 818 rows

The CSV files are not committed to git because they contain lead data. Keep them out of the repo and pass local file paths to the import script.

CRM endpoint verified in code:

- `POST /api/lead-import/execute`
- JSON body fields: `csv_data`, optional `column_mapping`, optional `filename`
- Per-request limit: 5,000 data rows
- Auth: `Authorization: Bearer <JWT or mtos_ API key>`

Run dry check:

```bash
node scripts/import-lead-batches.mjs --dry-run \
  /data/workspace/mtos_import/mtos_leads_import_part_01.csv \
  /data/workspace/mtos_import/mtos_leads_import_part_02.csv \
  /data/workspace/mtos_import/mtos_leads_import_part_03.csv
```

Run import:

```bash
MTOS_API_BASE=https://mtos-api-2b4x.onrender.com \
MTOS_API_KEY='mtos_...' \
node scripts/import-lead-batches.mjs --poll \
  /data/workspace/mtos_import/mtos_leads_import_part_01.csv \
  /data/workspace/mtos_import/mtos_leads_import_part_02.csv \
  /data/workspace/mtos_import/mtos_leads_import_part_03.csv
```

If using a session JWT instead of an API key, set `MTOS_BEARER_TOKEN` instead of `MTOS_API_KEY`.
