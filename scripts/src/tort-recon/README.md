# tort_recon.py — OSINT Lead Enrichment

Single-target OSINT enrichment for mass-tort lead acquisition.

**Only queries public sources. Makes no contact with anyone.**
Contact/consent is a downstream step (TCPA/HIPAA live there, not here).

## Setup (one-time)

```bash
pip install maigret holehe ghunt   # installs the chain
# phoneinfoga: download binary from https://github.com/sundowndev/phoneinfoga/releases
```

## Usage

```bash
# By email only
python3 tort_recon.py --email lead@example.com --out ./reports

# Full enrichment
python3 tort_recon.py \
  --username jdoe \
  --email j@x.com \
  --name "John Doe" \
  --phone +15551234567 \
  --top-sites 300 \
  --ghunt \
  --phoneinfoga \
  --out ./reports
```

## Outputs (in --out dir)

| File | Contents |
|---|---|
| `<slug>.json` | Full machine-readable dossier |
| `<slug>.html` | Human-readable visual report |
| `<slug>_leads.csv` | Flattened signals — pipe into MTOS intake pipeline |

## Integrate with MTOS

The `<slug>_leads.csv` is formatted to match the Outreach bulk-import
column schema. Run the script, then upload the CSV at `/outreach`.
