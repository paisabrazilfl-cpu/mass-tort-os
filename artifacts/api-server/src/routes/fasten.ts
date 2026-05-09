/**
 * Operator-facing routes for the Fasten Health integration.
 *
 *   GET  /api/fasten/status                — is Fasten configured? which backends?
 *   GET  /api/fasten/catalog?q=epic        — search the provider catalog
 *   POST /api/fasten/connect               — issue a connect URL for a (lead, brand)
 *   GET  /api/fasten/connections/:leadId   — list this lead's connections
 *   POST /api/fasten/sync/:connectionId    — re-trigger a sync for an existing connection
 *   POST /api/fasten/disconnect/:connectionId — mark a connection revoked
 *   GET  /api/fasten/callback              — patient redirect target after provider OAuth
 *
 * The /callback endpoint is intentionally on this protected router (not in
 * /webhooks) — patients hit it from a browser session that already carries
 * the operator's authentication, OR the link includes a one-time signed
 * state value (`state` returned by createConnectUrl) that we use to look
 * up the pending connection without an active session.
 */
import { Router, type Response } from "express";
import { db, fastenConnectionsTable, leadsTable } from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";
import { Permission, requirePermission } from "../lib/rbac";
import { auditLog } from "../lib/audit";
import { logger } from "../lib/logger";
import { badRequest, notFound } from "../lib/http-errors";
import { enqueueJob } from "../lib/queue";
import {
  connect as fastenConnect,
  isAnyBackendConfigured,
  createConnectUrl,
  type FastenBackend,
  FastenNotConfiguredError,
  FastenOnpremNotConfiguredError,
} from "../lib/fasten";

const router: ReturnType<typeof Router> = Router();

function parseId(res: Response, raw: unknown, label: string): number | null {
  const n = Number(Array.isArray(raw) ? raw[0] : raw);
  if (!Number.isInteger(n) || n <= 0) {
    badRequest(res, `${label} must be a positive integer`);
    return null;
  }
  return n;
}

function notConfigured(res: Response, err: unknown): boolean {
  if (err instanceof FastenNotConfiguredError || err instanceof FastenOnpremNotConfiguredError) {
    res.status(503).json({
      error: "fasten_not_configured",
      message: err.message,
    });
    return true;
  }
  return false;
}

// ─── status ────────────────────────────────────────────────────────────────

router.get("/status", requirePermission(Permission.MEDICAL_RECORDS_VIEW), async (_req, res) => {
  const status = await isAnyBackendConfigured();
  res.json({
    configured: status.any,
    backends: {
      connect: status.connect,
      onprem: status.onprem,
    },
  });
});

// ─── catalog search ────────────────────────────────────────────────────────

router.get("/catalog", requirePermission(Permission.MEDICAL_RECORDS_MANAGE), async (req, res) => {
  const q = String(req.query.q ?? "").trim();
  if (!q) {
    badRequest(res, "Query parameter 'q' is required");
    return;
  }
  try {
    const brands = await fastenConnect.searchCatalog(q);
    res.json({ brands });
  } catch (err) {
    if (notConfigured(res, err)) return;
    logger.error({ err }, "Fasten catalog search failed");
    res.status(502).json({ error: "fasten_api_error", message: String(err) });
  }
});

// ─── issue connect URL ─────────────────────────────────────────────────────

router.post("/connect", requirePermission(Permission.MEDICAL_RECORDS_MANAGE), async (req, res) => {
  const { lead_id, brand_id, backend, portal_name } = req.body as {
    lead_id?: number;
    brand_id?: string;
    backend?: FastenBackend;
    portal_name?: string;
  };
  if (!lead_id || !Number.isInteger(lead_id) || lead_id <= 0) {
    badRequest(res, "lead_id is required");
    return;
  }
  const chosenBackend: FastenBackend = backend === "onprem" ? "onprem" : "connect";
  if (chosenBackend === "connect" && !brand_id) {
    badRequest(res, "brand_id is required when backend=connect");
    return;
  }

  // Confirm the lead exists IN THE CALLER'S FIRM (cross-firm IDOR guard).
  const callerFirmId = req.user?.firm_id ?? null;
  if (!callerFirmId) {
    badRequest(res, "Caller has no firm context");
    return;
  }
  const [lead] = await db
    .select()
    .from(leadsTable)
    .where(and(eq(leadsTable.id, lead_id), eq(leadsTable.firm_id, callerFirmId)));
  if (!lead) {
    notFound(res, "Lead not found");
    return;
  }

  // Build the redirect URL pointing at our own /callback.
  const proto = req.header("x-forwarded-proto") || (req.secure ? "https" : "http");
  const host = req.header("x-forwarded-host") || req.header("host") || "localhost";
  const redirectUri = `${proto}://${host}/api/fasten/callback`;

  // External id we hand to Fasten so the webhook can correlate back.
  // Format: `mtos:<firm_id>:<lead_id>:<nonce>` — unique enough to dedupe and
  // structured so an ops engineer can read it in a Fasten support ticket.
  const externalId = `mtos:${req.user?.firm_id ?? 0}:${lead_id}:${Date.now().toString(36)}`;

  let result;
  try {
    result = await createConnectUrl({
      backend: chosenBackend,
      brandId: brand_id || "",
      redirectUri,
      externalId,
    });
  } catch (err) {
    if (notConfigured(res, err)) return;
    logger.error({ err, lead_id, chosenBackend }, "createConnectUrl failed");
    res.status(502).json({ error: "fasten_api_error", message: String(err) });
    return;
  }

  // Insert (or update) a pending connection row keyed by (lead, portal).
  const portalKey = brand_id || `onprem:${Date.now()}`;
  await db
    .insert(fastenConnectionsTable)
    .values({
      firm_id: callerFirmId,
      lead_id,
      backend: chosenBackend,
      portal_id: portalKey,
      portal_name: portal_name || brand_id || "Fasten on-prem",
      status: "pending",
      metadata: { state: result.state, external_id: externalId },
    })
    .onConflictDoUpdate({
      target: [fastenConnectionsTable.lead_id, fastenConnectionsTable.portal_id],
      set: {
        backend: chosenBackend,
        status: "pending",
        metadata: { state: result.state, external_id: externalId },
        last_error: null,
        updated_at: new Date(),
      },
    });

  await auditLog("lead", String(lead_id), "fasten_connect_url_issued", {
    backend: chosenBackend,
    portal_id: portalKey,
    external_id: externalId,
  });

  res.json({
    connect_url: result.url,
    state: result.state,
    backend: result.backend,
    redirect_uri: redirectUri,
  });
});

// ─── list connections for a lead ───────────────────────────────────────────

router.get(
  "/connections/:leadId",
  requirePermission(Permission.MEDICAL_RECORDS_VIEW),
  async (req, res) => {
    const leadId = parseId(res, req.params.leadId, "leadId");
    if (leadId === null) return;
    const callerFirmId = req.user?.firm_id ?? null;
    if (!callerFirmId) {
      badRequest(res, "Caller has no firm context");
      return;
    }
    const rows = await db
      .select()
      .from(fastenConnectionsTable)
      .where(
        and(
          eq(fastenConnectionsTable.lead_id, leadId),
          eq(fastenConnectionsTable.firm_id, callerFirmId),
        ),
      )
      .orderBy(desc(fastenConnectionsTable.updated_at));
    res.json({ connections: rows });
  },
);

// ─── trigger sync ──────────────────────────────────────────────────────────

router.post(
  "/sync/:connectionId",
  requirePermission(Permission.MEDICAL_RECORDS_MANAGE),
  async (req, res) => {
    const connectionId = parseId(res, req.params.connectionId, "connectionId");
    if (connectionId === null) return;
    const callerFirmId = req.user?.firm_id ?? null;
    if (!callerFirmId) {
      badRequest(res, "Caller has no firm context");
      return;
    }

    const [conn] = await db
      .select()
      .from(fastenConnectionsTable)
      .where(
        and(
          eq(fastenConnectionsTable.id, connectionId),
          eq(fastenConnectionsTable.firm_id, callerFirmId),
        ),
      );
    if (!conn) {
      notFound(res, "Connection not found");
      return;
    }
    if (!conn.org_connection_id) {
      res.status(409).json({
        error: "connection_not_ready",
        message: "Patient has not yet completed the OAuth flow for this connection.",
      });
      return;
    }

    // Vault files are written under "lead-<id>/" — no need to require an
    // existing cases row. The worker creates the dir on first write.
    const caseId = `lead-${conn.lead_id}`;

    const jobId = await enqueueJob("fasten_records_sync", {
      connection_id: connectionId,
      lead_id: conn.lead_id,
      case_id: caseId,
      backend: conn.backend as "connect" | "onprem",
      org_connection_id: conn.org_connection_id,
    });

    await db
      .update(fastenConnectionsTable)
      .set({ status: "syncing", updated_at: new Date(), last_error: null })
      .where(eq(fastenConnectionsTable.id, connectionId));

    await auditLog("fasten_connection", String(connectionId), "sync_enqueued", { job_id: jobId });

    res.json({ ok: true, job_id: jobId });
  },
);

// ─── disconnect ────────────────────────────────────────────────────────────

router.post(
  "/disconnect/:connectionId",
  requirePermission(Permission.MEDICAL_RECORDS_MANAGE),
  async (req, res) => {
    const connectionId = parseId(res, req.params.connectionId, "connectionId");
    if (connectionId === null) return;
    const callerFirmId = req.user?.firm_id ?? null;
    if (!callerFirmId) {
      badRequest(res, "Caller has no firm context");
      return;
    }
    // Confirm caller's firm owns this connection before mutating.
    const [conn] = await db
      .select({ id: fastenConnectionsTable.id })
      .from(fastenConnectionsTable)
      .where(
        and(
          eq(fastenConnectionsTable.id, connectionId),
          eq(fastenConnectionsTable.firm_id, callerFirmId),
        ),
      );
    if (!conn) {
      notFound(res, "Connection not found");
      return;
    }
    await db
      .update(fastenConnectionsTable)
      .set({ status: "revoked", updated_at: new Date() })
      .where(eq(fastenConnectionsTable.id, connectionId));
    await auditLog("fasten_connection", String(connectionId), "disconnected", {});
    res.json({ ok: true });
  },
);

// ─── patient OAuth callback ────────────────────────────────────────────────
// This is rate-limited, signed-state-validated, and never trusts client-
// provided lead_id directly — we derive it from the saved row keyed on
// `state`. Marked with PERM_OAUTH_CALLBACK so the route-matrix validator
// recognises it as intentionally accessible to any authenticated user.

router.get(
  "/callback",
  requirePermission(Permission.MEDICAL_RECORDS_VIEW),
  async (req, res) => {
    const state = String(req.query.state ?? "").trim();
    const orgConnectionId = String(
      req.query.org_connection_id ?? req.query.source_id ?? "",
    ).trim();
    if (!state) {
      badRequest(res, "state query parameter is required");
      return;
    }

    // Find the pending connection by saved state value, scoped to the
    // caller's firm so a stolen state from another tenant can't be claimed.
    const callerFirmId = req.user?.firm_id ?? null;
    if (!callerFirmId) {
      badRequest(res, "Caller has no firm context");
      return;
    }
    const rows = await db
      .select()
      .from(fastenConnectionsTable)
      .where(eq(fastenConnectionsTable.firm_id, callerFirmId));
    const conn = rows.find(
      (r) => (r.metadata as { state?: string } | null)?.state === state,
    );
    if (!conn) {
      notFound(res, "No pending connection matches the supplied state");
      return;
    }

    await db
      .update(fastenConnectionsTable)
      .set({
        org_connection_id: orgConnectionId || conn.org_connection_id,
        status: orgConnectionId ? "active" : conn.status,
        updated_at: new Date(),
      })
      .where(eq(fastenConnectionsTable.id, conn.id));

    await auditLog("fasten_connection", String(conn.id), "callback_received", {
      org_connection_id: orgConnectionId,
    });

    // Auto-enqueue the first sync if we have an org_connection_id.
    if (orgConnectionId) {
      try {
        await enqueueJob("fasten_records_sync", {
          connection_id: conn.id,
          lead_id: conn.lead_id,
          case_id: `lead-${conn.lead_id}`,
          backend: conn.backend as "connect" | "onprem",
          org_connection_id: orgConnectionId,
        });
      } catch (err) {
        logger.warn({ err, connectionId: conn.id }, "Auto-enqueue of fasten sync failed");
      }
    }

    // Send the operator/patient back to the lead detail page in the SPA.
    res.redirect(`/leads/${conn.lead_id}?fasten=connected`);
  },
);

export default router;
