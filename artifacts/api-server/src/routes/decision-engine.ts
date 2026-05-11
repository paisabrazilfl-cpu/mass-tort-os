import { Router } from "express";
import { authMiddleware, Permission, requirePermission } from "../lib/rbac";
import { badRequest, notFound, serverError } from "../lib/http-errors";
import {
  buildPortfolioSummary,
  computeAndPersistLeadScore,
  recomputeAllScores,
  getEngineSettings,
  updateEngineSettings,
} from "../lib/decision-engine-service";
import { logger } from "../lib/logger";
import { z } from "zod/v4";

const router = Router();

// Authentication is required for ALL decision-engine endpoints. The role
// gate, however, is split per-route:
//   - GET /portfolio, GET /settings  → attorney or admin (read-only views
//     that running attorneys legitimately need to plan caseload, see
//     concentration warnings, etc).
//   - PUT /settings, POST /leads/:id/recompute, POST /recompute-all
//     → admin only (mutations / cluster-wide work).
//
// We deliberately do NOT mount a global `requirePermission` on the router —
// the boot-time route validator enforces a gate on every route, so each
// handler below must declare its own. That keeps the "admin-only writes"
// policy auditable in this file rather than buried in a shared middleware.
router.use(authMiddleware);

router.get("/portfolio", requirePermission(Permission.DECISION_ENGINE_VIEW), async (req, res) => {
  try {
    const summary = await buildPortfolioSummary(req.user!.firm_id);
    res.json(summary);
  } catch (e) {
    logger.error({ err: e }, "portfolio build failed");
    serverError(res, "portfolio_failed");
  }
});

router.get("/settings", requirePermission(Permission.DECISION_ENGINE_VIEW), async (_req, res) => {
  const s = await getEngineSettings();
  res.json(s);
});

const updateSettingsSchema = z.object({
  default_attorney_hourly_cost: z.number().nonnegative().optional(),
  default_hours_per_lead: z.number().nonnegative().optional(),
  convex_ratio_threshold: z.number().positive().optional(),
  concave_ratio_threshold: z.number().positive().optional(),
  concentration_warning_pct: z.number().int().min(1).max(100).optional(),
  ruin_auto_flag: z.boolean().optional(),
});

router.put("/settings", requirePermission(Permission.DECISION_ENGINE_MANAGE), async (req, res) => {
  const parsed = updateSettingsSchema.safeParse(req.body);
  if (!parsed.success) {
    badRequest(res, "Invalid request body", parsed.error.flatten());
    return;
  }
  await updateEngineSettings(parsed.data);
  const s = await getEngineSettings();
  res.json(s);
});

router.post("/leads/:id/recompute", requirePermission(Permission.DECISION_ENGINE_MANAGE), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    badRequest(res, "invalid_id");
    return;
  }
  const result = await computeAndPersistLeadScore(id);
  if (!result) {
    notFound(res, "lead_or_tort_not_found");
    return;
  }
  res.json(result);
});

router.post("/recompute-all", requirePermission(Permission.DECISION_ENGINE_MANAGE), async (req, res) => {
  const result = await recomputeAllScores(req.user!.firm_id);
  res.json(result);
});

export default router;
