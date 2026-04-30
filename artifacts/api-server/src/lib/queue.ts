import { db, jobQueueTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { logger } from "./logger";

export type JobType =
  | "create_case"
  | "ingest_file"
  | "analyze_case"
  | "send_esign_packet"
  | "fax_med_records_request"
  | "send_workflow_email"
  | "send_workflow_sms";

export interface JobPayload {
  create_case: { case_id: string; data: Record<string, unknown>; created_by_user_id?: number | null };
  ingest_file: { case_id: string; file_name: string; content: string; content_type?: string };
  analyze_case: { case_id: string };
  send_esign_packet: {
    lead_id: number;
    template_id: number;
    envelope_id?: number;
    explicit_integration_id?: number | null;
  };
  fax_med_records_request: {
    lead_id: number;
    envelope_id: number;
    explicit_integration_id?: number | null;
  };
  send_workflow_email: {
    lead_id?: number;
    to: string;
    to_name?: string;
    subject: string;
    html: string;
    text?: string;
    explicit_integration_id?: number | null;
  };
  send_workflow_sms: {
    lead_id: number;
    body: string;
    firm_id?: number | null;
    source?: string;
  };
}

/**
 * Maximum retries for a transient/retryable failure before a job moves to
 * the `dead_letter` terminal status. Five attempts with exponential backoff
 * (2s, 4s, 8s, 16s, 32s) gives a total window of ~62 seconds before a
 * job is parked for human attention.
 */
export const MAX_RETRIES = 5;

/**
 * Returns the timestamp at which a job should next become claim-eligible
 * given how many times it has already been retried. Exponential backoff:
 * `2 ** retryCount` seconds, capped at 5 minutes.
 */
function backoffUntil(retryCount: number): Date {
  const baseSeconds = Math.min(2 ** Math.max(retryCount, 0), 300);
  return new Date(Date.now() + baseSeconds * 1000);
}

export async function enqueueJob<T extends JobType>(
  job_type: T,
  payload: JobPayload[T]
): Promise<number> {
  const [job] = await db
    .insert(jobQueueTable)
    .values({
      job_type,
      payload: payload as Record<string, unknown>,
      status: "pending",
    })
    .returning({ id: jobQueueTable.id });
  logger.info({ job_id: job.id, job_type }, "Job enqueued");
  return job.id;
}

export async function claimNextJob() {
  // Claim the oldest pending job whose `next_attempt_at` has elapsed (or
  // is NULL — fresh jobs). The new `job_queue_claim_ready_idx` covers
  // the WHERE + ORDER BY so this is an index range scan even at scale.
  const result = await db.execute(sql`
    UPDATE job_queue
    SET status = 'processing', started_at = NOW()
    WHERE id = (
      SELECT id FROM job_queue
      WHERE status = 'pending'
        AND (next_attempt_at IS NULL OR next_attempt_at <= NOW())
      ORDER BY created_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING *
  `);
  return result.rows[0] ?? null;
}

export async function markJobDone(id: number) {
  await db
    .update(jobQueueTable)
    .set({ status: "done", completed_at: new Date() })
    .where(eq(jobQueueTable.id, id));
}

/**
 * Mark a job failed.
 *
 * - If `retryable` is true and we haven't exhausted MAX_RETRIES, the job
 *   is re-queued back to `pending` with `retry_count` incremented and
 *   `next_attempt_at` pushed out by exponential backoff. The original
 *   `created_at` is preserved so the queue keeps FIFO fairness for
 *   same-priority jobs.
 * - Otherwise the job moves to terminal status `dead_letter` so it stops
 *   consuming worker capacity and can be inspected/requeued manually
 *   via the admin endpoint.
 *
 * Returns the new status so callers can log the outcome.
 */
export async function markJobFailed(
  id: number,
  error: string,
  opts: { retryable?: boolean } = {},
): Promise<"pending" | "dead_letter"> {
  const retryable = opts.retryable !== false; // default true — most thrown errors are transient

  // Read the current retry_count so we can decide whether to back off or
  // dead-letter. We do this in a single query to avoid races; concurrent
  // double-failures of the same job would be unusual since FOR UPDATE
  // SKIP LOCKED only hands out one worker per job, but the read+write
  // is still kept tight.
  const rows = await db
    .select({ retry_count: jobQueueTable.retry_count })
    .from(jobQueueTable)
    .where(eq(jobQueueTable.id, id))
    .limit(1);
  const currentRetries = rows[0]?.retry_count ?? 0;

  if (retryable && currentRetries < MAX_RETRIES) {
    const nextRetry = currentRetries + 1;
    const nextAt = backoffUntil(nextRetry);
    await db
      .update(jobQueueTable)
      .set({
        status: "pending",
        error,
        retry_count: nextRetry,
        next_attempt_at: nextAt,
        started_at: null,
      })
      .where(eq(jobQueueTable.id, id));
    logger.warn(
      { job_id: id, retry_count: nextRetry, next_at: nextAt.toISOString(), error },
      "Job re-queued with backoff",
    );
    return "pending";
  }

  await db
    .update(jobQueueTable)
    .set({
      status: "dead_letter",
      error,
      completed_at: new Date(),
    })
    .where(eq(jobQueueTable.id, id));
  logger.error(
    { job_id: id, retry_count: currentRetries, retryable, error },
    "Job dead-lettered (retries exhausted or non-retryable)",
  );
  return "dead_letter";
}

/**
 * Move a dead-lettered job back to `pending` so it gets picked up on the
 * next poll. Resets retry_count to 0 and clears next_attempt_at so the
 * fresh attempt is immediate. Used by the admin "retry job" endpoint.
 *
 * Returns true if the job was found and requeued, false otherwise.
 */
export async function requeueDeadLetterJob(id: number): Promise<boolean> {
  const result = await db
    .update(jobQueueTable)
    .set({
      status: "pending",
      retry_count: 0,
      next_attempt_at: null,
      started_at: null,
      completed_at: null,
      error: null,
    })
    .where(sql`${jobQueueTable.id} = ${id} AND ${jobQueueTable.status} = 'dead_letter'`)
    .returning({ id: jobQueueTable.id });
  if (result.length > 0) {
    logger.info({ job_id: id }, "Dead-lettered job requeued by admin");
    return true;
  }
  return false;
}

/**
 * Reset jobs that have been stuck in `processing` for longer than maxAgeMs.
 * Called periodically by the worker loop to recover from worker crashes /
 * autoscale container kills that left a job claimed but not finished.
 *
 * Reclaimed jobs go back to `pending` with retry_count incremented (so a
 * job that consistently kills its worker will eventually dead-letter
 * instead of looping forever).
 *
 * Returns the number of jobs reclaimed.
 */
export async function reclaimStaleProcessingJobs(maxAgeMs: number = 5 * 60 * 1000): Promise<number> {
  const seconds = Math.max(1, Math.floor(maxAgeMs / 1000));
  const result = await db.execute(sql`
    UPDATE job_queue
    SET status = CASE
          WHEN retry_count + 1 >= ${MAX_RETRIES} THEN 'dead_letter'
          ELSE 'pending'
        END,
        started_at = NULL,
        retry_count = retry_count + 1,
        next_attempt_at = NOW() + INTERVAL '5 seconds',
        error = COALESCE(error, '') || ' [reclaimed-stale]'
    WHERE status = 'processing'
      AND started_at IS NOT NULL
      AND started_at < NOW() - (${seconds} || ' seconds')::interval
    RETURNING id, status
  `);
  const count = result.rows?.length ?? 0;
  if (count > 0) {
    logger.warn({ count, maxAgeMs }, "Reclaimed stale processing jobs (likely from a crashed/killed worker)");
  }
  return count;
}

export async function getQueueStats() {
  const rows = await db
    .select({
      status: jobQueueTable.status,
      count: sql<number>`count(*)::int`,
    })
    .from(jobQueueTable)
    .groupBy(jobQueueTable.status);

  const stats: Record<string, number> = {};
  for (const row of rows) {
    stats[row.status] = row.count;
  }
  return stats;
}
