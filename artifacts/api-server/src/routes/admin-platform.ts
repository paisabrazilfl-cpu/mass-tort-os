/**
 * Platform admin — cross-firm view of every user and every firm on this
 * MTOS instance. Reserved for super_admins of the vendor (default-slug)
 * firm so a CUSTOMER firm's super_admin cannot see other customers'
 * data (cross-tenant PHI leak prevention).
 *
 * Mounted in routes/index.ts at /api/admin/platform behind
 * requireAdminUnlock, so the caller must already be a super_admin with
 * a valid PIN unlock; requirePlatformOwner adds the vendor-firm check.
 */
import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import { pool } from "@workspace/db";
import { getDefaultFirmId } from "../lib/firm-bootstrap";
import { requireRole } from "../lib/rbac";

const router = Router();

interface FirmRow {
  id: number;
  name: string;
  slug: string;
  subscription_status: string;
  current_period_end: Date | null;
  created_at: Date;
  user_count: string;
  super_admin_count: string;
}

interface PlatformUserRow {
  id: number;
  email: string;
  name: string;
  role: string;
  firm_id: number;
  firm_name: string | null;
  firm_slug: string | null;
  last_login_at: Date | null;
  email_verified_at: Date | null;
  mfa_enabled: boolean;
  created_at: Date;
}

async function requirePlatformOwner(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const defaultFirmId = await getDefaultFirmId();
  if (defaultFirmId == null || req.user?.firm_id !== defaultFirmId) {
    res.status(403).json({
      status: "error",
      code: "platform_owner_only",
      message: "Platform admin is restricted to the MTOS operator firm.",
    });
    return;
  }
  next();
}

/**
 * List every firm + per-firm user counts + subscription posture. Capped
 * at 200; pagination is a follow-up if the operator ever sells past it.
 */
router.get("/firms", requireRole("super_admin"), requirePlatformOwner, async (_req, res) => {
  const result = await pool.query<FirmRow>(
    `SELECT f.id, f.name, f.slug, f.subscription_status, f.current_period_end, f.created_at,
            (SELECT COUNT(*)::text FROM mtos_users u WHERE u.firm_id = f.id) AS user_count,
            (SELECT COUNT(*)::text FROM mtos_users u
              WHERE u.firm_id = f.id AND u.role = 'super_admin') AS super_admin_count
       FROM firms f
       ORDER BY f.created_at DESC
       LIMIT 200`,
  );
  res.json({
    status: "ok",
    data: {
      rows: result.rows.map((r) => ({
        ...r,
        user_count: Number(r.user_count),
        super_admin_count: Number(r.super_admin_count),
      })),
      count: result.rowCount ?? result.rows.length,
    },
  });
});

/**
 * List every user on the instance with their firm joined in. Supports
 * optional ?firm_id and ?search (email or name substring). Capped at 500.
 */
router.get("/users", requireRole("super_admin"), requirePlatformOwner, async (req, res) => {
  const firmIdRaw = req.query.firm_id;
  const firmFilter =
    typeof firmIdRaw === "string" && firmIdRaw.trim() !== "" ? Number(firmIdRaw) : null;
  const searchRaw = req.query.search;
  const search = typeof searchRaw === "string" ? searchRaw.trim().toLowerCase() : "";

  const params: unknown[] = [];
  const where: string[] = [];
  if (firmFilter !== null && Number.isFinite(firmFilter) && firmFilter > 0) {
    params.push(firmFilter);
    where.push(`u.firm_id = $${params.length}`);
  }
  if (search.length > 0) {
    params.push(`%${search}%`);
    where.push(
      `(LOWER(u.email) LIKE $${params.length} OR LOWER(u.name) LIKE $${params.length})`,
    );
  }

  const sql = `
    SELECT u.id, u.email, u.name, u.role, u.firm_id,
           f.name AS firm_name, f.slug AS firm_slug,
           u.last_login_at, u.email_verified_at, u.mfa_enabled, u.created_at
      FROM mtos_users u
      LEFT JOIN firms f ON f.id = u.firm_id
      ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY u.created_at DESC
      LIMIT 500
  `;
  const result = await pool.query<PlatformUserRow>(sql, params);
  res.json({
    status: "ok",
    data: { rows: result.rows, count: result.rowCount ?? result.rows.length },
  });
});

/**
 * Summary stats for the header cards: totals + active-in-last-30-days.
 * One round trip, four aggregates in a single SELECT.
 */
router.get("/stats", requireRole("super_admin"), requirePlatformOwner, async (_req, res) => {
  const r = await pool.query<{
    total_firms: string;
    total_users: string;
    super_admins: string;
    active_30d: string;
  }>(
    `SELECT
       (SELECT COUNT(*)::text FROM firms) AS total_firms,
       (SELECT COUNT(*)::text FROM mtos_users) AS total_users,
       (SELECT COUNT(*)::text FROM mtos_users WHERE role = 'super_admin') AS super_admins,
       (SELECT COUNT(*)::text FROM mtos_users
          WHERE last_login_at IS NOT NULL AND last_login_at > NOW() - INTERVAL '30 days') AS active_30d`,
  );
  const row = r.rows[0] ?? { total_firms: "0", total_users: "0", super_admins: "0", active_30d: "0" };
  res.json({
    status: "ok",
    data: {
      total_firms: Number(row.total_firms),
      total_users: Number(row.total_users),
      super_admins: Number(row.super_admins),
      active_30d: Number(row.active_30d),
    },
  });
});

export default router;
