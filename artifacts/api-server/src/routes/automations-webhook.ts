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
  } catch (err: any) {
    logger.error({ err: err?.message }, "automations webhook lookup failed");
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
    const { createHmac } = await import("node:crypto");
    const rawBody = JSON.stringify(req.body);
    const expected = "sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex");
    // Constant-time comparison to prevent timing attacks
    const crypto = await import("node:crypto");
    const sigOk = crypto.timingSafeEqual(
      Buffer.from(providedSig, "utf8"),
      Buffer.from(expected, "utf8")
    );
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
  } catch (err: any) {
    logger.error({ err: err?.message }, "webhook dispatch import failed");
  }
});

export default router;
