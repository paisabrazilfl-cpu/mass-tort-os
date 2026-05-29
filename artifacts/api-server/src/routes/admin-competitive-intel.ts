/**
 * Competitive Intelligence routes (mounted at /api/admin/competitive-intel).
 *
 * Multi-platform ad-tracking for competing plaintiff firms:
 *   - google : Google Ads Transparency Center via SerpAPI
 *   - meta   : Meta/Facebook Ad Library (graph.facebook.com/ads_archive)
 *   - tiktok : link-only — TikTok's Research API requires special approval;
 *              we store the firm name as advertiser_id and generate a deep link
 *
 * Endpoints:
 *   GET    /config                 { google: bool, meta: bool }
 *   POST   /lookup                 { advertiser_id|query, platform? } → live result
 *   GET    /watchlist              list this firm's saved advertisers + last snapshot
 *   POST   /watchlist              add advertiser to watchlist
 *   DELETE /watchlist/:id          remove from watchlist
 *   POST   /watchlist/:id/refresh  re-pull from source; persist new snapshot
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
import { enqueueJob } from "../lib/queue";
import {
  serpapiAdvertiserAds,
  serpapiSearchAdvertisers,
  isSerpapiConfigured,
  SerpapiError,
} from "../lib/serpapi-client";
import {
  metaSearchAds,
  metaSearchAdsByPageId,
  isMetaAdLibraryConfigured,
  MetaAdLibraryError,
} from "../lib/meta-ad-library-client";

const router = Router();

const PLATFORM_VALUES = ["google", "meta", "tiktok"] as const;
type Platform = typeof PLATFORM_VALUES[number];

const PlatformSchema = z.enum(PLATFORM_VALUES).default("google");

const LookupBody = z.object({
  advertiser_id: z.string().trim().min(1).max(200).optional(),
  query: z.string().trim().min(1).max(200).optional(),
  platform: PlatformSchema.optional(),
}).refine((b) => !!b.advertiser_id || !!b.query, {
  message: "Provide either advertiser_id or query",
});

const WatchlistAddBody = z.object({
  advertiser_id: z.string().trim().min(1).max(200),
  label: z.string().trim().min(1).max(200),
  notes: z.string().trim().max(2000).optional(),
  platform: PlatformSchema.optional(),
});

const IdParam = z.object({ id: z.coerce.number().int().positive() });

function notConfigured(res: import("express").Response, platform: Platform) {
  const labels: Record<Platform, string> = {
    google: "SERPAPI_API_KEY",
    meta: "META_AD_LIBRARY_TOKEN",
    tiktok: "n/a",
  };
  return res.status(503).json({
    status: "error",
    code: "platform_not_configured",
    platform,
    message: `${labels[platform]} is not set. Add it in Secrets to enable ${platform} lookups.`,
  });
}

function isPlatformConfigured(platform: Platform): boolean {
  if (platform === "google") return isSerpapiConfigured();
  if (platform === "meta") return isMetaAdLibraryConfigured();
  if (platform === "tiktok") return true; // link-only — always available
  return false;
}

// ──────────────────────────────────────────────────────────────
// GET /config
// ──────────────────────────────────────────────────────────────
router.get("/config", requirePermission(Permission.COMPETITIVE_INTEL_MANAGE), (_req, res) => {
  res.json({
    google: isSerpapiConfigured(),
    meta: isMetaAdLibraryConfigured(),
    tiktok: true,
  });
});

// ──────────────────────────────────────────────────────────────
// POST /lookup
// ──────────────────────────────────────────────────────────────
router.post("/lookup", requirePermission(Permission.COMPETITIVE_INTEL_MANAGE), async (req, res) => {
  const parsed = LookupBody.safeParse(req.body);
  if (!parsed.success) return badRequest(res, "Invalid input", parsed.error.flatten());

  const platform: Platform = parsed.data.platform ?? "google";

  if (!isPlatformConfigured(platform)) return notConfigured(res, platform);

  try {
    // ── Google ──────────────────────────────────────────────
    if (platform === "google") {
      if (parsed.data.advertiser_id) {
        const result = await serpapiAdvertiserAds(parsed.data.advertiser_id);
        await auditLog("competitive_intel", parsed.data.advertiser_id, "lookup_advertiser", {
          firm_id: req.user!.firm_id,
          user_id: req.user!.id,
          platform: "google",
          advertiser_id: parsed.data.advertiser_id,
          ad_count: result.ad_creatives?.length ?? 0,
        });
        return res.json({ kind: "advertiser_ads", platform: "google", ...result });
      }
      const result = await serpapiSearchAdvertisers(parsed.data.query!);
      await auditLog("competitive_intel", parsed.data.query!, "lookup_search", {
        firm_id: req.user!.firm_id,
        user_id: req.user!.id,
        platform: "google",
        query: parsed.data.query,
        hit_count: result.advertisers?.length ?? 0,
      });
      return res.json({ kind: "advertiser_search", platform: "google", ...result });
    }

    // ── Meta ────────────────────────────────────────────────
    if (platform === "meta") {
      const term = parsed.data.query ?? parsed.data.advertiser_id ?? "";
      const isPageId = /^\d{10,}$/.test(term);
      const result = isPageId
        ? await metaSearchAdsByPageId(term)
        : await metaSearchAds(term);
      await auditLog("competitive_intel", term, "lookup_meta", {
        firm_id: req.user!.firm_id,
        user_id: req.user!.id,
        platform: "meta",
        search_term: term,
        ad_count: result.ads?.length ?? 0,
      });
      return res.json({ kind: "meta_ads", platform: "meta", ads: result.ads, paging: result.paging });
    }

    // ── TikTok (link-only) ──────────────────────────────────
    if (platform === "tiktok") {
      const term = encodeURIComponent(parsed.data.query ?? parsed.data.advertiser_id ?? "");
      const url = `https://library.tiktok.com/?q=${term}&type=0&status=0&region=US&timeRange=0`;
      await auditLog("competitive_intel", term, "lookup_tiktok_link", {
        firm_id: req.user!.firm_id,
        user_id: req.user!.id,
        platform: "tiktok",
      });
      return res.json({ kind: "tiktok_link", platform: "tiktok", url });
    }

    return badRequest(res, "Unknown platform");
  } catch (err) {
    if (err instanceof SerpapiError) {
      return res.status(err.status ?? 502).json({
        status: "error", code: "serpapi_lookup_failed", message: err.message,
      });
    }
    if (err instanceof MetaAdLibraryError) {
      return res.status(err.status ?? 502).json({
        status: "error", code: "meta_lookup_failed", message: err.message,
      });
    }
    throw err;
  }
});

// ──────────────────────────────────────────────────────────────
// GET /watchlist
// ──────────────────────────────────────────────────────────────
router.get("/watchlist", requirePermission(Permission.COMPETITIVE_INTEL_MANAGE), async (req, res) => {
  const rows = await db
    .select()
    .from(competitiveIntelAdvertisersTable)
    .where(eq(competitiveIntelAdvertisersTable.firm_id, req.user!.firm_id))
    .orderBy(desc(competitiveIntelAdvertisersTable.created_at));
  res.json({ advertisers: rows });
});

// ──────────────────────────────────────────────────────────────
// POST /watchlist
// ──────────────────────────────────────────────────────────────
router.post("/watchlist", requirePermission(Permission.COMPETITIVE_INTEL_MANAGE), async (req, res) => {
  const parsed = WatchlistAddBody.safeParse(req.body);
  if (!parsed.success) return badRequest(res, "Invalid input", parsed.error.flatten());

  const platform: Platform = parsed.data.platform ?? "google";

  // TikTok is always "available" (link-only).  Google and Meta need their key.
  if (platform !== "tiktok" && !isPlatformConfigured(platform)) {
    return notConfigured(res, platform);
  }

  let row: typeof competitiveIntelAdvertisersTable.$inferSelect;
  try {
    [row] = await db
      .insert(competitiveIntelAdvertisersTable)
      .values({
        firm_id: req.user!.firm_id,
        platform,
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
        message: "This advertiser is already on your watchlist for this platform.",
      });
    }
    throw err;
  }

  // Best-effort initial snapshot (skip for TikTok — link-only).
  let snapshot_error: string | null = null;
  let ad_count = 0;

  if (platform === "google" && isSerpapiConfigured()) {
    try {
      const result = await serpapiAdvertiserAds(parsed.data.advertiser_id);
      ad_count = result.ad_creatives?.length ?? 0;
      await db.insert(competitiveIntelSnapshotsTable).values({
        advertiser_id_fk: row.id,
        raw_response: result as Record<string, unknown>,
        ad_count,
      });
      await db
        .update(competitiveIntelAdvertisersTable)
        .set({ last_fetched_at: new Date(), last_ad_count: ad_count })
        .where(eq(competitiveIntelAdvertisersTable.id, row.id));
    } catch (err) {
      snapshot_error = (err as Error).message;
    }
  }

  if (platform === "meta" && isMetaAdLibraryConfigured()) {
    try {
      const result = await metaSearchAds(parsed.data.advertiser_id);
      ad_count = result.ads?.length ?? 0;
      await db.insert(competitiveIntelSnapshotsTable).values({
        advertiser_id_fk: row.id,
        raw_response: result as unknown as Record<string, unknown>,
        ad_count,
      });
      await db
        .update(competitiveIntelAdvertisersTable)
        .set({ last_fetched_at: new Date(), last_ad_count: ad_count })
        .where(eq(competitiveIntelAdvertisersTable.id, row.id));
    } catch (err) {
      snapshot_error = (err as Error).message;
    }
  }

  await auditLog("competitive_intel", String(row.id), "watchlist_added", {
    firm_id: req.user!.firm_id,
    added_by_user_id: req.user!.id,
    platform,
    advertiser_id: parsed.data.advertiser_id,
    label: parsed.data.label,
    initial_ad_count: ad_count,
    snapshot_error,
  });
  res.status(201).json({ advertiser: row, ad_count, snapshot_error });
});

// ──────────────────────────────────────────────────────────────
// Shared helper — load a row owned by the current firm
// ──────────────────────────────────────────────────────────────
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

// ──────────────────────────────────────────────────────────────
// DELETE /watchlist/:id
// ──────────────────────────────────────────────────────────────
router.delete("/watchlist/:id", requirePermission(Permission.COMPETITIVE_INTEL_MANAGE), async (req, res) => {
  const parsed = IdParam.safeParse(req.params);
  if (!parsed.success) return badRequest(res, "Invalid id");
  const row = await loadOwnedRow(req, parsed.data.id);
  if (!row) return notFound(res, "Advertiser not on watchlist");

  await db.delete(competitiveIntelAdvertisersTable).where(eq(competitiveIntelAdvertisersTable.id, row.id));
  await auditLog("competitive_intel", String(row.id), "watchlist_removed", {
    firm_id: req.user!.firm_id,
    removed_by_user_id: req.user!.id,
    platform: row.platform,
    advertiser_id: row.advertiser_id,
    label: row.label,
  });
  res.status(204).end();
});

// ──────────────────────────────────────────────────────────────
// POST /watchlist/:id/refresh
// ──────────────────────────────────────────────────────────────
router.post("/watchlist/:id/refresh", requirePermission(Permission.COMPETITIVE_INTEL_MANAGE), async (req, res) => {
  const parsed = IdParam.safeParse(req.params);
  if (!parsed.success) return badRequest(res, "Invalid id");

  const row = await loadOwnedRow(req, parsed.data.id);
  if (!row) return notFound(res, "Advertiser not on watchlist");

  const platform = (row.platform ?? "google") as Platform;

  if (platform === "tiktok") {
    const term = encodeURIComponent(row.advertiser_id);
    return res.json({
      advertiser: row,
      ad_count: 0,
      platform: "tiktok",
      url: `https://library.tiktok.com/?q=${term}&type=0&status=0&region=US&timeRange=0`,
    });
  }

  if (!isPlatformConfigured(platform)) return notConfigured(res, platform);

  try {
    let ad_count = 0;
    let rawResponse: unknown;

    if (platform === "google") {
      const result = await serpapiAdvertiserAds(row.advertiser_id);
      ad_count = result.ad_creatives?.length ?? 0;
      rawResponse = result;
    } else {
      const result = await metaSearchAds(row.advertiser_id);
      ad_count = result.ads?.length ?? 0;
      rawResponse = result;
    }

    await db.insert(competitiveIntelSnapshotsTable).values({
      advertiser_id_fk: row.id,
      raw_response: rawResponse as Record<string, unknown>,
      ad_count,
    });
    const [updated] = await db
      .update(competitiveIntelAdvertisersTable)
      .set({ last_fetched_at: new Date(), last_ad_count: ad_count })
      .where(eq(competitiveIntelAdvertisersTable.id, row.id))
      .returning();

    if (row.last_ad_count !== ad_count) {
      await auditLog("competitive_intel", String(row.id), "watchlist_refreshed", {
        firm_id: req.user!.firm_id,
        refreshed_by_user_id: req.user!.id,
        platform,
        advertiser_id: row.advertiser_id,
        old_ad_count: row.last_ad_count,
        new_ad_count: ad_count,
      });
    }

    const ads = platform === "google"
      ? (rawResponse as { ad_creatives?: unknown[] }).ad_creatives ?? []
      : (rawResponse as { ads?: unknown[] }).ads ?? [];

    res.json({ advertiser: updated, ad_count, platform, ads });
  } catch (err) {
    if (err instanceof SerpapiError) {
      return res.status(err.status ?? 502).json({
        status: "error", code: "serpapi_refresh_failed", message: err.message,
      });
    }
    if (err instanceof MetaAdLibraryError) {
      return res.status(err.status ?? 502).json({
        status: "error", code: "meta_refresh_failed", message: err.message,
      });
    }
    throw err;
  }
});

// ──────────────────────────────────────────────────────────────
// POST /sync-all
// Enqueues a background job that re-fetches every watchlist entry
// for this firm. Returns immediately — the worker picks it up.
// ──────────────────────────────────────────────────────────────
router.post("/sync-all", requirePermission(Permission.COMPETITIVE_INTEL_MANAGE), async (req, res) => {
  const job = await enqueueJob("competitive_intel_watchlist_sync", {
    firm_id: req.user!.firm_id,
    triggered_by: "manual",
  });
  await auditLog("competitive_intel", String(req.user!.firm_id), "watchlist_sync_enqueued", {
    firm_id: req.user!.firm_id,
    enqueued_by_user_id: req.user!.id,
    job_id: (job as { id?: number }).id ?? null,
  });
  res.status(202).json({
    status: "queued",
    message: "Watchlist sync job enqueued — all advertisers for this firm will be refreshed by the worker.",
    job,
  });
});

export default router;
