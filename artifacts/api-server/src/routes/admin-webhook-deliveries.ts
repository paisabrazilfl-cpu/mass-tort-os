/**
 * Webhook delivery log — admin visibility into outbound event dispatch
 * history. Every row in `webhook_deliveries` represents one HTTP attempt
 * to a configured automation integration.
 *
 * Routes:
 *   GET  /api/admin/webhook-deliveries        list with filters + pagination
 *   POST /api/admin/webhook-deliveries/:id/resend  re-fire the same payload
 */
import crypto from "crypto";
import { Router } from "express";
import { and, desc, eq, gte, lte, max, or, sql } from "drizzle-orm";
import { z } from "zod/v4";
import { db, integrationsTable, webhookDeliveriesTable } from "@workspace/db";
import { Permission, requirePermission } from "../lib/rbac";
import { badRequest, notFound } from "../lib/http-errors";
import { decrypt } from "../lib/encryption";

const router = Router();

const SIGNING_FIELD = "api_key";
const DISPATCH_TIMEOUT_MS = 5000;

function decryptApiKey(row: typeof integrationsTable.$inferSelect): string | null {
  const stored = ((row.config as { credentials?: Record<string, string> } | null)?.credentials || {}) as Record<string, string>;
  const cipher = stored[SIGNING_FIELD];
  if (!cipher) return null;
  try {
    const plain = decrypt(cipher, `integration:${SIGNING_FIELD}`, String(row.id));
    if (plain === "[DECRYPTION_ERROR]") return null;
    return plain;
  } catch {
    return null;
  }
}

function signPayload(secret: string, body: string): string {
  return "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex");
}

async function postWithTimeout(
  url: string,
  body: string,
  headers: Record<string, string>,
): Promise<{ status: number; latencyMs: number; error?: string }> {
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DISPATCH_TIMEOUT_MS);
  try {
    const r = await fetch(url, { method: "POST", body, headers, signal: controller.signal });
    return { status: r.status, latencyMs: Date.now() - start };
  } catch (err) {
    return {
      status: 0,
      latencyMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

const listQuerySchema = z.object({
  integration_id: z.coerce.number().int().positive().optional(),
  event: z.string().optional(),
  status: z.enum(["success", "failure", "all"]).optional().default("all"),
  since: z.string().datetime().optional(),
  until: z.string().datetime().optional(),
  page: z.coerce.number().int().min(1).optional().default(1),
  page_size: z.coerce.number().int().min(1).max(200).optional().default(50),
});

router.get(
  "/",
  requirePermission(Permission.INTEGRATIONS_MANAGE),
  async (req, res) => {
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) return badRequest(res, "Invalid query parameters");

    const { integration_id, event, status, since, until, page, page_size } = parsed.data;

    const conditions = [];
    if (integration_id !== undefined) {
      conditions.push(eq(webhookDeliveriesTable.integration_id, integration_id));
    }
    if (event) {
      conditions.push(eq(webhookDeliveriesTable.event, event));
    }
    if (status === "success") {
      conditions.push(
        sql`${webhookDeliveriesTable.status_code} >= 200 AND ${webhookDeliveriesTable.status_code} < 300`,
      );
    } else if (status === "failure") {
      conditions.push(
        sql`(${webhookDeliveriesTable.status_code} IS NULL OR ${webhookDeliveriesTable.status_code} < 200 OR ${webhookDeliveriesTable.status_code} >= 300)`,
      );
    }
    if (since) {
      conditions.push(gte(webhookDeliveriesTable.occurred_at, new Date(since)));
    }
    if (until) {
      conditions.push(lte(webhookDeliveriesTable.occurred_at, new Date(until)));
    }

    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const [rows, countResult] = await Promise.all([
      db
        .select({
          id: webhookDeliveriesTable.id,
          integration_id: webhookDeliveriesTable.integration_id,
          event: webhookDeliveriesTable.event,
          delivery_id: webhookDeliveriesTable.delivery_id,
          status_code: webhookDeliveriesTable.status_code,
          response_ms: webhookDeliveriesTable.response_ms,
          attempt: webhookDeliveriesTable.attempt,
          last_error: webhookDeliveriesTable.last_error,
          payload_hash: webhookDeliveriesTable.payload_hash,
          is_test: webhookDeliveriesTable.is_test,
          occurred_at: webhookDeliveriesTable.occurred_at,
          integration_name: integrationsTable.name,
          integration_provider: integrationsTable.provider,
        })
        .from(webhookDeliveriesTable)
        .leftJoin(
          integrationsTable,
          eq(webhookDeliveriesTable.integration_id, integrationsTable.id),
        )
        .where(where)
        .orderBy(desc(webhookDeliveriesTable.occurred_at))
        .limit(page_size)
        .offset((page - 1) * page_size),
      db
        .select({ count: sql<number>`COUNT(*)::int` })
        .from(webhookDeliveriesTable)
        .where(where),
    ]);

    res.json({
      status: "ok",
      data: {
        rows,
        page,
        page_size,
        total: countResult[0]?.count ?? 0,
      },
    });
  },
);

router.post(
  "/:id/resend",
  requirePermission(Permission.INTEGRATIONS_MANAGE),
  async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return badRequest(res, "Invalid delivery ID");

    const [delivery] = await db
      .select()
      .from(webhookDeliveriesTable)
      .where(eq(webhookDeliveriesTable.id, id));

    if (!delivery) return notFound(res, "Delivery record not found");

    const [integ] = await db
      .select()
      .from(integrationsTable)
      .where(eq(integrationsTable.id, delivery.integration_id));

    if (!integ) return notFound(res, "Integration not found");
    if (!integ.webhook_url) return badRequest(res, "Integration has no webhook URL");

    const storedPayload = delivery.payload as Record<string, unknown> | null;
    if (!storedPayload) return badRequest(res, "No payload stored for this delivery; cannot resend");

    const originalDeliveryId = delivery.delivery_id;

    const [chainMax] = await db
      .select({ maxAttempt: max(webhookDeliveriesTable.attempt) })
      .from(webhookDeliveriesTable)
      .where(
        or(
          eq(webhookDeliveriesTable.delivery_id, originalDeliveryId),
          sql`${webhookDeliveriesTable.payload}->>'resent_from' = ${originalDeliveryId}`,
        ),
      );

    const nextAttempt = (chainMax?.maxAttempt ?? delivery.attempt ?? 1) + 1;

    const newDeliveryId = crypto.randomUUID();
    const freshPayload = {
      ...storedPayload,
      delivery_id: newDeliveryId,
      timestamp: new Date().toISOString(),
      resent_from: delivery.delivery_id,
    };
    const body = JSON.stringify(freshPayload);
    const secret = decryptApiKey(integ);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "User-Agent": "MTOS-CRM/1.0",
      "X-MTOS-Event": delivery.event,
      "X-MTOS-Delivery": newDeliveryId,
      "X-MTOS-Resent": "true",
    };
    if (secret) headers["X-MTOS-Signature"] = signPayload(secret, body);

    const result = await postWithTimeout(integ.webhook_url, body, headers);
    const ok = result.status >= 200 && result.status < 300;
    const payloadHash = crypto.createHash("sha256").update(body).digest("hex");

    await db.insert(webhookDeliveriesTable).values({
      integration_id: integ.id,
      event: delivery.event,
      delivery_id: newDeliveryId,
      status_code: result.status || null,
      response_ms: result.latencyMs,
      attempt: nextAttempt,
      last_error: result.error ?? null,
      payload_hash: payloadHash,
      payload: freshPayload,
      is_test: delivery.is_test,
    });

    if (!ok) {
      req.log.warn(
        {
          integration_id: integ.id,
          event: delivery.event,
          response_status: result.status,
          error: result.error,
        },
        "Webhook resend failed",
      );
    }

    res.json({
      status: "ok",
      data: {
        delivery_id: newDeliveryId,
        response_status: result.status,
        latency_ms: result.latencyMs,
        signed: !!secret,
        success: ok,
        error: result.error ?? null,
      },
    });
  },
);

export default router;
