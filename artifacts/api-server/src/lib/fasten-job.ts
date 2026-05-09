/**
 * Worker handler for the `fasten_records_sync` job type.
 *
 * Two backends, two sync shapes:
 *   - "connect" (hosted): startBulkExport → poll task → download files →
 *                         ingest each NDJSON file as one documents row.
 *   - "onprem":   single $everything fetch → one Bundle → one documents row.
 *
 * The job is re-enqueued with `poll_attempt + 1` while a Connect bulk export
 * is still in progress. After 60 polls (~5 minutes at default backoff) the
 * connection row is marked "error" so an operator notices.
 */
import { db, fastenConnectionsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./logger";
import { auditLog } from "./audit";
import { enqueueJob } from "./queue";
import { connect as fastenConnect, onprem as fastenOnprem } from "./fasten";
import { ingestFhirPayload } from "./fasten/ingest";

const MAX_POLL_ATTEMPTS = 60;

export interface FastenRecordsSyncPayload {
  connection_id: number;
  lead_id: number;
  case_id: string;
  backend: "connect" | "onprem";
  org_connection_id: string;
  task_id?: string;
  poll_attempt?: number;
}

async function markError(connectionId: number, message: string): Promise<void> {
  await db
    .update(fastenConnectionsTable)
    .set({ status: "error", last_error: message, updated_at: new Date() })
    .where(eq(fastenConnectionsTable.id, connectionId));
  await auditLog("fasten_connection", String(connectionId), "sync_error", { message });
}

export async function handleFastenRecordsSync(payload: FastenRecordsSyncPayload): Promise<void> {
  const { connection_id, lead_id, case_id, backend, org_connection_id } = payload;
  logger.info({ connection_id, backend }, "fasten_records_sync: starting");

  const [conn] = await db
    .select()
    .from(fastenConnectionsTable)
    .where(eq(fastenConnectionsTable.id, connection_id));
  if (!conn) {
    logger.warn({ connection_id }, "fasten_records_sync: connection row missing — skipping");
    return;
  }

  if (backend === "onprem") {
    try {
      const bundle = await fastenOnprem.fetchOnpremPatientEverything(org_connection_id);
      const result = await ingestFhirPayload({
        leadId: lead_id,
        caseId: case_id,
        payload: bundle,
        sourceLabel: `fasten_onprem:${conn.portal_name || org_connection_id}`,
      });
      await db
        .update(fastenConnectionsTable)
        .set({
          status: "synced",
          last_synced_at: new Date(),
          last_resource_count: result.summary?.total_resources ?? 0,
          last_error: null,
          updated_at: new Date(),
        })
        .where(eq(fastenConnectionsTable.id, connection_id));
      await auditLog("fasten_connection", String(connection_id), "sync_completed", {
        document_id: result.documentId,
        resource_count: result.summary?.total_resources ?? 0,
      });
    } catch (err) {
      logger.error({ err, connection_id }, "fasten on-prem sync failed");
      await markError(connection_id, String(err));
      throw err;
    }
    return;
  }

  // Hosted Connect backend: start (or resume) a bulk export task.
  let taskId = payload.task_id;
  let task: Awaited<ReturnType<typeof fastenConnect.getBulkExport>>;
  try {
    if (!taskId) {
      task = await fastenConnect.startBulkExport(org_connection_id);
      taskId = task.task_id;
    } else {
      task = await fastenConnect.getBulkExport(taskId);
    }
  } catch (err) {
    logger.error({ err, connection_id }, "fasten Connect bulk export call failed");
    await markError(connection_id, String(err));
    throw err;
  }

  const pollAttempt = (payload.poll_attempt ?? 0) + 1;

  if (task.status === "pending" || task.status === "in_progress") {
    if (pollAttempt > MAX_POLL_ATTEMPTS) {
      await markError(connection_id, `Bulk export still ${task.status} after ${pollAttempt} polls`);
      return;
    }
    // Re-enqueue ourselves to poll again. Standard exponential backoff in the
    // queue layer will naturally space these out.
    await enqueueJob("fasten_records_sync", {
      connection_id,
      lead_id,
      case_id,
      backend,
      org_connection_id,
      task_id: taskId,
      poll_attempt: pollAttempt,
    });
    logger.info({ connection_id, taskId, pollAttempt }, "fasten bulk export still running — re-queued");
    return;
  }

  if (task.status !== "completed") {
    await markError(connection_id, `Bulk export terminal status: ${task.status}`);
    return;
  }

  // Download every file the export produced and ingest each as its own document.
  // Connect bulk exports return NDJSON files (one FHIR resource per line). The
  // ingest layer only summarizes when handed a parsed JSON object, so we parse
  // each NDJSON line into a synthetic Bundle before handing it off — that way
  // last_resource_count and lead enrichment work for the Connect backend too.
  let totalResources = 0;
  let lastDocId: number | null = null;
  let succeeded = 0;
  const totalFiles = (task.files || []).length;
  let lastError: string | null = null;
  for (const file of task.files || []) {
    try {
      const dl = await fastenConnect.downloadBulkExportFile({ taskId, fileId: file.file_id });
      // dl.bytes is the raw NDJSON. Best-effort parse into a Bundle of entries;
      // if the file isn't valid NDJSON we still ingest the raw bytes so the
      // record is preserved for manual review.
      // `dl.bytes` is a Uint8Array (see fasten/client.ts) — Buffer.isBuffer
      // returns false on a plain Uint8Array so we wrap unconditionally
      // before decoding. Without the wrap, text was silently "" and the
      // NDJSON parse below produced zero entries, which sent
      // last_resource_count → 0 even on healthy bulk exports.
      const text =
        typeof dl.bytes === "string"
          ? dl.bytes
          : Buffer.from(dl.bytes as Uint8Array).toString("utf8");
      const lines = text
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
      const entries: Array<{ resource: unknown }> = [];
      for (const line of lines) {
        try {
          entries.push({ resource: JSON.parse(line) });
        } catch {
          // skip non-JSON line; counted via totalFiles fallback below
        }
      }
      const payload =
        entries.length > 0
          ? { resourceType: "Bundle", type: "collection", entry: entries }
          : dl.bytes;
      const result = await ingestFhirPayload({
        leadId: lead_id,
        caseId: case_id,
        payload,
        sourceLabel: `fasten_connect:${conn.portal_name || org_connection_id} (${file.resource_type ?? "file"})`,
        contentType: dl.contentType,
      });
      totalResources += result.summary?.total_resources ?? entries.length;
      lastDocId = result.documentId;
      succeeded += 1;
    } catch (err) {
      lastError = String(err);
      logger.error({ err, connection_id, fileId: file.file_id }, "fasten file ingest failed");
    }
  }

  // Honest reporting: only mark synced when at least one file landed cleanly.
  // If every file failed we set status=error so an operator notices instead
  // of silently believing the sync worked.
  if (succeeded === 0 && totalFiles > 0) {
    await markError(
      connection_id,
      `All ${totalFiles} bulk-export files failed to ingest${lastError ? `: ${lastError}` : ""}`,
    );
    return;
  }

  await db
    .update(fastenConnectionsTable)
    .set({
      status: "synced",
      last_synced_at: new Date(),
      last_resource_count: totalResources,
      last_error:
        succeeded < totalFiles
          ? `Partial: ${succeeded}/${totalFiles} files ingested`
          : null,
      updated_at: new Date(),
    })
    .where(eq(fastenConnectionsTable.id, connection_id));

  await auditLog("fasten_connection", String(connection_id), "sync_completed", {
    document_id: lastDocId,
    files_ingested: succeeded,
    files_failed: totalFiles - succeeded,
    resource_count: totalResources,
  });
}
