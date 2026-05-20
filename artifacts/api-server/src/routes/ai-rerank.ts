/**
 * POST /api/ai/rerank — relevance re-scoring of candidate documents.
 *
 * Thin HTTP surface over lib/reranker.ts (Bitdeer BAAI/bge-reranker-v2-m3).
 * Additive, isolated: no existing route or decision path changes.
 *
 * Body:
 *   { query: string, documents: string[], top_n?: number, model?: string }
 * Response:
 *   { results: [ { index, relevance_score, document }, ... ] }   sorted
 *   most-relevant-first. `index` points into the ORIGINAL documents array.
 */
import { Router } from "express";
import { z } from "zod/v4";
import { Permission, requirePermission } from "../lib/rbac";
import { badRequest, serverError } from "../lib/http-errors";
import { requireFirmId } from "../lib/firm-scope";
import { logger } from "../lib/logger";
import { rerank, isRerankerConfigured, RerankerError } from "../lib/reranker";

const router = Router();

const RerankBody = z.object({
  query: z.string().min(1).max(8000),
  documents: z.array(z.string().max(32000)).min(1).max(1000),
  top_n: z.number().int().positive().max(1000).optional(),
  model: z.string().max(120).optional(),
});

router.get("/rerank/config", requirePermission(Permission.AI_RERANK), async (req, res) => {
  try {
    const firmId = requireFirmId(req);
    res.json({ configured: await isRerankerConfigured(firmId) });
  } catch (err: any) {
    logger.error({ err: err?.message }, "ai/rerank config check failed");
    serverError(res, "Failed to check reranker config");
  }
});

router.post("/rerank", requirePermission(Permission.AI_RERANK), async (req, res) => {
  const parsed = RerankBody.safeParse(req.body);
  if (!parsed.success) { badRequest(res, "Invalid rerank request", parsed.error.flatten()); return; }
  try {
    const firmId = requireFirmId(req);
    const results = await rerank(parsed.data.query, parsed.data.documents, {
      firmId,
      topN: parsed.data.top_n,
      model: parsed.data.model,
    });
    res.json({ results, count: results.length });
  } catch (err: any) {
    if (err instanceof RerankerError) {
      res.status(err.status >= 400 && err.status < 600 ? err.status : 502).json({
        status: "error",
        code: err.status === 503 ? "reranker_not_configured" : "reranker_failed",
        message: err.message,
      });
      return;
    }
    logger.error({ err: err?.message }, "ai/rerank failed");
    serverError(res, "Rerank failed");
  }
});

export default router;
