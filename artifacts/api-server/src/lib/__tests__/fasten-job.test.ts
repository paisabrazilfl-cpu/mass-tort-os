// Coverage for handleFastenRecordsSync — the worker that drains a
// Fasten Connect bulk export onto a lead's documents tab. Three
// branches the operator UX depends on:
//
//   (1) NDJSON parse path — when the bulk export task completes and
//       its files are valid newline-delimited FHIR resources, the
//       worker must:
//         - parse each NDJSON line into a FHIR resource
//         - count resources > 0 (NOT files; per-line counting is what
//           closes the "we silently reported zero records" regression)
//         - write status='synced' with last_resource_count > 0 and
//           last_error = NULL
//   (2) all-files-fail path — when every file download throws, the
//       worker must mark the connection 'error' (not 'synced') and
//       record a last_error string mentioning every file failed.
//       Without this branch the operator UI would lie about the sync
//       having succeeded.
//   (3) partial-success path — when some files ingest cleanly and
//       others fail, the worker must mark the connection 'synced'
//       (records DID land) BUT carry a last_error of the form
//       "Partial: x/y files ingested" so the operator can chase the
//       missing files.
//
// We seed a real `fasten_connect` integration row + matching
// connection row, then override globalThis.fetch to script the Fasten
// Connect API responses (start-export, get-export, file download).
// All of the worker code path runs as it would in production —
// including the real ingestFhirPayload() write to the vault and the
// documents table.

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  db,
  documentsTable,
  fastenConnectionsTable,
  integrationsTable,
  leadsTable,
} from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { encrypt } from "../encryption.js";
import { handleFastenRecordsSync } from "../fasten-job.js";

// Audit writes off — we don't pin audit shape here, the route + matrix
// suites already cover the Fasten audit_log contract.
process.env["RBAC_DISABLE_AUDIT"] = "1";

const TS = Date.now();
const FIRM_B_SLUG = `fasten-job-firm-${TS}`;
const FAKE_BASE = "http://fasten-test.invalid";
const TASK_ID = `task_${TS}`;
const ORG_CONN_ID = `oc_${TS}`;

let firmId = 0;
let leadId = 0;
let connectionId = 0;
let integrationId = 0;
let originalFetch: typeof globalThis.fetch;

interface FetchScript {
  // Map of fileId → response shape. "ok" returns valid NDJSON; "fail"
  // throws a 500. Tests reset this in beforeEach to script per-case
  // download outcomes without re-seeding the rest of the fixture.
  fileOutcomes: Record<string, "ok" | "fail">;
  // Expose the fileIds the bulk export task will report — tests
  // override this so they can control how many files the worker tries
  // to download.
  files: Array<{ file_id: string; resource_type: string }>;
}

const script: FetchScript = { fileOutcomes: {}, files: [] };

function ndjsonForFile(fileId: string): string {
  // Two FHIR resources per file so we can prove per-resource counting
  // (not per-file counting) — last_resource_count must be 2 × succeeded.
  return [
    JSON.stringify({
      resourceType: "Condition",
      id: `${fileId}-c1`,
      code: { text: "Mesothelioma" },
      onsetDateTime: "2022-04-01",
    }),
    JSON.stringify({
      resourceType: "Observation",
      id: `${fileId}-o1`,
      code: { text: "Asbestos exposure" },
    }),
  ].join("\n");
}

function mockFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === "string" ? input : input.toString();

  // POST /v1/ehi-export — start a bulk export task.
  if (url.endsWith("/v1/ehi-export") && (init?.method ?? "GET") === "POST") {
    return Promise.resolve(
      new Response(
        JSON.stringify({ task_id: TASK_ID, status: "completed", files: script.files }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
  }

  // GET /v1/ehi-export/<task_id> — poll an existing task.
  const pollMatch = url.match(/\/v1\/ehi-export\/([^/]+)$/);
  if (pollMatch) {
    return Promise.resolve(
      new Response(
        JSON.stringify({ task_id: pollMatch[1], status: "completed", files: script.files }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
  }

  // GET /v1/ehi-export/<task>/file/<fileId> — download a single file.
  const fileMatch = url.match(/\/v1\/ehi-export\/[^/]+\/file\/([^/?]+)/);
  if (fileMatch) {
    const fileId = fileMatch[1]!;
    const outcome = script.fileOutcomes[fileId] ?? "ok";
    if (outcome === "fail") {
      return Promise.resolve(
        new Response("upstream provider error", {
          status: 500,
          headers: { "content-type": "text/plain" },
        }),
      );
    }
    return Promise.resolve(
      new Response(ndjsonForFile(fileId), {
        status: 200,
        headers: { "content-type": "application/fhir+ndjson" },
      }),
    );
  }

  // Anything else hitting the network is a test bug — fail loudly so
  // we don't accidentally skip our scripted responses.
  return Promise.reject(new Error(`Unscripted fetch in fasten-job test: ${url}`));
}

before(async () => {
  // Spin up an isolated firm + lead. Using a fresh firm keeps test
  // deletes scoped (cascade from firms removes leads + connections
  // even if a per-row cleanup misses).
  const firmRes = await db.execute(
    sql`INSERT INTO firms (name, slug, billing_email)
        VALUES ('Fasten Job Test Firm', ${FIRM_B_SLUG}, ${`fasten-job-${TS}@mtos.test`})
        RETURNING id`,
  );
  firmId = ((firmRes as unknown as { rows?: Array<{ id: number }> }).rows ?? [])[0]!.id;

  const [lead] = await db
    .insert(leadsTable)
    .values({
      name: "Worker Test Patient",
      tort_type: `fasten-worker-${TS}`,
      firm_id: firmId,
    } as typeof leadsTable.$inferInsert)
    .returning({ id: leadsTable.id });
  leadId = lead!.id;

  // Insert the integration row FIRST (status=pending so getIntegrationCredentials
  // returns null), then update it with encrypted credentials AAD-bound to its
  // own row id (matches what buildEncryptedCredentials does in the route).
  const [integration] = await db
    .insert(integrationsTable)
    .values({
      name: "Fasten (test)",
      type: "medical_records",
      provider: "fasten_connect",
      status: "pending",
      api_url: FAKE_BASE,
    } as typeof integrationsTable.$inferInsert)
    .returning({ id: integrationsTable.id });
  integrationId = integration!.id;

  const credentials = {
    api_key: encrypt("private_test_secret", "integration:api_key", String(integrationId)),
    client_id: encrypt("public_test_id", "integration:client_id", String(integrationId)),
    client_secret: encrypt("whsec_test", "integration:client_secret", String(integrationId)),
  };
  await db
    .update(integrationsTable)
    .set({ status: "active", config: { credentials } })
    .where(eq(integrationsTable.id, integrationId));

  const [conn] = await db
    .insert(fastenConnectionsTable)
    .values({
      firm_id: firmId,
      lead_id: leadId,
      backend: "connect",
      portal_id: `epic-${TS}`,
      portal_name: "Test Epic Portal",
      org_connection_id: ORG_CONN_ID,
      status: "syncing",
    })
    .returning({ id: fastenConnectionsTable.id });
  connectionId = conn!.id;

  originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetch as typeof globalThis.fetch;
});

after(async () => {
  globalThis.fetch = originalFetch;
  // Clean up everything FK-safely. The firm cascade catches any
  // documents / connections / leads we forget here.
  await db
    .delete(integrationsTable)
    .where(eq(integrationsTable.id, integrationId))
    .catch(() => {});
  await db
    .delete(documentsTable)
    .where(eq(documentsTable.lead_id, leadId))
    .catch(() => {});
  if (firmId) {
    await db.execute(sql`DELETE FROM firms WHERE id = ${firmId}`).catch(() => {});
  }
});

beforeEach(async () => {
  // Each test starts from a deterministic 'syncing' baseline so we
  // can prove the worker writes the correct terminal status, not just
  // that the row already happened to be in that state.
  await db
    .update(fastenConnectionsTable)
    .set({
      status: "syncing",
      last_error: null,
      last_resource_count: 0,
      last_synced_at: null,
    })
    .where(eq(fastenConnectionsTable.id, connectionId));
});

async function readConn(): Promise<{
  status: string;
  last_error: string | null;
  last_resource_count: number | null;
  last_synced_at: Date | null;
}> {
  const [row] = await db
    .select({
      status: fastenConnectionsTable.status,
      last_error: fastenConnectionsTable.last_error,
      last_resource_count: fastenConnectionsTable.last_resource_count,
      last_synced_at: fastenConnectionsTable.last_synced_at,
    })
    .from(fastenConnectionsTable)
    .where(eq(fastenConnectionsTable.id, connectionId));
  return row!;
}

test("(1) NDJSON parse path: counts resources per line, marks status='synced', clears last_error", async () => {
  // Single file, two NDJSON resources (one Condition + one Observation
  // — see ndjsonForFile()). The worker must parse line-by-line and
  // report total_resources=2, NOT files-count=1.
  script.files = [{ file_id: "file_ok_1", resource_type: "Condition" }];
  script.fileOutcomes = { file_ok_1: "ok" };

  await handleFastenRecordsSync({
    connection_id: connectionId,
    lead_id: leadId,
    case_id: `lead-${leadId}`,
    backend: "connect",
    org_connection_id: ORG_CONN_ID,
  });

  const conn = await readConn();
  assert.equal(
    conn.status,
    "synced",
    "with at least one file ingested cleanly the connection must end in 'synced', not 'syncing' / 'error'",
  );
  assert.equal(
    conn.last_error,
    null,
    "a fully-successful sync must clear last_error so the lead-detail UI doesn't keep flagging the previous failure",
  );
  assert.equal(
    conn.last_resource_count,
    2,
    "last_resource_count must reflect per-NDJSON-line FHIR resources, not bulk-export file count (regression guard for the silent-zero bug)",
  );
  assert.ok(conn.last_synced_at, "last_synced_at must be stamped on a successful sync");
});

test("(2) all-files-fail path: worker marks status='error' with a last_error string referencing every failed file", async () => {
  // Three files, all fail to download. The worker must mark the row
  // 'error' (NOT 'synced') and record a last_error mentioning the
  // count so an operator can immediately see the scope of the failure.
  script.files = [
    { file_id: "file_fail_1", resource_type: "Condition" },
    { file_id: "file_fail_2", resource_type: "Observation" },
    { file_id: "file_fail_3", resource_type: "MedicationStatement" },
  ];
  script.fileOutcomes = {
    file_fail_1: "fail",
    file_fail_2: "fail",
    file_fail_3: "fail",
  };

  await handleFastenRecordsSync({
    connection_id: connectionId,
    lead_id: leadId,
    case_id: `lead-${leadId}`,
    backend: "connect",
    org_connection_id: ORG_CONN_ID,
  });

  const conn = await readConn();
  assert.equal(
    conn.status,
    "error",
    "when every file fails the worker MUST mark the connection 'error' — silently writing 'synced' here would lie to the operator",
  );
  assert.ok(
    conn.last_error,
    "all-files-fail path must record a last_error string for the operator UI",
  );
  assert.match(
    String(conn.last_error),
    /All 3 .*files? failed/,
    "last_error must mention how many files failed so the operator sees the blast radius without grepping logs",
  );
});

test("(3) partial-success path: worker marks 'synced' but records last_error='Partial: x/y files ingested'", async () => {
  // Three files, one succeeds and two fail. The worker should land
  // status='synced' (some records DID make it) but carry a Partial
  // last_error so the operator can chase the missing files.
  script.files = [
    { file_id: "file_partial_ok", resource_type: "Condition" },
    { file_id: "file_partial_fail_a", resource_type: "Observation" },
    { file_id: "file_partial_fail_b", resource_type: "MedicationStatement" },
  ];
  script.fileOutcomes = {
    file_partial_ok: "ok",
    file_partial_fail_a: "fail",
    file_partial_fail_b: "fail",
  };

  await handleFastenRecordsSync({
    connection_id: connectionId,
    lead_id: leadId,
    case_id: `lead-${leadId}`,
    backend: "connect",
    org_connection_id: ORG_CONN_ID,
  });

  const conn = await readConn();
  assert.equal(
    conn.status,
    "synced",
    "partial success must still land 'synced' — records DID make it through, the operator just needs to know some files were lost",
  );
  assert.equal(
    conn.last_resource_count,
    2,
    "last_resource_count must reflect ONLY the successfully-ingested file (2 NDJSON resources), not the failed downloads",
  );
  assert.ok(conn.last_error, "partial sync must surface a last_error so the operator can act on it");
  assert.match(
    String(conn.last_error),
    /^Partial: 1\/3 files ingested$/,
    "last_error format is part of the operator-UX contract — the lead-detail card renders this string verbatim, so it must read 'Partial: x/y files ingested'",
  );
});
