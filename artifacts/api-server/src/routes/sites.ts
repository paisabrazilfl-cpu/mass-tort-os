// SITES admin router (Site Maker Engine).
//
// Drives the admin SITES tab and the 5-step Site Maker wizard:
//   GET    /api/sites            — list every tort site (urls, status, leads)
//   POST   /api/sites/scaffold   — AI proposal (tri-state, NEVER committed)
//   POST   /api/sites            — create + publish a new site
//   PUT    /api/sites/:slug      — edit / toggle enabled / (de)activate
//   DELETE /api/sites/:slug      — soft-delete (deactivate)
//   POST   /api/sites/rebuild-all — super_admin: backfill missing web forms
//
// All mutating routes require FORMS_CONFIG_MANAGE. rebuild-all is super_admin
// only. Lead counts are firm-scoped for non-super_admin operators.

import { Router, type Request } from "express";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db, formConfigurationsTable, leadsTable } from "@workspace/db";
import { z } from "zod/v4";
import {
  authMiddleware,
  Permission,
  requirePermission,
  requireRole,
} from "../lib/rbac";
import { badRequest, conflict, notFound, serverError } from "../lib/http-errors";
import { webFormFieldSchema, eligibilityRuleSchema } from "@workspace/db";
import {
  getAllFormConfigs,
  getFormConfig,
  createSite,
  updateFormConfig,
  softDeleteSite,
  reactivateSite,
  setSiteEnabled,
  toKebabSlug,
  slugExists,
  isCanonicalCategory,
  CANONICAL_CATEGORIES,
  type CanonicalCategory,
} from "../lib/form-config-service";
import { scaffoldTortSite } from "../lib/site-scaffold";
import { logger } from "../lib/logger";

const router = Router();
router.use(authMiddleware);

// Strict host pattern: alphanumerics, dot, hyphen, optional :port.
const SAFE_HOST = /^[a-zA-Z0-9.-]+(?::\d{1,5})?$/;

function resolveBaseUrl(req: Request): string {
  const fromEnv = process.env.PUBLIC_API_BASE_URL?.trim();
  if (fromEnv) return fromEnv.replace(/\/+$/, "");
  const host = req.get("host") ?? "";
  if (!SAFE_HOST.test(host)) return "";
  const proto = (req.get("x-forwarded-proto") ?? req.protocol ?? "https")
    .split(",")[0]
    .trim()
    .toLowerCase();
  if (proto !== "http" && proto !== "https") return "";
  return `${proto}://${host}`;
}

// ── GET /api/sites — list every site with public urls + lead counts ──────────
router.get(
  "/",
  requirePermission(Permission.FORMS_CONFIG_VIEW),
  async (req, res) => {
    try {
      const user = req.user!;
      const baseUrl = resolveBaseUrl(req);
      const configs = await getAllFormConfigs();

      // Lead counts grouped by tort_type (== label). Firm-scoped unless
      // super_admin sees all firms.
      const labels = configs.map(c => c.label);
      const countByLabel = new Map<string, number>();
      if (labels.length > 0) {
        const conds = [inArray(leadsTable.tort_type, labels)];
        if (user.role !== "super_admin") {
          conds.push(eq(leadsTable.firm_id, user.firm_id));
        }
        const rows = await db
          .select({
            tort_type: leadsTable.tort_type,
            n: sql<number>`count(*)::int`,
          })
          .from(leadsTable)
          .where(and(...conds))
          .groupBy(leadsTable.tort_type);
        for (const r of rows) countByLabel.set(r.tort_type, Number(r.n) || 0);
      }

      const sites = configs.map(c => {
        const wf = c.web_form_config;
        const formEnabled = Boolean(wf?.enabled);
        return {
          slug: c.id,
          label: c.label,
          category: c.category,
          active: c.active,
          web_form_enabled: formEnabled,
          has_web_form: Boolean(wf),
          // A site is "live" only when the row is active AND the web form is enabled.
          live: c.active && formEnabled,
          field_count: wf?.fields?.length ?? 0,
          rule_count: wf?.eligibility_rules?.length ?? 0,
          lead_count: countByLabel.get(c.label) ?? 0,
          landing_url: baseUrl ? `${baseUrl}/c/${encodeURIComponent(c.category)}/${encodeURIComponent(c.id)}` : null,
          intake_url: baseUrl ? `${baseUrl}/intake/${encodeURIComponent(c.id)}` : null,
          updated_at: c.updated_at,
        };
      });

      sites.sort((a, b) => a.label.localeCompare(b.label));
      res.json({ sites, categories: CANONICAL_CATEGORIES });
    } catch (err) {
      logger.error({ err }, "Failed to list sites");
      serverError(res, "Failed to list sites");
    }
  },
);

// ── POST /api/sites/scaffold — AI proposal (NEVER committed) ──────────────────
const scaffoldReqSchema = z.object({
  display_name: z.string().min(2).max(160),
  category: z.string().min(2).max(50),
});

router.post(
  "/scaffold",
  requirePermission(Permission.FORMS_CONFIG_MANAGE),
  async (req, res) => {
    const parsed = scaffoldReqSchema.safeParse(req.body);
    if (!parsed.success) {
      badRequest(res, "Invalid scaffold request", parsed.error.flatten());
      return;
    }
    const { display_name, category } = parsed.data;
    try {
      const result = await scaffoldTortSite({ displayName: display_name, category });
      if (!result.ok) {
        // The scaffold genuinely failed (LLM unreachable, bad shape after
        // retries). Surface the audit trail so the operator sees what was tried.
        res.status(502).json({
          status: "error",
          code: result.code,
          message: result.message,
          details: result.details,
          retry: { attempts: result.attempts, stoppedReason: result.stoppedReason },
        });
        return;
      }
      // Suggest a unique slug but do NOT reserve it — creation re-checks.
      const suggestedSlug = toKebabSlug(display_name);
      res.json({
        status: "ok",
        proposal: result.proposal,
        suggested_slug: suggestedSlug,
        slug_available: suggestedSlug ? !(await slugExists(suggestedSlug)) : false,
        retry: { attempts: result.attempts, stoppedReason: result.stoppedReason },
      });
    } catch (err) {
      logger.error({ err, display_name }, "Site scaffold failed");
      serverError(res, "Scaffold failed");
    }
  },
);

// ── POST /api/sites — create + publish a new site ─────────────────────────────
const createReqSchema = z.object({
  label: z.string().min(2).max(255),
  category: z.string().min(2).max(50),
  slug: z.string().max(80).optional(),
  headline: z.string().max(180).optional(),
  subhead: z.string().max(400).optional(),
  intro_text: z.string().max(1000).nullish(),
  custom_fields: z.array(webFormFieldSchema).max(30).default([]),
  eligibility_rules: z.array(eligibilityRuleSchema).max(30).default([]),
  avg_settlement_low: z.number().int().nullish(),
  avg_settlement_high: z.number().int().nullish(),
  mdl_status: z.string().max(30).nullish(),
  sol_months: z.number().int().nullish(),
});

router.post(
  "/",
  requirePermission(Permission.FORMS_CONFIG_MANAGE),
  async (req, res) => {
    const parsed = createReqSchema.safeParse(req.body);
    if (!parsed.success) {
      badRequest(res, "Invalid site payload", parsed.error.flatten());
      return;
    }
    const body = parsed.data;
    if (!isCanonicalCategory(body.category)) {
      badRequest(res, `category must be one of: ${CANONICAL_CATEGORIES.join(", ")}`);
      return;
    }
    try {
      const site = await createSite(
        {
          label: body.label,
          category: body.category as CanonicalCategory,
          slug: body.slug,
          headline: body.headline,
          subhead: body.subhead,
          introText: body.intro_text ?? null,
          customFields: body.custom_fields,
          eligibilityRules: body.eligibility_rules,
          avg_settlement_low: body.avg_settlement_low ?? null,
          avg_settlement_high: body.avg_settlement_high ?? null,
          mdl_status: body.mdl_status ?? null,
          sol_months: body.sol_months ?? null,
        },
        req.user!.id,
      );
      res.status(201).json({ status: "ok", site });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to create site";
      if (/already exists|reserved/i.test(msg)) {
        conflict(res, "slug_conflict", msg);
        return;
      }
      logger.error({ err }, "Failed to create site");
      badRequest(res, msg);
    }
  },
);

// ── PUT /api/sites/:slug — edit / toggle ──────────────────────────────────────
const updateReqSchema = z.object({
  label: z.string().min(2).max(255).optional(),
  category: z.string().min(2).max(50).optional(),
  intro_text: z.string().max(1000).nullish(),
  active: z.boolean().optional(),
  web_form_enabled: z.boolean().optional(),
});

router.put(
  "/:slug",
  requirePermission(Permission.FORMS_CONFIG_MANAGE),
  async (req, res) => {
    const slug = toKebabSlug(String(req.params.slug));
    const parsed = updateReqSchema.safeParse(req.body);
    if (!parsed.success) {
      badRequest(res, "Invalid update payload", parsed.error.flatten());
      return;
    }
    const body = parsed.data;
    if (body.category && !isCanonicalCategory(body.category)) {
      badRequest(res, `category must be one of: ${CANONICAL_CATEGORIES.join(", ")}`);
      return;
    }
    try {
      const existing = await getFormConfig(slug);
      if (!existing) {
        notFound(res, "Site not found");
        return;
      }
      // Web-form enabled flag lives inside web_form_config.
      if (body.web_form_enabled !== undefined) {
        await setSiteEnabled(slug, body.web_form_enabled, req.user!.id);
      }
      const fieldUpdates: Parameters<typeof updateFormConfig>[1] = {};
      if (body.label !== undefined) fieldUpdates.label = body.label;
      if (body.category !== undefined) fieldUpdates.category = body.category;
      if (body.intro_text !== undefined) fieldUpdates.intro_text = body.intro_text;
      if (body.active !== undefined) fieldUpdates.active = body.active;
      if (Object.keys(fieldUpdates).length > 0) {
        await updateFormConfig(slug, fieldUpdates, req.user!.id);
      }
      const site = await getFormConfig(slug);
      res.json({ status: "ok", site });
    } catch (err) {
      logger.error({ err, slug }, "Failed to update site");
      serverError(res, "Failed to update site");
    }
  },
);

// ── DELETE /api/sites/:slug — soft-delete (deactivate) ────────────────────────
router.delete(
  "/:slug",
  requirePermission(Permission.FORMS_CONFIG_MANAGE),
  async (req, res) => {
    const slug = toKebabSlug(String(req.params.slug));
    try {
      const existing = await getFormConfig(slug);
      if (!existing) {
        notFound(res, "Site not found");
        return;
      }
      const reactivate = req.query.reactivate === "1" || req.query.reactivate === "true";
      const site = reactivate
        ? await reactivateSite(slug, req.user!.id)
        : await softDeleteSite(slug, req.user!.id);
      res.json({ status: "ok", site });
    } catch (err) {
      logger.error({ err, slug }, "Failed to delete site");
      serverError(res, "Failed to delete site");
    }
  },
);

// ── POST /api/sites/rebuild-all — super_admin backfill ────────────────────────
// Backfills web_form_config from the canonical comprehensive forms for any
// built-in tort row that is missing one. Does NOT touch admin-edited sites
// that already have a web form. super_admin only.
router.post(
  "/rebuild-all",
  requireRole("super_admin"),
  async (req, res) => {
    try {
      const configs = await getAllFormConfigs();
      let rebuilt = 0;
      const missing = configs.filter(c => !c.web_form_config);
      // Nothing destructive here — seedFormConfigurations already backfills on
      // boot; this endpoint just reports + re-runs the lazy backfill via reads.
      for (const c of missing) {
        const refreshed = await getFormConfig(c.id);
        if (refreshed?.web_form_config) rebuilt += 1;
      }
      logger.info({ rebuilt, scanned: configs.length, userId: req.user!.id }, "Site rebuild-all");
      res.json({ status: "ok", scanned: configs.length, rebuilt });
    } catch (err) {
      logger.error({ err }, "rebuild-all failed");
      serverError(res, "rebuild-all failed");
    }
  },
);

export default router;
