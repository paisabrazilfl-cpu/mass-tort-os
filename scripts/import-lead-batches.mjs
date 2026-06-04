#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { basename } from "node:path";

const DEFAULT_API_BASE = "https://mtos-api-2b4x.onrender.com";
const DEFAULT_BATCHES = [
  "/data/workspace/mtos_import/mtos_leads_import_part_01.csv",
  "/data/workspace/mtos_import/mtos_leads_import_part_02.csv",
  "/data/workspace/mtos_import/mtos_leads_import_part_03.csv",
];

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const poll = args.includes("--poll");
const help = args.includes("--help") || args.includes("-h");
const files = args.filter((arg) => !arg.startsWith("--"));

if (help) {
  console.log(`Usage: node scripts/import-lead-batches.mjs [--dry-run] [--poll] [csv ...]\n\nEnvironment:\n  MTOS_API_BASE       API base URL; default ${DEFAULT_API_BASE}\n  MTOS_BEARER_TOKEN   JWT access token, or\n  MTOS_API_KEY        mtos_ API key with lead-import write/read scope, or\n  MTOS_MASTER_API_KEY same as MTOS_API_KEY if that is how the key is stored locally\n\nIf no CSV paths are supplied, the script uses the gateway-generated batch paths for the 2026-06-04 import.`);
  process.exit(0);
}

const apiBase = (process.env.MTOS_API_BASE || DEFAULT_API_BASE).replace(/\/+$/, "");
const token = process.env.MTOS_BEARER_TOKEN || process.env.MTOS_API_KEY || process.env.MTOS_MASTER_API_KEY || "";
const batchFiles = files.length ? files : DEFAULT_BATCHES;

function countDataRows(csv) {
  const lines = csv.split(/\r?\n/).filter((line) => line.length > 0);
  return Math.max(0, lines.length - 1);
}

async function postJson(path, body) {
  const res = await fetch(`${apiBase}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText}: ${typeof parsed === "string" ? parsed : JSON.stringify(parsed)}`);
  }
  return parsed;
}

async function getJson(path) {
  const res = await fetch(`${apiBase}${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const text = await res.text();
  let parsed;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText}: ${typeof parsed === "string" ? parsed : JSON.stringify(parsed)}`);
  }
  return parsed;
}

if (!dryRun && !token) {
  throw new Error("Missing MTOS_BEARER_TOKEN, MTOS_API_KEY, or MTOS_MASTER_API_KEY");
}

const started = [];
for (const file of batchFiles) {
  const csv = await readFile(file, "utf8");
  const rows = countDataRows(csv);
  if (rows === 0) throw new Error(`${file}: no data rows`);
  if (rows > 5000) throw new Error(`${file}: ${rows} rows exceeds the API limit of 5000 rows per batch`);

  if (dryRun) {
    console.log(JSON.stringify({ file, rows, status: "dry_run_ok" }));
    continue;
  }

  const result = await postJson("/api/lead-import/execute", {
    csv_data: csv,
    filename: basename(file),
  });
  started.push(result.batch_id);
  console.log(JSON.stringify({ file, rows, result }));
}

if (poll && started.length) {
  for (const batchId of started) {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const batch = await getJson(`/api/lead-import/batches/${batchId}`);
      console.log(JSON.stringify({ batch_id: batchId, status: batch.status, processed_rows: batch.processed_rows, total_rows: batch.total_rows }));
      if (!["pending", "processing"].includes(batch.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
}
