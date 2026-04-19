import { Router } from "express";
import { authMiddleware, requireRole } from "../lib/rbac";
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

// All decision-engine endpoints are admin-only.
router.use(authMiddleware, requireRole("admin"));

router.get("/portfolio", async (_req, res) => {
  try {
    const summary = await buildPortfolioSummary();
    res.json(summary);
  } catch (e) {
    logger.error({ err: e }, "portfolio build failed");
    res.status(500).json({ error: "portfolio_failed" });
  }
});

router.get("/settings", async (_req, res) => {
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

router.put("/settings", async (req, res) => {
  const parsed = updateSettingsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  await updateEngineSettings(parsed.data);
  const s = await getEngineSettings();
  res.json(s);
});

router.post("/leads/:id/recompute", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "invalid_id" });
    return;
  }
  const result = await computeAndPersistLeadScore(id);
  if (!result) {
    res.status(404).json({ error: "lead_or_tort_not_found" });
    return;
  }
  res.json(result);
});

router.post("/recompute-all", async (_req, res) => {
  const result = await recomputeAllScores();
  res.json(result);
});

export default router;
