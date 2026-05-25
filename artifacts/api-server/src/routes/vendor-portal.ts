import { Router } from "express";
import { eq, desc } from "drizzle-orm";
import { db, vendorsTable, leadsTable } from "@workspace/db";
import { notFound } from "../lib/http-errors";
import { getAllFormConfigs } from "../lib/form-config-service";
import { logger } from "../lib/logger";

const router = Router();

function resolveBaseUrl(req: import("express").Request): string {
  const fromEnv = process.env.PUBLIC_API_BASE_URL?.trim();
  if (fromEnv) return fromEnv.replace(/\/+$/, "");
  const proto = (req.get("x-forwarded-proto") ?? req.protocol ?? "https")
    .split(",")[0].trim();
  const host = req.get("host") ?? "localhost";
  return `${proto}://${host}`;
}

/**
 * GET /vendor-portal/:token
 * Returns vendor info + active campaigns + summary stats.
 * Token is the sole credential — no auth header required.
 */
router.get("/:token", async (req, res) => {
  const { token } = req.params;
  if (!token || !/^[0-9a-f]{32,64}$/i.test(token)) {
    notFound(res, "Invalid portal link");
    return;
  }

  const [vendor] = await db
    .select({
      id: vendorsTable.id,
      internal_code: vendorsTable.internal_code,
      status: vendorsTable.status,
      portal_token: vendorsTable.portal_token,
    })
    .from(vendorsTable)
    .where(eq(vendorsTable.portal_token, token));

  if (!vendor || vendor.status !== "active") {
    notFound(res, "Portal not found or inactive");
    return;
  }

  const base = resolveBaseUrl(req);

  let configs: Awaited<ReturnType<typeof getAllFormConfigs>> = [];
  try {
    configs = await getAllFormConfigs();
  } catch (err) {
    logger.warn({ err }, "vendor-portal: failed to load form configs");
  }

  const campaigns = configs
    .filter((c) => c.active)
    .map((c) => ({
      id: c.id,
      label: c.label,
      // Links to the web-forms preview page which is a real submittable form (no blocker).
      // The ?v= token is threaded into embed.js which appends it to the submit fetch URL.
      form_url: `${base}/api/web-forms/${c.id}/preview?v=${token}`,
    }));

  // Aggregate stats — never expose lead PII here
  const statsRows = await db
    .select({ status: leadsTable.status })
    .from(leadsTable)
    .where(eq(leadsTable.vendor_id, vendor.id));

  const stats = { total: 0, pending: 0, accepted: 0, rejected: 0 };
  for (const r of statsRows) {
    stats.total++;
    const s = r.status ?? "pending";
    if (s === "accepted" || s === "qualified") stats.accepted++;
    else if (s === "rejected" || s === "disqualified") stats.rejected++;
    else stats.pending++;
  }

  res.json({
    vendor: {
      internal_code: vendor.internal_code ?? `V-${vendor.id}`,
      status: vendor.status,
    },
    campaigns,
    stats,
  });
});

/**
 * GET /vendor-portal/:token/submissions
 * Paginated list of leads submitted through this vendor's token.
 * Returns only non-sensitive fields (name, tort, status, date).
 */
router.get("/:token/submissions", async (req, res) => {
  const { token } = req.params;
  if (!token || !/^[0-9a-f]{32,64}$/i.test(token)) {
    notFound(res, "Invalid portal link");
    return;
  }

  const [vendor] = await db
    .select({ id: vendorsTable.id, status: vendorsTable.status })
    .from(vendorsTable)
    .where(eq(vendorsTable.portal_token, token));

  if (!vendor || vendor.status !== "active") {
    notFound(res, "Portal not found or inactive");
    return;
  }

  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = 50;
  const offset = (page - 1) * pageSize;

  const rows = await db
    .select({
      id: leadsTable.id,
      name: leadsTable.name,
      tort_type: leadsTable.tort_type,
      status: leadsTable.status,
      created_at: leadsTable.created_at,
    })
    .from(leadsTable)
    .where(eq(leadsTable.vendor_id, vendor.id))
    .orderBy(desc(leadsTable.created_at))
    .limit(pageSize)
    .offset(offset);

  res.json({ submissions: rows, page, page_size: pageSize });
});

export default router;
