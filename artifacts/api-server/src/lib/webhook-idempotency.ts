/**
 * Inbound provider webhook idempotency. Providers retry on 5xx / timeout,
 * so without this every Stripe/Telnyx/Vapi/Fasten/DocuSign retry creates
 * duplicate rows in `sms_messages` / `fax_events` / `email_events` and
 * re-fires the downstream automations.
 *
 * Contract:
 *   `await markWebhookProcessed({ provider, externalEventId, ... })`
 *
 * Returns `true` if THIS call is the first to claim the (provider,
 * external_event_id) pair — the caller may proceed to mutate state.
 * Returns `false` if another call already claimed it (or if no external id
 * could be extracted — we fail-closed: better to drop a no-id event than
 * double-process every retry of one).
 *
 * The Postgres unique index on the ledger is the source of truth; we treat
 * a unique-violation as the "lost the race" outcome.
 */
import { db, processedWebhookEventsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { logger } from "./logger";

export interface MarkWebhookOptions {
  provider: string;
  externalEventId: string | null | undefined;
  firmId?: number | null;
  integrationId?: number | null;
  eventType?: string | null;
}

export async function markWebhookProcessed(opts: MarkWebhookOptions): Promise<boolean> {
  const { provider, externalEventId, firmId = null, integrationId = null, eventType = null } = opts;
  if (!externalEventId || typeof externalEventId !== "string" || externalEventId.length === 0) {
    // No id from the provider — we cannot dedup. Decline to claim it; the
    // caller's catch-all logging will record the skip. This is safer than
    // letting a no-id retry land twice and corrupt downstream tables.
    logger.warn({ provider, eventType }, "webhook idempotency: skipping — provider did not supply an external_event_id");
    return false;
  }
  try {
    const [row] = await db
      .insert(processedWebhookEventsTable)
      .values({
        provider,
        external_event_id: externalEventId,
        firm_id: firmId ?? null,
        integration_id: integrationId ?? null,
        event_type: eventType ?? null,
      })
      .onConflictDoNothing({ target: [processedWebhookEventsTable.provider, processedWebhookEventsTable.external_event_id] })
      .returning({ id: processedWebhookEventsTable.id });
    if (!row) {
      // Conflict — another concurrent (or earlier) call already claimed it.
      // Caller should ack 200 and skip state mutation.
      logger.info(
        { provider, externalEventId, eventType },
        "webhook idempotency: duplicate retry suppressed",
      );
      return false;
    }
    return true;
  } catch (err) {
    // If the dedup itself fails (DB down, table missing pre-migration),
    // fail OPEN so we don't drop legitimate first-time events. The cost of
    // a duplicate row during a DB blip is finite; the cost of silently
    // dropping production webhooks is unbounded.
    logger.error(
      { err, provider, externalEventId },
      "webhook idempotency: ledger write failed — falling open to allow event through",
    );
    return true;
  }
}

/**
 * Release a previously-claimed (provider, external_event_id) pair so the
 * provider's next retry is NOT suppressed. Call this when the handler claimed
 * the event but then failed to apply it (and you intend to return a 5xx asking
 * the provider to retry). The underlying pipeline transitions are
 * `event_key`-idempotent, so a retry that eventually succeeds cannot
 * double-apply. No-op when there is no external id to release.
 */
export async function releaseWebhookClaim(opts: {
  provider: string;
  externalEventId: string | null | undefined;
}): Promise<boolean> {
  const { provider, externalEventId } = opts;
  if (!externalEventId || typeof externalEventId !== "string" || externalEventId.length === 0) {
    // Nothing to release (no external id was claimed). Treat as success: the
    // caller's 5xx retry will not be suppressed because no ledger row exists.
    return true;
  }
  try {
    await db
      .delete(processedWebhookEventsTable)
      .where(
        and(
          eq(processedWebhookEventsTable.provider, provider),
          eq(processedWebhookEventsTable.external_event_id, externalEventId),
        ),
      );
    return true;
  } catch (err) {
    // The claim could NOT be released. The provider's retry will now be
    // suppressed as a duplicate, so this single event is at risk of being
    // dropped. Surface it loudly so an operator can requeue it — do not pretend
    // it succeeded.
    logger.error(
      { err, provider, externalEventId },
      "CRITICAL webhook idempotency: failed to release claim — provider retry will be suppressed and this event may be dropped; manual requeue may be required",
    );
    return false;
  }
}
