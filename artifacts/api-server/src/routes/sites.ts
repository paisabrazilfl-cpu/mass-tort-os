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
  getSiteEditDetail,
  createSite,
  updateFormConfig,
  republishSite,
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
import { buildCanonicalWebFormConfig } from "../lib/comprehensive-tort-forms";
import { renderDraftIntakePreviewHtml } from "../lib/site-render";
import { rebuildAllSites, rebuildSeoNetwork } from "../lib/site-rebuild";
import { logger } from "../lib/logger";
import type { WebFormField } from "@workspace/db";

const router = Router();
router.use(authMiddleware);

// Stable per-site lead source. Web-form submissions are stamped with this exact
// value (see routes/web-forms.ts), keyed by the immutable slug — NOT the label.
function siteLeadSource(slug: string): string {
  return `web_form_${slug}`;
}

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

      // Lead counts keyed by the STABLE per-site source `web_form_<slug>` — the
      // slug (form_configurations.id) never changes, whereas the tort label CAN
      // be renamed on edit/republish, which would silently mis-attribute counts.
      // Counting by source ties each lead to the exact site that produced it.
      // Firm-scoped unless super_admin sees all firms.
      const sources = configs.map(c => siteLeadSource(c.id));
      const countBySource = new Map<string, number>();
      if (sources.length > 0) {
        const conds = [inArray(leadsTable.source, sources)];
        if (user.role !== "super_admin") {
          conds.push(eq(leadsTable.firm_id, user.firm_id));
        }
        const rows = await db
          .select({
            source: leadsTable.source,
            n: sql<number>`count(*)::int`,
          })
          .from(leadsTable)
          .where(and(...conds))
          .groupBy(leadsTable.source);
        for (const r of rows) {
          if (r.source) countBySource.set(r.source, Number(r.n) || 0);
        }
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
          lead_count: countBySource.get(siteLeadSource(c.id)) ?? 0,
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

// ── GET /api/sites/:slug — single-site edit-prefill detail ───────────────────
// Returns label/category/intro_text/headline/subhead plus ONLY the editable
// (non-canonical) custom fields + eligibility rules, so the wizard re-opens
// pre-filled. The locked canonical spine is intentionally stripped out — it is
// always re-attached on republish and can never be edited here.
router.get(
  "/:slug",
  requirePermission(Permission.FORMS_CONFIG_VIEW),
  async (req, res) => {
    const slug = toKebabSlug(String(req.params.slug));
    try {
      const detail = await getSiteEditDetail(slug);
      if (!detail) {
        notFound(res, "Site not found");
        return;
      }
      res.json({ status: "ok", site: detail });
    } catch (err) {
      logger.error({ err, slug }, "Failed to load site detail");
      serverError(res, "Failed to load site");
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

// ── POST /api/sites/preview — route-backed draft preview (no persistence) ─────
// Renders the SAME canonical intake chrome the public `/intake/:slug` page uses
// (verbatim header block, locked base fields, [COMPANY] disclaimer) from an
// in-memory draft config — so the wizard's create-mode preview is authoritative
// and identical to what publish produces, without writing a row first. The live
// page mounts the interactive embed.js form; this static render mirrors the
// exact canonical fields it will contain. View-level permission: nothing is
// persisted or exposed publicly.
const previewReqSchema = z.object({
  label: z.string().min(1).max(255),
  headline: z.string().max(180).optional(),
  subhead: z.string().max(400).optional(),
  custom_fields: z.array(webFormFieldSchema).max(30).default([]),
  eligibility_rules: z.array(eligibilityRuleSchema).max(30).default([]),
});

router.post(
  "/preview",
  requirePermission(Permission.FORMS_CONFIG_VIEW),
  async (req, res) => {
    const parsed = previewReqSchema.safeParse(req.body);
    if (!parsed.success) {
      badRequest(res, "Invalid preview payload", parsed.error.flatten());
      return;
    }
    const body = parsed.data;
    try {
      const label = body.label.trim();
      const headline = (body.headline ?? label).trim();
      const subhead = (body.subhead ?? `See if you may qualify for a ${label} claim.`).trim();
      const eligibilityExtra = body.custom_fields.filter((f: WebFormField) => f.section === "eligibility");
      const storyExtra = body.custom_fields.filter((f: WebFormField) => f.section !== "eligibility");
      // Same builder the create/republish paths use — the canonical spine is
      // always re-attached, so the preview can never omit the locked guardrails.
      const cfg = buildCanonicalWebFormConfig({
        headline,
        subhead,
        eligibilityExtra,
        storyExtra,
        rulesExtra: body.eligibility_rules,
      });
      const html = renderDraftIntakePreviewHtml(cfg, label);
      res.json({ status: "ok", html });
    } catch (err) {
      logger.error({ err }, "Failed to render site preview");
      serverError(res, "Failed to render preview");
    }
  },
);

// ── PUT /api/sites/:slug — edit / toggle ──────────────────────────────────────
const updateReqSchema = z.object({
  label: z.string().min(2).max(255).optional(),
  category: z.string().min(2).max(50).optional(),
  headline: z.string().max(180).optional(),
  subhead: z.string().max(400).optional(),
  intro_text: z.string().max(1000).nullish(),
  active: z.boolean().optional(),
  web_form_enabled: z.boolean().optional(),
  custom_fields: z.array(webFormFieldSchema).max(30).optional(),
  eligibility_rules: z.array(eligibilityRuleSchema).max(30).optional(),
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
      // A republish rebuilds the LOCKED web_form_config from the canonical
      // spine + edited custom extras. Triggered whenever any content field
      // (headline/subhead/custom_fields/eligibility_rules) is present.
      const isRepublish =
        body.headline !== undefined ||
        body.subhead !== undefined ||
        body.custom_fields !== undefined ||
        body.eligibility_rules !== undefined;
      if (isRepublish) {
        await republishSite(
          slug,
          {
            label: body.label,
            category: body.category as CanonicalCategory | undefined,
            headline: body.headline,
            subhead: body.subhead,
            introText: body.intro_text,
            customFields: body.custom_fields,
            eligibilityRules: body.eligibility_rules,
          },
          req.user!.id,
        );
      }
      // Web-form enabled flag lives inside web_form_config. Apply AFTER a
      // republish so an explicit toggle wins over the preserved state.
      if (body.web_form_enabled !== undefined) {
        await setSiteEnabled(slug, body.web_form_enabled, req.user!.id);
      }
      const fieldUpdates: Parameters<typeof updateFormConfig>[1] = {};
      // label/category/intro_text are written by republishSite; only apply
      // them here for a plain (non-republish) metadata edit to avoid a
      // double-write.
      if (!isRepublish) {
        if (body.label !== undefined) fieldUpdates.label = body.label;
        if (body.category !== undefined) fieldUpdates.category = body.category;
        if (body.intro_text !== undefined) fieldUpdates.intro_text = body.intro_text;
      }
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

// ── POST /api/sites/rebuild-all — super_admin re-verify + backfill ────────────
// Re-verifies that EVERY registry row resolves to a live-serviceable site, not
// just the ones missing a web form. For each row it reloads via getFormConfig
// (which lazily backfills web_form_config from the canonical comprehensive
// forms), then validates the resolved config has the serviceable spine intact
// (the canonical contact fields, a TCPA consent field, and at least one
// eligibility rule — the minimum to capture and route a real lead). Returns detailed
// verification counts plus a list of any rows that still fail to resolve so the
// operator can act. Non-destructive — seeding already backfills on boot; this
// just forces + audits the resolution. super_admin only.
router.post(
  "/rebuild-all",
  requireRole("super_admin"),
  async (req, res) => {
    try {
      const result = await rebuildAllSites(req.user!.id);
      res.json({ status: "ok", ...result });
    } catch (err) {
      logger.error({ err }, "rebuild-all failed");
      serverError(res, "rebuild-all failed");
    }
  },
);

// ── POST /api/sites/seo/rebuild-all — super_admin SEO page-network rebuild ─────
// The SEO page network (category hubs, per-tort supporting pages, glossary,
// how-it-works, sitemap.xml, robots.txt) is rendered on-demand straight from
// the live form-config registry — there is no cached/materialised copy to
// regenerate. This action therefore recomputes the canonical SEO manifest from
// the current ACTIVE rows and reports exactly what is live (page counts by kind,
// tort/category coverage) plus any duplicate paths (which must always be empty).
// It is fully idempotent — calling it twice with no registry change yields an
// identical manifest — and is the operator's authoritative "what is indexed?"
// view + integrity check. super_admin only.
router.post(
  "/seo/rebuild-all",
  requireRole("super_admin"),
  async (req, res) => {
    try {
      const result = await rebuildSeoNetwork(req.user!.id);
      res.json(result);
    } catch (err) {
      logger.error({ err }, "SEO rebuild-all failed");
      serverError(res, "SEO rebuild-all failed");
    }
  },
);

export default router;
