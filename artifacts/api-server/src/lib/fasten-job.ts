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
 *
 * Partial-success handling (Task #72):
 * When some bulk-export files ingest cleanly and others fail, we record the
 * failed file_ids on `metadata.failed_files` along with the task_id so the
 * operator can retry ONLY the lost files via /api/fasten/sync with
 * `mode=retry-failed` — not re-pull the entire export, which can be expensive
 * and re-download data we already have.
 */
import { db, fastenConnectionsTable, auditLogTable } from "@workspace/db";
import { and, eq, isNull, lt, sql } from "drizzle-orm";
import { logger } from "./logger";
import { auditLog } from "./audit";
import { enqueueJob } from "./queue";
import { connect as fastenConnect, onprem as fastenOnprem } from "./fasten";
import { ingestFhirPayload } from "./fasten/ingest";

const MAX_POLL_ATTEMPTS = 60;

export interface FastenFailedFile {
  file_id: string;
  resource_type?: string;
  error: string;
}

export interface FastenRecordsSyncPayload {
  connection_id: number;
  lead_id: number;
  case_id: string;
  backend: "connect" | "onprem";
  org_connection_id: string;
  task_id?: string;
  poll_attempt?: number;
  /**
   * When true, skip the bulk-export start and only re-download the files
   * recorded in `metadata.failed_files` from the prior partial run. Requires
   * `task_id` (the previous bulk-export task, files are still cached there).
   * Set by /api/fasten/sync?mode=retry-failed.
   */
  retry_failed_only?: boolean;
}

interface ConnectionMetadata {
  state?: string;
  external_id?: string;
  last_task_id?: string;
  failed_files?: FastenFailedFile[];
  partial_audited_at?: string;
  [k: string]: unknown;
}

async function markError(connectionId: number, message: string): Promise<void> {
  await db
    .update(fastenConnectionsTable)
    .set({ status: "error", last_error: message, updated_at: new Date() })
    .where(eq(fastenConnectionsTable.id, connectionId));
  await auditLog("fasten_connection", String(connectionId), "sync_error", { message });
}

function readMetadata(raw: unknown): ConnectionMetadata {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as ConnectionMetadata;
  }
  return {};
}

export async function handleFastenRecordsSync(payload: FastenRecordsSyncPayload): Promise<void> {
  const { connection_id, lead_id, case_id, backend, org_connection_id, retry_failed_only } = payload;
  logger.info({ connection_id, backend, retry_failed_only: !!retry_failed_only }, "fasten_records_sync: starting");

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

  // Hosted Connect backend.
  const existingMeta = readMetadata(conn.metadata);

  // ─── Retry-failed-only fast path ─────────────────────────────────────────
  // Skip startBulkExport / polling — re-download just the file_ids from the
  // previous partial run using the saved task_id. If the upstream task has
  // expired we fall through to a fresh bulk export so the operator still
  // gets their records (just paying the full re-download cost once).
  let filesToProcess: Array<{ file_id: string; resource_type?: string }> = [];
  let taskId: string | undefined = payload.task_id;

  if (retry_failed_only) {
    const failed = existingMeta.failed_files ?? [];
    const savedTaskId = payload.task_id || existingMeta.last_task_id;
    if (failed.length === 0 || !savedTaskId) {
      logger.info(
        { connection_id, hasFailed: failed.length, hasTask: !!savedTaskId },
        "fasten_records_sync: retry_failed_only requested but nothing to retry — falling through to full sync",
      );
    } else {
      taskId = savedTaskId;
      try {
        // Confirm the task still exists upstream. If it 404s, fall through.
        await fastenConnect.getBulkExport(taskId);
        filesToProcess = failed.map((f) => ({ file_id: f.file_id, resource_type: f.resource_type }));
      } catch (err) {
        logger.warn(
          { err, connection_id, taskId },
          "fasten retry-failed: prior bulk export task unreachable, falling back to fresh sync",
        );
        taskId = undefined;
        filesToProcess = [];
      }
    }
  }

  // ─── Default path: start (or resume) a bulk export task ──────────────────
  if (filesToProcess.length === 0) {
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

    filesToProcess = (task.files || []).map((f) => ({ file_id: f.file_id, resource_type: f.resource_type }));
  }

  // Download every file the export produced and ingest each as its own document.
  // Connect bulk exports return NDJSON files (one FHIR resource per line). The
  // ingest layer only summarizes when handed a parsed JSON object, so we parse
  // each NDJSON line into a synthetic Bundle before handing it off — that way
  // last_resource_count and lead enrichment work for the Connect backend too.
  let totalResources = 0;
  let lastDocId: number | null = null;
  let succeeded = 0;
  const totalFiles = filesToProcess.length;
  let lastError: string | null = null;
  const failedFiles: FastenFailedFile[] = [];
  for (const file of filesToProcess) {
    try {
      const dl = await fastenConnect.downloadBulkExportFile({ taskId: taskId!, fileId: file.file_id });
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
      failedFiles.push({ file_id: file.file_id, resource_type: file.resource_type, error: String(err) });
      logger.error({ err, connection_id, fileId: file.file_id }, "fasten file ingest failed");
    }
  }

  // Honest reporting: only mark synced when at least one file landed cleanly.
  // If every file failed we set status=error so an operator notices instead
  // of silently believing the sync worked.
  if (succeeded === 0 && totalFiles > 0) {
    // Persist failed_files so the operator can still retry once the upstream
    // problem clears (e.g. provider 5xxs that resolve later).
    const updatedMeta: ConnectionMetadata = {
      ...existingMeta,
      last_task_id: taskId,
      failed_files: failedFiles,
      partial_audited_at: undefined,
    };
    await db
      .update(fastenConnectionsTable)
      .set({ metadata: updatedMeta })
      .where(eq(fastenConnectionsTable.id, connection_id));
    await markError(
      connection_id,
      `All ${totalFiles} bulk-export files failed to ingest${lastError ? `: ${lastError}` : ""}`,
    );
    return;
  }

  // Success or partial: persist failed_files + task_id so a retry-failed call
  // has what it needs. Clear them on full success so we don't keep stale data.
  const isPartial = succeeded < totalFiles;
  const updatedMeta: ConnectionMetadata = {
    ...existingMeta,
    last_task_id: taskId,
    failed_files: isPartial ? failedFiles : [],
    // Clearing partial_audited_at on a full success makes the next Partial
    // (if it ever happens) eligible for the >24h alert again.
    partial_audited_at: isPartial ? existingMeta.partial_audited_at : undefined,
  };

  await db
    .update(fastenConnectionsTable)
    .set({
      status: "synced",
      last_synced_at: new Date(),
      // For retry-failed runs, ADD the freshly-ingested resources to whatever
      // the prior run got — replacing would lie ("0 resources" right after a
      // successful retry that grabbed the missing files).
      last_resource_count: retry_failed_only
        ? (conn.last_resource_count ?? 0) + totalResources
        : totalResources,
      last_error: isPartial ? `Partial: ${succeeded}/${totalFiles} files ingested` : null,
      metadata: updatedMeta,
      updated_at: new Date(),
    })
    .where(eq(fastenConnectionsTable.id, connection_id));

  await auditLog("fasten_connection", String(connection_id), "sync_completed", {
    document_id: lastDocId,
    files_ingested: succeeded,
    files_failed: totalFiles - succeeded,
    resource_count: totalResources,
    retry_failed_only: !!retry_failed_only,
  });
}

/**
 * Surface partial Fasten syncs that have been sitting unresolved for more
 * than 24h. Writes one audit_log row per stale connection (deduped via
 * `metadata.partial_audited_at`) so the daily ops review catches missing
 * medical records before they become a deadline problem.
 *
 * Called periodically from the worker loop (every hour). Idempotent —
 * an already-audited stale partial is skipped until the next time it
 * goes Partial again.
 */
export async function auditStaleFastenPartials(opts?: { thresholdMs?: number }): Promise<number> {
  const thresholdMs = opts?.thresholdMs ?? 24 * 60 * 60 * 1000;
  const cutoff = new Date(Date.now() - thresholdMs);

  const stale = await db
    .select({
      id: fastenConnectionsTable.id,
      lead_id: fastenConnectionsTable.lead_id,
      firm_id: fastenConnectionsTable.firm_id,
      portal_name: fastenConnectionsTable.portal_name,
      last_error: fastenConnectionsTable.last_error,
      updated_at: fastenConnectionsTable.updated_at,
      metadata: fastenConnectionsTable.metadata,
    })
    .from(fastenConnectionsTable)
    .where(
      and(
        eq(fastenConnectionsTable.status, "synced"),
        // Partial last_error is the operator-UX contract — see fasten-job.ts.
        sql`${fastenConnectionsTable.last_error} LIKE 'Partial:%'`,
        lt(fastenConnectionsTable.updated_at, cutoff),
      ),
    );

  let auditedNow = 0;
  for (const row of stale) {
    const meta = readMetadata(row.metadata);
    if (meta.partial_audited_at) continue; // already alerted; skip until cleared

    // Use a raw insert into audit_log so we can stamp severity=high directly
    // (the audit() helper takes free-form details only).
    await db.insert(auditLogTable).values({
      entity_type: "fasten_connection",
      entity_id: String(row.id),
      action: "stale_partial_sync_unresolved",
      details: {
        lead_id: row.lead_id,
        firm_id: row.firm_id,
        portal_name: row.portal_name,
        last_error: row.last_error,
        unresolved_since: row.updated_at?.toISOString?.() ?? null,
        threshold_hours: Math.round(thresholdMs / 3_600_000),
        severity: "high",
        message:
          "Fasten sync left in Partial state for >24h — missing medical records may have not been retried. Open the lead-detail Fasten card and click 'Retry Failed Files'.",
      },
    });

    // Stamp the audited timestamp inside metadata so we don't re-fire the
    // same alert on the next hourly tick. Cleared next time the connection
    // returns to a healthy 'synced' state.
    //
    // Use jsonb_set so we only touch the partial_audited_at key — a
    // read-modify-write of the whole metadata object would race with the
    // sync worker writing failed_files / last_task_id / last_synced_at
    // and silently drop those keys. The isNull guard keeps the audit
    // idempotent across concurrent hourly ticks.
    const stampedAt = new Date().toISOString();
    await db
      .update(fastenConnectionsTable)
      .set({
        metadata: sql`jsonb_set(coalesce(${fastenConnectionsTable.metadata}, '{}'::jsonb), '{partial_audited_at}', to_jsonb(${stampedAt}::text), true)`,
      })
      .where(
        and(
          eq(fastenConnectionsTable.id, row.id),
          isNull(sql`${fastenConnectionsTable.metadata}->>'partial_audited_at'`),
        ),
      );
    void (meta satisfies ConnectionMetadata);

    auditedNow += 1;
  }

  if (auditedNow > 0) {
    logger.warn({ auditedNow, total_stale: stale.length }, "Stale Fasten partial syncs audited");
  }
  return auditedNow;
}
