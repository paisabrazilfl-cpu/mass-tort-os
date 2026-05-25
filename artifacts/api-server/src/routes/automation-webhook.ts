/**
 * Public automation webhook trigger receiver.
 *
 * POST /api/automations/webhook/:slug
 *
 * Allows external systems (n8n, Zapier, Make, etc.) to trigger MTOS
 * automation workflows via HTTP. The slug + HMAC secret IS the credential —
 * no Bearer token or session cookie is required. Operators configure the
 * slug and optional secret in the workflow's trigger_config.
 *
 * Security model:
 *   - Slug lookup is limited to enabled workflows with trigger_type="trigger.webhook".
 *   - If trigger_config.secret is set, the request body MUST carry a valid
 *     X-MTOS-Signature: sha256=<hex> header (same scheme as outbound webhooks).
 *   - Without a secret the endpoint is open — operators should use secrets in production.
 *   - The workflow runs async (fire-and-forget); 202 is returned immediately so the
 *     caller never times out waiting for the automation to complete.
 *   - rawBody is captured for signature verification (see app.ts express.json verify).
 */

import { Router } from "express";
import crypto from "crypto";
import { db, automationWorkflowsTable } from "@workspace/db";
import { eq, and, sql } from "drizzle-orm";
import { markPublic } from "../lib/route-protection";
import { runWorkflow } from "../lib/automations/executor";
import { logger } from "../lib/logger";

const router = markPublic(Router(), "automation-webhook");

// Non-POST methods should never fall through to authMiddleware — return 405 instead.
router.all("/:slug", (req, res, next) => {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    res.status(405).json({ status: "error", code: "method_not_allowed", message: "Only POST is accepted on webhook trigger endpoints" });
    return;
  }
  next();
});

router.post("/:slug", async (req, res) => {
  const slug = String(req.params.slug ?? "").trim();
  if (!slug) {
    res.status(400).json({ status: "error", code: "slug_required", message: "Webhook slug is required" });
    return;
  }

  const [wf] = await db
    .select()
    .from(automationWorkflowsTable)
    .where(
      and(
        eq(automationWorkflowsTable.enabled, true),
        eq(automationWorkflowsTable.trigger_type, "trigger.webhook"),
        sql`${automationWorkflowsTable.trigger_config}->>'path' = ${slug}`,
      ),
    )
    .limit(1);

  if (!wf) {
    res.status(404).json({ status: "error", code: "webhook_not_found", message: "No active webhook workflow for this slug" });
    return;
  }

  const secret = (wf.trigger_config as Record<string, unknown>)?.secret;
  if (secret && typeof secret === "string") {
    const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody;
    if (!rawBody) {
      res.status(400).json({ status: "error", code: "raw_body_missing", message: "Could not read raw request body for signature verification" });
      return;
    }
    const sig = String(req.headers["x-mtos-signature"] ?? "");
    const expected = "sha256=" + crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
    const a = Buffer.from(expected, "utf8");
    const b = Buffer.from(sig.padEnd(expected.length, "\0"), "utf8");
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      logger.warn({ slug, workflowId: wf.id }, "automation webhook signature mismatch");
      res.status(401).json({ status: "error", code: "invalid_signature", message: "Webhook signature is invalid" });
      return;
    }
  }

  const input = (typeof req.body === "object" && req.body !== null ? req.body : {}) as Record<string, unknown>;

  runWorkflow({
    workflowId: wf.id,
    firmId: wf.firm_id,
    triggerSource: `webhook:${slug}`,
    input,
  }).catch((err) => {
    logger.error({ err, workflowId: wf.id, slug }, "automation webhook trigger run failed");
  });

  res.status(202).json({ ok: true, workflowId: wf.id, slug });
});

export default router;
