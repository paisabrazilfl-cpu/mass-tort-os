#!/usr/bin/env python3
"""
NPPES NPI bulk import script.
Streams the zip file, parses the CSV, and bulk-loads into nppes_providers.

Usage:
  DATABASE_URL=postgres://... python3 scripts/import-nppes.py [path/to/NPPES_*.zip]

Defaults to data/nppes/NPPES_Data_Dissemination_May_2026_V2.zip
"""
import csv
import io
import json
import os
import sys
import time
import zipfile
from datetime import datetime

import psycopg2
import psycopg2.extras

ZIP_PATH = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
    os.path.dirname(__file__), "../data/nppes/NPPES_Data_Dissemination_May_2026_V2.zip"
)

DATABASE_URL = os.environ.get("DATABASE_URL")
if not DATABASE_URL:
    print("ERROR: DATABASE_URL env var required", file=sys.stderr)
    sys.exit(1)

BATCH_SIZE = 5000

CREATE_TABLE_SQL = """
CREATE TABLE IF NOT EXISTS nppes_providers (
    npi                 TEXT PRIMARY KEY,
    entity_type         CHAR(1),

    org_name            TEXT,
    other_org_name      TEXT,
    other_org_name_type TEXT,
    parent_org_name     TEXT,
    parent_org_tin      TEXT,
    is_org_subpart      BOOLEAN,

    last_name           TEXT,
    first_name          TEXT,
    middle_name         TEXT,
    name_prefix         TEXT,
    name_suffix         TEXT,
    credential          TEXT,
    sex                 CHAR(1),
    sole_proprietor     BOOLEAN,

    other_last_name     TEXT,
    other_first_name    TEXT,
    other_middle_name   TEXT,
    other_name_prefix   TEXT,
    other_name_suffix   TEXT,
    other_credential    TEXT,
    other_last_name_type TEXT,

    mail_line1          TEXT,
    mail_line2          TEXT,
    mail_city           TEXT,
    mail_state          TEXT,
    mail_zip            TEXT,
    mail_country        TEXT,
    mail_phone          TEXT,
    mail_fax            TEXT,

    practice_line1      TEXT,
    practice_line2      TEXT,
    practice_city       TEXT,
    practice_state      TEXT,
    practice_zip        TEXT,
    practice_country    TEXT,
    practice_phone      TEXT,
    practice_fax        TEXT,

    enumeration_date    DATE,
    last_update_date    DATE,
    deactivation_reason TEXT,
    deactivation_date   DATE,
    reactivation_date   DATE,
    certification_date  DATE,

    auth_last_name      TEXT,
    auth_first_name     TEXT,
    auth_middle_name    TEXT,
    auth_title          TEXT,
    auth_phone          TEXT,
    auth_name_prefix    TEXT,
    auth_name_suffix    TEXT,
    auth_credential     TEXT,

    taxonomies          JSONB,
    display_name        TEXT,

    imported_at         TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS nppes_last_name_idx     ON nppes_providers (last_name);
CREATE INDEX IF NOT EXISTS nppes_org_name_idx      ON nppes_providers (org_name);
CREATE INDEX IF NOT EXISTS nppes_practice_state_idx ON nppes_providers (practice_state);
CREATE INDEX IF NOT EXISTS nppes_mail_state_idx    ON nppes_providers (mail_state);
CREATE INDEX IF NOT EXISTS nppes_practice_fax_idx  ON nppes_providers (practice_fax);
CREATE INDEX IF NOT EXISTS nppes_mail_fax_idx      ON nppes_providers (mail_fax);
CREATE INDEX IF NOT EXISTS nppes_deactivation_idx  ON nppes_providers (deactivation_date);
CREATE INDEX IF NOT EXISTS nppes_display_name_idx  ON nppes_providers (display_name);
CREATE INDEX IF NOT EXISTS nppes_entity_type_idx   ON nppes_providers (entity_type);
"""

COLUMNS = [
    "npi","entity_type","org_name","other_org_name","other_org_name_type",
    "parent_org_name","parent_org_tin","is_org_subpart",
    "last_name","first_name","middle_name","name_prefix","name_suffix","credential",
    "sex","sole_proprietor",
    "other_last_name","other_first_name","other_middle_name","other_name_prefix",
    "other_name_suffix","other_credential","other_last_name_type",
    "mail_line1","mail_line2","mail_city","mail_state","mail_zip","mail_country",
    "mail_phone","mail_fax",
    "practice_line1","practice_line2","practice_city","practice_state","practice_zip",
    "practice_country","practice_phone","practice_fax",
    "enumeration_date","last_update_date","deactivation_reason","deactivation_date",
    "reactivation_date","certification_date",
    "auth_last_name","auth_first_name","auth_middle_name","auth_title","auth_phone",
    "auth_name_prefix","auth_name_suffix","auth_credential",
    "taxonomies","display_name",
]

def clean(v):
    v = v.strip()
    return v if v else None

def parse_date(v):
    v = clean(v)
    if not v:
        return None
    try:
        return datetime.strptime(v, "%m/%d/%Y").strftime("%Y-%m-%d")
    except ValueError:
        return None

def parse_bool(v):
    v = clean(v)
    if v in ("Y", "Yes", "X"):
        return True
    if v in ("N", "No"):
        return False
    return None

def strip_phone(v):
    v = clean(v)
    if not v:
        return None
    digits = "".join(c for c in v if c.isdigit())
    return digits if digits else None

def map_row(row):
    g = lambda k: clean(row.get(k, ""))

    # Build taxonomy array (up to 15 entries)
    taxons = []
    for i in range(1, 16):
        code = g(f"Healthcare Provider Taxonomy Code_{i}")
        if not code:
            continue
        taxons.append({
            "code": code,
            "license": g(f"Provider License Number_{i}") or None,
            "state": g(f"Provider License Number State Code_{i}") or None,
            "primary": g(f"Healthcare Provider Primary Taxonomy Switch_{i}") == "Y",
            "group": g(f"Healthcare Provider Taxonomy Group_{i}") or None,
        })

    entity = g("Entity Type Code")
    org = g("Provider Organization Name (Legal Business Name)")
    last = g("Provider Last Name (Legal Name)")
    first = g("Provider First Name")

    if entity == "2":
        display_name = org or g("Provider Other Organization Name")
    else:
        parts = [p for p in [g("Provider Name Prefix Text"), first,
                              g("Provider Middle Name"), last,
                              g("Provider Name Suffix Text"),
                              g("Provider Credential Text")] if p]
        display_name = " ".join(parts) if parts else None

    return (
        g("NPI"),                          # npi
        entity,                            # entity_type
        org,                               # org_name
        g("Provider Other Organization Name"),   # other_org_name
        g("Provider Other Organization Name Type Code"),  # other_org_name_type
        g("Parent Organization LBN"),      # parent_org_name
        g("Parent Organization TIN"),      # parent_org_tin
        parse_bool(g("Is Organization Subpart")),  # is_org_subpart
        last,                              # last_name
        first,                             # first_name
        g("Provider Middle Name"),         # middle_name
        g("Provider Name Prefix Text"),    # name_prefix
        g("Provider Name Suffix Text"),    # name_suffix
        g("Provider Credential Text"),     # credential
        g("Provider Sex Code"),            # sex
        parse_bool(g("Is Sole Proprietor")),  # sole_proprietor
        g("Provider Other Last Name"),     # other_last_name
        g("Provider Other First Name"),    # other_first_name
        g("Provider Other Middle Name"),   # other_middle_name
        g("Provider Other Name Prefix Text"),  # other_name_prefix
        g("Provider Other Name Suffix Text"),  # other_name_suffix
        g("Provider Other Credential Text"),   # other_credential
        g("Provider Other Last Name Type Code"),  # other_last_name_type
        g("Provider First Line Business Mailing Address"),   # mail_line1
        g("Provider Second Line Business Mailing Address"),  # mail_line2
        g("Provider Business Mailing Address City Name"),    # mail_city
        g("Provider Business Mailing Address State Name"),   # mail_state
        g("Provider Business Mailing Address Postal Code"),  # mail_zip
        g("Provider Business Mailing Address Country Code (If outside U.S.)"),  # mail_country
        strip_phone(g("Provider Business Mailing Address Telephone Number")),    # mail_phone
        strip_phone(g("Provider Business Mailing Address Fax Number")),          # mail_fax
        g("Provider First Line Business Practice Location Address"),   # practice_line1
        g("Provider Second Line Business Practice Location Address"),  # practice_line2
        g("Provider Business Practice Location Address City Name"),    # practice_city
        g("Provider Business Practice Location Address State Name"),   # practice_state
        g("Provider Business Practice Location Address Postal Code"),  # practice_zip
        g("Provider Business Practice Location Address Country Code (If outside U.S.)"),  # practice_country
        strip_phone(g("Provider Business Practice Location Address Telephone Number")),   # practice_phone
        strip_phone(g("Provider Business Practice Location Address Fax Number")),         # practice_fax
        parse_date(g("Provider Enumeration Date")),    # enumeration_date
        parse_date(g("Last Update Date")),             # last_update_date
        g("NPI Deactivation Reason Code"),             # deactivation_reason
        parse_date(g("NPI Deactivation Date")),        # deactivation_date
        parse_date(g("NPI Reactivation Date")),        # reactivation_date
        parse_date(g("Certification Date")),           # certification_date
        g("Authorized Official Last Name"),            # auth_last_name
        g("Authorized Official First Name"),           # auth_first_name
        g("Authorized Official Middle Name"),          # auth_middle_name
        g("Authorized Official Title or Position"),    # auth_title
        strip_phone(g("Authorized Official Telephone Number")),  # auth_phone
        g("Authorized Official Name Prefix Text"),     # auth_name_prefix
        g("Authorized Official Name Suffix Text"),     # auth_name_suffix
        g("Authorized Official Credential Text"),      # auth_credential
        json.dumps(taxons) if taxons else None,        # taxonomies
        display_name,                                  # display_name
    )


def main():
    print(f"Connecting to database...")
    conn = psycopg2.connect(DATABASE_URL)
    conn.autocommit = False
    cur = conn.cursor()

    print("Creating table and indexes...")
    cur.execute(CREATE_TABLE_SQL)
    conn.commit()

    # Check if already partially imported
    cur.execute("SELECT COUNT(*) FROM nppes_providers")
    existing = cur.fetchone()[0]
    if existing > 0:
        print(f"Table already has {existing:,} rows. Truncating for fresh import...")
        cur.execute("TRUNCATE nppes_providers")
        conn.commit()

    print(f"Opening {ZIP_PATH}...")
    zf = zipfile.ZipFile(ZIP_PATH, "r")

    # Find the main data file
    names = zf.namelist()
    main_file = next(n for n in names if n.startswith("npidata_pfile") and not n.endswith("fileheader.csv"))
    print(f"Streaming {main_file}...")

    batch = []
    total = 0
    errors = 0
    t0 = time.time()
    last_report = t0

    copy_sql = f"INSERT INTO nppes_providers ({','.join(COLUMNS)}) VALUES %s ON CONFLICT (npi) DO UPDATE SET " + \
               ", ".join(f"{c}=EXCLUDED.{c}" for c in COLUMNS if c != "npi" and c != "imported_at")

    with zf.open(main_file) as raw:
        reader = csv.DictReader(io.TextIOWrapper(raw, encoding="utf-8", errors="replace"))
        for row in reader:
            try:
                batch.append(map_row(row))
            except Exception as e:
                errors += 1
                if errors <= 5:
                    print(f"Row error: {e}")
                continue

            if len(batch) >= BATCH_SIZE:
                psycopg2.extras.execute_values(cur, copy_sql, batch, page_size=BATCH_SIZE)
                conn.commit()
                total += len(batch)
                batch = []

                now = time.time()
                if now - last_report >= 10:
                    rate = total / (now - t0)
                    print(f"  {total:>9,} records | {rate:,.0f} rec/s | {errors} errors", flush=True)
                    last_report = now

        # Final batch
        if batch:
            psycopg2.extras.execute_values(cur, copy_sql, batch, page_size=len(batch))
            conn.commit()
            total += len(batch)

    elapsed = time.time() - t0
    print(f"\nDone! {total:,} records imported in {elapsed:.0f}s ({total/elapsed:,.0f} rec/s). Errors: {errors}")

    # Add trgm index for full-text search after bulk load (much faster post-insert)
    print("Adding trigram index for search (this may take a minute)...")
    cur.execute("CREATE EXTENSION IF NOT EXISTS pg_trgm")
    cur.execute("CREATE INDEX IF NOT EXISTS nppes_display_name_trgm_idx ON nppes_providers USING gin (display_name gin_trgm_ops)")
    cur.execute("CREATE INDEX IF NOT EXISTS nppes_org_name_trgm_idx ON nppes_providers USING gin (org_name gin_trgm_ops)")
    conn.commit()
    print("Trigram indexes created.")

    cur.close()
    conn.close()


if __name__ == "__main__":
    main()
