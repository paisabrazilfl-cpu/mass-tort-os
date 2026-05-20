/**
 * Reranker client — Bitdeer-hosted BAAI/bge-reranker-v2-m3.
 *
 * Cross-encoder reranking: given a query and N candidate documents,
 * returns the candidates re-scored by true relevance (not the recall-
 * oriented cosine score a vector store gives). This is the PRECISION
 * layer of a retrieval pipeline — take a noisy top-50 from any search,
 * pass it here, keep the top-k that actually matter.
 *
 * SHIPPING STATUS — additive, opt-in, ISOLATED.
 *   Nothing in the existing decision-engine, lead-scoring, or AI-helper
 *   paths calls this module. It is reachable ONLY via:
 *     • POST /api/ai/rerank          (routes/ai-rerank.ts)
 *     • the `ai.rerank` automation node (lib/automations/executor.ts)
 *   Both are new surfaces. Importing this file changes zero existing
 *   behavior.
 *
 * AUTH — vault-first, env-fallback (same pattern as serpapi-client.ts):
 *   1. integrations row provider="bitdeer_reranker" (firm-scoped api_key)
 *   2. BITDEER_API_KEY env var
 *   Returns a structured "not configured" error if neither is present.
 */
import { logger } from "./logger";

const RERANK_URL =
  process.env["BITDEER_RERANK_URL"] || "https://api-inference.bitdeer.ai/v1/rerank";
const DEFAULT_MODEL = "BAAI/bge-reranker-v2-m3";
const DEFAULT_TIMEOUT_MS = 20_000;

export class RerankerError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = "RerankerError";
  }
}

export interface RerankResult {
  /** Index into the ORIGINAL documents array. */
  index: number;
  /** Cross-encoder relevance score; higher is more relevant. */
  relevance_score: number;
  /** The document text at that index (echoed for caller convenience). */
  document: string;
}

/**
 * Resolve the Bitdeer API key. Vault-first when a firmId is supplied,
 * env-fallback otherwise. Lazy import of the integrations helper avoids
 * a circular dependency (routes/integrations imports provider-router
 * which can reach lib code).
 */
async function resolveApiKey(firmId?: number): Promise<string | null> {
  if (firmId !== undefined) {
    try {
      const { getIntegrationCredentials } = await import("../routes/integrations");
      const creds = await getIntegrationCredentials("bitdeer_reranker", firmId);
      if (creds?.api_key) return creds.api_key;
    } catch (err) {
      logger.warn({ err }, "reranker: vault key lookup failed; falling back to env");
    }
  }
  return process.env["BITDEER_API_KEY"] ?? null;
}

export async function isRerankerConfigured(firmId?: number): Promise<boolean> {
  return (await resolveApiKey(firmId)) !== null;
}

export interface RerankOptions {
  /** Firm scope for vault key resolution. */
  firmId?: number;
  /** Keep only the top-N after reranking. Default: all. */
  topN?: number;
  /** Override the model id. Default BAAI/bge-reranker-v2-m3. */
  model?: string;
  /** Per-request timeout. Default 20s. */
  timeoutMs?: number;
}

/**
 * Rerank `documents` by relevance to `query`. Returns results sorted
 * most-relevant-first. Throws RerankerError on misconfiguration (503),
 * bad input (400), or upstream failure (502/504).
 */
export async function rerank(
  query: string,
  documents: string[],
  opts: RerankOptions = {},
): Promise<RerankResult[]> {
  const q = String(query || "").trim();
  if (!q) throw new RerankerError("rerank: query is required", 400);
  if (!Array.isArray(documents) || documents.length === 0) {
    throw new RerankerError("rerank: documents must be a non-empty array", 400);
  }
  // Defensive caps so a runaway caller can't blow the upstream quota or
  // the request timeout. 1000 docs is far above any sane rerank batch.
  if (documents.length > 1000) {
    throw new RerankerError("rerank: documents array exceeds 1000-item cap", 400);
  }
  const docs = documents.map((d) => String(d ?? ""));

  const key = await resolveApiKey(opts.firmId);
  if (!key) {
    throw new RerankerError(
      "Reranker is not configured. Add the Bitdeer integration in the Integrations Hub (AI / LLM → BAAI Reranker), or set BITDEER_API_KEY.",
      503,
    );
  }

  const body: Record<string, unknown> = {
    model: opts.model || DEFAULT_MODEL,
    query: q,
    documents: docs,
  };
  if (opts.topN && opts.topN > 0) body.top_n = Math.min(opts.topN, docs.length);

  let res: Response;
  try {
    res = await fetch(RERANK_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (err) {
    if ((err as { name?: string }).name === "TimeoutError" || (err as { name?: string }).name === "AbortError") {
      throw new RerankerError(`reranker timeout after ${opts.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`, 504);
    }
    throw new RerankerError(`reranker network error: ${(err as Error).message}`, 502);
  }

  const text = await res.text();
  let parsed: unknown;
  try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = text; }

  if (!res.ok) {
    // Never log the key; do log the upstream status for triage.
    logger.warn({ status: res.status }, "reranker: upstream non-2xx");
    throw new RerankerError(`reranker upstream HTTP ${res.status}`, res.status >= 500 ? 502 : res.status, parsed);
  }

  // Bitdeer's response mirrors the Cohere/Jina rerank shape:
  //   { results: [ { index, relevance_score }, ... ] }
  // Some deployments return { data: [...] }; accept both.
  const raw = parsed as { results?: unknown[]; data?: unknown[] } | undefined;
  const rows = (raw?.results ?? raw?.data ?? []) as Array<{ index?: number; relevance_score?: number; score?: number }>;
  if (!Array.isArray(rows)) {
    throw new RerankerError("reranker: unexpected response shape (no results array)", 502, parsed);
  }

  const out: RerankResult[] = rows
    .map((r) => {
      const index = typeof r.index === "number" ? r.index : -1;
      const score = typeof r.relevance_score === "number" ? r.relevance_score
        : typeof r.score === "number" ? r.score : 0;
      return { index, relevance_score: score, document: index >= 0 && index < docs.length ? docs[index] : "" };
    })
    .filter((r) => r.index >= 0)
    .sort((a, b) => b.relevance_score - a.relevance_score);

  return out;
}
