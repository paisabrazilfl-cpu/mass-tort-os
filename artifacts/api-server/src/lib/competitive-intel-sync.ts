/**
 * Competitive Intelligence — watchlist sync handler.
 *
 * Called from the worker when a `competitive_intel_watchlist_sync` job is
 * claimed. Iterates every active advertiser row owned by a firm (or ALL firms
 * when no firm_id is supplied), calls the appropriate platform API, persists a
 * new snapshot, and updates `last_fetched_at` / `last_ad_count`.
 *
 * Design notes:
 *  - Each advertiser is fetched serially so a single bad row (network error,
 *    stale advertiser id) doesn't kill the whole batch — failures are logged
 *    per-row and the sync continues.
 *  - TikTok is link-only; no live fetch is possible, so those rows are skipped.
 *  - Meta and Google each go through their respective clients, same as the
 *    manual /watchlist/:id/refresh endpoint — zero duplication.
 */
import { eq, and, sql } from "drizzle-orm";
import {
  db,
  competitiveIntelAdvertisersTable,
  competitiveIntelSnapshotsTable,
} from "@workspace/db";
import { logger } from "./logger";
import { auditLog } from "./audit";
import {
  serpapiAdvertiserAds,
  isSerpapiConfigured,
  SerpapiError,
} from "./serpapi-client";
import {
  metaSearchAds,
  isMetaAdLibraryConfigured,
  MetaAdLibraryError,
} from "./meta-ad-library-client";

export interface CompetitiveIntelSyncPayload {
  firm_id?: number;
  advertiser_id?: number;
  triggered_by?: "schedule" | "manual";
}

export interface CompetitiveIntelSyncResult {
  total: number;
  refreshed: number;
  skipped: number;
  failed: number;
  errors: Array<{ id: number; label: string; error: string }>;
}

export async function handleCompetitiveIntelSync(
  payload: CompetitiveIntelSyncPayload,
): Promise<CompetitiveIntelSyncResult> {
  const triggeredBy = payload.triggered_by ?? "schedule";

  // Build WHERE clause: optionally scope to one firm or one advertiser row.
  const conditions = [];
  if (typeof payload.advertiser_id === "number" && payload.advertiser_id > 0) {
    conditions.push(eq(competitiveIntelAdvertisersTable.id, payload.advertiser_id));
  } else if (typeof payload.firm_id === "number" && payload.firm_id > 0) {
    conditions.push(eq(competitiveIntelAdvertisersTable.firm_id, payload.firm_id));
  }

  const rows = await db
    .select()
    .from(competitiveIntelAdvertisersTable)
    .where(conditions.length > 0 ? and(...conditions as [ReturnType<typeof eq>, ...ReturnType<typeof eq>[]]) : sql`true`);

  const result: CompetitiveIntelSyncResult = {
    total: rows.length,
    refreshed: 0,
    skipped: 0,
    failed: 0,
    errors: [],
  };

  logger.info(
    { total: rows.length, firm_id: payload.firm_id, triggeredBy },
    "competitive-intel-sync: starting",
  );

  for (const row of rows) {
    const platform = (row.platform ?? "google") as "google" | "meta" | "tiktok";

    // TikTok is link-only — no live data to fetch.
    if (platform === "tiktok") {
      result.skipped++;
      continue;
    }

    // Skip if the relevant key is not configured.
    if (platform === "google" && !isSerpapiConfigured()) {
      result.skipped++;
      continue;
    }
    if (platform === "meta" && !isMetaAdLibraryConfigured()) {
      result.skipped++;
      continue;
    }

    try {
      let ad_count = 0;
      let rawResponse: unknown;

      if (platform === "google") {
        const r = await serpapiAdvertiserAds(row.advertiser_id);
        ad_count = r.ad_creatives?.length ?? 0;
        rawResponse = r;
      } else {
        const r = await metaSearchAds(row.advertiser_id);
        ad_count = r.ads?.length ?? 0;
        rawResponse = r;
      }

      await db.insert(competitiveIntelSnapshotsTable).values({
        advertiser_id_fk: row.id,
        raw_response: rawResponse as Record<string, unknown>,
        ad_count,
      });

      await db
        .update(competitiveIntelAdvertisersTable)
        .set({ last_fetched_at: new Date(), last_ad_count: ad_count })
        .where(eq(competitiveIntelAdvertisersTable.id, row.id));

      if (row.last_ad_count !== ad_count) {
        await auditLog(
          "competitive_intel",
          String(row.id),
          "watchlist_sync_ad_count_changed",
          {
            firm_id: row.firm_id,
            platform,
            advertiser_id: row.advertiser_id,
            label: row.label,
            old_ad_count: row.last_ad_count,
            new_ad_count: ad_count,
            triggered_by: triggeredBy,
          },
        );
      }

      result.refreshed++;
      logger.info(
        { advertiser_row_id: row.id, platform, ad_count, label: row.label },
        "competitive-intel-sync: row refreshed",
      );
    } catch (err) {
      const message =
        err instanceof SerpapiError || err instanceof MetaAdLibraryError
          ? err.message
          : (err as Error).message ?? String(err);

      result.failed++;
      result.errors.push({ id: row.id, label: row.label ?? "", error: message });
      logger.error(
        { err, advertiser_row_id: row.id, platform, label: row.label },
        "competitive-intel-sync: row failed",
      );
    }
  }

  logger.info(result, "competitive-intel-sync: complete");
  return result;
}
