import { Router } from "express";
import { db, fastenConnectionsTable, leadsTable, firmPortalConfigsTable } from "@workspace/db";
import { eq, and, desc } from "drizzle-orm";
import { badRequest, notFound } from "../../lib/http-errors";
import { portalAuthMiddleware, requirePortalMfa, writePortalAudit, getClientIp, tortTypeToSlug, getPortalBaseUrl } from "../../lib/portal-auth";
import {
  createConnectUrl,
  isAnyBackendConfigured,
  FastenNotConfiguredError,
  FastenOnpremNotConfiguredError,
  type FastenBackend,
} from "../../lib/fasten";
import { enqueueJob } from "../../lib/queue";
import { logger } from "../../lib/logger";

const router = Router();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function getFastenConfig(firmId: number, tortType: string) {
  const [cfg] = await db
    .select({
      fasten_enabled: firmPortalConfigsTable.fasten_enabled,
      fasten_backend: firmPortalConfigsTable.fasten_backend,
    })
    .from(firmPortalConfigsTable)
    .where(
      and(
        eq(firmPortalConfigsTable.firm_id, firmId),
        eq(firmPortalConfigsTable.tort_type, tortType),
      ),
    );
  return cfg ?? null;
}

// ---------------------------------------------------------------------------
// GET /portal/fasten/status
// Returns whether Fasten is enabled for this lead's tort type + lists
// the lead's existing provider connections.
// ---------------------------------------------------------------------------
router.get("/status", portalAuthMiddleware, requirePortalMfa, async (req, res) => {
  const pu = req.portalUser!;

  const [lead] = await db
    .select({ tort_type: leadsTable.tort_type })
    .from(leadsTable)
    .where(eq(leadsTable.id, pu.lead_id));

  if (!lead) {
    notFound(res, "Lead not found");
    return;
  }

  const cfg = await getFastenConfig(pu.firm_id, lead.tort_type ?? "");

  // If no config row exists or Fasten disabled for this tort, report disabled.
  if (!cfg?.fasten_enabled) {
    res.json({ enabled: false, connections: [] });
    return;
  }

  // Check at least one backend is actually configured (env vars present).
  const backends = await isAnyBackendConfigured();
  if (!backends.any) {
    res.json({ enabled: false, reason: "fasten_not_configured", connections: [] });
    return;
  }

  const connections = await db
    .select({
      id: fastenConnectionsTable.id,
      portal_id: fastenConnectionsTable.portal_id,
      portal_name: fastenConnectionsTable.portal_name,
      backend: fastenConnectionsTable.backend,
      status: fastenConnectionsTable.status,
      last_synced_at: fastenConnectionsTable.last_synced_at,
      last_resource_count: fastenConnectionsTable.last_resource_count,
      created_at: fastenConnectionsTable.created_at,
    })
    .from(fastenConnectionsTable)
    .where(
      and(
        eq(fastenConnectionsTable.lead_id, pu.lead_id),
        eq(fastenConnectionsTable.firm_id, pu.firm_id),
      ),
    )
    .orderBy(desc(fastenConnectionsTable.updated_at));

  await writePortalAudit({
    portal_user_id: pu.id,
    admin_user_id: pu.impersonation ? pu.admin_id : null,
    lead_id: pu.lead_id,
    firm_id: pu.firm_id,
    action: "portal.view_fasten_status",
    ip: getClientIp(req),
    user_agent: req.headers["user-agent"],
  });

  res.json({
    enabled: true,
    backend: cfg.fasten_backend ?? "onprem",
    connections: connections.map(c => ({
      id: c.id,
      name: c.portal_name ?? c.portal_id ?? "Healthcare Provider",
      backend: c.backend,
      status: c.status,
      status_label: friendlyStatus(c.status),
      needs_attention: ["reauth", "error"].includes(c.status),
      last_synced_at: c.last_synced_at,
      records_count: c.last_resource_count ?? 0,
      connected_at: c.created_at,
    })),
  });
});

// ---------------------------------------------------------------------------
// POST /portal/fasten/connect
// Patient initiates a SMART on FHIR / OAuth connection.
// Returns { connect_url } — client redirects the patient browser to this URL.
// Body: { brand_id?: string, portal_name?: string }
// brand_id is required when the backend is "connect" (Fasten SaaS), optional
// for "onprem" (the on-prem UI handles provider selection itself).
// ---------------------------------------------------------------------------
router.post("/connect", portalAuthMiddleware, requirePortalMfa, async (req, res) => {
  const pu = req.portalUser!;

  const [lead] = await db
    .select({ tort_type: leadsTable.tort_type })
    .from(leadsTable)
    .where(eq(leadsTable.id, pu.lead_id));

  if (!lead) {
    notFound(res, "Lead not found");
    return;
  }

  const cfg = await getFastenConfig(pu.firm_id, lead.tort_type ?? "");
  if (!cfg?.fasten_enabled) {
    res.status(403).json({
      status: "error",
      code: "FASTEN_DISABLED",
      message: "Health provider connections are not enabled for your case type.",
    });
    return;
  }

  const chosenBackend: FastenBackend = cfg.fasten_backend === "connect" ? "connect" : "onprem";
  const body = (req.body ?? {}) as { brand_id?: string; portal_name?: string };
  const { brand_id, portal_name } = body;

  if (chosenBackend === "connect" && !brand_id) {
    badRequest(res, "brand_id is required for Fasten Connect backend");
    return;
  }

  // Build redirect URI pointing at the portal fasten callback.
  const proto = req.header("x-forwarded-proto") || (req.secure ? "https" : "http");
  const host = req.header("x-forwarded-host") || req.header("host") || "localhost";
  const redirectUri = `${proto}://${host}/api/portal/fasten/callback`;

  // Unique external ID for Fasten to correlate the callback.
  const externalId = `portal:${pu.firm_id}:${pu.lead_id}:${Date.now().toString(36)}`;

  let result: { url: string; state: string; backend: FastenBackend };
  try {
    result = await createConnectUrl({
      backend: chosenBackend,
      brandId: brand_id ?? "",
      redirectUri,
      externalId,
    });
  } catch (err) {
    if (err instanceof FastenNotConfiguredError || err instanceof FastenOnpremNotConfiguredError) {
      res.status(503).json({
        status: "error",
        code: "FASTEN_NOT_CONFIGURED",
        message: "Health provider connections are temporarily unavailable. Please contact your case manager.",
      });
      return;
    }
    logger.error({ err, lead_id: pu.lead_id, backend: chosenBackend }, "portal fasten createConnectUrl failed");
    res.status(502).json({ status: "error", code: "FASTEN_API_ERROR", message: "Unable to initiate provider connection." });
    return;
  }

  const portalKey = brand_id ?? `onprem:${pu.lead_id}:${Date.now().toString(36)}`;

  await db
    .insert(fastenConnectionsTable)
    .values({
      firm_id: pu.firm_id,
      lead_id: pu.lead_id,
      backend: chosenBackend,
      portal_id: portalKey,
      portal_name: portal_name ?? brand_id ?? "Healthcare Provider",
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

  await writePortalAudit({
    portal_user_id: pu.id,
    admin_user_id: pu.impersonation ? pu.admin_id : null,
    lead_id: pu.lead_id,
    firm_id: pu.firm_id,
    action: "portal.fasten_connect_initiated",
    ip: getClientIp(req),
    user_agent: req.headers["user-agent"],
    metadata: { backend: chosenBackend, portal_id: portalKey, external_id: externalId },
  });

  res.json({
    connect_url: result.url,
    state: result.state,
    backend: result.backend,
  });
});

// ---------------------------------------------------------------------------
// GET /portal/fasten/callback
// OAuth redirect target — called by the patient's browser after completing
// the Fasten OAuth flow. NOT protected by portalAuthMiddleware: the patient's
// browser arrives here mid-OAuth with no Bearer token.
// State-based lookup only (same approach as /api/fasten/callback in CRM).
// Redirects patient to portal records page on completion.
// ---------------------------------------------------------------------------
router.get("/callback", async (req, res) => {
  const state = String(req.query.state ?? "").trim();
  const orgConnectionId = String(
    req.query.org_connection_id ?? req.query.source_id ?? "",
  ).trim();

  if (!state) {
    res.status(400).send("Missing state parameter");
    return;
  }

  // Find the pending connection row whose saved state matches.
  // We query all connections and filter in-process so we don't need to index
  // the state value (it's stored inside the metadata jsonb column).
  const allPending = await db
    .select()
    .from(fastenConnectionsTable)
    .where(eq(fastenConnectionsTable.status, "pending"));

  const conn = allPending.find(
    (r) => (r.metadata as { state?: string } | null)?.state === state,
  );

  if (!conn) {
    // State is either expired or already used — redirect to portal login.
    const base = getPortalBaseUrl();
    res.redirect(`${base}?error=invalid_state`);
    return;
  }

  // Mark as active and persist the org_connection_id from Fasten.
  await db
    .update(fastenConnectionsTable)
    .set({
      org_connection_id: orgConnectionId || conn.org_connection_id,
      status: orgConnectionId ? "active" : conn.status,
      updated_at: new Date(),
    })
    .where(eq(fastenConnectionsTable.id, conn.id));

  // Auto-enqueue the first sync if we have a handle to use.
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
      logger.warn({ err, connectionId: conn.id }, "Portal fasten auto-sync enqueue failed");
    }
  }

  // Write audit entry using just IDs (no portal JWT context here).
  await writePortalAudit({
    portal_user_id: null,
    lead_id: conn.lead_id,
    firm_id: conn.firm_id,
    action: "portal.fasten_connected",
    ip: getClientIp(req),
    user_agent: req.headers["user-agent"],
    metadata: { connection_id: conn.id, org_connection_id: orgConnectionId, backend: conn.backend },
  });

  // Build the return URL: portal records page with ?connected=1 flag.
  const [lead] = await db
    .select({ tort_type: leadsTable.tort_type })
    .from(leadsTable)
    .where(eq(leadsTable.id, conn.lead_id));

  const slug = tortTypeToSlug(lead?.tort_type ?? "portal");
  const portalBase = getPortalBaseUrl();
  res.redirect(`${portalBase}/${slug}/records?connected=1`);
});

// ---------------------------------------------------------------------------
// DELETE /portal/fasten/connections/:id
// Patient revokes one of their own provider connections.
// Scoped to the portal user's lead — cannot revoke another patient's connection.
// ---------------------------------------------------------------------------
router.delete("/connections/:id", portalAuthMiddleware, requirePortalMfa, async (req, res) => {
  const pu = req.portalUser!;
  const connectionId = parseInt(String(req.params["id"]), 10);
  if (isNaN(connectionId)) {
    badRequest(res, "Invalid connection id");
    return;
  }

  const [conn] = await db
    .select({ id: fastenConnectionsTable.id, status: fastenConnectionsTable.status })
    .from(fastenConnectionsTable)
    .where(
      and(
        eq(fastenConnectionsTable.id, connectionId),
        eq(fastenConnectionsTable.lead_id, pu.lead_id),
        eq(fastenConnectionsTable.firm_id, pu.firm_id),
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

  await writePortalAudit({
    portal_user_id: pu.id,
    admin_user_id: pu.impersonation ? pu.admin_id : null,
    lead_id: pu.lead_id,
    firm_id: pu.firm_id,
    action: "portal.fasten_disconnected",
    ip: getClientIp(req),
    user_agent: req.headers["user-agent"],
    metadata: { connection_id: connectionId },
  });

  res.json({ ok: true });
});

function friendlyStatus(status: string): string {
  const map: Record<string, string> = {
    pending: "Connecting…",
    active: "Connected",
    syncing: "Syncing Records",
    synced: "Records Retrieved",
    reauth: "Reconnection Required",
    revoked: "Disconnected",
    error: "Connection Error",
  };
  return map[status] ?? status;
}

export default router;
