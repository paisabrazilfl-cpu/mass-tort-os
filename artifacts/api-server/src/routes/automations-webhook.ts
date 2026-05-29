/**
 * automations-webhook.ts — PUBLIC router (no JWT required)
 * Mounted at /api/automations BEFORE authMiddleware in routes/index.ts.
 *
 * Only exposes POST /webhook/:slugOrId — everything else requires auth.
 * Security: HMAC-SHA256 slug+secret per workflow. Unknown slugs return 200
 * to prevent workflow ID enumeration.
 */
import { Router } from "express";
import { pool } from "@workspace/db";
import { logger } from "../lib/logger";

const router = Router();

router.post("/webhook/:slugOrId", async (req, res) => {
  const slugOrId = req.params.slugOrId ?? "";
  const providedSig = req.headers["x-mtos-signature"] as string | undefined;

  // Rate limit: max 100 chars on slug to prevent DoS via long param
  if (!slugOrId || slugOrId.length > 100) {
    res.json({ ok: true }); // silent reject
    return;
  }

  // Look up enabled trigger.webhook workflow by numeric id OR slug in trigger_config
  let wf: { id: number; trigger_config: unknown } | null = null;
  try {
    const raw = await pool.query<{ id: number; trigger_config: unknown }>(
      `SELECT id, trigger_config FROM automation_workflows
       WHERE enabled = true
         AND trigger_type = 'trigger.webhook'
         AND (id::text = $1 OR trigger_config->>'slug' = $1)
       LIMIT 1`,
      [slugOrId]
    );
    wf = raw.rows[0] ?? null;
  } catch (err: unknown) {
    logger.error({ err }, "automations webhook lookup failed");
    res.json({ ok: true }); // fail silently — don't leak DB errors
    return;
  }

  // Unknown slug → 200 (no enumeration, no timing leak via DB hit difference)
  if (!wf) {
    res.json({ ok: true });
    return;
  }

  // Verify HMAC-SHA256 if a secret is configured on this workflow
  const config = (wf.trigger_config ?? {}) as Record<string, unknown>;
  const secret = typeof config["secret"] === "string" ? config["secret"] : null;

  if (secret) {
    if (!providedSig) {
      res.status(401).json({ error: "x-mtos-signature header required" });
      return;
    }
    // Use the EXACT bytes the caller signed. JSON.stringify(req.body) was
    // the previous implementation; that reorders object keys and drops
    // insignificant whitespace, so every legitimate webhook silently 401s.
    // app.ts attaches rawBody for /api/automations/webhook/* alongside the
    // existing /api/webhooks/* capture.
    const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody;
    if (!rawBody || rawBody.length === 0) {
      logger.warn({ slugOrId, workflowId: wf.id }, "automations webhook: raw body missing — body parser misconfig");
      res.status(401).json({ error: "Raw body required for signature verification" });
      return;
    }
    const { createHmac, timingSafeEqual } = await import("node:crypto");
    const expected = "sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex");
    const providedBuf = Buffer.from(providedSig, "utf8");
    const expectedBuf = Buffer.from(expected, "utf8");
    // timingSafeEqual throws if the buffers differ in length; check first so
    // a malformed header doesn't surface as a 500.
    const sigOk =
      providedBuf.length === expectedBuf.length &&
      timingSafeEqual(providedBuf, expectedBuf);
    if (!sigOk) {
      res.status(401).json({ error: "Invalid signature" });
      return;
    }
  }

  // Respond 200 immediately — provider won't wait for workflow to complete
  res.json({ ok: true, workflow_id: wf.id });

  // Fire-and-forget dispatch
  try {
    const { dispatchTrigger } = await import("../lib/automations/dispatch");
    dispatchTrigger("trigger.webhook", {
      input: { body: req.body, headers: req.headers, slug: slugOrId },
      firmId: null,
      source: "automations-webhook.public",
    }).catch((err: unknown) => {
      logger.error({ err, workflowId: wf!.id }, "webhook dispatch failed");
    });
  } catch (err: unknown) {
    logger.error({ err }, "webhook dispatch import failed");
  }
});

export default router;
