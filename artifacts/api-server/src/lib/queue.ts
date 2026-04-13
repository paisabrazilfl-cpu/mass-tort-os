import { db, jobQueueTable } from "@workspace/db";
import { eq, sql, and } from "drizzle-orm";
import { logger } from "./logger";

export type JobType =
  | "create_case"
  | "ingest_file"
  | "analyze_case";

export interface JobPayload {
  create_case: { case_id: string; data: Record<string, unknown> };
  ingest_file: { case_id: string; file_name: string; content: string; content_type?: string };
  analyze_case: { case_id: string };
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
  const result = await db.execute(sql`
    UPDATE job_queue
    SET status = 'processing', started_at = NOW()
    WHERE id = (
      SELECT id FROM job_queue
      WHERE status = 'pending'
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

export async function markJobFailed(id: number, error: string) {
  await db
    .update(jobQueueTable)
    .set({ status: "failed", error, completed_at: new Date() })
    .where(eq(jobQueueTable.id, id));
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
