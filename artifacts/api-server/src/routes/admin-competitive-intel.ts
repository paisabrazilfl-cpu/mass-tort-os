/**
 * Competitive Intelligence routes (mounted at /api/admin/competitive-intel).
 *
 * Wraps SerpAPI's Google Ads Transparency Center engine. Lets the firm
 * 1) one-shot look up any advertiser id, and 2) maintain a watchlist of
 * competing plaintiff firms whose ad creatives they want to track over
 * time (used as a leading indicator for new MDLs).
 *
 * Endpoints:
 *   GET    /config                       { configured }
 *   POST   /lookup                       { advertiser_id | query } → live SerpAPI result
 *   GET    /watchlist                    list this firm's saved advertisers + last snapshot
 *   POST   /watchlist                    add advertiser to watchlist (fetches initial snapshot)
 *   DELETE /watchlist/:id                remove from watchlist
 *   POST   /watchlist/:id/refresh        re-pull from SerpAPI; persist new snapshot
 *
 * RBAC: every route requires `competitive_intel:manage` (admin only).
 * Audit: every mutation + lookup lands in audit_log.
 */
import { Router, type Request } from "express";
import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import {
  db,
  competitiveIntelAdvertisersTable,
  competitiveIntelSnapshotsTable,
} from "@workspace/db";
import { Permission, requirePermission } from "../lib/rbac";
import { auditLog } from "../lib/audit";
import { badRequest, notFound } from "../lib/http-errors";
import {
  serpapiAdvertiserAds,
  serpapiSearchAdvertisers,
  isSerpapiConfigured,
  SerpapiError,
} from "../lib/serpapi-client";

const router = Router();

const LookupBody = z.object({
  advertiser_id: z.string().trim().min(1).max(200).optional(),
  query: z.string().trim().min(1).max(200).optional(),
}).refine((b) => !!b.advertiser_id || !!b.query, {
  message: "Provide either advertiser_id or query",
});

const WatchlistAddBody = z.object({
  advertiser_id: z.string().trim().min(1).max(200),
  label: z.string().trim().min(1).max(200),
  notes: z.string().trim().max(2000).optional(),
});

const IdParam = z.object({ id: z.coerce.number().int().positive() });

function notConfigured(res: import("express").Response) {
  return res.status(503).json({
    status: "error",
    code: "serpapi_not_configured",
    message: "SerpAPI is not configured. Add it in the Integrations Hub (sidebar → Integrations → Web Search → SerpAPI → Connect). Or set SERPAPI_API_KEY as an env-var fallback.",
  });
}

router.get("/config", requirePermission(Permission.COMPETITIVE_INTEL_MANAGE), async (req, res) => {
  res.json({ configured: await isSerpapiConfigured(req.user!.firm_id) });
});

router.post("/lookup", requirePermission(Permission.COMPETITIVE_INTEL_MANAGE), async (req, res) => {
  const parsed = LookupBody.safeParse(req.body);
  if (!parsed.success) return badRequest(res, "Invalid input", parsed.error.flatten());
  const firmId = req.user!.firm_id;
  if (!(await isSerpapiConfigured(firmId))) return notConfigured(res);

  try {
    if (parsed.data.advertiser_id) {
      const result = await serpapiAdvertiserAds(parsed.data.advertiser_id, firmId);
      await auditLog("competitive_intel", parsed.data.advertiser_id, "lookup_advertiser", {
        firm_id: req.user!.firm_id,
        user_id: req.user!.id,
        advertiser_id: parsed.data.advertiser_id,
        ad_count: result.ad_creatives?.length ?? 0,
      });
      return res.json({ kind: "advertiser_ads", ...result });
    }
    const result = await serpapiSearchAdvertisers(parsed.data.query!, firmId);
    await auditLog("competitive_intel", parsed.data.query!, "lookup_search", {
      firm_id: req.user!.firm_id,
      user_id: req.user!.id,
      query: parsed.data.query,
      hit_count: result.advertisers?.length ?? 0,
    });
    return res.json({ kind: "advertiser_search", ...result });
  } catch (err) {
    const sa = err instanceof SerpapiError ? err : null;
    return res.status(sa?.status ?? 502).json({
      status: "error",
      code: "serpapi_lookup_failed",
      message: (err as Error).message,
    });
  }
});

router.get("/watchlist", requirePermission(Permission.COMPETITIVE_INTEL_MANAGE), async (req, res) => {
  const rows = await db
    .select()
    .from(competitiveIntelAdvertisersTable)
    .where(eq(competitiveIntelAdvertisersTable.firm_id, req.user!.firm_id))
    .orderBy(desc(competitiveIntelAdvertisersTable.created_at));
  res.json({ advertisers: rows });
});

router.post("/watchlist", requirePermission(Permission.COMPETITIVE_INTEL_MANAGE), async (req, res) => {
  const parsed = WatchlistAddBody.safeParse(req.body);
  if (!parsed.success) return badRequest(res, "Invalid input", parsed.error.flatten());
  const firmId = req.user!.firm_id;
  if (!(await isSerpapiConfigured(firmId))) return notConfigured(res);

  // Insert first; on duplicate (firm_id, advertiser_id) → 409.
  let row;
  try {
    [row] = await db
      .insert(competitiveIntelAdvertisersTable)
      .values({
        firm_id: req.user!.firm_id,
        advertiser_id: parsed.data.advertiser_id,
        label: parsed.data.label,
        notes: parsed.data.notes ?? null,
        added_by_user_id: req.user!.id,
      })
      .returning();
  } catch (err) {
    if (/duplicate key|unique/i.test((err as Error).message)) {
      return res.status(409).json({
        status: "error",
        code: "advertiser_already_watched",
        message: "This advertiser is already on your watchlist.",
      });
    }
    throw err;
  }

  // Best-effort initial snapshot. If the SerpAPI call fails, the row
  // still lives — the operator can refresh later.
  let snapshot_error: string | null = null;
  let ad_count = 0;
  try {
    const result = await serpapiAdvertiserAds(parsed.data.advertiser_id, firmId);
    ad_count = result.ad_creatives?.length ?? 0;
    await db.insert(competitiveIntelSnapshotsTable).values({
      advertiser_id_fk: row.id,
      raw_response: result as any,
      ad_count,
    });
    await db
      .update(competitiveIntelAdvertisersTable)
      .set({ last_fetched_at: new Date(), last_ad_count: ad_count })
      .where(eq(competitiveIntelAdvertisersTable.id, row.id));
  } catch (err) {
    snapshot_error = (err as Error).message;
  }

  await auditLog("competitive_intel", String(row.id), "watchlist_added", {
    firm_id: req.user!.firm_id,
    added_by_user_id: req.user!.id,
    advertiser_id: parsed.data.advertiser_id,
    label: parsed.data.label,
    initial_ad_count: ad_count,
    snapshot_error,
  });
  res.status(201).json({ advertiser: row, ad_count, snapshot_error });
});

async function loadOwnedRow(req: Request, id: number) {
  const [row] = await db
    .select()
    .from(competitiveIntelAdvertisersTable)
    .where(and(
      eq(competitiveIntelAdvertisersTable.id, id),
      eq(competitiveIntelAdvertisersTable.firm_id, req.user!.firm_id),
    ));
  return row ?? null;
}

router.delete("/watchlist/:id", requirePermission(Permission.COMPETITIVE_INTEL_MANAGE), async (req, res) => {
  const parsed = IdParam.safeParse(req.params);
  if (!parsed.success) return badRequest(res, "Invalid id");
  const row = await loadOwnedRow(req, parsed.data.id);
  if (!row) return notFound(res, "Advertiser not on watchlist");

  await db.delete(competitiveIntelAdvertisersTable).where(eq(competitiveIntelAdvertisersTable.id, row.id));
  await auditLog("competitive_intel", String(row.id), "watchlist_removed", {
    firm_id: req.user!.firm_id,
    removed_by_user_id: req.user!.id,
    advertiser_id: row.advertiser_id,
    label: row.label,
  });
  res.status(204).end();
});

router.post("/watchlist/:id/refresh", requirePermission(Permission.COMPETITIVE_INTEL_MANAGE), async (req, res) => {
  const parsed = IdParam.safeParse(req.params);
  if (!parsed.success) return badRequest(res, "Invalid id");
  const firmId = req.user!.firm_id;
  if (!(await isSerpapiConfigured(firmId))) return notConfigured(res);
  const row = await loadOwnedRow(req, parsed.data.id);
  if (!row) return notFound(res, "Advertiser not on watchlist");

  try {
    const result = await serpapiAdvertiserAds(row.advertiser_id, firmId);
    const ad_count = result.ad_creatives?.length ?? 0;
    await db.insert(competitiveIntelSnapshotsTable).values({
      advertiser_id_fk: row.id,
      raw_response: result as any,
      ad_count,
    });
    const [updated] = await db
      .update(competitiveIntelAdvertisersTable)
      .set({ last_fetched_at: new Date(), last_ad_count: ad_count })
      .where(eq(competitiveIntelAdvertisersTable.id, row.id))
      .returning();
    // Audit only on real changes (count delta) so manual refreshes don't spam.
    if (row.last_ad_count !== ad_count) {
      await auditLog("competitive_intel", String(row.id), "watchlist_refreshed", {
        firm_id: req.user!.firm_id,
        refreshed_by_user_id: req.user!.id,
        advertiser_id: row.advertiser_id,
        old_ad_count: row.last_ad_count,
        new_ad_count: ad_count,
      });
    }
    res.json({ advertiser: updated, ad_count, ads: result.ad_creatives ?? [] });
  } catch (err) {
    const sa = err instanceof SerpapiError ? err : null;
    res.status(sa?.status ?? 502).json({
      status: "error",
      code: "serpapi_refresh_failed",
      message: (err as Error).message,
    });
  }
});

export default router;
